// ===========================================================================
// LED / neon objects — shared by the editor palette and the VelociDrone
// converter, so a hand-placed neon ring and a converted one are the same thing.
//
// MRSIM has no light-emitting track object, but it does have a light-emitting
// MATERIAL: the drone's own arm LEDs (/Data/Simulations/Multirotor/RaceLEDs.xml
// -> RaceLEDs.model, painted with DroneRenderingMaterials.xml's "LEDLighting")
// are a PBREmissive material — a near-black baseColor plus an HDR `emissive`
// uniform whose values run past 1 so the bloom pass catches them. The Champs25
// gate LEDs do the same through per-instance data (0u base .3, 4u emissive 3).
// Point that material at ordinary geometry and any object glows, so "export the
// drone LED as a game object" is: build the shape out of prims, light it with
// GLOW_HDR-scaled PBREmissive.
//
// The XML child-element form is deliberate. MRSIM only resolves the JSON5 block
// form of <Material> for BinaryModelRenderer default materials; with a
// MeshRendererComponent it leaves geometry solid but UNRENDERED (see
// emit-mrsim.js). Every material here is written as child elements.
//
// Geometry is tube runs: each outline edge becomes one native <Cylinder>, which
// is ~40x smaller in the file than an inline Polyhedron of the same tube and
// renders as a real round tube. Nothing here is ever a collider — a glowing
// hoop is light, and MRSIM would otherwise collide against the hull of the
// shape you are supposed to fly through.
// ===========================================================================

// HDR headroom of the emissive uniform. 3 is what the game itself uses for
// both the drone LEDs and the Champs25 gate lights.
export const GLOW_HDR = 3;
// tube radius of a neon run (VD's neon extrusions are ~0.06 m thick)
export const NEON_TUBE = 0.06;

// ---- colour ---------------------------------------------------------------
// VelociDrone names its neon prefabs by colour letter/word: DefaultNeonRingR,
// NeonStripBlue, MicroNeonSquareMP…  (same table as the viewer's NAME_COLORS).
const NAME_COLOR_RE = /(Black|White|Red|Orange|Yellow|Green|Cyan|Blue|Purple|Pink|[WBRGYPO])$/;
const NAME_COLORS = {
  Black: '#17181c', White: '#f0f0ee', W: '#f0f0ee',
  Red: '#e63c3c', R: '#e63c3c', Orange: '#ff8c1a', O: '#ff8c1a',
  Yellow: '#ffd83d', Y: '#ffd83d', Green: '#33d05e', G: '#33d05e',
  Cyan: '#22d3d3', Blue: '#2a6bff', B: '#2a6bff',
  Purple: '#a04ce6', P: '#a04ce6', Pink: '#f280bf',
};
// a few carry the colour as a prefix instead (WhiteConeNeon), so fall back to
// a colour word anywhere in the name before giving up on the default cyan
const NAME_COLOR_ANY = /(Black|White|Red|Orange|Yellow|Green|Cyan|Blue|Purple|Pink)/;
export const NEON_DEFAULT_HEX = '#28d9ff';
export function neonHexOf(name) {
  const n = String(name || '');
  return NAME_COLORS[n.match(NAME_COLOR_RE)?.[1]] ||
    NAME_COLORS[n.match(NAME_COLOR_ANY)?.[1]] || NEON_DEFAULT_HEX;
}

// ---- material -------------------------------------------------------------
const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export function hexToLinear(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(srgbToLinear);
}
// one shared material per colour, named the same in both producers so a
// converted track and an editor recolour reuse each other's definitions
export const glowName = hex => 'EdGlow_' + String(hex).replace('#', '').toUpperCase();
export function glowMaterialXml(hex, indent = '  ') {
  const [r, g, b] = hexToLinear(hex);
  const f = v => (+v.toFixed(4)).toString();
  // unlit, a neon tube is dark plastic — all of its colour is in the glow
  return `${indent}<Material name="${glowName(hex)}">
${indent}  <PBREmissive>
${indent}    <baseColor x="${f(r * .1)}" y="${f(g * .1)}" z="${f(b * .1)}"/>
${indent}    <roughness value=".2"/>
${indent}    <metallic value="0"/>
${indent}    <emissive x="${f(r * GLOW_HDR)}" y="${f(g * GLOW_HDR)}" z="${f(b * GLOW_HDR)}"/>
${indent}  </PBREmissive>
${indent}</Material>`;
}

// ---- shapes ---------------------------------------------------------------
// Which outline a VelociDrone neon prefab is. VD's whole neon family is one
// silhouette per name: Ring/Circle round, Square/SquareM square, Triangle(M)
// triangular, Deca a decagon, SemiCircle an arch, Corner/Angle elbows, Back a
// bar, Strip a stretchable strip, ConeNeon the glowing collar on a cone.
export function neonShapeOf(name) {
  const n = String(name || '');
  if (/strip/i.test(n)) return 'strip';
  if (/cone/i.test(n)) return 'collar';
  if (/semicircle/i.test(n)) return 'semicircle';
  if (/triangle/i.test(n)) return 'triangle';
  if (/square/i.test(n)) return 'square';
  if (/deca/i.test(n)) return 'deca';
  if (/corner/i.test(n)) return 'corner';
  if (/angle/i.test(n)) return 'angle';
  if (/back/i.test(n)) return 'bar';
  if (/ring|circle|hoop/i.test(n)) return 'ring';
  return 'ring';
}
export const NEON_SHAPES = ['ring', 'square', 'triangle', 'deca', 'semicircle',
  'corner', 'angle', 'bar', 'strip', 'collar'];

// Outline of a neon shape in the object's local plane: x across, z up, the
// opening facing local ±Y (the same convention gates use, so a placed neon ring
// yaws like every other object). Every closed silhouette is "a shape `w` across
// sitting so its top is at `h`" — which is exactly how VD's own prefabs measure
// (ring 2.84x3.21, squareM 2.8x3.14, triangleM 2.84x3.18: h - w = the 0.34 m
// ground gap in all three).
// The silhouette, centred on its own middle: x across in [-w/2, w/2], z up in
// [-h/2, h/2]. Width and height are independent — VD track builders scale their
// neon per axis (the TBS finals stretch a 2 x 2 m neon square into 8.4 x 6.5 m),
// so a shape that assumed "as tall as it is wide" would put the opening metres
// from where the drone actually flies.
function outline(shape, w, h) {
  const rx = w / 2, rz = h / 2;
  const round = (n, from = 0, span = Math.PI * 2) => {
    const pts = [];
    const div = span >= Math.PI * 2 - 1e-6 ? n : n - 1;
    for (let i = 0; i < n; i++) {
      const t = from + span * (i / div);
      pts.push([rx * Math.sin(t), rz * Math.cos(t)]);
    }
    return pts;
  };
  switch (shape) {
    case 'deca':       return { pts: round(10), closed: true };
    // an arch: the top half of the ellipse, standing on its diameter
    case 'semicircle': return { pts: round(11, -Math.PI / 2, Math.PI), closed: false };
    case 'square':     return { pts: [[-rx, -rz], [rx, -rz], [rx, rz], [-rx, rz]], closed: true };
    case 'triangle':   return { pts: [[-rx, -rz], [rx, -rz], [0, rz]], closed: true };
    // elbow: a run up the left side turning over to the right at the top
    case 'corner':     return { pts: [[-rx, -rz], [-rx, rz], [rx, rz]], closed: false };
    // wider elbow with a return leg (VD's "angle" is a corner plus a stub)
    case 'angle':      return { pts: [[-rx, rz], [0, -rz], [rx, rz]], closed: false };
    case 'bar':        return { pts: [[-rx, 0], [rx, 0]], closed: false };
    case 'ring':
    default:           return { pts: round(20), closed: true };
  }
}

// Tube runs for a shape: one entry per outline edge, each a cylinder of length
// `len` centred at (x, z) whose axis is rolled `deg` about local +Y (a
// cylinder's own axis is +Z, and rotating it about +Y by a sends +Z to
// (sin a, 0, cos a) — so `deg` is just the edge's bearing from straight up).
// Ends are extended by the tube radius so corners meet without a notch.
// `cz` lifts the whole silhouette (its centre) off the entity origin; when that
// leaves a gap under it, two thin legs drop to the origin the way VD's own
// ground-standing neon rings stand on theirs.
export function neonRuns(shape, { w = 2.84, h = 2.84, cz = 0, d = 0,
  tube = NEON_TUBE, legs = true } = {}) {
  // two shapes aren't tube loops. A strip is VelociDrone's stretchable light
  // panel (its scale IS its size in metres), and a cone's neon is the glowing
  // collar around its base — both are one slab of light.
  if (shape === 'strip')
    return [{ box: true, x: 0, z: cz || h / 2, dims: [w, d || tube, h || tube], deg: 0 }];
  if (shape === 'collar')
    return [{ x: 0, z: cz || h / 2 || tube, len: Math.max(h, 0.04), deg: 0, r: w / 2 }];
  const o = outline(shape, w, h);
  const runs = [];
  const n = o.pts.length;
  const edges = o.closed ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const [ax, az] = o.pts[i], [bx, bz] = o.pts[(i + 1) % n];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    runs.push({ x: (ax + bx) / 2, z: cz + (az + bz) / 2, len: len + tube,
      deg: Math.atan2(dx, dz) * 180 / Math.PI, r: tube });
  }
  const base = cz - h / 2;
  if (legs && base > 0.05 && o.closed) {
    const foot = Math.min(w / 2 - tube, w / 3);
    for (const s of [-1, 1])
      runs.push({ x: s * foot, z: base / 2, len: base, deg: 0, r: tube * 0.7, leg: true });
  }
  return runs;
}

// The same runs as editor component parts (see mrsim-test.html's part schema).
export function neonParts(shape, opts = {}) {
  const color = opts.color || NEON_DEFAULT_HEX;
  const r4 = v => +(+v).toFixed(4);
  return neonRuns(shape, opts).map((run, i) => ({
    shape: run.box ? 'box' : 'cyl', name: run.leg ? `leg${i}` : `n${i}`,
    pos: [r4(run.x), 0, r4(run.z)],
    rot: [0, 0, +run.deg.toFixed(3)],
    dims: run.box ? run.dims.map(r4) : [r4(run.r), r4(run.len)],
    color, glow: true, solid: false,
  }));
}

// Fit a neon shape to a VelociDrone prefab's own mesh bounds (tracks/
// prefab-dims.json, VD's local axes: x right, y up, z forward) times the
// placement's scale. VD's neon family is not consistently oriented — the
// ground-standing pieces (ring, squareM, triangleM, deca, corner, back) are
// thin along z and stand in the xy plane, while the flat wall pieces (circle,
// square, triangle) are thin along x and hang in the yz plane — so the thin
// axis decides which MRSIM plane the tube runs live in.
export function neonFit(bounds, scale = [1, 1, 1], shape = 'ring') {
  const b = bounds || [-1.42, 0, -0.29, 1.42, 3.21, 0.29];
  const ext = [0, 1, 2].map(i => Math.abs(b[i + 3] - b[i]) * Math.abs(scale[i] ?? 1));
  const lo = i => Math.min(b[i], b[i + 3]) * Math.abs(scale[i] ?? 1);
  const hi = i => Math.max(b[i], b[i + 3]) * Math.abs(scale[i] ?? 1);
  // a cone's collar is the one flat-lying piece: a disc as wide as the cone
  // and only centimetres thick, so its thin axis is its height, not its plane
  if (shape === 'collar') {
    return { w: Math.max(ext[0], ext[2]), h: ext[1], d: ext[1],
      cz: (lo(1) + hi(1)) / 2, uOff: 0, plane: 'xz', shape };
  }
  const thin = ext.indexOf(Math.min(...ext));
  // u = the across axis, v = the up axis (VD y wherever it is not the thin one)
  const [u, v] = thin === 0 ? [2, 1] : thin === 1 ? [0, 2] : [0, 1];
  return {
    w: ext[u], h: ext[v], d: ext[thin],
    // where the silhouette's centre sits relative to the prefab's origin —
    // VD's ground-standing neon is modelled from its feet up, the wall pieces
    // around their middle, and only the bounds say which
    cz: (lo(v) + hi(v)) / 2,
    uOff: (lo(u) + hi(u)) / 2,
    plane: thin === 0 ? 'yz' : 'xz',
    shape,
  };
}

// The same runs as MRSIM XML entities, for the converter's string emitter.
// `material` defaults to the shared glow material for the colour; `plane`
// picks which way the loop faces ('xz' = opening along local ±Y, the gate
// convention; 'yz' = opening along ±X, VD's wall pieces) and `uOff` slides it
// along its across-axis so it lands where VD's own mesh sits.
export function neonEntitiesXml(shape, name, opts = {}) {
  const hex = opts.color || NEON_DEFAULT_HEX;
  const material = opts.material || glowName(hex);
  const pad = opts.indent || '        ';
  const yz = opts.plane === 'yz';
  const uOff = opts.uOff || 0;
  const f = v => (+v.toFixed(4)).toString();
  const at = (a, val) => (Math.abs(val) > 5e-4 ? ` ${a}="${f(val)}"` : '');
  return neonRuns(shape, opts).map((run, i) => {
    // a cylinder's axis is local +Z; rolling it about the plane's own normal by
    // the run's bearing lays it along the outline edge (+Y for the xz plane,
    // -X for the yz one, which is the same handedness seen from the opening)
    const rot = Math.abs(run.deg) > 1e-3
      ? ` ${yz ? 'rx="-1"' : 'ry="1"'} angleDegrees="${f(run.deg)}"` : '';
    const u = run.x + uOff;
    const geo = run.box
      ? `<Box x="${f(run.dims[yz ? 1 : 0])}" y="${f(run.dims[yz ? 0 : 1])}" z="${f(run.dims[2])}"/>`
      : `<Cylinder radius="${f(run.r)}" height="${f(run.len)}"/>`;
    return `${pad}<Entity name="${name}_n${i}">
${pad}  <WorldFromEntityComponent${at(yz ? 'y' : 'x', u)} z="${f(run.z)}"${rot}/>
${pad}  ${geo}
${pad}  <MeshRendererComponent material="${material}" subdivisions="${run.box ? 1 : 8}"/>
${pad}</Entity>`;
  }).join('\n');
}
