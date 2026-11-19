// Model versions: the states a model has been in, as a tree. Every change the agent applies makes a
// version whose parent is the version the model was at, and so do the user's own edits when
// something would otherwise replace them. Going back to an earlier version and changing it makes
// a new branch from there; the other branches stay, and the user can go back to any of them.
//
// A version keeps the placement, goals and triangle count, and the mesh (and for a designed pot
// its applied script, parts and build) by sha-256 in versions/blobs/, so a mesh many versions
// share is stored once.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelVersion, PotModel } from '../shared/types.ts';
import type { Live } from './agent/live.ts';
import type { Designs } from './design.ts';
import type { Store } from './store.ts';

type State = Pick<ModelVersion, 'transform' | 'fit' | 'triangleCount' | 'mesh' | 'design'>;

/** JSON with sorted keys, so equal states compare equal whatever order their keys were written in. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What makes two versions the same pot: not when they were built or what the build reported. */
const sameState = (a: State, b: State) =>
  canon([a.transform, a.fit, a.mesh, a.design?.script, a.design?.parts, a.design?.state.params]) ===
  canon([b.transform, b.fit, b.mesh, b.design?.script, b.design?.parts, b.design?.state.params]);

/** A short label from the agent's summary: its first sentence, trimmed. */
export function labelFrom(text: string, fallback: string): string {
  const first = text.trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? '';
  if (!first) return fallback;
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
}

export class Versions {
  private store: Store;
  private designs: Designs;
  private live: Live | null;
  private queues = new Map<string, Promise<unknown>>();

  constructor(store: Store, designs: Designs, live: Live | null = null) {
    this.store = store;
    this.designs = designs;
    this.live = live;
  }

  /** One version change at a time per model. */
  private serial<T>(modelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(modelId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(modelId, next.catch(() => undefined));
    return next;
  }

  /** Keep a file among the blobs (once), returning its sha-256. */
  private async keep(modelId: string, file: string): Promise<string> {
    const data = await readFile(file);
    const sha = createHash('sha256').update(data).digest('hex');
    const blob = this.store.blobFile(modelId, sha);
    if (!existsSync(blob)) {
      await mkdir(dirname(blob), { recursive: true });
      const tmp = `${blob}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, blob);
    }
    return sha;
  }

  /** The model as it is now, as a version keeps it, its files kept among the blobs. */
  private async state(model: PotModel): Promise<State> {
    const mesh = await this.keep(model.id, this.store.meshFile(model.id));
    let design: ModelVersion['design'] = null;
    if (model.design) {
      // As applied: the agent's unapplied edits to design.mjs and parts/ aren't the pot the user sees.
      const applied = this.designs.appliedScript(model.id);
      const script = await this.keep(model.id, existsSync(applied) ? applied : this.designs.scriptPath(model.id));
      const appliedParts = this.designs.appliedParts(model.id);
      const partsDir = existsSync(applied) ? appliedParts : this.designs.partsDir(model.id);
      const parts: Record<string, string> = {};
      if (existsSync(partsDir)) {
        for (const e of await readdir(partsDir, { recursive: true, withFileTypes: true })) {
          if (!e.isFile()) continue;
          const path = join(e.parentPath, e.name);
          parts[path.slice(partsDir.length + 1)] = await this.keep(model.id, path);
        }
      }
      const { params, paramSpec, report, builtFor, builtAt } = model.design;
      design = { script, parts, state: { params, paramSpec, report, builtFor, builtAt } };
    }
    return { transform: model.transform, fit: model.fit, triangleCount: model.triangleCount, mesh, design };
  }

  private async add(model: PotModel, info: Pick<ModelVersion, 'kind' | 'label' | 'checkpointId'>, state: State, parentId: string | null) {
    const all = await this.store.listVersions(model.id);
    const createdAt = new Date().toISOString();
    const version: ModelVersion = {
      id: `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      modelId: model.id,
      parentId,
      number: (all.at(-1)?.number ?? 0) + 1,
      createdAt,
      ...info,
      ...state,
    };
    await this.store.saveVersion(version);
    const updated = await this.store.updateModel(model.id, { versionId: version.id });
    this.live?.emit(model.id, { type: 'version', version });
    return { version, model: updated };
  }

  private async head(model: PotModel): Promise<ModelVersion | null> {
    return model.versionId ? this.store.getVersion(model.id, model.versionId).catch(() => null) : null;
  }

  /**
   * Make sure the model as it is now is a version: its first one if it has none, or, if the user has
   * changed it since its version, a new version of their edits. Returns the version it made, if any.
   */
  ensureCurrent(modelId: string, opts: { kind?: 'manual' | 'saved'; label?: string } = {}): Promise<ModelVersion | null> {
    return this.serial(modelId, () => this.ensureCurrentNow(modelId, opts));
  }

  private async ensureCurrentNow(modelId: string, opts: { kind?: 'manual' | 'saved'; label?: string }): Promise<ModelVersion | null> {
    const model = await this.store.getModel(modelId);
    const head = await this.head(model);
    const state = await this.state(model);
    if (head && sameState(head, state)) return null;
    if (!head) {
      // Models from before versions had changes already; their history starts here.
      const older = (await this.store.listCheckpoints(modelId)).length > 0;
      const label = opts.label ?? (older ? 'Where the history starts' : model.design ? 'Starter design' : 'Imported');
      return (await this.add(model, { kind: 'original', label, checkpointId: null }, state, null)).version;
    }
    return (await this.add(model, { kind: opts.kind ?? 'manual', label: opts.label ?? 'Your edits', checkpointId: null }, state, head.id)).version;
  }

  /** A version of the model as a change the agent applied has left it, a child of the one it was at. */
  record(modelId: string, info: { kind: ModelVersion['kind']; label: string; checkpointId: string | null }): Promise<{ version: ModelVersion; model: PotModel }> {
    return this.serial(modelId, async () => {
      const model = await this.store.getModel(modelId);
      const head = await this.head(model);
      return this.add(model, info, await this.state(model), head?.id ?? null);
    });
  }

  /**
   * Put the model back as it was at a version. The user's edits since its current version are kept
   * as a version first, so nothing is lost, and the next change makes a new branch from this one.
   */
  checkout(modelId: string, id: string): Promise<{ model: PotModel; version: ModelVersion; meshChanged: boolean }> {
    return this.serial(modelId, async () => {
      await this.ensureCurrentNow(modelId, {});
      const version = await this.store.getVersion(modelId, id);
      const model = await this.store.getModel(modelId);
      const head = await this.head(model);
      const meshChanged = head?.mesh !== version.mesh;
      if (meshChanged) await this.restoreBlob(modelId, version.mesh, this.store.meshFile(modelId));
      if (version.design && model.design) {
        await this.restoreBlob(modelId, version.design.script, this.designs.scriptPath(modelId));
        const parts = this.designs.partsDir(modelId);
        await rm(parts, { recursive: true, force: true });
        for (const [path, sha] of Object.entries(version.design.parts)) await this.restoreBlob(modelId, sha, join(parts, path));
        await this.designs.markApplied(modelId);
        await rm(join(this.designs.dir(modelId), 'unapplied.mjs'), { force: true });
      }
      const updated = await this.store.updateModel(modelId, {
        transform: version.transform,
        fit: version.fit,
        triangleCount: version.triangleCount,
        versionId: version.id,
        versionSwitchedAt: new Date().toISOString(),
        ...(version.design && model.design ? { design: { ...version.design.state, buildError: null } } : {}),
      });
      return { model: updated, version, meshChanged };
    });
  }

  private async restoreBlob(modelId: string, sha: string, to: string) {
    const blob = this.store.blobFile(modelId, sha);
    if (!existsSync(blob)) throw new Error(`A file of this version is missing (${sha.slice(0, 12)})`);
    if (!join(to).startsWith(this.store.modelDir(modelId))) throw new Error('A version may only write inside its model');
    await mkdir(dirname(to), { recursive: true });
    await copyFile(blob, `${to}.tmp`);
    await rename(`${to}.tmp`, to);
  }

  /** Rename a version. */
  async rename(modelId: string, id: string, label: string): Promise<ModelVersion> {
    return this.serial(modelId, async () => {
      const version = { ...(await this.store.getVersion(modelId, id)), label };
      await this.store.saveVersion(version);
      this.live?.emit(modelId, { type: 'version', version });
      return version;
    });
  }
}
