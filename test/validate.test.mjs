import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DIMS, loadFixture } from './helpers.mjs';
import { makeClassifier } from '../convert/vd-classify.js';
import { vdToMrsim } from '../convert/emit-mrsim.js';
import { validateMrsim } from '../convert/validate.js';

const { classify, prefabName, gateWidthFor } = makeClassifier(CATALOG, DIMS);
const converted = () =>
  vdToMrsim(loadFixture('synthetic-track.json'), classify, prefabName, { gateWidthFor });

test('a clean conversion validates with zero errors', () => {
  const { xml, summary, normal } = converted();
  const v = validateMrsim(xml, { summary, normal });
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(v.stats.checkpoints, summary.cpNames.length);
  assert.equal(v.comparison.length, summary.cpNames.length);
  assert.ok(v.comparison.every(c => c.posDelta < 0.25 && c.dirDot > 0.95));
});

test('a checkpoint dropped from the list is caught', () => {
  const { xml, summary, normal } = converted();
  const bad = xml.replace(/^\s*"trkCheck2_pass",\r?\n/m, '');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /does not match|emitted/.test(e)));
});

test('a misnamed checkpoint (unresolvable) is caught', () => {
  const { xml, summary, normal } = converted();
  const bad = xml.replace('name="trkGate2"', 'name="trkGate99"');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /did not resolve|unresolved/.test(e)));
});

test('NaN coordinates are caught', () => {
  const { xml, summary, normal } = converted();
  const bad = xml.replace(/<Transform x="[^"]+"/, '<Transform x="NaN"');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /NaN|non-finite/.test(e)));
});

test('an oversized sensor is caught', () => {
  const { xml, summary, normal } = converted();
  const bad = xml.replace('<Box x="16" y="16" z="7.8"/>', '<Box x="45" y="16" z="7.8"/>');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /oversized/.test(e)));
});

test('a buried checkpoint is caught', () => {
  const { xml, summary, normal } = converted();
  // sink the pole column transform far underground
  const bad = xml.replace(/(<Transform x="45" y="[^"]*") z="0"/, '$1 z="-40"');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /below the MRSIM floor|from intended/.test(e)));
});

test('a moved sensor is caught by the intent comparison', () => {
  const { xml, summary, normal } = converted();
  const bad = xml.replace('<Transform x="45"', '<Transform x="52"');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /from intended|drift/.test(e)));
});

test('a broken macro reference is caught', () => {
  const { xml, summary, normal } = converted();
  const bad = xml.replace('<Instance macro="Centered5x5Gate"/>',
    '<Instance macro="NoSuchMacro"/>');
  const v = validateMrsim(bad, { summary, normal });
  assert.equal(v.ok, false);
});

test('non-XML input fails gracefully', () => {
  const v = validateMrsim('this is not xml');
  assert.equal(v.ok, false);
  assert.ok(v.errors[0].includes('does not parse'));
});

test('validation works standalone without converter context', () => {
  const { xml } = converted();
  const v = validateMrsim(xml);
  assert.equal(v.ok, true);
});
