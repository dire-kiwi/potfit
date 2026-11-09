// The directories threads work in, and the state.json pot-tool reads there.
//
//   models/<id>/agent/                 a fitting thread: mesh.stl (a link to the model's mesh), state.json,
//                                      and whatever the agent writes (Blender scripts, meshes, renders/)
//   models/<id>/design/                a design thread (see design.ts)
//   models/<id>/reviews/<rid>/         a review thread: fitted.stl (the model as placed), state.json

import { copyFile, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSTL, writeBinarySTL } from '../../shared/stl.ts';
import { applyTransform, computeBounds, orientedBounds, type Bounds } from '../../shared/transform.ts';
import type { FitSettings, PotModel, ReferencePot } from '../../shared/types.ts';
import type { Store } from '../store.ts';

export const refState = (ref: ReferencePot) => ({ name: ref.name, topOD: ref.topOD, bottomOD: ref.bottomOD, height: ref.height, notes: ref.notes });

export function fitWorkspace(store: Store, modelId: string) {
  return join(store.modelDir(modelId), 'agent');
}

/** Link the model's current mesh and write its state, before each tool call that reads them. */
export async function prepareFitWorkspace(store: Store, model: PotModel, ref: ReferencePot | null): Promise<string> {
  const ws = fitWorkspace(store, model.id);
  await mkdir(join(ws, 'renders'), { recursive: true });
  // Linked afresh: an edit or a revert replaces the model's mesh file.
  const mesh = join(ws, 'mesh.stl');
  await rm(mesh, { force: true });
  await link(store.meshFile(model.id), mesh).catch(() => copyFile(store.meshFile(model.id), mesh));
  const state = {
    mesh: 'mesh.stl',
    model: { name: model.name, sourceFile: model.sourceFile, triangles: model.triangleCount },
    reference: ref ? refState(ref) : null,
    fit: model.fit,
    transform: model.transform,
  };
  await writeFile(join(ws, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  return ws;
}

const size = (b: Bounds) => ({ x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z });

export interface ReviewedDesign {
  scale: { x: number; y: number; z: number };
  originalSize: { x: number; y: number; z: number };
  fittedSize: { x: number; y: number; z: number };
}

/**
 * A review's directory, holding only the result: the model already placed in the pot frame, the
 * reference pot and the goals. Nothing from the fitting conversation or its workspace.
 */
export async function prepareReviewWorkspace(store: Store, model: PotModel, ref: ReferencePot, reviewId: string) {
  const ws = store.reviewDir(model.id, reviewId);
  await mkdir(join(ws, 'renders'), { recursive: true });
  const raw = parseSTL(await readFile(store.meshFile(model.id)));
  const rawBounds = computeBounds(raw);
  const fitted = applyTransform(raw, model.transform, rawBounds);
  await writeFile(join(ws, 'fitted.stl'), writeBinarySTL(fitted, `potfit fitted: ${model.name}`));
  const design: ReviewedDesign = { scale: model.transform.scale, originalSize: size(orientedBounds(rawBounds, model.transform.up)), fittedSize: size(computeBounds(fitted)) };
  const { referenceId: _ref, ...goals } = model.fit;
  const state = { mesh: 'fitted.stl', placed: true, reference: refState(ref), fit: goals, design };
  await writeFile(join(ws, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  return { ws, design, positions: raw };
}

const mm = (v: number) => `${Number(v.toFixed(3))} mm`;

export function describeReference(ref: ReferencePot): string {
  return `${ref.name}: top OD ${mm(ref.topOD)}, bottom OD ${mm(ref.bottomOD)}, height ${mm(ref.height)}${ref.notes ? ` (${ref.notes})` : ''}`;
}

export function describeFit(fit: Omit<FitSettings, 'referenceId'>): string {
  const top =
    fit.topOffset === null
      ? 'none (sit on the floor at the smallest scale that clears the walls)'
      : `${mm(fit.topOffset)} (reference rim ${fit.topOffset >= 0 ? 'above' : 'below'} the outer rim)`;
  return `clearance ${mm(fit.clearance)} diametral (${mm(fit.clearance / 2)} radial); scale mode ${fit.scaleMode}; rim offset target ${top}; floor gap ${mm(fit.floorGap)}`;
}
