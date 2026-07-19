import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { decryptTrk, encryptTrk, buildTrk, parseTrk } from '../trk.js';

test('encrypt -> decrypt round trip', () => {
  const text = '16\nMy Track\n{"gates":[]}\n0\n0';
  assert.equal(decryptTrk(encryptTrk(text)), text);
});

test('buildTrk -> parseTrk round trip preserves the track', () => {
  const json = {
    gates: [{ prefab: 742, trans: { pos: [1, 2, 3], rot: [1000, 0, 0, 0], scale: [100, 100, 100] }, gate: 0, start: true, finish: true }],
    barriers: [],
  };
  const trk = buildTrk(8, 'Round Trip {weird} name', json);
  const parsed = parseTrk(trk, 'x.trk');
  assert.equal(parsed.meta.name, 'Round Trip {weird} name');
  assert.equal(parsed.meta.scene_id, 8);
  assert.deepEqual(parsed.gates, json.gates);
});

test('newlines in track names cannot break the framing', () => {
  const trk = buildTrk(16, 'evil\nname', { gates: [{ prefab: 1, trans: { pos: [0, 0, 0], rot: [1000, 0, 0, 0] }, gate: 0 }] });
  assert.equal(parseTrk(trk).meta.name, 'evil name');
});

test('invalid input produces clear errors', () => {
  assert.throws(() => decryptTrk('not base64 !!!'), /base64/);
  assert.throws(() => decryptTrk('YWJj'), /block size/);          // 3 bytes
  // valid base64, right length, wrong content -> padding check fails
  assert.throws(() => decryptTrk(btoa('x'.repeat(32))), /wrong key or corrupt/);
});

test('parseTrk rejects tracks without gates', () => {
  assert.throws(() => parseTrk(encryptTrk('16\nempty\n{"gates":[]}\n0\n0')), /no gates/);
  assert.throws(() => parseTrk(encryptTrk('16\nempty\nnot json\n0\n0')), /no track JSON/);
});
