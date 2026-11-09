// Checkpoints: what an applying tool call (apply_fit, apply_mesh_edit, apply_design) replaced, so
// the user can revert it, and how they rated it.

import { copyFile, cp, mkdir, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, PotModel } from '../../shared/types.ts';
import type { Designs } from '../design.ts';
import { NotFound, type Store } from '../store.ts';
import { BadRequest } from './settings.ts';

export class Conflict extends Error {}

type New = Omit<Checkpoint, 'id' | 'modelId' | 'createdAt' | 'transformBefore' | 'fitBefore' | 'paramsBefore' | 'triangleCountBefore' | 'rating' | 'revertedAt'>;

export class Checkpoints {
  private store: Store;
  private designs: Designs;

  constructor(store: Store, designs: Designs) {
    this.store = store;
    this.designs = designs;
  }

  /** A checkpoint id from the tool call's (unique per thread), or a fresh one. */
  private newId(toolCallId: string | null) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const tail = (toolCallId ?? Math.random().toString(36).slice(2, 10)).replace(/[^\w-]/g, '').slice(-24);
    return `${stamp}-${tail}`;
  }

  /**
   * Save what `before` was, before a change is made: its placement, goals and params, and for a mesh
   * edit its mesh, for a design its last applied script and parts. Returns the checkpoint, which the
   * caller fills in and saves with `save` once the change is made.
   */
  async begin(before: PotModel, change: { kind: Checkpoint['kind']; threadId: string; toolCallId: string | null }): Promise<Checkpoint> {
    const id = this.newId(change.toolCallId);
    const dir = this.store.checkpointDir(before.id, id);
    await mkdir(dir, { recursive: true });
    if (change.kind === 'mesh-edit') await copyFile(this.store.meshFile(before.id), join(dir, 'mesh-before.stl'));
    if (change.kind === 'design') {
      const applied = this.designs.appliedScript(before.id);
      await copyFile(existsSync(applied) ? applied : this.designs.scriptPath(before.id), join(dir, 'before.mjs'));
      // The parts as they were applied, not as the agent has changed them since.
      const appliedParts = join(this.designs.appliedDirOf(before.id), 'parts-before');
      if (existsSync(appliedParts)) await cp(appliedParts, join(dir, 'parts-before'), { recursive: true });
      else await this.designs.snapshotParts(before.id, dir);
    }
    return {
      id,
      modelId: before.id,
      threadId: change.threadId,
      toolCallId: change.toolCallId,
      kind: change.kind,
      createdAt: new Date().toISOString(),
      summary: '',
      warnings: [],
      confidence: 'medium',
      transform: before.transform,
      fit: before.fit,
      transformBefore: before.transform,
      fitBefore: before.fit,
      paramsBefore: before.design?.params ?? null,
      triangleCountBefore: before.triangleCount,
      meshEdit: null,
      designReport: null,
      metrics: null,
      rating: null,
      revertedAt: null,
    };
  }

  async save(c: Checkpoint & Partial<New>): Promise<Checkpoint> {
    await this.store.saveCheckpoint(c);
    return c;
  }

  /** Put the model back as it was before the checkpoint's change. */
  async revert(modelId: string, id: string): Promise<{ model: PotModel; checkpoint: Checkpoint; meshChanged: boolean }> {
    const c = await this.store.getCheckpoint(modelId, id);
    const dir = this.store.checkpointDir(modelId, id);
    let model: PotModel;
    let meshChanged = false;
    if (c.kind === 'design') {
      if (!existsSync(join(dir, 'before.mjs'))) throw new NotFound('This checkpoint has no saved script to go back to');
      await this.designs.restoreParts(modelId, dir);
      model = await this.designs.rebuild(modelId, { script: await readFile(join(dir, 'before.mjs'), 'utf8'), params: c.paramsBefore ?? {}, resetParams: true });
      model = await this.store.updateModel(modelId, { fit: c.fitBefore });
      meshChanged = true;
    } else {
      if (c.kind === 'mesh-edit') {
        const before = join(dir, 'mesh-before.stl');
        if (!existsSync(before)) throw new BadRequest('This checkpoint has no mesh to go back to');
        const mesh = this.store.meshFile(modelId);
        await copyFile(before, `${mesh}.tmp`);
        await rename(`${mesh}.tmp`, mesh);
        meshChanged = true;
      }
      model = await this.store.updateModel(modelId, { transform: c.transformBefore, fit: c.fitBefore, triangleCount: c.triangleCountBefore });
    }
    const checkpoint = { ...c, revertedAt: new Date().toISOString() };
    await this.store.saveCheckpoint(checkpoint);
    return { model, checkpoint, meshChanged };
  }

  async rate(modelId: string, id: string, rating: Checkpoint['rating']): Promise<Checkpoint> {
    const c = { ...(await this.store.getCheckpoint(modelId, id)), rating };
    await this.store.saveCheckpoint(c);
    return c;
  }
}
