import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMesh, initialTransform } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { applyTransform, computeBounds, validateTransform, yUpToZUp } from '../shared/transform.ts';
import { DEFAULT_FIT, type FitSettings, type ModelPatch, type ReferenceInput, type ServerStatus } from '../shared/types.ts';
import { BadRequest, CodexRunner, Conflict, codexVersion } from './codex.ts';
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

const store = new Store(dataDir);
await store.init();
const codex = new CodexRunner(store, {
  bin: codexBin,
  model: process.env.POTFIT_CODEX_MODEL || null,
  toolPath: join(root, 'tools', 'pot-tool.ts'),
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

// ---------------------------------------------------------------- status

app.get('/api/status', route(async (_req, res) => {
  const status: ServerStatus = { codex: await codexVersion(codexBin), dataDir };
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
  // Default to the reference pot used most recently, else the newest one.
  const refs = await store.listReferences();
  const recent = (await store.listModels())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((m) => m.fit.referenceId)
    .find((id) => id && refs.some((r) => r.id === id));
  const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim() : 'Untitled pot';
  const model = await store.createModel(
    {
      name,
      sourceFile: typeof req.query.sourceFile === 'string' ? req.query.sourceFile : name,
      triangleCount: positions.length / 9,
      transform: initialTransform(positions, analysis),
      fit: { ...DEFAULT_FIT, referenceId: recent ?? refs.at(-1)?.id ?? null },
      codexThreadId: null,
    },
    writeBinarySTL(positions, `potfit: ${name}`),
  );
  res.status(201).json(model);
}));

app.get('/api/models/:id', route(async (req, res) => {
  const model = await store.getModel(param(req, 'id'));
  res.json({ model, activeRun: codex.activeRun(model.id) });
}));

app.patch('/api/models/:id', route(async (req, res) => {
  const id = param(req, 'id');
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: ModelPatch & { codexThreadId?: null } = {};
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
  if (b.resetCodex === true) patch.codexThreadId = null;
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
  const mode = b.mode === 'feedback' || b.mode === 'review' ? b.mode : 'fit';
  const images = Array.isArray(b.images) ? b.images : [];
  const decoded = images.slice(0, 4).map((img: { name?: unknown; dataUrl?: unknown }) => {
    const m = typeof img.dataUrl === 'string' ? /^data:image\/png;base64,(.+)$/.exec(img.dataUrl) : null;
    if (!m) throw new BadRequest('images must be PNG data URLs');
    return { name: typeof img.name === 'string' ? img.name : 'image', data: Buffer.from(m[1], 'base64') };
  });
  const run = await codex.start(param(req, 'id'), { mode, message: typeof b.message === 'string' ? b.message : '', images: decoded });
  res.status(202).json(run);
}));

app.post('/api/models/:id/runs/cancel', route(async (req, res) => {
  res.json({ cancelled: codex.cancel(param(req, 'id')) });
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

// ------------------------------------------------------------- static app

const dist = join(root, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: dist }));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof NotFound ? 404 : err instanceof BadRequest ? 400 : err instanceof Conflict ? 409 : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message });
});

app.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host;
  console.log(`potfit API on http://${shown}:${port} (data in ${dataDir})`);
  if (!loopbackOnly) {
    console.warn(
      `warning: POTFIT_HOST=${host} exposes an unauthenticated API that runs Codex as you; anyone who can reach it can read your files through Codex.`,
    );
  }
});
