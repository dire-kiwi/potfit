// Rasterise a side-on section of a placed pot, with the reference pot drawn
// over it, to a PNG. Used by pot-tool so Codex can look at its own fits.

import { deflateSync } from 'node:zlib';
import { frustumOf, type ReferenceDims } from '../shared/fit.ts';

export interface SectionImageOptions {
  /** Section plane angle about the vertical axis, degrees (0 looks along -Z, like the app). */
  angle?: number;
  /** Required radial clearance, drawn as a dashed envelope. */
  radialClear?: number;
  width?: number;
}

export interface SectionImage {
  png: Buffer;
  width: number;
  height: number;
  pxPerMm: number;
  /** World extent shown, mm. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

type RGB = [number, number, number];

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.data.set(bg, i * 3);
  }
  set(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set(c, (y * this.w + x) * 3);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, thick = 1, dash = 0) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len));
    const r = (thick - 1) / 2;
    for (let s = 0; s <= steps; s++) {
      if (dash > 0 && Math.floor(s / dash) % 2 === 1) continue;
      const x = x0 + ((x1 - x0) * s) / steps, y = y0 + ((y1 - y0) * s) / steps;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) this.set(Math.round(x + dx), Math.round(y + dy), c);
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      raw.set(this.data.subarray(y * this.w * 3, (y + 1) * this.w * 3), y * (this.w * 3 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  let c = 0xffffffff;
  for (const b of Buffer.concat([head.subarray(4), body])) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** Segments (u1, y1, u2, y2) where the mesh crosses the vertical plane at `angle`. */
export function verticalSection(world: Float32Array, angle = 0): Float64Array {
  const th = (angle * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const out: number[] = [];
  const u = new Float64Array(3), d = new Float64Array(3), y = new Float64Array(3);
  for (let t = 0; t + 8 < world.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const x = world[t + k * 3], z = world[t + k * 3 + 2];
      u[k] = x * c - z * s; // across the view
      d[k] = x * s + z * c; // towards the viewer
      y[k] = world[t + k * 3 + 1];
    }
    const below = [d[0] < 0, d[1] < 0, d[2] < 0];
    let lone = -1;
    if (below[0] !== below[1] && below[0] !== below[2]) lone = 0;
    else if (below[1] !== below[0] && below[1] !== below[2]) lone = 1;
    else if (below[2] !== below[0] && below[2] !== below[1]) lone = 2;
    if (lone < 0) continue;
    for (let k = 0; k < 3; k++) {
      if (k === lone) continue;
      const [lo, hi] = below[lone] ? [lone, k] : [k, lone];
      const f = (0 - d[lo]) / (d[hi] - d[lo]);
      out.push(u[lo] + (u[hi] - u[lo]) * f, y[lo] + (y[hi] - y[lo]) * f);
    }
  }
  return Float64Array.from(out);
}

export function renderSection(world: Float32Array, ref: ReferenceDims | null, opts: SectionImageOptions = {}): SectionImage {
  const segs = verticalSection(world, opts.angle ?? 0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < segs.length; i += 2) {
    minX = Math.min(minX, segs[i]); maxX = Math.max(maxX, segs[i]);
    minY = Math.min(minY, segs[i + 1]); maxY = Math.max(maxY, segs[i + 1]);
  }
  const f = ref ? frustumOf(ref) : null;
  if (f) {
    const r = Math.max(f.rb, f.rt) + (opts.radialClear ?? 0);
    minX = Math.min(minX, -r); maxX = Math.max(maxX, r);
    minY = Math.min(minY, 0); maxY = Math.max(maxY, f.h);
  }
  if (!Number.isFinite(minX)) {
    minX = -50; maxX = 50; minY = 0; maxY = 100;
  }
  const pad = 0.08 * Math.max(maxX - minX, maxY - minY);
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const width = opts.width ?? 900;
  const pxPerMm = width / (maxX - minX);
  const height = Math.max(1, Math.round((maxY - minY) * pxPerMm));
  const cv = new Canvas(width, height, [255, 255, 255]);
  const px = (x: number) => (x - minX) * pxPerMm;
  const py = (y: number) => (maxY - y) * pxPerMm;

  // 10 mm grid, darker every 50 mm, with the axes darkest.
  for (let g = Math.ceil(minX / 10) * 10; g <= maxX; g += 10) {
    const c: RGB = g === 0 ? [150, 150, 150] : g % 50 === 0 ? [205, 205, 205] : [235, 235, 235];
    cv.line(px(g), 0, px(g), height - 1, c);
  }
  for (let g = Math.ceil(minY / 10) * 10; g <= maxY; g += 10) {
    const c: RGB = g === 0 ? [150, 150, 150] : g % 50 === 0 ? [205, 205, 205] : [235, 235, 235];
    cv.line(0, py(g), width - 1, py(g), c);
  }

  // Fill the cut faces with an even-odd scanline fill, then outline them.
  for (let row = 0; row < height; row++) {
    const yw = maxY - (row + 0.5) / pxPerMm;
    const xs: number[] = [];
    for (let i = 0; i < segs.length; i += 4) {
      const y1 = segs[i + 1], y2 = segs[i + 3];
      if (y1 > yw !== y2 > yw) xs.push(segs[i] + ((yw - y1) * (segs[i + 2] - segs[i])) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let col = Math.ceil(px(xs[k]) - 0.5); col <= Math.floor(px(xs[k + 1]) - 0.5); col++) cv.set(col, row, [120, 120, 128]);
    }
  }
  for (let i = 0; i < segs.length; i += 4) cv.line(px(segs[i]), py(segs[i + 1]), px(segs[i + 2]), py(segs[i + 3]), [20, 20, 24], 2);

  if (f) {
    const red: RGB = [220, 30, 40];
    cv.line(px(-f.rb), py(0), px(f.rb), py(0), red, 3);
    cv.line(px(-f.rt), py(f.h), px(f.rt), py(f.h), red, 3);
    cv.line(px(-f.rb), py(0), px(-f.rt), py(f.h), red, 3);
    cv.line(px(f.rb), py(0), px(f.rt), py(f.h), red, 3);
    const c = opts.radialClear ?? 0;
    if (c > 0) {
      const orange: RGB = [240, 150, 20];
      cv.line(px(-f.rb - c), py(0), px(-f.rt - c), py(f.h), orange, 2, 6);
      cv.line(px(f.rb + c), py(0), px(f.rt + c), py(f.h), orange, 2, 6);
    }
    cv.line(px(0), py(-pad / 2), px(0), py(f.h + pad / 2), [40, 90, 220], 1, 8);
  }
  return { png: cv.png(), width, height, pxPerMm, bounds: { minX, maxX, minY, maxY } };
}
