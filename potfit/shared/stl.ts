// Minimal STL reader/writer. Meshes are flat Float32Arrays of triangle soup:
// 9 floats (three xyz vertices) per triangle.

function isBinary(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 === bytes.byteLength) return true;
  // ASCII files start with "solid"; some binary exporters also write that, so
  // fall back to the size check above before trusting the header.
  const head = new TextDecoder().decode(bytes.subarray(0, 5));
  return head !== 'solid';
}

export function parseSTL(data: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (isBinary(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (84 + count * 50 > bytes.byteLength) throw new Error('Truncated binary STL');
    const out = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const base = 84 + t * 50 + 12; // skip the facet normal
      for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(base + k * 4, true);
    }
    return out;
  }
  const text = new TextDecoder().decode(bytes);
  const values: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (values.length === 0 || values.length % 9 !== 0) throw new Error('Could not read any triangles from the STL');
  return new Float32Array(values);
}

export function writeBinarySTL(positions: Float32Array, header = 'potfit'): Uint8Array {
  const count = Math.floor(positions.length / 9);
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const p = t * 9;
    const ux = positions[p + 3] - positions[p], uy = positions[p + 4] - positions[p + 1], uz = positions[p + 5] - positions[p + 2];
    const vx = positions[p + 6] - positions[p], vy = positions[p + 7] - positions[p + 1], vz = positions[p + 8] - positions[p + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = 84 + t * 50;
    view.setFloat32(base, nx, true);
    view.setFloat32(base + 4, ny, true);
    view.setFloat32(base + 8, nz, true);
    for (let k = 0; k < 9; k++) view.setFloat32(base + 12 + k * 4, positions[p + k], true);
  }
  return bytes;
}
