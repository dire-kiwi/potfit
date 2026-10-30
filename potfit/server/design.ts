// Pots designed in the app. Each has a workspace, models/<id>/design/, with
// the design script, the user's reference images and what the Codex design
// agent needs. Builds run in a child process under Node's permission model,
// since the script is code Codex wrote, and replace the model's mesh.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DesignParam, DesignReport, DesignTarget, FitSettings, ParamValues, PotDesign, PotModel, ReferencePot } from '../shared/types.ts';
import { designAgentsMd } from './design-prompt.ts';
import type { Store } from './store.ts';

export class BuildError extends Error {}

export interface DesignImage {
  name: string;
  ext: 'png' | 'jpg' | 'webp';
  data: Buffer;
}

export interface BuildResult {
  stl: Buffer;
  report: DesignReport;
  paramSpec: Record<string, DesignParam>;
  params: ParamValues;
}

const BUILD_TIMEOUT_MS = 120_000;
export const SCRIPT_FILE = 'design.mjs';
/** Name a design gets until Codex names it or the user does. */
export const DEFAULT_DESIGN_NAME = 'New design';

export function targetFor(ref: ReferencePot, fit: FitSettings): DesignTarget {
  return {
    referenceId: ref.id,
    reference: { name: ref.name, topOD: ref.topOD, bottomOD: ref.bottomOD, height: ref.height },
    clearance: fit.clearance,
    topOffset: fit.topOffset,
    floorGap: fit.floorGap,
  };
}

export class Designs {
  private store: Store;
  private root: string;
  private toolPath: string;
  // One build at a time per model.
  private queues = new Map<string, Promise<unknown>>();

  constructor(store: Store, opts: { root: string; toolPath: string }) {
    this.store = store;
    this.root = opts.root;
    this.toolPath = opts.toolPath;
  }

  dir(modelId: string) {
    return join(this.store.modelDir(modelId), 'design');
  }

  scriptPath(modelId: string) {
    return join(this.dir(modelId), SCRIPT_FILE);
  }

  refsDir(modelId: string) {
    return join(this.dir(modelId), 'refs');
  }

  private serial<T>(modelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(modelId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(modelId, next.catch(() => undefined));
    return next;
  }

  /** Save reference images into refs/ as ref-N.<ext>, returning the new names. */
  async saveImages(modelId: string, existing: string[], images: DesignImage[]): Promise<string[]> {
    const dir = this.refsDir(modelId);
    await mkdir(dir, { recursive: true });
    let n = existing.length;
    const names: string[] = [];
    for (const img of images) {
      let name: string;
      do name = `ref-${++n}.${img.ext}`;
      while (existsSync(join(dir, name)));
      await writeFile(join(dir, name), img.data);
      names.push(name);
    }
    return names;
  }

  /**
   * Run the script in a locked-down Node: it may read only the build code,
   * manifold-3d and the script, write only its own output directory, and has
   * no network, subprocesses or workers.
   */
  private async runBuild(modelId: string, script: string, target: DesignTarget, params: ParamValues): Promise<BuildResult> {
    const out = join(this.store.modelDir(modelId), 'build', randomUUID().slice(0, 8));
    await mkdir(out, { recursive: true });
    try {
      const inputFile = join(out, 'input.json');
      await writeFile(inputFile, JSON.stringify({ reference: target.reference, fit: { clearance: target.clearance, topOffset: target.topOffset, floorGap: target.floorGap }, params }));
      const tools = dirname(this.toolPath);
      const args = [
        '--permission',
        `--allow-fs-read=${tools}`,
        `--allow-fs-read=${join(this.root, 'shared')}`,
        `--allow-fs-read=${join(this.root, 'node_modules', 'manifold-3d')}`,
        `--allow-fs-read=${script}`,
        `--allow-fs-read=${inputFile}`,
        `--allow-fs-write=${out}`,
        '--max-old-space-size=4096',
        join(tools, 'build-cli.ts'),
        '--script', script,
        '--input', inputFile,
        '--out', out,
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: {} });
        let err = '';
        child.stderr!.on('data', (d) => {
          if (err.length < 20000) err += d;
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), BUILD_TIMEOUT_MS);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new BuildError(`Could not start the build: ${e.message}`));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else if (signal === 'SIGKILL') reject(new BuildError(`The design took longer than ${BUILD_TIMEOUT_MS / 1000} s to build`));
          else reject(new BuildError(err.trim() || `The build exited with ${signal ?? `code ${code}`}`));
        });
      });
      const result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')) as Omit<BuildResult, 'stl'>;
      return { ...result, stl: await readFile(join(out, 'design.stl')) };
    } finally {
      await rm(out, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A new designed model, starting from the starter script, built for `ref` and `fit`. */
  async create(input: { name: string; description: string; images: DesignImage[]; fit: FitSettings; ref: ReferencePot }): Promise<PotModel> {
    const id = randomUUID();
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    try {
      await copyFile(join(dirname(this.toolPath), 'starter-design.mjs'), this.scriptPath(id));
      const images = await this.saveImages(id, [], input.images);
      const target = targetFor(input.ref, input.fit);
      const built = await this.runBuild(id, this.scriptPath(id), target, {});
      const design: PotDesign = {
        description: input.description,
        images,
        threadId: null,
        params: built.params,
        paramSpec: built.paramSpec,
        report: built.report,
        builtFor: target,
        builtAt: new Date().toISOString(),
        buildError: null,
      };
      return await this.store.createModel(
        {
          name: input.name,
          sourceFile: 'designed in potfit',
          triangleCount: built.report.triangles,
          transform: built.report.placement,
          fit: input.fit,
          codexThreadId: null,
          design,
        },
        built.stl,
        id,
      );
    } catch (e) {
      await rm(this.store.modelDir(id), { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Build the model's script (or `script`, which replaces it if it builds) for
   * its current reference pot and goals, and make the result the model's mesh.
   * `params` are merged over the current values unless `resetParams` is set,
   * in which case the script's defaults apply. With a new script, values the
   * user left at their defaults take the new script's defaults.
   */
  rebuild(modelId: string, opts: { params?: ParamValues; resetParams?: boolean; script?: string } = {}): Promise<PotModel> {
    return this.serial(modelId, async () => {
      const model = await this.store.getModel(modelId);
      if (!model.design) throw new BuildError('This model was imported, not designed');
      const ref = model.fit.referenceId ? await this.store.getReference(model.fit.referenceId) : null;
      if (!ref) throw new BuildError('Choose a reference pot before building the design');
      const target = targetFor(ref, model.fit);
      let current = model.design.params;
      if (opts.script !== undefined) {
        // Values the user never changed follow the new script's defaults.
        const spec = model.design.paramSpec;
        current = Object.fromEntries(Object.entries(current).filter(([k, v]) => spec[k]?.value !== v));
      }
      const params = opts.resetParams ? (opts.params ?? {}) : { ...current, ...opts.params };
      let script = this.scriptPath(modelId);
      if (opts.script !== undefined) {
        script = join(this.dir(modelId), `.edit-${randomUUID().slice(0, 8)}.mjs`);
        await writeFile(script, opts.script);
      }
      let built: BuildResult;
      try {
        built = await this.runBuild(modelId, script, target, params);
        if (opts.script !== undefined) await rename(script, this.scriptPath(modelId));
      } finally {
        if (opts.script !== undefined) await rm(script, { force: true }).catch(() => undefined);
      }
      const mesh = this.store.meshFile(modelId);
      await writeFile(`${mesh}.tmp`, built.stl);
      await rename(`${mesh}.tmp`, mesh);
      return this.store.updateModel(modelId, {
        triangleCount: built.report.triangles,
        transform: built.report.placement,
        design: {
          params: built.params,
          paramSpec: built.paramSpec,
          report: built.report,
          builtFor: target,
          builtAt: new Date().toISOString(),
          buildError: null,
        },
      });
    });
  }

  /** Record a failed build without touching the mesh. */
  async recordError(modelId: string, error: string) {
    await this.store.updateModel(modelId, { design: { buildError: error } });
  }

  readScript(modelId: string): Promise<string> {
    return readFile(this.scriptPath(modelId), 'utf8');
  }

  /** Set up the workspace the design agent runs in. */
  async prepareWorkspace(model: PotModel, ref: ReferencePot): Promise<string> {
    const ws = this.dir(model.id);
    await mkdir(join(ws, 'out'), { recursive: true });
    if (!existsSync(this.scriptPath(model.id))) await copyFile(join(dirname(this.toolPath), 'starter-design.mjs'), this.scriptPath(model.id));
    const tool = join(ws, 'pot-tool');
    await writeFile(tool, `#!/bin/sh\nexec "${process.execPath}" "${this.toolPath}" "$@"\n`);
    await chmod(tool, 0o755);
    await writeFile(join(ws, 'AGENTS.md'), designAgentsMd(join(this.root, 'node_modules', 'manifold-3d', 'manifold.d.ts')));
    const state = {
      frame: 'design',
      design: { script: SCRIPT_FILE, out: 'out' },
      mesh: 'out/design.stl',
      name: model.name,
      description: model.design?.description ?? '',
      images: (model.design?.images ?? []).map((n) => `refs/${n}`),
      reference: { name: ref.name, topOD: ref.topOD, bottomOD: ref.bottomOD, height: ref.height, notes: ref.notes },
      fit: model.fit,
      params: model.design?.params ?? {},
    };
    await writeFile(join(ws, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    return ws;
  }
}
