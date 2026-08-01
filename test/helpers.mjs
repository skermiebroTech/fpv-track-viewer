// Shared test scaffolding: DOM shims for mrsim.js under Node, a minimal
// prefab catalogue, and the synthetic fixture track.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';

globalThis.DOMParser = globalThis.DOMParser || DOMParser;
globalThis.location = globalThis.location || { href: 'http://localhost/' };

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// minimal but truthful slice of tracks/prefabs.json
export const CATALOG = {
  prefabs: {
    285: ['DefaultMGPRF', 'Gates', 1],
    286: ['DefaultMGPRFWindow', 'Gates', 1],
    742: ['WDCGate', 'Gates', 1],
    170: ['DefaultMGP4MFlag', 'Gates', 1],
    88: ['DefaultSquare', 'Invisible', 1],
    2231: ['DefaultInvisibleFlagPole', 'Invisible', 1],
    2232: ['DefaultInvisibleOffsetFlag', 'Invisible', 1],
    344: ['ControlCurve', 'Tools', 0],
    275: ['DefaultMGPHurdle', 'Barriers', 0],
    729: ['KDRAHurdle', 'Barriers', 0],
    740: ['WDCFlag1', 'Barriers', 0],
    336: ['DefaultNetBlack', 'Barriers', 0],
    90: ['DefaultStartGrid', 'Barriers', 0],
    2219: ['BlockWhite', 'Barriers', 0],
  },
};
export const DIMS = {
  285: [-1.6, 0, -0.02, 1.6, 2.56, 0.03],
  286: [-1.6, 0, -0.02, 1.6, 3.2, 0.03],
  742: [-1.6, 0, -0.02, 1.6, 2.56, 0.03],
  170: [-1.23, 0, -0.01, 0.01, 5.6, 0.01],
  740: [-0.88, 0, -0.01, 0.01, 3.99, 0.01],
  275: [-1.52, 0, -0.02, 1.52, 1.52, 0.03],
  // a 3-D structure that still matches /hurdle/i (KDRAHurdle's real bounds)
  729: [-1.78, 0, -1.74, 1.78, 2.98, 1.74],
};

export function loadFixture(name) {
  return JSON.parse(readFileSync(join(ROOT, 'test/fixtures', name), 'utf8'));
}

// full local catalogue when present (regression tests on real tracks)
export function loadRealCatalog() {
  return {
    catalog: JSON.parse(readFileSync(join(ROOT, 'tracks/prefabs.json'), 'utf8')),
    dims: JSON.parse(readFileSync(join(ROOT, 'tracks/prefab-dims.json'), 'utf8')),
  };
}

export function localTrack(name) {
  const p = join(ROOT, 'tracks', name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
