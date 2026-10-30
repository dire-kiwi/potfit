// Horizontal slicing of triangle soup around a vertical axis.
//
// A slice at height h cuts every triangle that has vertices both below h and
// at-or-above h, giving line segments in the XZ plane. For each slice we keep
// the nearest distance from the axis to any segment (the free radius of the
// cavity), the farthest endpoint (outer radius) and ray-crossing counts, which
// tell us whether the axis is inside solid material or surrounded by a wall.

export interface Grid {
  y0: number;
  step: number;
  n: number;
}

export interface Profile extends Grid {
  heights: Float64Array;
  /** Free radius around the axis: 0 inside material, Infinity where nothing is cut. */
  cavity: Float64Array;
  /** Farthest section point from the axis (0 where nothing is cut). */
  outer: Float64Array;
  /** 1 if the section surrounds the axis in +x, -x, +z and -z. */
  enclosed: Uint8Array;
}

export interface Frustum {
  /** Base radius, rim radius and height. */
  rb: number;
  rt: number;
  h: number;
}

/**
 * Slice positions strictly inside (minY, maxY) at roughly `targetStep` spacing,
 * with at least 200 slices (for models in metres) and at most `maxSlices`.
 */
export function gridFor(minY: number, maxY: number, targetStep = 0.2, maxSlices = 3000): Grid {
  const span = Math.max(maxY - minY, 1e-6);
  const step = Math.max(Math.min(targetStep, span / 200), span / maxSlices);
  const n = Math.max(1, Math.floor(span / step));
  return { y0: minY + step / 2, step, n };
}

export function sliceProfile(pos: Float32Array, grid: Grid, cx = 0, cz = 0): Profile {
  const { y0, step, n } = grid;
  const minD2 = new Float64Array(n).fill(Infinity);
  const maxD2 = new Float64Array(n);
  const cuts = new Int32Array(n);
  const xPos = new Int32Array(n), xNeg = new Int32Array(n), zPos = new Int32Array(n), zNeg = new Int32Array(n);

  for (let t = 0; t + 8 < pos.length; t += 9) {
    const ay = pos[t + 1], by = pos[t + 4], cy = pos[t + 7];
    const ymin = Math.min(ay, by, cy), ymax = Math.max(ay, by, cy);
    // Slices with ymin < h <= ymax cut this triangle. The range is padded by
    // one because the division can round either way when a vertex sits exactly
    // on a slice; the per-vertex test below decides.
    let i0 = Math.floor((ymin - y0) / step);
    let i1 = Math.floor((ymax - y0) / step) + 1;
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    if (i0 > i1) continue;
    const ax = pos[t] - cx, az = pos[t + 2] - cz;
    const bx = pos[t + 3] - cx, bz = pos[t + 5] - cz;
    const ccx = pos[t + 6] - cx, ccz = pos[t + 8] - cz;
    for (let i = i0; i <= i1; i++) {
      const h = y0 + i * step;
      const aB = ay < h, bB = by < h, cB = cy < h;
      // Pick the vertex on its own side of the plane (p) and the other two (q, r).
      let px, py, pz, qx, qy, qz, rx, ry, rz;
      if (aB !== bB && aB !== cB) {
        px = ax; py = ay; pz = az; qx = bx; qy = by; qz = bz; rx = ccx; ry = cy; rz = ccz;
      } else if (bB !== aB && bB !== cB) {
        px = bx; py = by; pz = bz; qx = ax; qy = ay; qz = az; rx = ccx; ry = cy; rz = ccz;
      } else if (cB !== aB && cB !== bB) {
        px = ccx; py = cy; pz = ccz; qx = ax; qy = ay; qz = az; rx = bx; ry = by; rz = bz;
      } else {
        continue;
      }
      // Always interpolate from the lower vertex of an edge so that the two
      // triangles sharing it produce bit-identical cut points; otherwise the
      // crossing counts below can disagree and flip the inside test.
      let x1, z1, x2, z2;
      if (py < h) {
        const s1 = (h - py) / (qy - py), s2 = (h - py) / (ry - py);
        x1 = px + (qx - px) * s1; z1 = pz + (qz - pz) * s1;
        x2 = px + (rx - px) * s2; z2 = pz + (rz - pz) * s2;
      } else {
        const s1 = (h - qy) / (py - qy), s2 = (h - ry) / (py - ry);
        x1 = qx + (px - qx) * s1; z1 = qz + (pz - qz) * s1;
        x2 = rx + (px - rx) * s2; z2 = rz + (pz - rz) * s2;
      }
      cuts[i]++;

      // Nearest point on the segment to the axis.
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz;
      let u = len2 > 0 ? -(x1 * dx + z1 * dz) / len2 : 0;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const nx = x1 + dx * u, nz = z1 + dz * u;
      const d2 = nx * nx + nz * nz;
      if (d2 < minD2[i]) minD2[i] = d2;
      const e1 = x1 * x1 + z1 * z1, e2 = x2 * x2 + z2 * z2;
      const e = e1 > e2 ? e1 : e2;
      if (e > maxD2[i]) maxD2[i] = e;

      // Half-open crossing tests for rays from the axis along +-x and +-z.
      if (z1 > 0 !== z2 > 0) {
        const xi = x1 + (0 - z1) * dx / dz;
        if (xi > 0) xPos[i]++; else xNeg[i]++;
      }
      if (x1 > 0 !== x2 > 0) {
        const zi = z1 + (0 - x1) * dz / dx;
        if (zi > 0) zPos[i]++; else zNeg[i]++;
      }
    }
  }

  const heights = new Float64Array(n);
  const cavity = new Float64Array(n);
  const outer = new Float64Array(n);
  const enclosed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    heights[i] = y0 + i * step;
    if (cuts[i] === 0) {
      cavity[i] = Infinity;
      continue;
    }
    // Inside material when the rays agree the crossing count is odd; a vote
    // keeps one bad crossing (open or self-intersecting meshes) from turning
    // a slice of the cavity solid.
    const inside = (xPos[i] & 1) + (xNeg[i] & 1) + (zPos[i] & 1) + (zNeg[i] & 1) >= 3;
    cavity[i] = inside ? 0 : Math.sqrt(minD2[i]);
    outer[i] = Math.sqrt(maxD2[i]);
    enclosed[i] = xPos[i] > 0 && xNeg[i] > 0 && zPos[i] > 0 && zNeg[i] > 0 ? 1 : 0;
  }
  return { y0, step, n, heights, cavity, outer, enclosed };
}

/** Largest finite free radius among slices where a wall surrounds the axis. */
export function maxCavity(p: Profile): number {
  let m = 0;
  for (let i = 0; i < p.n; i++) {
    if (p.enclosed[i] && Number.isFinite(p.cavity[i]) && p.cavity[i] > m) m = p.cavity[i];
  }
  return m;
}

export interface Floor {
  /** Index of the highest slice in the floor. */
  index: number;
  /** Estimated height of the floor surface. */
  top: number;
}

/**
 * Walk down from the rim until the free radius drops below 30% of the widest
 * cavity: that is the floor (solid, or a drainage hole too small to matter).
 */
export function findFloor(p: Profile, relThreshold = 0.3): Floor | null {
  const threshold = maxCavity(p) * relThreshold;
  if (threshold <= 0) {
    // No cavity anywhere: the top of the solid is the floor.
    for (let i = p.n - 1; i >= 0; i--) if (Number.isFinite(p.cavity[i])) return { index: i, top: p.heights[i] };
    return null;
  }
  let i = p.n - 1;
  while (i >= 0 && !Number.isFinite(p.cavity[i])) i--;
  for (; i >= 0; i--) {
    // The floor surface lies between this slice and the cavity slice above it.
    if (p.cavity[i] < threshold) return { index: i, top: p.heights[i] + (i < p.n - 1 ? p.step / 2 : 0) };
  }
  return null;
}

export interface Seat {
  /** Height of the frustum base when it comes to rest; -Infinity if it falls straight through. */
  seat: number;
  /** Height of the slice that stopped it. */
  stoppedAt: number | null;
}

/**
 * Lower a frustum down the axis from above and report where it first meets
 * the walls, keeping `radialClear` between frustum and wall. Heights and radii
 * of the profile are multiplied by `sh` and `sr` first, so a profile measured
 * at scale 1 can be reused while searching for a scale.
 */
export function descentSeat(p: Profile, f: Frustum, radialClear: number, sr = 1, sh = 1): Seat {
  let seat = -Infinity;
  let stoppedAt: number | null = null;
  const taper = f.rt - f.rb;
  for (let i = 0; i < p.n; i++) {
    const cav = p.cavity[i];
    if (cav === Infinity) continue;
    const allowed = cav * sr - radialClear;
    let tViol: number;
    if (f.rb > allowed) tViol = 0;
    else if (f.rt > allowed) tViol = ((allowed - f.rb) / taper) * f.h;
    else continue;
    const u = p.heights[i] * sh - tViol;
    if (u > seat) {
      seat = u;
      stoppedAt = p.heights[i] * sh;
    }
  }
  return { seat, stoppedAt };
}

/** Segments (x1, z1, x2, z2 per segment) of the section at height h. */
export function sliceSegments(pos: Float32Array, h: number): Float64Array {
  const out: number[] = [];
  for (let t = 0; t + 8 < pos.length; t += 9) {
    const ys = [pos[t + 1], pos[t + 4], pos[t + 7]];
    const below = ys.map((y) => y < h);
    let lone = -1;
    if (below[0] !== below[1] && below[0] !== below[2]) lone = 0;
    else if (below[1] !== below[0] && below[1] !== below[2]) lone = 1;
    else if (below[2] !== below[0] && below[2] !== below[1]) lone = 2;
    if (lone < 0) continue;
    const others = [0, 1, 2].filter((k) => k !== lone);
    for (const k of others) {
      const [lo, hi] = below[lone] ? [t + lone * 3, t + k * 3] : [t + k * 3, t + lone * 3];
      const s = (h - pos[lo + 1]) / (pos[hi + 1] - pos[lo + 1]);
      out.push(pos[lo] + (pos[hi] - pos[lo]) * s, pos[lo + 2] + (pos[hi + 2] - pos[lo + 2]) * s);
    }
  }
  return Float64Array.from(out);
}

/** Distance along a ray from (ox, oz) in direction (ux, uz) to the nearest segment, or Infinity. */
function rayHit(segs: Float64Array, ox: number, oz: number, ux: number, uz: number): number {
  let best = Infinity;
  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s] - ox, az = segs[s + 1] - oz;
    const ex = segs[s + 2] - segs[s], ez = segs[s + 3] - segs[s + 1];
    const den = ux * ez - uz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ez - az * ex) / den;
    const v = (ax * uz - az * ux) / den;
    if (t > 1e-9 && v >= 0 && v <= 1 && t < best) best = t;
  }
  return best;
}

/** Least-squares (Kasa) circle centre through 2D points, or null if degenerate. */
function fitCircleCenter(px: number[], pz: number[]): { x: number; z: number } | null {
  // Minimise sum (x^2 + z^2 + D x + E z + F)^2; the centre is (-D/2, -E/2).
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sxr = 0, szr = 0, sr = 0;
  const n = px.length;
  for (let k = 0; k < n; k++) {
    const x = px[k], z = pz[k], r = x * x + z * z;
    sxx += x * x; sxz += x * z; szz += z * z; sx += x; sz += z;
    sxr += x * r; szr += z * r; sr += r;
  }
  // [sxx sxz sx; sxz szz sz; sx sz n] [D E F]^T = -[sxr szr sr]^T
  const a = [sxx, sxz, sx, sxz, szz, sz, sx, sz, n];
  const rhs = [-sxr, -szr, -sr];
  const det3 = (m: number[]) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const det = det3(a);
  if (Math.abs(det) < 1e-12) return null;
  const col = (c: number) => a.map((v, i) => (i % 3 === c ? rhs[Math.floor(i / 3)] : v));
  const D = det3(col(0)) / det, E = det3(col(1)) / det;
  return { x: -D / 2, z: -E / 2 };
}

/**
 * Estimate the cavity axis: at each height cast rays outwards from the
 * current guess, fit a circle to the wall hits and repeat from its centre.
 * Returns the median over heights.
 */
export function estimateCenter(pos: Float32Array, heights: number[], start = { x: 0, z: 0 }, rays = 72): { x: number; z: number } | null {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const h of heights) {
    const segs = sliceSegments(pos, h);
    if (segs.length === 0) continue;
    let c: { x: number; z: number } | null = { ...start };
    for (let iter = 0; iter < 3 && c; iter++) {
      const hx: number[] = [], hz: number[] = [];
      for (let k = 0; k < rays; k++) {
        const a = (k / rays) * Math.PI * 2;
        const ux = Math.cos(a), uz = Math.sin(a);
        const d = rayHit(segs, c.x, c.z, ux, uz);
        if (!Number.isFinite(d)) {
          c = null; // not enclosed at this height
          break;
        }
        hx.push(c.x + ux * d);
        hz.push(c.z + uz * d);
      }
      if (c) c = fitCircleCenter(hx, hz);
    }
    if (c) {
      xs.push(c.x);
      zs.push(c.z);
    }
  }
  if (xs.length === 0) return null;
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return { x: median(xs), z: median(zs) };
}
