// ===========================================================================
// Fly a drone-sized volume along a real racing line through the converted
// track and verify the lap: every checkpoint sensor must fire in list order,
// and the line must not collide with any solid geometry.
//
// Collision geometry comes from the same place the game gets it: the parsed
// track (mrsim.js), whose elements carry every solid Box/Cylinder — including
// the gate includes' collision from the game's own library files. Sensors are
// reconstructed from the converter's per-checkpoint intent (summary.emitted).
//
// The drone is one of MRSIM's own: the ProSpec race quad, modelled as its
// collision mesh's bounding sphere (ProSpecMassCollision.model spans
// 0.258 x 0.26 x 0.049 m -> r = 0.185 m); the line is resampled to fine
// steps so thin panels cannot be stepped over.
// ===========================================================================
import * as THREE from 'three';
import { parseMrsim } from '../mrsim.js';

const DRONE_R = 0.185;   // MRSIM ProSpec collision bounding sphere
const STEP = 0.08;

export function simulateLine(xml, humanLines, { summary, normal }) {
  const track = parseMrsim(xml, 'sim.xml');
  const place = v => {
    const q = v.clone().sub(normal.layout.shift3);
    q.y -= normal.layout.groundY;
    return q;
  };

  // ---- solid geometry, with precomputed inverse transforms -----------------
  const solids = [];
  for (const el of track.elements) {
    for (const p of el.prims) {
      if (p.solid === false) continue;   // render-only (flag cloth, gate legs)
      solids.push({
        el: el.name, shape: p.shape, dims: p.dims,
        inv: p.matrix.clone().invert(),
      });
    }
  }

  // distance from a world point to a solid's surface (negative = inside)
  const lp = new THREE.Vector3();
  function distTo(s, wp) {
    lp.copy(wp).applyMatrix4(s.inv);
    if (s.shape === 'box') {
      const hx = s.dims[0] / 2, hy = s.dims[1] / 2, hz = s.dims[2] / 2;
      const dx = Math.abs(lp.x) - hx, dy = Math.abs(lp.y) - hy, dz = Math.abs(lp.z) - hz;
      const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
      const outside = Math.hypot(ox, oy, oz);
      return outside > 0 ? outside : Math.max(dx, dy, dz);
    }
    // cylinder: axis along local Y, dims = [radius, height]
    const dr = Math.hypot(lp.x, lp.z) - s.dims[0];
    const dy = Math.abs(lp.y) - s.dims[1] / 2;
    const or_ = Math.max(dr, 0), oy = Math.max(dy, 0);
    const outside = Math.hypot(or_, oy);
    return outside > 0 ? outside : Math.max(dr, dy);
  }

  // ---- checkpoint sensors from the converter's intent ----------------------
  // vertical: plates fire on the slab; others on an upright box around the ref.
  // The trigger box is centred on `sensor.centre` when the emitter gives one —
  // a tall pane's ring sits at the pilot's crossing height, metres below the
  // middle of the volume, so using the ring as the centre would model the
  // sensor several metres off and report phantom misses.
  const sensors = summary.emitted.map(e => {
    const dims = e.sensor ?? { w: e.form === '5x5' ? 1.6 : 2.3, h: e.form === '5x5' ? 1.55 : 1.9, d: 1.2 };
    const vertical = Math.abs(e.expectDir.y) > 0.9;
    const dirH = vertical ? null
      : new THREE.Vector3(e.expectDir.x, 0, e.expectDir.z).normalize();
    return { name: e.name, pos: dims.centre ?? e.expectPos, dims, vertical, dirH,
      dir3: new THREE.Vector3(e.expectDir.x, e.expectDir.y, e.expectDir.z) };
  });
  const insideSensor = (s, wp) => {
    const ox = wp.x - s.pos.x, oy = wp.y - s.pos.y, oz = wp.z - s.pos.z;
    const hw = s.dims.w / 2 + DRONE_R, hh = s.dims.h / 2 + DRONE_R;
    const hd = Math.max(s.dims.d / 2 + DRONE_R, 0.6);
    if (Math.abs(oy) > hh) return false;
    if (s.vertical) return Math.abs(ox) <= hw && Math.abs(oz) <= hw;
    const t = ox * s.dirH.x + oz * s.dirH.z;
    const sd = ox * s.dirH.z - oz * s.dirH.x;
    return Math.abs(t) <= hd && Math.abs(sd) <= hw;
  };

  // ---- resample the line to fine, evenly spaced steps ----------------------
  const path = [];
  for (const line of humanLines) {
    const placed = line.map(place);
    for (let i = 1; i < placed.length; i++) {
      const a = placed[i - 1], b = placed[i];
      const d = a.distanceTo(b);
      const n = Math.max(1, Math.ceil(d / STEP));
      for (let k = 0; k < n; k++) path.push(a.clone().lerp(b, k / n));
    }
  }

  // ---- sweep ---------------------------------------------------------------
  const hits = new Map();          // element -> {count, sample point, minDist}
  let next = 0;                    // next expected checkpoint index
  const firedAt = [];
  const outOfOrder = new Set();
  path.forEach((wp, i) => {
    for (const s of solids) {
      const d = distTo(s, wp) - DRONE_R;
      if (d < 0) {
        const thin = s.shape === 'cyl' ? s.dims[0] <= 0.1
          : Math.min(...s.dims) <= 0.06;
        const h = hits.get(s.el) ?? { count: 0, at: wp.clone(), depth: 0, thin };
        h.count++;
        h.thin &&= thin;
        if (-d > h.depth) { h.depth = -d; h.at = wp.clone(); }
        hits.set(s.el, h);
      }
    }
    // MRSIM checkpoints are directional: fire only when the drone is inside
    // the sensor AND moving along the checkpoint's facing — so a sensor
    // emitted backwards shows up here as a miss, not a silent pass
    const vel = i > 0 ? wp.clone().sub(path[i - 1]) : null;
    const along = s => !vel || vel.lengthSq() < 1e-10 || vel.dot(s.dir3) > 0;
    if (next < sensors.length && insideSensor(sensors[next], wp) && along(sensors[next])) {
      firedAt.push({
        n: next + 1, name: sensors[next].name, i,
        dot: vel && vel.lengthSq() > 1e-10
          ? +(vel.clone().normalize().dot(sensors[next].dir3)).toFixed(3) : 1,
      });
      next++;
    } else {
      for (let j = next + 1; j < sensors.length; j++) {
        if (insideSensor(sensors[j], wp)) { outOfOrder.add(j + 1); break; }
      }
    }
  });

  // Separate REAL obstructions from line-resolution grazes: a 10 Hz ghost
  // cuts corners by up to ~0.25 m around thin posts/poles it actually
  // rounded, and converted blocks are geometrically identical to VD's (the
  // real lap demonstrably fit past them). Anything deeper, or on a wide
  // surface that isn't VD-exact, is a genuine conversion obstruction.
  const all = [...hits.entries()].map(([el, h]) => ({
    element: el, samples: h.count, depth: +h.depth.toFixed(2),
    thin: h.thin, at: h.at.toArray().map(v => +v.toFixed(2)),
  })).sort((a, b) => b.depth - a.depth);
  const isGraze = c => c.depth <= 0.25 && (c.thin || /^blk|^net/.test(c.element));
  return {
    samples: path.length,
    checkpoints: sensors.length,
    fired: next,
    firedAt,           // per-fire {n, name, i, dot}: dot = travel·facing at the trigger
    missed: sensors.slice(next).map((s, k) => ({ n: next + k + 1, name: s.name })),
    collisions: all.filter(c => !isGraze(c)),
    grazes: all.filter(isGraze),
    outOfOrderTouches: [...outOfOrder],
  };
}
