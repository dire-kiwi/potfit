// Shaded orthographic views of a mesh as a PNG, so the design agent can look
// at what it built and compare it with the user's reference images.

import { encodePNG } from './section-png.ts';

export interface ViewAngle {
  /** Degrees about +Z; 0 looks at the front (from -Y), -90 at the right side. */
  azimuth: number;
  /** Degrees above the horizon; 90 looks straight down. */
  elevation: number;
}

export const DEFAULT_VIEWS: ViewAngle[] = [
  { azimuth: 0, elevation: 0 }, // front
  { azimuth: -90, elevation: 0 }, // right side
  { azimuth: -35, elevation: 28 }, // three-quarter, from front right
  { azimuth: 0, elevation: 90 }, // top, front at the bottom
];

export interface ViewsImage {
  png: Buffer;
  width: number;
  height: number;
}

const BASE = [214, 142, 112];
const BG = [246, 246, 244];

/** positions: triangle soup in the design frame (+Z up, counter-clockwise from outside). */
export function renderViews(positions: Float32Array, opts: { tile?: number; views?: ViewAngle[]; columns?: number } = {}): ViewsImage {
  const tile = opts.tile ?? 560;
  const views = opts.views ?? DEFAULT_VIEWS;
  const cols = opts.columns ?? 2;
  const rows = Math.ceil(views.length / cols);
  const gap = 4;
  const width = cols * tile + (cols - 1) * gap, height = rows * tile + (rows - 1) * gap;
  const rgb = new Uint8Array(width * height * 3).fill(200);
  views.forEach((v, i) => {
    const img = renderView(positions, v, tile);
    const ox = (i % cols) * (tile + gap), oy = Math.floor(i / cols) * (tile + gap);
    for (let y = 0; y < tile; y++) rgb.set(img.subarray(y * tile * 3, (y + 1) * tile * 3), ((oy + y) * width + ox) * 3);
  });
  return { png: encodePNG(rgb, width, height), width, height };
}

function renderView(pos: Float32Array, view: ViewAngle, size: number): Uint8Array {
  const ss = 2;
  const S = size * ss;
  const th = (view.azimuth * Math.PI) / 180, ph = (view.elevation * Math.PI) / 180;
  const f = [Math.sin(th) * Math.cos(ph), Math.cos(th) * Math.cos(ph), -Math.sin(ph)];
  const r = [Math.cos(th), -Math.sin(th), 0];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  // Key light from upper left of the camera, a weaker fill from the right.
  const norm = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return v.map((x) => x / l);
  };
  const key = norm([-f[0] + 0.7 * u[0] - 0.6 * r[0], -f[1] + 0.7 * u[1] - 0.6 * r[1], -f[2] + 0.7 * u[2] - 0.6 * r[2]]);
  const fill = norm([-f[0] + 0.2 * u[0] + 0.9 * r[0], -f[1] + 0.2 * u[1] + 0.9 * r[1], -f[2] + 0.2 * u[2] + 0.9 * r[2]]);

  const n = pos.length / 3;
  const sx = new Float32Array(n), sy = new Float32Array(n), sd = new Float32Array(n);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    sx[i] = x * r[0] + y * r[1] + z * r[2];
    sy[i] = x * u[0] + y * u[1] + z * u[2];
    sd[i] = x * f[0] + y * f[1] + z * f[2];
    minX = Math.min(minX, sx[i]); maxX = Math.max(maxX, sx[i]);
    minY = Math.min(minY, sy[i]); maxY = Math.max(maxY, sy[i]);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const scale = (S * 0.9) / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let i = 0; i < n; i++) {
    sx[i] = S / 2 + (sx[i] - cx) * scale;
    sy[i] = S / 2 - (sy[i] - cy) * scale;
  }

  const depth = new Float32Array(S * S).fill(Infinity);
  const color = new Uint8Array(S * S * 3);
  for (let i = 0; i < S * S; i++) color.set(BG, i * 3);

  for (let t = 0; t < n; t += 3) {
    const ax = pos[t * 3], ay = pos[t * 3 + 1], az = pos[t * 3 + 2];
    const ux = pos[t * 3 + 3] - ax, uy = pos[t * 3 + 4] - ay, uz = pos[t * 3 + 5] - az;
    const vx = pos[t * 3 + 6] - ax, vy = pos[t * 3 + 7] - ay, vz = pos[t * 3 + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l === 0) continue;
    nx /= l; ny /= l; nz /= l;
    if (nx * f[0] + ny * f[1] + nz * f[2] >= 0) continue; // faces away
    const lit = 0.32 + 0.58 * Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]) + 0.22 * Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]);
    const c0 = Math.min(255, BASE[0] * lit), c1 = Math.min(255, BASE[1] * lit), c2 = Math.min(255, BASE[2] * lit);

    const x0 = sx[t], y0 = sy[t], x1 = sx[t + 1], y1 = sy[t + 1], x2 = sx[t + 2], y2 = sy[t + 2];
    const d0 = sd[t], d1 = sd[t + 1], d2 = sd[t + 2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) continue;
    const xmin = Math.max(0, Math.floor(Math.min(x0, x1, x2))), xmax = Math.min(S - 1, Math.ceil(Math.max(x0, x1, x2)));
    const ymin = Math.max(0, Math.floor(Math.min(y0, y1, y2))), ymax = Math.min(S - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let py = ymin; py <= ymax; py++) {
      const qy = py + 0.5;
      for (let px = xmin; px <= xmax; px++) {
        const qx = px + 0.5;
        const w0 = ((x1 - qx) * (y2 - qy) - (x2 - qx) * (y1 - qy)) / area;
        const w1 = ((x2 - qx) * (y0 - qy) - (x0 - qx) * (y2 - qy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * d0 + w1 * d1 + w2 * d2;
        const k = py * S + px;
        if (d >= depth[k]) continue;
        depth[k] = d;
        color[k * 3] = c0;
        color[k * 3 + 1] = c1;
        color[k * 3 + 2] = c2;
      }
    }
  }

  // Box-filter the supersampled image down.
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) s += color[((y * ss + dy) * S + x * ss + dx) * 3 + c];
        out[(y * size + x) * 3 + c] = s / (ss * ss);
      }
    }
  }
  return out;
}
