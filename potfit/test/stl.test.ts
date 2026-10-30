import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';

const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]);

test('binary STL round-trips', () => {
  const bytes = writeBinarySTL(tri, 'solid header that is still binary');
  assert.equal(bytes.byteLength, 84 + 2 * 50);
  assert.deepEqual(parseSTL(bytes), tri);
});

test('binary STL facet normals follow the winding', () => {
  const bytes = writeBinarySTL(tri.subarray(0, 9));
  const view = new DataView(bytes.buffer);
  assert.deepEqual([view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)], [0, 0, 1]);
});

test('ASCII STL parses', () => {
  const text = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1.5e0 0
 endloop
endfacet
endsolid t
`;
  assert.deepEqual([...parseSTL(new TextEncoder().encode(text))], [0, 0, 0, 1, 0, 0, 0, 1.5, 0]);
});

test('garbage is rejected', () => {
  assert.throws(() => parseSTL(new TextEncoder().encode('solid nothing here')));
});
