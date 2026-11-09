// potfit's app tools, run as the agent would call them, on a temporary store.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Tool, ToolContext } from '@dire-kiwi/agent-threads-node';
import { analyzeMesh, initialTransform } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { DEFAULT_FIT, type AgentRole, type Checkpoint, type LiveEvent, type ReviewResult } from '../shared/types.ts';
import { Checkpoints } from '../server/agent/checkpoints.ts';
import { Live } from '../server/agent/live.ts';
import { potfitPolicy } from '../server/agent/policy.ts';
import { toolsFor } from '../server/agent/tools.ts';
import { prepareReviewWorkspace } from '../server/agent/workspace.ts';
import { Designs } from '../server/design.ts';
import { Store } from '../server/store.ts';
import { latheY, yToZ } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');
const toolPath = join(root, 'tools', 'pot-tool.ts');
const noBlender = { bin: 'blender', status: Promise.resolve({ available: false, version: null, error: 'not installed' }) };

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'potfit-tools-')));
  await store.init();
  const designs = new Designs(store, { root, toolPath });
  const live = new Live();
  const checkpoints = new Checkpoints(store, designs);
  const submitted: ReviewResult[] = [];
  const tools = await toolsFor({ store, designs, checkpoints, live, toolPath, blender: noBlender, submitReview: async (_m, _r, result) => (submitted.push(result), { ok: true }) });
  const ref = await store.createReference({ name: '60/40x55', topOD: 60, bottomOD: 40, height: 55, notes: '' });
  // A pot built for the reference with 5 mm clearance, Z up as STLs usually are.
  const positions = yToZ(latheY({ r0: 36, r1: 39, h: 50, wall: 3, floor: 3 }));
  const model = await store.createModel(
    { name: 'Lathe', sourceFile: 'lathe.stl', triangleCount: positions.length / 9, transform: initialTransform(positions, analyzeMesh(positions)), fit: { ...DEFAULT_FIT, referenceId: ref.id, topOffset: 8 }, threadId: null },
    writeBinarySTL(positions),
  );
  const events: LiveEvent[] = [];
  live.subscribe(model.id, (e) => events.push(e));
  const call = async (role: AgentRole, name: string, args: unknown = {}, extra: Record<string, unknown> = {}) => {
    const tool = tools[role].find((t: Tool) => t.name === name);
    if (!tool) throw new Error(`${role} has no ${name}`);
    const ctx: ToolContext = { threadId: 'th_test', metadata: { modelId: model.id, role, ...extra }, toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`, signal: new AbortController().signal };
    const out = await tool.run(args, ctx);
    return typeof out === 'string' ? { text: out, isError: false, structured: undefined as any } : { isError: false, ...out, structured: out.structured as any };
  };
  return { store, designs, checkpoints, tools, model, ref, call, events, submitted, positions };
}

test('each role gets only its tools, and Blender only when it runs', async () => {
  const { tools } = await setup();
  const names = (r: AgentRole) => tools[r].map((t) => t.name).sort();
  assert.deepEqual(names('fit'), ['analyze_mesh', 'apply_fit', 'apply_mesh_edit', 'check_fit', 'export_placed_mesh', 'get_state', 'list_reference_pots', 'render_views', 'solve_fit']);
  assert.deepEqual(names('design'), ['apply_design', 'build_design', 'check_fit', 'get_state', 'list_reference_pots', 'render_views']);
  assert.deepEqual(names('review'), ['analyze_mesh', 'check_fit', 'get_state', 'list_reference_pots', 'render_views', 'submit_review']);
  for (const role of ['fit', 'design', 'review'] as const) for (const t of tools[role]) assert.equal(t.input.type, 'object', `${t.name}'s schema`);
});

test('a tool refuses a thread of another role', async () => {
  const { tools, model } = await setup();
  const apply = tools.fit.find((t) => t.name === 'apply_fit')!;
  await assert.rejects(async () => apply.run({}, { threadId: 't', metadata: { modelId: model.id, role: 'review' }, signal: new AbortController().signal }), /not available/);
});

test('get_state and list_reference_pots describe the model as the user sees it', async () => {
  const { call, model } = await setup();
  const state = JSON.parse((await call('fit', 'get_state')).text);
  assert.equal(state.model.name, 'Lathe');
  assert.equal(state.nurseryPot.topOD, 60);
  assert.deepEqual(state.transform, model.transform);
  assert.match(state.overhangPreference, /avoid supports/);
  const refs = JSON.parse((await call('fit', 'list_reference_pots')).text);
  assert.equal(refs.length, 1);
});

test('solve, check and apply a fit; the change is live and can be reverted and rated', async () => {
  const { call, store, model, events, checkpoints } = await setup();
  const analysis = await call('fit', 'analyze_mesh');
  assert.match(analysis.text, /suggested up\s+\+Z/);
  const solved = await call('fit', 'solve_fit', { clearance: 5, topOffset: 8 });
  const t = solved.structured.transform;
  assert.ok(Math.abs(t.scale.x - 1) < 0.02, `scale ${t.scale.x}`);
  assert.equal(solved.structured.message, solved.text, 'the agent gets the text even where Claude shows it structured output');
  const checked = await call('fit', 'check_fit', { transform: t });
  assert.equal(checked.structured.metrics.interferes, false);
  assert.match(checked.text, /radial gap/);

  const bad = await call('fit', 'apply_fit', { transform: { ...t, up: 'sideways' }, fit: { ...DEFAULT_FIT, topOffset: 8 }, summary: '', warnings: [], confidence: 'high' });
  assert.equal(bad.isError, true);

  const applied = await call('fit', 'apply_fit', { transform: t, fit: { clearance: 5, scaleMode: 'uniform', topOffset: 8, floorGap: 1 }, summary: 'Fitted.', warnings: [], confidence: 'high' });
  assert.equal(applied.isError, false);
  const cp: Checkpoint = applied.structured.checkpoint;
  assert.equal(cp.kind, 'fit');
  assert.deepEqual(cp.transformBefore, model.transform);
  const after = await store.getModel(model.id);
  assert.deepEqual(after.transform, t);
  assert.equal(after.fit.floorGap, 1, 'the goals the agent applied are adopted');
  assert.ok(events.some((e) => e.type === 'model' && !e.meshChanged));
  assert.ok(events.some((e) => e.type === 'checkpoint' && e.checkpoint.id === cp.id));

  const rated = await checkpoints.rate(model.id, cp.id, 'accepted');
  assert.equal(rated.rating, 'accepted');
  const { model: reverted, checkpoint } = await checkpoints.revert(model.id, cp.id);
  assert.deepEqual(reverted.transform, model.transform);
  assert.equal(reverted.fit.floorGap, model.fit.floorGap);
  assert.ok(checkpoint.revertedAt);
});

test('render_views writes sections and shaded views into renders/', async () => {
  const { call, store, model } = await setup();
  const out = await call('fit', 'render_views', { sections: [0], shaded: true });
  assert.equal(out.structured.files.length, 2);
  for (const f of out.structured.files as string[]) {
    assert.match(f, /^agent\/renders\/[\w-]+\.png$/);
    assert.equal(readFileSync(join(store.modelDir(model.id), f)).subarray(1, 4).toString(), 'PNG');
  }
  assert.match(out.text, /wrote renders\//);
});

test('an exported and re-applied mesh edit replaces the mesh, and reverting puts it back', async () => {
  const { call, store, model } = await setup();
  const exported = await call('fit', 'export_placed_mesh', { out: 'placed.stl' });
  assert.match(exported.text, /apply_mesh_edit/);
  const ws = join(store.modelDir(model.id), 'agent');
  // "Edit" it in Blender: here, keep the same shape.
  const placed = parseSTL(readFileSync(join(ws, 'placed.stl')));
  writeFileSync(join(ws, 'edited.stl'), writeBinarySTL(placed));
  await assert.rejects(() => call('fit', 'apply_mesh_edit', { file: '../../x.stl', transform: model.transform, summary: '', warnings: [], confidence: 'low' }), /inside your working directory/);
  const applied = await call('fit', 'apply_mesh_edit', { file: 'edited.stl', transform: model.transform, summary: 'Same shape.', warnings: [], confidence: 'medium' });
  assert.equal(applied.isError, false, applied.text);
  const cp: Checkpoint = applied.structured.checkpoint;
  assert.equal(cp.meshEdit!.trianglesAfter, placed.length / 9);
  assert.ok(existsSync(join(store.checkpointDir(model.id, cp.id), 'mesh-before.stl')));
  const before = readFileSync(join(store.checkpointDir(model.id, cp.id), 'mesh-before.stl'));
  const { meshChanged } = await new Checkpoints(store, new Designs(store, { root, toolPath })).revert(model.id, cp.id);
  assert.equal(meshChanged, true);
  assert.deepEqual(readFileSync(store.meshFile(model.id)), before);
});

test('a reviewer measures the fitted pot as placed and submits its verdict', async () => {
  const { call, store, model, ref, submitted } = await setup();
  const reviewId = '00000000-0000-4000-8000-000000000001';
  await prepareReviewWorkspace(store, model, ref, reviewId);
  const state = JSON.parse((await call('review', 'get_state', {}, { reviewId })).text);
  assert.equal(state.placed, true);
  const checked = await call('review', 'check_fit', {}, { reviewId });
  assert.ok(checked.structured.metrics.minRadialGap > 0);
  const bad = await call('review', 'submit_review', { verdict: 'maybe', summary: '', findings: [], feedbackForFitter: '' }, { reviewId });
  assert.equal(bad.isError, true);
  const ok = await call('review', 'submit_review', { verdict: 'concerns', summary: 'Thin rim.', findings: [{ severity: 'minor', title: 'Rim', detail: '1.1 mm' }], feedbackForFitter: 'Thicken it.' }, { reviewId });
  assert.equal(ok.isError, false);
  assert.equal(submitted[0].verdict, 'concerns');
});

test('apply_design builds the script, refuses one that fails, and restores unapplied edits', async () => {
  const { store, designs, ref, tools } = await setup();
  const model = await designs.create({ name: 'New design', description: 'plain', images: [], fit: { ...DEFAULT_FIT, referenceId: ref.id }, ref });
  const ctx = (): ToolContext => ({ threadId: 'th_d', metadata: { modelId: model.id, role: 'design' }, toolCallId: 'c1', signal: new AbortController().signal });
  const tool = (n: string) => tools.design.find((t) => t.name === n)!;
  const built = (await tool('build_design').run({}, ctx())) as { text: string };
  assert.match(built.text, /triangles|size/i);

  writeFileSync(designs.scriptPath(model.id), 'export default () => null');
  const refused = (await tool('apply_design').run({ title: 'Broken', summary: '', warnings: [], confidence: 'low' }, ctx())) as { isError: boolean; text: string };
  assert.equal(refused.isError, true);
  assert.match(refused.text, /did not build/);
  assert.equal((await store.listCheckpoints(model.id)).length, 0);

  // The turn ends without applying: the applied script comes back, and the edit is kept aside.
  assert.equal(await designs.restoreApplied(model.id), true);
  assert.notEqual(readFileSync(designs.scriptPath(model.id), 'utf8'), 'export default () => null');
  assert.equal(readFileSync(join(designs.dir(model.id), 'unapplied.mjs'), 'utf8'), 'export default () => null');
  assert.equal(await designs.restoreApplied(model.id), false);

  const applied = (await tool('apply_design').run({ title: 'Plain pot', summary: 'The starter.', warnings: [], confidence: 'high' }, ctx())) as { isError?: boolean; structured: any };
  assert.ok(!applied.isError);
  assert.equal((await store.getModel(model.id)).name, 'Plain pot', 'a design keeps its default name until the agent names it');
  assert.equal(applied.structured.checkpoint.kind, 'design');
});

test('the policy keeps file tools to the workspace and turns the shell off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'potfit-policy-'));
  const ws = join(dir, 'ws');
  const outside = join(dir, 'secret');
  mkdirSync(ws);
  mkdirSync(outside);
  symlinkSync(outside, join(ws, 'link'));
  const policy = potfitPolicy({ readable: [join(root, 'tools', 'blender')] });
  const ask = (role: string, name: string, kind: string, input: unknown = {}) =>
    policy({ name, kind: kind as never, input }, { threadId: 't', thread: { id: 't', harness: 'claude', status: 'running', cwd: ws, created_at: '' }, metadata: { role } });
  assert.equal(ask('fit', 'apply_fit', 'app'), 'allow');
  assert.equal(ask('fit', 'Read', 'read', { file_path: 'renders/a.png' }), 'allow');
  assert.equal(ask('fit', 'Read', 'read', { file_path: join(root, 'tools', 'blender', 'potfit_bpy.py') }), 'allow');
  assert.notEqual(ask('fit', 'Read', 'read', { file_path: '/etc/passwd' }), 'allow');
  assert.notEqual(ask('fit', 'Read', 'read', { file_path: 'link/x' }), 'allow', 'a symlink out of the workspace');
  assert.notEqual(ask('fit', 'Grep', 'search', { path: '..' }), 'allow');
  assert.equal(ask('fit', 'Write', 'edit', { file_path: 'edit.py' }), 'allow');
  assert.notEqual(ask('fit', 'Write', 'edit', { file_path: 'mesh.stl' }), 'allow');
  assert.notEqual(ask('design', 'Write', 'edit', { file_path: 'refs/ref-1.jpg' }), 'allow');
  assert.notEqual(ask('design', 'Write', 'edit', { file_path: '.applied/design.mjs' }), 'allow');
  assert.notEqual(ask('fit', 'Glob', 'search', { pattern: '/etc/**' }), 'allow');
  assert.notEqual(ask('fit', 'Glob', 'search', { pattern: '../**/*.stl' }), 'allow');
  assert.equal(ask('fit', 'Glob', 'search', { pattern: 'renders/*.png' }), 'allow');
  assert.notEqual(ask('review', 'Write', 'edit', { file_path: 'x.txt' }), 'allow');
  assert.match(String((ask('fit', 'Bash', 'shell', { command: 'ls' }) as { deny: string }).deny), /no shell/);
  assert.equal(ask('fit', 'WebFetch', 'web'), 'allow');
  assert.notEqual(ask('review', 'WebFetch', 'web'), 'allow');
  assert.equal(ask('fit', 'SomethingNew', 'other'), 'ask');
  assert.equal(ask('review', 'SomethingNew', 'other'), 'deny');
  assert.equal(ask('review', 'ToolSearch', 'other'), 'allow');
  assert.notEqual(ask('fit', 'x', 'mcp'), 'allow');
});
