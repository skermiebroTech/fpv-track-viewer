// ===========================================================================
// Track format converter: VelociDrone <-> MRSIM.
//
// The two sims describe tracks very differently, so conversion is driven by
// what actually defines the race: the ordered checkpoint crossings (position
// + crossing direction), plus the object type at each one.
//
//   VelociDrone            MRSIM
//   ------------------     ---------------------------------------------
//   gate prefab (285)  <-> 7x6 gate (2.1 m aperture, closest to VD's 2 m)
//   window/dive (286)  <-> 7x6 gate placed with the same tilt
//   4 m flag (170)     <-> Flag.xml + a 4 m-wide sensor plane at 1.5 m
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
// `classify` is the viewer's prefab classifier: gate id -> kind
// ('gate' | 'dive' | 'flag' | 'checkpoint' | 'tool');
// `prefabName` maps a prefab id to its catalog name (for barrier mapping).
export function vdToMrsim(data, classify, prefabName = () => '', opts = {}) {
  const location = opts.location || 'EmptyGrassWorld';
  const seq = [...data.gates].sort((a, b) => a.gate - b.gate);
  if (!seq.length) throw new Error('track has no gates to convert');
  const kinds = seq.map(g => classify(g));
  // lift everything so the lowest raceable object sits on MRSIM's z=0 ground
  // (editor helpers like control curves must not skew the offset)
  const raceable = seq.filter((g, i) => kinds[i] !== 'tool');
  const groundY = Math.min(0, ...raceable.map(g => g.trans.pos[1] * CM));

  // axis-angle Transform attributes for an MRSIM-space quaternion
  function attrsFromQuat(q) {
    if (q.w < 0) { q = q.clone(); q.x *= -1; q.y *= -1; q.z *= -1; q.w *= -1; }
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
    if (angle < 1e-4) return '';
    const s = Math.sqrt(Math.max(1e-12, 1 - q.w * q.w));
    return ` rx="${fmt(q.x / s)}" ry="${fmt(q.y / s)}" rz="${fmt(q.z / s)}"` +
      ` angleDegrees="${fmt(angle * 180 / Math.PI)}"`;
  }

  // MRSIM rotation attributes for a mrsim-space direction the local +Y
  // (its crossing axis) should point along: yaw about Z then pitch about
  // the yawed X — never rolls, like a physical gate would stand
  function rotAttrs(dirM, yawOnly = false) {
    const d = dirM.clone().normalize();
    if (yawOnly || Math.abs(d.z) < 1e-6) {
      const yaw = Math.atan2(-d.x, d.y);
      if (Math.abs(yaw) < 1e-4) return '';
      return ` rz="1" angleDegrees="${fmt(yaw * 180 / Math.PI)}"`;
    }
    const yaw = (Math.abs(d.x) + Math.abs(d.y)) > 1e-6 ? Math.atan2(-d.x, d.y) : 0;
    const pitch = Math.asin(THREE.MathUtils.clamp(d.z, -1, 1));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
    return attrsFromQuat(q);
  }

  const parts = [];
  const cpNames = [];
  const warnings = [];
  let nGate = 0, nFlag = 0, nCheck = 0, scaled = 0;
  let first = null;   // {pos three, dir three} of the first crossing (start area)

  // MRSIM's flag is ~3.3 m; VD flags are 4 m x scale. Taller ones go on a
  // pole riser so the cloth tops out at the right height.
  function flagVisualXml(H) {
    if (H <= 3.5) {
      return `        <Include file="/Data/Simulations/Multirotor/Flag.xml"/>`;
    }
    const r = H - 3.3;
    return `        <Entity>
          <WorldFromEntityComponent z="${fmt(r / 2)}"/>
          <Cylinder radius=".02" height="${fmt(r)}"/>
          <StaticContact contactMaterial="TrackPart"/>
          <MeshRendererComponent material="FlagPoleRiserMaterial" subdivisions="8"/>
        </Entity>
        <Transform z="${fmt(r)}">
          <Include file="/Data/Simulations/Multirotor/Flag.xml"/>
        </Transform>`;
  }

  seq.forEach((g, i) => {
    const kind = kinds[i];
    if (kind === 'tool') return;
    const p = vdVec(g.trans.pos); p.y -= groundY;
    const q = vdQuat(g.trans.rot);
    const dir = Z_AXIS.clone().applyQuaternion(q);
    const sy = (g.trans.scale?.[1] ?? 100) / 100;
    if (kind !== 'checkpoint' && Math.abs((g.trans.scale?.[0] ?? 100) - 100) > 15) scaled++;
    first ??= { pos: p.clone(), dir: dir.clone() };
    const pm = toMrsim(p);
    const dm = toMrsim(dir);

    if (kind === 'flag') {
      const nm = `trkFlag${++nFlag}`;
      // VD flags trigger on a plane at the pole (either side): flag visual
      // at the VD height + a 4 m sensor centred on the pole
      parts.push(
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"${rotAttrs(dm, true)}>
      <Entity name="${nm}">
${flagVisualXml(4 * sy)}
        <Entity name="${nm}_pass">
          <WorldFromEntityComponent z="1.5"/>
          <Box x="4" y=".01" z="3"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      cpNames.push(nm);
    } else if (kind === 'checkpoint') {
      const nm = `trkCheck${++nCheck}`;
      // VD invisible checkpoints: ring centre sits GATE_SIZE*scale/2 up the
      // local Y axis from the stored base position (giant helper planes
      // stay near the ground, same reading as the viewer's racing line).
      // Structured exactly like the game's own passage objects: a named
      // wrapper whose inner entity carries the sensor + <Checkpoint>.
      const c = sy <= 3
        ? p.clone().add(new THREE.Vector3(0, sy, 0).applyQuaternion(q))
        : p.clone().add(new THREE.Vector3(0, 1, 0));
      const cm2 = toMrsim(c);
      const size = Math.min(20, 2 * sy);
      parts.push(
        `    <Transform x="${fmt(cm2.x)}" y="${fmt(cm2.y)}" z="${fmt(cm2.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Entity>
          <WorldFromEntityComponent/>
          <Box x="${fmt(size)}" y=".01" z="${fmt(size)}"/>
          <StaticContact contactMaterial="-1"/>
          <Entity name="CheckpointReference">
            <WorldFromEntityComponent/>
          </Entity>
          <Checkpoint/>
        </Entity>
      </Entity>
    </Transform>`);
      cpNames.push(nm);
    } else {   // gate / dive
      const nm = `trkGate${++nGate}`;
      const isSF = g.start || g.finish;
      parts.push(
        `    <Transform x="${fmt(pm.x)}" y="${fmt(pm.y)}" z="${fmt(pm.z)}"${rotAttrs(dm)}>
      <Entity name="${nm}">
        <Instance macro="${isSF ? 'Centered7x6StartFinishGate' : 'Centered7x6Gate'}"/>
      </Entity>
    </Transform>`);
      cpNames.push(nm);
    }
  });
  if (!cpNames.length) throw new Error('no convertible gates in this track');
  if (scaled) warnings.push(`${scaled} scaled gate(s) exported at MRSIM's fixed size`);

  // ---- barriers: blocks become boxes, hurdles panels, flags flags ----
  // (in VD the dive-gate towers and hurdles are scenery; the lap itself only
  // references invisible checkpoints placed at them)
  let nBlock = 0, nHurdle = 0, nDeco = 0;
  const skipped = new Map();
  const usedBlocks = new Set();
  (data.barriers || []).forEach(b => {
    const name = prefabName(b.prefab) || '';
    const p = vdVec(b.trans.pos); p.y -= groundY;
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
      const nm = `decoFlag${++nDeco}`;
      const dir = Z_AXIS.clone().applyQuaternion(q);
      parts.push(
        `    <Transform ${at}${rotAttrs(toMrsim(dir), true)}>
      <Entity name="${nm}">
${flagVisualXml(4 * sy)}
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
  const spawnYaw = Math.atan2(-fm.x, fm.y) * 180 / Math.PI;

  const xml = `<Simulation>
  <!-- Converted from VelociDrone by track-viewer -->
  <Include file="/Data/Simulations/Multirotor/Locations/${location}.xml"/>
  <Include file="/Data/Simulations/Multirotor/DroneTrackInstanceGroups.xml"/>
  <Include file="/Data/Simulations/Multirotor/Gates/PoleGates.xml"/>

  <Macro name="Centered7x6Gate">
    <Transform x="-1.5">
      <Include file="/Data/Simulations/Multirotor/7x6Gate.xml"/>
    </Transform>
  </Macro>
  <Macro name="Centered7x6StartFinishGate">
    <Transform x="-1.5">
      <Include file="/Data/Simulations/Multirotor/7x6StartFinishGate.xml"/>
    </Transform>
  </Macro>

${[...usedBlocks].map(id => {
    const [nm, [r, g, bl]] = VD_BLOCKS[id];
    return `  <Material name="Block${nm}Material">
    {
        definition: "PBR",
        uniforms: { baseColor: [${r}, ${g}, ${bl}], roughness: .8, metallic: 0 }
    }
  </Material>`;
  }).join('\n')}
  <Material name="HurdlePanelMaterial">
    {
        definition: "PBR",
        uniforms: { baseColor: [.6, .6, .6], roughness: .4, metallic: 0 }
    }
  </Material>
  <Material name="FlagPoleRiserMaterial">
    {
        definition: "PBR",
        uniforms: { baseColor: [.05, .05, .05], roughness: .5, metallic: 0 }
    }
  </Material>

  <Entity name="Track">
    <Transform x="${fmt(bm.x)}" y="${fmt(bm.y)}" rz="1" angleDegrees="${fmt(spawnYaw)}">
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
          isCircuit: true,
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
