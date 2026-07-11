import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { parseTrk, buildTrk, decryptTrk } from './trk.js?v=11';
import { parseMrsim } from './mrsim.js';
import { vdToMrsim, mrsimToVd, MRSIM_LOCATIONS, VD_SCENES } from './convert.js';
import { computeRaceline, planeBasis } from './raceline.js';
import { fetchLeaderboard, fetchFlightFor, averageLaps, parseGhostBytes,
  getProxyBase, setProxyBase, needsProxySetup } from './ghostfetch.js?v=12';

// ===========================================================================
// Data conventions (verified against the official 2024 AU NATS layout):
//  - positions are integer centimetres, Unity left-handed Y-up
//  - rotations are quaternions stored as int*1000 in (w, x, y, z) order
//  - scale is percent, relative to each prefab's native size
//  Unity -> three.js (right-handed): pos (x, y, -z), quat (-x, -y, z, w).
//  With this mapping the standard three.js top view (-z up-screen) matches
//  the official 2D track posters exactly.
// ===========================================================================
const CM = 0.01;
const GATE_SIZE = 2.0;        // race gates are 2 m square
const GATE_BAR = 0.11;        // frame bar thickness

// Prefab knowledge, harvested from the game's own databases and asset bundles:
//  - tracks/prefabs.json  = settings.db `trackprefabs` (id -> [name, type, gate])
//                           + `sceneries` (scene_id -> title)
//  - models/models.json   = GLB meshes extracted from the Unity asset bundles
//                           (StreamingAssets/assetbundles/{gates,barriers})
// Classification comes from the catalog: type 'Invisible' -> checkpoint,
// type 'Tools' -> not rendered at all (editor helpers like ControlCurve),
// names containing 'Flag' -> flag, 'Window' -> dive-style gate, else gate.
let CATALOG = { prefabs: {}, scenes: {} };
let MODELS_INDEX = {};
let PREFAB_DIMS = {};   // id -> [minx,miny,minz,maxx,maxy,maxz, "rrggbb"?] per prefab
// fallback when prefabs.json is unavailable
const GATE_KIND_FALLBACK = {
  285: 'gate', 742: 'gate', 286: 'dive',
  170: 'flag', 88: 'checkpoint', 2231: 'checkpoint', 2232: 'checkpoint',
};
// exact material colours pulled from the prefab materials in the bundles —
// the 13 stretchable building blocks are runtime meshes (nothing to extract)
const BLOCK_COLORS = {
  2218: '#0d0d0d',    // BlockBlack
  2219: '#e6e6e6',    // BlockWhite  (0.9, 0.9, 0.9)
  2220: '#e60000',    // BlockRed    (0.9, 0.0, 0.0)
  2221: '#e67300',    // BlockOrange
  2222: '#e6e600',    // BlockYellow
  2223: '#00cc00',    // BlockGreen
  2224: '#00d9d9',    // BlockCyan
  2225: '#0000e6',    // BlockBlue
  2226: '#8c00e6',    // BlockPurple
  2227: '#f280bf',    // BlockPink
  2228: '#e61a66',    // BlockRedPink
  2229: '#0566e6',    // BlockLightBlue (0.02, 0.4, 0.9)
  2230: '#006619',    // BlockDarkGreen
};
// box tint for prefabs that have real dims but no extracted model yet
const TYPE_COLORS = {
  Trees: '#4c8a4f', 'Fast Foliage': '#57945a', Rocks: '#8b8578',
  Terrain: '#8f8266', Cones: '#ff8c1a', Misc: '#9aa0a6',
  Bando: '#9a938a', PolyWorld: '#9aa0a6', Military: '#77855f',
  Construction: '#b3a891', Dungeon: '#8d8377', SciFi: '#c3c8d0',
  Future: '#c3c8d0', Buildings: '#a8a29a', DR1: '#d9d9d9',
  Neon: '#d0d0da', Micro: '#d0d0da', Hologram: '#9fd8e8',
  Decal: '#e0e0dc', Mobile: '#e8e8e4', Combat: '#c9a13f',
  Pipes: '#d94f3f',
};
// colour token at the end of runtime-prefab names (SphereR, NeonStripBlue...)
const NAME_COLOR_RE = /(Black|White|Red|Orange|Yellow|Green|Cyan|Blue|Purple|Pink|[WBRGYPO])$/;
const NAME_COLORS = {
  Black: '#17181c', White: '#f0f0ee', W: '#f0f0ee',
  Red: '#e63c3c', R: '#e63c3c', Orange: '#ff8c1a', O: '#ff8c1a',
  Yellow: '#ffd83d', Y: '#ffd83d', Green: '#33d05e', G: '#33d05e',
  Cyan: '#22d3d3', Blue: '#2a6bff', B: '#2a6bff',
  Purple: '#a04ce6', P: '#a04ce6', Pink: '#f280bf',
};
const GATE_BRAND = { 285: 'multigp', 286: 'multigp', 170: 'multigp' };

function prefabInfo(id) {
  const c = CATALOG.prefabs[id];
  return c ? { name: c[0], type: c[1], isGate: !!c[2] } : null;
}

function classifySeq(g) {
  const info = prefabInfo(g.prefab);
  if (!info) {
    return GATE_KIND_FALLBACK[g.prefab] ??
      (Math.max(...(g.trans.scale ?? [100, 100, 100])) >= 5000 ? 'checkpoint' : 'gate');
  }
  if (info.type === 'Tools') return 'tool';
  if (info.type === 'Invisible') return 'checkpoint';
  if (/flag/i.test(info.name)) return 'flag';
  if (/window/i.test(info.name)) return 'dive';
  return 'gate';
}

// Palette (sampled from the AUFPV / Mission Foods track posters)
const COL = {
  mat: '#42a06d', matDark: '#389161', matBorder: '#0d5c38',
  ground: '#1b6a42', sky: '#dfeee7',
  line: '#b3a13f', lineGround: '#7d7433',
  ghost: '#19e0ff',   // captured human world-record line (telemetry cyan)
  white: '#f5f5f2', red: '#d9251c', yellow: '#f2b21c',
  green: '#128a4d', ink: '#17251d', pole: '#e8e8e4',
  navy: '#1b2559', boundary: '#2e6fd6',
};

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.sky);
scene.fog = new THREE.Fog(COL.sky, 180, 600);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(0, 60, 60);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 2;
controls.maxDistance = 400;

scene.add(new THREE.HemisphereLight('#eafff2', '#3a7a55', 1.9));
const sun = new THREE.DirectionalLight('#fffdf5', 2.4);
sun.position.set(-45, 80, -30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

// Distant ground (outside the mat)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2000),
  new THREE.MeshLambertMaterial({ color: COL.ground })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
ground.receiveShadow = true;
scene.add(ground);

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------
function toVec(pos) {
  return new THREE.Vector3(pos[0] * CM, pos[1] * CM, -pos[2] * CM);
}
function toQuat(rot) {
  // stored (w,x,y,z)*1000 -> three (x,y,z,w), mirrored for left->right handed
  const [w, x, y, z] = rot;
  return new THREE.Quaternion(-x / 1000, -y / 1000, z / 1000, w / 1000).normalize();
}

// ---------------------------------------------------------------------------
// Canvas texture helpers
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plateTex(text, bg, fg, border) {
  return canvasTex(256, 64, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 10); ctx.fill();
    if (border) {
      ctx.strokeStyle = border; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.roundRect(4, 4, w - 8, h - 8, 8); ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.font = 'italic 900 38px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
  });
}

function checkerTex(cols = 10, rows = 2) {
  return canvasTex(cols * 16, rows * 16, (ctx, w, h) => {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#111' : '#fff';
        ctx.fillRect(c * 16, r * 16, 16, 16);
      }
  });
}

// MultiGP-style feather flag cloth: red tip, navy band, white body.
function flagClothTex() {
  return canvasTex(76, 256, (ctx, w, h) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = COL.red; ctx.fillRect(0, 0, w, 34);
    ctx.fillStyle = COL.navy; ctx.fillRect(0, 34, w, 26);
    ctx.save();
    ctx.translate(w / 2 + 8, h / 2 + 44);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = COL.navy;
    ctx.font = 'italic 900 28px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('MULTIGP', 0, 0);
    ctx.restore();
  });
}

function badgeSprite(text, fg = COL.green) {
  const s = 128;
  const tex = canvasTex(s, s, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(s / 2, s / 2, 52, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 8; ctx.strokeStyle = fg;
    ctx.beginPath(); ctx.arc(s / 2, s / 2, 48, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = fg;
    const px = text.length > 6 ? 24 : text.length > 4 ? 30 : text.length > 2 ? 40 : 56;
    ctx.font = `italic 900 ${px}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, s / 2, s / 2 + 4);
  });
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.scale.set(1.1, 1.1, 1);
  return spr;
}

// ---------------------------------------------------------------------------
// Object builders
// ---------------------------------------------------------------------------
// Square frame in the local XY plane; fly-through axis = local +Z (Unity forward).
function frameGeometry(size, bar) {
  const h = size / 2, ih = h - bar;
  const shape = new THREE.Shape();
  shape.moveTo(-h, -h); shape.lineTo(h, -h); shape.lineTo(h, h); shape.lineTo(-h, h);
  const hole = new THREE.Path();
  hole.moveTo(-ih, -ih); hole.lineTo(ih, -ih); hole.lineTo(ih, ih); hole.lineTo(-ih, ih);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: bar, bevelEnabled: false });
  geo.translate(0, 0, -bar / 2);
  return geo;
}

const SHARED = {
  plateMGP: null, plateWLC: null, checkerTexS: null, flagTex: null,
  frameGeo: null,
  whiteMat: null, redMat: null, poleMat: null,
};
function initShared() {
  SHARED.plateMGP = plateTex('MULTIGP', COL.navy, '#ffffff');
  SHARED.plateWLC = plateTex('WLC', '#f5f5f2', COL.red, COL.red);
  SHARED.checkerTexS = checkerTex();
  SHARED.flagTex = flagClothTex();
  SHARED.frameGeo = frameGeometry(GATE_SIZE, GATE_BAR);
  SHARED.whiteMat = new THREE.MeshStandardMaterial({
    color: '#ffffff', roughness: 0.45, metalness: 0.02,
    emissive: '#ffffff', emissiveIntensity: 0.32,
  });
  SHARED.redMat = new THREE.MeshStandardMaterial({
    color: COL.red, roughness: 0.6, emissive: COL.red, emissiveIntensity: 0.25,
  });
  SHARED.poleMat = new THREE.MeshStandardMaterial({
    color: COL.pole, roughness: 0.5, emissive: COL.pole, emissiveIntensity: 0.25,
  });
}

// A Mission race gate: white 2 m frame + branded top plate.
// VelociDrone prefab origins sit at the BASE of the gate, so the frame is
// raised by half its size in local Y (this also holds for tilted dive gates).
// Per-axis prefab scale is applied by the caller on the returned group.
// brand 'multigp': white frame + navy banner (2024-style objects).
// brand 'wlc': white frame + red corner accents + WLC plate (stadium objects).
function buildGate({ isStart = false, isDive = false, brand = 'wlc' } = {}) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = GATE_SIZE / 2;
  g.add(inner);
  const redFrame = isDive && brand === 'wlc';
  const frame = new THREE.Mesh(SHARED.frameGeo, redFrame ? SHARED.redMat : SHARED.whiteMat);
  frame.castShadow = true;
  inner.add(frame);

  // top plate: checker for start/finish, sponsor banner otherwise
  const plateW = GATE_SIZE * 0.62, plateH = 0.28;
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(plateW, plateH),
    new THREE.MeshBasicMaterial({
      map: isStart ? SHARED.checkerTexS
        : (brand === 'multigp' ? SHARED.plateMGP : SHARED.plateWLC),
      side: THREE.DoubleSide,
    })
  );
  plate.position.set(0, GATE_SIZE / 2 + plateH / 2 + 0.02, 0);
  inner.add(plate);

  if (brand === 'wlc' && !redFrame) {
    // red corner accents like the stadium WLC cube gates
    const tip = new THREE.BoxGeometry(0.2, 0.2, GATE_BAR * 1.5);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const m = new THREE.Mesh(tip, SHARED.redMat);
      m.position.set(sx * GATE_SIZE / 2, sy * GATE_SIZE / 2, 0);
      inner.add(m);
    }
  }
  if (redFrame) {
    // yellow tips so the WLC dive gate reads at a glance
    const tip = new THREE.BoxGeometry(0.22, 0.22, GATE_BAR * 1.6);
    const ymat = new THREE.MeshStandardMaterial({ color: COL.yellow, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(tip, ymat);
      m.position.set(sx * GATE_SIZE / 2, GATE_SIZE / 2, 0);
      inner.add(m);
    }
  }
  return g;
}

// A feather flag: pole + printed cloth.
function buildFlag() {
  const g = new THREE.Group();
  const H = 2.9;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, H, 8), SHARED.poleMat);
  pole.position.y = H / 2;
  pole.castShadow = true;
  g.add(pole);

  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 2.1),
    new THREE.MeshBasicMaterial({ map: SHARED.flagTex, side: THREE.DoubleSide })
  );
  cloth.position.set(0.34, H - 1.1, 0);
  cloth.castShadow = true;
  g.add(cloth);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.07, 12),
    SHARED.redMat
  );
  base.position.y = 0.035;
  g.add(base);
  return g;
}

// Invisible checkpoint: faint dashed ring.
function buildCheckpoint() {
  const pts = [];
  const R = 1.5, N = 64;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color: '#ffffff', dashSize: 0.28, gapSize: 0.2, transparent: true, opacity: 0.75,
  }));
  line.computeLineDistances();
  return line;
}

// Crossed checkered flags marker for the start gate (poster style).
function startFlagsSprite() {
  const tex = canvasTex(160, 128, (ctx) => {
    function flag(x0, y0, ang) {
      ctx.save();
      ctx.translate(x0, y0); ctx.rotate(ang);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -70); ctx.stroke();
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 4; c++) {
          ctx.fillStyle = (r + c) % 2 ? '#111' : '#fff';
          ctx.fillRect(c * 12, -70 + r * 12, 12, 12);
        }
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
      ctx.strokeRect(0, -70, 48, 36);
      ctx.restore();
    }
    flag(58, 120, -0.32);
    flag(100, 120, 0.32);
  });
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.scale.set(2.0, 1.6, 1);
  return spr;
}

// Flat yellow arrow on the mat showing travel direction at the start gate.
function buildStartArrow(dir) {
  const shape = new THREE.Shape();
  // arrow pointing +x, ~2.4 m long, centred
  shape.moveTo(-1.2, -0.25); shape.lineTo(0.2, -0.25); shape.lineTo(0.2, -0.55);
  shape.lineTo(1.2, 0); shape.lineTo(0.2, 0.55); shape.lineTo(0.2, 0.25);
  shape.lineTo(-1.2, 0.25); shape.lineTo(-1.2, -0.25);
  const geo = new THREE.ShapeGeometry(shape);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: COL.yellow, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
  }));
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = -Math.atan2(dir.z, dir.x);   // shape +x -> world dir (after x-rot, shape y -> world z)
  return m;
}

// ---------------------------------------------------------------------------
// Grid mat (1 m minor / 5 m major lines, poster style)
// ---------------------------------------------------------------------------
function buildMat(bbox, groundY = 0) {
  const margin = 7;
  const minX = Math.floor((bbox.min.x - margin) / 5) * 5;
  const maxX = Math.ceil((bbox.max.x + margin) / 5) * 5;
  const minZ = Math.floor((bbox.min.z - margin) / 5) * 5;
  const maxZ = Math.ceil((bbox.max.z + margin) / 5) * 5;
  const W = maxX - minX, D = maxZ - minZ;

  // resolution capped by longest edge (4096 px) AND total area (~6 MP)
  const PPM = Math.max(2, Math.min(28, 4096 / Math.max(W, D), Math.sqrt(6e6 / (W * D))));
  const tex = canvasTex(Math.round(W * PPM), Math.round(D * PPM), (ctx, w, h) => {
    ctx.fillStyle = COL.mat; ctx.fillRect(0, 0, w, h);
    // subtle 5 m checker tint
    ctx.fillStyle = 'rgba(0,0,0,0.045)';
    for (let gx = 0; gx < W / 5; gx++)
      for (let gz = 0; gz < D / 5; gz++)
        if ((gx + gz) % 2) ctx.fillRect(gx * 5 * PPM, gz * 5 * PPM, 5 * PPM, 5 * PPM);
    // minor 1 m lines
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x++) {
      ctx.beginPath(); ctx.moveTo(x * PPM, 0); ctx.lineTo(x * PPM, h); ctx.stroke();
    }
    for (let z = 0; z <= D; z++) {
      ctx.beginPath(); ctx.moveTo(0, z * PPM); ctx.lineTo(w, z * PPM); ctx.stroke();
    }
    // major 5 m lines
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
    for (let x = 0; x <= W; x += 5) {
      ctx.beginPath(); ctx.moveTo(x * PPM, 0); ctx.lineTo(x * PPM, h); ctx.stroke();
    }
    for (let z = 0; z <= D; z += 5) {
      ctx.beginPath(); ctx.moveTo(0, z * PPM); ctx.lineTo(w, z * PPM); ctx.stroke();
    }
    // dark border band
    ctx.strokeStyle = COL.matBorder; ctx.lineWidth = PPM * 0.9;
    ctx.strokeRect(0, 0, w, h);
  });

  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshLambertMaterial({ map: tex })
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set((minX + maxX) / 2, groundY, (minZ + maxZ) / 2);
  mat.receiveShadow = true;
  return mat;
}

// ---------------------------------------------------------------------------
// Track group state
// ---------------------------------------------------------------------------
let trackGroup = new THREE.Group();
scene.add(trackGroup);
let groups = {};
let flyPath = null;
let flyProfile = null;   // {t, s, T, S} time->distance profile from the optimiser
let estLapTime = null;   // estimated race-pace lap (s), for the info panel
let flyActive = false;
// human lines (VelociDrone leaderboard ghosts / imported .ghost files). Several
// can be shown at once (WR + your line + others) for comparison.
let humanLines = [];     // [{ id, kind, pilot, lapTime, isWr, color, curve, profile, group }]
let ghostPath = null;    // replay curve (the WR / primary line) for the ▶ WR lap
let ghostProfile = null; // {t, s, T, S} true-timing replay profile of ghostPath
let ghostMeta = null;    // { pilot, lap_time } of the primary line, for the info panel
let ghostActive = false;
let ghostT = 0;
let lineSeq = 0;
let raceLineMode = 'generated';   // 'generated' | 'avgwr' — source of the khaki racing line
let flyT = 0;
let flyDuration = 30;
let bounds = new THREE.Box3();
let seqSelectables = [];   // sequence objects in order, for inspector prev/next

// ---------------------------------------------------------------------------
// Inspector debug info
// ---------------------------------------------------------------------------
function quatAngles(rot) {
  const q = toQuat(rot);
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);   // fly-through axis
  const yaw = Math.atan2(f.x, f.z) * 180 / Math.PI;
  const pitch = Math.asin(THREE.MathUtils.clamp(-f.y, -1, 1)) * 180 / Math.PI;
  return { yaw, pitch };
}

function makeSeqDebug(g, kind, i) {
  const { yaw, pitch } = quatAngles(g.trans.rot);
  const info = prefabInfo(g.prefab);
  return {
    group: 'sequence', seqIndex: i, vd: g.gate + 1, kind,
    prefab: g.prefab, prefabName: info?.name, prefabType: info?.type,
    hasModel: !!MODELS_INDEX[g.prefab],
    raw: g.trans, start: g.start, finish: g.finish, lap1only: g.lap1only,
    world: toVec(g.trans.pos), yaw, pitch,
  };
}

function makeBarrierDebug(b, bi, label) {
  const { yaw, pitch } = quatAngles(b.trans.rot);
  const info = prefabInfo(b.prefab);
  return {
    group: 'barrier', barrierIndex: bi, kind: label,
    prefab: b.prefab, prefabName: info?.name, prefabType: info?.type,
    hasModel: !!MODELS_INDEX[b.prefab],
    raw: b.trans, world: toVec(b.trans.pos), yaw, pitch,
  };
}

// GLB templates extracted from the game's asset bundles, cached per prefab id
const gltfLoader = new GLTFLoader();
const modelTemplates = new Map();
async function preloadModels(prefabIds) {
  const wanted = [...new Set(prefabIds)]
    .filter(id => MODELS_INDEX[id] && !modelTemplates.has(id));
  await Promise.all(wanted.map(async id => {
    try {
      const gltf = await gltfLoader.loadAsync(MODELS_INDEX[id].file);
      gltf.scene.traverse(o => {
        if (o.isMesh) {
          o.castShadow = true;
          o.material.side = THREE.DoubleSide;
          o.material.metalness = 0;          // exporter defaults to metallic=1 → black
          o.material.roughness = 0.75;
          if (o.material.map) {
            o.material.map.colorSpace = THREE.SRGBColorSpace;
            o.material.alphaTest = 0.5;      // cutout for flag cloth edges
          }
          if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
          o.userData.shared = true;   // geometry/materials live in the cache
        }
      });
      modelTemplates.set(id, gltf.scene);
    } catch (e) {
      console.warn('model load failed for prefab', id, e);
    }
  }));
}
function modelInstance(id) {
  const tpl = modelTemplates.get(id);
  return tpl ? tpl.clone() : null;
}

function disposeGroup(g) {
  g.traverse(o => {
    if (o.isInstancedMesh) o.dispose();   // frees the per-instance buffers only
    if (o.userData.shared) return;   // cached model resources — never dispose
    // sprites share one module-level geometry inside three.js — never dispose it
    if (o.geometry && !o.isSprite && o.geometry !== SHARED.frameGeo) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => {
        if (Object.values(SHARED).includes(m)) return;
        if (m.map && ![SHARED.plateMGP, SHARED.plateWLC, SHARED.checkerTexS, SHARED.flagTex].includes(m.map)) m.map.dispose();
        m.dispose();
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Shared build steps (used by the VelociDrone and MRSIM builders)
// ---------------------------------------------------------------------------
function resetTrack() {
  hideInspector();
  scene.remove(trackGroup);
  disposeGroup(trackGroup);
  trackGroup = new THREE.Group();
  scene.add(trackGroup);
  groups = {
    gates: new THREE.Group(), flags: new THREE.Group(), numbers: new THREE.Group(),
    line: new THREE.Group(), barriers: new THREE.Group(), checkpoints: new THREE.Group(),
    ghost: new THREE.Group(), deco: new THREE.Group(),
  };
  Object.values(groups).forEach(g => trackGroup.add(g));
}

// Fallback line when the optimiser can't run: fixed centre crossings with
// entry/exit helper points along each through axis (the pre-TOGT behaviour).
// Helper distance adapts to neighbour spacing (cube faces sit only 2 m apart;
// open-field gates get the full 2.4 m approach).
function crossingTriples(crossings, closed = true) {
  const pts = [];
  const n = crossings.length;
  crossings.forEach((c, i) => {
    const dPrev = (i > 0 || closed)
      ? c.center.distanceTo(crossings[(i - 1 + n) % n].center) : Infinity;
    const dNext = (i < n - 1 || closed)
      ? c.center.distanceTo(crossings[(i + 1) % n].center) : Infinity;
    pts.push(
      c.center.clone().addScaledVector(c.through, -Math.min(2.4, Math.max(0.4, 0.45 * dPrev))),
      c.center.clone(),
      c.center.clone().addScaledVector(c.through, Math.min(2.4, Math.max(0.4, 0.45 * dNext))),
    );
  });
  return pts;
}

// Racing-line tube + flat ground trace + start arrow from ordered path points.
// `pathPts` is either the dense optimised line (TOGT-inspired, see raceline.js)
// or the entry/centre/exit-triple fallback. Also sets up the fly-lap path;
// `profile` (nodeTimes/lapTime from the optimiser) paces the fly-lap so it
// slows into corners and sprints the straights.
function addRacingLine(pathPts, groundY, closed = true, profile = null) {
  // clear any previous racing line (so the source can be swapped generated<->WR)
  while (groups.line.children.length) {
    const c = groups.line.children[0];
    groups.line.remove(c);
    c.geometry?.dispose?.(); c.material?.dispose?.();
  }
  pathPts.forEach(p => { p.y = Math.max(p.y, groundY + 0.35); });   // never dip underground
  if (pathPts.length < 3) { flyPath = null; flyProfile = null; estLapTime = null; return; }
  // centripetal parameterisation: no overshoot, follows the optimised nodes
  // (or the collinear fallback triples) without ringing
  const curve = new THREE.CatmullRomCurve3(pathPts, closed, 'centripetal');
  flyPath = curve;
  flyDuration = Math.max(14, curve.getLength() / 16);  // ~16 m/s tour pace
  estLapTime = profile?.lapTime ?? null;
  flyProfile = null;
  if (profile) {
    // cumulative chord length at each node, matched to the node time stamps
    const s = [0];
    const n = pathPts.length;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++)
      s.push(s[i] + pathPts[i].distanceTo(pathPts[(i + 1) % n]));
    if (profile.nodeTimes.length === s.length && profile.lapTime > 0)
      flyProfile = { t: profile.nodeTimes, s, T: profile.lapTime, S: s[segs] };
  }
  const div = Math.max(400, pathPts.length * 24);
  const tubeGeo = new THREE.TubeGeometry(curve, div, 0.055, 8, closed);
  const tube = new THREE.Mesh(tubeGeo, new THREE.MeshStandardMaterial({
    color: COL.line, roughness: 0.7, metalness: 0,
  }));
  groups.line.add(tube);

  // flat projection on the mat, yellow-dashed like the VelociDrone editor
  const flat = curve.getPoints(div).map(p => new THREE.Vector3(p.x, groundY + 0.02, p.z));
  const flatGeo = new THREE.BufferGeometry().setFromPoints(flat);
  const flatLine = new THREE.Line(flatGeo, new THREE.LineDashedMaterial({
    color: '#ffd83d', dashSize: 0.55, gapSize: 0.4, transparent: true, opacity: 0.95,
  }));
  flatLine.computeLineDistances();
  groups.line.add(flatLine);

  // start arrow on the mat (kept in groups.line so it clears with the line)
  const p0 = pathPts[0];
  const dir = curve.getTangentAt(0); dir.y = 0; dir.normalize();
  const arrow = buildStartArrow(dir);
  arrow.position.set(p0.x + dir.x * 2.2, groundY + 0.03, p0.z + dir.z * 2.2);
  groups.line.add(arrow);
}

// Remember the generated line so the racing-line source can be toggled between
// the optimiser and an averaged human WR lap without a full track rebuild.
let generatedRL = null;   // { pathPts, closed, profile }
let currentGroundY = 0;
function setGeneratedRaceLine(pathPts, groundY, closed, profile) {
  generatedRL = { pathPts, closed, profile };
  currentGroundY = groundY;
  applyRaceLineMode();
}
// Draw the racing line from whichever source is selected: the optimiser, or
// the average of the WR pilot's laps (a real human line, smoother than the
// generator). Falls back to the generated line when no WR is loaded.
function applyRaceLineMode() {
  if (!generatedRL) return;
  const w = wrLine();
  if (raceLineMode === 'avgwr' && w) {
    const avg = averageLaps(w.frames, currentWrLaps, 400);
    const pts = avg.map(f => new THREE.Vector3(f.p[0], f.p[1], -f.p[2]));
    addRacingLine(pts, currentGroundY, true,
      { nodeTimes: avg.map(f => f.t), lapTime: avg[avg.length - 1].t });
  } else {
    addRacingLine(generatedRL.pathPts.map(p => p.clone()), currentGroundY,
      generatedRL.closed, generatedRL.profile);
  }
}

// A captured human lap (VelociDrone leaderboard ghost, decoded by
// ghost_decode.py). `ghost.frames` are { t: seconds-from-start, p: [x,y,z] }
// in the same Unity metre space as the track, so the mapping matches the
// track's (x, y, -z). Draws it as a distinct tube + start marker + label, and
// sets up true-timing replay (the frame timestamps pace the "WR lap" flight).
// palette for non-WR human lines (WR is always COL.ghost cyan)
const LINE_PALETTE = ['#ff4fa3', '#ffa41c', '#7cff5a', '#c07bff', '#ff6b57', '#4bd6ff'];
function pickColor(spec) {
  if (spec.isWr) return COL.ghost;
  if (spec.kind === 'avg') return '#ffe14d';
  return LINE_PALETTE[humanLines.filter(l => !l.isWr && l.kind !== 'avg').length % LINE_PALETTE.length];
}

// Add one human line. spec = { kind, pilot, lapTime, frames, isWr, color?, tag? }.
// Draws it in its own subgroup (tube + start dot + label) so it can be removed
// individually, and stores a true-timing replay profile.
function addLine(spec) {
  const pts = spec.frames.map(f => new THREE.Vector3(f.p[0], f.p[1], -f.p[2]));
  if (pts.length < 3) return null;
  const color = spec.color || pickColor(spec);
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(400, pts.length * 4), spec.isWr ? 0.05 : 0.045, 8, false),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0, emissive: color, emissiveIntensity: 0.35 })));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
  dot.position.copy(pts[0]); group.add(dot);
  const tag = spec.tag || (spec.isWr ? 'WR' : spec.kind === 'avg' ? 'avg' : '');
  const label = badgeSprite(`${spec.pilot} · ${spec.lapTime ? spec.lapTime.toFixed(2) + 's' : ''} ${tag}`.trim(), '#0b3d46');
  label.position.copy(pts[0]).add(new THREE.Vector3(0, 2.4, 0));
  group.add(label);
  groups.ghost.add(group);

  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const T = spec.frames[spec.frames.length - 1].t || 1;
  const line = { id: ++lineSeq, kind: spec.kind, pilot: spec.pilot, lapTime: spec.lapTime,
    isWr: !!spec.isWr, color, curve, group, frames: spec.frames,
    profile: { t: spec.frames.map(f => f.t), s, T, S: s[s.length - 1] } };
  humanLines.push(line);
  syncPrimaryLine();
  return line;
}

// the primary line (WR if present, else first) drives the replay + info panel
function wrLine() { return humanLines.find(l => l.isWr) || humanLines[0] || null; }
function syncPrimaryLine() {
  const w = wrLine();
  ghostPath = w?.curve || null;
  ghostProfile = w?.profile || null;
  ghostMeta = w ? { pilot: w.pilot, lap_time: w.lapTime } : null;
}

function removeLine(line) {
  const i = humanLines.indexOf(line);
  if (i < 0) return;
  humanLines.splice(i, 1);
  groups.ghost.remove(line.group);
  line.group.traverse(o => { o.geometry?.dispose?.(); if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); } });
  syncPrimaryLine();
  refreshLinesUI();
}

function clearGhost() {
  humanLines.slice().forEach(l => { groups.ghost.remove(l.group);
    l.group.traverse(o => { o.geometry?.dispose?.(); if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); } }); });
  humanLines = [];
  stopGhost();
  syncPrimaryLine();
}

// mean nearest distance (m) of a line to the WR line, and its time delta
function lineVsWr(line) {
  const w = wrLine();
  if (!w || w === line) return null;
  const G = w.curve.getPoints(2000);
  let sum = 0; const N = 200;
  for (let i = 0; i < N; i++) {
    const p = line.curve.getPointAt(i / N);
    let best = Infinity;
    for (const q of G) { const d = p.distanceToSquared(q); if (d < best) best = d; }
    sum += Math.sqrt(best);
  }
  return { dist: sum / N, dt: (line.lapTime || 0) - (w.lapTime || 0) };
}

// Load the human line bundled for a track, if one exists (ghosts/<slug>-wr.json).
async function loadGhost(trackName) {
  clearGhost();
  try {
    if (!trackName) return;
    const slug = trackName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const res = await fetch(`ghosts/${slug}-wr.json`);
    if (!res.ok) return;
    const g = await res.json();
    addLine({ kind: 'wr', pilot: g.pilot, lapTime: Number(g.lap_time), frames: g.frames, isWr: true });
    if (g.laps > 1) currentWrLaps = g.laps;   // remember lap count for averaging
  } catch { /* no ghost for this track — fine */ }
  finally { applyRaceLineMode(); updateGhostUI(); refreshLinesUI(); }
}
let currentWrLaps = 3;

function updateGhostUI() {
  const has = humanLines.length > 0;
  document.getElementById('rowGhost').style.display = has ? '' : 'none';
  document.getElementById('legGhost').style.display = has ? '' : 'none';
  btnGhost.style.display = has ? '' : 'none';
  const online = resolveOnlineTrack(currentTrack?.meta);
  document.getElementById('linesTools').style.display = (online || has) ? '' : 'none';
  document.getElementById('rowLineSrc').style.display = wrLine() ? '' : 'none';
  applyLayerVisibility();
}

// Online leaderboard identity for a track, if we know it: user tracks carry it
// via WR_TRACKS (by name), catalogue tracks via meta.onlineId set on download.
// protectedValue 1 = official track, 2 = user/community track; raceMode 6 = 3-lap.
const WR_TRACKS = {
  '2024 AU NATS Quali': { trackId: 22834, protectedValue: 2, raceMode: 6 },
};
function resolveOnlineTrack(meta) {
  if (!meta) return null;
  if (meta.onlineId) {
    return { trackId: meta.onlineId, protectedValue: meta.protectedValue ?? 1,
             raceMode: meta.raceMode ?? 6 };
  }
  return WR_TRACKS[meta.name] ? { ...WR_TRACKS[meta.name] } : null;
}

// Grid mat under the course, ground level, camera-framing bounds, sun shadows.
function finishBuild(courseBox, matBox, groundY) {
  const mat = buildMat(matBox, groundY);
  groups.deco.add(mat);
  ground.position.y = groundY - 0.05;

  bounds = courseBox.clone();
  sun.target.position.copy(bounds.getCenter(new THREE.Vector3()));
  const span = Math.max(bounds.getSize(new THREE.Vector3()).x, bounds.getSize(new THREE.Vector3()).z);
  const sc = span / 2 + 15;
  sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
  sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.updateProjectionMatrix();

  applyLayerVisibility();
}

// ---------------------------------------------------------------------------
// Build a track from parsed JSON
// ---------------------------------------------------------------------------
function buildTrack(data) {
  resetTrack();

  const seq = [...data.gates].sort((a, b) => a.gate - b.gate);
  const kinds = seq.map(classifySeq);

  // scene ground level = lowest object base (the 2026 scene sits at y=-0.86 m)
  const groundY = seq.length
    ? Math.min(0, ...seq.map(g => g.trans.pos[1] * CM))
    : 0;

  const counts = { gate: 0, dive: 0, flag: 0, checkpoint: 0, tool: 0 };
  seqSelectables = [];

  seq.forEach((g, i) => {
    const kind = kinds[i];
    counts[kind]++;
    if (kind === 'tool') return;    // editor helpers (splines etc.) — not rendered
    const pos = toVec(g.trans.pos);
    const quat = toQuat(g.trans.rot);
    const isStart = g.start || g.finish;
    const debug = makeSeqDebug(g, kind, i);

    if (kind === 'checkpoint') {
      const cp = buildCheckpoint();
      cp.position.copy(pos); cp.quaternion.copy(quat);
      cp.userData.debug = debug;
      groups.checkpoints.add(cp);
      // grey badge, only visible with the checkpoint layer
      const cspr = badgeSprite(String(g.gate + 1), '#7d8794');
      cspr.position.set(pos.x, pos.y + 2.2, pos.z);
      groups.checkpoints.add(cspr);
      seqSelectables.push(cp);
      return;
    }

    const sc = g.trans.scale ?? [100, 100, 100];
    const model = modelInstance(g.prefab);
    let obj, labelY;
    if (model) {
      // the real in-game mesh, extracted from the asset bundles
      obj = model;
      obj.position.copy(pos); obj.quaternion.copy(quat);
      obj.scale.set(sc[0] / 100, sc[1] / 100, sc[2] / 100);
      labelY = (MODELS_INDEX[g.prefab]?.max?.[1] ?? GATE_SIZE) * sc[1] / 100 + 0.5;
      (kind === 'flag' ? groups.flags : groups.gates).add(obj);
    } else if (kind === 'flag') {
      obj = buildFlag();
      // flags sit on the ground; the stored position is the base
      obj.position.copy(pos); obj.quaternion.copy(quat);
      obj.scale.set(sc[0] / 100, sc[1] / 100, sc[2] / 100);
      labelY = 2.9 * sc[1] / 100 + 0.6;
      groups.flags.add(obj);
    } else {
      obj = buildGate({
        isStart, isDive: kind === 'dive',
        brand: GATE_BRAND[g.prefab] ?? 'wlc',
      });
      obj.position.copy(pos); obj.quaternion.copy(quat);
      obj.scale.set(sc[0] / 100, sc[1] / 100, sc[2] / 100);
      labelY = GATE_SIZE * sc[1] / 100 + 0.7;
      groups.gates.add(obj);
    }
    obj.userData.debug = debug;
    seqSelectables.push(obj);

    // dive-style gates (tilted + elevated) stand on legs from all 4 frame
    // corners down to the ground, like VelociDrone builds them
    if (kind !== 'flag') {
      const through = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
      if (pos.y > groundY + 0.3 && Math.abs(through.y) > 0.5) {
        const bb = MODELS_INDEX[g.prefab];
        const xs = bb ? [bb.min[0], bb.max[0]] : [-GATE_SIZE / 2, GATE_SIZE / 2];
        const ys = bb ? [bb.min[1], bb.max[1]] : [0, GATE_SIZE];
        for (const cx of xs) for (const cy of ys) {
          const corner = new THREE.Vector3(cx * sc[0] / 100, cy * sc[1] / 100, 0)
            .applyQuaternion(quat).add(pos);
          const h = corner.y - groundY;
          if (h > 0.3) {
            const leg = new THREE.Mesh(
              new THREE.CylinderGeometry(0.035, 0.035, h, 8), SHARED.poleMat);
            leg.position.set(corner.x, groundY + h / 2, corner.z);
            leg.castShadow = true;
            leg.userData.debug = debug;   // clicking a leg selects its gate
            groups.gates.add(leg);
          }
        }
      }
    }
    if (isStart) {
      // checkered marker plate on the start gate, whatever its model
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 0.26),
        new THREE.MeshBasicMaterial({ map: SHARED.checkerTexS, side: THREE.DoubleSide }));
      plate.position.copy(pos).y += labelY - 0.25;
      plate.quaternion.copy(quat);
      groups.deco.add(plate);
    }

    // sequence badge numbered like VelociDrone (1-based over the full sequence)
    const spr = badgeSprite(isStart ? 'S/F' : String(g.gate + 1), isStart ? COL.red : COL.green);
    spr.position.set(pos.x, pos.y + labelY, pos.z);
    groups.numbers.add(spr);

    if (isStart) {
      const flags = startFlagsSprite();
      flags.position.set(pos.x, pos.y + labelY + 1.6, pos.z);
      groups.deco.add(flags);
    }
  });

  // ---- Racing line through the full sequence (checkpoints shape it too) ----
  // Dedup on RAW positions (a checkpoint often sits 2 cm from a flag).
  // Every element's stored +Z axis IS its crossing direction in VelociDrone
  // (verified against the official posters: this is what produces the split-S
  // loops and hook turns the editor draws). Each element becomes a *crossing
  // region* — centre, in-plane axes and usable aperture extents — and the
  // TOGT-inspired optimiser picks the fastest point inside each of them
  // (see raceline.js). Fallback: fixed centre crossings.
  const FRAME_MARGIN = 0.5;   // frame bars + drone clearance inside the bbox
  const crossings = [];
  let last = null;
  seq.forEach((g, i) => {
    const kind = kinds[i];
    if (kind === 'tool') return;
    const raw = toVec(g.trans.pos);
    const q = toQuat(g.trans.rot);
    const through = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    // skip only true duplicates (same spot, same crossing direction)
    if (last && raw.distanceTo(last.raw) < 0.1 && through.dot(last.through) > 0.95) return;
    last = { raw, through };
    const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const sx = (g.trans.scale?.[0] ?? 100) / 100;
    const sy = (g.trans.scale?.[1] ?? 100) / 100;
    let center, halfW, halfH;
    if (kind === 'flag') {
      // pass the flag pole ~0.6–2.6 m up, close beside it
      center = raw.clone().addScaledVector(axisY, 1.6);
      halfW = 0.35; halfH = 1.0;
    } else if (kind === 'checkpoint') {
      if (sy <= 3) {
        center = raw.clone().add(new THREE.Vector3(0, GATE_SIZE * sy / 2, 0).applyQuaternion(q));
        halfW = halfH = Math.max(0.15, Math.min(0.6, 0.35 * sy));
      } else {
        center = raw.clone().add(new THREE.Vector3(0, 1.0, 0));    // helper poles: ~pole height
        halfW = halfH = 0.4;
      }
    } else {
      // aperture from the real model bounds when we have them
      const bb = MODELS_INDEX[g.prefab];
      const cx = bb ? (bb.min[0] + bb.max[0]) / 2 : 0;
      const cy = bb ? (bb.min[1] + bb.max[1]) / 2 : GATE_SIZE / 2;
      center = raw.clone().add(new THREE.Vector3(cx * sx, cy * sy, 0).applyQuaternion(q));
      halfW = Math.max(0.1, (bb ? (bb.max[0] - bb.min[0]) / 2 : GATE_SIZE / 2) * sx - FRAME_MARGIN);
      halfH = Math.max(0.1, (bb ? (bb.max[1] - bb.min[1]) / 2 : GATE_SIZE / 2) * sy - FRAME_MARGIN);
    }
    crossings.push({ center, through, axisX, axisY, halfW, halfH });
  });
  const rl = computeRaceline(crossings, { closed: true, groundY });
  setGeneratedRaceLine(rl ? rl.points : crossingTriples(crossings), groundY, true, rl || null);

  // ---- Barriers / scenery (colours matched to the VelociDrone editor) ----
  const netMat = new THREE.MeshStandardMaterial({
    color: '#ffffff', transparent: true, opacity: 0.14,
    side: THREE.DoubleSide, depthWrite: false, roughness: 1,
  });
  const boundaryMat = new THREE.MeshStandardMaterial({
    color: COL.boundary, roughness: 0.7, emissive: COL.boundary, emissiveIntensity: 0.25,
  });
  const bannerMat = new THREE.MeshStandardMaterial({
    color: '#f4f4f0', roughness: 0.8, emissive: '#f4f4f0', emissiveIntensity: 0.2,
  });
  const blackPoleMat = new THREE.MeshStandardMaterial({ color: '#17181c', roughness: 0.6 });
  const navyMat = new THREE.MeshStandardMaterial({ color: COL.navy, roughness: 0.8 });
  const propMat = new THREE.MeshStandardMaterial({ color: '#79a98b', roughness: 0.9 });
  const netBlackMat = new THREE.MeshStandardMaterial({
    color: '#151515', transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, roughness: 0.9,
  });
  const unit = new THREE.BoxGeometry(1, 1, 1);

  const padMat = new THREE.MeshStandardMaterial({ color: '#22315e', roughness: 0.9 });
  // classify each barrier into a material bucket, then draw one InstancedMesh
  // per bucket (the 2026 track has 298 barriers — individual meshes crawl)
  const MAT_NAME = new Map([
    [padMat, 'launch pad'], [boundaryMat, 'boundary'], [navyMat, 'navy banner'],
    [netMat, 'net / backdrop'], [bannerMat, 'panel banner'],
    [blackPoleMat, 'pole'], [propMat, 'prop'],
  ]);
  const blockMats = new Map();   // per-prefab exact-colour block materials
  const tintMats = new Map();    // colour+glow -> shared tinted material
  const tintMat = (hex, name, emissive = 0.15) => {
    const key = `${hex}|${emissive}`;
    if (!tintMats.has(key)) {
      const mat = new THREE.MeshStandardMaterial({
        color: hex, roughness: 0.8, emissive: hex, emissiveIntensity: emissive,
      });
      MAT_NAME.set(mat, name);
      tintMats.set(key, mat);
    }
    return tintMats.get(key);
  };

  // model-backed scenery draws instanced per prefab (one official track can
  // place 6000+ marker cones — clones would mean 6000 draw calls)
  const modelled = new Map();    // prefab id -> [{b, bi}]
  const rest = [];
  (data.barriers || []).forEach((b, bi) => {
    const type = prefabInfo(b.prefab)?.type;
    if (type === 'Tools' || type === 'Effects') return;  // splines / fog + smoke
    if (modelTemplates.has(b.prefab)) {
      if (!modelled.has(b.prefab)) modelled.set(b.prefab, []);
      modelled.get(b.prefab).push({ b, bi });
    } else rest.push({ b, bi });
  });

  const instMatrix = (b, extra) => {
    const m = new THREE.Matrix4().compose(
      toVec(b.trans.pos), toQuat(b.trans.rot),
      new THREE.Vector3(b.trans.scale[0] / 100, b.trans.scale[1] / 100, b.trans.scale[2] / 100));
    return extra ? m.multiply(extra) : m;
  };
  modelled.forEach((list, prefab) => {
    const label = prefabInfo(prefab)?.name ?? 'model';
    if (list.length < 4) {
      // few instances: plain clones keep the inspector's highlight simple
      list.forEach(({ b, bi }) => {
        const model = modelInstance(prefab);
        model.position.copy(toVec(b.trans.pos));
        model.quaternion.copy(toQuat(b.trans.rot));
        model.scale.set(b.trans.scale[0] / 100, b.trans.scale[1] / 100, b.trans.scale[2] / 100);
        model.userData.debug = makeBarrierDebug(b, bi, label);
        groups.barriers.add(model);
      });
      return;
    }
    const tpl = modelTemplates.get(prefab);
    tpl.updateMatrixWorld(true);
    const instanceData = list.map(({ b, bi }) => makeBarrierDebug(b, bi, label));
    tpl.traverse(o => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
      im.userData.instanceData = instanceData;
      im.userData.shared = true;   // geometry/material live in the template cache
      list.forEach(({ b }, i) => im.setMatrixAt(i, instMatrix(b, o.matrixWorld)));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      groups.barriers.add(im);
    });
  });

  const buckets = new Map();     // "shape|material" -> instanced-draw batch
  rest.forEach(({ b, bi }) => {
    const info = prefabInfo(b.prefab);
    const label = info?.name;
    let dims = b.trans.scale.map(s => Math.max(0.04, s / 100));
    let centre = null;           // local offset of the box centre
    let m, shape = 'box';
    const dd = BLOCK_COLORS[b.prefab] ? null : PREFAB_DIMS[b.prefab];
    if (BLOCK_COLORS[b.prefab]) {
      // VelociDrone's stretchable blocks: unit cubes with the exact game colour
      if (!blockMats.has(b.prefab)) {
        blockMats.set(b.prefab, new THREE.MeshStandardMaterial({
          color: BLOCK_COLORS[b.prefab], roughness: 0.8,
          emissive: BLOCK_COLORS[b.prefab], emissiveIntensity: 0.15,
        }));
        MAT_NAME.set(blockMats.get(b.prefab), label ?? 'block');
      }
      m = blockMats.get(b.prefab);
    } else if (dd) {
      // no extracted model, but the real prefab bounds are in the dims
      // catalogue -> draw a right-sized box tinted by category / material
      const sc = b.trans.scale.map(s => s / 100);
      dims = [
        Math.max(0.04, (dd[3] - dd[0]) * sc[0]),
        Math.max(0.04, (dd[4] - dd[1]) * sc[1]),
        Math.max(0.04, (dd[5] - dd[2]) * sc[2]),
      ];
      centre = new THREE.Vector3(
        (dd[0] + dd[3]) / 2 * sc[0],
        (dd[1] + dd[4]) / 2 * sc[1],
        (dd[2] + dd[5]) / 2 * sc[2]);
      m = tintMat(dd[6] ? `#${dd[6]}` : TYPE_COLORS[info?.type] ?? '#9aa0a6',
        label ?? 'scenery', 0.12);
    } else {
      // runtime-generated meshes (nothing in the bundles to extract):
      // nets, goals, neon strips/spheres, ground slabs, stretch walls
      const hex = NAME_COLORS[label?.match(NAME_COLOR_RE)?.[1]];
      const maxDim = Math.max(...dims), minDim = Math.min(...dims);
      if (label && /sphere/i.test(label)) {
        shape = 'sphere';
        m = tintMat(hex ?? '#f0f0ee', label, 0.5);
      }
      else if (label && /neon|holo/i.test(label)) m = tintMat(hex ?? '#d0d0da', label, 0.6);
      else if (label && /net/i.test(label)) {
        m = /black/i.test(label) ? netBlackMat : netMat;    // translucent netting
      }
      else if (label && /goal|barrier/i.test(label)) m = bannerMat;  // white panels
      else if (label && /asphalt/i.test(label)) m = tintMat('#3c3f44', label, 0);
      else if (label && /gravel/i.test(label)) m = tintMat('#a29a8c', label, 0);
      else if (label && /concrete|slab|wall/i.test(label)) m = tintMat('#b8b4ac', label, 0.05);
      else if (label && /line|ribbon/i.test(label)) m = tintMat(hex ?? '#f0f0ee', label, 0.2);
      else if (hex) m = tintMat(hex, label, 0.3);           // colour-named prop
      else if (maxDim > 12) m = netMat;                     // giant nets / backdrops
      else if (minDim <= 0.12 && maxDim >= 1.6) m = bannerMat;  // white panel banners
      else if (minDim <= 0.3 && maxDim >= 1.6) m = blackPoleMat; // poles / crossbars
      else m = propMat;                                     // generic props
    }
    const q = toQuat(b.trans.rot);
    // prefab origins are at the base: without real bounds, shift up half height
    const p = toVec(b.trans.pos)
      .add((centre ?? new THREE.Vector3(0, dims[1] / 2, 0)).applyQuaternion(q));
    const key = `${shape}|${m.uuid}`;
    if (!buckets.has(key)) buckets.set(key, { shape, m, list: [] });
    buckets.get(key).list.push({ p, q, dims, b, bi, label });
  });
  const M = new THREE.Matrix4();
  const S = new THREE.Vector3();
  buckets.forEach(({ shape, m, list }) => {
    const geo = shape === 'sphere' ? new THREE.SphereGeometry(0.5, 16, 12) : unit;
    const im = new THREE.InstancedMesh(geo, m, list.length);
    im.userData.instanceData = list.map(e => makeBarrierDebug(e.b, e.bi, e.label ?? MAT_NAME.get(m)));
    list.forEach((e, i) => {
      im.setMatrixAt(i, M.compose(e.p, e.q, S.set(e.dims[0], e.dims[1], e.dims[2])));
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = m !== netMat && m !== netBlackMat;
    groups.barriers.add(im);
  });

  // ---- Mat + camera framing bounds ----
  const courseBox = new THREE.Box3();
  seq.forEach(g => courseBox.expandByPoint(toVec(g.trans.pos)));
  // mat should also sit under scenery props and long block runs
  // (but not under giant nets/backdrops or editor tools)
  const matBox = courseBox.clone();
  (data.barriers || []).forEach(b => {
    if (prefabInfo(b.prefab)?.type === 'Tools') return;
    if (Math.max(...b.trans.scale) / 100 > 12 && !BLOCK_COLORS[b.prefab]) return;
    matBox.expandByPoint(toVec(b.trans.pos));
  });
  counts.scenery = (data.barriers || [])
    .filter(b => !['Tools', 'Effects'].includes(prefabInfo(b.prefab)?.type)).length;
  finishBuild(courseBox, matBox, groundY);
  return counts;
}

// ---------------------------------------------------------------------------
// Build an MRSIM track (parsed XML scene graph from mrsim.js)
// ---------------------------------------------------------------------------
// Elements arrive as collision primitives in world space (thin boxes = gate
// fabric, cylinders = PVC pipes / padded poles), so rendering is one
// InstancedMesh per material bucket + a few textured plates and flag cloths.
const MRSIM_LAYER = {
  gate: 'gates', dive: 'gates', cube: 'gates', pole: 'gates',
  flag: 'flags', pass: 'checkpoints', deco: 'barriers',
};
const MRSIM_KIND_LABEL = {
  gate: 'gate', dive: 'dive gate', cube: 'pipe cube', pole: 'pole',
  flag: 'flag', pass: 'passage', deco: 'scenery',
};

// [2,3,4,5,9] -> "2-5·9" (badge text for elements passed several times)
function compressRuns(nums) {
  const out = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return out.join('·');
}

function buildTrackMrsim(data) {
  resetTrack();
  const groundY = 0;                    // mrsim tracks sit on z=0 ground

  const mkMat = (color, emissive = 0.25, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.6, emissive: color, emissiveIntensity: emissive, ...extra,
  });
  // colours from the game's DroneTrackMaterials.xml, brightened poster-style
  const MATS = {
    pvc: mkMat('#f2f2ee'),              // structural PVC pipe
    pad: mkMat('#f5f5f2'),              // pole-gate foam padding
    tapeBlue: mkMat('#1b49c8', 0.3),
    tapeRed: mkMat(COL.red, 0.3),
    dark: mkMat('#23242a', 0),          // inner pipes, stands, canopy legs
    stalk: mkMat('#8b9094', 0.1),       // flag ground stalk
    sleeve: mkMat('#f5f5f2'),           // flag pole sleeve
    panelSide: mkMat('#eeeeea', 0.22, { side: THREE.DoubleSide }),
    padMat: mkMat(COL.navy, 0.1),       // 3x3 launch mat
  };
  // converted VelociDrone building blocks ('blk:<Color>' hints, on demand)
  const BLOCK_HEX = {
    Black: '#0d0d0d', White: '#e6e6e6', Red: '#e60000', Orange: '#e67300',
    Yellow: '#e6e600', Green: '#00cc00', Cyan: '#00d9d9', Blue: '#0000e6',
    Purple: '#8c00e6', Pink: '#f280bf', RedPink: '#e61a66',
    LightBlue: '#0566e6', DarkGreen: '#006619',
  };
  const matFor = hint => {
    if (MATS[hint]) return MATS[hint];
    const blk = hint.match(/^blk:(\w+)$/);
    if (blk) return (MATS[hint] = mkMat(BLOCK_HEX[blk[1]] || '#9a9a9a', 0.15));
    return MATS.dark;
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 12);
  unitCyl.rotateX(Math.PI / 2);         // axis -> local Z (mrsim is Z-up)

  // element visits from the checkpoint sequence
  const visits = new Map();
  data.seq.forEach(s => {
    if (s.elemIndex < 0) return;
    if (!visits.has(s.elemIndex)) visits.set(s.elemIndex, []);
    visits.get(s.elemIndex).push(s.seqNum);
  });

  // camera bounds from the raced course; the mat also covers nearby scenery
  const courseBox = new THREE.Box3();
  data.elements.forEach((el, ei) => {
    if (el.kind === 'deco' || (el.kind === 'pass' && !visits.has(ei))) return;
    el.prims.forEach(p => courseBox.expandByPoint(new THREE.Vector3().setFromMatrixPosition(p.matrix)));
  });
  data.seq.forEach(s => courseBox.expandByPoint(s.pos));
  // ground-level poles are modelled half-buried (centred cylinders at z=0);
  // don't let the underground halves skew the mat or the altitude stat
  courseBox.min.y = Math.max(courseBox.min.y, groundY);
  const matBox = courseBox.clone();

  const counts = {};
  seqSelectables = [];
  const buckets = new Map();            // "hint|shape" -> {geo, mat, list}
  const V = new THREE.Vector3();

  data.elements.forEach((el, ei) => {
    counts[el.kind] = (counts[el.kind] || 0) + 1;
    const layerName = MRSIM_LAYER[el.kind] || 'barriers';
    const layer = groups[layerName];
    const bbox = new THREE.Box3();
    el.prims.forEach(p => {
      const c = new THREE.Vector3().setFromMatrixPosition(p.matrix);
      const half = Math.max(...p.dims) / 2;
      bbox.expandByPoint(c.clone().addScalar(half));
      bbox.expandByPoint(c.clone().addScalar(-half));
    });
    el.models.forEach(m => bbox.expandByPoint(new THREE.Vector3().setFromMatrixPosition(m.matrix)));
    if (bbox.isEmpty()) {
      const s = data.seq.find(x => x.elemIndex === ei);
      bbox.setFromCenterAndSize(s ? s.pos : new THREE.Vector3(), V.set(1, 1, 1));
    }
    if (el.kind === 'deco' && bbox.distanceToPoint(courseBox.getCenter(V)) < 60) {
      matBox.union(bbox);
    }

    const debug = {
      group: 'mrsim', seqIndex: ei, name: el.name,
      kind: MRSIM_KIND_LABEL[el.kind] || el.kind,
      src: el.tags.filter(t => !/^group:/.test(t)).join(' · '),
      visits: visits.get(ei) || [],
      world: bbox.getCenter(new THREE.Vector3()),
      bbox, isStart: el.isStart,
    };

    el.prims.forEach(p => {
      const hint = p.hint;
      if (hint === 'panelTop') {
        // gate top banner: checker for start/finish, sponsor plate otherwise
        const geo = new THREE.PlaneGeometry(1, 1);
        geo.rotateX(Math.PI / 2);       // span local X/Z (mrsim upright)
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          map: el.isStart ? SHARED.checkerTexS : SHARED.plateMGP,
          side: THREE.DoubleSide,
        }));
        mesh.applyMatrix4(p.matrix.clone().scale(V.set(p.dims[0], 1, p.dims[2])));
        mesh.userData.debug = debug;
        layer.add(mesh);
        return;
      }
      let scale;
      if (p.shape === 'cyl') {
        // real PVC is 2 cm radius — bump it a little so frames read at distance
        const r = hint === 'pvc' ? Math.max(p.dims[0], 0.04) : p.dims[0];
        scale = [r, r, p.dims[1]];
      } else {
        scale = p.dims.map(d => Math.max(d, 0.02));
      }
      const key = `${layerName}|${hint}|${p.shape}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          geo: p.shape === 'cyl' ? unitCyl : unitBox,
          mat: matFor(hint), layerName, list: [],
        });
      }
      buckets.get(key).list.push({
        matrix: p.matrix.clone().scale(V.set(scale[0], scale[1], scale[2])),
        debug,
      });
    });

    // the few modelled visuals we substitute procedurally
    el.models.forEach(md => {
      if (md.model === 'Flag') {
        // feather flag cloth hanging along the 3.3 m pole
        const geo = new THREE.PlaneGeometry(0.55, 2.5);
        geo.rotateX(Math.PI / 2);
        geo.translate(0.32, 0, 1.95);
        const cloth = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          map: SHARED.flagTex, side: THREE.DoubleSide,
        }));
        cloth.applyMatrix4(md.matrix);
        cloth.userData.debug = debug;
        layer.add(cloth);
      } else if (md.model === 'ShadeCanopy') {
        // square pyramid roof over the 3x3 legs
        const geo = new THREE.ConeGeometry(2.4, 0.8, 4);
        geo.rotateY(Math.PI / 4);
        geo.rotateX(Math.PI / 2);
        geo.translate(0, 0, 2.3);
        const roof = new THREE.Mesh(geo, mkMat('#20264f', 0.15, { side: THREE.DoubleSide }));
        roof.applyMatrix4(md.matrix);
        roof.castShadow = true;
        roof.userData.debug = debug;
        layer.add(roof);
      }
    });

    // invisible anchor so prev/next element navigation can highlight it
    const anchor = new THREE.Object3D();
    anchor.position.copy(debug.world);
    anchor.userData.debug = debug;
    trackGroup.add(anchor);
    if (el.kind !== 'deco') seqSelectables.push(anchor);

    // sequence badge above every element the lap passes through
    const nums = visits.get(ei);
    if (nums) {
      const isStart = el.isStart || nums[0] === 1;
      const spr = badgeSprite(compressRuns(nums), isStart ? COL.red : COL.green);
      spr.position.set(debug.world.x, bbox.max.y + 0.7, debug.world.z);
      groups.numbers.add(spr);
      if (isStart) {
        const flags = startFlagsSprite();
        flags.position.set(debug.world.x, bbox.max.y + 2.1, debug.world.z);
        groups.deco.add(flags);
      }
    }
  });
  seqSelectables.sort((a, b) =>
    (a.userData.debug.visits[0] ?? 1e9) - (b.userData.debug.visits[0] ?? 1e9));

  // one instanced draw per material bucket
  buckets.forEach(({ geo, mat, layerName, list }) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.userData.instanceData = list.map(e => e.debug);
    list.forEach((e, i) => im.setMatrixAt(i, e.matrix));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    groups[layerName].add(im);
  });

  // dashed rings where the lap crosses each checkpoint (hidden layer)
  const Zaxis = new THREE.Vector3(0, 0, 1);
  data.seq.forEach(s => {
    const ring = buildCheckpoint();
    ring.scale.setScalar(0.66);
    ring.position.copy(s.pos);
    ring.quaternion.setFromUnitVectors(Zaxis, s.dir);
    ring.userData.debug = {
      group: 'mrsim', seqIndex: 10000 + s.seqNum, name: s.name,
      kind: 'checkpoint', visits: [s.seqNum], world: s.pos, src: '',
    };
    groups.checkpoints.add(ring);
  });

  // ---- racing line from the checkpoint sequence ----
  // Each checkpoint becomes a small crossing region around its reference
  // point (the XML only gives point + direction, so the slack is modest) and
  // the TOGT-inspired optimiser picks the fastest way through the sequence.
  const crossings = [];
  data.seq.forEach(s => {
    const prev = crossings[crossings.length - 1];
    if (prev && prev.center.distanceTo(s.pos) < 0.05 && prev.through.dot(s.dir) > 0.99) return;
    const { axisX, axisY } = planeBasis(s.dir);
    crossings.push({
      center: s.pos.clone(), through: s.dir.clone(),
      axisX, axisY, halfW: 0.45, halfH: 0.45,
    });
  });
  const rl = computeRaceline(crossings, { closed: data.meta.isCircuit, groundY });
  setGeneratedRaceLine(rl ? rl.points : crossingTriples(crossings, data.meta.isCircuit),
    groundY, data.meta.isCircuit, rl || null);

  counts.checkpoints = data.seq.length;
  finishBuild(courseBox, matBox, groundY);
  return counts;
}

// ---------------------------------------------------------------------------
// Camera framing
// ---------------------------------------------------------------------------
function stopFly() {
  flyActive = false;
  btnFly.textContent = '▶ Fly lap';
  btnFly.classList.add('primary');
}
// Distance needed to fit a w×d footprint in view for the current viewport aspect.
function fitDistance(w, d) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  return Math.max(
    (d / 2) / Math.tan(vFov / 2),
    (w / 2) / Math.tan(hFov / 2),
    12
  );
}
function frameTrack() {
  stopFly();
  stopGhost();
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const dist = fitDistance(size.x * 1.15, size.z * 1.6) ;
  // camera south of the course, elevated: poster orientation (north = up-screen)
  camera.position.set(center.x, center.y + dist * 0.75, center.z + dist * 0.8);
  controls.target.copy(center);
  controls.update();
}
function topView() {
  stopFly();
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  camera.position.set(center.x, fitDistance(size.x * 1.12, size.z * 1.12), center.z + 0.01);
  controls.target.copy(center);
  controls.update();
}

// Render a perfectly-overhead orthographic PNG of the track (no perspective),
// framed to the course bounds, and download it. -z points up-screen so it
// matches the 2D layout and the official posters.
function captureTopDown(px = 2200) {
  if (!bounds) return;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const w = size.x * 1.06, d = size.z * 1.06;
  const aspect = w / d;
  const rw = aspect >= 1 ? px : Math.round(px * aspect);
  const rh = aspect >= 1 ? Math.round(px / aspect) : px;

  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, d / 2, -d / 2, 0.1, 4000);
  cam.up.set(0, 0, -1);
  cam.position.set(center.x, center.y + Math.max(size.y, 10) + 500, center.z);
  cam.lookAt(center.x, center.y, center.z);

  const rt = new THREE.WebGLRenderTarget(rw, rh, { samples: 4 });
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);

  const buf = new Uint8Array(rw * rh * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, rw, rh, buf);
  rt.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = rw; canvas.height = rh;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(rw, rh);
  for (let y = 0; y < rh; y++) {                       // flip Y (GL origin is bottom-left)
    const src = (rh - 1 - y) * rw * 4;
    img.data.set(buf.subarray(src, src + rw * 4), y * rw * 4);
  }
  ctx.putImageData(img, 0, 0);
  canvas.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = (currentTrack?.meta?.name || 'track').replace(/[^\w-]+/g, '_') + '_topdown.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------
const toggles = {
  gates: document.getElementById('tGates'),
  flags: document.getElementById('tFlags'),
  numbers: document.getElementById('tNumbers'),
  line: document.getElementById('tLine'),
  ghost: document.getElementById('tGhost'),
  barriers: document.getElementById('tBarriers'),
  checkpoints: document.getElementById('tCheckpoints'),
};
function applyLayerVisibility() {
  if (!groups.gates) return;
  groups.gates.visible = toggles.gates.checked;
  groups.flags.visible = toggles.flags.checked;
  groups.numbers.visible = toggles.numbers.checked;
  groups.line.visible = toggles.line.checked;
  groups.ghost.visible = toggles.ghost.checked;
  groups.barriers.visible = toggles.barriers.checked;
  groups.checkpoints.visible = toggles.checkpoints.checked;
}
Object.values(toggles).forEach(t => t.addEventListener('change', applyLayerVisibility));

// ---------------------------------------------------------------------------
// Fly-through
// ---------------------------------------------------------------------------
const btnFly = document.getElementById('btnFly');
const btnGhost = document.getElementById('btnGhost');
btnFly.addEventListener('click', () => {
  if (!flyPath) return;
  if (flyActive) { stopFly(); return; }
  stopGhost();
  flyActive = true;
  flyT = 0;
  btnFly.textContent = '■ Stop';
  btnFly.classList.remove('primary');
});
btnGhost.addEventListener('click', () => {
  if (!ghostPath) return;
  if (ghostActive) { stopGhost(); return; }
  stopFly();
  ghostActive = true;
  ghostT = 0;
  btnGhost.textContent = '■ Stop';
  btnGhost.classList.add('primary');
});
// ---- Human lines: email, live leaderboard fetch, compare, import ----------
// getLeaderBoard is fetched straight from velocidrone.com (its reply allows
// cross-origin reads), so the leaderboard works even on GitHub Pages.
// getFlight does not, and its request carries the account email, so it goes
// through a trusted proxy instead: serve.py's /vd locally, or a Cloudflare
// Worker (proxy-worker.js) when hosted — this repo's deployed instance by
// default, overridable with your own via the field below.
const emailInput = document.getElementById('emailInput');
emailInput.value = localStorage.getItem('vd_email') || '';
emailInput.addEventListener('change', () => localStorage.setItem('vd_email', emailInput.value.trim()));
const proxyInput = document.getElementById('proxyInput');
proxyInput.value = getProxyBase();
proxyInput.addEventListener('change', () => { setProxyBase(proxyInput.value); proxyInput.value = getProxyBase(); });
// the field only matters when serve.py's /vd can't exist (hosted viewer)
if (needsProxySetup() || (proxyInput.value && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))) {
  proxyInput.style.display = '';
}
function getEmail() {
  const e = emailInput.value.trim();
  if (!e) { emailInput.focus(); throw new Error('enter your VelociDrone account email above first'); }
  localStorage.setItem('vd_email', e);
  return e;
}
const withBusy = async (btn, fn) => {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try { await fn(); } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = orig; }
};

// list of loaded lines (swatch, name, Δ vs WR, remove) + leaderboard picker
function refreshLinesUI() {
  const list = document.getElementById('linesList');
  list.innerHTML = humanLines.map(l => {
    const cmp = lineVsWr(l);
    const delta = cmp ? ` · <span class="dl">${cmp.dt >= 0 ? '+' : ''}${cmp.dt.toFixed(2)}s · ${cmp.dist.toFixed(1)} m off</span>` : (l.isWr ? ' · <span class="dl">WR</span>' : '');
    return `<div class="lineRow" data-id="${l.id}"><span class="sw" style="background:${l.color}"></span>` +
      `<span class="nm">${l.pilot}${l.lapTime ? ' · ' + l.lapTime.toFixed(2) + 's' : ''}${delta}</span>` +
      `<button class="lx" title="remove">✕</button></div>`;
  }).join('');
  list.querySelectorAll('.lineRow').forEach(row => {
    row.querySelector('.lx').addEventListener('click', () => {
      removeLine(humanLines.find(l => l.id === +row.dataset.id));
      updateGhostUI(); refreshInfo(); applyRaceLineMode();
    });
  });
}

async function addPilotLine(entry, isWr) {
  const t = resolveOnlineTrack(currentTrack?.meta);
  const email = getEmail();
  const flight = await fetchFlightFor({
    email, trackId: t.trackId, protectedValue: t.protectedValue, raceMode: t.raceMode,
    playername: entry.playername, lapTime: entry.lap_time,
  });
  const dup = humanLines.find(l => l.pilot === flight.pilot);
  if (dup) removeLine(dup);   // re-fetch replaces an existing line for the same pilot
  addLine({ kind: isWr ? 'wr' : 'pilot', pilot: flight.pilot, lapTime: flight.lap_time,
    frames: flight.frames, isWr });
  if (toggles.ghost) toggles.ghost.checked = true;
  updateGhostUI(); refreshLinesUI(); refreshInfo(); applyRaceLineMode();
}

const btnFetchWr = document.getElementById('btnFetchWr');
btnFetchWr.addEventListener('click', () => withBusy(btnFetchWr, async () => {
  const t = resolveOnlineTrack(currentTrack?.meta);
  if (!t) return;
  const board = await fetchLeaderboard({ trackId: t.trackId, protectedValue: t.protectedValue, raceMode: t.raceMode, count: 1 });
  if (!board.length) throw new Error('no leaderboard times for this track / mode');
  // if the WR is already loaded, don't duplicate
  if (!humanLines.some(l => l.isWr)) await addPilotLine(board[0], true);
}));

// leaderboard picker: fetch the top times, click one to add that pilot's line
const btnBoard = document.getElementById('btnBoard');
const boardList = document.getElementById('boardList');
btnBoard.addEventListener('click', () => withBusy(btnBoard, async () => {
  const t = resolveOnlineTrack(currentTrack?.meta);
  if (!t) return;
  const board = await fetchLeaderboard({ trackId: t.trackId, protectedValue: t.protectedValue, raceMode: t.raceMode, count: 25 });
  boardList.style.display = '';
  boardList.innerHTML = board.map(e =>
    `<div class="brdRow" data-name="${encodeURIComponent(e.playername)}" data-time="${e.lap_time}">` +
    `<b>${e.rank}</b><span class="nm">${e.playername}</span><span class="tm">${e.lap_time.toFixed(3)}s</span></div>`).join('');
  boardList.querySelectorAll('.brdRow').forEach((row, i) => {
    row.addEventListener('click', async () => {
      if (row.classList.contains('busy')) return;
      row.classList.add('busy');
      try {
        await addPilotLine({ playername: decodeURIComponent(row.dataset.name), lap_time: +row.dataset.time }, i === 0);
      } catch (e) { alert(e.message); }
      finally { row.classList.remove('busy'); }
    });
  });
}));

// import a .ghost file (or exported flight) and draw it as a human line
const ghostImport = document.getElementById('ghostImport');
document.getElementById('btnImportGhost').addEventListener('click', () => ghostImport.click());
ghostImport.addEventListener('change', async () => {
  const file = ghostImport.files[0]; ghostImport.value = '';
  if (!file) return;
  try {
    const frames = await parseGhostBytes(new Uint8Array(await file.arrayBuffer()));
    const t0 = frames[0].t;
    frames.forEach(f => { f.t = +(f.t - t0).toFixed(4); });
    const name = file.name.replace(/\.(ghost|bin|b64)$/i, '');
    addLine({ kind: 'imported', pilot: name, lapTime: frames[frames.length - 1].t, frames, tag: 'imported' });
    if (toggles.ghost) toggles.ghost.checked = true;
    updateGhostUI(); refreshLinesUI(); refreshInfo();
  } catch (e) { alert('Could not read “' + file.name + '”: ' + e.message); }
});

// racing-line source toggle: optimiser vs averaged human WR laps
const selLineSrc = document.getElementById('selLineSrc');
selLineSrc.addEventListener('change', () => {
  raceLineMode = selLineSrc.value;
  applyRaceLineMode(); refreshInfo();
});

// top-down capture: render an orthographic overhead PNG framed to the track
document.getElementById('btnCapture').addEventListener('click', () => captureTopDown());

document.getElementById('btnReset').addEventListener('click', frameTrack);
document.getElementById('btnTop').addEventListener('click', topView);

// Map an elapsed-time fraction to an arc-length fraction using the
// optimiser's speed profile, so the fly-lap brakes into corners and sprints
// the straights. Without a profile the pace is constant.
function flyU(f) {
  if (!flyProfile) return f;
  const { t, s, T, S } = flyProfile;
  const tp = f * T;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tp) lo = mid; else hi = mid;
  }
  const w = (tp - t[lo]) / (t[hi] - t[lo] || 1);
  return Math.min(1, (s[lo] + w * (s[hi] - s[lo])) / S);
}
function updateFly(dt) {
  if (!flyActive || !flyPath) return;
  flyT = (flyT + dt / flyDuration) % 1;
  const pos = flyPath.getPointAt(flyU(flyT));
  const ahead = flyPath.getPointAt(flyU((flyT + 0.012) % 1));
  camera.position.lerp(pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.3);
  controls.target.lerp(ahead, 0.35);
  controls.update();
}

function stopGhost() {
  ghostActive = false;
  btnGhost.textContent = '▶ WR lap';
  btnGhost.classList.remove('primary');
}
// Replay the human line at its true recorded pace: the frame timestamps drive
// the position along the curve, so it slows and accelerates exactly as flown.
function updateGhost(dt) {
  if (!ghostActive || !ghostPath || !ghostProfile) return;
  ghostT = (ghostT + dt / ghostProfile.T) % 1;
  const pos = ghostPath.getPointAt(flyU2(ghostProfile, ghostT));
  const ahead = ghostPath.getPointAt(flyU2(ghostProfile, Math.min(1, ghostT + 0.012)));
  camera.position.lerp(pos.clone().add(new THREE.Vector3(0, 0.4, 0)), 0.3);
  controls.target.lerp(ahead, 0.35);
  controls.update();
}
// elapsed-fraction -> arc-length fraction for a {t, s, T, S} timing profile
function flyU2({ t, s, T, S }, f) {
  const tp = f * T;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tp) lo = mid; else hi = mid;
  }
  const w = (tp - t[lo]) / (t[hi] - t[lo] || 1);
  return Math.min(1, (s[lo] + w * (s[hi] - s[lo])) / S);
}

// ---------------------------------------------------------------------------
// Inspector: click any object to see its raw track data
// ---------------------------------------------------------------------------
const inspectorEl = document.getElementById('inspector');
const insBody = document.getElementById('insBody');
const insTitle = document.getElementById('insTitle');
const helpEl = document.getElementById('help');
let highlight = null;
let currentDebug = null;

function clearHighlight() {
  if (highlight) {
    scene.remove(highlight);
    highlight.geometry?.dispose();
    highlight = null;
  }
}

function highlightObject(obj) {
  clearHighlight();
  // mrsim elements draw via instanced buckets; their anchor carries a bbox
  if (obj.userData.debug?.bbox) {
    highlight = new THREE.Box3Helper(obj.userData.debug.bbox, 0xffd83d);
  } else {
    highlight = new THREE.BoxHelper(obj, 0xffd83d);
  }
  scene.add(highlight);
}

function highlightInstance(mesh, instanceId) {
  clearHighlight();
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(instanceId, m);
  // the mrsim cylinder buckets span ±1 radially, the unit boxes ±0.5 —
  // take the extents from the actual geometry
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox.clone().applyMatrix4(m);
  highlight = new THREE.Box3Helper(box, 0xffd83d);
  scene.add(highlight);
}

const fmt = (n, d = 2) => Number(n).toFixed(d);
// values can come from track files (entity names etc.) — never raw HTML
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const row = (k, v) => `<div class="ir"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;

function showInspector(d) {
  currentDebug = d;
  let title, rows = '';
  if (d.group === 'mrsim') {
    title = `${d.name} — ${d.kind}`;
    rows += row('name', d.name);
    rows += row('kind', d.kind);
    if (d.src) rows += row('built from', d.src);
    rows += row('lap visits', d.visits.length ? compressRuns(d.visits) : '—');
    rows += row('world pos (m)', `${fmt(d.world.x)}, ${fmt(d.world.y)}, ${fmt(d.world.z)}`);
    if (d.bbox) {
      const s = d.bbox.getSize(new THREE.Vector3());
      rows += row('size (m)', `${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)}`);
    }
    insTitle.textContent = title;
    insBody.innerHTML = rows;
    inspectorEl.style.display = 'block';
    if (helpEl) helpEl.style.display = 'none';
    return;
  }
  if (d.group === 'sequence') {
    const flags = [d.start && 'start', d.finish && 'finish', d.lap1only && 'lap-1-only']
      .filter(Boolean).join(', ') || '—';
    title = `Gate ${d.vd} — ${d.kind}`;
    rows += row('VD gate #', `${d.vd} (seq ${d.seqIndex})`);
    rows += row('kind', d.kind);
    rows += row('prefab', `${d.prefab}${d.prefabName ? ' · ' + d.prefabName : ''}`);
    if (d.prefabType) rows += row('prefab type', d.prefabType);
    rows += row('mesh', d.hasModel ? 'game model' : 'procedural');
    rows += row('flags', flags);
  } else {
    title = `Barrier — ${d.kind}`;
    rows += row('index', d.barrierIndex);
    rows += row('prefab', `${d.prefab}${d.prefabName ? ' · ' + d.prefabName : ''}`);
    if (d.prefabType) rows += row('prefab type', d.prefabType);
    rows += row('mesh', d.hasModel ? 'game model' : 'procedural');
  }
  rows += row('raw pos (cm)', d.raw.pos.join(', '));
  rows += row('raw rot (w,x,y,z)', d.raw.rot.join(', '));
  rows += row('raw scale (%)', d.raw.scale.join(', '));
  rows += row('world pos (m)', `${fmt(d.world.x)}, ${fmt(d.world.y)}, ${fmt(d.world.z)}`);
  rows += row('yaw / pitch', `${fmt(d.yaw, 1)}° / ${fmt(d.pitch, 1)}°`);
  if (d.group === 'sequence' && d.kind !== 'checkpoint') {
    const s = (d.raw.scale?.[1] ?? 100) / 100;
    rows += row('aperture', `${fmt(GATE_SIZE * (d.raw.scale?.[0] ?? 100) / 100)} × ${fmt(GATE_SIZE * s)} m`);
  }
  insTitle.textContent = title;
  insBody.innerHTML = rows;
  inspectorEl.style.display = 'block';
  if (helpEl) helpEl.style.display = 'none';
}

function hideInspector() {
  clearHighlight();
  currentDebug = null;
  inspectorEl.style.display = 'none';
  if (helpEl) helpEl.style.display = '';
}

function selectSeq(i) {
  if (!seqSelectables.length) return;
  const n = seqSelectables.length;
  const obj = seqSelectables[((i % n) + n) % n];
  showInspector(obj.userData.debug);
  highlightObject(obj);
}

function focusSelection() {
  if (!currentDebug) return;
  const p = currentDebug.world;
  controls.target.set(p.x, p.y + 1, p.z);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target.clone().add(dir.multiplyScalar(8)));
  controls.update();
}

const raycaster = new THREE.Raycaster();
raycaster.params.Line = { threshold: 0.25 };
function pick(cx, cy) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((cx - rect.left) / rect.width) * 2 - 1,
    -((cy - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const targets = [groups.gates, groups.flags, groups.checkpoints, groups.barriers]
    .filter(g => g && g.visible);
  for (const h of raycaster.intersectObjects(targets, true)) {
    if (h.object.isSprite) continue;
    if (h.object.isInstancedMesh && h.instanceId != null) {
      showInspector(h.object.userData.instanceData[h.instanceId]);
      highlightInstance(h.object, h.instanceId);
      return;
    }
    let o = h.object;
    while (o && !o.userData.debug) o = o.parent;
    if (o) {
      showInspector(o.userData.debug);
      highlightObject(o);
      return;
    }
  }
  hideInspector();
}

let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt) return;
  const [x0, y0] = downAt;
  downAt = null;
  if ((e.clientX - x0) ** 2 + (e.clientY - y0) ** 2 > 25) return;  // it was a drag
  pick(e.clientX, e.clientY);
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideInspector();
    document.getElementById('browser').classList.remove('open');
  }
});
document.getElementById('insClose').addEventListener('click', hideInspector);
document.getElementById('insPrev').addEventListener('click', () => {
  const i = currentDebug?.seqIndex ?? 0;
  selectSeq(seqSelectables.findIndex(o => o.userData.debug.seqIndex === i) - 1);
});
document.getElementById('insNext').addEventListener('click', () => {
  const i = currentDebug?.seqIndex ?? -1;
  const cur = seqSelectables.findIndex(o => o.userData.debug.seqIndex === i);
  selectSeq(cur + 1);
});
document.getElementById('insFocus').addEventListener('click', focusSelection);

// ---------------------------------------------------------------------------
// Manifest / loading
// ---------------------------------------------------------------------------
const trackSelect = document.getElementById('trackSelect');
const loadingEl = document.getElementById('loading');

async function loadManifest() {
  try {
    const res = await fetch('tracks/manifest.json');
    let man = await res.json();
    // unpublished tracks live in a gitignored local overlay
    try {
      const local = await fetch('tracks/manifest.local.json');
      if (local.ok) man = await local.json();
    } catch (e) { /* no local overlay */ }
    trackSelect.innerHTML = '';
    man.tracks.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.file; opt.textContent = t.name;
      trackSelect.appendChild(opt);
    });
    return man.tracks;
  } catch (e) {
    console.error('manifest load failed', e);
    return [];
  }
}

let _lastInfo = null;
function refreshInfo() { if (_lastInfo) setTrackInfo(..._lastInfo); }
function setTrackInfo(name, sub, items) {
  _lastInfo = [name, sub, items];   // cached so a fetched WR line can re-render
  document.getElementById('trackName').textContent = name;
  document.getElementById('trackSub').textContent = sub;
  const size = bounds.getSize(new THREE.Vector3());
  document.getElementById('matList').innerHTML =
    items.map(([n, t]) => `<div class="mi"><b>${n}</b> ${t}</div>`).join('') +
    `<div class="sep"></div>` +
    `<div class="mi small"><b>${flyPath ? flyPath.getLength().toFixed(0) : '–'} m</b> racing line / lap</div>` +
    (estLapTime ? `<div class="mi small"><b>~${estLapTime.toFixed(1)} s</b> est. race pace</div>` : '') +
    (ghostMeta ? `<div class="mi small" style="color:#0b7c8c"><b>${ghostMeta.lap_time.toFixed(2)} s</b> WR — ${ghostMeta.pilot}</div>` : '') +
    `<div class="mi small"><b>${size.x.toFixed(0)}×${size.z.toFixed(0)} m</b> course area</div>` +
    `<div class="mi small"><b>${size.y.toFixed(1)} m</b> max altitude</div>`;
}

let currentTrack = null;   // whatever presentTrack last displayed (for convert)

// the convert button exports to the OTHER sim: offer that sim's environments
function populateEnvSelector(format) {
  const sel = document.getElementById('convEnv');
  sel.innerHTML = '';
  const opts = format === 'mrsim'
    ? VD_SCENES.map(([v, l]) => [v, `→ VD: ${l}`])
    : MRSIM_LOCATIONS.map(([v, l]) => [v, `→ MRSIM: ${l}`]);
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    sel.appendChild(o);
  }
}

async function presentTrack(data, gen) {
  if (data.format !== 'mrsim' && !Array.isArray(data.gates)) {
    throw new Error('track file has no gates list');
  }
  currentTrack = data;
  populateEnvSelector(data.format);
  if (data.format === 'mrsim') {
    const counts = buildTrackMrsim(data);
    frameTrack();
    const items = [];
    if (counts.gate) items.push([counts.gate, 'x Gates']);
    if (counts.dive) items.push([counts.dive, 'x Dive gates']);
    if (counts.cube) items.push([counts.cube, 'x Pipe cubes']);
    if (counts.pole) items.push([counts.pole, 'x Poles']);
    if (counts.flag) items.push([counts.flag, 'x Flags']);
    if (counts.deco) items.push([counts.deco, 'x Scenery objects']);
    if (counts.checkpoints) items.push([counts.checkpoints, 'x Checkpoints / lap']);
    setTrackInfo(
      data.meta.name || 'MRSIM track',
      ['MRSIM' + (data.meta.author ? ` track by ${data.meta.author}` : ' track'),
        data.meta.location, data.meta.isCircuit ? 'circuit' : 'sprint']
        .filter(Boolean).join(' · '),
      items);
    await loadGhost(data.meta.name);   // no MRSIM ghosts today; hides the UI
    return;
  }
  await preloadModels([
    ...data.gates.map(g => g.prefab),
    ...(data.barriers || []).map(b => b.prefab),
  ]);
  if (gen !== loadGen) return;
  const counts = buildTrack(data);
  frameTrack();
  const meta = data.meta || {};
  const sceneName = CATALOG.scenes[meta.scene_id] || meta.scene || '?';
  const items = [];
  if (counts.gate) items.push([counts.gate, 'x Gates']);
  if (counts.flag) items.push([counts.flag, 'x Flags']);
  if (counts.dive) items.push([counts.dive, 'x Dive Gate' + (counts.dive > 1 ? 's' : '')]);
  if (counts.checkpoint) items.push([counts.checkpoint, 'x Checkpoints (hidden)']);
  if (counts.scenery) items.push([counts.scenery, 'x Scenery objects']);
  setTrackInfo(
    meta.name || 'Track',
    [meta.source || 'Official layout viewer', sceneName, meta.date]
      .filter(Boolean).join(' · '),
    items);
  await loadGhost(meta.name);
  setTrackInfo(   // re-render so the WR line appears once the ghost is loaded
    meta.name || 'Track',
    [meta.source || 'Official layout viewer', sceneName, meta.date]
      .filter(Boolean).join(' · '),
    items);
}

// Serialises loads: a newer call supersedes any still in flight (gen guard).
let loadGen = 0;
async function runLoad(job, failMsg) {
  const gen = ++loadGen;
  loadingEl.style.display = 'flex';
  try {
    const data = await job();
    if (gen !== loadGen) return;   // a newer load superseded this one
    await presentTrack(data, gen);
  } catch (e) {
    console.error(e);
    if (gen !== loadGen) return;   // a newer load owns the UI now
    stopFly();
    document.getElementById('trackSub').textContent = failMsg(e);
  } finally {
    if (gen === loadGen) loadingEl.style.display = 'none';
  }
}

function loadTrack(file) {
  return runLoad(
    async () => {
      if (/\.xml$/i.test(file)) {
        return parseMrsim(await (await fetch(file)).text(), file.split('/').pop());
      }
      return (await fetch(file)).json();
    },
    () => 'Failed to load track (serve over HTTP).');
}

// ---------------------------------------------------------------------------
// Track import: VelociDrone .trk (encrypted, decoded in trk.js) and
// MRSIM .xml (scene graph, decoded in mrsim.js)
// ---------------------------------------------------------------------------
const uploads = [];
function registerUpload(data, icon = '📂') {
  const idx = uploads.push(data) - 1;
  const opt = document.createElement('option');
  opt.value = `upload:${idx}`;
  opt.textContent = `${icon} ${data.meta.name}`;
  trackSelect.appendChild(opt);
  trackSelect.value = opt.value;
  return data;
}

function importFile(file) {
  return runLoad(async () => {
    const text = await file.text();
    const data = /\.xml$/i.test(file.name)
      ? parseMrsim(text, file.name)
      : parseTrk(text, file.name);
    return registerUpload(data);
  }, e => `Could not read ${file.name}: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Convert the displayed track to the other sim's format and download it
// ---------------------------------------------------------------------------
function convertCurrent() {
  if (!currentTrack) throw new Error('no track loaded');
  const env = document.getElementById('convEnv').value;
  if (currentTrack.format === 'mrsim') {
    const { sceneId, name, json, warnings } =
      mrsimToVd(currentTrack, { sceneId: Number(env) || undefined });
    return {
      fileName: `${name}.trk`, type: 'text/plain', warnings,
      content: buildTrk(sceneId, name, json),
    };
  }
  const { xml, warnings } = vdToMrsim(
    currentTrack, classifySeq, id => prefabInfo(id)?.name ?? '',
    { location: env || undefined });
  const name = currentTrack.meta?.name || 'track';
  return { fileName: `${name}-VelociDrone.xml`, type: 'text/xml', warnings, content: xml };
}

document.getElementById('btnConvert').addEventListener('click', () => {
  try {
    const { fileName, content, type, warnings } = convertCurrent();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    document.getElementById('trackSub').textContent =
      [`Exported ${fileName}`, ...warnings].join(' · ');
  } catch (e) {
    console.error(e);
    document.getElementById('trackSub').textContent = `Convert failed: ${e.message}`;
  }
});

const trkInput = document.getElementById('trkFile');
document.getElementById('btnTrk').addEventListener('click', () => trkInput.click());
trkInput.addEventListener('change', () => {
  if (trkInput.files[0]) importFile(trkInput.files[0]);
  trkInput.value = '';   // allow re-selecting the same file
});

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find(f => /\.(trk|xml)$/i.test(f.name));
  if (f) importFile(f);
});

trackSelect.addEventListener('change', () => {
  const v = trackSelect.value;
  if (v.startsWith('upload:')) {
    runLoad(async () => uploads[+v.slice(7)], () => 'Failed to load track.');
  } else {
    loadTrack(v);
  }
});

// ---------------------------------------------------------------------------
// Community track browser — VelociDrone's official track catalogue.
// Catalogue discovery + AES scheme documented by
// https://github.com/bolagnaise/vdrone-tracks: the list is AES-128-ECB
// encrypted with the same key derivation as .trk files (seed 'Bat Cave
// Games'), decoded client-side here. The catalogue endpoint sends no CORS
// headers (fetched through a passthrough); downloads go straight to
// VelociDrone, which allows cross-origin requests.
// ---------------------------------------------------------------------------
const VD_API = 'https://www.velocidrone.com';
const corsProxy = u => 'https://corsproxy.io/?url=' + encodeURIComponent(u);
// scene_id -> download folder (the catalogue references tracks by path)
const VD_SCENE_DIRS = {
  1: 'MainMenu', 2: 'NetworkLobby', 3: 'Hangar', 7: 'Scene5', 8: 'Scene6',
  12: 'Countryside', 13: 'FactoryNight', 14: 'KartTrack', 15: 'SubWay',
  16: 'BlankCanvas', 17: 'BlankCanvasNight', 18: 'NEC_Birmingham',
  19: 'Warehouse', 20: 'CarPark', 21: 'Gym', 22: 'Coastal', 23: 'River2',
  24: 'City', 25: 'redbull_ring', 26: 'CarPark2', 27: 'Front9',
  28: 'VegetationStudio', 29: 'Baseball', 30: 'Bando', 31: 'IndoorGoKart',
  32: 'Slovenia', 33: 'DynamicWeather', 34: 'DR1Castles', 35: 'Sneznik',
  36: 'PolyWorld', 37: 'Library', 38: 'NightClub', 39: 'House',
  40: 'FutureHangar', 41: 'Island', 42: 'EmptyPoly', 43: 'FutureHangarEmpty',
  44: 'DynamicPoly', 45: 'Gaiatest', 46: 'CombatPractice', 47: 'Warehouse2',
  48: 'Drifting', 49: 'RedValley', 50: 'SportBar', 51: 'MiniWarehouse',
  52: 'Apartment', 53: 'Office', 54: 'OfficeComplex', 55: 'NightFactory2',
  56: 'Factory', 57: 'TechFacility', 100: 'PolyPort', 101: 'PolyBando',
  102: 'City2', 103: 'AlpineLake', 104: 'RomanCity', 105: 'NightFactory3',
};

const browserEl = document.getElementById('browser');
const brSearch = document.getElementById('brSearch');
const brSort = document.getElementById('brSort');
const brList = document.getElementById('brList');
const brMore = document.getElementById('brMore');
const brStatus = document.getElementById('brStatus');
const br = { shown: 0, busy: false };
const BR_PAGE = 100;

let cataloguePromise = null;
function loadCatalogue() {
  // single-flight: opening the browser while a fetch is running must not
  // start a second 500 KB download
  cataloguePromise ??= (async () => {
    // public data, no email involved — a third-party CORS proxy is acceptable
    // here, but prefer the user's own worker when one is configured
    const proxy = getProxyBase();
    const res = await fetch(proxy ? `${proxy}/get_official_tracks`
                                  : corsProxy(`${VD_API}/api/get_official_tracks`));
    if (!res.ok) throw new Error(`catalogue unavailable (${res.status})`);
    const data = JSON.parse(decryptTrk(await res.text(), 'Bat Cave Games'));
    if (!data.success || !Array.isArray(data.tracks)) {
      throw new Error('catalogue response was not successful');
    }
    return data.tracks.map(t => ({
      id: t.track_id, name: (t.track_name || '').trim(), sceneId: t.scene_id,
      scene: CATALOG.scenes[t.scene_id] || VD_SCENE_DIRS[t.scene_id] || `Scene ${t.scene_id}`,
      rating: Number(t.rating) || 0, count: Number(t.count) || 0,
      date: String(t.date || ''),
    }));
  })().catch(e => { cataloguePromise = null; throw e; });
  return cataloguePromise;
}

const BR_SORTS = {
  popularity: (a, b) => b.count - a.count || b.rating - a.rating,
  rating: (a, b) => b.rating - a.rating || b.count - a.count,
  newest: (a, b) => b.date.localeCompare(a.date),
  name: (a, b) => a.name.localeCompare(b.name),
};

function brFiltered(catalogue) {
  const q = brSearch.value.trim().toLowerCase();
  return catalogue
    .filter(t => !q || t.name.toLowerCase().includes(q) || t.scene.toLowerCase().includes(q))
    .sort(BR_SORTS[brSort.value] || BR_SORTS.popularity);
}

function brRow(t) {
  const row = document.createElement('div');
  row.className = 'brRow';
  row.title = `Published ${t.date} · track id ${t.id}`;
  row.innerHTML = `<b></b><span class="scene"></span>` +
    `<span class="stars">★ ${t.rating.toFixed(1)} (${t.count})</span>`;
  row.querySelector('b').textContent = t.name;
  row.querySelector('.scene').textContent = t.scene;
  row.addEventListener('click', () => {
    if (br.busy) return;
    br.busy = true;
    brStatus.textContent = `Downloading “${t.name}”…`;
    runLoad(async () => {
      const dir = VD_SCENE_DIRS[t.sceneId];
      if (!dir) throw new Error('unknown scenery');
      const res = await fetch(`${VD_API}/api/download-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          file_path: `downloads/scenes/${dir}/official_tracks/${t.name}.trk`,
        }),
      });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const text = await res.text();
      if (!text.trim()) throw new Error('track file is empty / unavailable');
      const data = parseTrk(text, `${t.name}.trk`);
      data.meta.name = t.name;
      data.meta.source = 'Official track';
      data.meta.onlineId = t.id;          // catalogue track_id -> enables Fetch WR
      data.meta.protectedValue = 1;       // official (catalogue) tracks
      browserEl.classList.remove('open');
      return registerUpload(data, '🌐');
    }, e => `Could not load “${t.name}”: ${e.message}`)
      .finally(() => { br.busy = false; brStatus.textContent = ''; });
  });
  return row;
}

async function brRender(reset) {
  if (reset) { br.shown = 0; brList.innerHTML = ''; }
  brStatus.textContent = 'Loading…';
  brMore.style.display = 'none';
  try {
    const list = brFiltered(await loadCatalogue());
    const next = list.slice(br.shown, br.shown + BR_PAGE);
    next.forEach(t => brList.appendChild(brRow(t)));
    br.shown += next.length;
    brStatus.textContent = `${br.shown} of ${list.length} official tracks`;
    brMore.style.display = br.shown < list.length ? '' : 'none';
  } catch (e) {
    console.error(e);
    brStatus.textContent = `Could not load the catalogue: ${e.message}`;
  }
}

document.getElementById('btnBrowse').addEventListener('click', () => {
  const open = browserEl.classList.toggle('open');
  if (open && !brList.children.length) brRender(true);
  if (open) brSearch.focus();
});
document.getElementById('brClose').addEventListener('click', () =>
  browserEl.classList.remove('open'));
let brDebounce = 0;
brSearch.addEventListener('input', () => {
  clearTimeout(brDebounce);
  brDebounce = setTimeout(() => brRender(true), 250);
});
brSort.addEventListener('change', () => brRender(true));
brMore.addEventListener('click', () => brRender(false));

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (flyActive) updateFly(dt);
  else if (ghostActive) updateGhost(dt);
  else controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  initShared();
  animate();
  // prefab catalog + extracted-model index (both optional — fallbacks exist)
  try { CATALOG = await (await fetch('tracks/prefabs.json')).json(); }
  catch (e) { console.warn('prefabs.json unavailable, using fallback classification'); }
  try { MODELS_INDEX = await (await fetch('models/models.json')).json(); }
  catch (e) { console.warn('models.json unavailable, using procedural meshes'); }
  try { PREFAB_DIMS = await (await fetch('tracks/prefab-dims.json')).json(); }
  catch (e) { console.warn('prefab-dims.json unavailable, scenery boxes use raw scale'); }
  const tracks = await loadManifest();
  if (tracks.length) {
    await loadTrack(tracks[0].file);
  } else {
    loadingEl.querySelector('.spin')?.remove();   // stop the spinner on fatal errors
    loadingEl.querySelector('div:last-child').textContent =
      'No tracks found — check tracks/manifest.json (must be served over HTTP).';
  }
})();

// Debug hook: force a synchronous frame and capture it (works in hidden tabs
// where requestAnimationFrame is throttled).
window.__viewer = {
  capture(quality = 0.6) {
    controls.update();
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/jpeg', quality);
  },
  topView, frameTrack, camera, controls, selectSeq, pick, convertCurrent,
  get bounds() { return bounds; },
  get groups() { return groups; },
  get currentTrack() { return currentTrack; },
};
