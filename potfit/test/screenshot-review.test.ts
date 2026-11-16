import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment } from '@dire-kiwi/agent-threads-node';
import { overhangPreference } from '../server/agent/prompts.ts';
import { Live } from '../server/agent/live.ts';
import type { Agent } from '../server/agent/agent.ts';
import type { ReviewInput, Reviews } from '../server/agent/reviews.ts';
import { ScreenshotReviews, approved } from '../server/screenshot-review.ts';
import { Store } from '../server/store.ts';
import { DEFAULT_FIT, type PotModel } from '../shared/types.ts';
import { writeBinarySTL } from '../shared/stl.ts';
import { latheY } from './helpers.ts';

interface Input {
  mode: 'review' | 'worker';
  message: string;
  images: Attachment[];
}

// The loop with fake reviewer and worker threads: each reviewer answers `verdict(n)` (n counts every
// agent the loop has started), and the worker's turn succeeds.
async function fixture(t: { after(fn: () => Promise<void>): void }, verdict: (index: number) => string) {
  const dir = await mkdtemp(join(tmpdir(), 'potfit-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.init();
  const model = await store.createModel({ name: 'Test', sourceFile: 'test.stl', triangleCount: 96,
    fit: { ...DEFAULT_FIT, referenceId: 'ref' }, threadId: 'worker-thread',
    transform: { up: '+Y', spin: 0, scale: { x: 1, y: 1, z: 1 }, position: { x: 0, y: 0, z: 0 } },
  }, writeBinarySTL(latheY({ r0: 10, r1: 12, h: 20, wall: 1, floor: 1, segments: 8 })));
  const inputs: Input[] = [];
  const reviews = {
    start: async (_id: string, _settings: unknown, input: ReviewInput) => {
      inputs.push({ mode: 'review', message: input.message ?? '', images: input.images ?? [] });
      const review = { id: String(inputs.length), status: 'done', result: { verdict: verdict(inputs.length), summary: 'Check silhouette', findings: [], feedbackForFitter: 'Widen the rim' } };
      return { review, done: Promise.resolve(review) };
    },
    cancel: async () => null,
  } as unknown as Reviews;
  const agent = {
    isBusy: () => false,
    mainThread: async () => ({ id: 'worker-thread' }),
    runTurn: async (_tid: string, message: string, images: Attachment[]) => {
      inputs.push({ mode: 'worker', message, images });
      return { ok: true };
    },
  } as unknown as Agent;
  return { store, model, inputs, loop: new ScreenshotReviews(store, agent, reviews, new Live()) };
}
async function finished(loop: ScreenshotReviews, model: PotModel) {
  // Wait for actual asynchronous file writes and renders, bounded so a regression fails.
  for (let i = 0; i < 1000; i++) {
    if (!loop.isRunning(model.id)) return (await loop.get(model.id))!;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Loop did not finish');
}
const target = { name: 'reference', ext: 'png' as const, data: Buffer.from('target') };

test('unanimous panel approval stops immediately; state and evidence persist', async t => {
  const { loop, model, inputs, store } = await fixture(t, () => 'pass');
  await loop.start(model.id, target, { model: 'review-model' });
  const state = await finished(loop, model);
  assert.equal(state.status, 'done'); assert.equal(state.round, 1); assert.equal(inputs.length, 3);
  assert.ok(inputs.every(i => i.mode === 'review' && i.images[0].name === 'target' && Buffer.from(i.images[1].data!, 'base64').subarray(1, 4).toString() === 'PNG'));
  assert.equal(JSON.parse(await readFile(join(store.modelDir(model.id), 'screenshot-review.json'), 'utf8')).status, 'done');
});

test('non-unanimous review feeds the worker and re-renders before another panel', async t => {
  const { loop, model, inputs } = await fixture(t, index => index === 2 ? 'concerns' : 'pass');
  await loop.start(model.id, target, {});
  const state = await finished(loop, model);
  assert.equal(state.status, 'done'); assert.equal(state.round, 2);
  assert.equal(inputs[3].mode, 'worker'); assert.match(inputs[3].message, /Widen the rim/);
  assert.equal(state.rounds[0].workerAdjusted, true); assert.equal(inputs.length, 7);
});

test('stops at 20 panels with no unreviewed final worker adjustment', async t => {
  const { loop, model, inputs } = await fixture(t, () => 'fail');
  await loop.start(model.id, target, {});
  const state = await finished(loop, model);
  assert.equal(state.status, 'limit'); assert.equal(state.rounds.length, 20);
  assert.equal(inputs.filter(i => i.mode === 'review').length, 60);
  assert.equal(inputs.filter(i => i.mode === 'worker').length, 19);
  assert.equal(state.rounds.at(-1)?.workerAdjusted, undefined);
});

test('cancel prevents subsequent agents; duplicate start rejected; restart marks interruption', async t => {
  const { loop, model, store } = await fixture(t, () => 'fail');
  await loop.start(model.id, target, {});
  await assert.rejects(loop.start(model.id, target, {}), /already working/);
  assert.equal(loop.cancel(model.id), true);
  assert.equal((await finished(loop, model)).status, 'cancelled');
  const file = join(store.modelDir(model.id), 'screenshot-review.json');
  const state = JSON.parse(await readFile(file, 'utf8')); state.status = 'running';
  const { writeFile } = await import('node:fs/promises'); await writeFile(file, JSON.stringify(state));
  await loop.recover(); assert.equal((await loop.get(model.id))?.status, 'error');
  assert.equal(approved([]), false);
});

for (const pauseAt of ['worker save', 'worker model read', 'reviewer save']) {
  test(`cancelling during ${pauseAt} prevents the next agent and preserves the model`, async t => {
    const { loop, model, inputs, store } = await fixture(t, () => 'fail');
    const before = await store.getModel(model.id);
    const meshBefore = await readFile(store.meshFile(model.id));
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    // Pause the exact async boundary from the reported race, after the status check.
    if (pauseAt.endsWith('save')) {
      const access = loop as unknown as { save(id: string, state: { phase: string }): Promise<void> };
      const save = access.save.bind(loop);
      access.save = async (id, state) => {
        if (!intercepted && (pauseAt === 'worker save' ? state.phase === 'Worker adjusting the model' : state.phase.startsWith('Reviewing:'))) {
          intercepted = true; reached(); await gate;
        }
        await save(id, state);
      };
    } else {
      const getModel = store.getModel.bind(store);
      store.getModel = async id => {
        if (!intercepted && inputs.length === 3) { intercepted = true; reached(); await gate; }
        return getModel(id);
      };
    }
    await loop.start(model.id, target, {});
    await paused;
    assert.equal(loop.cancel(model.id), true);
    release();
    const state = await finished(loop, model);
    assert.equal(state.status, 'cancelled');
    assert.equal(inputs.length, pauseAt === 'reviewer save' ? 0 : 3);
    assert.equal(inputs.some(input => input.mode !== 'review'), false);
    assert.deepEqual(await store.getModel(model.id), before);
    assert.deepEqual(await readFile(store.meshFile(model.id)), meshBefore);
  });
}

test('user prompt and accepted supports reach every reviewer and worker and survive reload', async t => {
  const { loop, model, inputs, store } = await fixture(t, index => index === 2 ? 'concerns' : 'pass');
  await store.updateModel(model.id, { avoidOverhangs: false });
  assert.equal((await store.getModel(model.id)).avoidOverhangs, false);
  await loop.start(model.id, target, {}, '  Keep the curved arms.  ');
  await finished(loop, model);
  for (const input of inputs) {
    const prompt = input.message;
    assert.match(prompt, /Keep the curved arms/);
    assert.match(prompt, /supports are accepted/);
    assert.match(prompt, /Preserve functional fit/);
  }
  const reloaded = await new ScreenshotReviews(store, {} as Agent, {} as Reviews, new Live()).get(model.id);
  assert.equal(reloaded?.prompt, 'Keep the curved arms.');
});

test('older models default to avoiding supports; empty iterative prompt stays optional', async t => {
  const { loop, model, inputs } = await fixture(t, () => 'pass');
  assert.equal(model.avoidOverhangs, undefined);
  await loop.start(model.id, target, {});
  const state = await finished(loop, model);
  assert.equal(state.prompt, '');
  assert.ok(inputs.every(input => input.message.includes('avoid supports')));
  assert.match(overhangPreference(), /avoid supports/);
  assert.match(overhangPreference(false), /supports are accepted/);
});
