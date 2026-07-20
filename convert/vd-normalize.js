// ===========================================================================
// VelociDrone track JSON -> normalised track model.
//
// Everything semantic about the source track is decided here, in the viewer's
// three.js space (right-handed Y-up, metres), so the emitter only has to
// render decisions:
//   * the ordered crossing list (sequence sorted by the `gate` field), with
//     editor tools filtered out and true duplicates merged,
//   * each crossing's kind, position, crossing direction and gate width,
//   * degenerate-direction handling: VD invisible checkpoints often store a
//     near-vertical +Z (turn poles / flat "stay low" squares); their sensors
//     must not inherit that as a plane heading, so each degenerate crossing
//     gets a path heading derived from its neighbours instead,
//   * the ground offset and recentring shift that map the track onto MRSIM's
//     solid z=0 floor near the world origin,
//   * scenery (barrier) items with their object-mapping decision.
//
// Merging rule (same as the viewer's racing-line dedup): consecutive
// crossings of the same kind within 0.1 m whose directions agree (dot>0.95)
// collapse into one — VD fires both in a single pass, so one sensor with one
// checkpoint-list entry preserves the lap exactly.
// ===========================================================================
import * as THREE from 'three';
import { CM, X_AXIS, Z_AXIS, vdVec, vdQuat } from './space.js';
import { mapScenery } from './mapping.js';

export function normalizeVdTrack(data, { classify, prefabName = () => '', gateWidthFor = () => 3.2,
  humanLines = [] } = {}) {
  if (!Array.isArray(data?.gates)) throw new Error('not a VelociDrone track: no gates array');
  const seq = [...data.gates].sort((a, b) => a.gate - b.gate);
  if (!seq.length) throw new Error('track has no gates to convert');
  const warnings = [];

  const kinds = seq.map(g => classify(g));
  const raceable = seq.filter((g, i) => kinds[i] !== 'tool');
  const raceKinds = kinds.filter(k => k !== 'tool');
  if (!raceable.length) throw new Error('no convertible gates in this track');

  // Put the track's GROUND LEVEL on MRSIM's z=0 floor. The level comes from
  // physical objects (gates/flags stand on the ground); invisible checkpoint
  // markers can be stored sunk below the field (the 2026 Australian Nationals
  // has poles at -1.10 under a -0.86 field) and must not float everything.
  // Robustness rule (same as the viewer's groundFromBases): the lowest base
  // that isn't sunk more than 0.75 m below the median.
  const PHYSICAL = new Set(['gate', 'dive', 'flag']);
  const physBases = raceable
    .filter((g, i) => PHYSICAL.has(raceKinds[i]))
    .map(g => g.trans.pos[1] * CM);
  // ground = the lowest physical base, unless it is a LONE buried outlier
  // (a single gate sunk >0.6 below everything else — e.g. the 2025 MultiGP
  // Euro Champs buries one tall gate 1.8 m down); multi-level tracks keep
  // their lowest level on the floor.
  const pool = (physBases.length ? physBases : raceable.map(g => g.trans.pos[1] * CM))
    .sort((a, b) => a - b);
  let groundY = pool[0] ?? 0;
  if (pool.length >= 4 && pool.filter(b => b <= pool[0] + 0.6).length === 1) {
    groundY = pool[1];
  }

  // circuit vs sprint: a VD circuit crosses one start/finish gate to close the
  // lap; a sprint finishes at a different gate. Default to circuit.
  const startG = seq.find(g => g.start), finishG = seq.find(g => g.finish);
  const isCircuit = !finishG || !startG || finishG.gate === startG.gate;

  // recentre so the track sits near the world origin (VD stores absolute
  // positions that can be hundreds of metres out): drop the first crossing to
  // (0, ·, 0) in the ground plane and shift everything — gates and scenery —
  // by the same vector, so relative positions (the race) are untouched.
  const fp = vdVec(raceable[0].trans.pos); fp.y -= groundY;
  const shift3 = new THREE.Vector3(fp.x, 0, fp.z);
  const place = p => { const q = p.clone().sub(shift3); q.y -= groundY; return q; };

  // ---- crossings -----------------------------------------------------------
  let crossings = raceable.map((g, ri) => {
    const rawPos = vdVec(g.trans.pos);
    const quat = vdQuat(g.trans.rot);
    const name = prefabName(g.prefab) || '';
    const kind = raceKinds[ri];
    // crossing axis: gates/flags/windows cross along local +Z (frame in XY);
    // the invisible SQUARE checkpoint's aperture is its local Y/Z plane and
    // it is crossed along local +X (its mesh is thin in X: bbox x ±0.04,
    // y ±1, z 2 m). Track designers roll squares ±90° to lay them flat as
    // dive/climb apertures (wall-top compartments, elevated hoops) — with
    // the +Z convention those sensors came out vertical and displaced
    // ("positioned vertically instead of horizontally", verified in-game on
    // the 2026 Australian Nationals).
    const squareAxis = kind === 'checkpoint' && /square/i.test(name);
    const dir = (squareAxis ? X_AXIS : Z_AXIS).clone().applyQuaternion(quat);
    const scale = [
      (g.trans.scale?.[0] ?? 100) / 100,
      (g.trans.scale?.[1] ?? 100) / 100,
      (g.trans.scale?.[2] ?? 100) / 100,
    ];
    // a turn pole marks "pass anywhere beside me" — always a column volume,
    // whatever its stored orientation
    const pole = kind === 'checkpoint' && (/pole/i.test(name) ||
      Math.max(...(g.trans.scale ?? [100])) >= 5000);
    const degenerate = pole ||
      (kind === 'checkpoint' && Math.abs(dir.y) > 0.85);
    return {
      vdBadge: g.gate + 1,          // VD's 1-based sequence number
      kind,
      prefab: g.prefab,
      prefabName: name,
      rawPos,
      pos: place(rawPos),
      quat,
      dir,
      scale,
      squareAxis,
      gateWidth: gateWidthFor(g.prefab) * scale[0],
      start: !!g.start,
      finish: !!g.finish,
      degenerate,
      pole,
      mergedBadges: [],
    };
  });

  // ---- merge true duplicates ----------------------------------------------
  const merged = [];
  for (const c of crossings) {
    const prev = merged[merged.length - 1];
    // degenerate pairs merge on position alone: their stored directions are
    // near-vertical noise, and their converted volumes would coincide anyway
    if (prev && prev.kind === c.kind &&
        prev.rawPos.distanceTo(c.rawPos) < 0.1 &&
        (prev.dir.dot(c.dir) > 0.95 || (prev.degenerate && c.degenerate))) {
      prev.mergedBadges.push(c.vdBadge);
      prev.start ||= c.start;
      prev.finish ||= c.finish;
      continue;
    }
    merged.push(c);
  }
  const nMerged = crossings.length - merged.length;
  if (nMerged) {
    warnings.push(`merged ${nMerged} duplicate checkpoint(s) stacked on the same spot ` +
      '(VelociDrone fires them in a single pass)');
  }
  crossings = merged;

  // ---- path headings for degenerate crossings ------------------------------
  // horizontal travel direction through crossing i, from its neighbours
  const n = crossings.length;
  crossings.forEach((c, i) => {
    const prev = crossings[i > 0 ? i - 1 : (isCircuit ? n - 1 : i)];
    const next = crossings[i < n - 1 ? i + 1 : (isCircuit ? 0 : i)];
    c.pathDelta = next.rawPos.clone().sub(prev.rawPos);   // full 3D lap travel
    const h = c.pathDelta.clone().setY(0);
    if (h.lengthSq() < 1e-6) {
      // co-located neighbours: fall back to the stored horizontal residual
      h.set(c.dir.x, 0, c.dir.z);
      if (h.lengthSq() < 1e-6) h.set(0, 0, 1);
    }
    c.pathHeading = h.normalize();
  });

  // ---- facing: orient every crossing the way the lap crosses it ------------
  // The stored VD orientation only defines the crossing AXIS — VD triggers
  // fire in both senses, so designers freely place gates and checkpoints
  // "backwards". MRSIM checkpoints are directional (the guidance arrow and
  // next-gate indicator follow the reference normal), so flip any crossing
  // whose stored direction opposes the actual travel: the human racing
  // lines' velocity at closest approach when lines are supplied, the
  // neighbour-to-neighbour lap delta otherwise. The flip also fixes the
  // dive/climb sense of flat squares (dir.y decides cage type downstream).
  // Travel through crossing k = the ghost's velocity where it passes closest,
  // accumulated as a proximity-weighted sum of every nearby segment's heading.
  // A weighted sum (not a single closest-approach pick, nor an in-order walk)
  // is robust to the two things that break naive matching: MULTI-LAP ghosts
  // (each lap crosses k the same way, so every pass reinforces one direction)
  // and the lap passing NEAR itself (the true pass is nearest, so it dominates
  // the 1/d² weight). Earlier single-pass matchers desynced and left the back
  // half of long tracks with no ghost travel at all — those fell back to noisy
  // neighbour deltas and flipped gates the wrong way.
  const travel = crossings.map(() => null);
  for (const line of humanLines) {
    for (let k = 0; k < crossings.length; k++) {
      const cp = crossings[k].rawPos;
      const acc = new THREE.Vector3();
      for (let i = 1; i < line.length; i++) {
        const d = 0.5 * (line[i - 1].distanceTo(cp) + line[i].distanceTo(cp));
        if (d > 6) continue;               // only segments passing near the crossing
        const v = line[i].clone().sub(line[i - 1]);
        if (v.lengthSq() > 1e-8) acc.addScaledVector(v.normalize(), 1 / (d * d + 0.25));
      }
      if (acc.lengthSq() > 1e-8) (travel[k] ??= new THREE.Vector3()).add(acc);
    }
  }
  // Compare only the component that decides anything downstream — the
  // vertical sense for steep crossings (dive vs climb cage), the yaw sense
  // for the rest — and flip only on CONFIDENT opposition (< -0.2): a pitched
  // window's horizontal residual, or the vertical noise of a level path,
  // must not overturn the stored sense.
  let flipped = 0;
  crossings.forEach((c, i) => {
    const raw = travel[i] && travel[i].lengthSq() > 1e-6 ? travel[i] :
      (c.pathDelta.lengthSq() > 1e-6 ? c.pathDelta : null);
    if (!raw) return;
    const ref = raw.clone().normalize();
    let sense;
    if (Math.abs(c.dir.y) > 0.5) {
      sense = Math.sign(c.dir.y) * ref.y;
    } else {
      const dH = Math.hypot(c.dir.x, c.dir.z), rH = Math.hypot(ref.x, ref.z);
      sense = dH > 1e-6 && rH > 1e-6
        ? (c.dir.x * ref.x + c.dir.z * ref.z) / (dH * rH) : 0;
    }
    if (sense < -0.2) { c.dir.negate(); flipped++; }
  });
  if (flipped) {
    warnings.push(`${flipped} checkpoint(s) stored facing against the lap were ` +
      'turned to the crossing direction');
  }

  // ---- scenery -------------------------------------------------------------
  const scenery = (data.barriers || []).map(b => {
    const name = prefabName(b.prefab) || '';
    return {
      prefab: b.prefab,
      prefabName: name,
      rawPos: vdVec(b.trans.pos),
      pos: place(vdVec(b.trans.pos)),
      quat: vdQuat(b.trans.rot),
      scale: (b.trans.scale || [100, 100, 100]).map(s => s / 100),
      map: mapScenery(b.prefab, name),
    };
  });

  const counts = { gate: 0, dive: 0, flag: 0, checkpoint: 0 };
  crossings.forEach(c => { counts[c.kind] = (counts[c.kind] || 0) + 1; });

  return {
    name: data.meta?.name,
    sceneId: data.meta?.scene_id,
    crossings,
    scenery,
    layout: { groundY, shift3 },
    isCircuit,
    counts,
    merged: nMerged,
    tools: seq.length - raceable.length,
    warnings,
  };
}
