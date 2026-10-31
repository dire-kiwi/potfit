import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenshotReviews, approved } from '../server/screenshot-review.ts';
import { Store } from '../server/store.ts';
import type { CodexRunner, StartInput } from '../server/codex.ts';
import { DEFAULT_FIT, type CodexRun, type PotModel } from '../shared/types.ts';
import { writeBinarySTL } from '../shared/stl.ts';
import { latheY } from './helpers.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, verdict: (index: number) => string) {
  const dir = await mkdtemp(join(tmpdir(), 'potfit-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.init();
  const model = await store.createModel({ name: 'Test', sourceFile: 'test.stl', triangleCount: 96,
    fit: { ...DEFAULT_FIT, referenceId: 'ref' }, codexThreadId: 'worker-thread',
    transform: { up: '+Y', spin: 0, scale: { x: 1, y: 1, z: 1 }, position: { x: 0, y: 0, z: 0 } },
  }, writeBinarySTL(latheY({ r0: 10, r1: 12, h: 20, wall: 1, floor: 1, segments: 8 })));
  const inputs: StartInput[] = [];
  const runner = {
    activeRun: () => null,
    start: async (_id: string, input: StartInput) => {
      inputs.push(input);
      return { id: String(inputs.length), status: 'done', review: input.mode === 'review' ? {
        verdict: verdict(inputs.length), summary: 'Check silhouette', findings: [], feedbackForFitter: 'Widen the rim',
      } : null } as CodexRun;
    }, cancel: () => true,
  } as unknown as CodexRunner;
  return { store, model, inputs, loop: new ScreenshotReviews(store, runner) };
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
  assert.ok(inputs.every(i => i.visualReview && i.images[0].name === 'target' && i.images[1].data.subarray(1, 4).toString() === 'PNG'));
  assert.equal(JSON.parse(await readFile(join(store.modelDir(model.id), 'screenshot-review.json'), 'utf8')).status, 'done');
});

test('non-unanimous review feeds the worker and re-renders before another panel', async t => {
  const { loop, model, inputs } = await fixture(t, index => index === 2 ? 'concerns' : 'pass');
  await loop.start(model.id, target, {});
  const state = await finished(loop, model);
  assert.equal(state.status, 'done'); assert.equal(state.round, 2);
  assert.equal(inputs[3].mode, 'feedback'); assert.match(inputs[3].message, /Widen the rim/);
  assert.equal(state.rounds[0].workerRunId, '4'); assert.equal(inputs.length, 7);
});

test('stops at 20 panels with no unreviewed final worker adjustment', async t => {
  const { loop, model, inputs } = await fixture(t, () => 'fail');
  await loop.start(model.id, target, {});
  const state = await finished(loop, model);
  assert.equal(state.status, 'limit'); assert.equal(state.rounds.length, 20);
  assert.equal(inputs.filter(i => i.mode === 'review').length, 60);
  assert.equal(inputs.filter(i => i.mode === 'feedback').length, 19);
  assert.equal(state.rounds.at(-1)?.workerRunId, undefined);
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
