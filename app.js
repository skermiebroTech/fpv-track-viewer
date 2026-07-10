import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
// fallback when prefabs.json is unavailable
const GATE_KIND_FALLBACK = {
  285: 'gate', 742: 'gate', 286: 'dive',
  170: 'flag', 88: 'checkpoint', 2231: 'checkpoint', 2232: 'checkpoint',
};
// exact material colours pulled from the prefab materials in the bundles
const BLOCK_COLORS = {
  2219: '#e6e6e6',    // BlockWhite  (0.9, 0.9, 0.9)
  2220: '#e60000',    // BlockRed    (0.9, 0.0, 0.0)
  2229: '#0566e6',    // BlockLightBlue (0.02, 0.4, 0.9)
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
      (Math.max(...g.trans.scale) >= 5000 ? 'checkpoint' : 'gate');
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
    ctx.font = `italic 900 ${text.length > 2 ? 40 : 56}px Arial`;
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
let flyActive = false;
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
// Build a track from parsed JSON
// ---------------------------------------------------------------------------
function buildTrack(data) {
  hideInspector();
  scene.remove(trackGroup);
  disposeGroup(trackGroup);
  trackGroup = new THREE.Group();
  scene.add(trackGroup);
  groups = {
    gates: new THREE.Group(), flags: new THREE.Group(), numbers: new THREE.Group(),
    line: new THREE.Group(), barriers: new THREE.Group(), checkpoints: new THREE.Group(),
    deco: new THREE.Group(),
  };
  Object.values(groups).forEach(g => trackGroup.add(g));

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
  // Dedup on RAW positions (a checkpoint often sits 2 cm from a flag), then
  // gates contribute entry/centre/exit points along their fly-through axis so
  // the curve crosses each gate perpendicular to its frame.
  // Every element's stored +Z axis IS its crossing direction in VelociDrone
  // (verified against the official posters: this is what produces the split-S
  // loops and hook turns the editor draws). Each element contributes
  // entry/centre/exit points along that axis — no direction guessing.
  const pathPts = [];
  const CROSS = 2.4;   // entry/exit helper distance (m) — clearance around gate frames
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
    const sy = (g.trans.scale?.[1] ?? 100) / 100;
    let center;
    if (kind === 'flag') {
      center = raw.clone().add(new THREE.Vector3(0, 1.5, 0));      // past the flag ~1.5 m up
    } else if (kind === 'checkpoint') {
      center = sy <= 3
        ? raw.clone().add(new THREE.Vector3(0, GATE_SIZE * sy / 2, 0).applyQuaternion(q))
        : raw.clone().add(new THREE.Vector3(0, 1.0, 0));           // helper poles: ~pole height
    } else {
      // aperture centre from the real model bounds when we have them
      const bb = MODELS_INDEX[g.prefab];
      const cy = bb ? (bb.min[1] + bb.max[1]) / 2 : GATE_SIZE / 2;
      center = raw.clone().add(new THREE.Vector3(0, cy * sy, 0).applyQuaternion(q));
    }
    pathPts.push(
      center.clone().addScaledVector(through, -CROSS),
      center,
      center.clone().addScaledVector(through, CROSS),
    );
  });
  pathPts.forEach(p => { p.y = Math.max(p.y, groundY + 0.35); });   // never dip underground
  if (pathPts.length >= 3) {
    // centripetal parameterisation: no overshoot, straight through the
    // collinear entry/centre/exit triples — flies like a drone would
    const curve = new THREE.CatmullRomCurve3(pathPts, true, 'centripetal');
    flyPath = curve;
    flyDuration = Math.max(14, curve.getLength() / 16);  // ~16 m/s tour pace
    const div = Math.max(400, pathPts.length * 24);
    const tubeGeo = new THREE.TubeGeometry(curve, div, 0.055, 8, true);
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

    // start arrow on the mat
    const p0 = pathPts[0];
    const dir = curve.getTangentAt(0); dir.y = 0; dir.normalize();
    const arrow = buildStartArrow(dir);
    arrow.position.set(p0.x + dir.x * 2.2, groundY + 0.03, p0.z + dir.z * 2.2);
    groups.deco.add(arrow);
  } else {
    flyPath = null;
  }

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
  const buckets = new Map();
  (data.barriers || []).forEach((b, bi) => {
    const info = prefabInfo(b.prefab);
    if (info?.type === 'Tools') return;    // editor helpers (splines) — invisible in-game
    const label = info?.name;
    const model = modelInstance(b.prefab);
    if (model) {
      // the real in-game mesh
      model.position.copy(toVec(b.trans.pos));
      model.quaternion.copy(toQuat(b.trans.rot));
      model.scale.set(b.trans.scale[0] / 100, b.trans.scale[1] / 100, b.trans.scale[2] / 100);
      model.userData.debug = makeBarrierDebug(b, bi, label ?? 'model');
      groups.barriers.add(model);
      return;
    }
    let dims = b.trans.scale.map(s => Math.max(0.04, s / 100));
    const maxDim = Math.max(...dims), minDim = Math.min(...dims);
    let m;
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
    }
    else if (label && /net/i.test(label)) m = netBlackMat;          // black safety nets
    else if (label && /goal|barrier/i.test(label)) m = bannerMat;   // white barrier panels
    else if (maxDim > 12) m = netMat;                               // giant nets / backdrops
    else if (minDim <= 0.12 && maxDim >= 1.6) m = bannerMat;        // white panel banners
    else if (minDim <= 0.3 && maxDim >= 1.6) m = blackPoleMat;      // poles / crossbars
    else m = propMat;                                               // generic props
    const q = toQuat(b.trans.rot);
    // prefab origins are at the base: shift the box up half its height in local Y
    const p = toVec(b.trans.pos)
      .add(new THREE.Vector3(0, dims[1] / 2, 0).applyQuaternion(q));
    if (!buckets.has(m)) buckets.set(m, []);
    buckets.get(m).push({ p, q, dims, b, bi });
  });
  const M = new THREE.Matrix4();
  const S = new THREE.Vector3();
  buckets.forEach((list, m) => {
    const im = new THREE.InstancedMesh(unit, m, list.length);
    im.userData.instanceData = list.map(e => makeBarrierDebug(e.b, e.bi, MAT_NAME.get(m)));
    list.forEach((e, i) => {
      im.setMatrixAt(i, M.compose(e.p, e.q, S.set(e.dims[0], e.dims[1], e.dims[2])));
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = m !== netMat;
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
    .filter(b => prefabInfo(b.prefab)?.type !== 'Tools').length;
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

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------
const toggles = {
  gates: document.getElementById('tGates'),
  flags: document.getElementById('tFlags'),
  numbers: document.getElementById('tNumbers'),
  line: document.getElementById('tLine'),
  barriers: document.getElementById('tBarriers'),
  checkpoints: document.getElementById('tCheckpoints'),
};
function applyLayerVisibility() {
  if (!groups.gates) return;
  groups.gates.visible = toggles.gates.checked;
  groups.flags.visible = toggles.flags.checked;
  groups.numbers.visible = toggles.numbers.checked;
  groups.line.visible = toggles.line.checked;
  groups.barriers.visible = toggles.barriers.checked;
  groups.checkpoints.visible = toggles.checkpoints.checked;
}
Object.values(toggles).forEach(t => t.addEventListener('change', applyLayerVisibility));

// ---------------------------------------------------------------------------
// Fly-through
// ---------------------------------------------------------------------------
const btnFly = document.getElementById('btnFly');
btnFly.addEventListener('click', () => {
  if (!flyPath) return;
  if (flyActive) { stopFly(); return; }
  flyActive = true;
  flyT = 0;
  btnFly.textContent = '■ Stop';
  btnFly.classList.remove('primary');
});
document.getElementById('btnReset').addEventListener('click', frameTrack);
document.getElementById('btnTop').addEventListener('click', topView);

function updateFly(dt) {
  if (!flyActive || !flyPath) return;
  flyT = (flyT + dt / flyDuration) % 1;
  const pos = flyPath.getPointAt(flyT);
  const ahead = flyPath.getPointAt((flyT + 0.012) % 1);
  camera.position.lerp(pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.3);
  controls.target.lerp(ahead, 0.35);
  controls.update();
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
  highlight = new THREE.BoxHelper(obj, 0xffd83d);
  scene.add(highlight);
}

function highlightInstance(mesh, instanceId) {
  clearHighlight();
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(instanceId, m);
  const box = new THREE.Box3(
    new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)
  ).applyMatrix4(m);
  highlight = new THREE.Box3Helper(box, 0xffd83d);
  scene.add(highlight);
}

const fmt = (n, d = 2) => Number(n).toFixed(d);
const row = (k, v) => `<div class="ir"><span>${k}</span><b>${v}</b></div>`;

function showInspector(d) {
  currentDebug = d;
  let title, rows = '';
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
window.addEventListener('keydown', e => { if (e.key === 'Escape') hideInspector(); });
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

let loadGen = 0;
async function loadTrack(file) {
  const gen = ++loadGen;
  loadingEl.style.display = 'flex';
  try {
    const res = await fetch(file);
    const data = await res.json();
    if (gen !== loadGen) return;   // a newer load superseded this one
    if (!Array.isArray(data.gates)) throw new Error('track file has no gates list');
    await preloadModels([
      ...data.gates.map(g => g.prefab),
      ...(data.barriers || []).map(b => b.prefab),
    ]);
    if (gen !== loadGen) return;
    const counts = buildTrack(data);
    frameTrack();
    const meta = data.meta || {};
    const sceneName = CATALOG.scenes[meta.scene_id] || meta.scene || '?';
    document.getElementById('trackName').textContent = meta.name || 'Track';
    document.getElementById('trackSub').textContent =
      `Official layout viewer · ${sceneName} · ${meta.date || ''}`;
    const size = bounds.getSize(new THREE.Vector3());
    const items = [];
    if (counts.gate) items.push([counts.gate, 'x Gates']);
    if (counts.flag) items.push([counts.flag, 'x Flags']);
    if (counts.dive) items.push([counts.dive, 'x Dive Gate' + (counts.dive > 1 ? 's' : '')]);
    if (counts.checkpoint) items.push([counts.checkpoint, 'x Checkpoints (hidden)']);
    if (counts.scenery) items.push([counts.scenery, 'x Scenery objects']);
    document.getElementById('matList').innerHTML =
      items.map(([n, t]) => `<div class="mi"><b>${n}</b> ${t}</div>`).join('') +
      `<div class="sep"></div>` +
      `<div class="mi small"><b>${flyPath ? flyPath.getLength().toFixed(0) : '–'} m</b> racing line / lap</div>` +
      `<div class="mi small"><b>${size.x.toFixed(0)}×${size.z.toFixed(0)} m</b> course area</div>` +
      `<div class="mi small"><b>${size.y.toFixed(1)} m</b> max altitude</div>`;
  } catch (e) {
    console.error(e);
    stopFly();
    document.getElementById('trackSub').textContent = 'Failed to load track (serve over HTTP).';
  } finally {
    if (gen === loadGen) loadingEl.style.display = 'none';
  }
}

trackSelect.addEventListener('change', () => loadTrack(trackSelect.value));

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (flyActive) updateFly(dt);
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
  topView, frameTrack, camera, controls, selectSeq, pick,
};
