#!/usr/bin/env node
// pot-tool: measuring and fitting helpers for the Codex fit agent (and humans).
// Run `node tools/pot-tool.ts help` for usage.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeMesh, checkFit, placeDesign, solveFit, type ReferenceDims } from '../shared/fit.ts';
import { parseSTL, writeBinarySTL } from '../shared/stl.ts';
import { anchorFor, applyMatrix, applyTransform, computeBounds, invertMatrix, reanchor, transformMatrix, validateTransform, yUpToZUp, zUpToYUp, type Bounds } from '../shared/transform.ts';
import { DEFAULT_FIT, type FitMetrics, type FitSettings, type ParamValues, type PotTransform, type ScaleMode, type UpAxis } from '../shared/types.ts';
import { buildDesign, formatReport } from './design-build.ts';
import { renderViews, type ViewAngle } from './render3d.ts';
import { renderSection } from './section-png.ts';

const USAGE = `pot-tool <command> [options]

Commands
  analyze   Orientation candidates, cavity profile and dimensions of the mesh at scale 1
  solve     Deterministic fit: scale and place the pot around the reference pot
  check     Measure a transform against the reference pot (gaps, rim offset, floor)
  render    Draw a side-on section of a transform as a PNG
  place     Write the mesh as placed by a transform, in the pot frame, for editing (Blender)
  unplace   Turn an edited placed mesh back into the raw coordinates of mesh.stl, and
            print the transform that puts it back where it was edited
  build     Design workspaces: run the design script and report on the result
  preview   Design workspaces: shaded views of the last build, and its section

Inputs default to ./state.json, which holds the mesh path, reference pot, fit
settings and the transform currently shown in the app. When state.json has
"placed": true (a review workspace), the mesh is already in the pot frame and
check and render measure it as it is. In a design workspace ("frame":
"design") the mesh is the last build, and check and render place it the way
the app will: scale 1, the reference pot lowered into the cavity.

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
  --out <path>           render/preview: output PNG (default section.png / out/preview.png);
                         build: output directory (default state.design.out);
                         place: placed STL (default placed.stl); unplace: raw STL (default edited.stl)
  --in <file>            unplace: the edited placed STL
  --z-up                 place/unplace: the placed STL is Z up (Blender's frame: x, -z, y of the
                         pot frame), with the reference pot's base centre at the origin
  --script <file>        build: design script (default state.design.script)
  --params <json>        build: parameter values to try, over state.params
  --view <az,el>         preview: one large view from this azimuth and elevation (degrees)
  --json                 print JSON instead of text
`;

interface State {
  mesh?: string;
  /** The mesh is already placed in the pot frame (review workspaces). */
  placed?: boolean;
  /** The mesh is a design build: +Z up, the pot's axis on x = y = 0 (design workspaces). */
  frame?: 'design';
  design?: { script: string; out: string };
  params?: ParamValues;
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
    script: { type: 'string' },
    params: { type: 'string' },
    view: { type: 'string' },
    in: { type: 'string' },
    'z-up': { type: 'boolean', default: false },
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
const here = (p: string) => resolve(dirname(statePath), p);

// Loaded on first use: build runs before there is a mesh.
let mesh: { positions: Float32Array; raw: Bounds } | null = null;
function loadMesh() {
  if (!mesh) {
    const path = values.mesh ? resolve(values.mesh) : state.mesh ? here(state.mesh) : fail('no mesh: pass --mesh or provide state.json');
    if (!existsSync(path)) fail(`${path} does not exist${state.frame === 'design' ? '; run ./pot-tool build first' : ''}`);
    const positions = parseSTL(readFileSync(path));
    mesh = { positions, raw: computeBounds(positions) };
  }
  return mesh;
}

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

/** The transform that leaves a mesh where it is: +Y up, scale 1, anchor unchanged. */
function asPlaced(): PotTransform {
  return { up: '+Y', spin: 0, position: anchorFor(loadMesh().raw, '+Y'), scale: { x: 1, y: 1, z: 1 } };
}

function defaultTransform(): unknown {
  if (state.placed) return asPlaced();
  if (state.frame === 'design') return placeDesign(loadMesh().positions, reference(), fitSettings(), loadMesh().raw);
  return state.transform;
}

function transformArg(): PotTransform {
  let t: unknown = defaultTransform();
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
    `wall thickness        ${m.wallThickness ? `thinnest ${f2(m.wallThickness.min)} mm at y=${f2(m.wallThickness.at, 1)}, median ${f2(m.wallThickness.median)} mm (measured horizontally)` : 'n/a'}`,
    `floor thickness       ${f2(m.floorThickness)} mm`,
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

/** Build the design script into outDir/design.stl and report.json. */
async function runBuild(script: string, outDir: string, params: ParamValues) {
  const fit = fitSettings();
  let result;
  try {
    const parts = join(dirname(script), 'parts');
    result = await buildDesign(script, {
      reference: reference(),
      fit: { clearance: fit.clearance, topOffset: fit.topOffset, floorGap: fit.floorGap },
      params,
      partsDir: existsSync(parts) ? parts : null,
    });
  } catch (e) {
    fail((e as Error).message);
  }
  mkdirSync(outDir, { recursive: true });
  const stl = join(outDir, 'design.stl');
  writeFileSync(stl, writeBinarySTL(result.positions, 'potfit design'));
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ report: result.report, paramSpec: result.paramSpec, params: result.params }, null, 2));
  return { result, stl };
}

// In a design workspace, measuring or previewing a stale build would show the
// old design, so rebuild first when the script is newer than the last build.
if (state.frame === 'design' && state.design && !values.mesh && ['analyze', 'solve', 'check', 'render', 'preview'].includes(command)) {
  const script = here(state.design.script);
  const stl = here(join(state.design.out, 'design.stl'));
  if (existsSync(script) && (!existsSync(stl) || statSync(stl).mtimeMs < statSync(script).mtimeMs)) {
    process.stderr.write(`${state.design.script} has changed since the last build; building it first.\n\n`);
    const { result } = await runBuild(script, here(state.design.out), state.params ?? {});
    process.stderr.write(`${formatReport(result)}\n\n`);
  }
}

switch (command) {
  case 'analyze': {
    const { positions } = loadMesh();
    const a = analyzeMesh(positions, state.frame === 'design' ? '+Z' : state.transform?.up);
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
    const { positions, raw } = loadMesh();
    if (state.placed) process.stderr.write('note: this mesh is already placed, so solve reports scales relative to the current fit\n');
    const up = (values.up ?? state.transform?.up ?? (state.frame === 'design' ? '+Z' : analyzeMesh(positions).suggestedUp)) as UpAxis;
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
    const { positions, raw } = loadMesh();
    const metrics = checkFit(positions, t, reference(), fit, raw);
    out(metrics, `transform ${formatTransform(t)}\n\n${formatMetrics(metrics, fit)}`);
    break;
  }
  case 'render': {
    const fit = fitSettings();
    const t = transformArg();
    const angle = num(values.angle, 'angle') ?? 0;
    const file = resolve(values.out ?? 'section.png');
    const { positions, raw } = loadMesh();
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
  case 'place': {
    const t = transformArg();
    const { positions, raw } = loadMesh();
    const placed = applyTransform(positions, t, raw);
    const file = resolve(values.out ?? 'placed.stl');
    writeFileSync(file, writeBinarySTL(values['z-up'] ? yUpToZUp(placed) : placed, 'potfit placed'));
    const b = computeBounds(placed);
    const ref = state.reference;
    const up = values['z-up'] ? 'z' : 'y';
    out(
      { file, transform: t, zUp: values['z-up'], bounds: values['z-up'] ? computeBounds(yUpToZUp(placed)) : b },
      [
        `wrote ${file}: ${positions.length / 9} triangles placed by ${formatTransform(t)}`,
        `frame: mm, ${up} up, the reference pot's base centre at the origin and its axis along +${up}${ref ? ` (it reaches ${up} = ${f2(ref.height)})` : ''}`,
        `the outer pot spans ${up} ${f2(b.min.y)} .. ${f2(b.max.y)}`,
        `after editing, turn it back with: ./pot-tool unplace --in <edited.stl> --out edited.stl${values['z-up'] ? ' --z-up' : ''}${values.transform ? " --transform '<the same transform>'" : ''}`,
      ].join('\n'),
    );
    break;
  }
  case 'unplace': {
    if (state.placed || state.frame === 'design') fail('unplace is for fit workspaces; here the mesh is already in its working frame');
    if (!values.in) fail('pass the edited placed STL with --in');
    const t = transformArg();
    const { raw } = loadMesh();
    let placed = parseSTL(readFileSync(resolve(values.in)));
    if (placed.length === 0) fail(`${values.in} has no triangles`);
    if (values['z-up']) placed = zUpToYUp(placed);
    const edited = applyMatrix(placed, invertMatrix(transformMatrix(t, raw)));
    const file = resolve(values.out ?? 'edited.stl');
    writeFileSync(file, writeBinarySTL(edited, 'potfit edited'));
    const placeIt = reanchor(t, raw, computeBounds(edited));
    out(
      { file, triangles: edited.length / 9, transform: placeIt },
      [
        `wrote ${file}: ${edited.length / 9} triangles in mesh.stl's raw coordinates`,
        `transform that places it where you edited it: ${formatTransform(placeIt)}`,
        `check it: ./pot-tool check --mesh ${relative(process.cwd(), file) || file} --transform '${formatTransform(placeIt)}'`,
      ].join('\n'),
    );
    break;
  }
  case 'build': {
    const d = state.design ?? fail('state.json has no design section; build only works in a design workspace');
    const script = values.script ? resolve(values.script) : here(d.script);
    const outDir = values.out ? resolve(values.out) : here(d.out);
    let params: ParamValues = state.params ?? {};
    if (values.params) {
      try {
        params = { ...params, ...JSON.parse(values.params) };
      } catch {
        fail('--params must be a JSON object');
      }
    }
    const { result, stl } = await runBuild(script, outDir, params);
    out(
      { report: result.report, paramSpec: result.paramSpec, params: result.params, stl },
      `${formatReport(result)}\n\nwrote ${relative(process.cwd(), stl) || stl}; look at it with ./pot-tool preview`,
    );
    break;
  }
  case 'preview': {
    const { positions, raw } = loadMesh();
    const file = resolve(values.out ?? (state.design ? here(join(state.design.out, 'preview.png')) : 'preview.png'));
    let views: ViewAngle[] | undefined;
    if (values.view) {
      const [azimuth, elevation] = values.view.split(',').map(Number);
      if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) fail('--view must be azimuth,elevation in degrees');
      views = [{ azimuth, elevation }];
    }
    const img = renderViews(positions, views ? { views, tile: 900, columns: 1 } : {});
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, img.png);
    const lines = [
      `wrote ${file} (${img.width}x${img.height} px)`,
      views
        ? `one view from azimuth ${views[0].azimuth}°, elevation ${views[0].elevation}° (azimuth 0 looks at the front from -y, -90 at the right side from +x)`
        : 'top left: front (from -y); top right: right side (from +x); bottom left: three-quarter from front right, above; bottom right: top down, front at the bottom.',
    ];
    if (!views && state.reference) {
      const fit = fitSettings();
      const t = transformArg();
      const sectionFile = join(dirname(file), 'section.png');
      writeFileSync(sectionFile, renderSection(applyTransform(positions, t, raw), state.reference, { radialClear: fit.clearance / 2 }).png);
      lines.push(`wrote ${sectionFile}: side-on section through the front and back with the nursery pot (red) and required clearance (dashed orange)`);
    }
    out({ file }, lines.join('\n'));
    break;
  }
  default:
    fail(`unknown command ${command}\n\n${USAGE}`);
}
