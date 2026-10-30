// Build a design script into a mesh and report on it: size, material,
// floating pieces, overhangs, and the fit around the reference pot it was
// built for. pot-tool runs this inside Codex's sandbox; the server runs it
// through build-cli.ts in a locked-down child process.

import Module, { type ManifoldToplevel } from 'manifold-3d';
import { pathToFileURL } from 'node:url';
import { checkFit, placeDesign } from '../shared/fit.ts';
import { computeBounds } from '../shared/transform.ts';
import type { DesignParam, DesignReport, OverhangSpot, ParamValues } from '../shared/types.ts';
import { createContext, normaliseParams, resolveParams, type DesignInput, type Manifold } from './potlib.ts';

let wasm: Promise<ManifoldToplevel> | null = null;
function loadWasm(): Promise<ManifoldToplevel> {
  wasm ??= Module().then((w) => {
    w.setup();
    return w;
  });
  return wasm;
}

export interface BuildOutput {
  /** Triangle soup in the design frame (+Z up), ready to write as STL. */
  positions: Float32Array;
  report: DesignReport;
  paramSpec: Record<string, DesignParam>;
  params: ParamValues;
}

/** Where `script` errors point: the first stack line in the design script itself. */
function locate(e: Error, scriptUrl: string): string {
  const line = (e.stack ?? '').split('\n').find((l) => l.includes(scriptUrl));
  const m = line && /:(\d+):(\d+)\)?$/.exec(line);
  return m ? ` (design script line ${m[1]})` : '';
}

const SIDES = ['right (+x)', 'back-right', 'back (+y)', 'back-left', 'left (-x)', 'front-left', 'front (-y)', 'front-right'];

/** Downward-facing surface steeper than 45° from vertical, grouped by height and side. */
export function overhangs(positions: Float32Array, baseZ: number): { area: number; spots: OverhangSpot[] } {
  const bins = new Map<string, OverhangSpot>();
  let total = 0;
  for (let t = 0; t + 8 < positions.length; t += 9) {
    const ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
    const bx = positions[t + 3], by = positions[t + 4], bz = positions[t + 5];
    const cx = positions[t + 6], cy = positions[t + 7], cz = positions[t + 8];
    if (Math.max(az, bz, cz) < baseZ + 0.05) continue; // on the bed
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l === 0 || nz / l > -Math.SQRT1_2) continue;
    const area = l / 2;
    total += area;
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    const side = Math.hypot(mx, my) < 2 ? 'centre' : SIDES[Math.round(((Math.atan2(my, mx) / (2 * Math.PI)) * 8 + 8)) % 8];
    const band = Math.floor(mz / 5);
    const key = `${band}:${side}`;
    const spot = bins.get(key) ?? { area: 0, zMin: Infinity, zMax: -Infinity, side };
    spot.area += area;
    spot.zMin = Math.min(spot.zMin, az, bz, cz);
    spot.zMax = Math.max(spot.zMax, az, bz, cz);
    bins.set(key, spot);
  }
  const spots = [...bins.values()].filter((s) => s.area >= 2).sort((a, b) => b.area - a.area).slice(0, 8);
  return { area: total, spots };
}

export async function buildDesign(scriptPath: string, input: DesignInput): Promise<BuildOutput> {
  const started = performance.now();
  const w = await loadWasm();
  const url = pathToFileURL(scriptPath).href;
  let mod: Record<string, unknown>;
  try {
    // A query string makes repeated builds in one process see edits.
    mod = await import(`${url}?v=${Date.now()}`);
  } catch (e) {
    throw new Error(`Could not load the design script: ${(e as Error).message}`);
  }
  const fn = (mod.default ?? mod.design) as unknown;
  if (typeof fn !== 'function') throw new Error('The design script must `export default function design(ctx) { ... }`');
  const paramSpec = normaliseParams(mod.params);
  const params = resolveParams(paramSpec, input.params);
  const { context, notes, asManifold } = createContext(w, input, params);

  let result: Manifold;
  try {
    const out = await fn(context);
    if (!out) throw new Error('the design function returned nothing; return the finished Manifold');
    result = asManifold(out as Manifold | Manifold[]);
    if (typeof (result as { getMesh?: unknown }).getMesh !== 'function') throw new Error('the design function must return a Manifold');
  } catch (e) {
    const err = e as Error;
    throw new Error(`The design script failed: ${err.message ?? err}${err instanceof Error ? locate(err, url) : ''}`);
  }
  const status = result.status();
  if (status !== 'NoError') throw new Error(`The design is not a valid solid (${status})`);
  if (result.isEmpty()) throw new Error('The design is empty');

  const mesh = result.getMesh();
  const { numProp, vertProperties: vp, triVerts } = mesh;
  const positions = new Float32Array(triVerts.length * 3);
  for (let i = 0; i < triVerts.length; i++) {
    const v = triVerts[i] * numProp;
    positions[i * 3] = vp[v];
    positions[i * 3 + 1] = vp[v + 1];
    positions[i * 3 + 2] = vp[v + 2];
  }
  const b = computeBounds(positions);
  const components = result.decompose().length;
  const oh = overhangs(positions, b.min.z);
  const fitSettings = { referenceId: null, scaleMode: 'uniform' as const, ...input.fit };
  const placement = placeDesign(positions, input.reference, fitSettings, b);
  const metrics = checkFit(positions, placement, input.reference, fitSettings, b);

  const warnings: string[] = [];
  if (components > 1) warnings.push(`The design is ${components} separate pieces; something is floating or only touching. Join every part to the pot.`);
  if (Math.abs(b.min.z) > 0.01) warnings.push(`The lowest point is at z = ${b.min.z.toFixed(2)}; the base should sit on z = 0.`);
  if (oh.area > 25) warnings.push(`About ${Math.round(oh.area)} mm² overhangs more than 45° and would need supports (see overhangs).`);
  if (metrics.interferes) warnings.push('The nursery pot passes through the design.');
  else if (!metrics.clearanceOk) warnings.push(`The narrowest gap is ${metrics.minRadialGap.toFixed(2)} mm; the clearance needs ${metrics.requiredRadialGap.toFixed(2)} mm.`);
  if (input.fit.topOffset !== null && Math.abs(metrics.topOffset - input.fit.topOffset) > 0.5) {
    warnings.push(`The nursery pot's rim stands ${metrics.topOffset.toFixed(2)} mm above the rim; the goal is ${input.fit.topOffset} mm.`);
  }
  if (metrics.floorGap !== null && Math.abs(metrics.floorGap - input.fit.floorGap) > 0.5) {
    warnings.push(`The gap under the nursery pot is ${metrics.floorGap.toFixed(2)} mm; the goal is ${input.fit.floorGap} mm.`);
  }
  if (metrics.wallThickness && metrics.wallThickness.min < 1.2) warnings.push(`The thinnest wall is ${metrics.wallThickness.min.toFixed(2)} mm; aim for at least 1.6 mm.`);
  if (metrics.floorThickness !== null && metrics.floorThickness < 1) warnings.push(`The floor is ${metrics.floorThickness.toFixed(2)} mm thick.`);
  const size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
  if (Math.max(size.x, size.y, size.z) > 250) warnings.push(`At ${Math.round(Math.max(size.x, size.y, size.z))} mm it may not fit a typical printer.`);

  return {
    positions,
    paramSpec,
    params,
    report: {
      triangles: positions.length / 9,
      size,
      minZ: b.min.z,
      volume: result.volume() / 1000,
      components,
      overhangArea: oh.area,
      overhangs: oh.spots,
      placement,
      metrics,
      notes,
      warnings,
      buildMs: Math.round(performance.now() - started),
    },
  };
}

const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? 'n/a' : Number.isFinite(v) ? v.toFixed(d) : String(v));

/** The report as text for pot-tool. */
export function formatReport(out: BuildOutput): string {
  const r = out.report;
  const m = r.metrics;
  const lines = [
    `built in ${r.buildMs} ms: ${r.triangles} triangles, ${r.components} piece${r.components === 1 ? '' : 's'}`,
    `size                  ${f(r.size.x)} x ${f(r.size.y)} mm, ${f(r.size.z)} mm tall (lowest z ${f(r.minZ, 2)})`,
    `material              ${f(r.volume, 1)} cm³ (about ${f(r.volume * 1.24, 0)} g of PLA if solid)`,
    `overhang over 45°     ${f(r.overhangArea, 0)} mm²${r.overhangs.length ? '' : ' (none worth supporting)'}`,
    ...r.overhangs.map((s) => `  ${f(s.area, 0).padStart(6)} mm² at z ${f(s.zMin)}..${f(s.zMax)}, ${s.side}`),
  ];
  if (m) {
    lines.push(
      `nursery pot           rim ${f(m.topOffset, 2)} mm above the design's rim, gap under it ${f(m.floorGap, 2)} mm`,
      `radial gap            min ${f(m.minRadialGap, 2)} mm at y=${f(m.minRadialGapAt)} (needs ${f(m.requiredRadialGap, 2)}), ${m.interferes ? 'INTERFERES' : m.clearanceOk ? 'clear' : 'TOO TIGHT'}`,
      `wall / floor          ${m.wallThickness ? `thinnest ${f(m.wallThickness.min, 2)} mm, median ${f(m.wallThickness.median, 2)} mm` : 'n/a'}; floor ${f(m.floorThickness, 2)} mm`,
    );
  }
  const params = Object.entries(out.params);
  if (params.length) lines.push('', 'params', ...params.map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`));
  if (r.notes.length) lines.push('', 'notes', ...r.notes.map((n) => `  ${n}`));
  if (r.warnings.length) lines.push('', 'warnings', ...r.warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}
