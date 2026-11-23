// Separate pieces: meshes printed on their own beside the pot (eyes that fit into sockets, say),
// made by the fitter in Blender or returned by a design script, kept in versions and placed with
// the pot.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Tool, ToolContext } from '@dire-kiwi/agent-threads-node';
import { analyzeMesh, initialTransform } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { applyTransform, computeBounds, yUpToZUp } from '../shared/transform.ts';
import { DEFAULT_FIT, type AgentRole, type Checkpoint, type PotTransform } from '../shared/types.ts';
import { Checkpoints } from '../server/agent/checkpoints.ts';
import { Live } from '../server/agent/live.ts';
import { toolsFor } from '../server/agent/tools.ts';
import { prepareReviewWorkspace } from '../server/agent/workspace.ts';
import { Designs } from '../server/design.ts';
import { ScreenshotReviews } from '../server/screenshot-review.ts';
import { Store } from '../server/store.ts';
import { buildDesign } from '../tools/design-build.ts';
import { latheY, yToZ } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');
const toolPath = join(root, 'tools', 'pot-tool.ts');
const noBlender = { bin: 'blender', status: Promise.resolve({ available: false, version: null, error: 'not installed' }) };

/** A closed box as triangle soup, outward-facing. */
function box(c: [number, number, number], s: [number, number, number]): Float32Array {
  const v = (i: number) => [c[0] + ((i & 1) - 0.5) * s[0], c[1] + (((i >> 1) & 1) - 0.5) * s[1], c[2] + (((i >> 2) & 1) - 0.5) * s[2]];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return new Float32Array(quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d].flatMap(v)));
}

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} not within ${eps} of ${b}`);

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'potfit-pieces-')));
  await store.init();
  const designs = new Designs(store, { root, toolPath });
  const live = new Live();
  const checkpoints = new Checkpoints(store, designs, live);
  const tools = await toolsFor({ store, designs, checkpoints, live, toolPath, blender: noBlender, submitReview: async () => ({ ok: true }) });
  const ref = await store.createReference({ name: '60/40x55', topOD: 60, bottomOD: 40, height: 55, notes: '' });
  const positions = yToZ(latheY({ r0: 36, r1: 39, h: 50, wall: 3, floor: 3, segments: 64 }));
  const transform = initialTransform(positions, analyzeMesh(positions));
  const model = await store.createModel(
    { name: 'Lathe', sourceFile: 'lathe.stl', triangleCount: positions.length / 9, transform: { ...transform, scale: { x: 1.2, y: 1.2, z: 1.2 } }, fit: { ...DEFAULT_FIT, referenceId: ref.id, topOffset: 8 }, threadId: null },
    writeBinarySTL(positions),
  );
  await checkpoints.versions.ensureCurrent(model.id);
  const call = async (role: AgentRole, name: string, args: unknown = {}, extra: Record<string, unknown> = {}) => {
    const tool = tools[role].find((t: Tool) => t.name === name)!;
    const ctx: ToolContext = { threadId: 'th_test', metadata: { modelId: model.id, role, ...extra }, toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`, signal: new AbortController().signal };
    const out = await tool.run(args, ctx);
    return typeof out === 'string' ? { text: out, isError: false, structured: undefined as any } : { isError: false, ...out, structured: out.structured as any };
  };
  return { store, designs, checkpoints, tools, model, ref, call };
}

test('the fitter adds a piece in the placed frame; it is kept in raw coordinates and placed with the pot', async () => {
  const { store, checkpoints, model, ref, call } = await setup();
  const ws = join(store.modelDir(model.id), 'agent');
  await call('fit', 'export_placed_mesh', {});
  // An "eye" on the front of the pot, made in Blender's Z-up placed frame.
  const eye = box([0, -46, 40], [8, 4, 8]);
  writeFileSync(join(ws, 'eye.stl'), writeBinarySTL(eye));

  const bad = await call('fit', 'apply_mesh_edit', { pieces: [{ name: 'Left Eye', file: 'eye.stl' }], transform: model.transform, summary: '', warnings: [], confidence: 'low' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /lower-case/);
  const nothing = await call('fit', 'apply_mesh_edit', { transform: model.transform, summary: '', warnings: [], confidence: 'low' });
  assert.equal(nothing.isError, true);

  const applied = await call('fit', 'apply_mesh_edit', { pieces: [{ name: 'eyes', file: 'eye.stl' }], transform: model.transform, summary: 'Added an eye.', warnings: [], confidence: 'high' });
  assert.equal(applied.isError, false, applied.text);
  const cp: Checkpoint = applied.structured.checkpoint;
  assert.deepEqual(cp.meshEdit!.piecesSet, ['eyes']);
  assert.equal(cp.meshEdit!.potUnchanged, true);
  const after = await store.getModel(model.id);
  assert.deepEqual(after.pieces, [{ name: 'eyes', triangleCount: 12 }]);
  assert.deepEqual(after.transform, model.transform, 'the pot stays where it was');
  assert.deepEqual(readFileSync(store.meshFile(model.id)), readFileSync(join(ws, 'mesh.stl')));

  // Stored in the pot's raw coordinates: placing it with the pot puts it back where it was made.
  const potRaw = computeBounds(parseSTL(readFileSync(store.meshFile(model.id))));
  const raw = parseSTL(readFileSync(store.pieceFile(model.id, 'eyes')));
  const again = yUpToZUp(applyTransform(raw, after.transform, potRaw));
  for (let i = 0; i < eye.length; i++) near(again[i], eye[i]);

  // export_placed_mesh writes it beside the pot, as placed.
  const exported = await call('fit', 'export_placed_mesh', {});
  assert.match(exported.text, /placed-eyes\.stl/);
  const placed = parseSTL(readFileSync(join(ws, 'placed-eyes.stl')));
  for (let i = 0; i < eye.length; i++) near(placed[i], eye[i]);

  // It moves and scales with the pot.
  const bigger: PotTransform = { ...after.transform, scale: { x: 2, y: 2, z: 2 } };
  await store.updateModel(model.id, { transform: bigger });
  const moved = await call('fit', 'export_placed_mesh', { out: 'big.stl' });
  assert.equal(moved.isError, false);
  const small = computeBounds(parseSTL(readFileSync(join(ws, 'placed.stl'))));
  const pot = computeBounds(parseSTL(readFileSync(join(ws, 'big.stl'))));
  const eyeBig = computeBounds(parseSTL(readFileSync(join(ws, 'big-eyes.stl'))));
  near(eyeBig.max.x - eyeBig.min.x, 8 * (2 / 1.2), 1e-2);
  // Its height on the pot scales with the pot.
  near((eyeBig.min.z + eyeBig.max.z) / 2 - pot.min.z, (40 - small.min.z) * (2 / 1.2), 1e-2);
  await store.updateModel(model.id, { transform: after.transform });

  // Renders show it; check_fit measures the pot alone.
  const views = await call('fit', 'render_views', { sections: [0] });
  assert.match(views.text, /blue/);
  const state = JSON.parse((await call('fit', 'get_state')).text);
  assert.deepEqual(state.pieces, [{ name: 'eyes', triangles: 12 }]);

  // A reviewer gets it placed, beside the fitted pot.
  const reviewId = '00000000-0000-4000-8000-000000000002';
  await prepareReviewWorkspace(store, await store.getModel(model.id), ref, reviewId);
  const reviewed = parseSTL(readFileSync(join(store.reviewDir(model.id, reviewId), 'pieces', 'eyes.stl')));
  const reviewedZ = yUpToZUp(reviewed);
  for (let i = 0; i < eye.length; i++) near(reviewedZ[i], eye[i]);

  // Reverting goes back to the version without it.
  const { meshChanged, model: reverted } = await checkpoints.revert(model.id, cp.id);
  assert.equal(meshChanged, true);
  assert.deepEqual(reverted.pieces, []);
  assert.ok(!existsSync(store.pieceFile(model.id, 'eyes')));
  // And going to its version brings it back.
  const { model: back } = await checkpoints.versions.checkout(model.id, cp.versionId!);
  assert.deepEqual(back.pieces, [{ name: 'eyes', triangleCount: 12 }]);
  assert.deepEqual(parseSTL(readFileSync(store.pieceFile(model.id, 'eyes'))), raw);
});

test('a mesh edit can change the pot and its pieces together, and remove pieces', async () => {
  const { store, model, call } = await setup();
  const ws = join(store.modelDir(model.id), 'agent');
  await call('fit', 'export_placed_mesh', {});
  // Make the pot taller at the bottom, so its bounding box (and anchor) changes, and add a piece.
  const placed = parseSTL(readFileSync(join(ws, 'placed.stl')));
  const b = computeBounds(placed);
  const base = box([0, 0, b.min.z - 2], [40, 40, 4]);
  const edited = new Float32Array(placed.length + base.length);
  edited.set(placed);
  edited.set(base, placed.length);
  writeFileSync(join(ws, 'edited.stl'), writeBinarySTL(edited));
  const hat = box([0, 0, b.max.z + 10], [30, 30, 6]);
  writeFileSync(join(ws, 'hat.stl'), writeBinarySTL(hat));
  writeFileSync(join(ws, 'tail.stl'), writeBinarySTL(box([0, 50, 10], [4, 10, 4])));

  const applied = await call('fit', 'apply_mesh_edit', { file: 'edited.stl', pieces: [{ name: 'hat', file: 'hat.stl' }, { name: 'tail', file: 'tail.stl' }], transform: model.transform, summary: 'Base and hat.', warnings: [], confidence: 'high' });
  assert.equal(applied.isError, false, applied.text);
  const after = await store.getModel(model.id);
  assert.deepEqual(after.pieces?.map((p) => p.name), ['hat', 'tail']);
  assert.notDeepEqual(after.transform.position, model.transform.position, 'the pot was re-anchored');
  // The hat is still where it was modelled, relative to the re-anchored pot.
  const out = await call('fit', 'export_placed_mesh', { out: 'again.stl' });
  assert.equal(out.isError, false);
  const hatAgain = parseSTL(readFileSync(join(ws, 'again-hat.stl')));
  for (let i = 0; i < hat.length; i++) near(hatAgain[i], hat[i], 1e-2);

  const missing = await call('fit', 'apply_mesh_edit', { removePieces: ['wings'], transform: after.transform, summary: '', warnings: [], confidence: 'low' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no piece wings/);
  const removed = await call('fit', 'apply_mesh_edit', { removePieces: ['tail'], transform: after.transform, summary: 'No tail.', warnings: [], confidence: 'high' });
  assert.equal(removed.isError, false, removed.text);
  assert.deepEqual((await store.getModel(model.id)).pieces?.map((p) => p.name), ['hat']);
});

test('a design script can return separate pieces, and the build reports any overlap with the pot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'potfit-pieces-design-'));
  const input = { reference: { topOD: 60, bottomOD: 40, height: 55 }, fit: { clearance: 5, topOffset: 8, floorGap: 0 }, params: {} };
  const file = join(dir, 'eyes.mjs');
  writeFileSync(
    file,
    `export default function design({ pot, lib }) {
  const L = pot.layout({ floor: 2.4 });
  const body = lib.lathe([[0, 0], [L.cavityRadius(0) + 3, 0], [L.cavityRadius(L.rimZ) + 3, L.rimZ], [0, L.rimZ]]);
  const r = L.cavityRadius(L.rimZ) + 3;
  const socket = lib.sphere([0, -r, L.rimZ * 0.6], 4.3);
  const eye = lib.sphere([0, -r, L.rimZ * 0.6], 4);
  return { pot: body.subtract(socket).subtract(L.cavity()), pieces: { eyes: eye.intersect(lib.box([0, -r - 5, L.rimZ * 0.6], [20, 10, 20])) } };
}`,
  );
  const out = await buildDesign(file, input);
  assert.deepEqual(Object.keys(out.pieces), ['eyes']);
  assert.equal(out.report.pieces![0].name, 'eyes');
  assert.ok(out.report.pieces![0].overlap < 0.5, `overlap ${out.report.pieces![0].overlap}`);
  assert.equal(out.report.components, 1);
  assert.ok(!out.report.warnings.some((w) => /overlaps/.test(w)));

  writeFileSync(file, `export default ({ M }) => ({ pot: M.cube([20, 20, 20]), pieces: { block: M.cube([10, 10, 10]) } })`);
  const overlapping = await buildDesign(file, input);
  near(overlapping.report.pieces![0].overlap, 1000, 1);
  assert.ok(overlapping.report.warnings.some((w) => /"block" overlaps the pot/.test(w)));

  writeFileSync(file, `export default ({ M }) => ({ pot: M.cube([20, 20, 20]), pieces: { Bad: M.cube([1, 1, 1]) } })`);
  await assert.rejects(buildDesign(file, input), /pieces\.Bad/);
});

test("a designed model's pieces come from its script, and follow its builds and versions", async () => {
  const { store, designs, checkpoints, ref, tools } = await setup();
  const model = await designs.create({ name: 'Eyes', description: '', images: [], fit: { ...DEFAULT_FIT, referenceId: ref.id }, ref });
  await checkpoints.versions.ensureCurrent(model.id);
  assert.deepEqual(model.pieces, []);
  const script = `export default ({ M }) => ({ pot: M.cube([20, 20, 20]), pieces: { lid: M.cube([20, 20, 2]).translate([0, 0, 30]) } })`;
  writeFileSync(designs.scriptPath(model.id), script);
  const ctx = (): ToolContext => ({ threadId: 'th_d', metadata: { modelId: model.id, role: 'design' }, toolCallId: `c${Math.random().toString(36).slice(2, 6)}`, signal: new AbortController().signal });
  const tool = (n: string) => tools.design.find((t) => t.name === n)!;
  const built = (await tool('build_design').run({}, ctx())) as { text: string };
  assert.match(built.text, /lid/);
  assert.ok(existsSync(join(designs.dir(model.id), 'out', 'pieces', 'lid.stl')));
  const views = (await tool('render_views').run({ sections: [0] }, ctx())) as { text: string };
  assert.match(views.text, /blue/);

  const applied = (await tool('apply_design').run({ title: 'Box and lid', summary: '', warnings: [], confidence: 'high' }, ctx())) as { isError?: boolean; structured: { checkpoint: Checkpoint } };
  assert.ok(!applied.isError);
  const after = await store.getModel(model.id);
  assert.deepEqual(after.pieces, [{ name: 'lid', triangleCount: 12 }]);
  assert.deepEqual(after.design!.report!.pieces!.map((p) => p.name), ['lid']);

  // A rebuild without pieces drops them; going back to the version brings them back.
  await designs.rebuild(model.id, { script: 'export default ({ M }) => M.cube([20, 20, 20])' });
  assert.deepEqual((await store.getModel(model.id)).pieces, []);
  const { model: back } = await checkpoints.versions.checkout(model.id, applied.structured.checkpoint.versionId!);
  assert.deepEqual(back.pieces, [{ name: 'lid', triangleCount: 12 }]);
});

test("the screenshot review's render of the produced pot includes its pieces", async () => {
  const { store, model } = await setup();
  const loop = new ScreenshotReviews(store, {} as never, {} as never, new Live());
  const bare = await loop.renderProduced(model.id);
  await store.writePieces(model.id, { eyes: writeBinarySTL(box([0, -40, 40], [10, 6, 10])) });
  const withEyes = await loop.renderProduced(model.id);
  assert.equal(withEyes.subarray(1, 4).toString(), 'PNG');
  assert.notDeepEqual(withEyes, bare, 'the eyes are drawn');
});
