// ===========================================================================
// Track format converter: VelociDrone <-> MRSIM.
//
// The two sims describe tracks very differently, so conversion is driven by
// what actually defines the race: the ordered checkpoint crossings (position
// + crossing direction), plus the object type at each one.
//
//   VelociDrone            MRSIM
//   ------------------     ---------------------------------------------
//   gate prefab (285)  <-> Centered5x5Gate (2.1 m MultiGP gate); oversized
//                          gates -> Centered7x6Gate (3 m)
//   window/dive (286)  <-> 7x7DiveGate/7x7ClimbGate (steep) or a tilted gate
//   4 m flag (170)     <-> FlagPassLeft/Right (Flag.xml + one-sided sensor)
//   invisible cp (88)  <-> bare Box sensor entity with a <Checkpoint>
//   (no equivalent)    <-  pipe cubes/poles: passes become checkpoints,
//                          the PVC structure becomes white blocks (2219)
//
// Repeat visits through the same MRSIM element (cubes, double-sided gates)
// become invisible VD checkpoints so the lap sequence is preserved exactly.
//
// Spaces: VD is Unity left-handed Y-up in integer cm with (w,x,y,z)*1000
// quaternions; MRSIM is right-handed Z-up in metres with axis-angle
// transforms. Everything routes through the viewer's three.js space
// (right-handed Y-up, metres): VD (x,y,z) -> three (x, y, -z);
// MRSIM (x,y,z) -> three (x, z, -y).
// ===========================================================================
import * as THREE from 'three';

const CM = 0.01;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// --- VelociDrone raw values <-> three.js space (same maths as app.js) ------
const vdVec = pos => new THREE.Vector3(pos[0] * CM, pos[1] * CM, -pos[2] * CM);
const vdQuat = rot => {
  const [w, x, y, z] = rot;
  return new THREE.Quaternion(-x / 1000, -y / 1000, z / 1000, w / 1000).normalize();
};
const vdPosOut = v => [Math.round(v.x * 100), Math.round(v.y * 100), Math.round(-v.z * 100)];
const vdRotOut = q => [
  Math.round(q.w * 1000), Math.round(-q.x * 1000),
  Math.round(-q.y * 1000), Math.round(q.z * 1000),
];

// three.js Y-up -> MRSIM Z-up
const toMrsim = v => new THREE.Vector3(v.x, -v.z, v.y);

// full orientation change of basis: a three-space rotation becomes the MRSIM
// rotation with the same physical effect (three local x/y/z <-> mrsim x/z/-y)
const Q_ZUP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_ZUP_INV = Q_ZUP.clone().invert();
const mrsimQuat = q => Q_ZUP_INV.clone().multiply(q).multiply(Q_ZUP);

// upright orientation whose local +Z crosses along dir (yaw, then pitch —
// never rolls, which is what a physical gate/checkpoint would do)
function quatFromDir(dir) {
  const yaw = (Math.abs(dir.x) + Math.abs(dir.z)) > 1e-6 ? Math.atan2(dir.x, dir.z) : 0;
  const pitch = -Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

const fmt = n => {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

// VD's stretchable building blocks -> plain MRSIM boxes with the same colour
const VD_BLOCKS = {
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

// ---------------------------------------------------------------------------
// VelociDrone -> MRSIM XML
// ---------------------------------------------------------------------------
// Output matches the format the community track editors (trackforge.racing,
// mrsimeditor.wesleyyjpark.workers.dev) read and write, so a converted track
// loads correctly in MRSIM *and* re-imports cleanly for further editing:
//   * standard gates -> Centered5x5Gate (the 2.1 m MultiGP-style gate, whose
//     CheckpointReference sits at x=1.05 z=.75; the "Centered…" macro shifts
//     -1.05 so the crossing lands on the entity origin). 7x6 gates are 3 m,
//     reserved for oversized gates.
//   * objects are placed with a pure heading `rz="-1" angleDegrees="A"` where
//     A = atan2(dir.x, dir.y) — the convention both editors emit; tilted dive
//     gates keep a full axis-angle so MRSIM renders the pitch.
//   * every object carries an `<!-- EditorMeta: {...} -->` comment so the
//     editors reconstruct it as the exact catalogue object on import.
//
// `classify` is the viewer's prefab classifier: gate id -> kind
// ('gate' | 'dive' | 'flag' | 'checkpoint' | 'tool');
// `prefabName` maps a prefab id to its catalog name (for barrier mapping).
export function vdToMrsim(data, classify, prefabName = () => '', opts = {}) {
  const location = opts.location || 'EmptyGrassWorld';
  const seq = [...data.gates].sort((a, b) => a.gate - b.gate);
  if (!seq.length) throw new Error('track has no gates to convert');
  const kinds = seq.map(g => classify(g));
  // raise any track that dips below VD's ground origin so nothing ends up
  // buried under MRSIM's z=0 floor; genuine elevation above ground is kept
  // (editor helpers like control curves must not skew the offset)
  const raceable = seq.filter((g, i) => kinds[i] !== 'tool');
  if (!raceable.length) throw new Error('no convertible gates in this track');
  const groundY = Math.min(0, ...raceable.map(g => g.trans.pos[1] * CM));
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

  // axis-angle Transform attributes for an MRSIM-space quaternion
  function attrsFromQuat(q) {
    if (q.w < 0) { q = q.clone(); q.x *= -1; q.y *= -1; q.z *= -1; q.w *= -1; }
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
    if (angle < 1e-4) return '';
    const s = Math.sqrt(Math.max(1e-12, 1 - q.w * q.w));
    return ` rx="${fmt(q.x / s)}" ry="${fmt(q.y / s)}" rz="${fmt(q.z / s)}"` +
      ` angleDegrees="${fmt(angle * 180 / Math.PI)}"`;
  }

  // MRSIM rotation attributes for a mrsim-space direction the local +Y (the
  // crossing axis) should point along. Pure heading uses the editors' canonical
  // `rz="-1" angleDegrees` form; a pitched crossing (dive) keeps yaw then pitch
  // about the yawed X as a full axis-angle — never rolls, like a real gate.
  function rotAttrs(dirM, yawOnly = false) {
    const d = dirM.clone().normalize();
    if (yawOnly || Math.abs(d.z) < 1e-4) {
      const yaw = Math.atan2(d.x, d.y);   // +Y about -Z by yaw -> (sin,cos)=(x,y)
      if (Math.abs(yaw) < 1e-4) return '';
      return ` rz="-1" angleDegrees="${fmt(yaw * 180 / Math.PI)}"`;
    }
    const yaw = Math.atan2(-d.x, d.y);
    const pitch = Math.asin(THREE.MathUtils.clamp(d.z, -1, 1));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
    return attrsFromQuat(q);
  }

  // round-trip breadcrumb for the community editors: the object's catalogue id
  const meta = (typeId, name) =>
    `    <!-- EditorMeta: {"typeId":"${typeId}","entityName":"${name}"} -->`;

  // Where do the supplied human racing lines actually cross this element?
  // Returns, in the placed sensor's own frame, the mean crossing (side = along
  // the sensor's local +X, up = local +Z) and the half-extents that cover every
  // sampled crossing, so the checkpoint sits on the line and is big enough to
  // catch the whole field. `dir` is the crossing direction in three-space.
  const humanLines = opts.humanLines || [];
  // native (unscaled) width in metres of a VD gate prefab, so we can pick the
  // closest fixed MRSIM gate; VD race gates (285/286/742) are ~3.2 m → 7x6
  const gateWidthFor = opts.gateWidthFor || (() => 3.2);
  function fitCrossings(porig, dir, horizontal) {
    if (!humanLines.length) return null;
    const A = Math.atan2(dir.x, -dir.z);                     // rz="-1" heading
    const side = new THREE.Vector3(Math.cos(A), 0, Math.sin(A));  // sensor local +X in three
    const ss = [], us = [];
    const dist = v => horizontal ? Math.hypot(v.x - porig.x, v.z - porig.z) : v.distanceTo(porig);
    for (const line of humanLines) {
      for (let i = 1; i < line.length - 1; i++) {
        const d = dist(line[i]);
        if (d < 5 && d <= dist(line[i - 1]) && d < dist(line[i + 1])) {   // one pass = one local min
          const off = line[i].clone().sub(porig);
          ss.push(off.dot(side)); us.push(off.y);
        }
      }
    }
    if (ss.length < 3) return null;
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    return { sC: mean(ss), uC: mean(us), sMin: Math.min(...ss), sMax: Math.max(...ss),
      uMin: Math.min(...us), uMax: Math.max(...us), n: ss.length };
  }

  // Box (centre + size) + checkpoint-reference offset for a sensor, in the
  // sensor's local frame (X = side, Z = up). Starts from a generous default
  // range that always catches the field, then expands to cover every supplied
  // human crossing; the reference is pinned to the human centroid (so the lap
  // line runs through it) or the default centre when no lines are given.
  function sensorBox(fit, def) {
    let { s0, s1, u0, u1, refU } = def, refS = 0;
    if (fit) {
      s0 = Math.min(s0, fit.sMin); s1 = Math.max(s1, fit.sMax);
      u0 = Math.min(u0, fit.uMin); u1 = Math.max(u1, fit.uMax);
      refS = fit.sC; refU = fit.uC;
    }
    const cx = (s0 + s1) / 2, cz = (u0 + u1) / 2;
    return { cx, cz, bw: (s1 - s0) + 1.5, bh: (u1 - u0) + 1.5, refX: refS - cx, refZ: refU - cz };
  }

  const parts = [];
  const cpNames = [];
  const warnings = [];
  const usedMacros = new Set();
  let nGate = 0, nFlag = 0, nCheck = 0, nDive = 0, scaled = 0;
  let usedHurdle = false, usedLeg = false;
  let first = null;   // {pos three, dir three} of the first crossing (start area)

  const raceKinds = kinds.filter(k => k !== 'tool');

  raceable.forEach((g, ri) => {
    const kind = raceKinds[ri];
    const p = place(vdVec(g.trans.pos));
    const q = vdQuat(g.trans.rot);
    const dir = Z_AXIS.clone().applyQuaternion(q);
    const sx = (g.trans.scale?.[0] ?? 100) / 100;
    const sy = (g.trans.scale?.[1] ?? 100) / 100;
    first ??= { pos: p.clone(), dir: dir.clone() };
    const pm = toMrsim(p);
    const dm = toMrsim(dir);

    if (kind === 'flag') {
      const nm = `trkFlag${++nFlag}`;
      // VD 4 m flags are lenient near-pole passes. MRSIM's own FlagPass object
      // references a point 11 m to one side, which would bow the racing line out
      // at every flag, so keep the game's Flag.xml visual on its pole but trigger
      // on a plane that fires from either side. When human lines are supplied the
      // plane is centred where the field actually crosses (they pass ~2.5 m up,
      // not at the pole base) and sized to catch the whole field; otherwise a
      // generous default. EditorMeta lets the wesley editor rebuild it as a flag
      // (trackforge, which keys off a direct-child FlagPass include, keeps only
      // the checkpoint).
      const fit = fitCrossings(vdVec(g.trans.pos), dir, true);
      // generous default: ±3 m either side of the pole, 0.4–5.4 m up (the band
      // the field actually flies through — see the top-25 crossing analysis)
      const b = sensorBox(fit, { s0: -3, s1: 3, u0: 0.4, u1: 5.4, refU: 2.6 });
      // Face the cloth the way the VD flag faces it. The VD flag's cloth hangs
      // on its local −X; the game's Flag.xml cloth points the opposite way, so
      // use Flag180.xml (Flag.xml rotated 180°) when the placed gate's +X lines
      // up against the VD flag's +X (verified in-game against the source track).
      const A = Math.atan2(dm.x, dm.y);
      const entX = new THREE.Vector3(Math.cos(A), 0, Math.sin(A));   // placed flag +X in three
      const vx = new THREE.Vector3(1, 0, 0).applyQuaternion(q);      // VD flag +X in three
      const flagFile = entX.dot(vx) > 0 ? 'Flag.xml' : 'Flag180.xml';
      parts.push(meta('flag', nm),
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"${rotAttrs(dm, true)}>
      <Entity name="${nm}">
        <Include file="/Data/Simulations/Multirotor/${flagFile}"/>
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent x="${fmt(b.cx)}" z="${fmt(b.cz)}"/>
          <Box x="${fmt(b.bw)}" y=".01" z="${fmt(b.bh)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent x="${fmt(b.refX)}" z="${fmt(b.refZ)}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      // the game resolves a checkpoint by the name of the entity that directly
      // carries it — the _pass child, NOT the flag wrapper (verified against the
      // community "…-sloogus.xml"); referencing the wrapper drops the checkpoint
      cpNames.push(`${nm}_pass`);
    } else if (kind === 'checkpoint') {
      const nm = `trkCheck${++nCheck}`;
      // VD invisible checkpoints: ring centre sits GATE_SIZE*scale/2 up the
      // local Y axis from the stored base position (giant helper planes stay
      // near the ground, matching the viewer's racing line). A named wrapper
      // whose inner entity carries the sensor + <Checkpoint>, like the game's
      // own passage objects.
      const fit = fitCrossings(vdVec(g.trans.pos), dir, false);
      const geo = Math.min(20, Math.max(1.2, 2 * sy));   // scale-based default size
      if (fit) {
        // human lines available: sit on the field's crossings, sized to catch
        // them (kept upright so side/up match the box). Box centred at the base
        // + offset; reference pinned to the human centroid.
        const cu = sy <= 3 ? sy : 1;
        const b = sensorBox(fit, { s0: -geo / 2, s1: geo / 2, u0: Math.max(0, cu - geo / 2), u1: cu + geo / 2, refU: cu });
        parts.push(
          `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"${rotAttrs(dm, true)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent x="${fmt(b.cx)}" z="${fmt(b.cz)}"/>
          <Box x="${fmt(b.bw)}" y=".01" z="${fmt(b.bh)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent x="${fmt(b.refX)}" z="${fmt(b.refZ)}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      } else {
        // no human data: ring centre sits scale·GATE_SIZE/2 up the local Y from
        // the base (helper planes stay near the ground), sensor square to scale.
        const c = sy <= 3
          ? p.clone().add(new THREE.Vector3(0, sy, 0).applyQuaternion(q))
          : p.clone().add(new THREE.Vector3(0, 1, 0));
        const cm2 = toMrsim(c);
        parts.push(
          `    <Transform x="${fmt(cm2.x)}" y="${fmt(cm2.y)}" z="${fmt(cm2.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent/>
          <Box x="${fmt(geo)}" y=".01" z="${fmt(geo)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      }
      // reference the checkpoint-bearing child, not the wrapper (see flags)
      cpNames.push(`${nm}_pass`);
    } else if (kind === 'dive' && Math.abs(dir.y) > 0.5) {
      // A steep VD window -> the game's own 7x7 dive/climb gate, exactly how
      // MRSIM's official tracks build one: a horizontal square cage on four
      // corner poles you cross vertically. dir.y<0 dives down (7x7DiveGate),
      // dir.y>0 climbs up (7x7ClimbGate) — the only difference is the include's
      // CheckpointReference normal. Placed flat with just a yaw; the include
      // self-lifts the window to z=2.7 and supplies its own legs (4 sides, 4 posts).
      const nm = `dive${++nDive}`;
      const climb = dir.y > 0;
      const flat = new THREE.Vector3(dm.x, dm.y, 0);   // horizontal approach heading
      parts.push(meta(climb ? 'climb-gate-7x7' : 'dive-gate-7x7', nm),
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="0"${rotAttrs(flat, true)}>
      <Entity name="${nm}">
        <Include file="/Data/Simulations/Multirotor/7x7${climb ? 'Climb' : 'Dive'}Gate.xml"/>
      </Entity>
    </Transform>`);
      cpNames.push(nm);   // wrapper name — the checkpoint lives inside the include
    } else {   // gate, and shallow windows -> a (possibly pitched) gate
      // MRSIM gates come in two fixed sizes: pick whichever matches the real VD
      // gate width — the 3 m 7x6 gate (VD's 3.2 m race gates) or the 2.1 m 5x5.
      const nm = `trkGate${++nGate}`;
      const isSF = !!g.start;                    // exactly ONE StartFinish gate
      const gw = gateWidthFor(g.prefab) * sx;    // real VD gate width in metres
      const big = gw >= 2.55;                     // 7x6 (3 m) vs 5x5 (2.1 m)
      const half = big ? 1.5 : 1.05;             // gate half-width (post spacing)
      const macro = big
        ? (isSF ? 'Centered7x6StartFinishGate' : 'Centered7x6Gate')
        : (isSF ? 'Centered5x5StartFinishGate' : 'Centered5x5Gate');
      const typeId = big
        ? (isSF ? 'start-finish-7x6' : 'gate-7x6')
        : (isSF ? 'start-finish-5x5' : 'gate-5x5');
      usedMacros.add(macro);
      parts.push(meta(typeId, nm),
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Instance macro="${macro}"/>
      </Entity>
    </Transform>`);
      cpNames.push(nm);
      // an elevated gate (raised / tower gate) stands on legs in VD — add a
      // vertical support post under each side down to the ground so it isn't floating
      if (p.y > 0.6) {
        usedLeg = true;
        const A = Math.atan2(dm.x, dm.y);
        const wax = new THREE.Vector3(Math.cos(A), 0, Math.sin(A));   // gate width axis
        for (const s of [-1, 1]) {
          const foot = toMrsim(p.clone().addScaledVector(wax, s * half));
          parts.push(
            `    <Transform x="${fmt(foot.x)}" y="${fmt(foot.y)}" z="${fmt(p.y / 2)}">
      <Entity name="${nm}_leg${s > 0 ? 2 : 1}">
        <Cylinder radius=".04" height="${fmt(p.y)}"/>
        <StaticContact contactMaterial="TrackPart"/>
        <MeshRendererComponent material="GateLegMaterial" subdivisions="8"/>
      </Entity>
    </Transform>`);
        }
      }
    }
  });
  if (!cpNames.length) throw new Error('no convertible gates in this track');
  if (scaled) warnings.push(`${scaled} off-size gate(s) fit to the nearest fixed MRSIM gate`);

  // ---- barriers: blocks become boxes, hurdles panels, flags flags ----
  // (in VD the dive-gate towers and hurdles are scenery; the lap itself only
  // references invisible checkpoints placed at them)
  let nBlock = 0, nHurdle = 0, nDeco = 0;
  const skipped = new Map();
  const usedBlocks = new Set();
  (data.barriers || []).forEach(b => {
    const name = prefabName(b.prefab) || '';
    const p = place(vdVec(b.trans.pos));
    const pm = toMrsim(p);
    const q = vdQuat(b.trans.rot);
    const at = `x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"`;
    const [sx, sy, sz] = (b.trans.scale || [100, 100, 100]).map(s => s / 100);
    if (VD_BLOCKS[b.prefab]) {
      // unit blocks: base origin, scale % per local axis (three x/y/z ->
      // mrsim x/z/y), full orientation preserved
      const nm = `blk${++nBlock}`;
      usedBlocks.add(b.prefab);
      parts.push(
        `    <Transform ${at}${attrsFromQuat(mrsimQuat(q))}>
      <Entity name="${nm}">
        <WorldFromEntityComponent z="${fmt(sy / 2)}"/>
        <Box x="${fmt(sx)}" y="${fmt(sz)}" z="${fmt(sy)}"/>
        <StaticContact contactMaterial="TrackPart"/>
        <MeshRendererComponent material="Block${VD_BLOCKS[b.prefab][0]}Material" subdivisions="1"/>
      </Entity>
    </Transform>`);
    } else if (/hurdle/i.test(name)) {
      // MGP hurdles are a single 3 x 1.5 m fabric panel: emit it at the
      // exact scaled size instead of snapping to an MRSIM hurdle
      const nm = `hurdle${++nHurdle}`;
      usedHurdle = true;
      const dir = Z_AXIS.clone().applyQuaternion(q);
      const w = 3.0 * sx, h = 1.5 * sy;
      parts.push(
        `    <Transform ${at}${rotAttrs(toMrsim(dir), true)}>
      <Entity name="${nm}">
        <WorldFromEntityComponent z="${fmt(h / 2)}"/>
        <Box x="${fmt(w)}" y=".02" z="${fmt(h)}"/>
        <StaticContact contactMaterial="TrackPart"/>
        <MeshRendererComponent material="HurdlePanelMaterial" subdivisions="1"/>
      </Entity>
    </Transform>`);
    } else if (/flag/i.test(name)) {
      // scenery flags (TBS/deco) -> the game's Flag.xml on its pole
      const nm = `decoFlag${++nDeco}`;
      const dir = Z_AXIS.clone().applyQuaternion(q);
      parts.push(
        `    <Transform ${at}${rotAttrs(toMrsim(dir), true)}>
      <Entity name="${nm}">
        <Include file="/Data/Simulations/Multirotor/Flag.xml"/>
      </Entity>
    </Transform>`);
    } else {
      skipped.set(name || `prefab ${b.prefab}`, (skipped.get(name || `prefab ${b.prefab}`) || 0) + 1);
    }
  });
  if (skipped.size) {
    warnings.push('skipped (no MRSIM equivalent): ' +
      [...skipped.entries()].map(([n, c]) => `${c}× ${n}`).join(', '));
  }

  // launch area 6 m behind the first crossing (fall back to +Z when the
  // first crossing is vertical — a dive entry has no horizontal direction)
  const fdir = first.dir.clone().setY(0);
  if (fdir.lengthSq() < 1e-6) fdir.set(0, 0, 1);
  fdir.normalize();
  const back = fdir.clone().multiplyScalar(-6).add(first.pos);
  const bm = toMrsim(back);
  const fm = toMrsim(fdir);
  const spawnYaw = Math.atan2(fm.x, fm.y) * 180 / Math.PI;   // rz="-1" heading

  // the "Centered…" gate macros (only the ones the track actually uses): the
  // shift is -width/2 so the gate's CheckpointReference lands on the entity
  // origin — 5x5 gate is 2.1 m (shift -1.05), 7x6 gate is 3 m (shift -1.5).
  const MACRO_DEFS = {
    Centered5x5Gate: ['-1.05', '5x5Gate.xml'],
    Centered5x5StartFinishGate: ['-1.05', '5x5StartFinishGate.xml'],
    Centered7x6Gate: ['-1.5', '7x6Gate.xml'],
    Centered7x6StartFinishGate: ['-1.5', '7x6StartFinishGate.xml'],
  };
  const macroXml = [...usedMacros].map(m => {
    const [shift, file] = MACRO_DEFS[m];
    return `  <Macro name="${m}">
    <Transform x="${shift}">
      <Include file="/Data/Simulations/Multirotor/${file}"/>
    </Transform>
  </Macro>`;
  }).join('\n');

  // custom PBR materials — only the ones the emitted geometry references
  const pbr = (name, [r, g, b], rough) =>
    `  <Material name="${name}">
    {
        definition: "PBR",
        uniforms: { baseColor: [${r}, ${g}, ${b}], roughness: ${rough}, metallic: 0 }
    }
  </Material>`;
  const materialsXml = [
    ...[...usedBlocks].map(id => pbr(`Block${VD_BLOCKS[id][0]}Material`, VD_BLOCKS[id][1], '.8')),
    ...(usedHurdle ? [pbr('HurdlePanelMaterial', [.6, .6, .6], '.4')] : []),
    ...(usedLeg ? [pbr('GateLegMaterial', [.85, .85, .85], '.5')] : []),
  ].join('\n');

  const xml = `<Simulation>
  <!-- Converted from VelociDrone by track-viewer -->
  <Include file="/Data/Simulations/Multirotor/Locations/${location}.xml"/>
  <Include file="/Data/Simulations/Multirotor/DroneTrackInstanceGroups.xml"/>

${macroXml}
${materialsXml ? '\n' + materialsXml + '\n' : ''}
  <Entity name="Track">
    <Transform x="${fmt(bm.x)}" y="${fmt(bm.y)}" rz="-1" angleDegrees="${fmt(spawnYaw)}">
      <Transform>
        <Include file="/Data/Simulations/Multirotor/7x7Mat.xml"/>
      </Transform>
      <Transform z=".025" rz="-1" angleDegrees="90">
        <Include file="/Data/Simulations/Multirotor/LaunchStands/MetalLaunchStand.xml"/>
      </Transform>
    </Transform>

${parts.join('\n')}
    <CheckpointList>
      {
          isCircuit: ${isCircuit},
          checkpoints:
          [
${cpNames.map(n => `              "${n}"`).join(',\n')}
          ]
      }
    </CheckpointList>
  </Entity>
</Simulation>
`;
  return { xml, warnings };
}

// ---------------------------------------------------------------------------
// MRSIM (parsed by mrsim.js) -> VelociDrone track JSON
// ---------------------------------------------------------------------------
const VD = { GATE: 285, WINDOW: 286, FLAG: 170, CHECKPOINT: 88, BLOCK_WHITE: 2219 };

export function mrsimToVd(data, opts = {}) {
  if (!data.seq?.length) throw new Error('track has no checkpoint sequence');
  const gates = [];
  const barriers = [];
  const warnings = [];
  const seen = new Set();        // element indices already given a visible object
  const placedGates = [];        // visible gate positions (avoid z-fighting twins)

  data.seq.forEach((s, i) => {
    const el = data.elements[s.elemIndex];
    const kind = el?.kind ?? 'pass';
    const firstVisit = el ? !seen.has(s.elemIndex) : false;
    if (el) seen.add(s.elemIndex);
    const dir = s.dir.clone().normalize();

    let prefab = VD.CHECKPOINT;
    let q = quatFromDir(dir);
    // invisible checkpoints: ring centre sits 1 m up the local Y from the base
    let pos = s.pos.clone().sub(new THREE.Vector3(0, 1, 0).applyQuaternion(q));

    if ((kind === 'gate' || kind === 'dive') && firstVisit) {
      const twin = placedGates.some(p => p.distanceTo(s.pos) < 0.2);
      if (!twin) {
        prefab = Math.abs(dir.y) > 0.5 || kind === 'dive' ? VD.WINDOW : VD.GATE;
        // real model aperture centres (from the prefab bounds): the MGP gate
        // crossing sits 1.28 m above its base, the window 1.6 m
        const cy = prefab === VD.WINDOW ? 1.6 : 1.28;
        pos = s.pos.clone().sub(new THREE.Vector3(0, cy, 0).applyQuaternion(q));
        placedGates.push(s.pos.clone());
        if (pos.y > -0.35 && pos.y < 0.35) pos.y = 0;   // snap near-ground gates
      }
    } else if ((kind === 'flag' || kind === 'pole') && firstVisit) {
      // a padded pole with a side pass reads as a VD flag at the same spot
      prefab = VD.FLAG;
      q = quatFromDir(new THREE.Vector3(dir.x, 0, dir.z).normalize());
      pos = new THREE.Vector3(s.pos.x, Math.max(0, s.pos.y - 1.5), s.pos.z);
    }
    gates.push({
      prefab,
      trans: { pos: vdPosOut(pos), rot: vdRotOut(q), scale: [100, 100, 100] },
      gate: i,
      start: i === 0,
      finish: i === 0,
    });
  });

  // pipe-cube structure -> thin white blocks along each PVC pole
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  data.elements.forEach(el => {
    if (el.kind !== 'cube') return;
    el.prims.forEach(p => {
      if (p.shape !== 'cyl' || (p.hint !== 'pad' && p.hint !== 'pvc')) return;
      p.matrix.decompose(P, Q, S);
      const [r, h] = p.dims;
      const d = Math.max(0.04, 2 * r);
      // block origins are at the base: drop half the (tiny) local-Y size
      const base = P.clone().sub(new THREE.Vector3(0, d / 2, 0).applyQuaternion(Q));
      barriers.push({
        prefab: VD.BLOCK_WHITE,
        trans: {
          pos: vdPosOut(base), rot: vdRotOut(Q),
          scale: [Math.round(d * 100), Math.round(d * 100), Math.round(h * 100)],
        },
      });
    });
  });
  const deco = data.elements.filter(e => e.kind === 'deco').length;
  if (deco) warnings.push(`${deco} scenery object(s) (mats, stands, canopies) skipped`);

  return {
    sceneId: opts.sceneId || VD_SCENES[0][0],
    name: data.meta.name || 'MRSIM track',
    json: { gates, barriers },
    warnings,
  };
}
