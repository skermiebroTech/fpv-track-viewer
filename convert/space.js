// ===========================================================================
// Coordinate, rotation and unit conversions between the three track spaces.
//
// VelociDrone: Unity left-handed Y-up, integer centimetres, quaternions
//   stored as int×1000 in (w, x, y, z) order.
// three.js:    right-handed Y-up, metres (the common interchange space —
//   the same maths the viewer uses in app.js).
// MRSIM:       right-handed Z-up, metres, axis-angle rotations.
//
//   VD (x, y, z)    -> three (x/100, y/100, -z/100)
//   MRSIM (x, y, z) -> three (x, z, -y)
// ===========================================================================
import * as THREE from 'three';

export const CM = 0.01;
export const X_AXIS = new THREE.Vector3(1, 0, 0);
export const Z_AXIS = new THREE.Vector3(0, 0, 1);

// --- VelociDrone raw values <-> three.js space -----------------------------
export const vdVec = pos => new THREE.Vector3(pos[0] * CM, pos[1] * CM, -pos[2] * CM);
export const vdQuat = rot => {
  const [w, x, y, z] = rot;
  return new THREE.Quaternion(-x / 1000, -y / 1000, z / 1000, w / 1000).normalize();
};
export const vdPosOut = v => [Math.round(v.x * 100), Math.round(v.y * 100), Math.round(-v.z * 100)];
export const vdRotOut = q => [
  Math.round(q.w * 1000), Math.round(-q.x * 1000),
  Math.round(-q.y * 1000), Math.round(q.z * 1000),
];

// --- three.js Y-up <-> MRSIM Z-up ------------------------------------------
export const toMrsim = v => new THREE.Vector3(v.x, -v.z, v.y);
export const fromMrsim = v => new THREE.Vector3(v.x, v.z, -v.y);

// full orientation change of basis: a three-space rotation becomes the MRSIM
// rotation with the same physical effect (three local x/y/z <-> mrsim x/z/-y)
const Q_ZUP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_ZUP_INV = Q_ZUP.clone().invert();
export const mrsimQuat = q => Q_ZUP_INV.clone().multiply(q).multiply(Q_ZUP);

// upright orientation whose local +Z crosses along dir (yaw, then pitch —
// never rolls, which is what a physical gate/checkpoint would do)
export function quatFromDir(dir) {
  const yaw = (Math.abs(dir.x) + Math.abs(dir.z)) > 1e-6 ? Math.atan2(dir.x, dir.z) : 0;
  const pitch = -Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

// compact number formatting for XML attributes (3 dp, no trailing zeros)
export const fmt = n => {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

// axis-angle Transform attributes for an MRSIM-space quaternion
export function attrsFromQuat(q) {
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
export function rotAttrs(dirM, yawOnly = false) {
  const d = dirM.clone().normalize();
  if (yawOnly || Math.abs(d.z) < 1e-4) {
    const yaw = Math.atan2(d.x, d.y);   // +Y about -Z by yaw -> (sin,cos)=(x,y)
    if (Math.abs(yaw) < 1e-4) return '';
    return ` rz="-1" angleDegrees="${fmt(yaw * 180 / Math.PI)}"`;
  }
  return attrsFromQuat(rotQuatForDir(dirM, yawOnly));
}

// the exact MRSIM-space rotation rotAttrs encodes (for predicting where a
// rotated child — e.g. a gate macro's CheckpointReference — ends up)
export function rotQuatForDir(dirM, yawOnly = false) {
  const d = dirM.clone().normalize();
  if (yawOnly || Math.abs(d.z) < 1e-4) {
    const yaw = Math.atan2(d.x, d.y);
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), yaw);
  }
  const yaw = Math.atan2(-d.x, d.y);
  const pitch = Math.asin(THREE.MathUtils.clamp(d.z, -1, 1));
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
}
