// Rigid-transform helpers on the game's 3x4 row-major matrices. No dependency on three.js, so the tests run in Node.
import type { Mat34, Vec3 } from './types.ts';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const IDENTITY: Mat34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** Rotation from game Euler degrees: R = Rz * Ry * Rx (X applied first), as sead's makeR. */
export function rotZYX(deg: Vec3): Mat34 {
  const [x, y, z] = deg.map((v) => v * D2R);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0,
    -sy, cy * sx, cy * cx, 0,
  ];
}

export function pose(pos: Vec3, rotDeg: Vec3): Mat34 {
  const m = rotZYX(rotDeg);
  m[3] = pos[0];
  m[7] = pos[1];
  m[11] = pos[2];
  return m;
}

export function translation(m: Mat34): Vec3 {
  return [m[3], m[7], m[11]];
}

/** Euler degrees (game order) of the rotation part of m. */
export function eulerZYX(m: Mat34): Vec3 {
  const r20 = Math.max(-1, Math.min(1, m[8]));
  const y = Math.asin(-r20);
  let x: number, z: number;
  if (Math.abs(Math.cos(y)) > 1e-6) {
    x = Math.atan2(m[9], m[10]);
    z = Math.atan2(m[4], m[0]);
  } else {
    z = 0;
    x = Math.atan2(-m[6], m[5]);
  }
  return [x * R2D, y * R2D, z * R2D];
}

export function mul(a: Mat34, b: Mat34): Mat34 {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 4 + k] * b[k * 4 + j];
      o[i * 4 + j] = s + (j === 3 ? a[i * 4 + 3] : 0);
    }
  }
  return o;
}

/** Inverse of a rigid transform (rotation transposed). */
export function inv(m: Mat34): Mat34 {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 4 + j] = m[j * 4 + i];
  for (let i = 0; i < 3; i++) o[i * 4 + 3] = -(o[i * 4] * m[3] + o[i * 4 + 1] * m[7] + o[i * 4 + 2] * m[11]);
  return o;
}

export function apply(m: Mat34, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ];
}

export function applyDir(m: Mat34, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

export function translate(m: Mat34, d: Vec3): Mat34 {
  const o = m.slice();
  o[3] += d[0];
  o[7] += d[1];
  o[11] += d[2];
  return o;
}

export const isIdentity = (m: Mat34) => IDENTITY.every((v, i) => Math.abs(m[i] - v) < 1e-6);

/** Largest element difference between two matrices. */
export function maxDiff(a: Mat34, b: Mat34): number {
  let d = 0;
  for (let i = 0; i < 12; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

export const round = (x: number, digits = 4) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
