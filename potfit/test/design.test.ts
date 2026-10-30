import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkFit, placeDesign } from '../shared/fit.ts';
import { parseSTL } from '../shared/stl.ts';
import { DEFAULT_FIT, type ReferencePot } from '../shared/types.ts';
import { buildDesign, overhangs } from '../tools/design-build.ts';
import { normaliseParams, resolveParams, type DesignInput } from '../tools/potlib.ts';
import { renderViews } from '../tools/render3d.ts';
import { parseDesignResult } from '../server/codex.ts';
import { BuildError, Designs } from '../server/design.ts';
import { Store } from '../server/store.ts';

const near = (a: number, b: number, eps: number, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} not within ${eps} of ${b}`);

const root = resolve(import.meta.dirname, '..');
const starter = join(root, 'tools', 'starter-design.mjs');
const dir = mkdtempSync(join(tmpdir(), 'potfit-design-'));
const script = (name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
};
const input = (over: Partial<DesignInput['fit']> = {}, params = {}): DesignInput => ({
  reference: { name: '6cm', topOD: 60, bottomOD: 40, height: 55 },
  fit: { clearance: 5, topOffset: 8, floorGap: 0, ...over },
  params,
});

test('the starter design fits its nursery pot exactly at scale 1', async () => {
  for (const fit of [{}, { floorGap: 2, topOffset: -3 }, { clearance: 2, topOffset: null }]) {
    const out = await buildDesign(starter, input(fit));
    const r = out.report;
    const goals = { ...input().fit, ...fit };
    assert.equal(r.components, 1);
    assert.deepEqual(r.warnings, []);
    near(r.minZ, 0, 1e-6, 'base');
    const m = r.metrics!;
    assert.ok(m.clearanceOk && !m.interferes, 'clears the nursery pot');
    near(m.minRadialGap, goals.clearance / 2, 0.02, 'gap');
    near(m.topOffset, goals.topOffset ?? 0, 0.05, 'rim offset');
    near(m.floorGap!, goals.floorGap, 0.06, 'floor gap');
    near(m.floorThickness!, 2.4, 0.06, 'floor');
    // The placement sits the nursery pot's base at the origin: floor + gap below it.
    near(r.placement.position.y, -(2.4 + goals.floorGap), 0.06, 'placement');
    assert.equal(r.placement.scale.x, 1);
  }
});

test('params are checked, clamped and defaulted', () => {
  const spec = normaliseParams({
    wall: { value: 3, min: 1.6, max: 8, label: 'Wall', unit: 'mm' },
    feet: true,
    face: { value: 'smile', options: ['smile', 'sleepy'] },
  });
  assert.equal(spec.wall.type, 'number');
  assert.equal(spec.feet.type, 'boolean');
  assert.equal(spec.feet.label, 'feet');
  assert.deepEqual(resolveParams(spec, { wall: 20, feet: 'yes', face: 'grumpy', other: 1 }), { wall: 8, feet: true, face: 'smile' });
  assert.deepEqual(resolveParams(spec, { wall: 2, feet: false, face: 'sleepy' }), { wall: 2, feet: false, face: 'sleepy' });
  assert.throws(() => normaliseParams({ 'bad name': 1 }), /identifier/);
  assert.throws(() => normaliseParams({ x: { value: 'a' } }), /options/);
});

test('the toolkit builds twisted, sculpted and decorated pots as one solid', async () => {
  const file = script(
    'kitchen-sink.mjs',
    `export const params = { twist: { value: 40, min: 0, max: 90 } };
export default function design({ pot, lib, sdf, params: p, note }) {
  const L = pot.layout({ floor: 2.4 });
  const top = L.rimZ;
  const R = lib.interp([[0, L.cavityRadius(0) + 4], [top / 2, L.cavityRadius(top / 2) + 7], [top, L.cavityRadius(top) + 3.5]]);
  const hex = lib.shapes.polygon(6, 0.3);
  const ribs = lib.shapes.ribs(24, -0.6);
  const tw = (z) => (p.twist * Math.PI / 180) * z / top;
  let body = lib.radial({ z1: top, radius: (a, z) => R(z) / hex(Math.PI / 6) * hex(a - tw(z)) + ribs(a - tw(z)) });
  // Each part starts inside the wall (between the cavity and the outside) so it joins the body.
  const inWall = (a, z) => [Math.cos(a) * (L.cavityRadius(z) + 2), Math.sin(a) * (L.cavityRadius(z) + 2), z];
  const out = (a, z, d) => [Math.cos(a) * (L.cavityRadius(z) + d), Math.sin(a) * (L.cavityRadius(z) + d), z];
  const arm = sdf.tube([inWall(-2.2, 30), out(-2.0, 22, 12), out(-1.8, 16, 11)], 3.5, 2);
  body = body.add(lib.fromSDF(arm, { min: [-40, -45, 8], max: [10, 0, 38] }, 0.8));
  body = body.add(lib.symmetric(lib.capsule(inWall(-1.2, 12), out(-1.3, 12, 9), 3)));
  body = body.subtract(lib.symmetric(lib.sphere(out(-1.35, 34, 7.2), 1.6)));
  note('kitchen sink');
  return lib.trimBase(body.subtract(L.cavity()).subtract(L.drainHoles({ count: 3 })));
}`,
  );
  const out = await buildDesign(file, input());
  assert.equal(out.report.components, 1);
  assert.deepEqual(out.report.notes, ['kitchen sink']);
  assert.deepEqual(out.params, { twist: 40 });
  assert.ok(out.report.metrics!.clearanceOk);
  near(out.report.minZ, 0, 1e-6);
  // The written mesh is what was measured.
  const placed = placeDesign(out.positions, input().reference, { clearance: 5, floorGap: 0 });
  assert.deepEqual(placed, out.report.placement);
});

test('a nursery pot wider at its base gets a cavity it can go into', async () => {
  const inp = { ...input(), reference: { name: 'odd', topOD: 40, bottomOD: 60, height: 50 } };
  const out = await buildDesign(starter, inp);
  const m = checkFit(out.positions, out.report.placement, inp.reference, { ...DEFAULT_FIT, clearance: 5, topOffset: 8 });
  assert.ok(m.clearanceOk && !m.interferes);
  near(m.dropToContact, 0, 0.1, 'resting on the floor');
});

test('script mistakes come back as readable errors', async () => {
  await assert.rejects(buildDesign(script('no-default.mjs', 'export const x = 1;'), input()), /export default function/);
  await assert.rejects(buildDesign(script('empty.mjs', 'export default ({ M }) => M.cube([5, 5, 5]).subtract(M.cube([9, 9, 9]))'), input()), /empty/);
  await assert.rejects(
    buildDesign(script('throws.mjs', 'export default function d() {\n  const a = 1;\n  throw new Error("boom");\n}'), input()),
    /The design script failed: boom \(design script line 3\)/,
  );
  await assert.rejects(buildDesign(script('syntax.mjs', 'export default function ( {'), input()), /Could not load the design script/);
});

test('overhangs are found by height and side', async () => {
  // A 10 mm post under a 30 mm disc: the disc's underside overhangs.
  const file = script('mushroom.mjs', 'export default ({ M }) => M.cylinder(10, 5, 5, 64).add(M.cylinder(3, 15, 15, 64).translate([0, -10, 10]))');
  const out = await buildDesign(file, input());
  const oh = overhangs(out.positions, 0);
  const underside = Math.PI * 15 * 15 - Math.PI * 5 * 5;
  near(oh.area, underside, underside * 0.02, 'area');
  assert.ok(oh.spots.every((s) => s.zMin >= 9.99 && s.zMax <= 10.01));
  assert.ok(oh.spots.some((s) => s.side.startsWith('front')), 'the disc is offset to the front');
});

test('preview renders shaded views', async () => {
  const out = await buildDesign(starter, input());
  const img = renderViews(out.positions, { tile: 120 });
  assert.equal(img.width, 244);
  assert.equal(img.height, 244);
  assert.deepEqual([...img.png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
});

test('design answers are parsed leniently', () => {
  const r = parseDesignResult(JSON.stringify({ title: '  Reading buddy ', summary: 's', warnings: ['w'], confidence: 'low' }));
  assert.deepEqual(r, { title: 'Reading buddy', summary: 's', warnings: ['w'], confidence: 'low' });
  assert.equal(parseDesignResult('{"summary": "x"}').confidence, 'medium');
});

test('the server builds scripts in a locked-down process', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'potfit-store-')));
  await store.init();
  const designs = new Designs(store, { root, toolPath: join(root, 'tools', 'pot-tool.ts') });
  const ref = await store.createReference({ name: '6cm', topOD: 60, bottomOD: 40, height: 55, notes: '' });
  const fit = { ...DEFAULT_FIT, referenceId: ref.id, topOffset: 8 };
  const model = await designs.create({ name: 'Test', description: 'plain', images: [{ name: 'a', ext: 'png', data: Buffer.from('x') }], fit, ref: ref as ReferencePot });
  assert.deepEqual(model.design!.images, ['ref-1.png']);
  assert.equal(parseSTL(readFileSync(store.meshFile(model.id))).length / 9, model.triangleCount);

  const rebuilt = await designs.rebuild(model.id, { params: { holes: 3, wall: 99 } });
  assert.equal(rebuilt.design!.params.holes, 3);
  assert.equal(rebuilt.design!.params.wall, 10, 'clamped to the max');
  assert.ok(rebuilt.triangleCount > model.triangleCount);

  // The script can't read outside what it is given, write anywhere, or spawn.
  const snoop = `import { readFileSync, writeFileSync } from 'node:fs';
export default function d({ M, note }) {
  for (const f of ['/etc/hostname', ${JSON.stringify(store.meshFile(model.id))}]) {
    try { readFileSync(f); note('read ' + f); } catch (e) { note(e.code); }
  }
  try { writeFileSync(${JSON.stringify(join(dir, 'escaped'))}, 'x'); note('wrote'); } catch (e) { note(e.code); }
  return M.cube([10, 10, 10]);
}`;
  const snooped = await designs.rebuild(model.id, { script: snoop });
  assert.deepEqual(snooped.design!.report!.notes, ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);

  // A script that doesn't build is refused and the old one stays.
  const before = await designs.readScript(model.id);
  await assert.rejects(designs.rebuild(model.id, { script: 'export default () => null' }), BuildError);
  assert.equal(await designs.readScript(model.id), before);
});
