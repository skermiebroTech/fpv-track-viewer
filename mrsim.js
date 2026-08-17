// ===========================================================================
// MRSIM (Multi Rotor SIM) track XML decoder.
//
// An MRSIM track is a <Simulation> scene graph: nested <Transform>s place
// <Entity>s that either <Include> a library object (5x5Gate.xml, Flag.xml...)
// or <Instance> a <Macro> (PaddedPole, PipeDoubleCube...). The library XMLs
// (embedded in mrsim-lib.js, extracted from the game's MRSIM.dkb archive)
// define each object's collision primitives — thin <Box>es are exactly the
// fabric panels and <Cylinder>s the PVC pipes/poles, so rendering the contact
// geometry reproduces the objects faithfully with no per-type code.
//
// Every raceable object also defines <Checkpoint> entities with a
// CheckpointReference point, and the track lists the flight order in
// <CheckpointList> (names like "trkCube1.lower.backEntry" are dotted entity
// name paths). That gives exact racing-line crossings: position = reference
// point, direction = the checkpoint entity's local +Y axis.
//
// Coordinates: metres, right-handed Z-up (x/y ground plane). Rotations are
// axis-angle attributes (rx/ry/rz = axis, angleDegrees or angle in radians).
// Converted here to three.js Y-up: (x, y, z) -> (x, z, -y).
// ===========================================================================
import * as THREE from 'three';
import { MRSIM_LIB } from './mrsim-lib.js';

const DEG = Math.PI / 180;

// mrsim Z-up right-handed -> three.js Y-up right-handed
const Z_UP_TO_Y_UP = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0),   // mrsim +x -> three +x
  new THREE.Vector3(0, 0, -1),  // mrsim +y -> three -z
  new THREE.Vector3(0, 1, 0),   // mrsim +z -> three +y
);

const num = (el, name, dflt = 0) => {
  const v = el.getAttribute(name);
  return v === null || v === '' ? dflt : parseFloat(v);
};

// <Transform>/<WorldFromEntityComponent> attributes -> local matrix (T * R * S).
// s="0.8" is the engine's uniform scale (Baylands trees, menu UI use it).
function localMatrix(el) {
  let x = num(el, 'x'), y = num(el, 'y'), z = num(el, 'z');
  const v = el.getAttribute('v');
  if (v) {
    const p = v.split(',').map(parseFloat);
    x = p[0] || 0; y = p[1] || 0; z = p[2] || 0;
  }
  const m = new THREE.Matrix4();
  const ax = num(el, 'rx'), ay = num(el, 'ry'), az = num(el, 'rz');
  const angle = el.hasAttribute('angleDegrees')
    ? num(el, 'angleDegrees') * DEG : num(el, 'angle');
  if ((ax || ay || az) && angle) {
    m.makeRotationAxis(new THREE.Vector3(ax, ay, az).normalize(), angle);
  }
  const s = num(el, 's', 1);
  if (s !== 1) m.multiply(new THREE.Matrix4().makeScale(s, s, s));
  m.setPosition(x, y, z);
  return m;
}

function directChild(el, tag) {
  for (const c of el.children) if (c.tagName === tag) return c;
  return null;
}

function parseXml(text, what) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`${what}: ${err.textContent.split('\n')[0].slice(0, 160)}`);
  if (doc.documentElement.tagName !== 'Simulation') {
    throw new Error(`${what}: no <Simulation> root — not an MRSIM track`);
  }
  return doc;
}

const dirname = p => p.slice(0, p.lastIndexOf('/') + 1);
const basename = p => p.slice(p.lastIndexOf('/') + 1);

// is `sub` a contiguous run inside `path`? (checkpoint name resolution:
// "trkCube1.lower.backEntry" against ["Track","trkCube1","lower","backEntry"])
function contiguousRun(path, sub) {
  outer: for (let i = 0; i + sub.length <= path.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (path[i + j] !== sub[j]) continue outer;
    }
    return true;
  }
  return false;
}

// material hint for a primitive, from its explicit render material, the
// macro/include names that produced it, and its shape
function matHint(shape, dims, material, tags) {
  if (material) {
    if (/Tape/.test(material)) {
      return tags.includes('PoleGateRedTape') ? 'tapeRed' : 'tapeBlue';
    }
    if (/PoleGateWhite/.test(material)) return 'pad';       // pole padding
    if (/FlagPole/.test(material)) return 'dark';           // inner pipe
    if (/FlagStalk/.test(material)) return 'stalk';
    if (/GateTop/.test(material)) return 'panelTop';
    if (/GateSide|Hurdle/.test(material)) return 'panelSide';
    // converted VelociDrone blocks (emitted by convert.js)
    const blk = material.match(/^Block(\w+?)Material$/);
    if (blk) return `blk:${blk[1]}`;
  }
  const src = tags.join(' ');
  if (shape === 'box') {
    if (/7x7Mat/.test(src)) return 'padMat';                 // 3x3 launch mat
    if (/ShadeCanopy|LaunchStand|StartBlock/.test(src)) return 'dark';
    if (dims[1] <= 0.02) {                                   // gate fabric
      return dims[0] >= dims[2] ? 'panelTop' : 'panelSide';
    }
    return 'dark';
  }
  if (/Flag\.xml|Flag180/.test(src)) return dims[0] >= 0.03 ? 'sleeve' : 'stalk';
  return 'pvc';                                              // structural pipe
}

function classify(tags) {
  const t = [...tags].join(' ');
  // order matters: cube/pole macros contain "PoleGate…Tape" (matches /Gate/),
  // flag passes include a half-plane passage, dive gates match /Gate/
  if (/StartFinishGate/.test(t)) return 'gate';
  if (/FlagPass|Flag\.xml|Flag180/.test(t)) return 'flag';
  if (/PipeDoubleCube|PipeCube|PipeLadder|PipeQuadrupleLadder/.test(t)) return 'cube';
  if (/PaddedPole/.test(t)) return 'pole';
  if (/DiveGate|ClimbGate|DiveBox|Carousel/.test(t)) return 'dive';
  if (/Gate|Hurdle|Tower/.test(t)) return 'gate';
  if (/HalfPlanePassage/.test(t)) return 'pass';
  return 'deco';                       // mats, launch stands, canopies...
}

const libDocs = new Map();   // parsed library XML, shared across imports

export function parseMrsim(xmlText, fileName = 'track.xml') {
  const doc = parseXml(xmlText, fileName);
  const st = {
    macros: new Map(),       // macro name -> {el, src}
    groups: new Map(),       // render-instance-group name -> {el, src}
    elements: [],            // logical objects (one per named scene entity)
    checkpoints: [],         // {path, m, refM, elem}
    cpList: null,            // {isCircuit, checkpoints: [names]}
    location: null,
    issues: new Map(),       // things we skipped -> count
  };
  const ctx = {
    m: new THREE.Matrix4(),  // mrsim-space world matrix
    path: [],                // named-entity ancestor chain
    elem: null,              // logical element being populated
    tags: [],                // include/macro names active here
    src: '/' + fileName,
    depth: 0,
  };
  walkChildren(doc.documentElement, ctx, st);
  return assemble(st, fileName);
}

function note(st, what) {
  st.issues.set(what, (st.issues.get(what) || 0) + 1);
}

function walkChildren(el, ctx, st) {
  for (const node of el.children) walkNode(node, ctx, st);
}

function walkNode(node, ctx, st) {
  switch (node.tagName) {
    case 'Transform':
      walkChildren(node, { ...ctx, m: ctx.m.clone().multiply(localMatrix(node)) }, st);
      break;
    case 'ForEachTransform': {
      const count = Math.min(num(node, 'count', 1), 512);
      let m = ctx.m.clone();
      for (let i = 0; i < count; i++) {
        walkChildren(node, { ...ctx, m: m.clone() }, st);
        m.multiply(localMatrix(node));
      }
      break;
    }
    case 'Entity':
      walkEntity(node, ctx, st);
      break;
    case 'Include':
      walkInclude(node, ctx, st);
      break;
    case 'Macro':
      st.macros.set(node.getAttribute('name'), { el: node, src: ctx.src });
      break;
    case 'Instance': {
      const name = node.getAttribute('macro');
      const def = st.macros.get(name);
      if (!def) { note(st, `unknown macro ${name}`); break; }
      if (ctx.depth > 24) break;
      const c2 = { ...ctx, src: def.src, depth: ctx.depth + 1, tags: [...ctx.tags, name] };
      // components can sit directly in a macro body (e.g. the pole tape
      // bands are a bare <RenderInstance> attached to the instancing entity);
      // processComponents and walkChildren handle disjoint tag sets
      processComponents(def.el, c2, st);
      walkChildren(def.el, c2, st);
      break;
    }
    default:                 // materials, SimC scripts, cameras... not scenery
      break;
  }
}

function walkEntity(node, ctx, st) {
  // entities holding a RenderInstanceGroup are mesh templates, not scenery
  if (directChild(node, 'RenderInstanceGroup')) {
    st.groups.set(node.getAttribute('name'), { el: node, src: ctx.src });
    return;
  }
  const name = node.getAttribute('name');
  let m = ctx.m;
  const wf = directChild(node, 'WorldFromEntityComponent');
  if (wf) m = m.clone().multiply(localMatrix(wf));
  let elem = ctx.elem;
  if (!elem && name && name !== 'Track') {
    elem = { name, tags: new Set(ctx.tags), prims: [], models: [], cps: [], sensors: [] };
    st.elements.push(elem);
  }
  const c2 = { ...ctx, m, parentM: ctx.m, elem, path: name ? [...ctx.path, name] : ctx.path };
  processComponents(node, c2, st);
  walkChildren(node, c2, st);
}

// handle the leaf components attached to one entity (shapes, renderers,
// checkpoints); child <Entity>/<Transform>s are handled by the walker
function processComponents(node, ctx, st) {
  const shapes = [];
  const models = [];
  const instRefs = [];
  let contact = null, material = null, hasCheckpoint = false;
  for (const c of node.children) {
    switch (c.tagName) {
      case 'Box':
        shapes.push({ shape: 'box', dims: [num(c, 'x'), num(c, 'y'), num(c, 'z')] });
        break;
      case 'Cylinder':
        shapes.push({ shape: 'cyl', dims: [num(c, 'radius'), num(c, 'height')] });
        break;
      case 'Sphere':
        shapes.push({ shape: 'sphere', dims: [num(c, 'radius')] });
        break;
      case 'Polyhedron': {
        const p = parseInlinePolyhedron(c);
        if (p) shapes.push(p);
        break;
      }
      case 'StaticContact': contact = c.getAttribute('contactMaterial'); break;
      case 'MeshRendererComponent': material = c.getAttribute('material'); break;
      case 'BinaryModelRenderer': models.push(c.getAttribute('file')); break;
      case 'RenderInstance': instRefs.push(c.getAttribute('group')); break;
      case 'Checkpoint': hasCheckpoint = true; break;
      case 'CheckpointList': parseCpList(c, st); break;
    }
  }
  const elem = ctx.elem;
  if (elem) ctx.tags.forEach(t => elem.tags.add(t));

  // a render-instance template with its own shapes (padded poles, tape bands)
  // replaces the entity's identical collision shapes — don't emit both
  const tplHasShapes = instRefs.some(g => {
    const tpl = st.groups.get(g);
    return tpl && (directChild(tpl.el, 'Box') || directChild(tpl.el, 'Cylinder'));
  });
  if (contact === '-1') {
    // sensor volume (checkpoint trigger) — invisible in-game, but kept so an
    // editor can show and manipulate the actual trigger extent
    for (const s of shapes) elem?.sensors.push({ ...s, m: ctx.m.clone(), src: ctx.src });
  } else if (!tplHasShapes) {
    for (const s of shapes) {
      if (!elem) { note(st, 'shape outside any entity'); continue; }
      elem.prims.push({
        ...s, m: ctx.m.clone(), hint: matHint(s.shape, s.dims, material, ctx.tags),
        material, src: ctx.src,   // the render material NAME, for exact-colour lookup
        solid: contact != null,   // render-only shapes carry no StaticContact
      });
    }
  }
  for (const f of models) {
    if (!elem) continue;
    elem.models.push({ model: basename(f).replace(/\.model$/, ''), m: ctx.m.clone(), src: ctx.src });
  }
  for (const g of instRefs) {
    const tpl = st.groups.get(g);
    if (!tpl) { note(st, `unknown instance group ${g}`); continue; }
    processComponents(tpl.el, ctx, st);
  }
  if (hasCheckpoint) {
    // MRSIM resolves the CheckpointReference (the ring position + crossing
    // normal) against the checkpoint entity's PARENT — it does NOT apply the
    // checkpoint entity's own WorldFromEntityComponent. Verified in-game: our
    // lifted `_pass` sensors drew the ring down at the gate base, and the
    // game's own gates always keep the checkpoint entity unshifted and carry
    // the offset on the reference (a full compose would put the hurdle ring
    // ~10 m up). Fall back to this entity's matrix if it has no reference child
    // or was reached outside the entity walker (macro/instance bodies).
    const refBase = ctx.parentM ?? ctx.m;
    let refM = ctx.m;
    for (const c of node.children) {
      if (c.tagName === 'Entity' && c.getAttribute('name') === 'CheckpointReference') {
        const wf = directChild(c, 'WorldFromEntityComponent');
        if (wf) refM = refBase.clone().multiply(localMatrix(wf));
      }
    }
    st.checkpoints.push({ path: ctx.path, m: ctx.m.clone(), refM, elem });
    elem?.cps.push(st.checkpoints.length - 1);
  }
}

// Inline <Polyhedron> — <Vertices count="N">x, y, z, …</Vertices> +
// <Triangles count="M">a, b, c, …</Triangles> children (the editor's pyramid/
// wedge/cone emit). Polyhedra that reference a binaryModelFile are the game
// gates' passage-geometry colliders and stay skipped, as before. The canonical
// editor shapes are recognised by their vertex/triangle structure so they
// round-trip through copy-to-builder; anything else renders as a raw mesh.
function parseInlinePolyhedron(el) {
  if (el.getAttribute('binaryModelFile')) return null;
  const numsOf = tag => {
    const c = directChild(el, tag);
    return c ? (c.textContent.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number) : [];
  };
  const verts = numsOf('Vertices'), tris = numsOf('Triangles');
  if (verts.length < 9 || verts.length % 3 || tris.length < 3) return null;
  let nx = Infinity, ny = Infinity, nz = Infinity, px = -Infinity, py = -Infinity, pz = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    nx = Math.min(nx, verts[i]);     px = Math.max(px, verts[i]);
    ny = Math.min(ny, verts[i + 1]); py = Math.max(py, verts[i + 1]);
    nz = Math.min(nz, verts[i + 2]); pz = Math.max(pz, verts[i + 2]);
  }
  const ext = [px - nx, py - ny, pz - nz];
  const n = verts.length / 3, t = tris.length / 3;
  // the editor's generators: pyramid = 4 base + apex; wedge = 6 verts / 8 tris;
  // cone = 16-gon + apex + base centre (see polyGeo in the editor)
  if (n === 5 && t === 6) return { shape: 'pyramid', dims: ext };
  if (n === 6 && t === 8) return { shape: 'wedge', dims: ext };
  if (n === 18 && t === 32) return { shape: 'cone', dims: [ext[0] / 2, ext[2]] };
  return { shape: 'poly', dims: ext, verts, tris };
}

function walkInclude(node, ctx, st) {
  const file = node.getAttribute('file') || '';
  const path = file.startsWith('/') ? file : dirname(ctx.src) + file;
  if (/\/Locations\//.test(path)) {
    // scenery worlds (Baylands Park...) — record the name, skip the content
    st.location ??= basename(path).replace(/\.xml$/, '').replace(/(?<=[a-z])(?=[A-Z])/g, ' ');
    return;
  }
  if (/Materials\.xml$|\/Foliage\/|Sound/.test(path)) return;
  const xml = MRSIM_LIB[path];
  if (!xml) { note(st, `unknown include ${path}`); return; }
  if (ctx.depth > 24) return;
  let doc = libDocs.get(path);
  if (!doc) {
    doc = parseXml(xml, path);
    libDocs.set(path, doc);
  }
  walkChildren(doc.documentElement, {
    ...ctx, src: path, depth: ctx.depth + 1, tags: [...ctx.tags, basename(path)],
  }, st);
}

function parseCpList(node, st) {
  const raw = node.textContent;
  try {
    // keys are unquoted (isCircuit:, checkpoints:) — JSON5-ish
    st.cpList = JSON.parse(raw.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '"$1":'));
  } catch {
    st.cpList = {
      isCircuit: /isCircuit\s*:\s*true/.test(raw),
      checkpoints: [...raw.matchAll(/"([^"]+)"/g)].map(m => m[1]),
    };
  }
}

function assemble(st, fileName) {
  const three = m => Z_UP_TO_Y_UP.clone().multiply(m);

  const kept = st.elements.filter(e =>
    e.prims.length || e.models.length || e.cps.length || e.sensors.length);
  const elemIndex = new Map(kept.map((e, i) => [e, i]));
  const elements = kept.map(e => ({
    name: e.name,
    // nothing to render + a checkpoint = a pure sensor, whatever produced it
    kind: !e.prims.length && !e.models.length && e.cps.length
      ? 'pass' : classify(e.tags),
    // start/finish gate: either built from a StartFinish library macro/include
    // (tag), or an editor-emitted/converted gate wearing the red start banner
    // material (GateStartBannerMaterial) — those carry no macro name.
    isStart: [...e.tags].some(t => /StartFinish/.test(t))
      || e.prims.some(p => /Start(Finish|Banner)/.test(p.material || '')),
    tags: [...e.tags],
    prims: e.prims.map(p => ({
      shape: p.shape, dims: p.dims, hint: p.hint, material: p.material, matrix: three(p.m), src: p.src,
      solid: p.solid !== false,
      ...(p.verts ? { verts: p.verts, tris: p.tris } : {}),
    })),
    models: e.models.map(md => ({ model: md.model, matrix: three(md.m), src: md.src })),
    sensors: e.sensors.map(s => ({
      shape: s.shape, dims: s.dims, matrix: three(s.m), src: s.src,
    })),
  }));

  // resolve the checkpoint sequence to world crossings
  const seq = [];
  (st.cpList?.checkpoints || []).forEach((name, i) => {
    const segs = name.split('.');
    const cp = st.checkpoints.find(c => contiguousRun(c.path, segs));
    if (!cp) { note(st, `unresolved checkpoint ${name}`); return; }
    // crossing frame comes from the CheckpointReference: its position is the
    // gate centre and its local +Y is the fly-through normal. Most references
    // are a pure offset (same orientation as the gate), but some — the dive
    // gate's rx=-90 — rotate the normal (straight down), so read both from it.
    const refM = three(cp.refM);
    seq.push({
      name,
      seqNum: i + 1,
      pos: new THREE.Vector3().setFromMatrixPosition(refM),
      dir: new THREE.Vector3().setFromMatrixColumn(refM, 1).normalize(),
      elemIndex: cp.elem != null && elemIndex.has(cp.elem) ? elemIndex.get(cp.elem) : -1,
    });
  });

  // "Track Name-author.xml" is the community file naming convention
  const stem = fileName.replace(/\.xml$/i, '');
  const dash = stem.lastIndexOf('-');
  const issues = [...st.issues.entries()].map(([k, n]) => `${k} ×${n}`);
  if (issues.length) console.warn('MRSIM import:', issues.join('; '));
  return {
    format: 'mrsim',
    meta: {
      name: dash > 0 ? stem.slice(0, dash) : stem,
      author: dash > 0 ? stem.slice(dash + 1) : undefined,
      location: st.location,
      isCircuit: !!st.cpList?.isCircuit,
      source: 'MRSIM track',
    },
    elements,
    seq,
    issues,
  };
}
