import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMesh, initialTransform } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { applyTransform, computeBounds, validateTransform, yUpToZUp } from '../shared/transform.ts';
import { DEFAULT_FIT, type CodexRunKind, type FitSettings, type ModelPatch, type ParamValues, type ReferenceInput, type ServerStatus } from '../shared/types.ts';
import { blenderVersion } from './blender.ts';
import { BadRequest, CodexRunner, Conflict, SANDBOX_MODES, codexVersion, type SandboxMode } from './codex.ts';
import { BuildError, DEFAULT_DESIGN_NAME, Designs, type DesignImage } from './design.ts';
import { NotFound, Store } from './store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.POTFIT_PORT ?? 5174);
// The API is unauthenticated and drives Codex under the user's login, so it
// only listens on loopback unless POTFIT_HOST says otherwise.
const host = process.env.POTFIT_HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const loopbackOnly = LOOPBACK_HOSTS.has(host);
const dataDir = resolve(process.env.POTFIT_DATA ?? join(root, 'data'));
const codexBin = process.env.POTFIT_CODEX_BIN ?? 'codex';
// Codex's own sandbox needs user namespaces, which a default Docker container
// doesn't allow; there the container is the sandbox (danger-full-access).
const codexSandbox = (process.env.POTFIT_CODEX_SANDBOX || 'workspace-write') as SandboxMode;
if (!SANDBOX_MODES.includes(codexSandbox)) {
  console.error(`potfit: POTFIT_CODEX_SANDBOX must be one of ${SANDBOX_MODES.join(', ')}`);
  process.exit(1);
}

// Codex can run Blender, when there is one, to edit meshes and make parts for designs.
const blenderBin = process.env.POTFIT_BLENDER_BIN || 'blender';
const blender = { bin: blenderBin, status: blenderVersion(blenderBin) };

const store = new Store(dataDir);
await store.init();
const toolPath = join(root, 'tools', 'pot-tool.ts');
const designs = new Designs(store, { root, toolPath, blender });
const codex = new CodexRunner(store, designs, {
  bin: codexBin,
  model: process.env.POTFIT_CODEX_MODEL || null,
  sandbox: codexSandbox,
  toolPath,
  blender,
});
await codex.recover();

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

const RUN_KINDS: CodexRunKind[] = ['fit', 'feedback', 'review', 'design', 'design-feedback'];

// ---------------------------------------------------------------- status

app.get('/api/status', route(async (_req, res) => {
  const status: ServerStatus = { codex: await codexVersion(codexBin), blender: await blender.status, dataDir };
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
      codexThreadId: null,
    },
    writeBinarySTL(positions, `potfit: ${name}`),
  );
  res.status(201).json(model);
}));

// A pot designed from a description and/or reference images. It starts as a
// plain pot built around the reference pot, and Codex redesigns it unless
// `codex` is false.
app.post('/api/designs', route(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  const images = decodeImages(b.images, 8);
  const useCodex = b.codex !== false;
  if (useCodex && !description && images.length === 0) throw new BadRequest('Describe the pot or add a reference image');
  const fit: FitSettings = { ...DEFAULT_FIT, referenceId: await defaultReferenceId(), ...fitPatch(b.fit) };
  const ref = fit.referenceId ? await store.getReference(fit.referenceId) : null;
  if (!ref) throw new BadRequest('Choose a reference pot for the design');
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : DEFAULT_DESIGN_NAME;
  const model = await designs.create({ name, description, images, fit, ref });
  const run = useCodex ? await codex.start(model.id, { mode: 'design', message: description, images: [] }) : null;
  res.status(201).json({ model, run });
}));

app.get('/api/models/:id', route(async (req, res) => {
  const model = await store.getModel(param(req, 'id'));
  res.json({ model, activeRun: codex.activeRun(model.id) });
}));

app.patch('/api/models/:id', route(async (req, res) => {
  const id = param(req, 'id');
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: ModelPatch & { codexThreadId?: null; design?: { threadId: null } } = {};
  if ('name' in b) {
    if (typeof b.name !== 'string' || !b.name.trim()) throw new BadRequest('name must be a non-empty string');
    patch.name = b.name.trim();
  }
  if ('transform' in b) {
    const err = validateTransform(b.transform);
    if (err) throw new BadRequest(err);
    // A review works on its own copy of the fit, so editing during one is fine.
    const active = codex.activeRun(id);
    if (active && active.kind !== 'review') throw new Conflict('Codex is working on this model; wait for it to finish or cancel it');
    patch.transform = b.transform as ModelPatch['transform'];
  }
  if ('fit' in b) patch.fit = fitPatch(b.fit) as FitSettings;
  // Forget the conversation: the fitting one, and a designed pot's design one.
  if (b.resetCodex === true) Object.assign(patch, { codexThreadId: null, design: { threadId: null } });
  res.json(await store.updateModel(id, patch));
}));

app.delete('/api/models/:id', route(async (req, res) => {
  const id = param(req, 'id');
  codex.cancel(id);
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

// ------------------------------------------------------------------ codex

app.get('/api/models/:id/runs', route(async (req, res) => {
  res.json(await store.listRuns(param(req, 'id')));
}));

app.post('/api/models/:id/runs', route(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const mode = RUN_KINDS.includes(b.mode as CodexRunKind) ? (b.mode as CodexRunKind) : 'fit';
  const run = await codex.start(param(req, 'id'), {
    mode,
    message: typeof b.message === 'string' ? b.message : '',
    images: decodeImages(b.images, 4),
    attachments: decodeImages(b.attachments, 8),
  });
  res.status(202).json(run);
}));

app.post('/api/models/:id/runs/cancel', route(async (req, res) => {
  res.json({ cancelled: codex.cancel(param(req, 'id')) });
}));

// Undo a fit run that edited the mesh: the mesh, placement and fit settings from before it.
app.post('/api/models/:id/runs/:runId/revert', route(async (req, res) => {
  res.json(await codex.revertMeshEdit(param(req, 'id'), param(req, 'runId')));
}));

app.patch('/api/models/:id/runs/:runId', route(async (req, res) => {
  const run = await store.getRun(param(req, 'id'), param(req, 'runId'));
  const rating = (req.body ?? {}).rating;
  if (rating !== null && rating !== 'accepted' && rating !== 'rejected') throw new BadRequest('rating must be accepted, rejected or null');
  const next = { ...run, rating };
  await store.saveRun(next);
  res.json(next);
}));

// Server-sent events: replays the run's events, then streams until it ends.
app.get('/api/models/:id/runs/:runId/events', route(async (req, res) => {
  const id = param(req, 'id'), runId = param(req, 'runId');
  await store.getRun(id, runId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = codex.subscribe(id, runId, (e) => {
    send(e);
    if (e.type === 'result') res.end();
  });
  if (!unsubscribe) {
    for (const e of await store.readEvents(id, runId)) send(e);
    send({ type: 'end' });
    res.end();
    return;
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}));

// ---------------------------------------------------------------- designs

const notWhileRunning = (id: string) => {
  if (codex.activeRun(id)) throw new Conflict('Codex is working on this model; wait for it to finish or cancel it');
};

// Rebuild with new parameter values, or with an edited script (kept only if it builds).
app.post('/api/models/:id/design/build', route(async (req, res) => {
  const id = param(req, 'id');
  notWhileRunning(id);
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

// Put back the script and parameters from before a design run.
app.post('/api/models/:id/design/revert', route(async (req, res) => {
  const id = param(req, 'id');
  notWhileRunning(id);
  const run = await store.getRun(id, String((req.body ?? {}).runId ?? ''));
  if (run.kind !== 'design' && run.kind !== 'design-feedback') throw new BadRequest('Only design runs can be reverted here');
  const before = join(store.runDir(id, run.id), 'before.mjs');
  if (!existsSync(before)) throw new NotFound('This run has no saved script to go back to');
  await designs.restoreParts(id, store.runDir(id, run.id));
  res.json(await designs.rebuild(id, { script: await readFile(before, 'utf8'), params: run.paramsBefore ?? {}, resetParams: true }));
}));

// ------------------------------------------------------------- static app

const dist = join(root, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: dist }));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof NotFound ? 404 : err instanceof BadRequest ? 400 : err instanceof Conflict ? 409 : err instanceof BuildError ? 422 : 500;
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
      `warning: POTFIT_HOST=${host} exposes an unauthenticated API that runs Codex as you; anyone who can reach it can read your files through Codex.`,
    );
  }
});
