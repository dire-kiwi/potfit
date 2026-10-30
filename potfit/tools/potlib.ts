// The toolkit a design script gets. A design script is an ES module whose
// default export receives { pot, lib, sdf, M, CS, params, note } and returns a
// Manifold in the design frame: millimetres, +Z up, the base on z = 0 and the
// pot's axis on x = y = 0, with the front of the pot facing -Y. It is built on
// manifold-3d, whose booleans always give watertight, printable meshes.
//
// AGENTS.md for the design agent (server/design-prompt.ts) documents all of
// this; keep the two in step.

import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import type { DesignParam, ParamValues } from '../shared/types.ts';

export interface DesignInput {
  reference: { name?: string; topOD: number; bottomOD: number; height: number };
  fit: { clearance: number; topOffset: number | null; floorGap: number };
  /** Values the user chose; anything missing or invalid falls back to the script's default. */
  params: ParamValues;
}

type P3 = readonly [number, number, number];
type P2 = readonly [number, number];
type Sdf = (p: P3) => number;

// ------------------------------------------------------------ parameters

const MAX_PARAMS = 40;

/** Turn a script's `params` export into a checked spec. Throws on nonsense. */
export function normaliseParams(spec: unknown): Record<string, DesignParam> {
  if (spec === undefined || spec === null) return {};
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('`params` must be an object of { name: { value, ... } }');
  const out: Record<string, DesignParam> = {};
  const entries = Object.entries(spec as Record<string, unknown>);
  if (entries.length > MAX_PARAMS) throw new Error(`At most ${MAX_PARAMS} params`);
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][\w]{0,39}$/.test(key)) throw new Error(`param name "${key}" must be an identifier`);
    const o = (raw !== null && typeof raw === 'object' ? raw : { value: raw }) as Record<string, unknown>;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : key;
    const help = typeof o.help === 'string' ? o.help : '';
    const v = o.value;
    if (typeof v === 'number' && Number.isFinite(v)) {
      const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
      out[key] = { type: 'number', value: v, min: n(o.min), max: n(o.max), step: n(o.step), label, unit: typeof o.unit === 'string' ? o.unit : '', help };
    } else if (typeof v === 'boolean') {
      out[key] = { type: 'boolean', value: v, label, help };
    } else if (typeof v === 'string' && Array.isArray(o.options) && o.options.length > 0) {
      const options = o.options.map(String);
      out[key] = { type: 'choice', value: options.includes(v) ? v : options[0], options, label, help };
    } else {
      throw new Error(`param "${key}" needs a numeric or boolean value, or a string value with options`);
    }
  }
  return out;
}

/** The values to build with: the user's where they are valid, else the defaults. */
export function resolveParams(spec: Record<string, DesignParam>, values: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const [key, p] of Object.entries(spec)) {
    const v = values[key];
    if (p.type === 'number') {
      let x = typeof v === 'number' && Number.isFinite(v) ? v : p.value;
      if (p.min !== null) x = Math.max(p.min, x);
      if (p.max !== null) x = Math.min(p.max, x);
      out[key] = x;
    } else if (p.type === 'boolean') {
      out[key] = typeof v === 'boolean' ? v : p.value;
    } else {
      out[key] = typeof v === 'string' && p.options.includes(v) ? v : p.value;
    }
  }
  return out;
}

// ------------------------------------------------------------ small maths

const sub = (a: P3, b: P3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Column-major 4x4 rotation taking +Z onto `dir`, then translating to `at`. */
function alignZ(dir: P3, at: P3): Mat4 {
  const l = len(dir);
  const d = [dir[0] / l, dir[1] / l, dir[2] / l];
  // Rodrigues about z x d.
  const ax = [-d[1], d[0], 0];
  const s = Math.hypot(ax[0], ax[1]);
  const c = d[2];
  let r: number[];
  if (s < 1e-9) {
    r = c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  } else {
    const k = [ax[0] / s, ax[1] / s, 0];
    const v = 1 - c;
    // Row-major.
    r = [
      c + k[0] * k[0] * v, k[0] * k[1] * v, k[1] * s,
      k[1] * k[0] * v, c + k[1] * k[1] * v, -k[0] * s,
      -k[1] * s, k[0] * s, c,
    ];
  }
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, at[0], at[1], at[2], 1];
}

/** Monotone cubic (Fritsch-Carlson) through [x, y] points sorted by x; flat beyond the ends. */
function monotone(points: readonly P2[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 0) throw new Error('interp needs at least one point');
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-12, xs[i + 1] - xs[i]));
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * a * d[i]) / h;
      m[i + 1] = (3 * b * d[i]) / h;
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Centripetal Catmull-Rom through 2D or 3D points, `samples` per span. */
function catmullRom<T extends readonly number[]>(points: readonly T[], samples: number): number[][] {
  const pts = points.map((p) => [...p]);
  if (pts.length < 3) return pts;
  const dist = (a: number[], b: number[]) => Math.sqrt(Math.max(1e-12, Math.hypot(...a.map((v, i) => v - b[i]))));
  const out: number[][] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const t1 = dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
    for (let s = 1; s <= samples; s++) {
      const t = t1 + ((t2 - t1) * s) / samples;
      const lerp = (a: number[], b: number[], ta: number, tb: number) =>
        a.map((v, k) => (tb === ta ? v : ((tb - t) * v + (t - ta) * b[k]) / (tb - ta)));
      const a1 = lerp(p0, p1, 0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

// ------------------------------------------------------------ cross-section shapes

/**
 * Factors for radial(): each returns f(angle) with a maximum of 1, to multiply
 * a radius by. Corners, lobes and tips sit at angle 0 and every 360/n degrees.
 */
const shapes = {
  circle: () => () => 1,
  /** Regular n-gon; rounding 0 is sharp, 1 is a circle. */
  polygon(n: number, rounding = 0) {
    const k = clamp(rounding, 0, 1);
    const half = Math.PI / n, sector = 2 * half;
    const r0 = 1 - k, c = k, apothem = r0 * Math.cos(half) + c;
    return (angle: number) => {
      let phi = ((angle % sector) + sector) % sector;
      if (phi > half) phi = sector - phi;
      if (c >= r0 * Math.sin(phi)) {
        const rc = r0 * Math.cos(phi) + Math.sqrt(c * c - (r0 * Math.sin(phi)) ** 2);
        if (Math.atan2(rc * Math.sin(phi), rc * Math.cos(phi) - r0) <= half + 1e-12) return rc;
      }
      return apothem / Math.cos(half - phi);
    };
  },
  /** n smooth lobes; between them the radius dips to 1 - depth. */
  lobes: (n: number, depth: number) => (angle: number) => 1 - (depth * (1 - Math.cos(n * angle))) / 2,
  /** n rounded scallops meeting in sharp creases at 1 - depth. */
  scallops: (n: number, depth: number) => (angle: number) => 1 - depth * (1 - Math.abs(Math.cos((n * angle) / 2))),
  /** Star with n straight-edged points; the valleys are at 1 - depth. */
  star(n: number, depth: number) {
    const half = Math.PI / n, sector = 2 * half;
    const vx = (1 - depth) * Math.cos(half), vy = (1 - depth) * Math.sin(half);
    return (angle: number) => {
      let phi = ((angle % sector) + sector) % sector;
      if (phi > half) phi = sector - phi;
      // Ray at phi against the edge from the tip (1, 0) to the valley (vx, vy).
      const dx = vx - 1, dy = vy;
      return (1 * dy - 0 * dx) / (Math.cos(phi) * dy - Math.sin(phi) * dx);
    };
  },
  /**
   * Vertical ribs to add to a radius (mm, not a factor): n ribs standing
   * `height` proud (negative cuts flutes), each `width` of its pitch wide.
   */
  ribs(n: number, height: number, width = 0.5, profile: 'round' | 'v' | 'square' = 'round') {
    const w = clamp(width, 0.01, 1);
    return (angle: number) => {
      const u = (((n * angle) / (2 * Math.PI)) % 1 + 1) % 1;
      const d = Math.abs(u - 0.5) * 2; // 0 between ribs ... 1 at a rib centre
      const x = (1 - d) / w; // 0 at the rib centre, 1 at its edge
      if (x >= 1) return 0;
      const shape = profile === 'v' ? 1 - x : profile === 'square' ? 1 : Math.cos((x * Math.PI) / 2);
      return height * shape;
    };
  },
};

// ------------------------------------------------------------ the context

export function createContext(wasm: ManifoldToplevel, input: DesignInput, params: ParamValues) {
  const { Manifold: M, CrossSection: CS, Mesh } = wasm;
  const notes: string[] = [];
  const empty = () => M.cube([0, 0, 0]);
  const asManifold = (v: Manifold | Manifold[]) => (Array.isArray(v) ? (v.length ? M.union(v) : empty()) : v);

  const ref = input.reference;
  const rb = ref.bottomOD / 2, rt = ref.topOD / 2, H = ref.height;
  const radial = input.fit.clearance / 2;

  function layout(opts: { floor?: number } = {}) {
    const floor = opts.floor ?? 2;
    if (!(floor >= 0)) throw new Error('layout: floor must be >= 0');
    const floorZ = floor;
    const seatZ = floorZ + input.fit.floorGap;
    const nurseryTopZ = seatZ + H;
    const rimZ = input.fit.topOffset === null ? nurseryTopZ : nurseryTopZ - input.fit.topOffset;
    const nurseryRadius = (z: number) => (z < seatZ || z > nurseryTopZ ? 0 : rb + ((rt - rb) * (z - seatZ)) / H);
    /** Free radius the cavity needs at height z: room for whatever part of the nursery pot passes z on the way in, plus clearance. */
    const cavityRadius = (z: number) => {
      const passing = rt >= rb ? rb + ((rt - rb) * (clamp(z, seatZ, nurseryTopZ) - seatZ)) / H : rb;
      return passing + radial;
    };
    return {
      floor,
      floorZ,
      seatZ,
      nurseryTopZ,
      rimZ,
      nurseryRadius,
      cavityRadius,
      /** The cavity to subtract: floorZ up to `top`, `extra` mm wider all round. */
      cavity(o: { extra?: number; top?: number; segments?: number } = {}): Manifold {
        const segments = o.segments ?? 256;
        // Polygon vertices on a circle sit inside it between them; push them
        // out so the flats, not the corners, keep the clearance.
        const k = 1 / Math.cos(Math.PI / segments);
        const top = o.top ?? Math.max(rimZ, nurseryTopZ) + 200;
        const r = (z: number) => (cavityRadius(z) + (o.extra ?? 0)) * k;
        const zs = [floorZ, seatZ, nurseryTopZ, top].filter((z, i, a) => z <= top && (i === 0 || z > a[i - 1] + 1e-9));
        const poly: [number, number][] = [[0, floorZ], ...zs.map((z): [number, number] => [r(z), z]), [0, zs[zs.length - 1]]];
        return M.revolve(new CS([poly], 'EvenOdd'), segments);
      },
      /** Holes through the floor: one in the middle, or `count` around a ring. */
      drainHoles(o: { count?: number; diameter?: number; ring?: number } = {}): Manifold {
        const count = Math.round(o.count ?? 1);
        if (count <= 0) return empty();
        const d = o.diameter ?? 6;
        const ring = o.ring ?? cavityRadius(floorZ) * 0.5;
        const hole = M.cylinder(floorZ + 2, d / 2, d / 2, 32).translate([0, 0, -1]);
        if (count === 1) return hole;
        return M.union(Array.from({ length: count }, (_, i) => {
          const a = (2 * Math.PI * i) / count + Math.PI / 2;
          return hole.translate([ring * Math.cos(a), ring * Math.sin(a), 0]);
        }));
      },
      /** The nursery pot as seated, for checking how parts sit around it. */
      nursery(): Manifold {
        return M.revolve(new CS([[[0, seatZ], [rb, seatZ], [rt, nurseryTopZ], [0, nurseryTopZ]]], 'EvenOdd'), 128);
      },
    };
  }

  const pot = {
    reference: { ...ref },
    fit: { ...input.fit },
    layout,
  };

  const lib = {
    shapes,
    /** Smooth interpolating function through [x, y] points (no overshoot). */
    interp: (points: readonly P2[]) => monotone(points),
    /** Dense smooth curve through 2D or 3D points (centripetal Catmull-Rom). */
    smooth: (points: readonly (readonly number[])[], samples = 8) => catmullRom(points, samples),
    /** Solid of revolution from an outer profile of [r, z] points, closed along the axis. */
    lathe(points: readonly P2[], o: { segments?: number } = {}): Manifold {
      if (points.length < 2) throw new Error('lathe needs at least two [r, z] points');
      const pts = points.map(([r, z]): [number, number] => [Math.max(0, r), z]);
      const poly: [number, number][] = [[0, pts[0][1]], ...pts, [0, pts[pts.length - 1][1]]];
      return M.revolve(new CS([poly], 'EvenOdd'), o.segments ?? 256);
    },
    /** Revolve any closed [r, z] polygon about the Z axis (rings, beads, lips). */
    revolve(polygon: readonly P2[], o: { segments?: number } = {}): Manifold {
      return M.revolve(new CS([polygon.map(([r, z]): [number, number] => [r, z])], 'EvenOdd'), o.segments ?? 256);
    },
    /**
     * Solid whose surface is r = radius(angle, z) for z0 <= z <= z1, with flat
     * ends: twisted, faceted, lobed, ribbed or textured bodies. angle is in
     * radians, counter-clockwise from +X seen from above.
     */
    radial(o: { radius: (angle: number, z: number) => number; z0?: number; z1: number; segments?: number; step?: number; rows?: number }): Manifold {
      const z0 = o.z0 ?? 0, z1 = o.z1;
      if (!(z1 > z0)) throw new Error('radial: z1 must be above z0');
      const S = Math.max(3, Math.round(o.segments ?? 256));
      const rows = Math.max(1, Math.round(o.rows ?? Math.ceil((z1 - z0) / (o.step ?? 0.5))));
      if (S * rows > 2_000_000) throw new Error('radial: too many vertices; use fewer segments or a larger step');
      const verts = new Float32Array(((rows + 1) * S + 2) * 3);
      for (let j = 0; j <= rows; j++) {
        const z = z0 + ((z1 - z0) * j) / rows;
        for (let i = 0; i < S; i++) {
          const a = (2 * Math.PI * i) / S;
          let r = o.radius(a, z);
          if (!Number.isFinite(r)) throw new Error(`radial: radius(${a.toFixed(3)}, ${z.toFixed(2)}) is not a number`);
          r = Math.max(1e-3, r);
          verts.set([r * Math.cos(a), r * Math.sin(a), z], (j * S + i) * 3);
        }
      }
      const B = (rows + 1) * S, T = B + 1;
      verts.set([0, 0, z0, 0, 0, z1], B * 3);
      const tris: number[] = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < S; i++) {
          const a = j * S + i, b = j * S + ((i + 1) % S), c = (j + 1) * S + ((i + 1) % S), d = (j + 1) * S + i;
          tris.push(a, b, c, a, c, d);
        }
      }
      for (let i = 0; i < S; i++) {
        tris.push(B, (i + 1) % S, i);
        tris.push(T, rows * S + i, rows * S + ((i + 1) % S));
      }
      return new M(new Mesh({ numProp: 3, vertProperties: verts, triVerts: Uint32Array.from(tris) }));
    },
    sphere: (center: P3, r: number, segments = 48) => M.sphere(r, segments).translate([...center]),
    ellipsoid: (center: P3, radii: P3, segments = 48) => M.sphere(1, segments).scale([...radii]).translate([...center]),
    /** Box centred on `center`; `round` rounds every edge; `rotate` is [x, y, z] degrees about its centre. */
    box(center: P3, size: P3, o: { round?: number; rotate?: P3; segments?: number } = {}): Manifold {
      const r = Math.min(o.round ?? 0, size[0] / 2, size[1] / 2, size[2] / 2);
      let m: Manifold;
      if (r > 1e-6) {
        const h = size.map((s) => s / 2 - r);
        const ball = M.sphere(r, o.segments ?? 24);
        const corners: Manifold[] = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(ball.translate([sx * h[0], sy * h[1], sz * h[2]]));
        m = M.hull(corners);
      } else {
        m = M.cube([...size], true);
      }
      if (o.rotate) m = m.rotate([...o.rotate]);
      return m.translate([...center]);
    },
    /** Cylinder or cone from point a to point b. */
    cylinder(a: P3, b: P3, r1: number, r2 = r1, segments = 48): Manifold {
      const d = sub(b, a);
      return M.cylinder(len(d), r1, r2, segments).transform(alignZ(d, a));
    },
    /** Rounded rod from a to b, radius r1 at a and r2 at b. */
    capsule(a: P3, b: P3, r1: number, r2 = r1, segments = 24): Manifold {
      return M.hull([M.sphere(r1, segments).translate([...a]), M.sphere(r2, segments).translate([...b])]);
    },
    /** Smooth rod through points; radius can vary per point or with t (0..1 along the path). */
    tube(points: readonly P3[], radius: number | readonly number[] | ((t: number) => number), o: { segments?: number } = {}): Manifold {
      if (points.length < 2) throw new Error('tube needs at least two points');
      const r = (i: number) => (typeof radius === 'number' ? radius : typeof radius === 'function' ? radius(i / (points.length - 1)) : radius[Math.min(i, radius.length - 1)]);
      const parts: Manifold[] = [];
      for (let i = 0; i + 1 < points.length; i++) parts.push(lib.capsule(points[i], points[i + 1], r(i), r(i + 1), o.segments ?? 24));
      return M.union(parts);
    },
    /** Ring of radius R and tube radius r around the Z axis through `center`; `rotate` tilts it. */
    torus(center: P3, R: number, r: number, o: { rotate?: P3; segments?: number; tubeSegments?: number } = {}): Manifold {
      let m = M.revolve(CS.circle(r, o.tubeSegments ?? 24).translate([R, 0]), o.segments ?? 96);
      if (o.rotate) m = m.rotate([...o.rotate]);
      return m.translate([...center]);
    },
    /** The part plus its mirror image across x = 0 (left/right pairs). */
    symmetric: (m: Manifold) => m.add(m.mirror([1, 0, 0])),
    union: (parts: Manifold[]) => asManifold(parts),
    /**
     * Mesh a signed distance function (negative inside) over a box. Use the
     * sdf helpers to blend parts smoothly, like a sculpt. Keep the shape inside
     * the box, and edge at 0.4 to 1 mm: finer is slower.
     */
    fromSDF(fn: Sdf, bounds: { min: P3; max: P3 }, edge = 0.6): Manifold {
      const span = sub(bounds.max, bounds.min);
      const cells = (span[0] / edge) * (span[1] / edge) * (span[2] / edge);
      if (!(cells > 0)) throw new Error('fromSDF: bounds must have max above min');
      if (cells > 60e6) throw new Error(`fromSDF: ${Math.round(cells / 1e6)}M cells is too many; use a larger edge or smaller bounds`);
      return M.levelSet((p) => -fn(p), { min: [...bounds.min], max: [...bounds.max] }, edge);
    },
    /** First point where the segment from -> to enters `body`, with the surface normal; null if it misses. */
    surface(body: Manifold, from: P3, to: P3): { position: [number, number, number]; normal: [number, number, number] } | null {
      const hits = body.rayCast([...from], [...to]).sort((a, b) => a.distance - b.distance);
      return hits.length ? { position: [...hits[0].position], normal: [...hits[0].normal] } : null;
    },
    /** Cut everything below z (default 0): a flat base. */
    trimBase: (m: Manifold, z = 0) => m.trimByPlane([0, 0, 1], z),
    /** Round off creases and subdivide to roughly `edge` mm; slow on big meshes. */
    soften: (m: Manifold, o: { minSharpAngle?: number; edge?: number } = {}) => m.smoothOut(o.minSharpAngle ?? 60).refineToLength(o.edge ?? 1),
  };

  const sdf = {
    sphere: (c: P3, r: number): Sdf => (p) => len(sub(p, c)) - r,
    /** Approximate (exact on the axes); fine for blobs. */
    ellipsoid: (c: P3, radii: P3): Sdf => (p) => {
      const q = sub(p, c);
      const k0 = Math.hypot(q[0] / radii[0], q[1] / radii[1], q[2] / radii[2]);
      const k1 = Math.hypot(q[0] / radii[0] ** 2, q[1] / radii[1] ** 2, q[2] / radii[2] ** 2);
      return k1 === 0 ? -Math.min(...radii) : (k0 * (k0 - 1)) / k1;
    },
    box: (c: P3, size: P3, round = 0): Sdf => (p) => {
      const q = [0, 1, 2].map((i) => Math.abs(p[i] - c[i]) - (size[i] / 2 - round));
      const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      return outside + Math.min(Math.max(q[0], q[1], q[2]), 0) - round;
    },
    capsule: (a: P3, b: P3, r1: number, r2 = r1): Sdf => (p) => {
      const pa = sub(p, a), ba = sub(b, a);
      const h = clamp(dot(pa, ba) / Math.max(1e-12, dot(ba, ba)), 0, 1);
      return len(sub(pa, [ba[0] * h, ba[1] * h, ba[2] * h])) - mix(r1, r2, h);
    },
    tube: (points: readonly P3[], r: number, k = 0): Sdf => {
      const parts: Sdf[] = [];
      for (let i = 0; i + 1 < points.length; i++) parts.push(sdf.capsule(points[i], points[i + 1], r));
      return k > 0 ? sdf.smoothUnion(k, ...parts) : sdf.union(...parts);
    },
    /** Torus around the Z axis through c. */
    torus: (c: P3, R: number, r: number): Sdf => (p) => Math.hypot(Math.hypot(p[0] - c[0], p[1] - c[1]) - R, p[2] - c[2]) - r,
    /** Solid of revolution from an outer [r, z] profile, like lib.lathe. */
    lathe: (points: readonly P2[]): Sdf => {
      const poly: P2[] = [[0, points[0][1]], ...points, [0, points[points.length - 1][1]]];
      return (p) => {
        const x = Math.hypot(p[0], p[1]), y = p[2];
        let d = Infinity, s = 1;
        // Inigo Quilez's polygon distance with a winding-parity sign.
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [ix, iy] = poly[i], [jx, jy] = poly[j];
          const ex = jx - ix, ey = jy - iy, wx = x - ix, wy = y - iy;
          const h = clamp((wx * ex + wy * ey) / Math.max(1e-12, ex * ex + ey * ey), 0, 1);
          d = Math.min(d, Math.hypot(wx - ex * h, wy - ey * h));
          const c1 = y >= iy, c2 = y < jy, c3 = ex * wy > ey * wx;
          if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
        }
        return s * d;
      };
    },
    union: (...fns: Sdf[]): Sdf => (p) => Math.min(...fns.map((f) => f(p))),
    /** Union with a fillet of about k mm where parts meet. */
    smoothUnion: (k: number, ...fns: Sdf[]): Sdf => (p) => {
      let d = fns[0](p);
      for (let i = 1; i < fns.length; i++) {
        const e = fns[i](p);
        const h = Math.max(k - Math.abs(d - e), 0) / k;
        d = Math.min(d, e) - h * h * k * 0.25;
      }
      return d;
    },
    subtract: (a: Sdf, b: Sdf): Sdf => (p) => Math.max(a(p), -b(p)),
    smoothSubtract: (k: number, a: Sdf, b: Sdf): Sdf => (p) => {
      const d1 = a(p), d2 = -b(p);
      const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
      return Math.max(d1, d2) + h * h * k * 0.25;
    },
    intersect: (a: Sdf, b: Sdf): Sdf => (p) => Math.max(a(p), b(p)),
    translate: (f: Sdf, v: P3): Sdf => (p) => f(sub(p, v)),
    /** Rotate a shape about the Z axis by degrees. */
    rotateZ: (f: Sdf, degrees: number): Sdf => {
      const c = Math.cos((-degrees * Math.PI) / 180), s = Math.sin((-degrees * Math.PI) / 180);
      return (p) => f([c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]);
    },
  };

  return {
    context: {
      M,
      CS,
      pot,
      lib,
      sdf,
      params,
      /** Add a line to the build report. */
      note: (text: unknown) => {
        if (notes.length < 50) notes.push(String(text).slice(0, 500));
      },
    },
    notes,
    asManifold,
  };
}

export type DesignContext = ReturnType<typeof createContext>['context'];
export type { CrossSection, Manifold };
