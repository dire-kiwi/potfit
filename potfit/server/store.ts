// File-backed storage for reference pots, models and Codex runs.
//
// data/
//   references.json
//   models/<id>/model.json      PotModel
//   models/<id>/mesh.stl        normalised binary STL (raw model coordinates)
//   models/<id>/runs/<runId>/   run.json, events.jsonl, images, Codex output
//   models/<id>/codex/          working directory Codex runs in (state.json, AGENTS.md, ...)

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexEvent, CodexRun, ModelPatch, PotModel, ReferenceInput, ReferencePot } from '../shared/types.ts';

async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

export class NotFound extends Error {}

export class Store {
  readonly dir: string;
  // Serialise writes per file so concurrent requests don't lose updates.
  private queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async init() {
    await mkdir(join(this.dir, 'models'), { recursive: true });
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  // ------------------------------------------------------------ references

  private get referencesFile() {
    return join(this.dir, 'references.json');
  }

  listReferences(): Promise<ReferencePot[]> {
    return readJson<ReferencePot[]>(this.referencesFile, []);
  }

  async getReference(id: string): Promise<ReferencePot | null> {
    return (await this.listReferences()).find((r) => r.id === id) ?? null;
  }

  createReference(input: ReferenceInput): Promise<ReferencePot> {
    return this.serial(this.referencesFile, async () => {
      const list = await this.listReferences();
      const now = new Date().toISOString();
      const ref: ReferencePot = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
      list.push(ref);
      await writeJson(this.referencesFile, list);
      return ref;
    });
  }

  updateReference(id: string, input: ReferenceInput): Promise<ReferencePot> {
    return this.serial(this.referencesFile, async () => {
      const list = await this.listReferences();
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) throw new NotFound(`reference ${id} not found`);
      list[i] = { ...list[i], ...input, updatedAt: new Date().toISOString() };
      await writeJson(this.referencesFile, list);
      return list[i];
    });
  }

  deleteReference(id: string): Promise<void> {
    return this.serial(this.referencesFile, async () => {
      const list = await this.listReferences();
      const next = list.filter((r) => r.id !== id);
      if (next.length === list.length) throw new NotFound(`reference ${id} not found`);
      await writeJson(this.referencesFile, next);
    });
  }

  // ---------------------------------------------------------------- models

  modelDir(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFound(`model ${id} not found`);
    return join(this.dir, 'models', id);
  }

  meshFile(id: string) {
    return join(this.modelDir(id), 'mesh.stl');
  }

  async listModels(): Promise<PotModel[]> {
    const ids = await readdir(join(this.dir, 'models')).catch(() => [] as string[]);
    const models = await Promise.all(ids.map((id) => this.getModel(id).catch(() => null)));
    return models.filter((m): m is PotModel => m !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getModel(id: string): Promise<PotModel> {
    const m = await readJson<PotModel | null>(join(this.modelDir(id), 'model.json'), null);
    if (!m) throw new NotFound(`model ${id} not found`);
    return m;
  }

  async createModel(model: Omit<PotModel, 'id' | 'createdAt' | 'updatedAt'>, mesh: Uint8Array): Promise<PotModel> {
    const now = new Date().toISOString();
    const m: PotModel = { ...model, id: randomUUID(), createdAt: now, updatedAt: now };
    const dir = this.modelDir(m.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'mesh.stl'), mesh);
    await writeJson(join(dir, 'model.json'), m);
    return m;
  }

  updateModel(id: string, patch: ModelPatch & { codexThreadId?: string | null }): Promise<PotModel> {
    const file = join(this.modelDir(id), 'model.json');
    return this.serial(file, async () => {
      const m = await this.getModel(id);
      const next: PotModel = { ...m, ...patch, fit: { ...m.fit, ...patch.fit }, updatedAt: new Date().toISOString() };
      await writeJson(file, next);
      return next;
    });
  }

  async deleteModel(id: string): Promise<void> {
    const dir = this.modelDir(id);
    if (!existsSync(dir)) throw new NotFound(`model ${id} not found`);
    await rm(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ runs

  runDir(modelId: string, runId: string) {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new NotFound(`run ${runId} not found`);
    return join(this.modelDir(modelId), 'runs', runId);
  }

  async listRuns(modelId: string): Promise<CodexRun[]> {
    const ids = await readdir(join(this.modelDir(modelId), 'runs')).catch(() => [] as string[]);
    const runs = await Promise.all(ids.map((id) => this.getRun(modelId, id).catch(() => null)));
    return runs.filter((r): r is CodexRun => r !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async getRun(modelId: string, runId: string): Promise<CodexRun> {
    const r = await readJson<CodexRun | null>(join(this.runDir(modelId, runId), 'run.json'), null);
    if (!r) throw new NotFound(`run ${runId} not found`);
    return r;
  }

  async saveRun(run: CodexRun): Promise<void> {
    const dir = this.runDir(run.modelId, run.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'run.json');
    await this.serial(file, () => writeJson(file, run));
  }

  async appendEvent(modelId: string, runId: string, event: CodexEvent): Promise<void> {
    const file = join(this.runDir(modelId, runId), 'events.jsonl');
    await this.serial(file, () => appendFile(file, JSON.stringify(event) + '\n'));
  }

  async readEvents(modelId: string, runId: string): Promise<CodexEvent[]> {
    const text = await readFile(join(this.runDir(modelId, runId), 'events.jsonl'), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CodexEvent);
  }
}
