import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DIMS, loadFixture } from './helpers.mjs';
import { makeClassifier } from '../convert/vd-classify.js';
import { vdToMrsim } from '../convert/emit-mrsim.js';
import { parseMrsim } from '../mrsim.js';

// the SHIPPED option set (app.js and convert-cli.mjs both pass all three),
// so what the suite asserts is what a user actually gets
const { classify, prefabName, gateWidthFor, heightFor, boundsFor } = makeClassifier(CATALOG, DIMS);
const convert = (data, opts = {}) =>
  vdToMrsim(data, classify, prefabName, { gateWidthFor, heightFor, boundsFor, ...opts });
const fixture = () => loadFixture('synthetic-track.json');

test('conversion is deterministic', () => {
  const a = convert(fixture()).xml;
  const b = convert(fixture()).xml;
  assert.equal(a, b);
});

test('output parses and every checkpoint resolves in order', () => {
  const { xml, summary } = convert(fixture());
  const t = parseMrsim(xml, 'synthetic.xml');
  assert.equal(t.seq.length, summary.cpNames.length);
  assert.deepEqual(t.seq.map(s => s.name), summary.cpNames);
  t.seq.forEach((s, i) => assert.equal(s.seqNum, i + 1));
  assert.equal(t.meta.isCircuit, true);
  assert.equal(t.meta.location, 'Empty Grass World');
});

test('gate size mapping: big gates are TRUE-SIZE frames, 1.92 m -> 5x5', () => {
  const { xml, summary } = convert(fixture());
  // VD race gates exceed every MRSIM gate: they become exact-aperture frames
  // (posts + banner + a full-opening sensor) so real racing lines fit through
  const forms = summary.emitted.filter(e => e.kind === 'gate').map(e => e.form);
  assert.deepEqual(forms.slice(0, 3), ['exact', '5x5', 'exact']);
  assert.match(xml, /trkGate1_postL/);
  assert.match(xml, /trkGate1_banner/);
  assert.match(xml, /GateStartBannerMaterial/);       // the start gate's banner
  assert.match(xml, /Centered5x5Gate/);               // small gates keep the model
  assert.ok(!/StartFinishGate\.xml/.test(xml));       // no undersized SF include
  assert.equal(summary.emitted.filter(e => e.sf).length, 1);
  // WDC gate at 100%: aperture 3.2-0.24 wide, 2.56*1.0-0.1 tall — the
  // trigger spans the WHOLE opening so any pass through the gate fires
  assert.match(xml, /<Box x="2\.96" y="\.3" z="2\.46"\/>/);
});

test('checkpoint rings sit at the gate/opening centre, not the base', () => {
  // MRSIM places the ring at the CheckpointReference resolved against the
  // checkpoint entity's PARENT — it ignores the entity's own lift. So the
  // vertical offset MUST live on the reference, matching the game's own gates;
  // if we only lift the `_pass` entity and leave the reference at zero (as we
  // once did) the ring drops to the gate base in-game.
  const { xml } = convert(fixture());
  // the start gate's reference carries the half-height offset, not a bare tag
  const pass = xml.match(/<Entity name="trkGate1_pass">[\s\S]*?<Checkpoint\/>/)[0];
  const ref = pass.match(/CheckpointReference">\s*<WorldFromEntityComponent z="([^"]+)"/);
  assert.ok(ref && parseFloat(ref[1]) > 0.5,
    `start gate reference must carry the centre offset (got ${ref?.[1]})`);
  const t = parseMrsim(xml, 'synthetic.xml');
  assert.ok(t.seq[0].pos.y > 0.5,
    `start gate ring should be centred, not at the floor (y=${t.seq[0].pos.y})`);
});

test('parseMrsim resolves the ring against the checkpoint entity parent, not its own lift', () => {
  // a checkpoint whose sensor entity is lifted 2 m with a zero-offset reference
  // renders at the PARENT level (0), not at 2 — the game skips the entity's own
  // WorldFromEntityComponent when placing the ring
  const xml = `<Simulation>
    <Entity name="Track">
      <Transform>
        <Entity name="gate">
          <Entity name="gate_pass">
            <WorldFromEntityComponent z="2"/>
            <Box x="2" y=".3" z="2"/>
            <StaticContact contactMaterial="-1"/>
            <Entity name="CheckpointReference"><WorldFromEntityComponent z="1.4"/></Entity>
            <Checkpoint/>
          </Entity>
        </Entity>
      </Transform>
      <CheckpointList>{ isCircuit: false, checkpoints: [ "gate_pass" ] }</CheckpointList>
    </Entity>
  </Simulation>`;
  const t = parseMrsim(xml, 'lift.xml');
  assert.equal(t.seq.length, 1);
  // ring = parent(0) + reference(1.4) = 1.4, NOT 2 + 1.4 = 3.4
  assert.ok(Math.abs(t.seq[0].pos.y - 1.4) < 1e-6,
    `ring must skip the entity's own 2 m lift (got ${t.seq[0].pos.y})`);
});

test('steep windows become dive/climb gates by crossing sign, shallow stays a gate', () => {
  const { xml, summary } = convert(fixture());
  assert.match(xml, /7x7DiveGate\.xml/);
  assert.match(xml, /7x7ClimbGate\.xml/);
  const dives = summary.emitted.filter(e => e.kind === 'dive');
  assert.deepEqual(dives.map(d => d.form), ['dive', 'climb']);
  // the shallow window (pitch ~20°) is emitted as a pitched gate instead
  const shallow = summary.emitted[5];
  assert.equal(shallow.kind, 'gate');
});

test('elevated gates get support legs', () => {
  const { xml } = convert(fixture());
  assert.match(xml, /trkGate3_leg1/);
  assert.match(xml, /trkGate3_leg2/);
  assert.match(xml, /GateLegMaterial/);
});

test('flags: solid pole, render-only cloth, listed by their _pass sensor', () => {
  const { xml, summary } = convert(fixture());
  assert.match(xml, /trkFlag1_pole/);
  // the cloth must NOT be a hard collider (VD cloth is brushable)
  const cloth = xml.match(/<Entity name="trkFlag1_cloth">[\s\S]*?<\/Entity>/)[0];
  assert.ok(!/StaticContact/.test(cloth), 'cloth has no collision');
  const flag = summary.emitted.find(e => e.kind === 'flag');
  assert.match(flag.name, /_pass$/);
  assert.ok(summary.cpNames.includes(flag.name));
});

test('degenerate checkpoints become thin panes, never blocks', () => {
  const { xml, summary } = convert(fixture());
  const forms = summary.emitted.filter(e => e.kind === 'checkpoint').map(e => e.form);
  assert.deepEqual(forms, ['upright', 'plate', 'pane', 'pane']);
  assert.match(xml, /<Box x="16" y="0.3" z="7.8"\/>/);       // turn-pole pane
  assert.match(xml, /<Box x="5" y="5" z="0.3"\/>/);          // flat plate (2*2.5)
  // no sensor volume is a block: every one has a window-pane thin axis
  for (const [, w, d, h] of xml.matchAll(
    /<Entity name="trkCheck\d+_pass">[\s\S]*?<Box x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)) {
    assert.ok(Math.min(+w, +d, +h) <= 0.3, `sensor ${w},${d},${h} is a solid block`);
  }
});

test('flags trigger on the pole side only, never through the fabric', () => {
  const { xml } = convert(fixture());
  const flag = xml.match(/<Entity name="trkFlag1">[\s\S]*?<Checkpoint\/>/)[0];
  const clothX = +flag.match(/_cloth">\s*<WorldFromEntityComponent x="([^"]+)"/)[1];
  const [, passX, passW] =
    flag.match(/_pass">\s*<WorldFromEntityComponent x="([^"]+)"[^>]*\/>\s*<Box x="([^"]+)"/);
  // the near edge sits on the pole, give or take the lip that catches lines
  // shaving it — never a wall reaching out over the fabric
  const near = +passX - Math.sign(+passX) * (+passW / 2);
  assert.ok(Math.abs(near) <= 0.76, `sensor starts ${near} m past the pole`);
  assert.ok(Math.sign(+passX) === -Math.sign(clothX),
    `sensor (${passX}) and cloth (${clothX}) are on the same side`);
});

test('a flag facing against the lap keeps cloth and sensor apart', () => {
  // same flag, stored facing the other way: vd-normalize flips it to the lap
  // direction, so BOTH the sensor and the cloth must swap with it
  const data = fixture();
  const flagG = data.gates.find(g => g.prefab === 170);
  flagG.trans.rot = [0, 0, 1000, 0];                        // 180 deg yaw
  const { xml } = convert(data);
  const flag = xml.match(/<Entity name="trkFlag1">[\s\S]*?<Checkpoint\/>/)[0];
  const clothX = +flag.match(/_cloth">\s*<WorldFromEntityComponent x="([^"]+)"/)[1];
  const passX = +flag.match(/_pass">\s*<WorldFromEntityComponent x="([^"]+)"/)[1];
  assert.ok(Math.sign(passX) === -Math.sign(clothX),
    `sensor (${passX}) and cloth (${clothX}) are on the same side`);
});

test('scenery: blocks, nets, hurdles, deco flags, skips with warning', () => {
  const { xml, warnings, summary } = convert(fixture());
  assert.match(xml, /BlockWhiteMaterial/);
  assert.match(xml, /NetPanelMaterial/);
  assert.match(xml, /HurdlePanelMaterial/);
  assert.equal(summary.counts.blocks, 1);
  assert.equal(summary.counts.nets, 1);
  assert.equal(summary.counts.hurdles, 1);
  assert.equal(summary.counts.decoFlags, 1);
  assert.ok(warnings.some(w => /skipped.*DefaultStartGrid/.test(w)));
  assert.ok(warnings.some(w => /net.*dark panels/.test(w)));
});

test('hurdles keep the roll VD stores (a slat stays a slat)', () => {
  const data = fixture();
  const flat = data.barriers.find(b => b.prefab === 275);
  // the same panel rolled 90 deg about its fly-past axis: the 2025 MultiGP GQ
  // tracks stand hurdles on their short edge, and a yaw-only emit laid them
  // back down flat
  data.barriers.push({ prefab: 275, trans: { ...flat.trans, pos: [1200, 349, 2000],
    rot: [707, 0, 0, 707], scale: [64, 30, 101] } });
  const { xml } = convert(data);
  const rolled = xml.match(/<Transform ([^>]*)>\s*<Entity name="hurdle2">/)[1];
  assert.match(rolled, /rx=|ry=/, 'the roll survived as a full axis-angle');
  // width runs along the panel's own local X, height along local Y (base
  // origin) and the thin axis along local Z — VD's frame, like blocks
  assert.match(xml, /<Entity name="hurdle2">\s*<WorldFromEntityComponent z="0.228"\/>\s*<Box x="1.946" y=".02" z="0.456"\/>/);
});

test('a 3-D "hurdle" prefab is not inflated into a panel of its bounding box', () => {
  // /hurdle/i also matches solid structures (KDRAHurdle is 3.56 x 2.98 x 3.48
  // m). Their bounding box is not a panel, and the emitted panel is a SOLID
  // collider — sizing one off the box would drop a 3.6 x 3 m wall on the lap.
  const data = fixture();
  data.barriers.push({ prefab: 729,
    trans: { pos: [1200, 0, 2200], rot: [1000, 0, 0, 0], scale: [100, 100, 100] } });
  const { xml } = convert(data);
  const box = xml.match(/<Entity name="hurdle2">\s*<WorldFromEntityComponent[^>]*\/>\s*<Box x="([^"]+)" y="[^"]+" z="([^"]+)"/);
  assert.ok(box, 'the 3-D hurdle still converts');
  assert.ok(+box[1] <= 3.05 && +box[2] <= 1.55,
    `kept the nominal panel size, got ${box[1]} x ${box[2]}`);
});

test('a near-vertical marker never aims its pane back down the lap', () => {
  // These markers reach the pane branch BECAUSE their stored axis is vertical,
  // so the leftover yaw is noise vd-normalize never vets (its facing pass only
  // checks the vertical sense once |dir.y| > 0.5). As a pane normal a
  // backwards yaw is fatal: MRSIM only fires a checkpoint crossed along its
  // facing, so the lap would stall there forever.
  const data = fixture();
  const pole = data.gates.find(g => g.prefab === 2231);
  // 155 deg about Y, then tipped ~25 deg off vertical: |dir.y| ~ 0.9 with a
  // usable-but-backwards horizontal residual
  pole.prefab = 88;                       // not a pole -> takes the stored yaw
  pole.trans.rot = [200, -110, 940, -230];
  const { summary, normal } = convert(data);
  summary.emitted.forEach((e, i) => {
    if (e.form !== 'pane' && e.form !== 'upright') return;
    const h = normal.crossings[i].pathHeading;
    const dot = e.expectDir.x * h.x + e.expectDir.z * h.z;
    assert.ok(dot > -0.3, `${e.name} faces the lap at dot ${dot.toFixed(2)}`);
  });
});

test('block geometry: base origin, per-axis scale, world placement', () => {
  const { xml } = convert(fixture());
  // block scale [200,50,400] -> box x=2 (three x), y=4 (three z), z=0.5 (three y)
  assert.match(xml, /<Box x="2" y="4" z="0.5"\/>/);
});

test('spawn sits 6 m behind the first crossing facing it', () => {
  const { summary } = convert(fixture());
  const first = convert(fixture()).normal.crossings[0];
  const d = summary.spawn.pos.distanceTo(first.pos);
  assert.ok(Math.abs(d - Math.hypot(6, first.pos.y)) < 0.51, `spawn ${d} m from gate`);
  assert.ok(summary.spawn.heading.dot(first.dir) > 0.99);
});

test('empty scene id produces no scene warning, other scenes do', () => {
  assert.ok(!convert(fixture()).warnings.some(w => /scene/.test(w)));
  const data = fixture();
  data.meta.scene_id = 8;
  assert.ok(convert(data).warnings.some(w => /source scene #8/.test(w)));
});

test('location option is respected', () => {
  const { xml } = convert(fixture(), { location: 'BaylandsPark' });
  assert.match(xml, /Locations\/BaylandsPark\.xml/);
});
