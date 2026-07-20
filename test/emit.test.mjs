import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DIMS, loadFixture } from './helpers.mjs';
import { makeClassifier } from '../convert/vd-classify.js';
import { vdToMrsim } from '../convert/emit-mrsim.js';
import { parseMrsim } from '../mrsim.js';

const { classify, prefabName, gateWidthFor } = makeClassifier(CATALOG, DIMS);
const convert = (data, opts = {}) =>
  vdToMrsim(data, classify, prefabName, { gateWidthFor, ...opts });
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

test('degenerate checkpoints become rotation-robust volumes', () => {
  const { xml, summary } = convert(fixture());
  const forms = summary.emitted.filter(e => e.kind === 'checkpoint').map(e => e.form);
  assert.deepEqual(forms, ['upright', 'plate', 'column', 'column']);
  assert.match(xml, /<Box x="16" y="16" z="7.8"\/>/);        // pole column
  assert.match(xml, /<Box x="5" y="5" z="2"\/>/);            // flat plate (2*2.5)
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
