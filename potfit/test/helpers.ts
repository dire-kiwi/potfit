// Synthetic pots with known dimensions, built as surfaces of revolution.

export interface PotSpec {
  /** Outer radius at the base and rim, height, wall and floor thickness. */
  r0: number;
  r1: number;
  h: number;
  wall: number;
  floor: number;
  /** Radius of a drainage hole through the floor (0 for none). */
  hole?: number;
  segments?: number;
}

/** Inner (cavity) radius at height y above the pot's bottom. */
export function innerRadius(p: PotSpec, y: number): number {
  const a = p.r0 - p.wall, b = p.r1 - p.wall;
  return a + ((b - a) * (y - p.floor)) / (p.h - p.floor);
}

/**
 * Closed, outward-facing triangle soup of the pot with +Y up, bottom at y = 0,
 * centred on the Y axis.
 */
export function latheY(p: PotSpec): Float32Array {
  const seg = p.segments ?? 256;
  const hole = p.hole ?? 0;
  const profile: [number, number][] = [
    [hole, 0],
    [p.r0, 0],
    [p.r1, p.h],
    [p.r1 - p.wall, p.h],
    [p.r0 - p.wall, p.floor],
    [hole, p.floor],
  ];
  const out: number[] = [];
  const pt = (i: number, k: number) => {
    const [r, y] = profile[i % profile.length];
    const a = (2 * Math.PI * k) / seg;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  };
  for (let i = 0; i < profile.length; i++) {
    for (let k = 0; k < seg; k++) {
      const a = pt(i, k), b = pt(i, k + 1), c = pt(i + 1, k + 1), d = pt(i + 1, k);
      out.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  }
  return new Float32Array(out);
}

/** Map +Y-up coordinates to +Z-up, as an STL from a CAD tool would be. */
export function yToZ(pos: Float32Array): Float32Array {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = pos[i];
    out[i + 1] = -pos[i + 2];
    out[i + 2] = pos[i + 1];
  }
  return out;
}

export function translate(pos: Float32Array, x: number, y: number, z: number): Float32Array {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = pos[i] + x;
    out[i + 1] = pos[i + 1] + y;
    out[i + 2] = pos[i + 2] + z;
  }
  return out;
}
