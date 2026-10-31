import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexRun, CodexSettings, ScreenshotReview } from '../shared/types.ts';
import { parseSTL } from '../shared/stl.ts';
import { applyTransform, yUpToZUp } from '../shared/transform.ts';
import { renderViews } from '../tools/render3d.ts';
import { BadRequest, Conflict, type CodexRunner, type StartInput } from './codex.ts';
import { overhangPreference } from './design-prompt.ts';
import type { DesignImage } from './design.ts';
import type { Store } from './store.ts';

export const REVIEW_FOCUS = ['Overall silhouette and proportions', 'Details, pattern and visual style', 'Final visual fidelity and remaining discrepancies'];
export const MAX_ROUNDS = 20;
export const approved = (reviews: { result: { verdict: string } }[]) => reviews.length === REVIEW_FOCUS.length && reviews.every(r => r.result.verdict === 'pass');

/** Owns the loop on the server, independently of browser selection or connection. */
export class ScreenshotReviews {
  private running = new Map<string, ScreenshotReview>();
  private controllers = new Map<string, AbortController>();
  private store: Store;
  private codex: CodexRunner;
  constructor(store: Store, codex: CodexRunner) { this.store = store; this.codex = codex; }
  private file(id: string) { return join(this.store.modelDir(id), 'screenshot-review.json'); }
  private async save(id: string, state: ScreenshotReview) {
    const tmp = this.file(id) + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.file(id));
  }
  isRunning(id: string) { return this.running.has(id); }
  async get(id: string): Promise<ScreenshotReview | null> {
    if (this.running.has(id)) return this.running.get(id)!;
    try { return JSON.parse(await readFile(this.file(id), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async recover() {
    for (const model of await this.store.listModels()) {
      const state = await this.get(model.id);
      if (state?.status === 'running') {
        state.status = 'error'; state.error = 'The server stopped during screenshot review. Start a new review to continue.';
        await this.save(model.id, state);
      }
    }
  }
  cancel(id: string) {
    const state = this.running.get(id);
    if (!state) return false;
    state.status = 'cancelled';
    this.controllers.get(id)?.abort();
    this.codex.cancel(id);
    return true;
  }
  async start(id: string, target: DesignImage, settings: CodexSettings, prompt = '') {
    if (this.isRunning(id) || this.codex.activeRun(id)) throw new Conflict('An agent is already working on this model');
    const state: ScreenshotReview = { id: randomUUID(), status: 'running', round: 0, phase: 'Starting', prompt: prompt.trim(), error: null, rounds: [] };
    this.running.set(id, state);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const model = await this.store.getModel(id);
      if (!model.fit.referenceId) throw new BadRequest('Choose a reference pot first');
      await this.save(id, state);
    }
    catch (e) { this.running.delete(id); this.controllers.delete(id); throw e; }
    void this.execute(id, state, { ...target, name: 'target' }, settings).catch(e => console.error('Could not save screenshot review:', e));
    return state;
  }
  private async run(id: string, input: StartInput): Promise<CodexRun> {
    const signal = this.controllers.get(id)!.signal;
    signal.throwIfAborted();
    const run = await this.codex.start(id, input, signal);
    if (run.status !== 'running') return run;
    return new Promise((resolve, reject) => {
      const off = this.codex.subscribe(id, run.id, e => { if (e.type === 'result') resolve(e.run); });
      if (!off) this.store.getRun(id, run.id).then(resolve, reject);
    });
  }
  private async execute(id: string, state: ScreenshotReview, target: DesignImage, settings: CodexSettings) {
    try {
      for (let round = 1; round <= MAX_ROUNDS && state.status === 'running'; round++) {
        state.round = round;
        const entry: ScreenshotReview['rounds'][number] = { round, reviews: [] };
        state.rounds.push(entry);
        const model = await this.store.getModel(id);
        const raw = parseSTL(await readFile(this.store.meshFile(id)));
        const produced: DesignImage = { name: 'produced', ext: 'png', data: renderViews(yUpToZUp(applyTransform(raw, model.transform)), { tile: 400 }).png };
        for (const focus of REVIEW_FOCUS) {
          if (state.status !== 'running') break;
          state.phase = `Reviewing: ${focus}`;
          await this.save(id, state);
          if (state.status !== 'running') break;
          const run = await this.run(id, { ...settings, mode: 'review', message: `Screenshot review round ${round}: ${focus}`, images: [target, produced], visualReview:
            `Compare the attached target screenshot (target) against the fresh render of the produced work (produced: front, side, three-quarter, top). Your focus: ${focus}. User instructions (apply alongside the target image): ${JSON.stringify(state.prompt || 'No additional instructions')}. ${overhangPreference(model.avoidOverhangs !== false)} Review independently; do not change any files. Judge visual similarity, allowing for camera, lighting and background differences. A pass means no meaningful visual changes remain. Otherwise return concerns or fail with specific actionable discrepancies in findings and feedbackForFitter. Do not approve merely because the nursery pot fits. Return the required review JSON.` });
          if (state.status !== 'running') break;
          if (run.status !== 'done' || !run.review) throw new Error(run.error || 'Reviewer did not complete');
          entry.reviews.push({ focus, runId: run.id, result: run.review });
          await this.save(id, state);
        }
        if (state.status !== 'running') break;
        if (approved(entry.reviews)) { state.status = 'done'; break; }
        // Every adjustment gets a subsequent review; the final round never leaves unreviewed work.
        if (round === MAX_ROUNDS) { state.status = 'limit'; break; }
        state.phase = 'Worker adjusting the model';
        await this.save(id, state);
        if (state.status !== 'running') break;
        const current = await this.store.getModel(id);
        if (state.status !== 'running') break;
        const mode = current.design ? (current.design.threadId ? 'design-feedback' : 'design') : (current.codexThreadId ? 'feedback' : 'fit');
        const run = await this.run(id, { ...settings, mode, images: [target, produced], message:
          `Match the target screenshot. Adjust the produced model using this independent review panel's feedback. Preserve functional fit and printability.\nUser instructions: ${JSON.stringify(state.prompt || 'No additional instructions')}.\n${overhangPreference(current.avoidOverhangs !== false)}\n${entry.reviews.map(r => `${r.focus}: ${r.result.summary}\n${r.result.feedbackForFitter}\n${r.result.findings.map(f => f.detail).join('\n')}`).join('\n\n')}` });
        entry.workerRunId = run.id;
        if (state.status !== 'running') break;
        if (run.status !== 'done') throw new Error(run.error || 'Worker did not complete');
      }
    } catch (e) {
      if (state.status === 'running') { state.status = 'error'; state.error = (e as Error).message; }
    } finally {
      state.phase = state.status === 'done' ? 'All reviewers approved' : state.status === 'limit' ? 'Reached 20 review rounds' : state.status;
      try { await this.save(id, state); }
      finally { this.running.delete(id); this.controllers.delete(id); }
    }
  }
}
