// ===========================================================================
// Automated validation of a converted MRSIM track.
//
// Two independent layers:
//   1. STRUCTURAL — re-parse the emitted XML with the viewer's own MRSIM
//      parser (mrsim.js + the game's real library files in mrsim-lib.js).
//      That parser is genuinely independent of the emitter: it resolves
//      macros/includes through the game's object XMLs, so if it finds every
//      checkpoint at the expected place, MRSIM will too.
//   2. GEOMETRIC — compare what the parser found against what the converter
//      *intended* to emit (summary.emitted) and against the normalised
//      source track, reporting positional/directional deltas per checkpoint.
//
// Returns { ok, errors, warnings, stats, comparison } — errors are lap
// breakers (missing/duplicated/misplaced checkpoints, NaN coordinates,
// buried crossings); warnings are fidelity notes.
// ===========================================================================
import * as THREE from 'three';
import { parseMrsim } from '../mrsim.js';

const SENSOR_MIN = 0.005;      // metres — a sensor side smaller than this is broken
const SENSOR_MAX = 30;         // a sensor side larger than this is a bug
const SENSOR_BIG = 22;         // ...larger than this is suspicious

export function validateMrsim(xml, { summary, normal, humanLines } = {}) {
  const errors = [];
  const warnings = [];
  const comparison = [];
  const stats = {};

  // ---- raw text checks -----------------------------------------------------
  if (/\b(NaN|Infinity|undefined)\b/.test(xml)) {
    errors.push('output contains NaN/Infinity/undefined literals');
  }

  // ---- parse with the independent MRSIM parser -----------------------------
  let track;
  try {
    track = parseMrsim(xml, 'converted.xml');
  } catch (e) {
    return { ok: false, errors: [`output does not parse as an MRSIM track: ${e.message}`],
      warnings, stats, comparison };
  }
  stats.location = track.meta.location;
  stats.isCircuit = track.meta.isCircuit;
  stats.elements = track.elements.length;
  stats.checkpoints = track.seq.length;

  if (!track.meta.location) errors.push('no <Include …/Locations/…> — nothing would render');
  if (!/DroneTrackInstanceGroups\.xml/.test(xml)) {
    errors.push('missing DroneTrackInstanceGroups.xml include (gates would not render)');
  }
  if (!/LaunchStand/.test(xml)) warnings.push('no launch stand — MRSIM has no spawn point');

  for (const issue of track.issues) {
    // unresolved checkpoints / unknown includes reported by the parser
    (/unresolved checkpoint/.test(issue) ? errors : warnings).push(`parser: ${issue}`);
  }

  // ---- checkpoint list ------------------------------------------------------
  const cpMatch = xml.match(/<CheckpointList>([\s\S]*?)<\/CheckpointList>/);
  if (!cpMatch) errors.push('no <CheckpointList> — the track has no lap');
  const listedNames = cpMatch ? [...cpMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
  stats.listed = listedNames.length;

  const dupes = listedNames.filter((n, i) => listedNames.indexOf(n) !== i);
  // repeats are legal in MRSIM (multi-pass elements) but our VD conversion
  // never emits them — a repeat here means colliding generated names
  if (summary && dupes.length) {
    errors.push(`duplicate checkpoint-list names: ${[...new Set(dupes)].join(', ')}`);
  }
  if (track.seq.length !== listedNames.length) {
    errors.push(`${listedNames.length - track.seq.length} checkpoint-list entr(ies) did not ` +
      'resolve to a <Checkpoint> entity');
  }
  // ordering continuity: the parser keeps list order; seqNum must be 1..n
  track.seq.forEach((s, i) => {
    if (s.seqNum !== i + 1) errors.push(`checkpoint order break at #${i + 1} (${s.name})`);
  });

  // ---- numeric sanity over the whole document ------------------------------
  const attrRe = /(\w+)="([^"]*)"/g;
  let m2, badNum = 0;
  while ((m2 = attrRe.exec(xml))) {
    const [, key, val] = m2;
    if (!/^(x|y|z|rx|ry|rz|angle|angleDegrees|radius|height|v)$/.test(key)) continue;
    for (const tok of val.split(',')) {
      if (tok !== '' && !Number.isFinite(parseFloat(tok))) badNum++;
    }
  }
  if (badNum) errors.push(`${badNum} non-finite numeric attribute value(s)`);
  const angRe = /angleDegrees="(-?[\d.]+)"/g;
  while ((m2 = angRe.exec(xml))) {
    const a = parseFloat(m2[1]);
    if (Math.abs(a) > 360) errors.push(`angleDegrees out of range: ${m2[1]}`);
  }

  // ---- sensor volumes -------------------------------------------------------
  // bare sensors are emitted as <Entity name="…_pass"> with a direct Box —
  // find each and check its size (macro gates carry their own lib geometry).
  // The Box must be a non-solid trigger (contactMaterial="-1") or the
  // "sensor" is a collision wall the drone smashes into.
  const sensRe = /<Entity name="([^"]*_pass)">\s*<WorldFromEntityComponent[^>]*\/>\s*<Box x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>\s*(<StaticContact contactMaterial="([^"]*)"\/>)?/g;
  const sensors = new Map();
  while ((m2 = sensRe.exec(xml))) {
    const dims = [m2[2], m2[3], m2[4]].map(parseFloat);
    sensors.set(m2[1], dims);
    if (m2[6] !== '-1') {
      errors.push(`sensor ${m2[1]} is not a trigger volume ` +
        `(contactMaterial=${m2[6] === undefined ? 'missing' : `"${m2[6]}"`})`);
    }
    if (dims.some(d => !Number.isFinite(d) || d < SENSOR_MIN)) {
      errors.push(`sensor ${m2[1]} has a degenerate dimension (${m2[2]},${m2[3]},${m2[4]})`);
    }
    if (dims.some(d => d > SENSOR_MAX)) {
      errors.push(`sensor ${m2[1]} is oversized (${m2[2]},${m2[3]},${m2[4]})`);
    } else if (dims.some(d => d > SENSOR_BIG)) {
      warnings.push(`sensor ${m2[1]} is very large (${m2[2]},${m2[3]},${m2[4]})`);
    }
    const [w, , h] = dims;
    if (Math.max(w, h) < 1.2) warnings.push(`sensor ${m2[1]} may be too small to fly through`);
  }
  stats.bareSensors = sensors.size;
  for (const name of listedNames) {
    if (name.endsWith('_pass') && !sensors.has(name)) {
      errors.push(`listed checkpoint ${name} has no sensor Box`);
    }
  }

  // ---- the in-game naming rule ---------------------------------------------
  // MRSIM resolves a list name to the entity that DIRECTLY carries the
  // <Checkpoint> (its nearest named carrier). mrsim.js is more lenient (any
  // contiguous path run), so specifically guard the one known-fatal case:
  // listing a WRAPPER whose checkpoint actually lives in a named child —
  // the game silently drops such checkpoints (verified in-game).
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const byName = new Map();
    (function walk(el) {
      for (const c of el.children ?? []) {
        if (c.tagName === 'Entity' && c.getAttribute('name')) {
          byName.set(c.getAttribute('name'), c);
        }
        walk(c);
      }
    })(doc.documentElement);
    const directCp = el =>
      [...(el.children ?? [])].some(c => c.tagName === 'Checkpoint');
    const namedDescendantCp = el => {
      for (const c of el.children ?? []) {
        if (c.tagName === 'Entity' && c.getAttribute('name') && directCp(c)) return c;
        const hit = namedDescendantCp(c);
        if (hit) return hit;
      }
      return null;
    };
    for (const name of listedNames) {
      const leaf = name.split('.').pop();
      const el = byName.get(leaf);
      if (!el) continue;                      // macro/include-provided (gates)
      if (directCp(el)) continue;             // correct: the direct carrier
      const inner = namedDescendantCp(el);
      if (inner) {
        errors.push(`checkpoint "${name}" is listed by its wrapper — MRSIM only ` +
          `resolves the entity carrying <Checkpoint> ("${inner.getAttribute('name')}")`);
      }
    }
  } catch { /* DOM walk is best-effort; parseMrsim already vetted the XML */ }

  // ---- scenery burial -------------------------------------------------------
  // blocks half-sunk below the MRSIM floor can be intentional (VD tracks bury
  // block bases in sloped terrain), but a FULLY submerged object is invisible
  // and almost certainly a conversion artefact worth flagging
  let buried = 0;
  for (const el of track.elements) {
    if (el.cps?.length || !el.prims.length) continue;
    const whollyBelow = el.prims.every(p => {
      const e = p.matrix.elements;
      const cy = e[13];                      // three-space centre height
      let up;                                // half-extent projected onto up
      if (p.shape === 'box') {
        up = (Math.abs(e[1]) * p.dims[0] + Math.abs(e[5]) * p.dims[1] +
              Math.abs(e[9]) * p.dims[2]) / 2;
      } else {                               // cylinder: radius r, height h
        up = Math.abs(e[5]) * p.dims[1] / 2 +
             p.dims[0] * (Math.abs(e[1]) + Math.abs(e[9]));
      }
      return cy + up < 0.02;
    });
    if (whollyBelow) buried++;
  }
  if (buried) warnings.push(`${buried} scenery object(s) sit entirely below the MRSIM floor`);

  // flag poles must stand ON the floor — a base below it renders the flag
  // sunk and short (custom flags emit a `…_pole` cylinder from the ground up)
  for (const el of track.elements) {
    if (!/_pole$|^decoFlag|^trkFlag/.test(el.name)) continue;
    for (const p of el.prims) {
      if (p.shape !== 'cyl') continue;
      const base = p.matrix.elements[13] - p.dims[1] / 2;
      if (base < -0.1) {
        errors.push(`flag "${el.name}" pole is sunk ${(-base).toFixed(2)} m into the floor`);
      }
    }
  }

  // ---- crossing geometry ----------------------------------------------------
  track.seq.forEach((s, i) => {
    if (s.pos.y < -0.05) {
      errors.push(`checkpoint #${i + 1} (${s.name}) sits below the MRSIM floor (y=${s.pos.y.toFixed(2)})`);
    } else if (s.pos.y < 0.15) {
      warnings.push(`checkpoint #${i + 1} (${s.name}) is nearly at floor level`);
    }
    if (i > 0) {
      const d = s.pos.distanceTo(track.seq[i - 1].pos);
      if (d < 0.25) warnings.push(`checkpoints #${i} and #${i + 1} are ${d.toFixed(2)} m apart`);
    }
  });

  // ---- start / finish -------------------------------------------------------
  const sfElems = track.elements.filter(e => e.isStart);
  stats.startFinishGates = sfElems.length;
  if (summary) {
    // custom true-size start gates carry no StartFinishGate include (their
    // banner marks them instead), so only library SF gates are counted here
    const wantSF = summary.emitted.some(e => e.sf && !e.sfCustom);
    if (wantSF && sfElems.length !== 1) {
      errors.push(`expected exactly 1 start/finish gate, found ${sfElems.length}`);
    }
    if (wantSF && track.seq.length) {
      const sfEmit = summary.emitted.find(e => e.sf);
      if (summary.cpNames[0] !== sfEmit.name && track.meta.isCircuit) {
        warnings.push(`start/finish gate is list entry ` +
          `#${summary.cpNames.indexOf(sfEmit.name) + 1}, not #1`);
      }
    }
  }

  // ---- compare parsed reality vs converter intent vs source -----------------
  if (summary) {
    if (listedNames.join('\n') !== summary.cpNames.join('\n')) {
      errors.push('checkpoint list does not match the converter\'s intended order');
    }
    summary.emitted.forEach((e, i) => {
      const s = track.seq[i];
      if (!s) return;
      const dPos = s.pos.distanceTo(e.expectPos);
      const dDot = s.dir.dot(e.expectDir);
      const entry = {
        n: i + 1, name: e.name, kind: e.kind, form: e.form, vdBadge: e.vdBadge,
        posDelta: +dPos.toFixed(3), dirDot: +dDot.toFixed(3),
      };
      comparison.push(entry);
      // the parser resolving each sensor exactly where the emitter aimed is
      // the core self-consistency check: tolerance is small on purpose
      if (dPos > 0.25) {
        errors.push(`#${i + 1} ${e.name}: parsed crossing is ${dPos.toFixed(2)} m from intended`);
      }
      if (Math.abs(dDot) < 0.95) {
        errors.push(`#${i + 1} ${e.name}: crossing direction off (dot=${dDot.toFixed(2)})`);
      } else if (dDot < 0) {
        // a reversed sensor still fires on contact, but guidance points backwards
        warnings.push(`#${i + 1} ${e.name}: crossing direction reversed vs intended`);
      }
    });
  }
  if (normal && summary) {
    // fidelity vs the source track (informational; dive gates knowingly move
    // to the fixed 2.7 m cage height, sensor refs may sit off the base point)
    summary.emitted.forEach((e, i) => {
      const c = normal.crossings[i];
      if (!c) return;
      const dxz = Math.hypot(e.expectPos.x - c.pos.x, e.expectPos.z - c.pos.z);
      // a pitched gate legitimately carries its reference off the base point
      // (up to the ref height); sensors may centre on the fitted crossing
      // a pitched gate carries its aperture-centre reference sideways by up
      // to the ref height (pylon gates lie nearly flat)
      const lim = e.kind === 'gate' ? (e.refH ?? 0.9) + 0.2
        : e.kind === 'dive' ? 0.05 : 12;
      if (dxz > lim) {
        errors.push(`#${i + 1} ${e.name}: ${dxz.toFixed(2)} m horizontal drift from the source crossing`);
      }
      const entry = comparison[i];
      if (entry) entry.srcDxz = +dxz.toFixed(3);
      if (e.kind === 'dive' && e.vdHeight != null && Math.abs(e.vdHeight - 2.7) > 1) {
        warnings.push(`#${i + 1} ${e.name}: VD window at ${e.vdHeight.toFixed(1)} m mapped to ` +
          'the fixed 2.7 m dive cage');
      }
    });
    if (normal.crossings.length !== summary.emitted.length) {
      errors.push(`converter emitted ${summary.emitted.length} checkpoints for ` +
        `${normal.crossings.length} source crossings`);
    }
  }

  // ---- racing-line lineup ---------------------------------------------------
  // when a real (WR/ghost) line is supplied, every checkpoint's sensor must be
  // crossed by it — the strongest "will a real lap register" check available
  // without flying the sim
  if (humanLines?.length && summary && normal && track.seq.length) {
    const place = v => {
      const q = v.clone().sub(normal.layout.shift3); q.y -= normal.layout.groundY; return q;
    };
    // densify: 10 Hz ghosts move metres per frame — add segment midpoints
    const pts = [];
    for (const line of humanLines) {
      let prev = null;
      for (const raw of line) {
        const p = place(raw);
        if (prev) pts.push(prev.clone().add(p).multiplyScalar(0.5));
        pts.push(p);
        prev = p;
      }
    }
    let missed = 0;
    track.seq.forEach((s, i) => {
      const e = summary.emitted[i];
      if (!e) return;
      const dims = e.sensor ?? { w: 2.6, h: 2.2, d: 2.4 };   // macro gates: aperture + slack
      // the trigger box's own centre when the emitter supplies one: a tall
      // pane's ring sits at the crossing height, not in the middle of the volume
      const c = dims.centre ?? s.pos;
      const hw = dims.w / 2 + 0.75, hh = dims.h / 2 + 0.75;
      const hd = Math.max(dims.d / 2 + 0.75, 1.6);
      const vertical = Math.abs(s.dir.y) > 0.9;
      const dirH = vertical ? null
        : new THREE.Vector3(s.dir.x, 0, s.dir.z).normalize();
      const hit = pts.some(p => {
        const ox = p.x - c.x, oy = p.y - c.y, oz = p.z - c.z;
        if (Math.abs(oy) > (vertical ? hh : hh)) return false;
        if (vertical) {   // square footprint, any yaw
          return Math.abs(ox) <= hw && Math.abs(oz) <= hw;
        }
        const t = ox * dirH.x + oz * dirH.z;
        const sd = ox * dirH.z - oz * dirH.x;
        return Math.abs(t) <= hd && Math.abs(sd) <= hw;
      });
      if (!hit) {
        missed++;
        errors.push(`#${i + 1} ${s.name}: the supplied racing line never passes through the sensor`);
      }
      const entry = comparison[i];
      if (entry) entry.lineHit = hit;
    });
    stats.lineChecked = track.seq.length;
    stats.lineMissed = missed;
  }

  return { ok: errors.length === 0, errors, warnings, stats, comparison };
}
