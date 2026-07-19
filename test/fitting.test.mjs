// Human-line sensor fitting and the review-hardened behaviours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DIMS, loadFixture } from './helpers.mjs';
import * as THREE from 'three';
import { makeClassifier } from '../convert/vd-classify.js';
import { vdToMrsim } from '../convert/emit-mrsim.js';
import { mrsimToVd } from '../convert/mrsim-to-vd.js';
import { validateMrsim } from '../convert/validate.js';
import { parseMrsim } from '../mrsim.js';

const { classify, prefabName, gateWidthFor, heightFor } = makeClassifier(CATALOG, DIMS);
const convert = (data, opts = {}) =>
  vdToMrsim(data, classify, prefabName, { gateWidthFor, heightFor, ...opts });

// three laps of a ghost passing the fixture's flag (VD raw pos [3000,0,4800]
// -> three (30, ·, -48)) ~1.5 m to the side, 2 m up
function flagGhost(side = 1.5, up = 2) {
  const line = [];
  for (let lap = 0; lap < 3; lap++) {
    for (let t = -6; t <= 6; t += 1) {
      // flag dir is +x in three space; the pass runs along x, offset in z
      line.push(new THREE.Vector3(30 + t, up, -48 - side));
    }
  }
  return [line];
}

test('flag sensors centre on supplied human crossings', () => {
  const plain = convert(loadFixture('synthetic-track.json'));
  const fitted = convert(loadFixture('synthetic-track.json'), { humanLines: flagGhost() });
  const f0 = plain.summary.emitted.find(e => e.kind === 'flag');
  const f1 = fitted.summary.emitted.find(e => e.kind === 'flag');
  // the reference moves to the crossing centroid: 2 m above the pole BASE
  // (the base itself sits at the 0.5 m ground raise in placed space)
  const base = fitted.normal.crossings.find(c => c.kind === 'flag').pos.y;
  assert.ok(Math.abs(f1.expectPos.y - (base + 2)) < 0.3, `ref height ${f1.expectPos.y}`);
  assert.ok(f0.expectPos.distanceTo(f1.expectPos) > 0.5, 'fit moved the reference');
  // and the fitted conversion still validates
  const v = validateMrsim(fitted.xml, { summary: fitted.summary, normal: fitted.normal });
  assert.deepEqual(v.errors, []);
});

test('ghost overflights far above a flag do not stretch the sensor', () => {
  const high = convert(loadFixture('synthetic-track.json'), { humanLines: flagGhost(1.5, 25) });
  const f = high.summary.emitted.find(e => e.kind === 'flag');
  // all samples rejected (25 m up is not a flag pass) -> default sensor kept
  assert.ok(f.sensor.h < 10, `sensor height ${f.sensor.h}`);
  assert.ok(f.expectPos.y < 4, `ref height ${f.expectPos.y}`);
});

test('upright checkpoint sensors scale width and height independently', () => {
  const data = loadFixture('synthetic-track.json');
  // a square's aperture spans its local Y/Z: at identity +Y is up (height)
  // and +Z is width — make it wide-but-low (16 m wide, 2 m tall)
  data.gates.find(g => g.gate === 7).trans.scale = [100, 100, 800];
  const { xml } = convert(data);
  assert.match(xml, /<Box x="16" y="\.01" z="2"\/>/);
});

test('an MRSIM sprint converts back to a VD sprint, not a circuit', () => {
  const data = loadFixture('synthetic-track.json');
  data.gates.find(g => g.gate === 0).finish = false;
  data.gates.find(g => g.gate === 6).finish = true;   // sprint: finish at the flag
  const { xml, normal } = convert(data);
  assert.equal(normal.isCircuit, false);
  assert.match(xml, /isCircuit: false/);
  const back = mrsimToVd(parseMrsim(xml, 'sprint.xml'));
  const gates = back.json.gates;
  assert.equal(gates[0].start, true);
  assert.equal(gates[0].finish, false);
  assert.equal(gates[gates.length - 1].finish, true);
});

test('validator rejects a sensor that lost its trigger material', () => {
  const { xml, summary, normal } = convert(loadFixture('synthetic-track.json'));
  const bad = xml.replace('<StaticContact contactMaterial="-1"/>',
    '<StaticContact contactMaterial="TrackPart"/>');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /not a trigger volume/.test(e)));
});

test('validator rejects a checkpoint listed by its wrapper name', () => {
  const { xml, summary, normal } = convert(loadFixture('synthetic-track.json'));
  // the game silently drops wrapper-name references when the checkpoint lives
  // in a named child — the exact failure that once broke a converted track.
  // (replace the checkpoint-LIST entry, not the entity attribute)
  const bad = xml.replace(/^(\s+)"trkFlag1_pass"/m, '$1"trkFlag1"');
  const v = validateMrsim(bad, { summary: { ...summary,
    cpNames: summary.cpNames.map(n => n === 'trkFlag1_pass' ? 'trkFlag1' : n) }, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /listed by its wrapper/.test(e)));
});

test('a non-gate start element produces a clear warning', () => {
  const data = loadFixture('synthetic-track.json');
  data.gates.find(g => g.gate === 0).start = false;
  data.gates.find(g => g.gate === 0).finish = false;
  data.gates.find(g => g.gate === 6).start = true;    // start on the flag
  data.gates.find(g => g.gate === 6).finish = true;
  const { warnings } = convert(data);
  assert.ok(warnings.some(w => /start element is a flag/.test(w)), warnings.join(' | '));
});

test('upright checkpoint sensors are centred on the stored point', () => {
  // VD DefaultSquare triggers are centred on their position; an offset sensor
  // lands on the window frame of a block-built wall and can never fire
  const { summary, normal } = convert(loadFixture('synthetic-track.json'));
  const up = summary.emitted.find(e => e.form === 'upright');
  const src = normal.crossings.find(c => c.kind === 'checkpoint' && !c.degenerate);
  assert.ok(up.expectPos.distanceTo(src.pos) < 1e-9,
    `sensor centre ${up.expectPos.toArray()} vs stored ${src.pos.toArray()}`);
});

test('a Z-rolled square lies flat: dive/climb plate at the stored point', () => {
  const data = loadFixture('synthetic-track.json');
  const sq = data.gates.find(g => g.gate === 7);
  sq.trans.rot = [-707, 0, 0, 707];        // roll about Z -> local +X vertical
  const { summary } = convert(data);
  const e = summary.emitted.find(x => x.vdBadge === 8);
  assert.equal(e.form, 'plate');
  // slab centred on the stored point (the aperture plane height)
  const src = convert(data).normal.crossings.find(c => c.vdBadge === 8);
  assert.ok(e.expectPos.distanceTo(src.pos) < 1e-9);
});

test('flags stand at the true VD height and never sink below the floor', () => {
  const { xml } = convert(loadFixture('synthetic-track.json'));
  // race flag (170, 5.6 m native at 100%): pole cylinder the full height
  assert.match(xml, /trkFlag1_pole/);
  assert.match(xml, /<Cylinder radius="\.045" height="5\.6"\/>/);
  // the sunken deco flag (stored 2 m underground) is clamped to the floor
  const deco = xml.match(/<Transform ([^>]*)>\s*<Entity name="decoFlag1">/);
  assert.ok(deco && / z="0"/.test(deco[1]), deco?.[1]);
});

test('flag cloth hangs on the VD side (+X) and is never solid', () => {
  const { xml } = convert(loadFixture('synthetic-track.json'));
  for (const nm of ['trkFlag1_cloth', 'decoFlag1_cloth']) {
    const block = xml.match(new RegExp(`<Entity name="${nm}">[\\s\\S]*?</Entity>`))[0];
    const x = parseFloat(block.match(/WorldFromEntityComponent x="([^"]+)"/)[1]);
    assert.ok(x > 0, `${nm} on +X (got ${x})`);
    assert.ok(!/StaticContact/.test(block), `${nm} has no collision`);
  }
});

test('the launch stand is not rotated relative to the lap direction', () => {
  const { xml } = convert(loadFixture('synthetic-track.json'));
  // StartPosition faces the stand's local +Y; any extra yaw here points the
  // spawned drone away from checkpoint 1 (was 90° right in-game)
  assert.match(xml, /<Transform z="\.025">\s*<Include file="[^"]*MetalLaunchStand\.xml"\/>/);
});

test('validator catches a flag pole sunk below the floor', () => {
  const { xml, summary, normal } = convert(loadFixture('synthetic-track.json'));
  const bad = xml.replace(/<Transform x="30" y="48" z="[^"]*"/, '<Transform x="30" y="48" z="-1"');
  assert.notEqual(bad, xml, 'flag transform not found');
  const v = validateMrsim(bad, { summary, normal });
  assert.ok(v.errors.some(e => /pole is sunk/.test(e)), v.errors.join(' | '));
});

test('gate dressing blocks are evicted from the opening', () => {
  const data = loadFixture('synthetic-track.json');
  // a decorative post through the middle of the start gate (VD dresses its
  // taller gates with blocks that end up inside the smaller MRSIM aperture)
  data.barriers.push({ prefab: 2219,
    trans: { pos: [0, 150, 0], rot: [1000, 0, 0, 0], scale: [10, 370, 10] } });
  const r = convert(data);
  assert.equal(r.summary.counts.evicted, 1);
  assert.ok(r.warnings.some(w => /removed from gate openings/.test(w)));
});

test('a sunken invisible marker does not float the track', () => {
  const data = loadFixture('synthetic-track.json');
  // sink a turn pole below every gate: the ground level must still come from
  // the physical gates, not from invisible checkpoint markers
  data.gates.find(g => g.gate === 9).trans.pos[1] = -100;
  const n = convert(data).normal;
  assert.ok(Math.abs(n.layout.groundY - (-0.5)) < 1e-9, `groundY ${n.layout.groundY}`);
});

test('spawn faces along the lap when the first element is a turn pole', () => {
  const data = loadFixture('synthetic-track.json');
  // renumber so the pole (gate 9) becomes the first element
  data.gates.find(g => g.gate === 9).gate = -1;
  const { summary, normal } = convert(data);
  assert.equal(normal.crossings[0].pole, true);
  assert.ok(summary.spawn.heading.dot(normal.crossings[0].pathHeading) > 0.99);
});
