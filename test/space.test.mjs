import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import * as THREE from 'three';
import {
  vdVec, vdQuat, vdPosOut, vdRotOut, toMrsim, fromMrsim, mrsimQuat,
  quatFromDir, fmt, attrsFromQuat, rotAttrs, rotQuatForDir,
} from '../convert/space.js';

test('VD position cm -> three m round trip', () => {
  const raw = [1234, -567, 8901];
  assert.deepEqual(vdPosOut(vdVec(raw)), raw);
  const v = vdVec([100, 200, 300]);
  assert.deepEqual([v.x, v.y, v.z], [1, 2, -3]);   // z mirrored
});

test('VD quaternion (w,x,y,z)*1000 round trip and axis convention', () => {
  const raw = [819, -574, 0, 0];                    // 70° about X
  const q = vdQuat(raw);
  const back = vdRotOut(q);
  raw.forEach((v, i) => assert.ok(Math.abs(back[i] - v) <= 1, `${back[i]} vs ${v}`));
  // a VD yaw-90 quaternion turns +Z into +X in three space
  const d = new THREE.Vector3(0, 0, 1).applyQuaternion(vdQuat([707, 0, -707, 0]));
  assert.ok(d.distanceTo(new THREE.Vector3(1, 0, 0)) < 0.01);
});

test('three <-> MRSIM axis mapping is inverse and orientation-preserving', () => {
  const v = new THREE.Vector3(1, 2, 3);
  assert.ok(fromMrsim(toMrsim(v)).distanceTo(v) < 1e-12);
  // three up (0,1,0) becomes mrsim up (0,0,1)
  assert.ok(toMrsim(new THREE.Vector3(0, 1, 0)).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-12);
});

test('mrsimQuat change of basis preserves physical rotations', () => {
  // a yaw about three-up must become a yaw about mrsim-up
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
  const m = mrsimQuat(yaw);
  const rotated = toMrsim(new THREE.Vector3(0, 0, 1)).applyQuaternion(m);
  const expected = toMrsim(new THREE.Vector3(0, 0, 1).applyQuaternion(yaw));
  assert.ok(rotated.distanceTo(expected) < 1e-6);
});

test('quatFromDir yaws and pitches without roll', () => {
  const dir = new THREE.Vector3(1, -0.5, 0.3).normalize();
  const q = quatFromDir(dir);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  assert.ok(z.distanceTo(dir) < 1e-6);
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  assert.ok(Math.abs(x.y) < 1e-6, 'local X stays level (no roll)');
});

test('fmt trims and never emits -0', () => {
  assert.equal(fmt(1.5), '1.5');
  assert.equal(fmt(2), '2');
  assert.equal(fmt(-0.0001), '0');
  assert.equal(fmt(1.23456), '1.235');
});

test('attrsFromQuat: identity is empty, negative w normalised', () => {
  assert.equal(attrsFromQuat(new THREE.Quaternion()), '');
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1);
  const neg = q.clone(); neg.x *= -1; neg.y *= -1; neg.z *= -1; neg.w *= -1;
  assert.equal(attrsFromQuat(q), attrsFromQuat(neg));
});

test('rotAttrs yaw-only form matches the editors\' rz="-1" convention', () => {
  const a = rotAttrs(new THREE.Vector3(1, 1, 0).normalize(), true);
  assert.match(a, /rz="-1" angleDegrees="45"/);
  assert.equal(rotAttrs(new THREE.Vector3(0, 1, 0), true), '');   // straight ahead
});

test('rotQuatForDir agrees with rotAttrs in both branches', () => {
  for (const [d, yawOnly] of [
    [new THREE.Vector3(0.5, 1, 0).normalize(), true],
    [new THREE.Vector3(0.5, 1, 0.6).normalize(), false],
  ]) {
    const q = rotQuatForDir(d, yawOnly);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);   // mrsim crossing axis
    if (yawOnly) {
      assert.ok(Math.hypot(y.x - d.x, y.y - d.y) < 1e-6);
    } else {
      assert.ok(y.distanceTo(d) < 1e-6);
    }
  }
});
