// Runs `codex exec` to fit a model, review a fit or design a pot, streams its
// events, and applies (fit, design) or records (review) the result.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkFit } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { applyTransform, computeBounds, orientedBounds, validateTransform } from '../shared/transform.ts';
import type { CodexEvent, CodexItem, CodexResult, CodexRun, CodexRunKind, DesignResult, FitGoals, PotModel, ReferencePot, ReviewResult } from '../shared/types.ts';
import { DEFAULT_DESIGN_NAME, type DesignImage, type Designs } from './design.ts';
import { DESIGN_SCHEMA, designFeedbackPrompt, designPrompt } from './design-prompt.ts';
import { agentsMd, feedbackPrompt, fitPrompt, OUTPUT_SCHEMA, REVIEW_SCHEMA, reviewAgentsMd, reviewPrompt } from './prompt.ts';
import type { Store } from './store.ts';

export class Conflict extends Error {}
export class BadRequest extends Error {}

export interface CodexOptions {
  bin: string;
  model: string | null;
  /** Absolute path of tools/pot-tool.ts. */
  toolPath: string;
}

interface ActiveRun {
  run: CodexRun;
  child: ChildProcess | null;
  events: CodexEvent[];
  listeners: Set<(e: CodexEvent) => void>;
  cancelled: boolean;
}

export interface StartInput {
  mode: CodexRunKind;
  message: string;
  /** Screenshots of the app's views. */
  images: DesignImage[];
  /** Images the user attached; designed pots keep them as reference images. */
  attachments?: DesignImage[];
}

const isDesignRun = (kind: CodexRunKind) => kind === 'design' || kind === 'design-feedback';

const MAX_OUTPUT = 6000;
const truncate = (s: string | undefined, n = MAX_OUTPUT) => (s && s.length > n ? `${s.slice(0, n)}\n... (${s.length - n} more characters)` : s);

/** "/usr/bin/bash -lc 'cmd'" (or with double quotes) -> "cmd" */
export function unwrapShell(cmd: string): string {
  const single = /^\S*\b(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(cmd);
  if (single) return single[1].replace(/'\\''/g, "'");
  const double = /^\S*\b(?:ba|z)?sh -l?c "([\s\S]*)"$/.exec(cmd);
  if (double) return double[1].replace(/\\(["\\$`])/g, '$1');
  return cmd;
}

function normaliseItem(phase: string, it: Record<string, unknown>): CodexItem {
  const done = phase === 'item.completed';
  const failed = it.status === 'failed' || it.status === 'declined';
  const item: CodexItem = { id: String(it.id), type: String(it.type), status: failed ? 'failed' : done ? 'completed' : 'in_progress' };
  switch (it.type) {
    case 'agent_message':
    case 'reasoning':
      item.text = String(it.text ?? '');
      break;
    case 'command_execution':
      item.command = unwrapShell(String(it.command ?? ''));
      item.output = truncate(String(it.aggregated_output ?? ''));
      item.exitCode = typeof it.exit_code === 'number' ? it.exit_code : null;
      break;
    case 'error':
      item.text = String(it.message ?? '');
      break;
    default: {
      const { id: _id, type: _type, ...rest } = it;
      const json = JSON.stringify(rest);
      item.detail = json.length > 3000 ? truncate(json, 3000) : rest;
    }
  }
  return item;
}

function parseGoals(v: unknown): FitGoals | null {
  const f = v as Record<string, unknown> | null;
  if (!f || typeof f !== 'object') return null;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!num(f.clearance) || (f.clearance as number) < 0) return null;
  if (f.scaleMode !== 'uniform' && f.scaleMode !== 'radial-height') return null;
  if (f.topOffset !== null && !num(f.topOffset)) return null;
  if (!num(f.floorGap) || (f.floorGap as number) < 0) return null;
  return { clearance: f.clearance as number, scaleMode: f.scaleMode, topOffset: f.topOffset as number | null, floorGap: f.floorGap as number };
}

export function parseResult(text: string): CodexResult {
  const o = parseJson(text);
  const err = validateTransform(o.transform);
  if (err) throw new Error(`Codex returned an invalid transform: ${err}`);
  return {
    transform: o.transform as CodexResult['transform'],
    fit: parseGoals(o.fit),
    summary: typeof o.summary === 'string' ? o.summary : '',
    warnings: Array.isArray(o.warnings) ? o.warnings.map(String) : [],
    confidence: o.confidence === 'high' || o.confidence === 'low' ? o.confidence : 'medium',
  };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) throw new Error('Codex did not return a JSON result');
    return JSON.parse(m[0]);
  }
}

export function parseDesignResult(text: string): DesignResult {
  const o = parseJson(text);
  return {
    title: typeof o.title === 'string' ? o.title.trim().slice(0, 80) : '',
    summary: typeof o.summary === 'string' ? o.summary : '',
    warnings: Array.isArray(o.warnings) ? o.warnings.map(String) : [],
    confidence: o.confidence === 'high' || o.confidence === 'low' ? o.confidence : 'medium',
  };
}

export function parseReview(text: string): ReviewResult {
  const o = parseJson(text);
  if (o.verdict !== 'pass' && o.verdict !== 'concerns' && o.verdict !== 'fail') throw new Error('Codex returned a review without a verdict');
  const findings = Array.isArray(o.findings) ? o.findings : [];
  return {
    verdict: o.verdict,
    summary: typeof o.summary === 'string' ? o.summary : '',
    findings: findings
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({
        severity: f.severity === 'major' || f.severity === 'minor' ? f.severity : 'info',
        title: String(f.title ?? ''),
        detail: String(f.detail ?? ''),
      })),
    feedbackForFitter: typeof o.feedbackForFitter === 'string' ? o.feedbackForFitter : '',
  };
}

export async function codexVersion(bin: string): Promise<{ available: boolean; version: string | null; error: string | null }> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 10000 });
    return { available: true, version: stdout.trim(), error: null };
  } catch (e) {
    return { available: false, version: null, error: (e as Error).message };
  }
}

export class CodexRunner {
  private active = new Map<string, ActiveRun>(); // by model id
  private store: Store;
  private designs: Designs;
  private opts: CodexOptions;

  constructor(store: Store, designs: Designs, opts: CodexOptions) {
    this.store = store;
    this.designs = designs;
    this.opts = opts;
  }

  activeRun(modelId: string): CodexRun | null {
    return this.active.get(modelId)?.run ?? null;
  }

  /** Mark runs left "running" by a previous server process as failed. */
  async recover() {
    for (const model of await this.store.listModels()) {
      for (const run of await this.store.listRuns(model.id)) {
        if (run.status === 'running') {
          if (isDesignRun(run.kind)) await this.restoreScript(run.modelId, this.store.runDir(run.modelId, run.id));
          await this.store.saveRun({ ...run, status: 'error', error: 'The server stopped while this run was in progress.', finishedAt: new Date().toISOString() });
        }
      }
    }
  }

  /**
   * Put back the design script from before a run that didn't finish, so the
   * workspace matches the model's mesh again. Codex's partial version is kept
   * in the run directory.
   */
  private async restoreScript(modelId: string, runDir: string) {
    const before = join(runDir, 'before.mjs');
    if (!existsSync(before)) return;
    const script = this.designs.scriptPath(modelId);
    await copyFile(script, join(runDir, 'after.mjs')).catch(() => undefined);
    await copyFile(before, script).catch(() => undefined);
  }

  /**
   * Replay a run's events to `fn` and keep streaming until it finishes.
   * Returns an unsubscribe function, or null if the run is not active (the
   * caller should replay from the store instead).
   */
  subscribe(modelId: string, runId: string, fn: (e: CodexEvent) => void): (() => void) | null {
    const a = this.active.get(modelId);
    if (!a || a.run.id !== runId) return null;
    for (const e of a.events) fn(e);
    a.listeners.add(fn);
    return () => a.listeners.delete(fn);
  }

  cancel(modelId: string): boolean {
    const a = this.active.get(modelId);
    if (!a) return false;
    a.cancelled = true;
    a.child?.kill('SIGTERM');
    const child = a.child;
    setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref();
    return true;
  }

  async start(modelId: string, input: StartInput): Promise<CodexRun> {
    if (this.active.has(modelId)) throw new Conflict('Codex is already working on this model');
    const model = await this.store.getModel(modelId);
    const ref = model.fit.referenceId ? await this.store.getReference(model.fit.referenceId) : null;
    const verb = input.mode === 'review' ? 'review' : isDesignRun(input.mode) ? 'design' : 'fit';
    if (!ref) throw new BadRequest(`Choose a reference pot before asking Codex to ${verb} the model`);
    if (isDesignRun(input.mode) && !model.design) throw new BadRequest('This model was imported; only designed pots can be redesigned');
    if (input.mode === 'feedback' && !model.codexThreadId) throw new BadRequest('There is no Codex conversation to give feedback on yet; run a fit first');
    if (input.mode === 'design-feedback' && !model.design?.threadId) throw new BadRequest('There is no design conversation to give feedback on yet');
    if ((input.mode === 'feedback' || input.mode === 'design-feedback') && !input.message.trim()) throw new BadRequest('Feedback is empty');

    const run: CodexRun = {
      id: randomUUID(),
      modelId,
      kind: input.mode,
      message: input.message,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      threadId: input.mode === 'feedback' ? model.codexThreadId : input.mode === 'design-feedback' ? (model.design?.threadId ?? null) : null,
      transformBefore: model.transform,
      fitBefore: model.fit,
      referenceId: ref.id,
      result: null,
      review: null,
      design: null,
      designReport: null,
      paramsBefore: isDesignRun(input.mode) ? (model.design?.params ?? null) : null,
      attachments: [],
      metrics: null,
      error: null,
      rating: null,
    };
    const active: ActiveRun = { run, child: null, events: [], listeners: new Set(), cancelled: false };
    this.active.set(modelId, active);
    try {
      await this.store.saveRun(run);
      await this.launch(active, model, ref, input);
    } catch (e) {
      await this.finish(active, { status: 'error', error: (e as Error).message });
    }
    return run;
  }

  private emit(a: ActiveRun, e: CodexEvent) {
    a.events.push(e);
    for (const fn of a.listeners) fn(e);
    void this.store.appendEvent(a.run.modelId, a.run.id, e).catch(() => undefined);
  }

  private async prepareWorkspace(model: PotModel, ref: ReferencePot): Promise<string> {
    const ws = join(this.store.modelDir(model.id), 'codex');
    await mkdir(ws, { recursive: true });
    const mesh = join(ws, 'mesh.stl');
    if (!existsSync(mesh)) {
      await link(this.store.meshFile(model.id), mesh).catch(() => copyFile(this.store.meshFile(model.id), mesh));
    }
    const tool = join(ws, 'pot-tool');
    await writeFile(tool, `#!/bin/sh\nexec "${process.execPath}" "${this.opts.toolPath}" "$@"\n`);
    await chmod(tool, 0o755);
    await writeFile(join(ws, 'AGENTS.md'), agentsMd());
    const state = {
      mesh: 'mesh.stl',
      model: { name: model.name, sourceFile: model.sourceFile, triangles: model.triangleCount },
      reference: { name: ref.name, topOD: ref.topOD, bottomOD: ref.bottomOD, height: ref.height, notes: ref.notes },
      fit: model.fit,
      transform: model.transform,
    };
    await writeFile(join(ws, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    return ws;
  }

  /**
   * A fresh directory per review holding only the result: the model already
   * placed in the pot frame, the reference pot and the goals. Nothing from the
   * fitting conversation or its workspace.
   */
  private async prepareReviewWorkspace(model: PotModel, ref: ReferencePot, runDir: string) {
    const ws = join(runDir, 'workspace');
    await mkdir(ws, { recursive: true });
    const raw = parseSTL(await readFile(this.store.meshFile(model.id)));
    const rawBounds = computeBounds(raw);
    const fitted = applyTransform(raw, model.transform, rawBounds);
    await writeFile(join(ws, 'fitted.stl'), writeBinarySTL(fitted, `potfit fitted: ${model.name}`));
    const tool = join(ws, 'pot-tool');
    await writeFile(tool, `#!/bin/sh\nexec "${process.execPath}" "${this.opts.toolPath}" "$@"\n`);
    await chmod(tool, 0o755);
    await writeFile(join(ws, 'AGENTS.md'), reviewAgentsMd());
    const size = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) => ({
      x: b.max.x - b.min.x,
      y: b.max.y - b.min.y,
      z: b.max.z - b.min.z,
    });
    const design = { scale: model.transform.scale, originalSize: size(orientedBounds(rawBounds, model.transform.up)), fittedSize: size(computeBounds(fitted)) };
    const { referenceId: _ref, ...goals } = model.fit;
    const state = {
      mesh: 'fitted.stl',
      placed: true,
      reference: { name: ref.name, topOD: ref.topOD, bottomOD: ref.bottomOD, height: ref.height, notes: ref.notes },
      fit: goals,
      design,
    };
    await writeFile(join(ws, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    return { ws, design };
  }

  private async launch(a: ActiveRun, model: PotModel, ref: ReferencePot, input: StartInput) {
    const { run } = a;
    const runDir = this.store.runDir(model.id, run.id);
    await mkdir(join(runDir, 'images'), { recursive: true });
    const shots: { name: string; path: string }[] = [];
    const design = isDesignRun(run.kind);
    // Designed pots keep attachments as reference images; other runs just pass them on.
    const extra = design ? [] : (input.attachments ?? []);
    for (const img of [...input.images, ...extra]) {
      const name = `${img.name.replace(/[^\w.-]/g, '_')}.${img.ext}`;
      await writeFile(join(runDir, 'images', name), img.data);
      shots.push({ name, path: join(runDir, 'images', name) });
    }
    const review = run.kind === 'review';
    let ws: string;
    let prompt: string;
    let schema: object = OUTPUT_SCHEMA;
    let imagePaths = shots.map((s) => s.path);
    if (design) {
      let refs = model.design?.images ?? [];
      const added = input.attachments?.length ? await this.designs.saveImages(model.id, refs, input.attachments) : [];
      if (added.length) {
        refs = [...refs, ...added];
        model = await this.store.updateModel(model.id, { design: { images: refs } });
      }
      run.attachments = added;
      ws = await this.designs.prepareWorkspace(model, ref);
      await copyFile(this.designs.scriptPath(model.id), join(runDir, 'before.mjs'));
      // A new session sees every reference image; feedback only the new ones (the rest are in refs/).
      const refImages = run.kind === 'design' ? refs : added;
      imagePaths = [...refImages.map((n) => join(this.designs.refsDir(model.id), n)), ...imagePaths];
      const promptImages = [...refImages, ...shots.map((s) => s.name)].map((name) => ({ name }));
      const failed = existsSync(join(ws, 'failed.mjs'))
        ? `your last version did not build on the server (${model.design?.buildError ?? 'unknown error'}). It is saved as failed.mjs; design.mjs is the last version that built.`
        : null;
      prompt =
        run.kind === 'design'
          ? designPrompt(model, ref, input.message.trim() || model.design?.description || '', promptImages)
          : designFeedbackPrompt(model, ref, input.message, promptImages, failed);
      schema = DESIGN_SCHEMA;
    } else if (review) {
      const prepared = await this.prepareReviewWorkspace(model, ref, runDir);
      ws = prepared.ws;
      prompt = reviewPrompt(ref, model.fit, prepared.design, shots.map((s) => s.name.replace(/\.\w+$/, '')));
      schema = REVIEW_SCHEMA;
    } else {
      ws = await this.prepareWorkspace(model, ref);
      const names = shots.map((s) => s.name.replace(/\.\w+$/, ''));
      prompt = run.kind === 'fit' ? fitPrompt(model, ref, input.message, names) : feedbackPrompt(model, ref, input.message, names);
    }
    const schemaPath = join(runDir, 'output-schema.json');
    await writeFile(schemaPath, JSON.stringify(schema, null, 2));
    const lastPath = join(runDir, 'last-message.json');
    await writeFile(join(runDir, 'prompt.md'), prompt);

    const common = [
      '--json',
      '--skip-git-repo-check',
      '-c', 'sandbox_mode="workspace-write"',
      '--output-schema', schemaPath,
      '-o', lastPath,
      ...(this.opts.model ? ['-m', this.opts.model] : []),
      ...imagePaths.flatMap((p) => ['-i', p]),
    ];
    // Reviews are one-off sessions that are never resumed, so don't keep them.
    const resume = (run.kind === 'feedback' || run.kind === 'design-feedback') && run.threadId;
    const args = resume
        ? ['exec', 'resume', run.threadId!, ...common, '--', prompt]
        : ['exec', ...(review ? ['--ephemeral'] : []), ...common, '--', prompt];

    this.emit(a, { type: 'status', status: 'running' });
    this.emit(a, {
      type: 'log',
      level: 'info',
      text: review ? 'Starting an independent review session' : resume ? `Resuming Codex session ${run.threadId}` : 'Starting a new Codex session',
    });

    const child = spawn(this.opts.bin, args, { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    a.child = child;
    const stderr: string[] = [];
    let turnError: string | null = null;

    createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        this.emit(a, { type: 'log', level: 'info', text: line });
        return;
      }
      switch (ev.type) {
        case 'thread.started':
          run.threadId = String(ev.thread_id);
          this.emit(a, { type: 'thread', threadId: run.threadId });
          // Fitting and design conversations are continued with feedback; reviews aren't.
          if (design) void this.store.updateModel(model.id, { design: { threadId: run.threadId } }).catch(() => undefined);
          else if (!review) void this.store.updateModel(model.id, { codexThreadId: run.threadId }).catch(() => undefined);
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          this.emit(a, { type: 'item', item: normaliseItem(ev.type, ev.item as Record<string, unknown>) });
          break;
        case 'turn.completed':
          this.emit(a, { type: 'usage', usage: (ev.usage ?? {}) as Record<string, number> });
          break;
        case 'turn.failed':
          turnError = String((ev.error as { message?: string } | undefined)?.message ?? 'Codex turn failed');
          this.emit(a, { type: 'log', level: 'error', text: turnError });
          break;
        case 'error':
          this.emit(a, { type: 'log', level: 'error', text: String(ev.message ?? 'Codex error') });
          break;
      }
    });
    createInterface({ input: child.stderr! }).on('line', (line) => {
      stderr.push(line);
      if (stderr.length > 200) stderr.shift();
    });

    child.on('error', (e) => {
      void this.finish(a, { status: 'error', error: `Could not start Codex (${this.opts.bin}): ${e.message}` });
    });
    child.on('close', (code, signal) => {
      void writeFile(join(runDir, 'stderr.log'), stderr.join('\n')).catch(() => undefined);
      // The fitted mesh can be rebuilt from the reviewed transform; don't keep a copy per review.
      if (review) void rm(join(ws, 'fitted.stl'), { force: true }).catch(() => undefined);
      void this.complete(a, code, signal, lastPath, turnError, stderr, runDir);
    });
  }

  private async complete(a: ActiveRun, code: number | null, signal: NodeJS.Signals | null, lastPath: string, turnError: string | null, stderr: string[], runDir: string) {
    if (isDesignRun(a.run.kind) && (a.cancelled || code !== 0)) await this.restoreScript(a.run.modelId, runDir);
    if (a.cancelled) return this.finish(a, { status: 'cancelled', error: null });
    if (code !== 0) {
      const tail = stderr.filter((l) => l.trim() && !/^Reading additional input/.test(l)).slice(-8).join('\n');
      return this.finish(a, { status: 'error', error: turnError ?? `Codex exited with ${signal ?? `code ${code}`}${tail ? `:\n${tail}` : ''}` });
    }
    try {
      if (isDesignRun(a.run.kind)) return await this.completeDesign(a, await readFile(lastPath, 'utf8'), runDir);
      if (a.run.kind === 'review') {
        const review = parseReview(await readFile(lastPath, 'utf8'));
        const model = await this.store.getModel(a.run.modelId);
        const ref = a.run.referenceId ? await this.store.getReference(a.run.referenceId) : null;
        const positions = parseSTL(await readFile(this.store.meshFile(model.id)));
        // Measure what was reviewed, not whatever the user has done since.
        const metrics = ref ? checkFit(positions, a.run.transformBefore, ref, a.run.fitBefore) : null;
        return this.finish(a, { status: 'done', error: null, review, metrics });
      }
      const result = parseResult(await readFile(lastPath, 'utf8'));
      const model = await this.store.getModel(a.run.modelId);
      const ref = model.fit.referenceId ? await this.store.getReference(model.fit.referenceId) : null;
      const positions = parseSTL(await readFile(this.store.meshFile(model.id)));
      const fit = { ...model.fit, ...result.fit };
      const metrics = ref ? checkFit(positions, result.transform, ref, fit) : null;
      await this.store.updateModel(model.id, { transform: result.transform, fit, codexThreadId: a.run.threadId });
      return this.finish(a, { status: 'done', error: null, result, metrics });
    } catch (e) {
      return this.finish(a, { status: 'error', error: (e as Error).message });
    }
  }

  /** Build the script Codex left; if it fails, put back the one that built. */
  private async completeDesign(a: ActiveRun, text: string, runDir: string) {
    const result = parseDesignResult(text);
    const id = a.run.modelId;
    const script = this.designs.scriptPath(id);
    const failed = join(this.designs.dir(id), 'failed.mjs');
    await copyFile(script, join(runDir, 'after.mjs')).catch(() => undefined);
    let model: PotModel;
    try {
      // Codex was asked to make the user's values its defaults.
      model = await this.designs.rebuild(id, { resetParams: true });
    } catch (e) {
      const msg = (e as Error).message;
      await copyFile(script, failed).catch(() => undefined);
      await copyFile(join(runDir, 'before.mjs'), script).catch(() => undefined);
      await this.designs.recordError(id, msg);
      return this.finish(a, { status: 'error', error: `Codex's design did not build: ${msg}`, design: result });
    }
    await rm(failed, { force: true });
    if (result.title && model.name === DEFAULT_DESIGN_NAME) model = await this.store.updateModel(id, { name: result.title });
    const report = model.design?.report ?? null;
    return this.finish(a, { status: 'done', error: null, design: result, designReport: report, metrics: report?.metrics ?? null });
  }

  private async finish(a: ActiveRun, patch: Partial<CodexRun> & Pick<CodexRun, 'status' | 'error'>) {
    if (this.active.get(a.run.modelId) !== a) return;
    Object.assign(a.run, patch, { finishedAt: new Date().toISOString() });
    await this.store.saveRun(a.run).catch(() => undefined);
    this.emit(a, { type: 'status', status: a.run.status, error: a.run.error });
    this.emit(a, { type: 'result', run: a.run });
    this.active.delete(a.run.modelId);
    a.listeners.clear();
  }
}
