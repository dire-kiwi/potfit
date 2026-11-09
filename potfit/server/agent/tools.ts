// potfit's app tools: what the agent measures, looks at and changes the pot with. Each role's
// threads get only its tools (toolsFor). They're thin wrappers over pot-tool (run as a child
// process, so slicing and rendering don't hold up the server) and the server's own code.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { defineTool, type Tool, type ToolContext, type ToolOutput } from '@dire-kiwi/agent-threads-node';
import { checkFit } from '../../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../../shared/stl.ts';
import { validateTransform } from '../../shared/transform.ts';
import type { AgentRole, Confidence, FitGoals, PotModel, PotTransform, ReferencePot, ReviewResult } from '../../shared/types.ts';
import type { BlenderOption } from '../blender.ts';
import { BuildError, DEFAULT_DESIGN_NAME, type Designs } from '../design.ts';
import type { Store } from '../store.ts';
import type { Checkpoints } from './checkpoints.ts';
import type { Live } from './live.ts';
import { inside } from './policy.ts';
import { overhangPreference } from './prompts.ts';
import { fitWorkspace, prepareFitWorkspace, refState } from './workspace.ts';

export interface ToolDeps {
  store: Store;
  designs: Designs;
  checkpoints: Checkpoints;
  live: Live;
  /** tools/pot-tool.ts */
  toolPath: string;
  blender: BlenderOption;
  /** Records a reviewer's verdict. */
  submitReview(modelId: string, reviewId: string, result: ReviewResult): Promise<unknown>;
}

const POT_TOOL_TIMEOUT_MS = 5 * 60_000;
const BLENDER_TIMEOUT_S = 600;
const OUTPUT_TAIL = 8000;

const tail = (s: string, n = OUTPUT_TAIL) => (s.length > n ? `... (${s.length - n} characters before)\n${s.slice(-n)}` : s);

/** Run pot-tool in `ws`; its text for the agent and its JSON for the app. */
export async function potTool(toolPath: string, ws: string, args: string[]): Promise<{ text: string; json: any }> {
  const jsonFile = join(ws, `.pot-tool-${randomUUID().slice(0, 8)}.json`);
  try {
    const { code, stdout, stderr } = await run(process.execPath, [toolPath, ...args, '--json-out', jsonFile], ws, POT_TOOL_TIMEOUT_MS);
    if (code !== 0) throw new Error((stderr.trim() || stdout.trim() || `pot-tool ${args[0]} exited with code ${code}`).replace(/^pot-tool: /, ''));
    const json = existsSync(jsonFile) ? JSON.parse(await readFile(jsonFile, 'utf8')) : null;
    return { text: [stderr.trim(), stdout.trim()].filter(Boolean).join('\n\n'), json };
  } finally {
    await rm(jsonFile, { force: true }).catch(() => undefined);
  }
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length > 4_000_000 ? s : s + d);
    child.stdout!.on('data', (d) => (stdout = cap(stdout, d)));
    child.stderr!.on('data', (d) => (stderr = cap(stderr, d)));
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${bin}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------- schemas

const vec3 = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'z'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
};

const TRANSFORM = {
  type: 'object',
  description: 'A placement: world = position + scale * (spinY(spin) * (upRotation(up) * raw - anchor)).',
  additionalProperties: false,
  required: ['up', 'spin', 'position', 'scale'],
  properties: {
    up: { type: 'string', enum: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] },
    spin: { type: 'number' },
    position: vec3,
    scale: vec3,
  },
};

const GOALS = {
  type: 'object',
  additionalProperties: false,
  required: ['clearance', 'scaleMode', 'topOffset', 'floorGap'],
  properties: {
    clearance: { type: 'number', minimum: 0, description: 'Diametral clearance, mm' },
    scaleMode: { type: 'string', enum: ['uniform', 'radial-height'] },
    topOffset: { type: ['number', 'null'], description: "Reference rim above the outer rim, mm; null: sit on the floor at the smallest scale" },
    floorGap: { type: 'number', minimum: 0 },
  },
};

const GOAL_OVERRIDES = {
  clearance: { type: 'number', minimum: 0, description: 'Diametral clearance, mm (default: the current goal)' },
  mode: { type: 'string', enum: ['uniform', 'radial-height'], description: 'Scale mode (default: the current goal)' },
  topOffset: { type: ['number', 'null'], description: 'Rim offset goal, mm, or null for none (default: the current goal)' },
  floorGap: { type: 'number', minimum: 0, description: 'Floor gap, mm (default: the current goal)' },
};

const REPORT = {
  summary: { type: 'string', description: '2-5 plain sentences for the user' },
  warnings: { type: 'array', items: { type: 'string' }, description: 'What the user should check; empty if none' },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
};

// ---------------------------------------------------------------- helpers

interface Meta {
  modelId: string;
  role: AgentRole;
  reviewId?: string;
}

function meta(ctx: ToolContext, roles: AgentRole[]): Meta {
  const m = ctx.metadata as Partial<Meta>;
  if (typeof m.modelId !== 'string' || !m.role || !roles.includes(m.role)) throw new Error('This tool is not available in this thread');
  return m as Meta;
}

function goalArgs(a: { clearance?: number; mode?: string; topOffset?: number | null; floorGap?: number }): string[] {
  return [
    ...(a.clearance !== undefined ? ['--clearance', String(a.clearance)] : []),
    ...(a.mode !== undefined ? ['--mode', a.mode] : []),
    ...(a.topOffset !== undefined ? ['--top-offset', a.topOffset === null ? 'none' : String(a.topOffset)] : []),
    ...(a.floorGap !== undefined ? ['--floor-gap', String(a.floorGap)] : []),
  ];
}

export function parseGoals(v: unknown): FitGoals | null {
  const f = v as Record<string, unknown> | null;
  if (!f || typeof f !== 'object') return null;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!num(f.clearance) || (f.clearance as number) < 0) return null;
  if (f.scaleMode !== 'uniform' && f.scaleMode !== 'radial-height') return null;
  if (f.topOffset !== null && !num(f.topOffset)) return null;
  if (!num(f.floorGap) || (f.floorGap as number) < 0) return null;
  return { clearance: f.clearance as number, scaleMode: f.scaleMode, topOffset: f.topOffset as number | null, floorGap: f.floorGap as number };
}

export function parseReview(o: Record<string, unknown>): ReviewResult {
  if (o.verdict !== 'pass' && o.verdict !== 'concerns' && o.verdict !== 'fail') throw new Error('verdict must be pass, concerns or fail');
  const findings = Array.isArray(o.findings) ? o.findings : [];
  return {
    verdict: o.verdict,
    summary: typeof o.summary === 'string' ? o.summary : '',
    findings: findings
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({ severity: f.severity === 'major' || f.severity === 'minor' ? f.severity : 'info', title: String(f.title ?? ''), detail: String(f.detail ?? '') })),
    feedbackForFitter: typeof o.feedbackForFitter === 'string' ? o.feedbackForFitter : '',
  };
}

/**
 * Text for the agent with data for the app's renderer. Claude Code shows the agent an MCP result's
 * structured content in place of its text, so the text goes in the data too, as `message`.
 */
const reply = (text: string, data: object): ToolOutput => ({ text, structured: { message: text, ...data } });

const confidenceOf = (c: unknown): Confidence => (c === 'high' || c === 'low' ? c : 'medium');
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const f2 = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : Number.isFinite(v) ? v.toFixed(2) : v > 0 ? 'inf' : '-inf');

function metricsLine(m: ReturnType<typeof checkFit>): string {
  return [
    `min radial gap ${f2(m.minRadialGap)} mm (required ${f2(m.requiredRadialGap)})`,
    `rim offset ${f2(m.topOffset)} mm`,
    `floor gap ${f2(m.floorGap)} mm`,
    m.interferes ? 'the reference pot INTERFERES with the outer pot' : 'no interference',
    m.wallThickness ? `thinnest wall ${f2(m.wallThickness.min)} mm` : null,
    `size ${f2(m.size.x)} x ${f2(m.size.z)} x ${f2(m.size.y)} mm`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** The tools for each role. Blender's is offered only when Blender runs. */
export async function toolsFor(deps: ToolDeps): Promise<Record<AgentRole, Tool[]>> {
  const { store, designs, checkpoints, live, toolPath } = deps;
  const blender = await deps.blender.status;
  const helpers = join(dirname(toolPath), 'blender');

  const load = async (modelId: string): Promise<{ model: PotModel; ref: ReferencePot | null }> => {
    const model = await store.getModel(modelId);
    const ref = model.fit.referenceId ? await store.getReference(model.fit.referenceId) : null;
    return { model, ref };
  };
  const needRef = (ref: ReferencePot | null): ReferencePot => {
    if (!ref) throw new Error('The model has no nursery pot chosen; ask the user to pick one in step 1.');
    return ref;
  };

  /** The thread's workspace, made ready for pot-tool. */
  const workspace = async (m: Meta): Promise<string> => {
    if (m.role === 'review') return store.reviewDir(m.modelId, m.reviewId!);
    const { model, ref } = await load(m.modelId);
    if (m.role === 'design') return designs.prepareWorkspace(model, needRef(ref));
    return prepareFitWorkspace(store, model, ref);
  };

  const transformArg = (t: unknown) => {
    if (t === undefined) return [];
    const err = validateTransform(t);
    if (err) throw new Error(`transform: ${err}`);
    return ['--transform', JSON.stringify(t)];
  };

  /** A path the agent gave, inside its workspace. */
  const inWorkspace = (ws: string, p: unknown, what: string) => {
    if (typeof p !== 'string' || !p.trim()) throw new Error(`${what} is required`);
    const file = resolve(ws, p);
    if (!inside(file, ws)) throw new Error(`${what} must be inside your working directory`);
    return file;
  };

  const getState = defineTool<Record<string, never>>({
    name: 'get_state',
    description:
      "The model as the user sees it now: the nursery (reference) pot, the fit goals, the current placement (with the user's manual moves), the overhang preference and, for a designed pot, its description, reference images and parameters. For a review, what is being reviewed.",
    input: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, ctx) => {
      const m = meta(ctx, ['fit', 'design', 'review']);
      if (m.role === 'review') {
        const ws = await workspace(m);
        return readFile(join(ws, 'state.json'), 'utf8');
      }
      const { model, ref } = await load(m.modelId);
      const out: Record<string, unknown> = {
        model: { name: model.name, sourceFile: model.sourceFile, triangles: model.triangleCount },
        nurseryPot: ref ? refState(ref) : null,
        fitGoals: model.fit,
        transform: model.transform,
        overhangPreference: overhangPreference(model.avoidOverhangs !== false),
        blender: blender.available ? blender.version : 'not installed',
      };
      if (model.design) {
        const d = model.design;
        out.design = {
          description: d.description,
          referenceImages: d.images.map((n) => `refs/${n}`),
          params: d.params,
          paramSpec: d.paramSpec,
          lastBuild: d.report ? { size: d.report.size, triangles: d.report.triangles, pieces: d.report.components, overhangArea: d.report.overhangArea, warnings: d.report.warnings, notes: d.report.notes } : null,
          buildError: d.buildError,
          unapplied: existsSync(join(designs.dir(model.id), 'unapplied.mjs')) ? 'unapplied.mjs: your last edits, which were never applied (design.mjs is the applied version)' : null,
        };
      }
      return JSON.stringify(out, null, 2);
    },
  });

  const listReferencePots = defineTool<Record<string, never>>({
    name: 'list_reference_pots',
    description: 'The nursery pots the user has saved: name, top and bottom outer diameter and height (mm), and notes.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, ctx) => {
      meta(ctx, ['fit', 'design', 'review']);
      return JSON.stringify((await store.listReferences()).map((r) => ({ id: r.id, ...refState(r) })), null, 2);
    },
  });

  const analyzeMesh = defineTool<Record<string, never>>({
    name: 'analyze_mesh',
    description: "Orientation candidates (which raw axis is up), the cavity profile and the model's dimensions at scale 1.",
    input: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, ctx) => {
      const m = meta(ctx, ['fit', 'review']);
      return (await potTool(toolPath, await workspace(m), ['analyze'])).text;
    },
  });

  const solveFit = defineTool<{ up?: string; spin?: number; clearance?: number; mode?: string; topOffset?: number | null; floorGap?: number }>({
    name: 'solve_fit',
    description: 'The deterministic fit: scales and places the pot around the nursery pot for the goals, and measures the result. Doesn\'t change anything; apply_fit does.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        up: { type: 'string', enum: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'], description: 'Raw axis that points up (default: the current placement\'s)' },
        spin: { type: 'number', description: 'Degrees about the vertical axis (default: the current placement\'s)' },
        ...GOAL_OVERRIDES,
      },
    },
    run: async (a, ctx) => {
      const m = meta(ctx, ['fit']);
      const args = ['solve', ...(a.up ? ['--up', a.up] : []), ...(a.spin !== undefined ? ['--spin', String(a.spin)] : []), ...goalArgs(a)];
      const { text, json } = await potTool(toolPath, await workspace(m), args);
      return reply(text, { transform: json?.transform, metrics: json?.metrics });
    },
  });

  const checkFitTool = defineTool<{ transform?: PotTransform; clearance?: number; mode?: string; topOffset?: number | null; floorGap?: number }>({
    name: 'check_fit',
    description:
      'Measures a placement against the nursery pot: radial gaps by height, rim offset, floor gap, interference, wall and floor thickness, size. Default: the current placement (for a design, the last build as the app places it; for a review, the fitted pot as it is).',
    input: { type: 'object', additionalProperties: false, properties: { transform: TRANSFORM, ...GOAL_OVERRIDES } },
    run: async (a, ctx) => {
      const m = meta(ctx, ['fit', 'design', 'review']);
      const { text, json } = await potTool(toolPath, await workspace(m), ['check', ...(m.role === 'fit' ? transformArg(a.transform) : []), ...goalArgs(a)]);
      return reply(text, { metrics: json });
    },
  });

  const renderViews = defineTool<{ sections?: number[]; shaded?: boolean; view?: { azimuth: number; elevation: number }; transform?: PotTransform }>({
    name: 'render_views',
    description:
      'Draws the pot as PNGs in renders/ and returns their paths: side-on sections through the axis at the given angles (the nursery pot in red, the required clearance dashed orange), and shaded views (front, right side, three-quarter, top; or one large view from `view`). Look at them with the Read tool.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sections: { type: 'array', items: { type: 'number' }, maxItems: 6, description: 'Section angles in degrees about the vertical axis (default [0, 90]; [] for none)' },
        shaded: { type: 'boolean', description: 'Also render shaded views (default true)' },
        view: {
          type: 'object',
          additionalProperties: false,
          required: ['azimuth', 'elevation'],
          properties: { azimuth: { type: 'number', description: '0 looks at the front from -y, -90 at the right side' }, elevation: { type: 'number' } },
          description: 'One large shaded view instead of the four',
        },
        transform: { ...TRANSFORM, description: 'Fitting threads: a placement to draw (default: the current one)' },
      },
    },
    run: async (a, ctx) => {
      const m = meta(ctx, ['fit', 'design', 'review']);
      const ws = await workspace(m);
      const stamp = Date.now().toString(36);
      const files: string[] = [];
      const notes: string[] = [];
      const t = m.role === 'fit' ? transformArg(a.transform) : [];
      for (const angle of a.sections ?? [0, 90]) {
        const out = `renders/${stamp}-section-${Math.round(angle)}.png`;
        await potTool(toolPath, ws, ['render', '--angle', String(angle), '--out', out, ...t]);
        files.push(out);
      }
      if ((a.sections ?? [0, 90]).length) notes.push('Sections: grey fill is the cut outer pot, red the nursery pot, dashed orange the required clearance, dashed blue the axis, light grid 10 mm.');
      if (a.shaded !== false) {
        const out = `renders/${stamp}-${a.view ? `view-${Math.round(a.view.azimuth)}-${Math.round(a.view.elevation)}` : 'views'}.png`;
        const view = a.view ? ['--view', `${a.view.azimuth},${a.view.elevation}`] : [];
        if (m.role === 'design') {
          await potTool(toolPath, ws, ['preview', '--out', out, ...view]);
        } else {
          const placed = `renders/.${stamp}-placed.stl`;
          try {
            await potTool(toolPath, ws, ['place', '--z-up', '--out', placed, ...t]);
            await potTool(toolPath, ws, ['preview', '--mesh', placed, '--out', out, ...view]);
          } finally {
            await rm(join(ws, placed), { force: true });
          }
        }
        files.push(out);
        notes.push(a.view ? 'The shaded view looks from the azimuth and elevation given.' : 'Shaded views: top left front (from -y), top right right side (from +x), bottom left three-quarter from the front right above, bottom right top down with the front at the bottom.');
      }
      const base = relative(store.modelDir(m.modelId), ws);
      return reply([...files.map((f) => `wrote ${f}`), ...notes].join('\n'), { files: files.map((f) => `${base}/${f}`) });
    },
  });

  const applyFit = defineTool<{ transform: PotTransform; fit: FitGoals; summary: string; warnings: string[]; confidence: Confidence }>({
    name: 'apply_fit',
    description:
      'Makes a placement the one the user sees, with the fit goals it meets (the app adopts them) and your summary. The server measures it again and the user can revert it. Check it with check_fit first.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['transform', 'fit', 'summary', 'warnings', 'confidence'],
      properties: { transform: TRANSFORM, fit: GOALS, ...REPORT },
    },
    run: async (a, ctx): Promise<ToolOutput> => {
      const m = meta(ctx, ['fit']);
      const err = validateTransform(a.transform);
      if (err) return { text: `Invalid transform: ${err}`, isError: true };
      const goals = parseGoals(a.fit);
      if (!goals) return { text: 'Invalid fit goals: clearance and floorGap must be numbers >= 0, scaleMode uniform or radial-height, topOffset a number or null.', isError: true };
      const { model, ref } = await load(m.modelId);
      const checkpoint = await checkpoints.begin(model, { kind: 'fit', threadId: ctx.threadId, toolCallId: ctx.toolCallId ?? null });
      const fit = { ...model.fit, ...goals };
      const positions = parseSTL(await readFile(store.meshFile(model.id)));
      const metrics = ref ? checkFit(positions, a.transform, ref, fit) : null;
      const next = await store.updateModel(model.id, { transform: a.transform, fit });
      const saved = await checkpoints.save({ ...checkpoint, transform: a.transform, fit, summary: String(a.summary ?? ''), warnings: strings(a.warnings), confidence: confidenceOf(a.confidence), metrics });
      live.emit(model.id, { type: 'model', model: next, meshChanged: false });
      live.emit(model.id, { type: 'checkpoint', checkpoint: saved });
      return reply(`Applied; the user sees it now (checkpoint ${saved.id}). Server's measurements: ${metrics ? metricsLine(metrics) : 'none (no nursery pot)'}.`, { checkpoint: saved });
    },
  });

  const exportPlaced = defineTool<{ transform?: PotTransform; out?: string }>({
    name: 'export_placed_mesh',
    description:
      "Writes the pot as a placement puts it, turned Z up for Blender (mm, the nursery pot's base centre at the origin, its axis along +Z). Default: the current placement, to placed.stl.",
    input: { type: 'object', additionalProperties: false, properties: { transform: TRANSFORM, out: { type: 'string', description: 'File to write (default placed.stl)' } } },
    run: async (a, ctx) => {
      const m = meta(ctx, ['fit']);
      const ws = await workspace(m);
      const out = relative(ws, inWorkspace(ws, a.out ?? 'placed.stl', 'out'));
      return (await potTool(toolPath, ws, ['place', '--z-up', '--out', out, ...transformArg(a.transform)])).text.replace(/after editing, turn it back with:.*$/m, 'after editing it, give it to apply_mesh_edit with the same transform.');
    },
  });

  const applyMeshEdit = defineTool<{ file: string; transform: PotTransform; fit?: FitGoals; summary: string; warnings: string[]; confidence: Confidence }>({
    name: 'apply_mesh_edit',
    description:
      "Makes a mesh you edited in Blender the model's mesh. `file` is the edited Z-up placed STL; `transform` the placement you exported it with. The server turns it back into raw coordinates, places it where you edited it and measures it; the user can revert it.",
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'transform', 'summary', 'warnings', 'confidence'],
      properties: { file: { type: 'string' }, transform: TRANSFORM, fit: { ...GOALS, description: 'The goals the result meets (default: the current ones)' }, ...REPORT },
    },
    run: async (a, ctx): Promise<ToolOutput> => {
      const m = meta(ctx, ['fit']);
      const ws = await workspace(m);
      const file = inWorkspace(ws, a.file, 'file');
      if (!existsSync(file)) return { text: `${a.file} does not exist`, isError: true };
      const goals = a.fit === undefined ? null : parseGoals(a.fit);
      if (a.fit !== undefined && !goals) return { text: 'Invalid fit goals', isError: true };
      const tmp = `.edited-${randomUUID().slice(0, 8)}.stl`;
      try {
        const { json } = await potTool(toolPath, ws, ['unplace', '--z-up', '--in', relative(ws, file), '--out', tmp, ...transformArg(a.transform)]);
        const edited = parseSTL(await readFile(join(ws, tmp)));
        if (edited.length === 0) return { text: `${a.file} has no triangles`, isError: true };
        if (!edited.every(Number.isFinite)) return { text: `${a.file} has invalid coordinates`, isError: true };
        const placeIt = json.transform as PotTransform;
        const { model, ref } = await load(m.modelId);
        const checkpoint = await checkpoints.begin(model, { kind: 'mesh-edit', threadId: ctx.threadId, toolCallId: ctx.toolCallId ?? null });
        const mesh = store.meshFile(model.id);
        await writeFile(`${mesh}.tmp`, writeBinarySTL(edited, 'potfit: edited by the agent'));
        await rename(`${mesh}.tmp`, mesh);
        const fit = { ...model.fit, ...goals };
        const metrics = ref ? checkFit(edited, placeIt, ref, fit) : null;
        const meshEdit = { trianglesBefore: model.triangleCount, trianglesAfter: edited.length / 9 };
        const next = await store.updateModel(model.id, { transform: placeIt, fit, triangleCount: meshEdit.trianglesAfter });
        const saved = await checkpoints.save({ ...checkpoint, transform: placeIt, fit, meshEdit, summary: String(a.summary ?? ''), warnings: strings(a.warnings), confidence: confidenceOf(a.confidence), metrics });
        live.emit(model.id, { type: 'model', model: next, meshChanged: true });
        live.emit(model.id, { type: 'checkpoint', checkpoint: saved });
        return reply(
          `The edited mesh (${meshEdit.trianglesAfter} triangles, was ${meshEdit.trianglesBefore}) is now the model's, placed by ${JSON.stringify(placeIt)} (checkpoint ${saved.id}). mesh.stl is the edited mesh from now on. Server's measurements: ${metrics ? metricsLine(metrics) : 'none'}.`,
          { checkpoint: saved },
        );
      } finally {
        await rm(join(ws, tmp), { force: true });
      }
    },
  });

  const runBlender = defineTool<{ script: string; args?: string[]; timeoutSeconds?: number }>({
    name: 'run_blender',
    description: `Runs a Python script from your working directory in headless ${blender.version ?? 'Blender'} (factory settings, no UI), with potfit_bpy importable (${join(helpers, 'potfit_bpy.py')}). Its working directory is yours. Returns the exit code and the end of its output.`,
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['script'],
      properties: {
        script: { type: 'string', description: 'The .py file, relative to your working directory' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments after --, for pb.args()' },
        timeoutSeconds: { type: 'number', minimum: 10, maximum: 1800, description: `Default ${BLENDER_TIMEOUT_S}` },
      },
    },
    run: async (a, ctx): Promise<ToolOutput> => {
      const m = meta(ctx, ['fit', 'design']);
      const ws = m.role === 'design' ? designs.dir(m.modelId) : fitWorkspace(store, m.modelId);
      const script = inWorkspace(ws, a.script, 'script');
      if (!existsSync(script)) return { text: `${a.script} does not exist; write it first`, isError: true };
      const args = ['-b', '--factory-startup', '-noaudio', '--python-expr', `import sys; sys.path.insert(0, ${JSON.stringify(helpers)})`, '-P', script, '--', ...(a.args ?? []).map(String)];
      const timeout = Math.min(1800, Math.max(10, a.timeoutSeconds ?? BLENDER_TIMEOUT_S));
      const r = await run(deps.blender.bin, args, ws, timeout * 1000, ctx.signal);
      const output = tail(`${r.stdout}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''}`.trim());
      if (r.timedOut) return { text: `Blender was stopped after ${timeout} s.\n${output}`, isError: true };
      return { text: `exit code ${r.code}\n${output}`, isError: r.code !== 0 };
    },
  });

  const buildDesign = defineTool<{ params?: Record<string, number | boolean | string> }>({
    name: 'build_design',
    description:
      'Builds design.mjs (with the user\'s parameter values, or `params` over them to try others) and reports the size, material, pieces, overhangs steeper than 45° by height and side, and the fit around the nursery pot. Writes out/design.stl. Doesn\'t change what the user sees; apply_design does.',
    input: { type: 'object', additionalProperties: false, properties: { params: { type: 'object', additionalProperties: { type: ['number', 'boolean', 'string'] } } } },
    run: async (a, ctx) => {
      const m = meta(ctx, ['design']);
      const ws = await workspace(m);
      const { text, json } = await potTool(toolPath, ws, ['build', ...(a.params ? ['--params', JSON.stringify(a.params)] : [])]);
      return reply(text, { report: json?.report, params: json?.params });
    },
  });

  const applyDesign = defineTool<{ title: string; summary: string; warnings: string[]; confidence: Confidence }>({
    name: 'apply_design',
    description:
      "Builds design.mjs on the server and makes it the pot the user sees, with the script's parameter defaults (make the user's current values the defaults unless they asked otherwise). If it doesn't build, nothing changes and you get the error. The user can revert it.",
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary', 'warnings', 'confidence'],
      properties: { title: { type: 'string', description: 'Two to four words naming the design' }, ...REPORT },
    },
    run: async (a, ctx): Promise<ToolOutput> => {
      const m = meta(ctx, ['design']);
      const { model } = await load(m.modelId);
      const checkpoint = await checkpoints.begin(model, { kind: 'design', threadId: ctx.threadId, toolCallId: ctx.toolCallId ?? null });
      let next: PotModel;
      try {
        next = await designs.rebuild(model.id, { resetParams: true });
      } catch (e) {
        await rm(store.checkpointDir(model.id, checkpoint.id), { recursive: true, force: true });
        if (e instanceof BuildError) return { text: `The design did not build, so nothing changed: ${e.message}\nFix design.mjs and apply it again.`, isError: true };
        throw e;
      }
      const title = String(a.title ?? '').trim().slice(0, 80);
      if (title && next.name === DEFAULT_DESIGN_NAME) next = await store.updateModel(model.id, { name: title });
      const report = next.design?.report ?? null;
      const saved = await checkpoints.save({
        ...checkpoint,
        title,
        transform: next.transform,
        fit: next.fit,
        summary: String(a.summary ?? ''),
        warnings: strings(a.warnings),
        confidence: confidenceOf(a.confidence),
        designReport: report,
        metrics: report?.metrics ?? null,
      });
      live.emit(model.id, { type: 'model', model: next, meshChanged: true });
      live.emit(model.id, { type: 'checkpoint', checkpoint: saved });
      const metrics = report?.metrics;
      return reply(
        `Applied; the user sees the new design (checkpoint ${saved.id}). ${report ? `${report.triangles} triangles, ${f2(report.size.x)} x ${f2(report.size.y)} x ${f2(report.size.z)} mm, ${report.components} piece(s), overhangs ${f2(report.overhangArea)} mm².` : ''} ${metrics ? `Fit: ${metricsLine(metrics)}.` : ''}`.trim(),
        { checkpoint: saved },
      );
    },
  });

  const submitReview = defineTool<ReviewResult>({
    name: 'submit_review',
    description: 'Records your review of the fit. Call it once, at the end.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'summary', 'findings', 'feedbackForFitter'],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'concerns', 'fail'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'title', 'detail'],
            properties: { severity: { type: 'string', enum: ['major', 'minor', 'info'] }, title: { type: 'string' }, detail: { type: 'string' } },
          },
        },
        feedbackForFitter: { type: 'string' },
      },
    },
    run: async (a, ctx): Promise<ToolOutput> => {
      const m = meta(ctx, ['review']);
      let result: ReviewResult;
      try {
        result = parseReview(a as unknown as Record<string, unknown>);
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
      const review = await deps.submitReview(m.modelId, m.reviewId!, result);
      return reply('Recorded. The user sees your review now.', { review });
    },
  });

  const read = [getState, listReferencePots];
  const blenderTools = blender.available ? [runBlender] : [];
  return {
    fit: [...read, analyzeMesh, solveFit, checkFitTool, renderViews, applyFit, exportPlaced, applyMeshEdit, ...blenderTools],
    design: [...read, buildDesign, checkFitTool, renderViews, applyDesign, ...blenderTools],
    review: [...read, analyzeMesh, checkFitTool, renderViews, submitReview],
  };
}

