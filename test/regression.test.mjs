// Regression tests over real tracks. The 2024 AU NATS Quali is committed;
// other tracks (including the private 2026 AU NATS V3 Polished) are local
// overlays — their tests skip cleanly when the files are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRealCatalog, localTrack } from './helpers.mjs';
import { makeClassifier } from '../convert/vd-classify.js';
import { vdToMrsim } from '../convert/emit-mrsim.js';
import { validateMrsim } from '../convert/validate.js';

const { catalog, dims } = loadRealCatalog();
// the shipped option set, so these goldens are the real converter output
const { classify, prefabName, gateWidthFor, heightFor, boundsFor } = makeClassifier(catalog, dims);
const convert = data =>
  vdToMrsim(data, classify, prefabName, { gateWidthFor, heightFor, boundsFor });

test('2024 AU NATS Quali converts and validates', () => {
  const data = localTrack('2024-au-nats-quali.json');
  assert.ok(data, 'committed reference track missing');
  const { xml, summary, normal } = convert(data);
  assert.equal(summary.counts.crossings, 14);
  assert.deepEqual(
    [summary.counts.gates, summary.counts.dives, summary.counts.flags, summary.counts.checkpoints],
    [6, 1, 6, 1]);
  assert.equal(summary.isCircuit, true);
  const v = validateMrsim(xml, { summary, normal });
  assert.deepEqual(v.errors, []);
  // the lone invisible checkpoint is a straight-down pole -> upright pane
  assert.equal(summary.emitted.find(e => e.kind === 'checkpoint').form, 'pane');
});

test('2026 AU NATS V3 Polished (local) converts and validates', t => {
  const data = localTrack('2026-au-nats-v3-polished.json');
  if (!data) return t.skip('private track not present locally');
  const { xml, warnings, summary, normal } = convert(data);
  // 47 sequence objects -> 46 checkpoints (one co-located duplicate merged)
  assert.equal(summary.counts.sourceSequence, 47);
  assert.equal(summary.counts.crossings, 46);
  assert.equal(summary.counts.merged, 1);
  assert.deepEqual(
    [summary.counts.gates, summary.counts.dives, summary.counts.flags, summary.counts.checkpoints],
    [27, 0, 0, 19]);
  // sensor forms: 12 panes across the lap (11 turn poles + one offset-flag
  // marker — flown PAST, so not an aperture), 5 dive/climb plates (only a
  // rolled DefaultSquare lies flat), 2 upright windows
  const forms = summary.emitted.filter(e => e.kind === 'checkpoint').map(e => e.form);
  assert.equal(forms.filter(f => f === 'pane').length, 12);
  assert.equal(forms.filter(f => f === 'plate').length, 5);
  assert.equal(forms.filter(f => f === 'upright').length, 2);
  // every gate is a true-size frame (WDC gates are 3.2-3.84 m wide — bigger
  // than any MRSIM gate model)
  assert.ok(summary.emitted.filter(e => e.kind === 'gate').every(e => e.form === 'exact'));
  assert.equal(summary.emitted.filter(e => e.sf).length, 1);
  assert.equal(summary.counts.nets, 76);
  // low boundary strips under gates are flown over, never evicted
  assert.equal(summary.counts.blocks, 202);
  assert.equal(summary.counts.evicted, 0);
  assert.equal(summary.counts.hurdles, 6);
  assert.ok(warnings.some(w => /source scene #8/.test(w)));
  const v = validateMrsim(xml, { summary, normal });
  assert.deepEqual(v.errors, []);
  assert.ok(v.comparison.every(c => c.posDelta < 0.05), 'parser agrees with intent');
});

test('every local track converts without errors', t => {
  const names = ['2022-mission-foods.json', 'dutch-drone-madness-2021-race1.json',
    '2025-multigp-european-champs.json', 'fai-world-cup-italy-2024.json',
    'ddr-race-series-track-5.json'];
  let ran = 0;
  for (const n of names) {
    const data = localTrack(n);
    if (!data) continue;
    ran++;
    const { xml, summary, normal } = convert(data);
    const v = validateMrsim(xml, { summary, normal });
    assert.deepEqual(v.errors, [], `${n}: ${v.errors[0] ?? ''}`);
  }
  if (!ran) t.skip('no local corpus tracks present');
});
