// potfit's agent: one agent-threads instance on Claude Code, with a thread per model (fitting an
// imported pot, or designing a designed one) and one per review. It gives each thread its role's
// tools and system prompt, adds potfit's context to what the user sends, and tells /live about
// threads' status.

import { AgentThreads, CommandError, SqliteStore, claudeCode, type Attachment, type ClaudeCodeOptions, type Command, type Thread, type ThreadEvent, type Tool, type TurnResult } from '@dire-kiwi/agent-threads-node';
import type { AgentRole, AgentSettings, PotModel, ReferencePot, ThreadState } from '../../shared/types.ts';
import type { BlenderOption } from '../blender.ts';
import type { Designs } from '../design.ts';
import type { Store } from '../store.ts';
import { Conflict, type Checkpoints } from './checkpoints.ts';
import type { Live } from './live.ts';
import { potfitPolicy } from './policy.ts';
import { designSystemPrompt, fitSystemPrompt, overhangPreference, reviewSystemPrompt } from './prompts.ts';
import { BadRequest, parseAgentSettings } from './settings.ts';
import { toolsFor, type ToolDeps } from './tools.ts';
import { describeFit, describeReference, fitWorkspace, prepareFitWorkspace } from './workspace.ts';
import { dirname, join } from 'node:path';
import { transformsEqual } from '../../shared/transform.ts';

export interface AgentOptions {
  store: Store;
  designs: Designs;
  checkpoints: Checkpoints;
  live: Live;
  /** agent-threads' SQLite file. */
  threadsDb: string;
  toolPath: string;
  blender: BlenderOption;
  claude: ClaudeCodeOptions;
  /** Used when a client doesn't choose (POTFIT_CLAUDE_MODEL, POTFIT_CLAUDE_EFFORT). */
  defaultModel: string | null;
  defaultEffort: string | null;
  submitReview: ToolDeps['submitReview'];
  /** Called when a review thread's turn ends. */
  onReviewTurnEnd?: (modelId: string, reviewId: string) => void;
  /** Whether something else (the screenshot review loop) is driving the model's thread. */
  lockedBy?: (modelId: string) => string | null;
}

interface Meta {
  modelId: string;
  role: AgentRole;
  reviewId?: string;
}

const metaOf = (t: Thread): Meta | null => {
  const m = t.metadata as Partial<Meta> | undefined;
  return m && typeof m.modelId === 'string' && (m.role === 'fit' || m.role === 'design' || m.role === 'review') ? (m as Meta) : null;
};

const CONTEXT = /\n*<potfit-context>[\s\S]*?<\/potfit-context>\s*$/;
/** The user's own text of a message, without the context potfit added. */
export const withoutContext = (text: string) => text.replace(CONTEXT, '');

/** Names the client gives its screenshots of the views. */
const VIEW_LABELS: Record<string, string> = {
  'view-3d': "the app's 3D view, as the user sees it",
  'view-section': "the app's side-on section view (outer pot cut in half, nursery pot in green, required clearance dashed)",
};
const stem = (name = '') => name.replace(/\.\w+$/, '');

export class Agent {
  readonly sdk: AgentThreads;
  private opts: AgentOptions;
  private tools!: Record<AgentRole, Tool[]>;
  private prompts!: Record<AgentRole, string>;
  private states = new Map<string, ThreadState & { modelId: string }>();
  private lastResult = new Map<string, TurnResult>();
  private waiters = new Map<string, ((r: TurnResult | null) => void)[]>();
  private creating = new Map<string, Promise<Thread>>();

  constructor(opts: AgentOptions) {
    this.opts = opts;
    const { designs } = opts;
    this.sdk = new AgentThreads({
      store: new SqliteStore(opts.threadsDb),
      harnesses: { claude: claudeCode(opts.claude) },
      permissions: potfitPolicy({
        readable: [join(dirname(opts.toolPath), 'blender'), join(dirname(opts.toolPath), 'potlib.ts'), designs.manifoldTypes()],
      }),
      onError: (e) => console.error('potfit agent:', e),
    });
  }

  /** Give every stored thread its tools again, and follow their events. Call once, at startup. */
  async init() {
    const { store, designs, checkpoints, live, toolPath, blender } = this.opts;
    this.tools = await toolsFor({ store, designs, checkpoints, live, toolPath, blender, submitReview: this.opts.submitReview });
    const b = await blender.status;
    const version = b.available ? b.version : null;
    this.prompts = { fit: fitSystemPrompt(version), design: designSystemPrompt(designs.manifoldTypes(), version), review: reviewSystemPrompt() };
    this.sdk.subscribe((e) => this.onEvent(e));
    for (const t of await this.sdk.list()) {
      const m = metaOf(t);
      if (!m) continue;
      await this.sdk.configure(t.id, this.capabilities(m.role));
      this.track(t, m);
    }
  }

  close() {
    return this.sdk.close();
  }

  private capabilities(role: AgentRole) {
    return { tools: this.tools[role], systemPrompt: this.prompts[role] };
  }

  private track(t: Thread, m: Meta) {
    const state: ThreadState & { modelId: string } = { id: t.id, role: m.role, status: t.status, model: t.model, effort: t.effort, modelId: m.modelId };
    this.states.set(t.id, state);
    return state;
  }

  private onEvent(e: ThreadEvent) {
    if (e.type === 'thread.updated') {
      const m = metaOf(e.thread);
      if (!m) return;
      const { modelId, ...state } = this.track(e.thread, m);
      this.opts.live.emit(modelId, { type: 'thread', thread: state });
    } else if (e.type === 'item.added' && e.item.type === 'turn_result' && !e.item.parent_id) {
      this.lastResult.set(e.thread_id, e.item);
    } else if (e.type === 'turn.completed') {
      const state = this.states.get(e.thread_id);
      const result = this.lastResult.get(e.thread_id) ?? null;
      const waiting = this.waiters.get(e.thread_id) ?? [];
      this.waiters.delete(e.thread_id);
      for (const fn of waiting) fn(result);
      if (!state) return;
      if (state.role === 'design') {
        // Edits the agent never applied would leave design.mjs out of step with the mesh.
        void this.opts.designs.restoreApplied(state.modelId).catch((err) => console.error('potfit: could not restore the applied design:', err));
      }
      if (state.role === 'review') {
        void this.sdk.get(e.thread_id).then((t) => {
          const m = t && metaOf(t);
          if (m?.reviewId) this.opts.onReviewTurnEnd?.(m.modelId, m.reviewId);
        });
      }
    }
  }

  /** The thread's status, as /live tells it. */
  threadState(threadId: string): ThreadState | null {
    const s = this.states.get(threadId);
    if (!s) return null;
    const { modelId: _m, ...state } = s;
    return state;
  }

  /** Whether the model's fitting or design thread is working (so the model mustn't be edited). */
  isBusy(model: PotModel): boolean {
    const s = model.threadId ? this.states.get(model.threadId) : undefined;
    return !!s && (s.status === 'running' || s.status === 'waiting');
  }

  /** The model's threads that are working: its own and its reviews'. */
  threadsOf(modelId: string): ThreadState[] {
    return [...this.states.values()].filter((s) => s.modelId === modelId).map(({ modelId: _m, ...s }) => s);
  }

  private settings(s: AgentSettings) {
    const { model, effort } = parseAgentSettings(s as Record<string, unknown>);
    return {
      ...((model ?? this.opts.defaultModel) ? { model: (model ?? this.opts.defaultModel)! } : {}),
      ...((effort ?? this.opts.defaultEffort) ? { effort: (effort ?? this.opts.defaultEffort)! } : {}),
    };
  }

  /** The model's fitting or design thread, made if it hasn't one. */
  async mainThread(modelId: string, settings: AgentSettings = {}): Promise<Thread> {
    const pending = this.creating.get(modelId);
    if (pending) return pending;
    const p = (async () => {
      const model = await this.opts.store.getModel(modelId);
      if (model.threadId) {
        const t = await this.sdk.get(model.threadId);
        if (t) return t;
      }
      const ref = model.fit.referenceId ? await this.opts.store.getReference(model.fit.referenceId) : null;
      const role: AgentRole = model.design ? 'design' : 'fit';
      let cwd: string;
      if (role === 'design') {
        if (!ref) throw new BadRequest('Choose a nursery pot before designing the pot');
        cwd = await this.opts.designs.prepareWorkspace(model, ref);
      } else {
        cwd = await prepareFitWorkspace(this.opts.store, model, ref);
      }
      const t = await this.sdk.create({
        harness: 'claude',
        ...this.settings(settings),
        cwd,
        title: model.name,
        metadata: { modelId, role },
        permission_mode: 'default',
        ...this.capabilities(role),
      });
      await this.opts.store.updateModel(modelId, { threadId: t.id });
      this.track(t, { modelId, role });
      return t;
    })();
    this.creating.set(modelId, p);
    try {
      return await p;
    } finally {
      this.creating.delete(modelId);
    }
  }

  /** A reviewer's thread: its own conversation, in the review's directory, asking nothing. */
  async reviewThread(modelId: string, reviewId: string, cwd: string, title: string, settings: AgentSettings): Promise<Thread> {
    const t = await this.sdk.create({
      harness: 'claude',
      ...this.settings(settings),
      cwd,
      title,
      metadata: { modelId, role: 'review', reviewId },
      permission_mode: 'dont_ask',
      ...this.capabilities('review'),
    });
    this.track(t, { modelId, role: 'review', reviewId });
    return t;
  }

  /** What the user (or the screenshot loop) sends a fitting or design thread, with potfit's context. */
  private async prepareSend(thread: Thread, text: string, attachments: Attachment[] = []): Promise<string> {
    const m = metaOf(thread);
    if (!m || m.role === 'review') return text;
    const { store, designs } = this.opts;
    let model = await store.getModel(m.modelId);
    const ref = model.fit.referenceId ? await store.getReference(model.fit.referenceId) : null;
    const saved: string[] = [];
    if (m.role === 'design') {
      // Pictures the user attaches to a design become its reference images.
      const pictures = attachments.filter((a) => a.kind === 'image' && a.data && !VIEW_LABELS[stem(a.name)]);
      const images = pictures.map((a, i) => {
        const ext = a.media_type === 'image/png' ? 'png' : a.media_type === 'image/webp' ? 'webp' : 'jpg';
        return { name: a.name ?? `image-${i + 1}`, ext: ext as 'png' | 'jpg' | 'webp', data: Buffer.from(a.data!, 'base64') };
      });
      if (images.length) {
        const existing = model.design?.images ?? [];
        saved.push(...(await designs.saveImages(model.id, existing, images)));
        model = await store.updateModel(model.id, { design: { images: [...existing, ...saved] } });
      }
      if (ref) await designs.prepareWorkspace(model, ref);
    } else {
      await prepareFitWorkspace(store, model, ref);
    }
    return `${text}\n\n${await this.context(model, ref, thread.id, attachments, saved)}`;
  }

  private async context(model: PotModel, ref: ReferencePot | null, threadId: string, attachments: Attachment[], saved: string[]): Promise<string> {
    const lines = [
      model.design ? `Model: ${model.name} (designed in potfit, ${model.triangleCount} triangles)` : `Model: ${model.name} (imported from ${model.sourceFile}, ${model.triangleCount} triangles)`,
      `Nursery pot: ${ref ? describeReference(ref) : 'none chosen yet'}`,
      `Fit goals: ${describeFit(model.fit)}`,
    ];
    if (!model.design) {
      const last = (await this.opts.store.listCheckpoints(model.id)).filter((c) => c.threadId === threadId && !c.revertedAt).at(-1);
      const moved = last && !transformsEqual(last.transform, model.transform);
      lines.push(`Placement now: ${JSON.stringify(model.transform)}${moved ? ' (the user moved or scaled it by hand since your last change)' : ''}`);
    } else {
      lines.push(`Design parameters now: ${JSON.stringify(model.design.params)}`);
      if (model.design.buildError) lines.push(`The last build failed: ${model.design.buildError}`);
    }
    lines.push(overhangPreference(model.avoidOverhangs !== false));
    const images = attachments.filter((a) => a.kind === 'image');
    if (images.length) {
      let n = 0;
      lines.push(
        `Attached images, in order: ${images
          .map((a) => VIEW_LABELS[stem(a.name)] ?? (model.design && saved[n] ? `the user's picture, saved as refs/${saved[n++]}` : `the user's picture${a.name ? ` (${a.name})` : ''}`))
          .join('; ')}`,
      );
    }
    return `<potfit-context>\n${lines.join('\n')}\n</potfit-context>`;
  }

  /** A command from the browser, for one of potfit's threads. */
  async handle(command: Command): Promise<void> {
    const thread = await this.sdk.get(command.thread_id);
    const m = thread && metaOf(thread);
    if (!thread || !m) throw new CommandError(`unknown thread ${command.thread_id}`);
    if (command.type === 'set_options') {
      if (command.permission_mode !== undefined) throw new BadRequest("potfit sets threads' permission modes itself");
      parseAgentSettings(command as unknown as Record<string, unknown>);
    }
    if (command.type === 'send') {
      if (m.role !== 'review') {
        const locked = this.opts.lockedBy?.(m.modelId);
        if (locked) throw new Conflict(locked);
      }
      const text = await this.prepareSend(thread, command.text, command.attachments ?? []);
      return this.sdk.send(thread.id, text, { attachments: command.attachments, client_id: command.client_id });
    }
    return this.sdk.handle(command);
  }

  /** Send a message and wait for the turn it's in to end. */
  async runTurn(threadId: string, text: string, attachments: Attachment[] = [], signal?: AbortSignal): Promise<TurnResult | null> {
    const thread = await this.sdk.get(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const done = new Promise<TurnResult | null>((resolve) => {
      const list = this.waiters.get(threadId) ?? [];
      list.push(resolve);
      this.waiters.set(threadId, list);
    });
    const abort = () => void this.sdk.interrupt(threadId).catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.sdk.send(threadId, await this.prepareSend(thread, text, attachments), { attachments });
      return await done;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Stop the model's threads and forget them, when the model is deleted. */
  async forgetModel(modelId: string) {
    for (const t of await this.sdk.list()) {
      if (metaOf(t)?.modelId !== modelId) continue;
      await this.sdk.interrupt(t.id).catch(() => undefined);
      await this.sdk.delete(t.id).catch(() => undefined);
      this.states.delete(t.id);
    }
  }

  /** Forget the model's thread (Start over): the next message starts a new one. */
  async startOver(modelId: string) {
    const model = await this.opts.store.getModel(modelId);
    if (this.isBusy(model)) throw new Conflict('The agent is working on this model; stop it first');
    if (model.threadId) await this.sdk.newSession(model.threadId);
  }

  fitWorkspace(modelId: string) {
    return fitWorkspace(this.opts.store, modelId);
  }
}
