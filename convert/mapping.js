// ===========================================================================
// Object-mapping tables: which MRSIM object stands in for each VelociDrone
// prefab, and the fixed catalogue data both directions share.
//
// Ground truth for the trigger-volume choices (extracted from the game's
// race-gate prefabs in the VelociDrone asset bundles, 2026-07-18):
//   * WDCGate (742): trigger box 2.18 w x 1.90 h x 0.10 thin, centred 0.96 m
//     up, normal = local +Z  -> gates cross along +Z, triggers are TIGHTER
//     than the visible aperture.
//   * DefaultMultiGPSquare: 1.52 x 1.51 x 0.10 at 0.77 up, same pattern.
//   * DefaultMGP4MFlag (170): one-sided 25.4 x 7.5 m wall starting at the
//     pole and extending along local +X (the side away from the cloth),
//     centred 2.6 m up — VD flags work like MRSIM's FlagPass side plane.
//   * Invisible prefabs (88/2231/2232) have no bundled prefab at all (runtime
//     built); their exported mesh bounds are editor markers, not triggers.
// ===========================================================================
import { neonShapeOf, neonHexOf } from './neon.js';

// VD's stretchable building blocks -> plain MRSIM boxes with the same colour
export const VD_BLOCKS = {
  2218: ['Black', [.05, .05, .05]],
  2219: ['White', [.9, .9, .9]],
  2220: ['Red', [.9, 0, 0]],
  2221: ['Orange', [.9, .45, 0]],
  2222: ['Yellow', [.9, .9, 0]],
  2223: ['Green', [0, .8, 0]],
  2224: ['Cyan', [0, .85, .85]],
  2225: ['Blue', [0, 0, .9]],
  2226: ['Purple', [.55, 0, .9]],
  2227: ['Pink', [.95, .5, .75]],
  2228: ['RedPink', [.9, .1, .4]],
  2229: ['LightBlue', [.02, .4, .9]],
  2230: ['DarkGreen', [0, .4, .1]],
};

// MRSIM locations a converted track can load into
export const MRSIM_LOCATIONS = [
  ['EmptyGrassWorld', 'Empty Grass World'],
  ['BaylandsPark', 'Baylands Park'],
  ['HardestyBMXTrack', 'Hardesty BMX Track'],
];
// VelociDrone scenes a converted .trk can target (empty scenes carry no props)
export const VD_SCENES = [
  [16, 'Empty Scene Day'],
  [17, 'Empty Scene Night'],
  [42, 'Empty PolyWorld'],
  [43, 'Future Hangar Empty'],
];

// VD prefab ids used when converting MRSIM -> VelociDrone
export const VD = { GATE: 285, WINDOW: 286, FLAG: 170, CHECKPOINT: 88, BLOCK_WHITE: 2219 };

// the "Centered…" gate macros: the shift is -width/2 so the gate's
// CheckpointReference lands on the entity origin — 5x5 gate is 2.1 m
// (shift -1.05), 7x6 gate is 3 m (shift -1.5).
export const MACRO_DEFS = {
  Centered5x5Gate: ['-1.05', '5x5Gate.xml'],
  Centered5x5StartFinishGate: ['-1.05', '5x5StartFinishGate.xml'],
  Centered7x6Gate: ['-1.5', '7x6Gate.xml'],
  Centered7x6StartFinishGate: ['-1.5', '7x6StartFinishGate.xml'],
};

// MRSIM gates come in two fixed sizes: pick whichever matches the real VD
// gate width — the 3 m 7x6 gate (VD's 3.2 m race gates) or the 2.1 m 5x5.
export function pickGate(widthM, isStartFinish) {
  const big = widthM >= 2.55;
  return {
    macro: big
      ? (isStartFinish ? 'Centered7x6StartFinishGate' : 'Centered7x6Gate')
      : (isStartFinish ? 'Centered5x5StartFinishGate' : 'Centered5x5Gate'),
    typeId: big
      ? (isStartFinish ? 'start-finish-7x6' : 'gate-7x6')
      : (isStartFinish ? 'start-finish-5x5' : 'gate-5x5'),
    half: big ? 1.5 : 1.05,          // gate half-width (post spacing)
    width: big ? 3.0 : 2.1,          // aperture the player actually gets
  };
}

// how a VD barrier prefab converts: a colour block, a hurdle panel, a deco
// flag, a glowing neon run, or nothing MRSIM can represent
export function mapScenery(prefabId, prefabName) {
  if (VD_BLOCKS[prefabId]) return { type: 'block', color: VD_BLOCKS[prefabId] };
  if (/hurdle/i.test(prefabName)) return { type: 'hurdle' };
  // VD's whole neon family (rings, squares, triangles, decagons, corners,
  // angles, back bars, strips, cone collars) — glowing tube outlines, which
  // MRSIM can do with the PBREmissive material its own drone LEDs use. Checked
  // before /flag/ so nothing in the family is mistaken for a feather flag.
  if (/neon/i.test(prefabName))
    return { type: 'neon', shape: neonShapeOf(prefabName), color: neonHexOf(prefabName) };
  if (/flag/i.test(prefabName)) return { type: 'flag' };
  // VD nets are runtime meshes with unit-cube sizing (scale = metres):
  // approximate as solid dark panels with the same footprint and collisions
  if (/net/i.test(prefabName)) return { type: 'net' };
  return { type: 'skip' };
}
