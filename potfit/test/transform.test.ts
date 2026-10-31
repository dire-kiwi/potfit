import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMatrix, applyTransform, computeBounds, invertMatrix, reanchor, transformMatrix, validateTransform, yUpToZUp, zUpToYUp } from '../shared/transform.ts';
import type { PotTransform, UpAxis } from '../shared/types.ts';

// An L-shaped point cloud: a long arm along raw +Z plus a short one along +X.
const raw = new Float32Array([0, 0, 0, 0, 0, 10, 4, 0, 0, 4, 2, 0]);

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('up axis rotates that raw axis onto +Y', () => {
  const cases: [UpAxis, [number, number, number]][] = [
    ['+X', [1, 0, 0]],
    ['-X', [-1, 0, 0]],
    ['+Y', [0, 1, 0]],
    ['-Y', [0, -1, 0]],
    ['+Z', [0, 0, 1]],
    ['-Z', [0, 0, -1]],
  ];
  const bounds = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  for (const [up, v] of cases) {
    const m = transformMatrix({ up, spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, bounds);
    const out = [0, 1, 2].map((r) => m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2]);
    assert.deepEqual(out.map((x) => Math.round(x)), [0, 1, 0], up);
    // Proper rotation: determinant +1.
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    close(det, 1);
  }
});

test('position is where the bottom centre of the bounding box lands, whatever the spin and scale', () => {
  for (const spin of [0, 37, 90, 180]) {
    const t: PotTransform = { up: '+Z', spin, position: { x: 3, y: -2, z: 5 }, scale: { x: 1.5, y: 2, z: 1.5 } };
    const world = applyTransform(raw, t);
    const b = computeBounds(world);
    close(b.min.y, -2);
    // The anchor is the up-rotated bounding-box centre; spin turns about it, so
    // with spin 0 the world bbox is centred on the position.
    if (spin === 0) {
      close((b.min.x + b.max.x) / 2, 3);
      close((b.min.z + b.max.z) / 2, 5);
    }
  }
});

test('scale is applied along world axes after the rotation', () => {
  const t: PotTransform = { up: '+Z', spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 3, z: 1 } };
  const b = computeBounds(applyTransform(raw, t));
  close(b.max.y - b.min.y, 30); // the long raw Z arm is now vertical and tripled
});

test('Y-up to Z-up keeps handedness', () => {
  assert.deepEqual([...yUpToZUp(new Float32Array([1, 2, 3]))], [1, -3, 2]);
});

test('validateTransform rejects bad input', () => {
  assert.equal(validateTransform({ up: '+Z', spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }), null);
  assert.match(validateTransform({ up: 'Z', spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })!, /up/);
  assert.match(validateTransform({ up: '+Z', spin: 0, position: { x: 0, y: 0 }, scale: { x: 1, y: 1, z: 1 } })!, /position/);
  assert.match(validateTransform({ up: '+Z', spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: -1, z: 1 } })!, /positive/);
});

test('placing and unplacing a mesh round-trips, and reanchor keeps an edited mesh in place', () => {
  const t: PotTransform = { up: '+X', spin: 33, position: { x: 1, y: -2, z: 3 }, scale: { x: 1.3, y: 0.8, z: 1.3 } };
  const bounds = computeBounds(raw);
  const placed = applyTransform(raw, t, bounds);
  const back = applyMatrix(zUpToYUp(yUpToZUp(placed)), invertMatrix(transformMatrix(t, bounds)));
  raw.forEach((v, i) => close(back[i], v, 1e-4));

  // An edit that grows the bounding box: the old points must land where they did.
  const placedEdited = new Float32Array([...placed, 20, -30, 40]);
  const edited = applyMatrix(placedEdited, invertMatrix(transformMatrix(t, bounds)));
  const t2 = reanchor(t, bounds, computeBounds(edited));
  const again = applyTransform(edited, t2);
  placedEdited.forEach((v, i) => close(again[i], v, 1e-3));
});
