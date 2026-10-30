// Turn an uploaded model file into triangle soup, one entry per object.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { parseSTL } from '../../shared/stl.ts';

export interface ImportedPart {
  name: string;
  positions: Float32Array;
}

export const ACCEPTED_EXTENSIONS = ['.stl', '.3mf', '.obj', '.glb', '.gltf', '.ply'];

function geometryPositions(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4): Float32Array {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  if (matrix) g.applyMatrix4(matrix);
  const attr = g.getAttribute('position');
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  g.dispose();
  return out;
}

function concat(arrays: Float32Array[]): Float32Array {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function meshesOf(object: THREE.Object3D): Float32Array[] {
  const parts: Float32Array[] = [];
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.getAttribute('position')) {
      parts.push(geometryPositions(mesh.geometry, mesh.matrixWorld));
    }
  });
  return parts;
}

/** One part per top-level object that contains meshes. */
function partsOf(root: THREE.Object3D, fallbackName: string): ImportedPart[] {
  root.updateMatrixWorld(true);
  let top = root;
  // Descend through wrapper groups with a single child.
  while (top.children.length === 1 && !(top as THREE.Mesh).isMesh) top = top.children[0];
  const candidates = (top as THREE.Mesh).isMesh ? [top] : top.children;
  const parts = candidates
    .map((child, i) => ({ name: child.name || `${fallbackName} ${i + 1}`, positions: concat(meshesOf(child)) }))
    .filter((p) => p.positions.length > 0);
  if (parts.length === 1) parts[0].name = fallbackName;
  return parts;
}

export async function importFile(file: File): Promise<ImportedPart[]> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, '');
  const buffer = await file.arrayBuffer();
  switch (ext) {
    case '.stl':
      return [{ name: base, positions: parseSTL(buffer) }];
    case '.ply':
      return [{ name: base, positions: geometryPositions(new PLYLoader().parse(buffer)) }];
    case '.obj':
      return partsOf(new OBJLoader().parse(new TextDecoder().decode(buffer)), base);
    case '.3mf':
      return partsOf(new ThreeMFLoader().parse(buffer), base);
    case '.glb':
    case '.gltf': {
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      return partsOf(gltf.scene, base);
    }
    default:
      throw new Error(`Unsupported file type ${ext}. Use one of ${ACCEPTED_EXTENSIONS.join(', ')}.`);
  }
}
