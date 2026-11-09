// File-backed storage for reference pots, models, the agent's checkpoints and reviews.
// Threads themselves are in agent-threads' store (data/threads.db).
//
// data/
//   references.json
//   models/<id>/model.json             PotModel
//   models/<id>/mesh.stl               normalised binary STL (raw model coordinates)
//   models/<id>/agent/                 working directory the fitting agent runs in
//   models/<id>/design/                designed pots: design.mjs, refs/ (the user's images), parts/,
//                                      and the design agent's working files
//   models/<id>/checkpoints/<id>/      checkpoint.json and what a change replaced (mesh, script, parts)
//   models/<id>/reviews/<id>/          review.json and the reviewer's workspace

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, ModelPatch, Review, PotDesign, PotModel, ReferenceInput, ReferencePot } from '../shared/types.ts';

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

  async createModel(model: Omit<PotModel, 'id' | 'createdAt' | 'updatedAt'>, mesh: Uint8Array, id: string = randomUUID()): Promise<PotModel> {
    const now = new Date().toISOString();
    const m: PotModel = { ...model, id, createdAt: now, updatedAt: now };
    const dir = this.modelDir(m.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'mesh.stl'), mesh);
    await writeJson(join(dir, 'model.json'), m);
    return m;
  }

  /** `patch.design` is merged into a designed model's design; it is ignored for imported models. */
  updateModel(id: string, patch: ModelPatch & Partial<Pick<PotModel, 'threadId' | 'triangleCount'>> & { design?: Partial<PotDesign> }): Promise<PotModel> {
    const file = join(this.modelDir(id), 'model.json');
    return this.serial(file, async () => {
      const m = await this.getModel(id);
      const { design, ...rest } = patch;
      const next: PotModel = {
        ...m,
        ...rest,
        fit: { ...m.fit, ...patch.fit },
        ...(m.design && design ? { design: { ...m.design, ...design } } : {}),
        updatedAt: new Date().toISOString(),
      };
      await writeJson(file, next);
      return next;
    });
  }

  async deleteModel(id: string): Promise<void> {
    const dir = this.modelDir(id);
    if (!existsSync(dir)) throw new NotFound(`model ${id} not found`);
    await rm(dir, { recursive: true, force: true });
  }

  // ----------------------------------------------------------- checkpoints

  checkpointDir(modelId: string, id: string) {
    if (!/^[\w-]{1,80}$/.test(id)) throw new NotFound(`checkpoint ${id} not found`);
    return join(this.modelDir(modelId), 'checkpoints', id);
  }

  async listCheckpoints(modelId: string): Promise<Checkpoint[]> {
    const ids = await readdir(join(this.modelDir(modelId), 'checkpoints')).catch(() => [] as string[]);
    const all = await Promise.all(ids.map((id) => this.getCheckpoint(modelId, id).catch(() => null)));
    return all.filter((c): c is Checkpoint => c !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getCheckpoint(modelId: string, id: string): Promise<Checkpoint> {
    const c = await readJson<Checkpoint | null>(join(this.checkpointDir(modelId, id), 'checkpoint.json'), null);
    if (!c) throw new NotFound(`checkpoint ${id} not found`);
    return c;
  }

  async saveCheckpoint(c: Checkpoint): Promise<void> {
    const dir = this.checkpointDir(c.modelId, c.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'checkpoint.json');
    await this.serial(file, () => writeJson(file, c));
  }

  // --------------------------------------------------------------- reviews

  reviewDir(modelId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFound(`review ${id} not found`);
    return join(this.modelDir(modelId), 'reviews', id);
  }

  async listReviews(modelId: string): Promise<Review[]> {
    const ids = await readdir(join(this.modelDir(modelId), 'reviews')).catch(() => [] as string[]);
    const all = await Promise.all(ids.map((id) => this.getReview(modelId, id).catch(() => null)));
    return all.filter((r): r is Review => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getReview(modelId: string, id: string): Promise<Review> {
    const r = await readJson<Review | null>(join(this.reviewDir(modelId, id), 'review.json'), null);
    if (!r) throw new NotFound(`review ${id} not found`);
    return r;
  }

  async saveReview(r: Review): Promise<void> {
    const dir = this.reviewDir(r.modelId, r.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'review.json');
    await this.serial(file, () => writeJson(file, r));
  }
}
