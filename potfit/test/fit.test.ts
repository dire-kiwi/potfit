import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeMesh, checkFit, initialTransform, solveFit } from '../shared/fit.ts';
import { gridFor, sliceProfile } from '../shared/profile.ts';
import { parseSTL } from '../shared/stl.ts';
import { DEFAULT_FIT, type FitSettings } from '../shared/types.ts';
import { innerRadius, latheY, translate, yToZ, type PotSpec } from './helpers.ts';
import { renderSection } from '../tools/section-png.ts';
import { applyTransform } from '../shared/transform.ts';

const near = (a: number, b: number, eps: number, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} not within ${eps} of ${b}`);

const spec: PotSpec = { r0: 22, r1: 30, h: 50, wall: 2, floor: 3 };
// Off-centre and Z-up, like a model exported from a CAD tool.
const pot = translate(yToZ(latheY(spec)), 12, -7, 4);

// A reference that fits this cavity exactly with 4 mm diametral clearance and a flush rim.
const clearance = 4;
const H = spec.h - spec.floor;
const ref = { bottomOD: 2 * (innerRadius(spec, spec.floor) - clearance / 2), topOD: 2 * (innerRadius(spec, spec.h) - clearance / 2), height: H };
const fit = (over: Partial<FitSettings> = {}): FitSettings => ({ ...DEFAULT_FIT, clearance, topOffset: 0, floorGap: 0, ...over });

test('slicing finds the cavity radius and the floor', () => {
  const p = sliceProfile(latheY(spec), gridFor(0, spec.h, 0.5));
  for (let i = 0; i < p.n; i++) {
    const y = p.heights[i];
    if (y < spec.floor - 0.01) assert.equal(p.cavity[i], 0, `solid floor at ${y}`);
    else if (y > spec.floor + 0.01) near(p.cavity[i], innerRadius(spec, y), 0.01, `cavity at ${y}`);
  }
});

test('analysis finds the up axis, cavity axis and floor', () => {
  const a = analyzeMesh(pot);
  assert.equal(a.suggestedUp, '+Z');
  near(a.height, spec.h, 1e-3, 'height');
  near(a.floorTop!, spec.floor, 0.15, 'floor');
  near(a.maxCavityDiameter, 2 * innerRadius(spec, spec.h), 0.1, 'rim cavity');
  near(a.cavityCenter!.x, 0, 0.01, 'centre x');
  near(a.cavityCenter!.z, 0, 0.01, 'centre z');
  // Upside down, the opening is at -Z.
  const flipped = new Float32Array(pot);
  for (let i = 2; i < flipped.length; i += 3) flipped[i] = -flipped[i];
  assert.equal(analyzeMesh(flipped).suggestedUp, '-Z');
});

test('initial transform stands the pot on the reference base', () => {
  const a = analyzeMesh(pot);
  const m = checkFit(pot, initialTransform(pot, a), ref, fit());
  near(m.floorGap!, 0, 0.15, 'floor gap');
  near(m.cavityCenterOffset!.x, 0, 0.01);
  near(m.cavityCenterOffset!.z, 0, 0.01);
});

test('solver recovers scale 1 for a pot designed around the reference', () => {
  for (const mode of ['uniform', 'radial-height'] as const) {
    const r = solveFit(pot, ref, { up: '+Z', spin: 0, mode, clearance, topOffset: 0, floorGap: 0 });
    near(r.radialScale, 1, 0.005, `${mode} radial`);
    near(r.heightScale, 1, 0.005, `${mode} height`);
    const m = checkFit(pot, r.transform, ref, fit({ scaleMode: mode }));
    assert.ok(m.clearanceOk, `${mode}: ${m.warnings.join('; ')}`);
    assert.ok(!m.interferes);
    near(m.minRadialGap, clearance / 2, 0.05, `${mode} gap`);
    near(m.topOffset, 0, 0.1, `${mode} rim`);
    near(m.floorGap!, 0, 0.15, `${mode} floor`);
  }
});

test('solver scales up for a bigger reference and honours the goals', () => {
  const big = { bottomOD: ref.bottomOD * 1.3, topOD: ref.topOD * 1.3, height: ref.height * 1.1 };
  const r = solveFit(pot, big, { up: '+Z', spin: 0, mode: 'radial-height', clearance: 5, topOffset: 6, floorGap: 1.5 });
  const m = checkFit(pot, r.transform, big, fit({ clearance: 5, topOffset: 6, floorGap: 1.5, scaleMode: 'radial-height' }));
  assert.ok(r.radialScale > 1.25 && r.heightScale > 1, `${r.radialScale} ${r.heightScale}`);
  near(m.topOffset, 6, 0.15, 'rim');
  near(m.floorGap!, 1.5, 0.2, 'floor gap');
  assert.ok(m.clearanceOk, m.warnings.join('; '));
  near(m.minRadialGap, 2.5, 0.05, 'gap');

  // Uniform with no rim target: smallest scale that still reaches the floor.
  const u = solveFit(pot, big, { up: '+Z', spin: 0, mode: 'uniform', clearance: 5, topOffset: null, floorGap: 0 });
  const mu = checkFit(pot, u.transform, big, fit({ clearance: 5, topOffset: null }));
  assert.ok(mu.clearanceOk, mu.warnings.join('; '));
  near(mu.floorGap!, 0, 0.15, 'uniform floor');
  near(mu.minRadialGap, 2.5, 0.05, 'uniform gap');
});

test('a drainage hole still counts as the floor', () => {
  const holed = latheY({ ...spec, hole: 5 });
  const a = analyzeMesh(holed);
  near(a.floorTop!, spec.floor, 0.15, 'floor');
  const r = solveFit(holed, ref, { up: '+Y', spin: 0, mode: 'uniform', clearance, topOffset: 0, floorGap: 0 });
  near(r.radialScale, 1, 0.005);
});

test('check reports interference when the pot is too small', () => {
  const a = analyzeMesh(pot);
  const s = 0.8;
  const position = { x: -a.cavityCenter!.x * s, y: -a.floorTop! * s, z: -a.cavityCenter!.z * s };
  const m = checkFit(pot, { up: '+Z', spin: 0, position, scale: { x: s, y: s, z: s } }, ref, fit());
  assert.ok(m.interferes);
  assert.ok(!m.clearanceOk);
  assert.ok(m.minRadialGap < 0);
});

test('section render produces a PNG', () => {
  const img = renderSection(applyTransform(pot, initialTransform(pot, analyzeMesh(pot))), ref, { radialClear: 2, width: 300 });
  assert.deepEqual([...img.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(img.width, 300);
});

const v3 = new URL('../../cactus_pot_v3.stl', import.meta.url);
test('cactus pot v3 fits the 60/40 x 55 nursery pot it was designed for', { skip: !existsSync(v3) && 'cactus_pot_v3.stl not found' }, () => {
  // From cactus_pot.py: 5 mm diametral clearance, shortened 8 mm from the top.
  const positions = parseSTL(readFileSync(v3));
  const nursery = { topOD: 60, bottomOD: 40, height: 55 };
  const r = solveFit(positions, nursery, { up: '+Z', spin: 0, mode: 'radial-height', clearance: 5, topOffset: 8, floorGap: 0 });
  near(r.radialScale, 1, 0.003, 'radial');
  near(r.heightScale, 1, 0.003, 'height');
});
