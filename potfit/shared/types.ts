// Types shared by the browser app, the API server and the Codex pot-tool.
//
// Units are millimetres throughout. The "pot frame" is the world frame of the
// fit: +Y is up, the reference (inner nursery) pot stands with the centre of its
// base at the origin, and its axis runs up the Y axis.

export type UpAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
export const UP_AXES: readonly UpAxis[] = ['+Z', '-Z', '+Y', '-Y', '+X', '-X'];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Placement of an outer pot model in the pot frame.
 *
 * world = position + scale * (spinY(spin) * (upRotation(up) * raw - anchor))
 *
 * `anchor` is the centre of the bottom face of the model's bounding box once
 * `up` has been applied, so `position` is where the bottom centre of the outer
 * pot ends up and spinning or scaling happens about that point.
 */
export interface PotTransform {
  /** Which raw model axis points up out of the pot's opening. */
  up: UpAxis;
  /** Rotation about the vertical axis, degrees. */
  spin: number;
  /** World position of the outer pot's bottom centre, mm. */
  position: Vec3;
  /** Scale factors along world X, Y (height) and Z. */
  scale: Vec3;
}

/** The inner nursery pot that actually holds the plant. */
export interface ReferencePot {
  id: string;
  name: string;
  /** Outside diameter at the rim, mm. */
  topOD: number;
  /** Outside diameter at the base, mm. */
  bottomOD: number;
  /** Overall height, mm. */
  height: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type ReferenceInput = Pick<ReferencePot, 'name' | 'topOD' | 'bottomOD' | 'height' | 'notes'>;

export type ScaleMode = 'uniform' | 'radial-height';

export interface FitSettings {
  referenceId: string | null;
  /** Diametral clearance between the reference pot and the cavity wall, mm. */
  clearance: number;
  /** uniform keeps proportions; radial-height scales width and height independently. */
  scaleMode: ScaleMode;
  /**
   * How far the reference pot's rim should stand above the outer pot's rim, mm
   * (negative sinks it below). null means "no target": sit on the floor at the
   * smallest scale that clears the walls.
   */
  topOffset: number | null;
  /** Gap left between the cavity floor and the reference pot's base, mm. */
  floorGap: number;
}

export const DEFAULT_FIT: FitSettings = {
  referenceId: null,
  clearance: 5,
  scaleMode: 'uniform',
  topOffset: 0,
  floorGap: 0,
};

export interface PotModel {
  id: string;
  name: string;
  /** File the model was imported from. */
  sourceFile: string;
  triangleCount: number;
  createdAt: string;
  updatedAt: string;
  transform: PotTransform;
  fit: FitSettings;
  /** Codex thread used for this model's fit conversation, if any. */
  codexThreadId: string | null;
}

export type ModelPatch = Partial<Pick<PotModel, 'name' | 'transform' | 'fit'>>;

/** Measurements of a placed outer pot against a reference pot. */
export interface FitMetrics {
  /** Outer pot size once placed, mm. */
  size: Vec3;
  /** World Y of the outer pot's bottom and rim. */
  potBottom: number;
  potTop: number;
  /** Reference rim height minus outer pot rim height; positive means it stands proud. */
  topOffset: number;
  /** Highest point of the cavity floor under the reference pot, or null if none was found. */
  floorTop: number | null;
  /** Reference base height minus floorTop; negative means it sinks into the floor. */
  floorGap: number | null;
  /** Smallest radial gap between the reference pot and the cavity wall over the reference's height. */
  minRadialGap: number;
  /** Height (world Y) where minRadialGap occurs. */
  minRadialGapAt: number;
  /** Radial gap at the reference base and at the lower of the two rims. */
  bottomRadialGap: number;
  rimRadialGap: number;
  /** Required radial gap (clearance / 2). */
  requiredRadialGap: number;
  /** True if any part of the reference pot passes through the outer pot. */
  interferes: boolean;
  /** True if the gaps meet the clearance and the reference does not interfere. */
  clearanceOk: boolean;
  /** How far the reference pot could drop before it touches anything (negative: it is already inside the walls). */
  dropToContact: number;
  /** Fraction of the reference pot's height that is surrounded by the outer pot. */
  enclosedFraction: number;
  /** Estimated horizontal offset of the cavity axis from the reference axis. */
  cavityCenterOffset: { x: number; z: number } | null;
  /** Sampled profile over the reference pot's height. */
  profile: ProfileRow[];
  warnings: string[];
}

export interface ProfileRow {
  y: number;
  /** Free radius around the axis at this height (Infinity above the pot). */
  cavityRadius: number;
  referenceRadius: number;
  gap: number;
}

export type CodexRunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** Fit goals Codex can change when the user's feedback asks for different ones. */
export type FitGoals = Omit<FitSettings, 'referenceId'>;

export interface CodexResult {
  transform: PotTransform;
  /** The goals the transform was fitted to; null if Codex did not report them. */
  fit: FitGoals | null;
  summary: string;
  warnings: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface CodexRun {
  id: string;
  modelId: string;
  kind: 'fit' | 'feedback';
  /** User instructions (fit) or feedback text. */
  message: string;
  status: CodexRunStatus;
  startedAt: string;
  finishedAt: string | null;
  threadId: string | null;
  transformBefore: PotTransform;
  fitBefore: FitSettings;
  referenceId: string | null;
  result: CodexResult | null;
  /** Server-side check of the result transform. */
  metrics: FitMetrics | null;
  error: string | null;
  /** User verdict on the result. */
  rating: 'accepted' | 'rejected' | null;
}

/** Normalised item from `codex exec --json`, as shown in the run log. */
export interface CodexItem {
  id: string;
  type: string;
  status: 'in_progress' | 'completed' | 'failed';
  text?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  detail?: unknown;
}

export type CodexEvent =
  | { type: 'status'; status: CodexRunStatus; error?: string | null }
  | { type: 'thread'; threadId: string }
  | { type: 'item'; item: CodexItem }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'log'; level: 'info' | 'error'; text: string }
  | { type: 'result'; run: CodexRun };

export interface ServerStatus {
  codex: { available: boolean; version: string | null; error: string | null };
  dataDir: string;
}
