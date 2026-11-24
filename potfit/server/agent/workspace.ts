// The directories threads work in, and the state.json pot-tool reads there.
//
//   models/<id>/agent/                 a fitting thread: mesh.stl (a link to the model's mesh), state.json,
//                                      and whatever the agent writes (Blender scripts, meshes, renders/);
//                                      state.json points pot-tool at the model's pieces/ beside it
//   models/<id>/design/                a design thread (see design.ts)
//   models/<id>/reviews/<rid>/         a review thread: fitted.stl (the model as placed), pieces/ (its
//                                      separate pieces as placed), state.json

import { copyFile, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSTL, writeBinarySTL } from '../../shared/stl.ts';
import { applyTransform, computeBounds, orientedBounds, type Bounds } from '../../shared/transform.ts';
import type { FitSettings, PotModel, ReferencePot } from '../../shared/types.ts';
import type { Store } from '../store.ts';
import { BadRequest } from './settings.ts';

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
  // Swapped in with a rename, so a pot-tool reading it meanwhile never finds it missing.
  const tmp = `${mesh}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  await link(store.meshFile(model.id), tmp).catch(() => copyFile(store.meshFile(model.id), tmp));
  await rename(tmp, mesh);
  const state = {
    mesh: 'mesh.stl',
    // The model's own pieces, which pot-tool places with the mesh; the agent changes them with apply_mesh_edit.
    pieces: '../pieces',
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
  const piecesDir = join(ws, 'pieces');
  await rm(piecesDir, { recursive: true, force: true });
  const pieces = await store.readPieces(model.id);
  if (pieces.length) await mkdir(piecesDir, { recursive: true });
  for (const p of pieces) {
    const placed = applyTransform(parseSTL(await readFile(store.pieceFile(model.id, p.name))), model.transform, rawBounds);
    await writeFile(join(piecesDir, `${p.name}.stl`), writeBinarySTL(placed, `potfit fitted piece: ${p.name}`));
  }
  const design: ReviewedDesign = { scale: model.transform.scale, originalSize: size(orientedBounds(rawBounds, model.transform.up)), fittedSize: size(computeBounds(fitted)) };
  const { referenceId: _ref, ...goals } = model.fit;
  const state = { mesh: 'fitted.stl', pieces: 'pieces', placed: true, reference: refState(ref), fit: goals, design };
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

/** A mesh the user attached to a message, saved in the thread's working directory. */
export interface AttachedMesh {
  /** Relative to the working directory: refs/<name>.stl. */
  path: string;
  /** The file the user picked (a 3MF, say; the browser turns every mesh into an STL). */
  source: string;
  triangles: number;
  size: { x: number; y: number; z: number };
}

/** Whether an attachment is a mesh for reference (the composer sends them as STL). */
export const isMeshAttachment = (a: { kind: string; media_type?: string; data?: string }) => a.kind === 'file' && a.media_type === 'model/stl' && typeof a.data === 'string';

/**
 * Save the meshes attached to a message in `<cwd>/refs/`, for the agent to open with its tools.
 * They aren't sent to Claude: the returned attachments keep only their names, which the message
 * shows, and the context tells the agent where they are.
 */
export async function saveAttachedMeshes<A extends { kind: 'image' | 'file'; name?: string; media_type?: string; data?: string }>(
  cwd: string,
  attachments: A[],
): Promise<{ attachments: A[]; meshes: AttachedMesh[] }> {
  const meshes: AttachedMesh[] = [];
  const out: A[] = [];
  for (const a of attachments) {
    if (!isMeshAttachment(a)) {
      out.push(a);
      continue;
    }
    const source = a.name?.trim() || `mesh-${meshes.length + 1}.stl`;
    const bytes = Buffer.from(a.data!, 'base64');
    let positions: Float32Array;
    try {
      positions = parseSTL(bytes);
    } catch (e) {
      throw new BadRequest(`Can't read the mesh ${source}: ${(e as Error).message}`);
    }
    if (positions.length === 0) throw new BadRequest(`The mesh ${source} has no triangles`);
    const dir = join(cwd, 'refs');
    await mkdir(dir, { recursive: true });
    const stemName = (source.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'mesh').slice(0, 60);
    let name = `${stemName}.stl`;
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${stemName}-${n}.stl`;
    await writeFile(join(dir, name), bytes);
    meshes.push({ path: `refs/${name}`, source, triangles: positions.length / 9, size: size(computeBounds(positions)) });
    const { data: _data, ...rest } = a;
    out.push({ ...rest, name: source } as A);
  }
  return { attachments: out, meshes };
}

/** The context's line about attached meshes. */
export function describeMeshes(meshes: AttachedMesh[], blender: boolean, role: 'fit' | 'design' | 'review'): string {
  const list = meshes
    .map((m) => `${m.path}${m.source.toLowerCase().endsWith('.stl') ? '' : ` (from ${m.source})`}: ${m.triangles} triangle${m.triangles === 1 ? "" : "s"}, ${[m.size.x, m.size.y, m.size.z].map((v) => Number(v.toFixed(2))).join(' × ')} (x × y × z in the file's own units and axes)`)
    .join('; ');
  return (
    `Attached meshes, for reference: ${list}. They're binary STLs saved in your working directory, not in this conversation. ` +
    (!blender || role === 'review'
      ? "You can't open them here, so go by their size and what the user says about them."
      : `Open them in Blender with run_blender to look at, measure or use their shape${role === 'design' ? ' (to build with one, save it, or what you make from it, into parts/ from Blender and load it with lib.part)' : ''}.`)
  );
}
