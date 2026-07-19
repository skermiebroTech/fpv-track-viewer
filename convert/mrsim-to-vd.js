// ===========================================================================
// MRSIM (parsed by mrsim.js) -> VelociDrone track JSON.
//
// Driven by the parsed checkpoint sequence (position + crossing direction per
// visit). First visits of visible elements become visible VD objects; repeat
// visits (cubes, double-sided gates) become invisible VD checkpoints so the
// lap sequence is preserved exactly.
// ===========================================================================
import * as THREE from 'three';
import { vdPosOut, vdRotOut, quatFromDir } from './space.js';
import { VD, VD_SCENES } from './mapping.js';

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
    // a circuit closes the lap on the start gate; a sprint finishes on the
    // LAST checkpoint — VD encodes that as a finish flag on a different gate
    const isCircuit = data.meta.isCircuit !== false;
    gates.push({
      prefab,
      trans: { pos: vdPosOut(pos), rot: vdRotOut(q), scale: [100, 100, 100] },
      gate: i,
      start: i === 0,
      finish: isCircuit ? i === 0 : i === data.seq.length - 1,
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
