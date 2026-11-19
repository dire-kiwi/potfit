// Model versions: the tree the agent's changes and the user's edits make, going back to a version
// and branching from it, for imported and designed pots.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Tool, ToolContext } from '@dire-kiwi/agent-threads-node';
import { analyzeMesh, initialTransform, solveFit } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { DEFAULT_FIT, type AgentRole, type Checkpoint, type LiveEvent } from '../shared/types.ts';
import { Checkpoints } from '../server/agent/checkpoints.ts';
import { Live } from '../server/agent/live.ts';
import { toolsFor } from '../server/agent/tools.ts';
import { Designs } from '../server/design.ts';
import { Store } from '../server/store.ts';
import { labelFrom } from '../server/versions.ts';
import { latheY, yToZ } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');
const toolPath = join(root, 'tools', 'pot-tool.ts');
const noBlender = { bin: 'blender', status: Promise.resolve({ available: false, version: null, error: 'not installed' }) };

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'potfit-versions-')));
  await store.init();
  const designs = new Designs(store, { root, toolPath });
  const live = new Live();
  const checkpoints = new Checkpoints(store, designs, live);
  const versions = checkpoints.versions;
  const tools = await toolsFor({ store, designs, checkpoints, live, toolPath, blender: noBlender, submitReview: async () => ({ ok: true }) });
  const ref = await store.createReference({ name: '60/40x55', topOD: 60, bottomOD: 40, height: 55, notes: '' });
  const positions = yToZ(latheY({ r0: 36, r1: 39, h: 50, wall: 3, floor: 3 }));
  const model = await store.createModel(
    { name: 'Lathe', sourceFile: 'lathe.stl', triangleCount: positions.length / 9, transform: initialTransform(positions, analyzeMesh(positions)), fit: { ...DEFAULT_FIT, referenceId: ref.id, topOffset: 8 }, threadId: null },
    writeBinarySTL(positions),
  );
  const events: LiveEvent[] = [];
  const call = async (modelId: string, role: AgentRole, name: string, args: unknown = {}) => {
    const tool = tools[role].find((t: Tool) => t.name === name)!;
    const ctx: ToolContext = { threadId: 'th_test', metadata: { modelId, role }, toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`, signal: new AbortController().signal };
    const out = await tool.run(args, ctx);
    if (typeof out === 'string') return {} as { checkpoint: Checkpoint };
    assert.ok(!out.isError, out.text);
    return (out as { structured: { checkpoint: Checkpoint } }).structured;
  };
  return { store, designs, versions, checkpoints, model, ref, positions, events, live, call };
}

test('changes make a tree: going back to a version and changing it starts a branch', async () => {
  const { store, versions, checkpoints, model, ref, positions, live, call } = await setup();
  const events: LiveEvent[] = [];
  live.subscribe(model.id, (e) => events.push(e));
  const v1 = await versions.ensureCurrent(model.id);
  assert.equal(v1?.kind, 'original');
  assert.equal(v1?.label, 'Imported');
  assert.equal(await versions.ensureCurrent(model.id), null, 'nothing changed, so no new version');

  const solved = solveFit(positions, ref, { up: '+Z', spin: 0, mode: 'uniform', clearance: 5, topOffset: 8, floorGap: 0 });
  const fit = { clearance: 5, scaleMode: 'uniform', topOffset: 8, floorGap: 0 };
  const { checkpoint: first } = await call(model.id, 'fit', 'apply_fit', { transform: solved.transform, fit, summary: 'Fitted at scale 1. The rim stands 8 mm proud.', warnings: [], confidence: 'high' });
  const v2 = await store.getVersion(model.id, first.versionId!);
  assert.equal(v2.parentId, v1!.id);
  assert.equal(v2.number, 2);
  assert.equal(v2.label, 'Fitted at scale 1.');
  assert.equal(v2.checkpointId, first.id);
  assert.equal((await store.getModel(model.id)).versionId, v2.id);
  assert.ok(events.some((e) => e.type === 'version' && e.version.id === v2.id));
  assert.ok(events.some((e) => e.type === 'model' && e.model.versionId === v2.id), "the model the tool sends has its new version");

  // The user turns it by hand, then goes back to the first version: their edit is kept as a version.
  const turned = { ...solved.transform, spin: 45 };
  await store.updateModel(model.id, { transform: turned });
  const back = await versions.checkout(model.id, v1!.id);
  assert.equal(back.meshChanged, false);
  assert.deepEqual(back.model.transform, model.transform);
  assert.equal(back.model.versionId, v1!.id);
  assert.ok(back.model.versionSwitchedAt);
  const edits = (await store.listVersions(model.id)).find((v) => v.number === 3)!;
  assert.equal(edits.kind, 'manual');
  assert.equal(edits.parentId, v2.id);
  assert.deepEqual(edits.transform, turned);

  // A change now branches from the first version.
  const { checkpoint: second } = await call(model.id, 'fit', 'apply_fit', { transform: { ...solved.transform, spin: 90 }, fit, summary: 'Turned.', warnings: [], confidence: 'high' });
  const v4 = await store.getVersion(model.id, second.versionId!);
  assert.equal(v4.parentId, v1!.id);
  const children = (await store.listVersions(model.id)).filter((v) => v.parentId === v1!.id).map((v) => v.number);
  assert.deepEqual(children, [2, 4]);

  // The user's edits can be gone back to as they were.
  assert.deepEqual((await versions.checkout(model.id, edits.id)).model.transform, turned);

  // Reverting a change goes to the version before it, and the next change branches from there.
  const { model: reverted } = await checkpoints.revert(model.id, second.id);
  assert.equal(reverted.versionId, v1!.id);
  assert.deepEqual(reverted.transform, model.transform);
  assert.equal((await store.listVersions(model.id)).length, 4, 'nothing to keep: the model was at a version');

  // Saving with no changes makes nothing; with changes, a version with the user's label.
  assert.equal(await versions.ensureCurrent(model.id, { kind: 'saved', label: 'Mine' }), null);
  await store.updateModel(model.id, { fit: { ...reverted.fit, clearance: 4 } });
  const saved = await versions.ensureCurrent(model.id, { kind: 'saved', label: 'Mine' });
  assert.equal(saved?.label, 'Mine');
  assert.equal(saved?.parentId, v1!.id);
  assert.equal((await versions.rename(model.id, saved!.id, 'Tighter')).label, 'Tighter');
});

test('a version keeps its mesh, stored once however many versions share it', async () => {
  const { store, versions, model, call } = await setup();
  const v1 = (await versions.ensureCurrent(model.id))!;
  const original = readFileSync(store.meshFile(model.id));
  const ws = join(store.modelDir(model.id), 'agent');
  await call(model.id, 'fit', 'export_placed_mesh', { out: 'placed.stl' });
  // An "edit" that drops the last triangle.
  const placed = parseSTL(readFileSync(join(ws, 'placed.stl')));
  writeFileSync(join(ws, 'edited.stl'), writeBinarySTL(placed.subarray(0, placed.length - 9)));
  const { checkpoint } = await call(model.id, 'fit', 'apply_mesh_edit', { file: 'edited.stl', transform: model.transform, summary: 'Trimmed.', warnings: [], confidence: 'low' });
  const v2 = await store.getVersion(model.id, checkpoint.versionId!);
  assert.notEqual(v2.mesh, v1.mesh);
  assert.equal(v2.triangleCount, v1.triangleCount - 1);
  const edited = readFileSync(store.meshFile(model.id));

  const back = await versions.checkout(model.id, v1.id);
  assert.equal(back.meshChanged, true);
  assert.equal(back.model.triangleCount, v1.triangleCount);
  assert.deepEqual(readFileSync(store.meshFile(model.id)), original);
  const forward = await versions.checkout(model.id, v2.id);
  assert.equal(forward.meshChanged, true);
  assert.deepEqual(readFileSync(store.meshFile(model.id)), edited);

  await store.updateModel(model.id, { transform: { ...model.transform, spin: 10 } });
  const moved = (await versions.ensureCurrent(model.id))!;
  assert.equal(moved.mesh, v2.mesh, 'a placement change shares its mesh');
});

test("a designed pot's versions keep its script, parts and parameters", async () => {
  const { store, designs, versions, ref, call } = await setup();
  const model = await designs.create({ name: 'New design', description: 'plain', images: [], fit: { ...DEFAULT_FIT, referenceId: ref.id }, ref });
  const v1 = (await versions.ensureCurrent(model.id))!;
  assert.equal(v1.label, 'Starter design');
  const starter = readFileSync(designs.scriptPath(model.id), 'utf8');
  const starterMesh = readFileSync(store.meshFile(model.id));

  // The agent thickens the wall and adds a part, then applies it.
  const thicker = starter.replace("wall: { value: 3,", "wall: { value: 5,");
  assert.notEqual(thicker, starter);
  writeFileSync(designs.scriptPath(model.id), thicker);
  mkdirSync(designs.partsDir(model.id), { recursive: true });
  writeFileSync(join(designs.partsDir(model.id), 'ear.stl'), 'solid ear\nendsolid ear\n');
  const { checkpoint } = await call(model.id, 'design', 'apply_design', { title: 'Thick pot', summary: 'Thicker walls.', warnings: [], confidence: 'high' });
  const v2 = await store.getVersion(model.id, checkpoint.versionId!);
  assert.equal(v2.label, 'Thick pot');
  assert.equal(v2.design?.state.params.wall, 5);
  assert.deepEqual(Object.keys(v2.design!.parts), ['ear.stl']);

  // Unapplied edits aren't the pot the user sees, so they don't make a version.
  writeFileSync(designs.scriptPath(model.id), `${thicker}\n// half done\n`);
  assert.equal(await versions.ensureCurrent(model.id), null);
  await designs.restoreApplied(model.id);

  const back = await versions.checkout(model.id, v1.id);
  assert.equal(back.meshChanged, true);
  assert.equal(back.model.design?.params.wall, 3);
  assert.equal(readFileSync(designs.scriptPath(model.id), 'utf8'), starter);
  assert.equal(readFileSync(designs.appliedScript(model.id), 'utf8'), starter, 'the restored script counts as applied');
  assert.equal(existsSync(join(designs.partsDir(model.id), 'ear.stl')), false);
  assert.deepEqual(readFileSync(store.meshFile(model.id)), starterMesh);
  assert.equal(await designs.restoreApplied(model.id), false);

  const forward = await versions.checkout(model.id, v2.id);
  assert.equal(forward.model.design?.params.wall, 5);
  assert.equal(readFileSync(designs.scriptPath(model.id), 'utf8'), thicker);
  assert.equal(readFileSync(join(designs.partsDir(model.id), 'ear.stl'), 'utf8'), 'solid ear\nendsolid ear\n');
});

test('labels come from the first sentence of a summary', () => {
  assert.equal(labelFrom('Scaled to 1.04. The rim is level.', 'Fit'), 'Scaled to 1.04.');
  assert.equal(labelFrom('  ', 'Fit applied'), 'Fit applied');
  assert.equal(labelFrom('x'.repeat(100), 'Fit').length, 78);
});
