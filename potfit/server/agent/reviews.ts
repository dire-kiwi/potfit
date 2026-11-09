// Reviews: a fresh thread per review that sees only the fitted pot, never the fitting
// conversation, and answers with submit_review.

import { randomUUID } from 'node:crypto';
import type { Attachment } from '@dire-kiwi/agent-threads-node';
import { checkFit } from '../../shared/fit.ts';
import type { AgentSettings, Review, ReviewResult } from '../../shared/types.ts';
import type { Store } from '../store.ts';
import type { Agent } from './agent.ts';
import type { Live } from './live.ts';
import { BadRequest } from './settings.ts';
import { describeFit, describeReference, prepareReviewWorkspace, type ReviewedDesign } from './workspace.ts';

export interface ReviewInput {
  /** A screenshot-review focus: the reviewer compares renders with a target picture. */
  focus?: string;
  /** The message, in place of the default one. */
  message?: string;
  images?: Attachment[];
}

const size = (s: ReviewedDesign['originalSize']) => `${s.x.toFixed(1)} x ${s.z.toFixed(1)} mm wide, ${s.y.toFixed(1)} mm tall`;

export class Reviews {
  private store: Store;
  private live: Live;
  agent!: Agent;
  private waiting = new Map<string, (r: Review) => void>();

  constructor(store: Store, live: Live) {
    this.store = store;
    this.live = live;
  }

  list(modelId: string) {
    return this.store.listReviews(modelId);
  }

  /** Mark reviews left running by a previous server process as failed. */
  async recover() {
    for (const model of await this.store.listModels()) {
      for (const r of await this.store.listReviews(model.id)) {
        if (r.status === 'running') await this.store.saveReview({ ...r, status: 'error', error: 'The server stopped during this review.', finishedAt: new Date().toISOString() });
      }
    }
  }

  /** Start a review of the model as it is now. `done` resolves when the reviewer's turn ends. */
  async start(modelId: string, settings: AgentSettings, input: ReviewInput = {}): Promise<{ review: Review; done: Promise<Review> }> {
    const model = await this.store.getModel(modelId);
    const ref = model.fit.referenceId ? await this.store.getReference(model.fit.referenceId) : null;
    if (!ref) throw new BadRequest('Choose a nursery pot before reviewing the fit');
    const id = randomUUID();
    const { ws, design, positions } = await prepareReviewWorkspace(this.store, model, ref, id);
    // Measure what is reviewed, not whatever the user does meanwhile.
    const metrics = checkFit(positions, model.transform, ref, model.fit);
    const review: Review = {
      id,
      modelId,
      threadId: '',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      error: null,
      focus: input.focus ?? null,
      transform: model.transform,
      fit: model.fit,
      referenceId: ref.id,
      metrics,
      result: null,
    };
    const thread = await this.agent.reviewThread(modelId, id, ws, input.focus ? `Review: ${input.focus}` : `Review of ${model.name}`, settings);
    review.threadId = thread.id;
    await this.store.saveReview(review);
    this.live.emit(modelId, { type: 'review', review });
    const { referenceId: _r, ...goals } = model.fit;
    const sc = design.scale;
    const images = input.images ?? [];
    const text =
      input.message ??
      [
        'Review the fitted pot in your working directory.',
        '',
        `Nursery pot: ${describeReference(ref)}`,
        `Goals: ${describeFit(goals)}`,
        `Design: originally ${size(design.originalSize)}; scaled x ${sc.x.toFixed(4)}, y (height) ${sc.y.toFixed(4)}, z ${sc.z.toFixed(4)} to ${size(design.fittedSize)}.`,
        ...(images.length ? [`Attached images, in order: ${images.map((a) => a.name ?? 'image').join('; ')}.`] : []),
        '',
        'Check it, then answer with submit_review.',
      ].join('\n');
    const done = new Promise<Review>((resolve) => this.waiting.set(id, resolve));
    void this.agent.runTurn(thread.id, text, images).catch(async (e) => {
      await this.finish(modelId, id, { status: 'error', error: (e as Error).message });
    });
    return { review, done };
  }

  private async finish(modelId: string, id: string, patch: Partial<Review>): Promise<Review> {
    const r = { ...(await this.store.getReview(modelId, id)), ...patch, finishedAt: new Date().toISOString() };
    await this.store.saveReview(r);
    this.live.emit(modelId, { type: 'review', review: r });
    return r;
  }

  /** submit_review's verdict. */
  async submit(modelId: string, id: string, result: ReviewResult): Promise<Review> {
    return this.finish(modelId, id, { status: 'done', error: null, result });
  }

  /** The reviewer's turn ended: a review it never submitted failed. */
  async turnEnded(modelId: string, id: string) {
    let r = await this.store.getReview(modelId, id).catch(() => null);
    if (!r) return;
    if (r.status === 'running') r = await this.finish(modelId, id, { status: 'error', error: 'The reviewer stopped without submitting a review.' });
    this.waiting.get(id)?.(r);
    this.waiting.delete(id);
  }

  async cancel(modelId: string, id: string) {
    const r = await this.store.getReview(modelId, id);
    if (r.status !== 'running') return r;
    await this.agent.sdk.interrupt(r.threadId).catch(() => undefined);
    return this.finish(modelId, id, { status: 'cancelled' });
  }
}
