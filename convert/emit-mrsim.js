// ===========================================================================
// Normalised track model -> MRSIM XML emitter.
//
// Output matches the format the community track editors (trackforge.racing,
// mrsimeditor.wesleyyjpark.workers.dev) read and write, so a converted track
// loads correctly in MRSIM *and* re-imports cleanly for further editing:
//   * standard gates -> Centered5x5Gate / Centered7x6Gate macros whose shift
//     puts the gate's CheckpointReference on the entity origin.
//   * objects are placed with a pure heading `rz="-1" angleDegrees="A"` where
//     A = atan2(dir.x, dir.y) — the convention both editors emit; tilted dive
//     gates keep a full axis-angle so MRSIM renders the pitch.
//   * every object carries an `<!-- EditorMeta: {...} -->` comment so the
//     editors reconstruct it as the exact catalogue object on import.
//
// The game resolves a CheckpointList name to the entity that DIRECTLY carries
// the <Checkpoint>: gates are referenced by their wrapper (the checkpoint
// lives inside the macro's include), flags/bare sensors by the `…_pass` child
// that holds the sensor (verified in-game — the wrapper name silently drops
// such a checkpoint).
//
// Sensor volumes for VD's invisible checkpoints are rotation-robust: the
// stored +Z of turn poles / flat squares is near-vertical, so a plane given
// that heading could be flown along edge-on and missed. Poles become a
// column volume, flat squares a thick horizontal slab; both are yawed to the
// local path heading only so the guidance arrow points along the lap.
//
// When a human racing line is supplied (opts.humanLines) the CheckpointReference
// (the visible ring the pilot flies to) is placed on the CLOSEST POINT of that
// line — not at the wide-radius centroid of nearby samples, which cuts corners
// and can sit metres off the mark or, on a dive, several metres low. Windows
// then fly as thin oriented planes on the line; poles keep the robust column
// but re-seat the ring on it; dives/climbs keep the flat plate at the true
// crossing height. (Matches how the perfected 2026 AU NATS edit was hand-tuned.)
// ===========================================================================
import * as THREE from 'three';
import { Z_AXIS, toMrsim, fromMrsim, mrsimQuat, fmt, attrsFromQuat, rotAttrs, rotQuatForDir } from './space.js';
import { VD_BLOCKS, MACRO_DEFS, pickGate } from './mapping.js';
import { normalizeVdTrack } from './vd-normalize.js';

// VD scenes that carry no props of their own (no scenery warning needed)
const EMPTY_VD_SCENES = new Set([16, 17, 42, 43]);

// native MGPHurdle panel, VD local axes [width X, height Y] — only used when
// the caller supplies no prefab dimensions
const HURDLE_SIZE = [3.04, 1.52];
// native DefaultMGP4MFlag mesh bounds on X: the pole sits at ~0 and the cloth
// runs to -1.23. Same fallback shape as boundsFor's [x0,…,x1,…] slice.
const FLAG_X = [-1.23, 0.01];

// Which side of its pole a flag's cloth hangs on, and how wide it is, from the
// prefab's mesh bounds. VD's flag families are NOT consistent: the feather
// flags (DefaultMGP4MFlag, the WDC/TBS/Velo family) hang their cloth on local
// -X, but DefaultFlagGateMultiGP and DefaultFlagGate hang it on +X — and the
// trigger wall is always on the OTHER side, so guessing costs real passes.
// A few prefabs give no answer at all (PolyFlagLine is a symmetric banner run;
// the DefaultFlag family's cloth lies along Z), and those report side 0 so the
// caller can fall back to a plane that catches both sides.
function flagCloth(bounds, sx) {
  const [x0, x1] = bounds ? [bounds[0], bounds[3]] : FLAG_X;
  const w = x1 - x0, mid = (x0 + x1) / 2;
  const side = w > 0.2 && Math.abs(mid) > 0.15 * w ? Math.sign(mid) : 0;
  // the cloth reaches from the pole to the far edge on its own side; clamp so
  // a banner-run prefab cannot hang a 13 m sheet off a 3 m pole
  const reach = Math.max(Math.abs(x0), Math.abs(x1)) * sx - 0.06;
  return { side, width: Math.min(1.6, Math.max(0.4, reach)) };
}
// Every checkpoint sensor is a WINDOW PANE: wide and tall enough to catch the
// field, but only this thick through the crossing — the same depth the
// converter's gate triggers have always used, and thin enough that the volume
// reads as a plane in an editor instead of a solid block of air.
const PANE_D = 0.3;

export function emitMrsim(normal, opts = {}) {
  const location = opts.location || 'EmptyGrassWorld';
  const humanLines = opts.humanLines || [];
  const { crossings, scenery, layout, isCircuit } = normal;
  const warnings = [...normal.warnings];

  // Where do the supplied human racing lines actually cross this element?
  // Returns, in the placed sensor's own frame, the mean crossing (side = along
  // the sensor's local +X, up = local +Z) and the half-extents that cover every
  // sampled crossing, so the checkpoint sits on the line and is big enough to
  // catch the whole field. `dir` is the crossing direction in three-space;
  // positions are the RAW (unshifted) viewer-space ones the ghosts fly in.
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
          // horizontal-distance fits (flags): a ghost overflying the course
          // high above the pole is not a flag pass — don't let it stretch the
          // sensor or drag the reference skyward
          if (horizontal && (off.y > 8 || off.y < -2)) continue;
          ss.push(off.dot(side)); us.push(off.y);
        }
      }
    }
    if (ss.length < 3) return null;
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    return { sC: mean(ss), uC: mean(us), sMin: Math.min(...ss), sMax: Math.max(...ss),
      uMin: Math.min(...us), uMax: Math.max(...us), n: ss.length };
  }

  // Where does the human line actually pass a point? 3D closest-approach
  // samples within `radius`, as a raw-space centroid + spread — used to
  // centre plate and column sensors on the field's real line.
  const placeFit = v => {
    const q = v.clone().sub(layout.shift3); q.y -= layout.groundY; return q;
  };
  function fitPoint(porig, radius = 6) {
    if (!humanLines.length) return null;
    const pts = [];
    for (const line of humanLines) {
      for (let i = 1; i < line.length - 1; i++) {
        const d = line[i].distanceTo(porig);
        if (d < radius && d <= line[i - 1].distanceTo(porig) &&
            d < line[i + 1].distanceTo(porig)) pts.push(line[i]);
      }
    }
    if (pts.length < 2) return null;
    const c = pts.reduce((a, p) => a.clone().add(p)).multiplyScalar(1 / pts.length);
    let rH = 0, rV = 0;
    for (const p of pts) {
      rH = Math.max(rH, Math.hypot(p.x - c.x, p.z - c.z));
      rV = Math.max(rV, Math.abs(p.y - c.y));
    }
    return { c: placeFit(c), rH, rV, n: pts.length };
  }

  // Where does the human line CROSS a marker, and which way is it flying there?
  // Unlike fitPoint (a wide centroid that cuts corners), this returns the single
  // closest point on the ghost polyline to the VD marker plus the smoothed flight
  // tangent — so an invisible checkpoint's ring can sit exactly on the line and
  // face along the lap, which is how the field actually flies the mark. Points
  // are returned in placed (recentred) space; `near` are nearby samples for
  // sizing the sensor to catch the whole field. Null when no lines are supplied.
  function lineHit(porig, radius = 8) {
    if (!humanLines.length) return null;
    let best = Infinity, bp = null, bi = -1, bl = null;
    for (const line of humanLines) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1], ab = b.clone().sub(a);
        const len2 = ab.lengthSq();
        if (len2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, a.clone().negate().add(porig).dot(ab) / len2));
        const proj = a.clone().addScaledVector(ab, t);
        const d = proj.distanceTo(porig);
        if (d < best) { best = d; bp = proj; bi = i; bl = line; }
      }
    }
    if (!bp || best > radius) return null;
    // tangent smoothed over a short window around the hit (raw ghosts are ~10 Hz)
    const w = 4;
    const a = bl[Math.max(0, bi - w)], b = bl[Math.min(bl.length - 1, bi + 1 + w)];
    const tangent = b.clone().sub(a);
    if (tangent.lengthSq() < 1e-9) return null;
    const near = [];
    for (const line of humanLines)
      for (const pt of line) if (pt.distanceTo(bp) < 5) near.push(placeFit(pt));
    return { point: placeFit(bp), tangent: tangent.normalize(), d: best, near };
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

  // A flag's one-sided trigger plane, in the placed flag's own frame.
  // `trigSign` is which way along local +X the VD trigger wall runs (the side
  // away from the cloth). Worked out in distance-from-the-pole coordinates so
  // the near edge stays EXACTLY on the pole — slack is only ever added at the
  // far end, never back across the fabric. Returns the box centre/size and the
  // absolute ring offset (a CheckpointReference resolves against its parent).
  function flagSensor(fit, trigSign, sided, reach = 11) {
    if (!sided) {
      // the prefab's mesh gives no pole side (a symmetric banner run, a cloth
      // that lies along the other axis): guessing would drop every pass on the
      // wrong guess, so keep a plane that reaches both ways
      const s = sensorBox(fit, { s0: -8, s1: 8, u0: 0.4, u1: 6.3, refU: 2.6 });
      return { cx: s.cx, cz: s.cz, bw: s.bw, bh: s.bh,
        refS: s.cx + s.refX, refU: s.cz + s.refZ };
    }
    let near = 0, far = reach, u0 = 0.4, u1 = 6.3, refT = 0, refU = 2.6;
    if (fit) {
      const a = trigSign * fit.sMin, b = trigSign * fit.sMax;
      near = Math.min(near, a, b); far = Math.max(far, a, b);
      u0 = Math.min(u0, fit.uMin); u1 = Math.max(u1, fit.uMax);
      refT = trigSign * fit.sC; refU = fit.uC;
    }
    // A drone's width of lip past the pole, no more. Real racing lines shave
    // the pole so close that a hard cut exactly on it drops passes a few
    // centimetres the wrong way (the 2024 AU NATS WR clips five of six flags
    // within 0.75 m of the pole, which is why a ghost widens `near` above) —
    // but the sensor must read as "out of the pole side", not as a wall
    // hanging through the fabric.
    near -= 0.4; far += 0.75;
    return {
      cx: trigSign * (near + far) / 2, cz: (u0 + u1) / 2,
      bw: far - near, bh: (u1 - u0) + 1.5,
      refS: trigSign * Math.min(Math.max(refT, near), far), refU,
    };
  }

  // round-trip breadcrumb for the community editors: the object's catalogue id
  const meta = (typeId, name) =>
    `    <!-- EditorMeta: {"typeId":"${typeId}","entityName":"${name}"} -->`;

  const parts = [];
  const cpNames = [];
  const emitted = [];    // per-checkpoint expectations, for validate.js
  const apertures = [];  // gate openings, to evict VD dressing that blocks them
  const usedMacros = new Set();
  let nGate = 0, nFlag = 0, nCheck = 0, nDive = 0;
  let offSize = 0, offSizeExample = '', sunkGates = 0;
  let usedHurdle = false, usedLeg = false, usedNet = false, usedRiser = false;
  let usedGateFrame = false, usedStartBanner = false, usedFlagParts = false;
  let first = null;   // {pos three, dir three} of the first crossing (start area)

  // An upright window pane across the lap — what an invisible marker you fly
  // PAST becomes: a turn pole, an offset flag, any checkpoint whose stored
  // orientation is near-vertical noise. Squared to the lap path heading and
  // made wide/tall enough that a line round the mark cannot miss it, but only
  // PANE_D thick. (These used to be 16 x 16 m columns and metres-thick slabs:
  // they fired reliably, but a checkpoint is a window you fly through, and in
  // an editor a block of solid-looking air is impossible to work with.)
  // `head` is the three-space heading the pane is crossed along; `refY` is the
  // ring height (a CheckpointReference resolves against the wrapper, which
  // sits on the floor, so it is simply the world height).
  function uprightPane(nm, x, z, W, u0, u1, refY, head, badge) {
    const cm = toMrsim(new THREE.Vector3(x, 0, z));
    const H = u1 - u0, cU = (u0 + u1) / 2;
    parts.push(
      `    <Transform x="${fmt(cm.x)}" y="${fmt(cm.y)}" z="0"${rotAttrs(toMrsim(head), true)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent z="${fmt(cU)}"/>
          <Box x="${fmt(W)}" y="${fmt(PANE_D)}" z="${fmt(H)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent z="${fmt(refY)}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
    cpNames.push(`${nm}_pass`);
    emitted.push({
      name: `${nm}_pass`, kind: 'checkpoint', form: 'pane', vdBadge: badge,
      expectPos: new THREE.Vector3(x, refY, z),
      expectDir: head.clone(),
      // the ring sits at the pilot's crossing height, well below the middle of
      // a floor-to-8 m pane — so the volume carries its own centre
      sensor: { w: W, h: H, d: PANE_D, centre: new THREE.Vector3(x, cU, z) },
    });
  }

  crossings.forEach(c => {
    const { kind, quat: q, dir } = c;
    const p = c.pos;
    const [sx, sy] = c.scale;
    // the launch area faces the first crossing — use the path heading when the
    // stored direction is a degenerate near-vertical (turn pole starts)
    first ??= { pos: p.clone(), dir: (c.degenerate ? c.pathHeading : dir).clone() };
    const pm = toMrsim(p);
    const dm = toMrsim(dir);
    // an invisible checkpoint's true placement is where the field crosses it —
    // resolved from the ghost line when one is supplied (see the unified branch)
    const hit = kind === 'checkpoint' ? lineHit(c.rawPos) : null;

    if (kind === 'flag') {
      const nm = `trkFlag${++nFlag}`;
      // VD 4 m flags: the real trigger (extracted from the race prefab) is a
      // ONE-SIDED 25 x 7.5 m wall that starts AT THE POLE and runs along the
      // flag's local +X — the side away from the cloth — centred 2.6 m up.
      // MRSIM's own FlagPass references a point 11 m out, which would bow the
      // racing line, so keep the flag visual on its pole and emit a plane
      // sensor of our own: from the pole outwards on the trigger side only,
      // 0.4–6.3 m up. (It used to straddle the pole, sticking 3 m out THROUGH
      // the fabric — a checkpoint on the cloth side, which is not where VD
      // fires.) With human lines the plane grows to cover every crossing.
      const fit = fitCrossings(c.rawPos, dir, true);
      const A = Math.atan2(dm.x, dm.y);
      const entX = new THREE.Vector3(Math.cos(A), 0, Math.sin(A));   // placed flag +X in three
      const vx = new THREE.Vector3(1, 0, 0).applyQuaternion(q);      // VD flag +X in three
      // Which way the cloth and the trigger point in the PLACED frame. Two
      // things move them and BOTH must be followed, never assumed: the prefab
      // decides which side of its own pole the cloth is on, and the entity is
      // yawed to the lap crossing direction, which vd-normalize may have
      // flipped away from the stored one. (When only the sensor followed the
      // flip, a flipped flag drew its cloth on the trigger side and hid the
      // pole side.) side 0 = the prefab gives no answer; see flagCloth.
      const cloth = flagCloth(opts.boundsFor?.(c.prefab), sx);
      const entPlus = entX.dot(vx) > 0 ? 1 : -1;   // entity +X vs VD +X
      const clothSign = cloth.side ? cloth.side * entPlus : 1;
      const trigSign = -clothSign;
      const b = flagSensor(fit, trigSign, !!cloth.side);
      // Custom flag at the TRUE scaled VD height: solid pole (thin, exactly
      // where VD's pole is) + a render-only cloth — in VD the cloth is soft
      // enough to brush at race speed, so it must never be a hard collider
      // (simulating the WR line showed it grazing the game flag's solid
      // cloth). Never sink the pole below the floor.
      const flagH = Math.max(3, (opts.heightFor?.(c.prefab) ?? 4) * sy);
      const clothH = flagH * 0.72;
      const clothW = cloth.width;
      usedFlagParts = true;
      const zBase = Math.max(pm.z, 0);
      const clampD = zBase - pm.z;            // how far the clamp raised the pole
      const flagPart = `<Entity name="${nm}_pole">
          <WorldFromEntityComponent z="${fmt(flagH / 2)}"/>
          <Cylinder radius=".045" height="${fmt(flagH)}"/>
          <StaticContact contactMaterial="TrackPart"/>
          <MeshRendererComponent material="FlagRiserMaterial" subdivisions="10"/>
        </Entity>
        <Entity name="${nm}_cloth">
          <WorldFromEntityComponent x="${fmt(clothSign * (0.06 + clothW / 2))}" z="${fmt(flagH - clothH / 2)}"/>
          <Box x="${fmt(clothW)}" y=".03" z="${fmt(clothH)}"/>
          <MeshRendererComponent material="FlagClothMaterial" subdivisions="1"/>
        </Entity>`;
      parts.push(meta('flag', nm),
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(zBase)}"${rotAttrs(dm, true)}>
      <Entity name="${nm}">
        ${flagPart}
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent x="${fmt(b.cx)}" z="${fmt(b.cz - clampD)}"/>
          <Box x="${fmt(b.bw)}" y=".01" z="${fmt(b.bh)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent x="${fmt(b.refS)}" z="${fmt(b.refU - clampD)}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      // the game resolves a checkpoint by the name of the entity that directly
      // carries it — the _pass child, NOT the flag wrapper (verified against the
      // community "…-sloogus.xml"); referencing the wrapper drops the checkpoint
      cpNames.push(`${nm}_pass`);
      emitted.push({
        name: `${nm}_pass`, kind, form: 'flag', vdBadge: c.vdBadge,
        expectPos: p.clone().addScaledVector(entX, b.refS)
          .add(new THREE.Vector3(0, b.refU, 0)),
        expectDir: new THREE.Vector3(dir.x, 0, dir.z).normalize(),
        sensor: { w: b.bw, h: b.bh, d: 0.01,
          centre: p.clone().addScaledVector(entX, b.cx)
            .add(new THREE.Vector3(0, b.cz, 0)) },
      });
    } else if (kind === 'checkpoint' && hit && !c.pole) {
      // A ghost line is available: place this invisible checkpoint (a real
      // window/aperture, not a turn pole — those keep a column, below) exactly
      // where the field crosses it, facing along the flight there. Learned from
      // the perfected 2026 AU NATS edit: windows fly as thin oriented planes ON
      // the racing line, and dive/climb squares stay flat plates but sit at the
      // actual crossing HEIGHT (the stored-centroid slab could be metres low).
      // Without a ghost, the branches below fall back to the default volumes.
      const nm = `trkCheck${++nCheck}`;
      const P = hit.point;                                 // ring world (placed space)
      let head = new THREE.Vector3(hit.tangent.x, 0, hit.tangent.z);   // flight heading
      if (head.lengthSq() < 1e-4) head.copy(c.pathHeading);            // near-vertical dive
      head.normalize();
      // a multi-lap ghost may cross a mark on a return pass going the other way
      // (out-and-back sections); flip only on CLEAR opposition to the lap travel,
      // not near-perpendicularity — at sharp corners the prev->next chord heading
      // is itself unreliable and would wrongly reverse a valid crossing
      const lapH = new THREE.Vector3(c.pathHeading.x, 0, c.pathHeading.z);
      if (lapH.lengthSq() > 1e-6 && head.dot(lapH.normalize()) < -0.3) head.negate();
      const sideV = new THREE.Vector3(-head.z, 0, head.x);            // across the line
      let sMax = 0, uMax = 0, hMax = 0;
      for (const s of hit.near) {
        const off = s.clone().sub(P);
        sMax = Math.max(sMax, Math.abs(off.dot(sideV)));
        uMax = Math.max(uMax, Math.abs(off.y));
        hMax = Math.max(hMax, Math.hypot(off.x, off.z));
      }
      const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      // only a rolled DefaultSquare is a genuine flat aperture you cross
      // vertically; other markers store a near-vertical axis as noise and are
      // flown PAST, so they take the upright plane below
      const plate = c.degenerate && !c.pole && c.squareAxis && Math.abs(dir.y) > 0.85;
      const pmH = toMrsim(P);
      if (plate) {
        // a rolled/flat square you cross vertically: a thin horizontal pane on
        // the line, ring pointing up/down with the crossing sense (as MRSIM's
        // own dive/climb gate). Centred exactly on the ghost crossing, so it
        // needs no thickness beyond a window pane's.
        const down = dir.y < 0;
        const S = cl(2 * hMax + 3, 4, 14), T = PANE_D;
        parts.push(
          `    <Transform x="${fmt(pmH.x)}" y="${fmt(pmH.y)}" z="${fmt(pmH.z)}"${rotAttrs(toMrsim(head), true)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent/>
          <Box x="${fmt(S)}" y="${fmt(S)}" z="${fmt(T)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent rx="1" angle="${down ? '-1.570796' : '1.570796'}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
        emitted.push({
          name: `${nm}_pass`, kind, form: 'plate', vdBadge: c.vdBadge,
          expectPos: P.clone(),
          expectDir: new THREE.Vector3(0, down ? -1 : 1, 0),
          sensor: { w: S, h: T, d: S },
        });
      } else {
        // upright plane crossing along the flight heading: keep the window's
        // VD-derived crossing direction, falling back to the flight tangent if
        // the stored direction is (near-)vertical and gives no usable heading
        const nd = new THREE.Vector3(dir.x, 0, dir.z);
        if (nd.lengthSq() < 0.09) nd.copy(head);
        nd.normalize();
        // a near-vertical marker's residual yaw is noise vd-normalize never
        // vets (its facing pass only checks the VERTICAL sense once |dir.y|
        // > 0.5), so reconcile against the flight before it becomes the
        // trigger's facing — a checkpoint aimed backwards never fires
        if (nd.dot(head) < -0.3) nd.negate();
        const W = cl(2 * sMax + 2.5, 4, 12), H = cl(2 * uMax + 2.5, 4, 12);
        parts.push(
          `    <Transform x="${fmt(pmH.x)}" y="${fmt(pmH.y)}" z="${fmt(pmH.z)}"${rotAttrs(toMrsim(nd))}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent/>
          <Box x="${fmt(W)}" y=".01" z="${fmt(H)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
        emitted.push({
          name: `${nm}_pass`, kind, form: 'upright', vdBadge: c.vdBadge,
          expectPos: P.clone(),
          expectDir: nd.clone(),
          sensor: { w: W, h: H, d: 0.01 },
        });
      }
      cpNames.push(`${nm}_pass`);
    } else if (kind === 'checkpoint' && (c.pole || (c.degenerate && !c.squareAxis))) {
      // Invisible turn pole (VD scale ~10000: pass anywhere beside it) or any
      // other invisible marker whose stored +Z is near-vertical noise — an
      // offset flag, a bare pylon mark. Neither is an aperture you cross
      // vertically, so both become an upright pane squared to the lap path
      // heading, keeping the full lateral and vertical reach the old column
      // had (the field rounds a pylon at a wide range of offsets) and losing
      // only the 16 m of depth. The visible RING is what the pilot flies to,
      // so with a ghost line it sits exactly where the field crosses (closest
      // point on the line) rather than at the wide-radius centroid, which cuts
      // corners metres off the line.
      const nm = `trkCheck${++nCheck}`;
      const fitC = fitPoint(c.rawPos, 9);
      const fx = hit ? hit.point.x : (fitC ? fitC.c.x : p.x);
      const fz = hit ? hit.point.z : (fitC ? fitC.c.z : p.z);
      const ringY = hit ? hit.point.y : (fitC ? fitC.c.y : p.y);
      const W = fitC ? Math.min(20, Math.max(10, 2 * fitC.rH + 5)) : 16;
      const top = Math.max(8, p.y + 6, ringY + (fitC ? fitC.rV : 0) + 2);
      const refY = Math.min(Math.max(hit || fitC ? 0.8 : 1.5, ringY), top - 1);
      // A pole is crossed however the lap runs; a marker that DOES carry a
      // usable horizontal facing keeps it, so its guidance arrow stays true —
      // but only after reconciling it with the lap. These markers reach here
      // because their stored axis is near-VERTICAL, and vd-normalize's facing
      // pass only vets the vertical sense once |dir.y| > 0.5, so the leftover
      // yaw is unvetted noise that can point straight back down the course.
      // As the pane's normal that is fatal: MRSIM fires a checkpoint only when
      // the drone crosses ALONG its facing, so a backwards pane never fires.
      const head = new THREE.Vector3(c.dir.x, 0, c.dir.z);
      if (c.pole || head.lengthSq() < 0.09) head.copy(c.pathHeading);
      head.normalize();
      const lapH = new THREE.Vector3(c.pathHeading.x, 0, c.pathHeading.z);
      if (lapH.lengthSq() > 1e-6 && head.dot(lapH.normalize()) < -0.3) head.negate();
      // ALONG the lap the pane stays on the marker — VD's own volume is
      // centred there, so the checkpoint fires at the same moment VD fires it.
      // (Sliding it onto the ghost's closest point moves the trigger metres up
      // or down the lap, which on a split-S tower let the drone reach the next
      // gate before this checkpoint had fired and stalled the whole lap.)
      // ACROSS the lap it still follows the field's line, so the ring the
      // pilot flies to lands where the field really goes round.
      const side = new THREE.Vector3(-head.z, 0, head.x);
      const lat = new THREE.Vector3(fx - p.x, 0, fz - p.z).dot(side);
      const cx = p.x + side.x * lat, cz = p.z + side.z * lat;
      uprightPane(nm, cx, cz, W, 0.2, top, refY, head, c.vdBadge);
    } else if (kind === 'checkpoint' && c.degenerate) {
      // Flat invisible square: a dive/climb aperture (wall-top compartments,
      // elevated hoops — crossed vertically). A horizontal pane CENTRED on the
      // stored point, its footprint covering the square's scaled in-plane
      // extent. The reference points up/down with the crossing sense, exactly
      // like the game's own 7x7Dive/ClimbGate, so the in-game guidance shows
      // "dive here" / "climb here".
      const nm = `trkCheck${++nCheck}`;
      const [, , sz] = c.scale;
      let S = Math.min(20, Math.max(4,
        2 * (c.squareAxis ? Math.max(sy, sz) : Math.max(sx, sy))));
      const dh = toMrsim(c.pathHeading);
      const down = dir.y < 0;
      // with a human line: centre the pane on where the field actually makes
      // the dive/climb, and widen it to cover every sampled pass
      const fitP = fitPoint(c.rawPos, 7);
      const ctr = fitP ? fitP.c.clone() : p.clone();
      if (fitP) S = Math.min(20, Math.max(S, 2 * fitP.rH + 2.5));
      const T = PANE_D;
      // markers stored below the track's ground level still need a reachable
      // crossing: keep the pane clear of the floor
      ctr.y = Math.max(ctr.y, 0.3);
      const cmP = toMrsim(ctr);
      parts.push(
        `    <Transform x="${fmt(cmP.x)}" y="${fmt(cmP.y)}" z="${fmt(cmP.z)}"${rotAttrs(dh, true)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent/>
          <Box x="${fmt(S)}" y="${fmt(S)}" z="${fmt(T)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent rx="1" angle="${down ? '-1.570796' : '1.570796'}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      cpNames.push(`${nm}_pass`);
      emitted.push({
        name: `${nm}_pass`, kind, form: 'plate', vdBadge: c.vdBadge,
        expectPos: ctr.clone(),
        expectDir: new THREE.Vector3(0, down ? -1 : 1, 0),
        sensor: { w: S, h: T, d: S },
      });
    } else if (kind === 'checkpoint') {
      const nm = `trkCheck${++nCheck}`;
      // Upright invisible checkpoints. VD's DefaultSquare trigger is CENTRED
      // on the stored position (symmetric mesh bounds; verified against the
      // block-built wall windows of the 2026 NATS track — an offset sensor
      // lands on the window frame and can never fire). A named wrapper whose
      // inner entity carries the sensor + <Checkpoint>, like the game's own
      // passage objects.
      const fit = fitCrossings(c.rawPos, dir, false);
      // VD rotates invisible squares freely (a rolled square swaps which
      // scale is width vs height), so project the scaled in-plane axes onto
      // the sensor plane's horizontal/vertical. A square's aperture spans its
      // local Y/Z (crossing +X); other checkpoints span local X/Y.
      const a1 = (c.squareAxis ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0)).applyQuaternion(q);
      const a2 = (c.squareAxis ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0)).applyQuaternion(q);
      const s1 = c.squareAxis ? sy : sx;
      const s2 = c.squareAxis ? c.scale[2] : sy;
      const geoW = Math.min(20, Math.max(1.2,
        2 * (s1 * Math.hypot(a1.x, a1.z) + s2 * Math.hypot(a2.x, a2.z))));
      const geo = Math.min(20, Math.max(1.2,
        2 * (s1 * Math.abs(a1.y) + s2 * Math.abs(a2.y))));
      if (fit) {
        // human lines available: sit on the field's crossings, sized to catch
        // them (kept upright so side/up match the box). Box centred on the
        // stored point + offset; reference pinned to the human centroid.
        const b = sensorBox(fit, { s0: -geoW / 2, s1: geoW / 2, u0: -geo / 2, u1: geo / 2, refU: 0 });
        parts.push(
          `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"${rotAttrs(dm, true)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent x="${fmt(b.cx)}" z="${fmt(b.cz)}"/>
          <Box x="${fmt(b.bw)}" y=".01" z="${fmt(b.bh)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent x="${fmt(b.cx + b.refX)}" z="${fmt(b.cz + b.refZ)}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
        const A = Math.atan2(dm.x, dm.y);
        const side = new THREE.Vector3(Math.cos(A), 0, Math.sin(A));
        emitted.push({
          name: `${nm}_pass`, kind, form: 'upright', vdBadge: c.vdBadge,
          expectPos: p.clone().addScaledVector(side, b.cx + b.refX)
            .add(new THREE.Vector3(0, b.cz + b.refZ, 0)),
          expectDir: new THREE.Vector3(dir.x, 0, dir.z).normalize(),
          sensor: { w: b.bw, h: b.bh, d: 0.01,
            centre: p.clone().addScaledVector(side, b.cx)
              .add(new THREE.Vector3(0, b.cz, 0)) },
        });
      } else {
        // no human data: sensor plane centred on the stored point (kept a
        // little above the floor for markers stored below ground level)
        const zc = Math.max(pm.z, 0.2);
        parts.push(
          `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(zc)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent/>
          <Box x="${fmt(geoW)}" y=".01" z="${fmt(geo)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
        emitted.push({
          name: `${nm}_pass`, kind, form: 'upright', vdBadge: c.vdBadge,
          expectPos: new THREE.Vector3(p.x, Math.max(p.y, 0.2), p.z),
          expectDir: dir.clone(),
          sensor: { w: geoW, h: geo, d: 0.01 },
        });
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
      emitted.push({
        name: nm, kind, form: climb ? 'climb' : 'dive', vdBadge: c.vdBadge,
        expectPos: new THREE.Vector3(p.x, 2.7, p.z),
        expectDir: new THREE.Vector3(0, climb ? 1 : -1, 0),
        vdHeight: p.y,
      });
    } else {   // gate, and shallow windows -> a (possibly pitched) gate
      const nm = `trkGate${++nGate}`;
      const isSF = !!c.start;
      // a gate stored sunk below the track's ground level (VD buries tall RF
      // gates in sloped terrain; their apertures sit higher up) stands on the
      // MRSIM floor instead — a below-floor aperture would be unflyable
      const pg = p.y < 0 ? new THREE.Vector3(p.x, 0, p.z) : p;
      if (pg !== p) sunkGates++;
      const pmg = toMrsim(pg);
      // VD race gates are BIGGER than any MRSIM gate (WDC/MGP openings run
      // 2.9-3.6 m wide x 2.4-2.9 m tall; MRSIM's largest is 3.0 x 1.8) —
      // simulating the WR line proved real racing lines clip the smaller
      // MRSIM frames on most gates. Small gates (<=2.55 m) keep the game's
      // 5x5 model; everything bigger becomes a TRUE-SIZE frame whose
      // collision sits exactly where VD's does.
      const small = c.gateWidth <= 2.55;
      let refWorld, half;
      if (small) {
        const gp = pickGate(c.gateWidth, isSF);
        half = gp.half;
        if (isSF) {
          // the official WorldCup structure: a direct, uncentred include with
          // the -halfwidth centering baked into the placement
          const postOff = new THREE.Vector3(-gp.half, 0, 0).applyQuaternion(rotQuatForDir(dm));
          const postM = pmg.clone().add(postOff);
          parts.push(meta(gp.typeId, nm),
            `    <Transform x="${fmt(postM.x)}" y="${fmt(postM.y)}" z="${fmt(postM.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Include file="/Data/Simulations/Multirotor/5x5StartFinishGate.xml"/>
      </Entity>
    </Transform>`);
        } else {
          usedMacros.add(gp.macro);
          parts.push(meta(gp.typeId, nm),
            `    <Transform x="${fmt(pmg.x)}" y="${fmt(pmg.y)}" z="${fmt(pmg.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Instance macro="${gp.macro}"/>
      </Entity>
    </Transform>`);
        }
        cpNames.push(nm);
        const refOff = new THREE.Vector3(0, 0, 0.75).applyQuaternion(rotQuatForDir(dm));
        refWorld = pg.clone().add(fromMrsim(refOff));
        emitted.push({
          name: nm, kind: 'gate', form: '5x5', vdBadge: c.vdBadge, sf: isSF,
          refH: 0.75,
          expectPos: refWorld, expectDir: dir.clone(),
        });
      } else {
        // true-size frame: opening = the real scaled VD aperture; posts and a
        // top banner are the only solids, exactly where VD has them
        const apW = Math.max(1.6, c.gateWidth - 0.24);
        const apH = Math.max(1.6, (opts.heightFor?.(c.prefab) ?? 2.56) * sy - 0.1);
        half = apW / 2;
        const rq = rotQuatForDir(dm);
        // trigger spans the WHOLE opening: a drone through the gate anywhere —
        // even hugging a post — must fire (the box is a non-solid trigger, so
        // reaching the frame costs nothing); a little depth so a fast pass
        // can't be stepped over
        const bw = apW, bh = apH;
        parts.push(meta(isSF ? 'start-finish-7x6' : 'gate-7x6', nm),
          `    <Transform x="${fmt(pmg.x)}" y="${fmt(pmg.y)}" z="${fmt(pmg.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Entity name="${nm}_postL">
          <WorldFromEntityComponent x="${fmt(-apW / 2 - 0.06)}" z="${fmt((apH + 0.15) / 2)}"/>
          <Cylinder radius=".06" height="${fmt(apH + 0.15)}"/>
          <StaticContact contactMaterial="TrackPart"/>
          <MeshRendererComponent material="GatePostMaterial" subdivisions="10"/>
        </Entity>
        <Entity name="${nm}_postR">
          <WorldFromEntityComponent x="${fmt(apW / 2 + 0.06)}" z="${fmt((apH + 0.15) / 2)}"/>
          <Cylinder radius=".06" height="${fmt(apH + 0.15)}"/>
          <StaticContact contactMaterial="TrackPart"/>
          <MeshRendererComponent material="GatePostMaterial" subdivisions="10"/>
        </Entity>
        <Entity name="${nm}_banner">
          <WorldFromEntityComponent z="${fmt(apH + 0.075)}"/>
          <Box x="${fmt(apW + 0.24)}" y=".04" z=".15"/>
          <StaticContact contactMaterial="TrackPart"/>
          <MeshRendererComponent material="${isSF ? 'GateStartBannerMaterial' : 'GateBannerMaterial'}" subdivisions="1"/>
        </Entity>
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent z="${fmt(apH / 2)}"/>
          <Box x="${fmt(bw)}" y=".3" z="${fmt(bh)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent z="${fmt(apH / 2)}"/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
        usedGateFrame = true;
        if (isSF) usedStartBanner = true;
        cpNames.push(`${nm}_pass`);
        refWorld = pg.clone().add(fromMrsim(
          new THREE.Vector3(0, 0, apH / 2).applyQuaternion(rq)));
        emitted.push({
          name: `${nm}_pass`, kind: 'gate', form: 'exact', vdBadge: c.vdBadge, sf: isSF,
          sfCustom: isSF, refH: apH / 2,
          expectPos: refWorld, expectDir: dir.clone(),
          sensor: { w: bw, h: bh, d: 0.3 },
        });
      }
      {
        // the flyable opening, for the scenery eviction test below; the S/F
        // gate uses a wide shell so its whole dressing frame goes too
        const A = Math.atan2(dm.x, dm.y);
        apertures.push({
          pos: refWorld,
          side: new THREE.Vector3(Math.cos(A), 0, Math.sin(A)),
          through: new THREE.Vector3(dir.x, 0, dir.z).normalize(),
          half,       // gate half-width: thin dressing evicts across the whole frame
          sf: isSF,   // only the start gate sheds its full decorative frame
        });
      }
      // an elevated gate (raised / tower gate) stands on legs in VD — add a
      // vertical support post under each side down to the ground so it isn't floating
      if (pg.y > 0.6) {
        usedLeg = true;
        const A = Math.atan2(dm.x, dm.y);
        const wax = new THREE.Vector3(Math.cos(A), 0, Math.sin(A));   // gate width axis
        for (const s of [-1, 1]) {
          const foot = toMrsim(pg.clone().addScaledVector(wax, s * half));
          // render-only: VD's elevated gates FLOAT (nothing solid below), so
          // the visual support must never be a collider a VD line can hit
          parts.push(
            `    <Transform x="${fmt(foot.x)}" y="${fmt(foot.y)}" z="${fmt(pg.y / 2)}">
      <Entity name="${nm}_leg${s > 0 ? 2 : 1}">
        <Cylinder radius=".04" height="${fmt(pg.y)}"/>
        <MeshRendererComponent material="GateLegMaterial" subdivisions="8"/>
      </Entity>
    </Transform>`);
        }
      }
    }
  });
  if (!cpNames.length) throw new Error('no convertible gates in this track');
  // only the gate branch can emit a StartFinish gate: if VD's start flag sits
  // on a flag/checkpoint/dive, the lap still starts there (list order rules)
  // but MRSIM gets no start/finish visual — say so instead of staying silent
  const startC = crossings.find(c => c.start);
  if (startC && !emitted.some(e => e.sf)) {
    warnings.push(`the VD start element is a ${startC.kind} — no MRSIM start/finish ` +
      'gate emitted (the lap still starts at checkpoint 1)');
  }
  if (offSize) {
    warnings.push(`${offSize} gate(s) differ from the fixed MRSIM gate sizes ` +
      `(e.g. ${offSizeExample}) — MRSIM gates only come in 3 m and 2.1 m`);
  }
  if (sunkGates) {
    warnings.push(`${sunkGates} gate(s) stored below the track's ground level ` +
      'were raised onto the MRSIM floor');
  }

  // ---- scenery: blocks become boxes, hurdles panels, flags flags, nets
  // dark panels (in VD the dive-gate towers and hurdles are scenery; the lap
  // itself only references invisible checkpoints placed at them)
  let nBlock = 0, nHurdle = 0, nDeco = 0, nNet = 0, nEvicted = 0;
  const skipped = new Map();
  const usedBlocks = new Set();
  // VD gates are often dressed with decoration blocks sized for the taller
  // 3.8 x 4 m VD gate; on MRSIM's smaller 7x6/5x5 those blocks would sit
  // INSIDE the flyable opening (this made the 2026 Australian Nationals start
  // gate nearly impassable). Evict any solid box overlapping a gate aperture.
  const UP = new THREE.Vector3(0, 1, 0);
  function blocksAperture(basePos, q, [bsx, bsy, bsz], thin) {
    const bx = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const by = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const bz = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const centre = basePos.clone().addScaledVector(by, bsy / 2);
    const half = a => Math.abs(a.dot(bx)) * bsx / 2 +
      Math.abs(a.dot(by)) * bsy / 2 + Math.abs(a.dot(bz)) * bsz / 2;
    return apertures.some(ap => {
      const off = centre.clone().sub(ap.pos);
      // must sit in the gate's own plane either way — never touch scenery
      // that merely passes in front of or behind the gate
      if (Math.abs(off.dot(ap.through)) >= 0.6 + half(ap.through)) return false;
      if (thin && ap.sf) {
        // VD dresses its start gate with a thin decorative frame (coloured PVC
        // poles + top bars) sized for its taller/wider gate. We already draw
        // the gate, so those poles are redundant AND land as phantom colliders
        // hugging the posts and arching over the opening (the dev's "invisible
        // pole in the middle of the start gate"). A thin pole/bar standing in
        // the start gate's plane, anywhere across its own width and up to just
        // above its top, is that frame — evict it. Scoped to the S/F gate: the
        // spawn sits here so its dressing is the most intrusive, and a blanket
        // sweep of every gate strips legitimate track-side poles.
        return Math.abs(off.dot(ap.side)) < ap.half + 0.35 + half(ap.side) &&
          centre.y - half(UP) < ap.pos.y + 2 &&   // reaches down into the gate zone
          centre.y + half(UP) > -0.55;            // and up out of the floor band
      }
      return Math.abs(off.dot(ap.side)) < 1.35 + half(ap.side) &&
        Math.abs(off.y) < 1.05 + half(UP) &&
        // a low ground strip (boundary band) under the gate is flown OVER,
        // not through — only evict what reaches up into the opening
        off.y + half(UP) > -0.55;
    });
  }
  scenery.forEach(b => {
    const pm = toMrsim(b.pos);
    const q = b.quat;
    const at = `x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"`;
    const [sx, sy, sz] = b.scale;
    if (b.map.type === 'block' || b.map.type === 'net') {
      // a short thin pole/bar (two smaller dims <=0.3 m, long axis <=4.5 m ≈ a
      // gate's own height) is gate-frame dressing, not a wall — it evicts
      // across the gate's whole width, not just the opening. The length cap
      // spares tall boundary/light masts that merely align with a gate plane.
      const dd = [sx, sy, sz].slice().sort((a, z) => a - z);
      const thin = dd[1] <= 0.3 && dd[2] <= 4.5;
      if (blocksAperture(b.pos, q, [sx, sy, sz], thin)) { nEvicted++; return; }
    }
    if (b.map.type === 'block') {
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
        <MeshRendererComponent material="Block${b.map.color[0]}Material" subdivisions="1"/>
      </Entity>
    </Transform>`);
    } else if (b.map.type === 'net') {
      // VD nets are runtime meshes with unit-cube sizing (scale = metres):
      // approximate as solid dark panels — same footprint, same collisions
      const nm = `net${++nNet}`;
      usedNet = true;
      parts.push(
        `    <Transform ${at}${attrsFromQuat(mrsimQuat(q))}>
      <Entity name="${nm}">
        <WorldFromEntityComponent z="${fmt(sy / 2)}"/>
        <Box x="${fmt(sx)}" y="${fmt(sz)}" z="${fmt(sy)}"/>
        <StaticContact contactMaterial="TrackPart"/>
        <MeshRendererComponent material="NetPanelMaterial" subdivisions="1"/>
      </Entity>
    </Transform>`);
    } else if (b.map.type === 'hurdle') {
      // MGP hurdles are a single flat fabric panel (3.04 x 1.52 m native,
      // base origin). Designers ROLL them: the 2025 MultiGP GQ tracks stand
      // several on their short edge as tall narrow slats, and VD stores that
      // as a 90 deg roll about the panel's own fly-past axis. A yaw-only
      // heading threw that away and laid every rolled hurdle back down flat,
      // so keep the WHOLE orientation — and with it VD's own axes (local X =
      // width, local Y = height, local Z = thickness), exactly like blocks.
      const nm = `hurdle${++nHurdle}`;
      usedHurdle = true;
      // Size from the real prefab, but ONLY when it really is a flat panel:
      // /hurdle/ also catches 3-D structures (KDRAHurdle is 3.56 x 2.98 x 3.48
      // m), and taking their bounding box as a panel would inflate a solid
      // collider straight across the lap. Those keep the nominal MGP size, as
      // before. Width/height come from the panel; the thickness stays a
      // nominal 2 cm sheet — a scaled-up sheet would thicken into lines that
      // legitimately brush past it.
      const hb = opts.boundsFor?.(b.prefab);
      const flat = hb && Math.min(hb[3] - hb[0], hb[4] - hb[1], hb[5] - hb[2]) <= 0.3;
      const [nw, nh] = flat ? [hb[3] - hb[0], hb[4] - hb[1]] : HURDLE_SIZE;
      const w = nw * sx, h = nh * sy;
      parts.push(
        `    <Transform ${at}${attrsFromQuat(mrsimQuat(q))}>
      <Entity name="${nm}">
        <WorldFromEntityComponent z="${fmt(h / 2)}"/>
        <Box x="${fmt(w)}" y=".02" z="${fmt(h)}"/>
        <StaticContact contactMaterial="TrackPart"/>
        <MeshRendererComponent material="HurdlePanelMaterial" subdivisions="1"/>
      </Entity>
    </Transform>`);
    } else if (b.map.type === 'flag') {
      // scenery flags: same custom soft-cloth flag as the race branch — solid
      // thin pole at the true scaled height, render-only cloth. The yaw comes
      // straight from the stored orientation (nothing flips a deco flag), so
      // the placed entity's +X sits on VD's local -X and the cloth side is
      // just the prefab's own, mirrored. No trigger here, so nothing depends
      // on getting it right beyond the look.
      const nm = `decoFlag${++nDeco}`;
      const dir = Z_AXIS.clone().applyQuaternion(q);
      const dmF = toMrsim(dir);
      const flagH = Math.max(3, (opts.heightFor?.(b.prefab) ?? 4) * sy);
      const clothH = flagH * 0.72;
      const cloth = flagCloth(opts.boundsFor?.(b.prefab), sx);
      const clothW = cloth.width, clothSign = -(cloth.side || -1);
      usedFlagParts = true;
      const zBase = Math.max(pm.z, 0);
      parts.push(
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(zBase)}"${rotAttrs(dmF, true)}>
      <Entity name="${nm}">
        <Entity name="${nm}_pole">
          <WorldFromEntityComponent z="${fmt(flagH / 2)}"/>
          <Cylinder radius=".045" height="${fmt(flagH)}"/>
          <StaticContact contactMaterial="TrackPart"/>
          <MeshRendererComponent material="FlagRiserMaterial" subdivisions="10"/>
        </Entity>
        <Entity name="${nm}_cloth">
          <WorldFromEntityComponent x="${fmt(clothSign * (0.06 + clothW / 2))}" z="${fmt(flagH - clothH / 2)}"/>
          <Box x="${fmt(clothW)}" y=".03" z="${fmt(clothH)}"/>
          <MeshRendererComponent material="FlagClothMaterial" subdivisions="1"/>
        </Entity>
      </Entity>
    </Transform>`);
    } else {
      const key = b.prefabName || `prefab ${b.prefab}`;
      skipped.set(key, (skipped.get(key) || 0) + 1);
    }
  });
  if (nNet) warnings.push(`${nNet} net(s) approximated as solid dark panels`);
  if (nEvicted) {
    warnings.push(`${nEvicted} decoration block(s) removed from gate openings ` +
      '(VD gate dressing that would block the smaller MRSIM gate)');
  }
  if (skipped.size) {
    warnings.push('skipped (no MRSIM equivalent): ' +
      [...skipped.entries()].map(([n, c]) => `${c}× ${n}`).join(', '));
  }
  if (normal.sceneId != null && !EMPTY_VD_SCENES.has(normal.sceneId)) {
    warnings.push(`source scene ${opts.sceneName || `#${normal.sceneId}`} scenery is not ` +
      `reproduced — the converted track loads in ${location}`);
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

  // the "Centered…" gate macros (only the ones the track actually uses)
  const macroXml = [...usedMacros].map(m => {
    const [shift, file] = MACRO_DEFS[m];
    return `  <Macro name="${m}">
    <Transform x="${shift}">
      <Include file="/Data/Simulations/Multirotor/${file}"/>
    </Transform>
  </Macro>`;
  }).join('\n');

  // custom PBR materials — only the ones the emitted geometry references.
  // MUST use the XML child-element form (like the game's own
  // DroneTrackMaterials.xml and the official tracks' inline materials): the
  // JSON5 block form is only resolved for BinaryModelRenderer default
  // materials — with MeshRendererComponent it leaves the geometry UNRENDERED
  // but still solid (the "invisible object" crash).
  const pbr = (name, [r, g, b], rough) =>
    `  <Material name="${name}">
    <PBR>
      <baseColor x="${r}" y="${g}" z="${b}"/>
      <roughness value="${rough}"/>
      <metallic value="0"/>
    </PBR>
  </Material>`;
  const materialsXml = [
    ...[...usedBlocks].map(id => pbr(`Block${VD_BLOCKS[id][0]}Material`, VD_BLOCKS[id][1], '.8')),
    ...(usedNet ? [pbr('NetPanelMaterial', [.13, .13, .15], '.9')] : []),
    ...(usedHurdle ? [pbr('HurdlePanelMaterial', [.6, .6, .6], '.4')] : []),
    ...(usedLeg ? [pbr('GateLegMaterial', [.85, .85, .85], '.5')] : []),
    ...(usedRiser || usedFlagParts ? [pbr('FlagRiserMaterial', [.1, .1, .1], '.6')] : []),
    ...(usedFlagParts ? [pbr('FlagClothMaterial', [.92, .92, .9], '.7')] : []),
    ...(usedGateFrame ? [pbr('GatePostMaterial', [.93, .93, .9], '.4'),
      pbr('GateBannerMaterial', [.09, .13, .38], '.5')] : []),
    ...(usedStartBanner ? [pbr('GateStartBannerMaterial', [.55, .05, .05], '.4')] : []),
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
      <Transform z=".025">
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

  const summary = {
    name: normal.name,
    location,
    isCircuit,
    groundRaise: -layout.groundY,
    counts: {
      sourceSequence: crossings.length + normal.merged,
      crossings: crossings.length,
      gates: nGate, dives: nDive, flags: nFlag, checkpoints: nCheck,
      merged: normal.merged, tools: normal.tools, offSize,
      sourceScenery: scenery.length,
      blocks: nBlock, nets: nNet, hurdles: nHurdle, decoFlags: nDeco,
      evicted: nEvicted,
      skipped: [...skipped.entries()].map(([n, count]) => ({ name: n, count })),
    },
    cpNames,
    emitted,
    spawn: { pos: back.clone(), heading: fdir.clone() },
  };
  return { xml, warnings, summary };
}

// Public API kept compatible with the viewer: classify/prefabName come from
// the caller's prefab catalogue.
export function vdToMrsim(data, classify, prefabName = () => '', opts = {}) {
  const normal = normalizeVdTrack(data, {
    classify, prefabName, gateWidthFor: opts.gateWidthFor,
    humanLines: opts.humanLines,
  });
  const { xml, warnings, summary } = emitMrsim(normal, opts);
  return { xml, warnings, summary, normal };
}
