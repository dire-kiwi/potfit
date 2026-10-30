// Measuring an outer pot against a reference pot, and solving for a scale.

import {
  descentSeat,
  estimateCenter,
  findFloor,
  gridFor,
  maxCavity,
  rayIntersections,
  sliceProfile,
  sliceSegmentsAt,
  type Floor,
  type Frustum,
  type Profile,
} from './profile.ts';
import { anchorFor, applyTransform, computeBounds, type Bounds } from './transform.ts';
import {
  UP_AXES,
  type FitMetrics,
  type FitSettings,
  type PotTransform,
  type ProfileRow,
  type ScaleMode,
  type UpAxis,
} from './types.ts';

export interface ReferenceDims {
  topOD: number;
  bottomOD: number;
  height: number;
}

export function frustumOf(ref: ReferenceDims): Frustum {
  return { rb: ref.bottomOD / 2, rt: ref.topOD / 2, h: ref.height };
}

const radiusAt = (f: Frustum, y: number) => f.rb + ((f.rt - f.rb) * y) / f.h;

/** The model in the pot frame at scale 1 with its bounding-box bottom centre at the origin. */
function oriented(positions: Float32Array, raw: Bounds, up: UpAxis, spin: number): Float32Array {
  return applyTransform(positions, { up, spin, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, raw);
}

/** Heights spread through the cavity, for estimating its axis. */
function cavityHeights(floorTop: number, top: number, count = 5): number[] {
  const out: number[] = [];
  const lo = floorTop + (top - floorTop) * 0.15;
  const hi = floorTop + (top - floorTop) * 0.85;
  for (let k = 0; k < count; k++) out.push(lo + ((hi - lo) * k) / Math.max(1, count - 1));
  return out;
}

// ---------------------------------------------------------------- analysis

export interface OrientationCandidate {
  up: UpAxis;
  height: number;
  width: number;
  depth: number;
  /** Rim height minus floor height along the vertical axis. */
  cavityDepth: number;
  score: number;
}

export interface ProfileSummaryRow {
  /** Height above the pot's bottom. */
  h: number;
  cavityDiameter: number | null;
  outerDiameter: number | null;
}

export interface MeshAnalysis {
  triangleCount: number;
  rawBounds: Bounds;
  candidates: OrientationCandidate[];
  suggestedUp: UpAxis;
  /** The rest describe the model with `suggestedUp` applied, at scale 1. */
  height: number;
  outerDiameter: number;
  /** Cavity axis relative to the bounding-box centre. */
  cavityCenter: { x: number; z: number } | null;
  floorTop: number | null;
  cavityDepth: number;
  rimCavityDiameter: number | null;
  maxCavityDiameter: number;
  maxCavityAt: number | null;
  /** Narrowest opening between the widest point of the cavity and the rim. */
  minOpeningAboveMax: number | null;
  rows: ProfileSummaryRow[];
  warnings: string[];
}

function cavityDepthOf(o: Float32Array): { depth: number; height: number; bounds: Bounds; profile: Profile } {
  const b = computeBounds(o);
  const profile = sliceProfile(o, gridFor(b.min.y, b.max.y, 0.25, 600));
  const floor = findFloor(profile);
  const floorTop = floor ? floor.top : b.min.y;
  return { depth: Math.max(0, b.max.y - floorTop), height: b.max.y - b.min.y, bounds: b, profile };
}

export function analyzeMesh(positions: Float32Array, preferredUp?: UpAxis): MeshAnalysis {
  const raw = computeBounds(positions);
  const warnings: string[] = [];
  const candidates: OrientationCandidate[] = UP_AXES.map((up) => {
    const o = oriented(positions, raw, up, 0);
    const { depth, height, bounds } = cavityDepthOf(o);
    const width = bounds.max.x - bounds.min.x;
    const d = bounds.max.z - bounds.min.z;
    // Prefer orientations with a deep opening at the top and a round footprint.
    const roundness = Math.min(width, d) / Math.max(width, d, 1e-9);
    return { up, height, width, depth: d, cavityDepth: depth, score: (depth / Math.max(height, 1e-9)) * (0.5 + 0.5 * roundness) };
  });
  const best = Math.max(...candidates.map((c) => c.score));
  // Near-ties go to the conventional up axes (in UP_AXES order), or the caller's preference.
  const near = candidates.filter((c) => c.score >= best * 0.95);
  const suggestedUp = (preferredUp && near.find((c) => c.up === preferredUp)?.up) || near[0].up;
  if (best < 0.2) warnings.push('No clear cavity opening found in any orientation; check that the model is a pot with an open top.');

  const o = oriented(positions, raw, suggestedUp, 0);
  const b = computeBounds(o);
  let profile = sliceProfile(o, gridFor(b.min.y, b.max.y));
  let floor = findFloor(profile);
  const top = b.max.y;
  const cavityCenter = estimateCenter(o, cavityHeights(floor ? floor.top : b.min.y, top));
  if (cavityCenter && Math.hypot(cavityCenter.x, cavityCenter.z) > 0.01) {
    profile = sliceProfile(o, gridFor(b.min.y, b.max.y), cavityCenter.x, cavityCenter.z);
    floor = findFloor(profile);
  }
  const floorTop = floor ? floor.top : null;
  let maxCav = 0;
  let maxCavIdx = -1;
  let outer = 0;
  for (let i = 0; i < profile.n; i++) {
    const c = profile.cavity[i];
    if (profile.enclosed[i] && Number.isFinite(c) && c > maxCav && (floorTop === null || profile.heights[i] >= floorTop)) {
      maxCav = c;
      maxCavIdx = i;
    }
    if (profile.outer[i] > outer) outer = profile.outer[i];
  }
  let minOpening: number | null = null;
  let rim: number | null = null;
  for (let i = Math.max(maxCavIdx, 0); i < profile.n; i++) {
    const c = profile.cavity[i];
    if (!Number.isFinite(c)) continue;
    rim = c;
    if (minOpening === null || c < minOpening) minOpening = c;
  }
  const rows: ProfileSummaryRow[] = [];
  const count = 40;
  for (let k = 0; k <= count; k++) {
    const i = Math.min(profile.n - 1, Math.round((k / count) * (profile.n - 1)));
    const c = profile.cavity[i];
    rows.push({
      h: profile.heights[i],
      cavityDiameter: Number.isFinite(c) ? 2 * c : null,
      outerDiameter: profile.outer[i] > 0 ? 2 * profile.outer[i] : null,
    });
  }
  const height = b.max.y - b.min.y;
  if (height < 5 || height > 2000) warnings.push(`Model is ${height.toFixed(2)} units tall; STL units are assumed to be millimetres.`);
  return {
    triangleCount: Math.floor(positions.length / 9),
    rawBounds: raw,
    candidates,
    suggestedUp,
    height,
    outerDiameter: 2 * outer,
    cavityCenter,
    floorTop,
    cavityDepth: floorTop === null ? 0 : top - floorTop,
    rimCavityDiameter: rim === null ? null : 2 * rim,
    maxCavityDiameter: 2 * maxCav,
    maxCavityAt: maxCavIdx >= 0 ? profile.heights[maxCavIdx] : null,
    minOpeningAboveMax: minOpening === null ? null : 2 * minOpening,
    rows,
    warnings,
  };
}

/** Transform that stands the model upright with its cavity on the axis and its floor at y = 0. */
export function initialTransform(positions: Float32Array, a: MeshAnalysis): PotTransform {
  const c = a.cavityCenter ?? { x: 0, z: 0 };
  return {
    up: a.suggestedUp,
    spin: 0,
    position: { x: -c.x, y: -(a.floorTop ?? 0), z: -c.z },
    scale: { x: 1, y: 1, z: 1 },
  };
}

/**
 * Placement for a pot built in the design frame (+Z up, the pot's axis on
 * x = y = 0): scale 1, the design's axis on the reference axis, and the
 * reference pot standing where it comes to rest when lowered in, on the floor
 * plus floorGap or on the walls if they stop it first.
 */
export function placeDesign(positions: Float32Array, ref: ReferenceDims, fit: Pick<FitSettings, 'clearance' | 'floorGap'>, raw?: Bounds): PotTransform {
  const bounds = raw ?? computeBounds(positions);
  // Positioning the anchor at itself leaves the mesh where the up rotation puts it.
  const anchor = anchorFor(bounds, '+Z');
  const t: PotTransform = { up: '+Z', spin: 0, position: anchor, scale: { x: 1, y: 1, z: 1 } };
  const world = applyTransform(positions, t, bounds);
  const b = computeBounds(world);
  const profile = sliceProfile(world, gridFor(b.min.y, b.max.y, 0.1));
  const floor = findFloor(profile);
  // Designs leave exactly the clearance, so the walls touch the clearance
  // envelope along its length; a few microns of slack stop float rounding
  // from catching the nursery pot on them.
  const walls = descentSeat(profile, frustumOf(ref), fit.clearance / 2 - 0.005).seat;
  const base = Math.max(walls, (floor ? floor.top : b.min.y) + fit.floorGap);
  return { ...t, position: { x: anchor.x, y: anchor.y - base, z: anchor.z } };
}

// ---------------------------------------------------------------- checking

/**
 * Side wall thickness: from the cavity axis, cast rays outwards at several
 * heights between the floor and the rim; the first crossing is the inside of
 * the wall and the second its outside. Measured horizontally, so a tapered
 * wall reads slightly thicker than its true (normal) thickness.
 */
function wallThickness(world: Float32Array, axis: { x: number; z: number }, lo: number, hi: number): FitMetrics['wallThickness'] {
  if (!(hi > lo)) return null;
  const heights: number[] = [];
  for (let k = 0; k < 12; k++) heights.push(lo + ((hi - lo) * (k + 0.5)) / 12);
  const samples: { t: number; y: number }[] = [];
  const rays = 36;
  sliceSegmentsAt(world, heights).forEach((segs, j) => {
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * Math.PI * 2;
      const hits = rayIntersections(segs, axis.x, axis.z, Math.cos(a), Math.sin(a));
      if (hits.length >= 2) samples.push({ t: hits[1] - hits[0], y: heights[j] });
    }
  });
  if (samples.length === 0) return null;
  samples.sort((a, b) => a.t - b.t);
  return { min: samples[0].t, at: samples[0].y, median: samples[samples.length >> 1].t };
}

/** Thickness of the floor slab: the run of floor slices under the cavity, at the axis. */
function floorThickness(p: Profile, floor: Floor | null): number | null {
  if (!floor) return null;
  const threshold = maxCavity(p) * 0.3;
  let i = floor.index;
  while (i > 0 && Number.isFinite(p.cavity[i - 1]) && p.cavity[i - 1] < threshold) i--;
  // The bottom slice sits half a step above the pot's underside.
  const bottom = i === 0 ? p.heights[0] - p.step / 2 : p.heights[i] - p.step / 2;
  return floor.top - bottom;
}

export function checkFit(positions: Float32Array, t: PotTransform, ref: ReferenceDims, fit: FitSettings, raw?: Bounds): FitMetrics {
  const f = frustumOf(ref);
  const cr = fit.clearance / 2;
  const world = applyTransform(positions, t, raw ?? computeBounds(positions));
  const b = computeBounds(world);
  const profile = sliceProfile(world, gridFor(b.min.y, b.max.y, 0.1));
  const warnings: string[] = [];

  let minGap = Infinity, minGapAt = 0;
  let bottomGap = NaN, rimGap = NaN;
  let interferes = false;
  let inRange = 0, enclosed = 0;
  for (let i = 0; i < profile.n; i++) {
    const y = profile.heights[i];
    if (y < 0 || y > f.h) continue;
    inRange++;
    if (profile.enclosed[i]) enclosed++;
    const cav = profile.cavity[i];
    if (!Number.isFinite(cav)) continue;
    const gap = cav - radiusAt(f, y);
    if (Number.isNaN(bottomGap)) bottomGap = gap;
    rimGap = gap;
    if (gap < minGap) {
      minGap = gap;
      minGapAt = y;
    }
    if (gap < -0.01) interferes = true;
  }
  // Slices only cover the pot's height; the reference is enclosed nowhere above it.
  const refSlices = Math.max(1, Math.round(f.h / profile.step));
  const enclosedFraction = Math.min(1, enclosed / Math.max(refSlices, inRange));

  const floor = findFloor(profile);
  const floorTop = floor ? floor.top : null;
  const floorGap = floorTop === null ? null : -floorTop;
  const contact = descentSeat(profile, f, 0);
  const dropToContact = contact.seat === -Infinity ? Infinity : -contact.seat;

  let cavityCenterOffset: { x: number; z: number } | null = null;
  const lo = Math.max(0, floorTop ?? b.min.y), hi = Math.min(f.h, b.max.y);
  if (hi > lo) cavityCenterOffset = estimateCenter(world, cavityHeights(lo, hi, 3));

  // Wall from just above the floor (clear of any fillet) to just under the rim.
  const wallLo = floorTop ?? b.min.y;
  const depth = b.max.y - wallLo;
  const walls = wallThickness(world, cavityCenterOffset ?? { x: 0, z: 0 }, wallLo + Math.min(2, depth * 0.1), b.max.y - Math.min(0.5, depth * 0.02));
  const floorThick = floorThickness(profile, floor);

  const rows: ProfileRow[] = [];
  const rowCount = 24;
  for (let k = 0; k <= rowCount; k++) {
    const y = (f.h * k) / rowCount;
    const i = Math.round((y - profile.y0) / profile.step);
    const cav = i >= 0 && i < profile.n ? profile.cavity[i] : Infinity;
    const r = radiusAt(f, y);
    rows.push({ y, cavityRadius: cav, referenceRadius: r, gap: cav - r });
  }

  const topOffset = f.h - b.max.y;
  const clearanceOk = inRange > 0 && !interferes && minGap >= cr - 0.05;
  if (inRange === 0) warnings.push('The outer pot does not overlap the reference pot vertically at all.');
  if (interferes) warnings.push(`The reference pot passes through the outer pot (worst overlap ${(-minGap).toFixed(2)} mm at y=${minGapAt.toFixed(1)}).`);
  else if (minGap < cr - 0.05) warnings.push(`Radial gap is ${minGap.toFixed(2)} mm at y=${minGapAt.toFixed(1)}, below the ${cr.toFixed(2)} mm required.`);
  if (floorGap !== null && floorGap < -0.1) warnings.push(`The reference base is ${(-floorGap).toFixed(2)} mm below the cavity floor.`);
  if (floorGap !== null && floorGap > fit.floorGap + 0.5 && !interferes) warnings.push(`The reference base is ${floorGap.toFixed(2)} mm above the floor; it would drop until it touches the walls.`);
  if (fit.topOffset !== null && Math.abs(topOffset - fit.topOffset) > 0.5) warnings.push(`Rim offset is ${topOffset.toFixed(2)} mm (target ${fit.topOffset.toFixed(2)} mm).`);
  if (inRange > 0 && enclosedFraction < 0.5) warnings.push('Most of the reference pot is not inside the outer pot.');
  if (cavityCenterOffset && Math.hypot(cavityCenterOffset.x, cavityCenterOffset.z) > 0.5) {
    warnings.push(`Cavity axis is ${Math.hypot(cavityCenterOffset.x, cavityCenterOffset.z).toFixed(2)} mm off the reference axis.`);
  }
  if (walls && walls.min < 0.8) warnings.push(`The thinnest wall is ${walls.min.toFixed(2)} mm (at y=${walls.at.toFixed(1)}), which may not print well.`);
  if (floorThick !== null && floorThick < 0.8) warnings.push(`The floor is only ${floorThick.toFixed(2)} mm thick.`);
  const s = t.scale;
  if (Math.abs(s.x - s.z) > 1e-3 * Math.max(s.x, s.z)) warnings.push(`Width scales differ (x ${s.x.toFixed(4)}, z ${s.z.toFixed(4)}), so the pot is no longer round.`);
  if (Math.min(s.x, s.y, s.z) < 0.2 || Math.max(s.x, s.y, s.z) > 5) warnings.push('Scale is far from 1; check the model units.');

  return {
    size: { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z },
    potBottom: b.min.y,
    potTop: b.max.y,
    topOffset,
    floorTop,
    floorGap,
    minRadialGap: minGap,
    minRadialGapAt: minGapAt,
    bottomRadialGap: bottomGap,
    rimRadialGap: rimGap,
    requiredRadialGap: cr,
    interferes,
    clearanceOk,
    dropToContact,
    enclosedFraction,
    cavityCenterOffset,
    wallThickness: walls,
    floorThickness: floorThick,
    profile: rows,
    warnings,
  };
}

// ---------------------------------------------------------------- solving

export interface SolveOptions {
  up: UpAxis;
  spin: number;
  mode: ScaleMode;
  clearance: number;
  topOffset: number | null;
  floorGap: number;
}

export interface SolveResult {
  transform: PotTransform;
  radialScale: number;
  heightScale: number;
  /** Cavity axis relative to the bounding-box centre, at scale 1. */
  cavityCenter: { x: number; z: number };
  /** Floor height above the pot bottom at scale 1. */
  floorTop: number;
  notes: string[];
}

function bisect(lo: number, hi: number, pred: (x: number) => boolean, iters = 60): number {
  // Smallest x in [lo, hi] (log-spaced) with pred(x) true; pred is monotone false -> true.
  let a = Math.log(lo), b = Math.log(hi);
  for (let k = 0; k < iters; k++) {
    const m = (a + b) / 2;
    if (pred(Math.exp(m))) b = m;
    else a = m;
  }
  return Math.exp(b);
}

export function solveFit(positions: Float32Array, ref: ReferenceDims, opts: SolveOptions, raw?: Bounds): SolveResult {
  const f = frustumOf(ref);
  const cr = opts.clearance / 2;
  const notes: string[] = [];
  const o = oriented(positions, raw ?? computeBounds(positions), opts.up, opts.spin);
  const b = computeBounds(o);
  const top = b.max.y; // the bottom is at 0
  const grid = gridFor(0, top, 0.1, 3000);

  let profile = sliceProfile(o, grid);
  let floor = findFloor(profile);
  const center = estimateCenter(o, cavityHeights(floor ? floor.top : 0, top)) ?? { x: 0, z: 0 };
  if (Math.hypot(center.x, center.z) > 0.01) {
    profile = sliceProfile(o, grid, center.x, center.z);
    floor = findFloor(profile);
  }
  if (maxCavity(profile) <= 0) throw new Error(`No cavity found with ${opts.up} up; try another up axis.`);
  let floorTop = floor ? floor.top : 0;
  if (!floor) notes.push('No floor found inside the cavity, so the reference pot sits level with the outer pot\'s base.');
  if (top - floorTop < 1e-3) throw new Error('The cavity has no depth with this orientation.');

  // Where the reference base ends up for a given scale: on the floor (plus
  // floorGap), or higher if the walls stop it first.
  const place = (sr: number, sh: number) => {
    const walls = descentSeat(profile, f, cr, sr, sh).seat;
    const onFloor = sh * floorTop + opts.floorGap;
    return { base: Math.max(walls, onFloor), hang: walls - onFloor };
  };
  const tol = Math.min(0.05, top / 1000);
  let sr: number, sh: number;
  if (opts.mode === 'uniform') {
    if (opts.topOffset === null) {
      sr = sh = bisect(1e-4, 1e4, (s) => place(s, s).hang <= tol);
    } else {
      const target = opts.topOffset;
      if (target >= f.h) throw new Error(`A top offset of ${target} mm would leave the reference pot (${f.h} mm tall) entirely above the outer pot.`);
      sr = sh = bisect(1e-4, 1e4, (s) => place(s, s).base + f.h - s * top <= target);
    }
  } else {
    const target = opts.topOffset ?? 0;
    // On the floor, rim offset = floorGap + H - sh * (top - floorTop).
    sh = (f.h + opts.floorGap - target) / (top - floorTop);
    if (!(sh > 0)) throw new Error(`Cannot reach a top offset of ${target} mm: the reference pot is only ${f.h} mm tall.`);
    sr = bisect(1e-4, 1e4, (s) => place(s, sh).hang <= tol);
  }
  const { base, hang } = place(sr, sh);
  if (hang > tol) notes.push(`At this scale the walls hold the reference pot ${hang.toFixed(2)} mm above the floor.`);
  if (opts.mode === 'uniform' && opts.topOffset !== null && hang <= tol) {
    const sFloor = bisect(1e-4, 1e4, (s) => place(s, s).hang <= tol);
    if (sFloor > sr * 1.0005) notes.push(`Scale ${sFloor.toFixed(4)} would be needed for the reference pot to reach the floor with full clearance.`);
  }
  if (opts.mode === 'radial-height' && Math.abs(sr - sh) / Math.max(sr, sh) > 0.25) {
    notes.push(`Width and height scales differ a lot (${sr.toFixed(3)} vs ${sh.toFixed(3)}); the pot's proportions will change visibly.`);
  }
  floorTop = floor ? floor.top : 0;
  return {
    transform: {
      up: opts.up,
      spin: opts.spin,
      position: { x: -sr * center.x, y: -base, z: -sr * center.z },
      scale: { x: sr, y: sh, z: sr },
    },
    radialScale: sr,
    heightScale: sh,
    cavityCenter: center,
    floorTop,
    notes,
  };
}

