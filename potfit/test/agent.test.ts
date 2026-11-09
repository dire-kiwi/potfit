// potfit's Agent on agent-threads, against a scriptable fake `claude` (test/fixtures/mini-claude.mjs,
// from agent-threads): threads per model and per review, potfit's context on messages, app tools
// called over Claude Code's control channel, the permission policy, and reviews. Then the Codex
// migration.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ThreadEvent } from '@dire-kiwi/agent-threads-node';
import { analyzeMesh, initialTransform, solveFit } from '../shared/fit.ts';
import { writeBinarySTL } from '../shared/stl.ts';
import { DEFAULT_FIT } from '../shared/types.ts';
import { Agent, withoutContext } from '../server/agent/agent.ts';
import { Checkpoints } from '../server/agent/checkpoints.ts';
import { Live } from '../server/agent/live.ts';
import { Reviews } from '../server/agent/reviews.ts';
import { Designs } from '../server/design.ts';
import { migrateFromCodex } from '../server/migrate.ts';
import { Store } from '../server/store.ts';
import { latheY, yToZ } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');
const toolPath = join(root, 'tools', 'pot-tool.ts');
const fakeClaude = join(import.meta.dirname, 'fixtures', 'mini-claude.mjs');

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'potfit-agent-'));
  const store = new Store(dir);
  await store.init();
  const designs = new Designs(store, { root, toolPath });
  const live = new Live();
  const checkpoints = new Checkpoints(store, designs);
  const reviews = new Reviews(store, live);
  const agent = new Agent({
    store,
    designs,
    checkpoints,
    live,
    threadsDb: join(dir, 'threads.db'),
    toolPath,
    blender: { bin: 'blender', status: Promise.resolve({ available: false, version: null, error: 'none' }) },
    claude: { bin: process.execPath, binArgs: [fakeClaude] },
    defaultModel: 'haiku',
    defaultEffort: null,
    submitReview: (m, r, result) => reviews.submit(m, r, result),
    onReviewTurnEnd: (m, r) => void reviews.turnEnded(m, r),
  });
  reviews.agent = agent;
  await agent.init();
  t.after(() => agent.close());
  const ref = await store.createReference({ name: '60/40x55', topOD: 60, bottomOD: 40, height: 55, notes: '' });
  const positions = yToZ(latheY({ r0: 36, r1: 39, h: 50, wall: 3, floor: 3 }));
  const model = await store.createModel(
    { name: 'Lathe', sourceFile: 'lathe.stl', triangleCount: positions.length / 9, transform: initialTransform(positions, analyzeMesh(positions)), fit: { ...DEFAULT_FIT, referenceId: ref.id, topOffset: 8 }, threadId: null },
    writeBinarySTL(positions),
  );
  const events: ThreadEvent[] = [];
  agent.sdk.subscribe((e) => events.push(e));
  return { dir, store, agent, reviews, live, model, ref, positions, events };
}

test('a fitting thread gets potfit context, calls app tools and is held to the policy', async (t) => {
  const { store, agent, model, ref, positions, events } = await setup(t);
  const thread = await agent.mainThread(model.id, { effort: 'low' });
  assert.equal(thread.model, 'haiku', 'the server default model');
  assert.equal(thread.effort, 'low');
  assert.equal((await store.getModel(model.id)).threadId, thread.id);
  assert.equal((await agent.mainThread(model.id)).id, thread.id, 'one thread per model');
  assert.ok(existsSync(join(store.modelDir(model.id), 'agent', 'mesh.stl')));

  const solved = solveFit(positions, ref, { up: '+Z', spin: 0, mode: 'uniform', clearance: 5, topOffset: 8, floorGap: 0 });
  const args = { transform: solved.transform, fit: { clearance: 5, scaleMode: 'uniform', topOffset: 8, floorGap: 0 }, summary: 'Fitted.', warnings: [], confidence: 'high' };
  // mini-claude reads "app <tool> <json>"; the space after the JSON keeps potfit's context out of it.
  const result = await agent.runTurn(thread.id, `app apply_fit ${JSON.stringify(args)} `);
  assert.equal(result?.ok, true);
  const after = await store.getModel(model.id);
  assert.deepEqual(after.transform, solved.transform);
  const [cp] = await store.listCheckpoints(model.id);
  assert.equal(cp.threadId, thread.id);

  const sent = events.find((e) => e.type === 'item.added' && e.item.type === 'user_message');
  const text = sent && sent.type === 'item.added' && sent.item.type === 'user_message' ? sent.item.text : '';
  assert.match(text, /<potfit-context>[\s\S]*Nursery pot: 60\/40x55[\s\S]*Overhang preference: avoid supports[\s\S]*<\/potfit-context>$/);
  assert.equal(withoutContext(text).trim(), `app apply_fit ${JSON.stringify(args)}`);

  // The user moves it by hand: the next message says so.
  await store.updateModel(model.id, { transform: { ...solved.transform, spin: 30 } });
  await agent.runTurn(thread.id, 'reply ok');
  const second = events.filter((e) => e.type === 'item.added' && e.item.type === 'user_message').at(-1);
  assert.match(second && second.type === 'item.added' && second.item.type === 'user_message' ? second.item.text : '', /moved or scaled it by hand/);

  // No shell, and nothing outside the workspace.
  await agent.runTurn(thread.id, 'tool Bash {"command":"id"} ');
  await agent.runTurn(thread.id, 'tool Read {"file_path":"/etc/passwd"} ');
  const snap = await agent.sdk.snapshot(thread.id);
  const denied = snap.items.flatMap((i) => (i.type === 'tool_call' && (i.name === 'Bash' || i.name === 'Read') ? [i.status] : []));
  assert.deepEqual(denied, ['denied', 'denied'], JSON.stringify(snap.items.map((i) => [i.type, i.type === 'tool_call' ? i.name : i.type === 'user_message' ? i.text.slice(0, 40) : i.type === 'notice' ? (i as any).text ?? (i as any).message : i.type === 'turn_result' ? (i as any).error ?? (i as any).ok : ''])));
  assert.equal(agent.isBusy(await store.getModel(model.id)), false);
});

test('commands from the browser are checked', async (t) => {
  const { agent, model } = await setup(t);
  const thread = await agent.mainThread(model.id);
  await assert.rejects(agent.handle({ type: 'send', thread_id: 'th_nope', text: 'hi' }), /unknown thread/);
  await assert.rejects(agent.handle({ type: 'set_options', thread_id: thread.id, permission_mode: 'bypass' }), /permission modes/);
  await agent.handle({ type: 'set_options', thread_id: thread.id, model: 'sonnet' });
  assert.equal((await agent.sdk.get(thread.id))?.model, 'sonnet');
});

test('a review runs in a thread of its own and records its verdict', async (t) => {
  const { store, agent, reviews, model } = await setup(t);
  const verdict = { verdict: 'pass', summary: 'Fine.', findings: [], feedbackForFitter: '' };
  const { review, done } = await reviews.start(model.id, {}, { message: `app submit_review ${JSON.stringify(verdict)}` });
  assert.equal(review.status, 'running');
  assert.notEqual(review.threadId, (await store.getModel(model.id)).threadId);
  const thread = await agent.sdk.get(review.threadId);
  assert.equal(thread?.permission_mode, 'dont_ask');
  assert.ok(existsSync(join(store.reviewDir(model.id, review.id), 'fitted.stl')));
  const finished = await done;
  assert.equal(finished.status, 'done');
  assert.equal(finished.result?.verdict, 'pass');
  assert.ok(finished.metrics, 'the reviewed placement is measured');

  const { done: silent } = await reviews.start(model.id, {}, { message: 'reply I forgot' });
  assert.equal((await silent).status, 'error');
});

test("threads are configured again after a restart, and a deleted model's threads go", async (t) => {
  const { dir, store, agent, model } = await setup(t);
  const thread = await agent.mainThread(model.id);
  await agent.close();
  const designs = new Designs(store, { root, toolPath });
  const again = new Agent({
    store,
    designs,
    checkpoints: new Checkpoints(store, designs),
    live: new Live(),
    threadsDb: join(dir, 'threads.db'),
    toolPath,
    blender: { bin: 'blender', status: Promise.resolve({ available: false, version: null, error: 'none' }) },
    claude: { bin: process.execPath, binArgs: [fakeClaude] },
    defaultModel: null,
    defaultEffort: null,
    submitReview: async () => null,
  });
  await again.init();
  t.after(() => again.close());
  const result = await again.runTurn(thread.id, 'app get_state {} ');
  assert.equal(result?.ok, true);
  const snap = await again.sdk.snapshot(thread.id);
  const call = snap.items.find((i) => i.type === 'tool_call' && i.name === 'get_state');
  assert.equal(call && call.type === 'tool_call' ? call.status : null, 'completed');
  await again.forgetModel(model.id);
  assert.equal(await again.sdk.get(thread.id), null);
});

test("the Codex migration removes Codex's runs and workspaces once, and keeps the models", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'potfit-migrate-'));
  const m = join(dir, 'models', '11111111-1111-4111-8111-111111111111');
  for (const d of ['runs/r1', 'codex', 'design/parts']) mkdirSync(join(m, d), { recursive: true });
  writeFileSync(join(m, 'model.json'), JSON.stringify({ id: 'x', name: 'Old', codexThreadId: 'abc', design: { threadId: 'def', params: { wall: 2 } } }));
  writeFileSync(join(m, 'mesh.stl'), 'mesh');
  for (const f of ['design/AGENTS.md', 'design/pot-tool', 'design/failed.mjs', 'design/design.mjs', 'screenshot-review.json']) writeFileSync(join(m, f), 'x');
  const out = await migrateFromCodex(dir);
  assert.deepEqual(out, { models: 1, runs: 1 });
  for (const gone of ['runs', 'codex', 'design/AGENTS.md', 'design/pot-tool', 'design/failed.mjs', 'screenshot-review.json']) assert.equal(existsSync(join(m, gone)), false, gone);
  for (const kept of ['mesh.stl', 'design/design.mjs', 'design/parts']) assert.ok(existsSync(join(m, kept)), kept);
  const model = JSON.parse(readFileSync(join(m, 'model.json'), 'utf8'));
  assert.equal(model.codexThreadId, undefined);
  assert.equal(model.design.threadId, undefined);
  assert.deepEqual(model.design.params, { wall: 2 });
  assert.equal(await migrateFromCodex(dir), null, 'only once');
});
