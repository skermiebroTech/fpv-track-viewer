import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DIMS, loadFixture } from './helpers.mjs';
import { makeClassifier } from '../convert/vd-classify.js';
import { vdToMrsim } from '../convert/emit-mrsim.js';
import { mrsimToVd } from '../convert/mrsim-to-vd.js';
import { parseMrsim } from '../mrsim.js';

const { classify, prefabName, gateWidthFor, heightFor, boundsFor } = makeClassifier(CATALOG, DIMS);

test('round trip VD -> MRSIM -> VD preserves the lap', () => {
  const src = loadFixture('synthetic-track.json');
  const { xml, summary } = vdToMrsim(src, classify, prefabName, { gateWidthFor, heightFor, boundsFor });
  const back = mrsimToVd(parseMrsim(xml, 'rt.xml'));
  // one VD gate per MRSIM checkpoint, in order
  assert.equal(back.json.gates.length, summary.cpNames.length);
  back.json.gates.forEach((g, i) => assert.equal(g.gate, i));
  // start/finish collapses onto the first element
  assert.equal(back.json.gates[0].start, true);
  assert.equal(back.json.gates[0].finish, true);
  // targets an empty VD scene by default
  assert.equal(back.sceneId, 16);
  // scenery skipped on the way back is reported, not silent
  assert.ok(back.warnings.some(w => /scenery/.test(w)));
});

test('round-trip gate positions survive within a metre', () => {
  const src = loadFixture('synthetic-track.json');
  const { xml, normal } = vdToMrsim(src, classify, prefabName, { gateWidthFor, heightFor, boundsFor });
  const back = mrsimToVd(parseMrsim(xml, 'rt.xml'));
  // compare the start gate: source crossing (recentred) vs round-tripped base
  const rt = back.json.gates[0].trans.pos.map(v => v / 100);
  const srcPos = normal.crossings[0].pos;
  assert.ok(Math.hypot(rt[0] - srcPos.x, -rt[2] - srcPos.z) < 1.0,
    `start gate moved: ${rt} vs ${srcPos.toArray()}`);
});

test('mrsimToVd rejects tracks without a sequence', () => {
  assert.throws(() => mrsimToVd({ seq: [], elements: [], meta: {} }), /no checkpoint sequence/);
});
