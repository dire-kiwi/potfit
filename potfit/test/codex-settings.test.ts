import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BadRequest, codexModels, codexSettingsArgs, parseCodexModels, parseCodexSettings } from '../server/codex-settings.ts';

test('default settings omit overrides; explicit settings produce Codex CLI arguments', () => {
  assert.deepEqual(parseCodexSettings({}), { model: null, effort: null });
  assert.deepEqual(codexSettingsArgs(parseCodexSettings({ model: ' ', effort: '' })), []);
  assert.deepEqual(codexSettingsArgs(parseCodexSettings({ model: ' custom-model ', effort: 'high' })), [
    '-m', 'custom-model', '-c', 'model_reasoning_effort="high"',
  ]);
});

test('invalid settings cannot become CLI arguments', () => {
  for (const model of [42, {}, [], '--help', 'model\n-c evil', 'a'.repeat(201)]) {
    assert.throws(() => parseCodexSettings({ model }), BadRequest);
  }
  for (const effort of [42, {}, [], 'extreme', 'high"\nother=true']) {
    assert.throws(() => parseCodexSettings({ effort }), BadRequest);
  }
});

test('catalog exposes visible models and supported efforts, tolerating malformed metadata', () => {
  assert.deepEqual(parseCodexModels({ models: [null, {},
    { slug: 'hidden', visibility: 'hide' },
    { slug: 'custom-model', display_name: 'Custom model', supported_reasoning_levels: [null, { effort: 'low' }, { effort: 'high' }, { effort: 'new-level' }] },
    { slug: 'another' },
  ] }), [
    { id: 'custom-model', name: 'Custom model', efforts: ['low', 'high'] },
    { id: 'another', name: 'another', efforts: [] },
  ]);
  assert.deepEqual(parseCodexModels(null), []);
});

test('missing or invalid Codex catalogs gracefully allow custom model entry', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'potfit-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await codexModels(home), []);
  await writeFile(join(home, 'models_cache.json'), 'invalid JSON');
  assert.deepEqual(await codexModels(home), []);
  await writeFile(join(home, 'models_cache.json'), '{"models":[{"slug":"custom"}]}');
  assert.equal((await codexModels(home))[0].id, 'custom');
});

test('runner forwards overrides to fresh, resumed and review sessions and saves the settings', async (t) => {
  const { CodexRunner } = await import('../server/codex.ts');
  const { Store } = await import('../server/store.ts');
  const { Designs } = await import('../server/design.ts');
  const { DEFAULT_FIT } = await import('../shared/types.ts');
  const { writeBinarySTL } = await import('../shared/stl.ts');
  const { latheY } = await import('./helpers.ts');
  const { chmod, readFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'potfit-run-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'fake-codex.mjs');
  await writeFile(bin, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
writeFileSync(join(dirname(args[args.indexOf('--output-schema') + 1]), 'argv.json'), JSON.stringify(args));
process.exit(1);
`);
  await chmod(bin, 0o755);
  const store = new Store(home);
  await store.init();
  const ref = await store.createReference({ name: 'Test', topOD: 60, bottomOD: 40, height: 55, notes: '' });
  const mesh = latheY({ r0: 25, r1: 35, h: 60, wall: 2, floor: 2, segments: 16 });
  const model = await store.createModel({
    name: 'Test', sourceFile: 'test.stl', triangleCount: mesh.length / 9,
    fit: { ...DEFAULT_FIT, referenceId: ref.id }, codexThreadId: 'existing-thread',
    transform: { up: '+Y', spin: 0, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  }, writeBinarySTL(mesh));
  const root = new URL('..', import.meta.url).pathname;
  const blender = { bin: 'blender', status: Promise.resolve({ available: false, version: null, error: 'unused' }) };
  const designs = new Designs(store, { root, toolPath: join(root, 'tools/pot-tool.ts'), blender });
  const runner = new CodexRunner(store, designs, { bin, model: 'server-model', sandbox: 'workspace-write', toolPath: join(root, 'tools/pot-tool.ts'), blender });
  // Cancellation must survive preparation before active-run registration.
  for (const pauseAt of ['getModel', 'getReference', 'saveRun'] as const) {
    const controller = new AbortController();
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = store[pauseAt].bind(store);
    // Each method is gated independently, preserving its original arguments/results.
    const access = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    access[pauseAt] = async (...args: unknown[]) => {
      reached(); await gate;
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    };
    const starting = runner.start(model.id, { mode: 'feedback', message: 'Cancelled', images: [] }, controller.signal);
    const outcome = starting.then(run => run, error => error);
    await paused;
    controller.abort();
    release();
    const result = await outcome;
    access[pauseAt] = original as (...args: unknown[]) => Promise<unknown>;
    if (pauseAt === 'saveRun') {
      assert.equal(result.status, 'cancelled');
      assert.equal(await readFile(join(store.runDir(model.id, result.id), 'argv.json')).then(() => true, () => false), false);
    } else {
      assert.equal(result.name, 'AbortError');
    }
    assert.equal(runner.activeRun(model.id), null);
    assert.deepEqual((await store.getModel(model.id)).transform, model.transform);
  }
  for (const mode of ['fit', 'feedback', 'review'] as const) {
    const overrides = mode === 'review' ? {} : { model: 'custom-model', effort: 'high' as const };
    const run = await runner.start(model.id, { mode, message: 'Test', images: mode === 'review' ? [{ name: 'target', ext: 'png', data: Buffer.from('target') }, { name: 'produced', ext: 'png', data: Buffer.from('produced') }] : [], visualReview: mode === 'review' ? 'Compare target and produced independently.' : undefined, ...overrides });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fake Codex timed out')), 5000);
      if (!runner.subscribe(model.id, run.id, (event) => {
        if (event.type === 'result') { clearTimeout(timer); resolve(); }
      })) { clearTimeout(timer); resolve(); }
    });
    const saved = await store.getRun(model.id, run.id);
    assert.deepEqual(saved.settings, mode === 'review' ? { model: 'server-model', effort: null } : overrides);
    const args = JSON.parse(await readFile(join(store.runDir(model.id, run.id), 'argv.json'), 'utf8')) as string[];
    assert.equal(args[args.indexOf('-m') + 1], saved.settings?.model);
    assert.equal(args.includes('model_reasoning_effort="high"'), mode !== 'review');
    assert.equal(args.includes('resume'), mode === 'feedback');
    assert.equal(args.includes('--ephemeral'), mode === 'review');
    if (mode === 'review') {
      assert.ok(args.at(-1)?.startsWith('Compare target and produced independently.'));
      assert.match(args.at(-1)!, /Overhang preference: avoid supports/);
      assert.equal(args.filter(arg => arg === '-i').length, 2);
      assert.equal(await readFile(join(store.runDir(model.id, run.id), 'images/target.png'), 'utf8'), 'target');
      assert.equal(await readFile(join(store.runDir(model.id, run.id), 'images/produced.png'), 'utf8'), 'produced');
    }
  }
});
