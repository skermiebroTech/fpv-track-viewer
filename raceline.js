// ===========================================================================
// TOGT-inspired racing-line optimiser.
//
// Method from the TOGT-Planner by FSC-Lab (University of Toronto), MIT licence:
//   https://github.com/FSC-Lab/TOGT-Planner
//   Chao Qin, Maxime S.J. Michet, Jingxiang Chen, Hugh H.-T. Liu,
//   "Time-Optimal Gate-Traversing Planner for Autonomous Drone Racing",
//   IEEE ICRA 2024.
//
// Their key insight: a racing line should not be forced through gate centres.
// Each gate is a *region*; the crossing point is a free variable inside the
// aperture, optimised jointly with the rest of the trajectory against a time
// objective. This file is an independent JavaScript re-implementation of that
// idea, simplified for an in-browser viewer:
//   - the trajectory is a dense polyline (free points between crossings)
//     rather than MINCO polynomials
//   - lap time is estimated with a curvature-limited speed model
//     v = min(vmax, sqrt(a_lat / kappa)) instead of full quadrotor dynamics
//   - crossing points stay inside each aperture through a tanh map, so the
//     problem is unconstrained (same trick TOGT uses for gate regions)
//   - optimisation is Adam with local finite-difference gradients instead of
//     L-BFGS with analytic MINCO gradients
// ===========================================================================
import * as THREE from 'three';

// Tunable parameters (calibrated so the line tracks real human WR flights).
// Override any at runtime via globalThis.__RL for experimentation.
const DEFAULTS = {
  VMAX: 30,        // m/s top speed
  ALAT: 24,        // m/s^2 lateral accel limit — lower => wider, flowing arcs
  W_SMOOTH: 0.03,  // anti-kink second-difference weight — higher => smoother
  W_GROUND: 6,     // stay-above-ground weight
  W_ALIGN: 8,      // cross roughly along the gate normal
  W_SIDE: 4,       // neighbours on the correct side of the gate plane
  COS_MAX: 0.64,   // ~50 deg max crossing angle before penalty
  SIDE_GAP: 0.15,  // m the neighbours must clear the gate plane by
  ITERS: 420,
  LR: 0.035,
  CROSS: 2.4,        // entry/exit helper distance (m) along the gate axis
  CROSS_VDAMP: 0.35, // vertical damping of that helper (dive gates don't balloon)
};

// A crossing: { center, through, axisX, axisY, halfW, halfH } (THREE.Vector3
// axes, unit; halfW/halfH = usable aperture half-extents in metres).
// Returns { points, nodeTimes, lapTime } or null when there is nothing to
// optimise. `nodeTimes` is the cumulative estimated time at each point.
export function computeRaceline(crossings, { closed, groundY }) {
  const N = crossings.length;
  if (N < 3) return null;

  const { VMAX, ALAT, W_SMOOTH, W_GROUND, W_ALIGN, W_SIDE, COS_MAX, SIDE_GAP,
    ITERS, LR, CROSS, CROSS_VDAMP } = { ...DEFAULTS, ...(globalThis.__RL || {}) };

  // ---- warm start: today's proven line (entry/centre/exit + Catmull-Rom) --
  // keeps the verified crossing topology (split-S loops, hook turns) and lets
  // the optimiser refine from a feasible shape instead of a straight guess.
  // The entry/exit helpers extend along each gate's through-axis, but their
  // vertical reach is damped so steeply-tilted dive gates don't balloon the
  // line above the course.
  const warmPts = [];
  crossings.forEach(c => {
    const off = c.through.clone().multiplyScalar(CROSS);
    off.y *= CROSS_VDAMP;
    warmPts.push(
      c.center.clone().sub(off),
      c.center.clone(),
      c.center.clone().add(off),
    );
  });
  warmPts.forEach(p => { p.y = Math.max(p.y, groundY + 0.35); });
  const warm = new THREE.CatmullRomCurve3(warmPts, closed, 'centripetal');
  const P = warmPts.length;
  const tOf = k => closed ? k / P : k / (P - 1);

  // ---- nodes: one per crossing + free points sampled from the warm curve --
  const spanCount = closed ? N : N - 1;
  const nodeGate = [];      // crossing index or -1 (free)
  const initPos = [];
  const gateNode = new Array(N).fill(-1);
  for (let i = 0; i < spanCount; i++) {
    const a = crossings[i], b = crossings[(i + 1) % N];
    gateNode[i] = initPos.length;
    nodeGate.push(i); initPos.push(a.center.clone());
    const chord = a.center.distanceTo(b.center);
    const sub = Math.min(10, Math.max(2, Math.ceil(chord / 2)));
    let ta = tOf(3 * i + 1), tb = tOf(3 * ((i + 1) % N) + 1);
    if (tb <= ta) tb += 1;
    for (let s = 1; s < sub; s++) {
      const t = ta + (tb - ta) * (s / sub);
      nodeGate.push(-1); initPos.push(warm.getPoint(t % 1));
    }
  }
  if (!closed) {
    gateNode[N - 1] = initPos.length;
    nodeGate.push(N - 1); initPos.push(crossings[N - 1].center.clone());
  }
  const M = initPos.length;
  const px = new Float64Array(M), py = new Float64Array(M), pz = new Float64Array(M);
  initPos.forEach((p, k) => { px[k] = p.x; py[k] = Math.max(p.y, groundY + 0.35); pz[k] = p.z; });

  const wrap = k => closed ? ((k % M) + M) % M : (k < 0 || k >= M ? -1 : k);

  // ---- gate-plane tanh map (keeps crossings strictly inside apertures) ----
  const gu = new Float64Array(N), gv = new Float64Array(N);
  function placeGate(i) {
    const c = crossings[i], k = gateNode[i];
    const du = c.halfW * Math.tanh(gu[i]), dv = c.halfH * Math.tanh(gv[i]);
    px[k] = c.center.x + c.axisX.x * du + c.axisY.x * dv;
    py[k] = c.center.y + c.axisX.y * du + c.axisY.y * dv;
    pz[k] = c.center.z + c.axisX.z * du + c.axisY.z * dv;
  }

  // ---- cost terms (all local, so gradients only touch a small window) -----
  const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  function curvature(k) {           // Menger curvature at node k
    const a = wrap(k - 1), b = wrap(k + 1);
    if (a < 0 || b < 0) return 0;
    const ux = px[k] - px[a], uy = py[k] - py[a], uz = pz[k] - pz[a];
    const vx = px[b] - px[k], vy = py[b] - py[k], vz = pz[b] - pz[k];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const lu = len3(ux, uy, uz), lv = len3(vx, vy, vz);
    const lw = len3(ux + vx, uy + vy, uz + vz);
    return 2 * len3(cx, cy, cz) / (lu * lv * lw + 1e-9);
  }
  const speedAt = k => Math.min(VMAX, Math.sqrt(ALAT / Math.max(curvature(k), 1e-9)));
  function edgeTime(e) {            // time to fly edge e -> e+1
    const a = wrap(e), b = wrap(e + 1);
    if (a < 0 || b < 0) return 0;
    const ds = len3(px[b] - px[a], py[b] - py[a], pz[b] - pz[a]);
    return ds / (0.5 * (speedAt(a) + speedAt(b)) + 1e-9);
  }
  function smoothTerm(k) {
    const a = wrap(k - 1), b = wrap(k + 1);
    if (a < 0 || b < 0) return 0;
    const sx = px[a] - 2 * px[k] + px[b], sy = py[a] - 2 * py[k] + py[b],
      sz = pz[a] - 2 * pz[k] + pz[b];
    return W_SMOOTH * (sx * sx + sy * sy + sz * sz);
  }
  const groundTerm = k => {
    const d = groundY + 0.35 - py[k];
    return d > 0 ? W_GROUND * d * d : 0;
  };
  function alignTerm(k) {           // only meaningful at crossing nodes
    const gi = nodeGate[k];
    if (gi < 0) return 0;
    const a = wrap(k - 1), b = wrap(k + 1);
    if (a < 0 || b < 0) return 0;
    const c = crossings[gi], n = c.through;
    const dx = px[b] - px[a], dy = py[b] - py[a], dz = pz[b] - pz[a];
    const dn = len3(dx, dy, dz) + 1e-9;
    let J = 0;
    const dot = (dx * n.x + dy * n.y + dz * n.z) / dn;
    if (dot < COS_MAX) J += W_ALIGN * (COS_MAX - dot) * (COS_MAX - dot);
    // entry neighbour behind the gate plane, exit neighbour past it
    const sa = (px[a] - c.center.x) * n.x + (py[a] - c.center.y) * n.y + (pz[a] - c.center.z) * n.z;
    const sb = (px[b] - c.center.x) * n.x + (py[b] - c.center.y) * n.y + (pz[b] - c.center.z) * n.z;
    if (sa > -SIDE_GAP) J += W_SIDE * (sa + SIDE_GAP) * (sa + SIDE_GAP);
    if (sb < SIDE_GAP) J += W_SIDE * (SIDE_GAP - sb) * (SIDE_GAP - sb);
    return J;
  }
  // everything that can change when node j moves
  function localCost(j) {
    let J = 0;
    for (let e = j - 2; e <= j + 1; e++) J += edgeTime(e);
    for (let k = j - 1; k <= j + 1; k++) {
      const kk = wrap(k);
      if (kk < 0) continue;
      J += smoothTerm(kk) + alignTerm(kk);
    }
    return J + groundTerm(j);
  }
  function totalCost() {
    let J = 0;
    const E = closed ? M : M - 1;
    for (let e = 0; e < E; e++) J += edgeTime(e);
    for (let k = 0; k < M; k++) J += smoothTerm(k) + groundTerm(k) + alignTerm(k);
    return J;
  }

  // ---- Adam over [gate u,v pairs..., free node x,y,z...] ------------------
  const freeNodes = [];
  for (let k = 0; k < M; k++) if (nodeGate[k] < 0) freeNodes.push(k);
  const nVars = 2 * N + 3 * freeNodes.length;
  const m1 = new Float64Array(nVars), m2 = new Float64Array(nVars);
  const H = 5e-3;

  function fdGrad(idx) {            // central difference on the local window
    let node, set, get;
    if (idx < 2 * N) {
      const gi = idx >> 1, uv = idx & 1 ? gv : gu;
      node = gateNode[gi];
      get = () => uv[gi];
      set = x => { uv[gi] = x; placeGate(gi); };
    } else {
      const r = idx - 2 * N, f = Math.floor(r / 3), ax = [px, py, pz][r % 3];
      node = freeNodes[f];
      get = () => ax[node];
      set = x => { ax[node] = x; };
    }
    const x0 = get();
    set(x0 + H); const jp = localCost(node);
    set(x0 - H); const jm = localCost(node);
    set(x0);
    return (jp - jm) / (2 * H);
  }
  const readVar = idx => {
    if (idx < 2 * N) return (idx & 1 ? gv : gu)[idx >> 1];
    const r = idx - 2 * N;
    return [px, py, pz][r % 3][freeNodes[Math.floor(r / 3)]];
  };
  const writeVar = (idx, x) => {
    if (idx < 2 * N) {
      (idx & 1 ? gv : gu)[idx >> 1] = x; placeGate(idx >> 1);
    } else {
      const r = idx - 2 * N;
      [px, py, pz][r % 3][freeNodes[Math.floor(r / 3)]] = x;
    }
  };

  let prev = totalCost();
  const b1 = 0.9, b2 = 0.999;
  for (let it = 1; it <= ITERS; it++) {
    const c1 = 1 / (1 - Math.pow(b1, it)), c2 = 1 / (1 - Math.pow(b2, it));
    for (let i = 0; i < nVars; i++) {
      const g = fdGrad(i);
      m1[i] = b1 * m1[i] + (1 - b1) * g;
      m2[i] = b2 * m2[i] + (1 - b2) * g * g;
      writeVar(i, readVar(i) - LR * (m1[i] * c1) / (Math.sqrt(m2[i] * c2) + 1e-8));
    }
    if (it % 25 === 0) {
      const J = totalCost();
      if (!isFinite(J)) return null;
      if (Math.abs(prev - J) < 1e-4 * Math.abs(J)) break;
      prev = J;
    }
  }

  // ---- results: points + cumulative time profile for the fly-lap ----------
  const points = [];
  for (let k = 0; k < M; k++) {
    if (!isFinite(px[k]) || !isFinite(py[k]) || !isFinite(pz[k])) return null;
    points.push(new THREE.Vector3(px[k], py[k], pz[k]));
  }
  const nodeTimes = [0];
  const E = closed ? M : M - 1;
  for (let e = 0; e < E; e++) nodeTimes.push(nodeTimes[e] + edgeTime(e));
  return { points, nodeTimes, lapTime: nodeTimes[E] };
}

// Orthonormal in-plane basis for a crossing that only knows its normal
// (MRSIM checkpoints): axisX horizontal where possible, axisY completing it.
export function planeBasis(through) {
  const up = Math.abs(through.y) > 0.9
    ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const axisX = new THREE.Vector3().crossVectors(up, through).normalize();
  const axisY = new THREE.Vector3().crossVectors(through, axisX).normalize();
  return { axisX, axisY };
}
