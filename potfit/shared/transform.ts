import type { PotTransform, UpAxis, Vec3 } from './types.ts';

/** Row-major 3x3 rotations taking each raw axis onto +Y. */
const UP_ROTATIONS: Record<UpAxis, readonly number[]> = {
  '+Y': [1, 0, 0, 0, 1, 0, 0, 0, 1],
  '-Y': [1, 0, 0, 0, -1, 0, 0, 0, -1],
  '+Z': [1, 0, 0, 0, 0, 1, 0, -1, 0], // (x, y, z) -> (x, z, -y)
  '-Z': [1, 0, 0, 0, 0, -1, 0, 1, 0], // (x, y, z) -> (x, -z, y)
  '+X': [0, -1, 0, 1, 0, 0, 0, 0, 1], // (x, y, z) -> (-y, x, z)
  '-X': [0, 1, 0, -1, 0, 0, 0, 0, 1], // (x, y, z) -> (y, -x, z)
};

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function identityTransform(up: UpAxis = '+Z'): PotTransform {
  return { up, spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

export function cloneTransform(t: PotTransform): PotTransform {
  return { up: t.up, spin: t.spin, position: { ...t.position }, scale: { ...t.scale } };
}

export function transformsEqual(a: PotTransform, b: PotTransform, eps = 1e-6): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) <= eps;
  return (
    a.up === b.up &&
    close(a.spin, b.spin) &&
    close(a.position.x, b.position.x) &&
    close(a.position.y, b.position.y) &&
    close(a.position.z, b.position.z) &&
    close(a.scale.x, b.scale.x) &&
    close(a.scale.y, b.scale.y) &&
    close(a.scale.z, b.scale.z)
  );
}

export function computeBounds(positions: Float32Array): Bounds {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min.x) min.x = x;
    if (x > max.x) max.x = x;
    if (y < min.y) min.y = y;
    if (y > max.y) max.y = y;
    if (z < min.z) min.z = z;
    if (z > max.z) max.z = z;
  }
  return { min, max };
}

function rotate(m: readonly number[], v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/** Bounds of the raw model after only the up-axis rotation (it permutes axes, so this is exact). */
export function orientedBounds(raw: Bounds, up: UpAxis): Bounds {
  const m = UP_ROTATIONS[up];
  const corners = [
    rotate(m, raw.min),
    rotate(m, raw.max),
  ];
  return {
    min: {
      x: Math.min(corners[0].x, corners[1].x),
      y: Math.min(corners[0].y, corners[1].y),
      z: Math.min(corners[0].z, corners[1].z),
    },
    max: {
      x: Math.max(corners[0].x, corners[1].x),
      y: Math.max(corners[0].y, corners[1].y),
      z: Math.max(corners[0].z, corners[1].z),
    },
  };
}

/** Bottom centre of the up-rotated bounding box: the point `position` refers to. */
export function anchorFor(raw: Bounds, up: UpAxis): Vec3 {
  const b = orientedBounds(raw, up);
  return { x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 };
}

/**
 * Row-major 3x4 affine matrix [L | t] mapping raw model coordinates to the pot
 * frame, as described on PotTransform.
 */
export function transformMatrix(t: PotTransform, raw: Bounds): number[] {
  const u = UP_ROTATIONS[t.up];
  const a = anchorFor(raw, t.up);
  const th = (t.spin * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  // spinY = [c 0 s; 0 1 0; -s 0 c]
  const spin = [c, 0, s, 0, 1, 0, -s, 0, c];
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = spin[i * 3] * u[j] + spin[i * 3 + 1] * u[3 + j] + spin[i * 3 + 2] * u[6 + j];
    }
  }
  // world = P + S * spin * (U * v - a)  =>  L = S * spin * U, t = P - S * spin * a
  const sa = rotate(spin, a);
  const sc = [t.scale.x, t.scale.y, t.scale.z];
  const p = [t.position.x, t.position.y, t.position.z];
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(sc[i] * r[i * 3], sc[i] * r[i * 3 + 1], sc[i] * r[i * 3 + 2], p[i] - sc[i] * [sa.x, sa.y, sa.z][i]);
  }
  return out;
}

/** Apply a 3x4 row-major affine matrix to a flat xyz array. */
export function applyMatrix(positions: Float32Array, m: number[]): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  return out;
}

export function applyTransform(positions: Float32Array, t: PotTransform, raw?: Bounds): Float32Array {
  return applyMatrix(positions, transformMatrix(t, raw ?? computeBounds(positions)));
}

/** Inverse of a 3x4 row-major affine matrix (its 3x3 part must be invertible). */
export function invertMatrix(m: number[]): number[] {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error('the transform is not invertible');
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  const t = [tx, ty, tz];
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    out.push(inv[r * 3], inv[r * 3 + 1], inv[r * 3 + 2], -(inv[r * 3] * t[0] + inv[r * 3 + 1] * t[1] + inv[r * 3 + 2] * t[2]));
  }
  return out;
}

/**
 * The transform that places a mesh whose bounds changed (it was edited) exactly
 * where `t` placed it before: `position` refers to the bounding box's bottom
 * centre, so it moves with the bounds.
 */
export function reanchor(t: PotTransform, before: Bounds, after: Bounds): PotTransform {
  const a = anchorFor(before, t.up), b = anchorFor(after, t.up);
  const th = (t.spin * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const spun = { x: c * d.x + s * d.z, y: d.y, z: -s * d.x + c * d.z };
  return {
    ...t,
    position: { x: t.position.x + t.scale.x * spun.x, y: t.position.y + t.scale.y * spun.y, z: t.position.z + t.scale.z * spun.z },
    scale: { ...t.scale },
  };
}

/** Pot frame (Y up) to the Z-up frame slicers expect. */
export function yUpToZUp(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i];
    out[i + 1] = -positions[i + 2];
    out[i + 2] = positions[i + 1];
  }
  return out;
}

/** The inverse of yUpToZUp. */
export function zUpToYUp(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i];
    out[i + 1] = positions[i + 2];
    out[i + 2] = -positions[i + 1];
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate an untrusted transform (from the API or Codex). Returns an error message or null. */
export function validateTransform(t: unknown): string | null {
  if (!t || typeof t !== 'object') return 'transform must be an object';
  const o = t as Record<string, unknown>;
  if (!['+X', '-X', '+Y', '-Y', '+Z', '-Z'].includes(o.up as string)) return 'transform.up must be one of +X -X +Y -Y +Z -Z';
  if (!finite(o.spin)) return 'transform.spin must be a number';
  for (const key of ['position', 'scale'] as const) {
    const v = o[key] as Record<string, unknown> | undefined;
    if (!v || !finite(v.x) || !finite(v.y) || !finite(v.z)) return `transform.${key} needs numeric x, y and z`;
  }
  const s = o.scale as Vec3;
  if (s.x <= 0 || s.y <= 0 || s.z <= 0) return 'transform.scale components must be positive';
  return null;
}
