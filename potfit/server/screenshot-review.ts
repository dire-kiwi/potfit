// The iterative screenshot review: each round, three independent reviewer threads compare fresh
// renders with a target picture; unless all three pass, the model's own thread adjusts the model
// with their findings. At most 20 rounds; the last is a review, so the loop never ends on an
// unreviewed adjustment.

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment } from '@dire-kiwi/agent-threads-node';
import type { AgentSettings, ScreenshotReview } from '../shared/types.ts';
import { parseSTL } from '../shared/stl.ts';
import { applyTransform, yUpToZUp } from '../shared/transform.ts';
import { renderViews } from '../tools/render3d.ts';
import type { Agent } from './agent/agent.ts';
import { Conflict } from './agent/checkpoints.ts';
import type { Live } from './agent/live.ts';
import { overhangPreference } from './agent/prompts.ts';
import type { Reviews } from './agent/reviews.ts';
import { BadRequest } from './agent/settings.ts';
import type { DesignImage } from './design.ts';
import type { Store } from './store.ts';

export const REVIEW_FOCUS = ['Overall silhouette and proportions', 'Details, pattern and visual style', 'Final visual fidelity and remaining discrepancies'];
export const MAX_ROUNDS = 20;
export const approved = (reviews: { result: { verdict: string } }[]) => reviews.length === REVIEW_FOCUS.length && reviews.every((r) => r.result.verdict === 'pass');

const image = (img: DesignImage, name: string): Attachment => ({
  kind: 'image',
  name,
  media_type: img.ext === 'jpg' ? 'image/jpeg' : `image/${img.ext}`,
  data: img.data.toString('base64'),
});

/** Owns the loop on the server, independently of browser selection or connection. */
export class ScreenshotReviews {
  private running = new Map<string, ScreenshotReview>();
  private controllers = new Map<string, AbortController>();
  private store: Store;
  private agent: Agent;
  private reviews: Reviews;
  private live: Live;
  constructor(store: Store, agent: Agent, reviews: Reviews, live: Live) {
    this.store = store;
    this.agent = agent;
    this.reviews = reviews;
    this.live = live;
  }
  private file(id: string) {
    return join(this.store.modelDir(id), 'screenshot-review.json');
  }
  private async save(id: string, state: ScreenshotReview) {
    const tmp = this.file(id) + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.file(id));
    this.live.emit(id, { type: 'loop', state });
  }
  isRunning(id: string) {
    return this.running.has(id);
  }
  async get(id: string): Promise<ScreenshotReview | null> {
    if (this.running.has(id)) return this.running.get(id)!;
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async recover() {
    for (const model of await this.store.listModels()) {
      const state = await this.get(model.id);
      if (state?.status === 'running') {
        state.status = 'error';
        state.error = 'The server stopped during screenshot review. Start a new review to continue.';
        await this.save(model.id, state);
      }
    }
  }
  cancel(id: string) {
    const state = this.running.get(id);
    if (!state) return false;
    state.status = 'cancelled';
    this.controllers.get(id)?.abort();
    return true;
  }
  async start(id: string, target: DesignImage, settings: AgentSettings, prompt = '') {
    const model = await this.store.getModel(id);
    if (this.isRunning(id) || this.agent.isBusy(model)) throw new Conflict('An agent is already working on this model');
    if (!model.fit.referenceId) throw new BadRequest('Choose a nursery pot first');
    const state: ScreenshotReview = { id: randomUUID(), status: 'running', round: 0, phase: 'Starting', prompt: prompt.trim(), error: null, rounds: [] };
    this.running.set(id, state);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      await this.save(id, state);
    } catch (e) {
      this.running.delete(id);
      this.controllers.delete(id);
      throw e;
    }
    void this.execute(id, state, image(target, 'target'), settings, controller.signal).catch((e) => console.error('Could not save screenshot review:', e));
    return state;
  }
  private async execute(id: string, state: ScreenshotReview, target: Attachment, settings: AgentSettings, signal: AbortSignal) {
    const go = () => state.status === 'running';
    try {
      for (let round = 1; round <= MAX_ROUNDS && go(); round++) {
        state.round = round;
        const entry: ScreenshotReview['rounds'][number] = { round, reviews: [] };
        state.rounds.push(entry);
        const model = await this.store.getModel(id);
        const raw = parseSTL(await readFile(this.store.meshFile(id)));
        const produced = image({ name: 'produced', ext: 'png', data: renderViews(yUpToZUp(applyTransform(raw, model.transform)), { tile: 400 }).png }, 'produced');
        for (const focus of REVIEW_FOCUS) {
          if (!go()) break;
          state.phase = `Reviewing: ${focus}`;
          await this.save(id, state);
          if (!go()) break;
          const message = `Compare the attached target screenshot (target) against the fresh render of the produced work (produced: front, side, three-quarter, top). Your focus: ${focus}. User instructions (apply alongside the target image): ${JSON.stringify(state.prompt || 'No additional instructions')}. ${overhangPreference(model.avoidOverhangs !== false)} Review independently. Judge visual similarity, allowing for camera, lighting and background differences. A pass means no meaningful visual changes remain. Otherwise answer concerns or fail with specific actionable discrepancies in findings and feedbackForFitter. Do not approve merely because the nursery pot fits. Answer with submit_review.`;
          const { review, done } = await this.reviews.start(id, settings, { focus, message, images: [target, produced] });
          const stop = () => void this.reviews.cancel(id, review.id).catch(() => undefined);
          signal.addEventListener('abort', stop, { once: true });
          const finished = await done.finally(() => signal.removeEventListener('abort', stop));
          if (!go()) break;
          if (finished.status !== 'done' || !finished.result) throw new Error(finished.error || 'The reviewer did not finish');
          entry.reviews.push({ focus, reviewId: finished.id, result: finished.result });
          await this.save(id, state);
        }
        if (!go()) break;
        if (approved(entry.reviews)) {
          state.status = 'done';
          break;
        }
        // Every adjustment gets a review after it; the final round never leaves unreviewed work.
        if (round === MAX_ROUNDS) {
          state.status = 'limit';
          break;
        }
        state.phase = 'Worker adjusting the model';
        await this.save(id, state);
        if (!go()) break;
        const current = await this.store.getModel(id);
        if (!go()) break;
        const thread = await this.agent.mainThread(id, settings);
        if (!go()) break;
        const result = await this.agent.runTurn(
          thread.id,
          `Match the target screenshot. Adjust the produced model using this independent review panel's feedback, then apply it. Preserve functional fit and printability.\nUser instructions: ${JSON.stringify(state.prompt || 'No additional instructions')}.\n${overhangPreference(current.avoidOverhangs !== false)}\n\n${entry.reviews.map((r) => `${r.focus}: ${r.result.summary}\n${r.result.feedbackForFitter}\n${r.result.findings.map((f) => f.detail).join('\n')}`).join('\n\n')}`,
          [target, produced],
          signal,
        );
        entry.workerAdjusted = true;
        if (!go()) break;
        if (!result || !result.ok) throw new Error(result?.error || 'The worker did not finish its turn');
      }
    } catch (e) {
      if (go()) {
        state.status = 'error';
        state.error = (e as Error).message;
      }
    } finally {
      state.phase = state.status === 'done' ? 'All reviewers approved' : state.status === 'limit' ? `Reached ${MAX_ROUNDS} review rounds` : state.status;
      try {
        await this.save(id, state);
      } finally {
        this.running.delete(id);
        this.controllers.delete(id);
      }
    }
  }
}
