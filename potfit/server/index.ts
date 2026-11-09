import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, type Attachment, type ThreadEvent } from '@dire-kiwi/agent-threads-node';
import { analyzeMesh, initialTransform } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { applyTransform, computeBounds, validateTransform, yUpToZUp } from '../shared/transform.ts';
import { AGENT_EFFORTS, DEFAULT_FIT, type FitSettings, type LiveEvent, type ModelPatch, type ParamValues, type ReferenceInput, type ServerStatus } from '../shared/types.ts';
import { Agent } from './agent/agent.ts';
import { Checkpoints, Conflict } from './agent/checkpoints.ts';
import { Live } from './agent/live.ts';
import { Reviews } from './agent/reviews.ts';
import { BadRequest, CLAUDE_MODELS, claudeVersion, parseAgentSettings } from './agent/settings.ts';
import { blenderVersion } from './blender.ts';
import { BuildError, DEFAULT_DESIGN_NAME, Designs, type DesignImage } from './design.ts';
import { migrateFromCodex } from './migrate.ts';
import { ScreenshotReviews } from './screenshot-review.ts';
import { NotFound, Store } from './store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.POTFIT_PORT ?? 5174);
// The API is unauthenticated and drives Claude Code under the user's login, so it
// only listens on loopback unless POTFIT_HOST says otherwise.
const host = process.env.POTFIT_HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const loopbackOnly = LOOPBACK_HOSTS.has(host);
const dataDir = resolve(process.env.POTFIT_DATA ?? join(root, 'data'));
const claudeBin = process.env.POTFIT_CLAUDE_BIN || 'claude';
const defaultModel = process.env.POTFIT_CLAUDE_MODEL || null;
const defaultEffort = process.env.POTFIT_CLAUDE_EFFORT || null;
try {
  parseAgentSettings({ model: defaultModel, effort: defaultEffort });
} catch (e) {
  console.error(`potfit: POTFIT_CLAUDE_MODEL / POTFIT_CLAUDE_EFFORT: ${(e as Error).message} (efforts: ${AGENT_EFFORTS.join(', ')})`);
  process.exit(1);
}

// The agent can run Blender, when there is one, to edit meshes and make parts for designs.
const blenderBin = process.env.POTFIT_BLENDER_BIN || 'blender';
const blender = { bin: blenderBin, status: blenderVersion(blenderBin) };

const store = new Store(dataDir);
await store.init();
const migrated = await migrateFromCodex(dataDir);
if (migrated) console.log(`potfit: removed Codex's runs and workspaces (${migrated.runs} runs in ${migrated.models} models); see README.md`);
const toolPath = join(root, 'tools', 'pot-tool.ts');
const designs = new Designs(store, { root, toolPath });
const live = new Live();
const checkpoints = new Checkpoints(store, designs);
const reviews = new Reviews(store, live);
let screenshotReviews: ScreenshotReviews;
const agent = new Agent({
  store,
  designs,
  checkpoints,
  live,
  threadsDb: join(dataDir, 'threads.db'),
  toolPath,
  blender,
  claude: { bin: claudeBin },
  defaultModel,
  defaultEffort,
  submitReview: (modelId, reviewId, result) => reviews.submit(modelId, reviewId, result),
  onReviewTurnEnd: (modelId, reviewId) => void reviews.turnEnded(modelId, reviewId).catch((e) => console.error(e)),
  lockedBy: (modelId) => (screenshotReviews?.isRunning(modelId) ? 'The screenshot review is driving this model; cancel it first' : null),
});
reviews.agent = agent;
await agent.init();
await reviews.recover();
screenshotReviews = new ScreenshotReviews(store, agent, reviews, live);
await screenshotReviews.recover();

const app = express();
// Refuse requests addressed to any other host name while bound to loopback, so
// a web page can't reach the API through DNS rebinding.
if (loopbackOnly) {
  app.use((req, res, next) => {
    const name = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
    if (LOOPBACK_HOSTS.has(name)) return next();
    res.status(403).json({ error: 'potfit only accepts requests addressed to localhost' });
  });
}
app.use(express.json({ limit: '64mb' }));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};
const param = (req: Request, name: string) => String(req.params[name]);

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function referenceInput(body: unknown): ReferenceInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new BadRequest('Reference pot needs a name');
  for (const k of ['topOD', 'bottomOD', 'height'] as const) {
    if (!positive(b[k])) throw new BadRequest(`${k} must be a positive number of millimetres`);
  }
  return { name, topOD: b.topOD as number, bottomOD: b.bottomOD as number, height: b.height as number, notes: typeof b.notes === 'string' ? b.notes : '' };
}

function fitPatch(v: unknown): Partial<FitSettings> {
  const f = (v ?? {}) as Record<string, unknown>;
  const out: Partial<FitSettings> = {};
  if ('referenceId' in f) {
    if (f.referenceId !== null && typeof f.referenceId !== 'string') throw new BadRequest('fit.referenceId must be a string or null');
    out.referenceId = f.referenceId as string | null;
  }
  if ('clearance' in f) {
    if (typeof f.clearance !== 'number' || !(f.clearance >= 0)) throw new BadRequest('fit.clearance must be a number >= 0');
    out.clearance = f.clearance;
  }
  if ('scaleMode' in f) {
    if (f.scaleMode !== 'uniform' && f.scaleMode !== 'radial-height') throw new BadRequest('fit.scaleMode must be uniform or radial-height');
    out.scaleMode = f.scaleMode;
  }
  if ('topOffset' in f) {
    if (f.topOffset !== null && (typeof f.topOffset !== 'number' || !Number.isFinite(f.topOffset))) throw new BadRequest('fit.topOffset must be a number or null');
    out.topOffset = f.topOffset as number | null;
  }
  if ('floorGap' in f) {
    if (typeof f.floorGap !== 'number' || !(f.floorGap >= 0)) throw new BadRequest('fit.floorGap must be a number >= 0');
    out.floorGap = f.floorGap;
  }
  return out;
}

/** Screenshots and reference images arrive as PNG, JPEG or WebP data URLs. */
function decodeImages(v: unknown, max: number): DesignImage[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new BadRequest('images must be an array');
  if (v.length > max) throw new BadRequest(`At most ${max} images at a time`);
  return v.map((img: { name?: unknown; dataUrl?: unknown }, i) => {
    const m = typeof img?.dataUrl === 'string' ? /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(img.dataUrl) : null;
    if (!m) throw new BadRequest('images must be PNG, JPEG or WebP data URLs');
    return {
      name: typeof img.name === 'string' && img.name.trim() ? img.name.trim() : `image-${i + 1}`,
      ext: m[1] === 'jpeg' ? 'jpg' : (m[1] as 'png' | 'webp'),
      data: Buffer.from(m[2], 'base64'),
    };
  });
}

/** The reference pot used most recently, else the newest one. */
async function defaultReferenceId(): Promise<string | null> {
  const refs = await store.listReferences();
  const recent = (await store.listModels())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((m) => m.fit.referenceId)
    .find((id) => id && refs.some((r) => r.id === id));
  return recent ?? refs.at(-1)?.id ?? null;
}


// ---------------------------------------------------------------- status

app.get('/api/status', route(async (_req, res) => {
  const status: ServerStatus = {
    claude: { ...(await claudeVersion(claudeBin)), defaultModel, defaultEffort, models: CLAUDE_MODELS },
    blender: await blender.status,
    dataDir,
  };
  res.json(status);
}));

// ------------------------------------------------------------ references

app.get('/api/references', route(async (_req, res) => {
  res.json(await store.listReferences());
}));

app.post('/api/references', route(async (req, res) => {
  res.status(201).json(await store.createReference(referenceInput(req.body)));
}));

app.put('/api/references/:id', route(async (req, res) => {
  res.json(await store.updateReference(param(req, 'id'), referenceInput(req.body)));
}));

app.delete('/api/references/:id', route(async (req, res) => {
  await store.deleteReference(param(req, 'id'));
  res.status(204).end();
}));

// ---------------------------------------------------------------- models

app.get('/api/models', route(async (_req, res) => {
  res.json(await store.listModels());
}));

// Body: binary STL of the model in its raw coordinates. Query: name, sourceFile.
app.post('/api/models', express.raw({ type: () => true, limit: '1gb' }), route(async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequest('Send the mesh as a binary STL request body');
  let positions: Float32Array;
  try {
    positions = parseSTL(body);
  } catch (e) {
    throw new BadRequest(`Could not read the mesh: ${(e as Error).message}`);
  }
  if (positions.length === 0) throw new BadRequest('The mesh has no triangles');
  const analysis = analyzeMesh(positions);
  const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim() : 'Untitled pot';
  const model = await store.createModel(
    {
      name,
      sourceFile: typeof req.query.sourceFile === 'string' ? req.query.sourceFile : name,
      triangleCount: positions.length / 9,
      transform: initialTransform(positions, analysis),
      fit: { ...DEFAULT_FIT, referenceId: await defaultReferenceId() },
      threadId: null,
    },
    writeBinarySTL(positions, `potfit: ${name}`),
  );
  res.status(201).json(model);
}));

/** The images a send command attaches, as the agent takes them. */
const asAttachments = (images: DesignImage[]): Attachment[] =>
  images.map((img) => ({ kind: 'image', name: img.name, media_type: img.ext === 'jpg' ? 'image/jpeg' : `image/${img.ext}`, data: img.data.toString('base64') }));

// A pot designed from a description and/or reference images. It starts as a
// plain pot built around the reference pot, and the agent redesigns it unless
// `agent` is false.
app.post('/api/designs', route(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  const images = decodeImages(b.images, 8);
  const useAgent = b.agent !== false;
  const settings = parseAgentSettings(b);
  if (useAgent && !description && images.length === 0) throw new BadRequest('Describe the pot or add a reference image');
  const fit: FitSettings = { ...DEFAULT_FIT, referenceId: await defaultReferenceId(), ...fitPatch(b.fit) };
  const ref = fit.referenceId ? await store.getReference(fit.referenceId) : null;
  if (!ref) throw new BadRequest('Choose a reference pot for the design');
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : DEFAULT_DESIGN_NAME;
  if (b.avoidOverhangs !== undefined && typeof b.avoidOverhangs !== 'boolean') throw new BadRequest('avoidOverhangs must be a boolean');
  // The agent's first message carries the pictures, which saves them as the design's references.
  let model = await designs.create({ name, description, images: useAgent ? [] : images, fit, ref, avoidOverhangs: b.avoidOverhangs !== false });
  if (useAgent) {
    const thread = await agent.mainThread(model.id, settings);
    await agent.handle({ type: 'send', thread_id: thread.id, text: description || 'Design a pot like the attached pictures.', attachments: asAttachments(images) });
    model = await store.getModel(model.id);
  }
  res.status(201).json({ model });
}));

app.get('/api/models/:id', route(async (req, res) => {
  const model = await store.getModel(param(req, 'id'));
  res.json({ model, threads: agent.threadsOf(model.id) });
}));

/** Why the model can't be edited now, or nothing. */
async function editLock(id: string): Promise<string | null> {
  if (screenshotReviews.isRunning(id)) return 'Screenshot review is working on this model; cancel it before editing';
  if (agent.isBusy(await store.getModel(id))) return 'The agent is working on this model; wait for it to finish or stop it';
  return null;
}
const notWhileRunning = async (id: string) => {
  const why = await editLock(id);
  if (why) throw new Conflict(why);
};

app.patch('/api/models/:id', route(async (req, res) => {
  const id = param(req, 'id');
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: ModelPatch = {};
  if ('name' in b) {
    if (typeof b.name !== 'string' || !b.name.trim()) throw new BadRequest('name must be a non-empty string');
    patch.name = b.name.trim();
  }
  if ('transform' in b) {
    const err = validateTransform(b.transform);
    if (err) throw new BadRequest(err);
    await notWhileRunning(id);
    patch.transform = b.transform as ModelPatch['transform'];
  }
  if ('avoidOverhangs' in b) {
    if (typeof b.avoidOverhangs !== 'boolean') throw new BadRequest('avoidOverhangs must be a boolean');
    await notWhileRunning(id);
    patch.avoidOverhangs = b.avoidOverhangs;
  }
  if ('fit' in b) {
    await notWhileRunning(id);
    patch.fit = fitPatch(b.fit) as FitSettings;
  }
  res.json(await store.updateModel(id, patch));
}));

app.delete('/api/models/:id', route(async (req, res) => {
  const id = param(req, 'id');
  await store.getModel(id);
  screenshotReviews.cancel(id);
  await agent.forgetModel(id);
  await store.deleteModel(id);
  res.status(204).end();
}));

app.get('/api/models/:id/mesh.stl', route(async (req, res) => {
  const id = param(req, 'id');
  if (!existsSync(store.meshFile(id))) throw new NotFound('mesh not found');
  // Pass a root: send refuses absolute paths with dot-directories (e.g. ~/.local) in them.
  res.type('model/stl').sendFile('mesh.stl', { root: store.modelDir(id) });
}));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pot';

// The placed, scaled model as a Z-up STL standing on z = 0, ready for a slicer.
app.get('/api/models/:id/export.stl', route(async (req, res) => {
  const model = await store.getModel(param(req, 'id'));
  const ref = model.fit.referenceId ? await store.getReference(model.fit.referenceId) : null;
  const raw = parseSTL(await readFile(store.meshFile(model.id)));
  const out = yUpToZUp(applyTransform(raw, model.transform));
  const minZ = computeBounds(out).min.z;
  for (let i = 2; i < out.length; i += 3) out[i] -= minZ;
  const name = `${slug(model.name)}${ref ? `-for-${slug(ref.name)}` : ''}.stl`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.type('model/stl').send(Buffer.from(writeBinarySTL(out, `potfit export: ${model.name}`)));
}));

// Images the agent rendered (render_views), and a design's reference images.
app.get(/^\/api\/models\/([0-9a-f-]{36})\/files\/((?:agent|design|reviews\/[0-9a-f-]{36})\/renders\/[\w.-]+\.png|design\/refs\/[\w-]+\.(?:png|jpg|webp))$/, route(async (req, res) => {
  const id = String(req.params[0]);
  const rel = String(req.params[1]);
  if (!existsSync(join(store.modelDir(id), rel))) throw new NotFound('file not found');
  res.sendFile(rel, { root: store.modelDir(id) });
}));

// Server-sent events: what changes on the model while it's open (see LiveEvent).
app.get('/api/models/:id/live', route(async (req, res) => {
  const id = param(req, 'id');
  await store.getModel(id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (e: LiveEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const off = live.subscribe(id, send);
  for (const thread of agent.threadsOf(id)) send({ type: 'thread', thread });
  const loop = await screenshotReviews.get(id);
  if (loop) send({ type: 'loop', state: loop });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    off();
  });
}));

// ------------------------------------------------------------------ agent

// The model's fitting or design thread, made if it hasn't one yet.
app.post('/api/models/:id/agent', route(async (req, res) => {
  const thread = await agent.mainThread(param(req, 'id'), parseAgentSettings(req.body ?? {}));
  res.json(agent.threadState(thread.id));
}));

// Start over: the next message starts a new conversation (the thread keeps what was said).
app.post('/api/models/:id/agent/new-session', route(async (req, res) => {
  await agent.startOver(param(req, 'id'));
  res.status(204).end();
}));

app.get('/api/models/:id/checkpoints', route(async (req, res) => {
  res.json(await store.listCheckpoints(param(req, 'id')));
}));

// Put the model back as it was before a change the agent made.
app.post('/api/models/:id/checkpoints/:cid/revert', route(async (req, res) => {
  const id = param(req, 'id');
  await notWhileRunning(id);
  const { model, checkpoint, meshChanged } = await checkpoints.revert(id, param(req, 'cid'));
  live.emit(id, { type: 'model', model, meshChanged });
  live.emit(id, { type: 'checkpoint', checkpoint });
  res.json({ model, checkpoint, meshChanged });
}));

app.patch('/api/models/:id/checkpoints/:cid', route(async (req, res) => {
  const rating = (req.body ?? {}).rating;
  if (rating !== null && rating !== 'accepted' && rating !== 'rejected') throw new BadRequest('rating must be accepted, rejected or null');
  const checkpoint = await checkpoints.rate(param(req, 'id'), param(req, 'cid'), rating);
  live.emit(checkpoint.modelId, { type: 'checkpoint', checkpoint });
  res.json(checkpoint);
}));

app.get('/api/models/:id/reviews', route(async (req, res) => {
  res.json(await reviews.list(param(req, 'id')));
}));

// An independent review of the fit as it is now, in a thread of its own.
app.post('/api/models/:id/reviews', route(async (req, res) => {
  const { review } = await reviews.start(param(req, 'id'), parseAgentSettings(req.body ?? {}), { images: asAttachments(decodeImages(req.body?.images, 4)) });
  res.status(202).json(review);
}));

app.post('/api/models/:id/reviews/:rid/cancel', route(async (req, res) => {
  res.json(await reviews.cancel(param(req, 'id'), param(req, 'rid')));
}));

app.get('/api/models/:id/screenshot-review', route(async (req, res) => {
  await store.getModel(param(req, 'id'));
  res.json(await screenshotReviews.get(param(req, 'id')));
}));

app.post('/api/models/:id/screenshot-review', route(async (req, res) => {
  if (req.body?.prompt !== undefined && typeof req.body.prompt !== 'string') throw new BadRequest('prompt must be a string');
  const targets = decodeImages(req.body?.images, 1);
  if (targets.length !== 1) throw new BadRequest('Attach one target screenshot');
  res.status(202).json(await screenshotReviews.start(param(req, 'id'), targets[0], parseAgentSettings(req.body), req.body?.prompt ?? ''));
}));

app.post('/api/models/:id/screenshot-review/cancel', route(async (req, res) => {
  res.json({ cancelled: screenshotReviews.cancel(param(req, 'id')) });
}));

// ---------------------------------------------------------------- threads
// agent-threads over SSE and POST (its docs/transport.md): a thread's snapshot and then its
// events, saved events after a seq, earlier items, and commands. Only potfit's threads.

const potfitThread = async (tid: string) => {
  const t = await agent.sdk.get(tid);
  if (!t || typeof t.metadata?.modelId !== 'string') throw new NotFound(`thread ${tid} not found`);
  return t;
};

app.get('/api/threads/:tid/stream', route(async (req, res) => {
  const tid = param(req, 'tid');
  await potfitThread(tid);
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Subscribe first, holding events until the snapshot is out, so none are missed in between.
  let held: ThreadEvent[] | null = [];
  const off = agent.sdk.subscribe((e) => {
    if (e.thread_id !== tid) return;
    if (held) held.push(e);
    else send('event', e);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    off();
  });
  const snapshot = await agent.sdk.snapshot(tid, { limit: 300 });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  send('snapshot', snapshot);
  for (const e of held) send('event', e);
  held = null;
}));

app.get('/api/threads/:tid/events', route(async (req, res) => {
  const tid = param(req, 'tid');
  await potfitThread(tid);
  res.json(await agent.sdk.eventsSince(tid, Number(req.query.after ?? 0)));
}));

app.get('/api/threads/:tid/items', route(async (req, res) => {
  const tid = param(req, 'tid');
  await potfitThread(tid);
  res.json(await agent.sdk.itemsBefore(tid, Number(req.query.before ?? 0), Math.min(500, Number(req.query.limit ?? 200))));
}));

app.post('/api/threads/:tid/commands', route(async (req, res) => {
  const tid = param(req, 'tid');
  const command = req.body;
  if (command?.thread_id !== tid) throw new BadRequest('the command is for another thread');
  await agent.handle(command);
  res.status(204).end();
}));

// ---------------------------------------------------------------- designs

// Rebuild with new parameter values, or with an edited script (kept only if it builds).
app.post('/api/models/:id/design/build', route(async (req, res) => {
  const id = param(req, 'id');
  await notWhileRunning(id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  let params: ParamValues | undefined;
  if (b.params !== undefined) {
    if (!b.params || typeof b.params !== 'object' || Array.isArray(b.params)) throw new BadRequest('params must be an object');
    params = Object.fromEntries(Object.entries(b.params).filter(([, v]) => ['number', 'boolean', 'string'].includes(typeof v))) as ParamValues;
  }
  if (b.script !== undefined && (typeof b.script !== 'string' || b.script.length > 500_000)) throw new BadRequest('script must be a string under 500 kB');
  const script = b.script as string | undefined;
  try {
    res.json(await designs.rebuild(id, { params, script }));
  } catch (e) {
    // A failed edit is just refused; a failed rebuild of the saved script is recorded.
    if (e instanceof BuildError && script === undefined) await designs.recordError(id, e.message);
    throw e;
  }
}));

app.get('/api/models/:id/design/script', route(async (req, res) => {
  const id = param(req, 'id');
  if (!existsSync(designs.scriptPath(id))) throw new NotFound('This model has no design script');
  res.type('text/javascript').send(await designs.readScript(id));
}));

app.get('/api/models/:id/design/refs/:name', route(async (req, res) => {
  const name = param(req, 'name');
  if (!/^[\w-]+\.(png|jpg|webp)$/.test(name)) throw new NotFound('image not found');
  const dir = designs.refsDir(param(req, 'id'));
  if (!existsSync(join(dir, name))) throw new NotFound('image not found');
  res.sendFile(name, { root: dir });
}));

// ------------------------------------------------------------- static app

const dist = join(root, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: dist }));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof NotFound ? 404 : err instanceof BadRequest || err instanceof CommandError || err instanceof SyntaxError ? 400 : err instanceof Conflict ? 409 : err instanceof BuildError ? 422 : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message });
});

app.listen(port, host, (err?: Error) => {
  // Express 5 reports a failed listen (e.g. the port is taken) here.
  if (err) {
    console.error(`potfit: could not listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  }
  const shown = host.includes(':') ? `[${host}]` : host;
  console.log(`potfit API on http://${shown}:${port} (data in ${dataDir})`);
  if (!loopbackOnly) {
    console.warn(
      `warning: POTFIT_HOST=${host} exposes an unauthenticated API that runs Claude Code as you; anyone who can reach it can use your Claude login and run Blender scripts on this machine.`,
    );
  }
});

// Stop the threads' Claude processes and save everything before going.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    agent.close().finally(() => process.exit(0));
  });
}
