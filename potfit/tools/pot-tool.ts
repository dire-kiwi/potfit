#!/usr/bin/env node
// pot-tool: measuring and fitting helpers for the Codex fit agent (and humans).
// Run `node tools/pot-tool.ts help` for usage.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeMesh, checkFit, solveFit, type ReferenceDims } from '../shared/fit.ts';
import { parseSTL } from '../shared/stl.ts';
import { applyTransform, computeBounds, validateTransform } from '../shared/transform.ts';
import { DEFAULT_FIT, type FitMetrics, type FitSettings, type PotTransform, type ScaleMode, type UpAxis } from '../shared/types.ts';
import { renderSection } from './section-png.ts';

const USAGE = `pot-tool <command> [options]

Commands
  analyze   Orientation candidates, cavity profile and dimensions of the mesh at scale 1
  solve     Deterministic fit: scale and place the pot around the reference pot
  check     Measure a transform against the reference pot (gaps, rim offset, floor)
  render    Draw a side-on section of a transform as a PNG

Inputs default to ./state.json, which holds the mesh path, reference pot, fit
settings and the transform currently shown in the app.

Options
  --state <file>         state file (default ./state.json)
  --mesh <file>          mesh STL (default: state.mesh)
  --transform <json|file> transform for check/render (default: state.transform)
  --up <axis>            solve: raw axis that points up (+X -X +Y -Y +Z -Z; default: state or analysis)
  --spin <deg>           solve: rotation about the vertical axis (default: state transform)
  --mode <m>             solve: uniform | radial-height (default: state.fit.scaleMode)
  --clearance <mm>       diametral clearance (default: state.fit.clearance)
  --top-offset <mm|none> reference rim height above the outer rim (default: state.fit.topOffset)
  --floor-gap <mm>       gap under the reference pot (default: state.fit.floorGap)
  --angle <deg>          render: section plane angle about the vertical axis (default 0)
  --out <file>           render: output PNG (default section.png)
  --json                 print JSON instead of text
`;

interface State {
  mesh?: string;
  reference?: (ReferenceDims & { name?: string }) | null;
  fit?: Partial<FitSettings>;
  transform?: PotTransform;
}

function fail(msg: string): never {
  process.stderr.write(`pot-tool: ${msg}\n`);
  process.exit(1);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: 'string' },
    mesh: { type: 'string' },
    transform: { type: 'string' },
    up: { type: 'string' },
    spin: { type: 'string' },
    mode: { type: 'string' },
    clearance: { type: 'string' },
    'top-offset': { type: 'string' },
    'floor-gap': { type: 'string' },
    angle: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? 'help';
if (values.help || command === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const statePath = resolve(values.state ?? 'state.json');
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const meshPath = values.mesh ? resolve(values.mesh) : state.mesh ? resolve(dirname(statePath), state.mesh) : fail('no mesh: pass --mesh or provide state.json');
const positions = parseSTL(readFileSync(meshPath));
const raw = computeBounds(positions);

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
};

function fitSettings(): FitSettings {
  const fit: FitSettings = { ...DEFAULT_FIT, ...state.fit };
  const clearance = num(values.clearance, 'clearance');
  if (clearance !== undefined) fit.clearance = clearance;
  const top = values['top-offset'];
  if (top !== undefined) fit.topOffset = top === 'none' || top === 'null' ? null : num(top, 'top-offset')!;
  const gap = num(values['floor-gap'], 'floor-gap');
  if (gap !== undefined) fit.floorGap = gap;
  if (values.mode !== undefined) {
    if (values.mode !== 'uniform' && values.mode !== 'radial-height') fail('--mode must be uniform or radial-height');
    fit.scaleMode = values.mode as ScaleMode;
  }
  return fit;
}

function reference(): ReferenceDims & { name?: string } {
  const ref = state.reference;
  if (!ref) fail('state.json has no reference pot');
  return ref;
}

function transformArg(): PotTransform {
  let t: unknown = state.transform;
  if (values.transform !== undefined) {
    const src = values.transform.trim();
    t = JSON.parse(src.startsWith('{') ? src : readFileSync(resolve(src), 'utf8'));
  }
  const err = validateTransform(t);
  if (err) fail(err);
  return t as PotTransform;
}

const f2 = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? 'n/a' : Number.isFinite(v) ? v.toFixed(digits) : v > 0 ? 'inf' : '-inf';

function formatTransform(t: PotTransform): string {
  return JSON.stringify(t, (_k, v) => (typeof v === 'number' ? Number(v.toFixed(5)) : v));
}

function formatMetrics(m: FitMetrics, fit: FitSettings): string {
  const lines = [
    `outer pot size        ${f2(m.size.x)} x ${f2(m.size.z)} wide, ${f2(m.size.y)} tall (y ${f2(m.potBottom)} .. ${f2(m.potTop)})`,
    `rim offset            ${f2(m.topOffset)} mm (reference rim above outer rim${fit.topOffset === null ? '' : `; target ${f2(fit.topOffset)}`})`,
    `floor                 top at y=${f2(m.floorTop)}, gap under reference ${f2(m.floorGap)} mm (target ${f2(fit.floorGap)})`,
    `radial gap            min ${f2(m.minRadialGap)} mm at y=${f2(m.minRadialGapAt, 1)}, base ${f2(m.bottomRadialGap)}, rim ${f2(m.rimRadialGap)}, required ${f2(m.requiredRadialGap)}`,
    `interferes            ${m.interferes ? 'YES' : 'no'}`,
    `clearance ok          ${m.clearanceOk ? 'yes' : 'NO'}`,
    `drop to contact       ${f2(m.dropToContact)} mm`,
    `enclosed fraction     ${f2(m.enclosedFraction, 3)}`,
    `cavity axis offset    ${m.cavityCenterOffset ? `x ${f2(m.cavityCenterOffset.x, 3)}, z ${f2(m.cavityCenterOffset.z, 3)}` : 'n/a'}`,
    '',
    '     y   cavity R    ref R      gap',
    ...m.profile.map((r) => `${f2(r.y, 1).padStart(6)} ${f2(r.cavityRadius).padStart(10)} ${f2(r.referenceRadius).padStart(8)} ${f2(r.gap).padStart(8)}`),
  ];
  if (m.warnings.length) lines.push('', 'warnings:', ...m.warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}

function out(json: unknown, text: string) {
  process.stdout.write(values.json ? JSON.stringify(json, null, 2) + '\n' : text + '\n');
}

switch (command) {
  case 'analyze': {
    const a = analyzeMesh(positions, state.transform?.up);
    const text = [
      `triangles             ${a.triangleCount}`,
      `raw bounds            x ${f2(a.rawBounds.min.x)}..${f2(a.rawBounds.max.x)}  y ${f2(a.rawBounds.min.y)}..${f2(a.rawBounds.max.y)}  z ${f2(a.rawBounds.min.z)}..${f2(a.rawBounds.max.z)}`,
      '',
      'up axis candidates (score favours a deep opening at the top and a round footprint)',
      ...a.candidates.map((c) => `  ${c.up}  height ${f2(c.height).padStart(8)}  footprint ${f2(c.width)} x ${f2(c.depth)}  cavity depth ${f2(c.cavityDepth).padStart(7)}  score ${f2(c.score, 3)}`),
      `suggested up          ${a.suggestedUp}`,
      '',
      `with ${a.suggestedUp} up, at scale 1 (heights from the pot's bottom):`,
      `height                ${f2(a.height)}`,
      `outer diameter        ${f2(a.outerDiameter)}`,
      `cavity axis           ${a.cavityCenter ? `x ${f2(a.cavityCenter.x, 3)}, z ${f2(a.cavityCenter.z, 3)} from the bounding-box centre` : 'n/a'}`,
      `floor top             ${f2(a.floorTop)}`,
      `cavity depth          ${f2(a.cavityDepth)}`,
      `cavity diameter       max ${f2(a.maxCavityDiameter)} at h=${f2(a.maxCavityAt, 1)}, rim ${f2(a.rimCavityDiameter)}, narrowest above max ${f2(a.minOpeningAboveMax)}`,
      '',
      '     h   cavity D   outer D',
      ...a.rows.map((r) => `${f2(r.h, 1).padStart(6)} ${f2(r.cavityDiameter).padStart(10)} ${f2(r.outerDiameter).padStart(9)}`),
      ...(a.warnings.length ? ['', 'warnings:', ...a.warnings.map((w) => `  - ${w}`)] : []),
    ].join('\n');
    out(a, text);
    break;
  }
  case 'solve': {
    const fit = fitSettings();
    const ref = reference();
    const up = (values.up ?? state.transform?.up ?? analyzeMesh(positions).suggestedUp) as UpAxis;
    if (!['+X', '-X', '+Y', '-Y', '+Z', '-Z'].includes(up)) fail('--up must be one of +X -X +Y -Y +Z -Z');
    const spin = num(values.spin, 'spin') ?? state.transform?.spin ?? 0;
    let result;
    try {
      result = solveFit(positions, ref, { up, spin, mode: fit.scaleMode, clearance: fit.clearance, topOffset: fit.topOffset, floorGap: fit.floorGap }, raw);
    } catch (e) {
      fail((e as Error).message);
    }
    const metrics = checkFit(positions, result.transform, ref, fit, raw);
    const text = [
      `mode ${fit.scaleMode}, clearance ${f2(fit.clearance)} mm, top offset ${fit.topOffset === null ? 'none (sit on floor, smallest scale)' : `${f2(fit.topOffset)} mm`}, floor gap ${f2(fit.floorGap)} mm`,
      `radial scale ${f2(result.radialScale, 5)}, height scale ${f2(result.heightScale, 5)}`,
      `cavity axis at x ${f2(result.cavityCenter.x, 3)}, z ${f2(result.cavityCenter.z, 3)} from the bounding-box centre; floor ${f2(result.floorTop)} above the bottom (scale 1)`,
      ...result.notes.map((n) => `note: ${n}`),
      '',
      `transform ${formatTransform(result.transform)}`,
      '',
      formatMetrics(metrics, fit),
    ].join('\n');
    out({ ...result, metrics }, text);
    break;
  }
  case 'check': {
    const fit = fitSettings();
    const t = transformArg();
    const metrics = checkFit(positions, t, reference(), fit, raw);
    out(metrics, `transform ${formatTransform(t)}\n\n${formatMetrics(metrics, fit)}`);
    break;
  }
  case 'render': {
    const fit = fitSettings();
    const t = transformArg();
    const angle = num(values.angle, 'angle') ?? 0;
    const file = resolve(values.out ?? 'section.png');
    const img = renderSection(applyTransform(positions, t, raw), state.reference ?? null, { angle, radialClear: fit.clearance / 2 });
    writeFileSync(file, img.png);
    const b = img.bounds;
    out(
      { file, ...img, png: undefined },
      [
        `wrote ${file} (${img.width}x${img.height} px, ${f2(img.pxPerMm)} px/mm, x ${f2(b.minX)}..${f2(b.maxX)}, y ${f2(b.minY)}..${f2(b.maxY)})`,
        'grey fill: outer pot cut faces; red: reference pot; dashed orange: required clearance; dashed blue: reference axis; light grid: 10 mm.',
      ].join('\n'),
    );
    break;
  }
  default:
    fail(`unknown command ${command}\n\n${USAGE}`);
}
