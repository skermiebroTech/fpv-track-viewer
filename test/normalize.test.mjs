import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DIMS, loadFixture } from './helpers.mjs';
import { makeClassifier } from '../convert/vd-classify.js';
import { normalizeVdTrack } from '../convert/vd-normalize.js';

const { classify, prefabName, gateWidthFor } = makeClassifier(CATALOG, DIMS);
const fixture = () => loadFixture('synthetic-track.json');
const normalize = data => normalizeVdTrack(data, { classify, prefabName, gateWidthFor });

test('sequence is ordered by the gate field, tools dropped, duplicates merged', () => {
  const n = normalize(fixture());
  // 13 sequence objects: 1 tool dropped, 1 duplicate merged -> 11 crossings
  assert.equal(n.tools, 1);
  assert.equal(n.merged, 1);
  assert.equal(n.crossings.length, 11);
  assert.deepEqual(n.crossings.map(c => c.vdBadge), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(n.crossings[10].mergedBadges.length, 1);
  assert.ok(n.warnings.some(w => /merged 1 duplicate/.test(w)));
});

test('kinds and degenerate detection', () => {
  const n = normalize(fixture());
  const kinds = n.crossings.map(c => c.kind);
  assert.deepEqual(kinds,
    ['gate', 'gate', 'gate', 'dive', 'dive', 'dive', 'flag',
      'checkpoint', 'checkpoint', 'checkpoint', 'checkpoint']);
  const [, , , , , , , upright, flat, pole] = n.crossings;
  // squares cross along local +X: the identity square stands upright, the
  // Z-rolled square lies flat (a dive/climb aperture)
  assert.equal(upright.degenerate, false);
  assert.ok(Math.abs(upright.dir.y) < 0.1);
  assert.equal(flat.degenerate, true);
  assert.equal(flat.pole, false);
  assert.ok(Math.abs(flat.dir.y) > 0.95);
  assert.equal(pole.degenerate, true);
  assert.equal(pole.pole, true);
});

test('ground raise and recentring', () => {
  const n = normalize(fixture());
  // lowest raceable base is -0.5 m -> whole track raised 0.5
  assert.equal(n.layout.groundY, -0.5);
  // first crossing lands on the origin in the ground plane
  const first = n.crossings[0].pos;
  assert.ok(Math.abs(first.x) < 1e-9 && Math.abs(first.z) < 1e-9);
  assert.ok(Math.abs(first.y - 0.5) < 1e-9);   // raised by the ground offset
  // relative spacing is preserved by the shared shift
  const rawD = n.crossings[1].rawPos.distanceTo(n.crossings[0].rawPos);
  const outD = n.crossings[1].pos.distanceTo(n.crossings[0].pos);
  assert.ok(Math.abs(rawD - outD) < 1e-9);
});

test('circuit detection and start/finish flags', () => {
  const n = normalize(fixture());
  assert.equal(n.isCircuit, true);
  assert.equal(n.crossings[0].start, true);
  const data = fixture();
  data.gates.find(g => g.gate === 0).finish = false;
  data.gates.find(g => g.gate === 6).finish = true;   // finish elsewhere -> sprint
  assert.equal(normalize(data).isCircuit, false);
});

test('path heading for degenerate crossings follows the lap', () => {
  const n = normalize(fixture());
  const pole = n.crossings[9];
  // neighbours run +x/+z-ish; the stored dir points straight down
  assert.ok(Math.abs(pole.dir.y) > 0.95);
  assert.ok(Math.abs(pole.pathHeading.y) < 1e-9);
  assert.ok(pole.pathHeading.length() > 0.99);
  const travel = n.crossings[10].rawPos.clone().sub(n.crossings[8].rawPos).setY(0).normalize();
  assert.ok(pole.pathHeading.dot(travel) > 0.99);
});

test('gate width uses native dims x scale', () => {
  const n = normalize(fixture());
  assert.ok(Math.abs(n.crossings[0].gateWidth - 3.2) < 1e-9);        // WDC at 100%
  assert.ok(Math.abs(n.crossings[1].gateWidth - 1.92) < 1e-9);       // MGP at 60%
});

test('scenery mapping decisions', () => {
  const n = normalize(fixture());
  assert.deepEqual(n.scenery.map(s => s.map.type),
    ['block', 'hurdle', 'flag', 'net', 'skip']);
});

test('invalid input is rejected', () => {
  assert.throws(() => normalize({}), /no gates/);
  assert.throws(() => normalize({ gates: [] }), /no gates/);
  const onlyTools = { gates: [{ prefab: 344, trans: { pos: [0, 0, 0], rot: [1000, 0, 0, 0] }, gate: 0 }] };
  assert.throws(() => normalize(onlyTools), /no convertible gates/);
});

test('missing scale/rot fields fall back to defaults', () => {
  const data = { gates: [{ prefab: 742, trans: { pos: [0, 0, 0], rot: [1000, 0, 0, 0] }, gate: 0 }] };
  const n = normalize(data);
  assert.deepEqual(n.crossings[0].scale, [1, 1, 1]);
});
