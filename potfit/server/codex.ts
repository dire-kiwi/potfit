// Runs `codex exec` to fit a model, streams its events, and applies the result.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, link, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkFit } from '../shared/fit.ts';
import { parseSTL } from '../shared/stl.ts';
import { validateTransform } from '../shared/transform.ts';
import type { CodexEvent, CodexItem, CodexResult, CodexRun, FitGoals, PotModel, ReferencePot } from '../shared/types.ts';
import { agentsMd, feedbackPrompt, fitPrompt, OUTPUT_SCHEMA } from './prompt.ts';
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
  mode: 'fit' | 'feedback';
  message: string;
  images: { name: string; data: Buffer }[];
}

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
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) throw new Error('Codex did not return a JSON result');
    obj = JSON.parse(m[0]);
  }
  const o = obj as Record<string, unknown>;
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
  private opts: CodexOptions;

  constructor(store: Store, opts: CodexOptions) {
    this.store = store;
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
          await this.store.saveRun({ ...run, status: 'error', error: 'The server stopped while this run was in progress.', finishedAt: new Date().toISOString() });
        }
      }
    }
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
    if (!ref) throw new BadRequest('Choose a reference pot before asking Codex to fit the model');
    if (input.mode === 'feedback' && !model.codexThreadId) throw new BadRequest('There is no Codex conversation to give feedback on yet; run a fit first');
    if (input.mode === 'feedback' && !input.message.trim()) throw new BadRequest('Feedback is empty');

    const run: CodexRun = {
      id: randomUUID(),
      modelId,
      kind: input.mode,
      message: input.message,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      threadId: input.mode === 'feedback' ? model.codexThreadId : null,
      transformBefore: model.transform,
      fitBefore: model.fit,
      referenceId: ref.id,
      result: null,
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

  private async launch(a: ActiveRun, model: PotModel, ref: ReferencePot, input: StartInput) {
    const { run } = a;
    const runDir = this.store.runDir(model.id, run.id);
    await mkdir(join(runDir, 'images'), { recursive: true });
    const imagePaths: string[] = [];
    for (const img of input.images) {
      const p = join(runDir, 'images', `${img.name.replace(/[^\w.-]/g, '_')}.png`);
      await writeFile(p, img.data);
      imagePaths.push(p);
    }
    const ws = await this.prepareWorkspace(model, ref);
    const schemaPath = join(runDir, 'output-schema.json');
    await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2));
    const lastPath = join(runDir, 'last-message.json');

    const imageNames = input.images.map((i) => i.name);
    const prompt = input.mode === 'fit' ? fitPrompt(model, ref, input.message, imageNames) : feedbackPrompt(model, ref, input.message, imageNames);
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
    const args = input.mode === 'feedback' && run.threadId ? ['exec', 'resume', run.threadId, ...common, '--', prompt] : ['exec', ...common, '--', prompt];

    this.emit(a, { type: 'status', status: 'running' });
    this.emit(a, { type: 'log', level: 'info', text: input.mode === 'fit' ? 'Starting a new Codex session' : `Resuming Codex session ${run.threadId}` });

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
          void this.store.updateModel(model.id, { codexThreadId: run.threadId }).catch(() => undefined);
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
      void this.complete(a, code, signal, lastPath, turnError, stderr);
    });
  }

  private async complete(a: ActiveRun, code: number | null, signal: NodeJS.Signals | null, lastPath: string, turnError: string | null, stderr: string[]) {
    if (a.cancelled) return this.finish(a, { status: 'cancelled', error: null });
    if (code !== 0) {
      const tail = stderr.filter((l) => l.trim() && !/^Reading additional input/.test(l)).slice(-8).join('\n');
      return this.finish(a, { status: 'error', error: turnError ?? `Codex exited with ${signal ?? `code ${code}`}${tail ? `:\n${tail}` : ''}` });
    }
    try {
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
