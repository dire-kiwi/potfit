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
  /** Prefer support-free geometry; omitted on older pots means true. */
  avoidOverhangs?: boolean;
  id: string;
  name: string;
  /** File the model was imported from. */
  sourceFile: string;
  triangleCount: number;
  createdAt: string;
  updatedAt: string;
  transform: PotTransform;
  fit: FitSettings;
  /** The agent-threads thread that fits (imported) or designs (designed) this model, if any. */
  threadId?: string | null;
  /** Set for pots designed in the app rather than imported (absent on older models). */
  design?: PotDesign | null;
}

export type ModelPatch = Partial<Pick<PotModel, 'name' | 'transform' | 'fit' | 'avoidOverhangs'>>;

// ------------------------------------------------------------------ designs

/**
 * A user-adjustable value a design script declares. The app shows a control
 * for each and rebuilds the design when one changes.
 */
export type DesignParam =
  | { type: 'number'; value: number; min: number | null; max: number | null; step: number | null; label: string; unit: string; help: string }
  | { type: 'boolean'; value: boolean; label: string; help: string }
  | { type: 'choice'; value: string; options: string[]; label: string; help: string };

export type ParamValues = Record<string, number | boolean | string>;

/** The reference pot and goals a design's cavity was built for. */
export interface DesignTarget {
  referenceId: string | null;
  reference: { name: string; topOD: number; bottomOD: number; height: number };
  clearance: number;
  topOffset: number | null;
  floorGap: number;
}

/** Overhang found on one part of a built design. */
export interface OverhangSpot {
  /** Downward-facing area steeper than 45° from vertical, mm². */
  area: number;
  /** Height range in the design frame (z up from the base), mm. */
  zMin: number;
  zMax: number;
  /** Which side of the pot, e.g. "front (-y)". */
  side: string;
}

/** What building a design script produced. */
export interface DesignReport {
  triangles: number;
  /** Size of the printed part in the design frame (z is height), mm. */
  size: Vec3;
  /** Lowest point; the base should be at z = 0. */
  minZ: number;
  /** cm³ of material. */
  volume: number;
  /** Separate solid pieces; more than one means something is floating. */
  components: number;
  /** Total downward-facing area steeper than 45° from vertical, not counting the base, mm². */
  overhangArea: number;
  overhangs: OverhangSpot[];
  /** Placement that sits the reference pot in the cavity at scale 1. */
  placement: PotTransform;
  /** The built pot measured against the reference pot it was built for. */
  metrics: FitMetrics | null;
  /** Lines the script added with note(). */
  notes: string[];
  warnings: string[];
  buildMs: number;
}

export interface PotDesign {
  /** What the user asked for when they created the design. */
  description: string;
  /** Reference images the user supplied (file names in the design's refs/ folder). */
  images: string[];
  /** Current parameter values and what the script declares. */
  params: ParamValues;
  paramSpec: Record<string, DesignParam>;
  /** The last successful build, and what it was built for. */
  report: DesignReport | null;
  builtFor: DesignTarget | null;
  builtAt: string | null;
  /** Why the last build failed, if it did (the mesh is from the build before). */
  buildError: string | null;
}

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
  /**
   * Side wall thickness measured horizontally outwards from the cavity axis,
   * sampled around the pot above the floor: thinnest, its height, and median.
   */
  wallThickness: { min: number; at: number; median: number } | null;
  /** Thickness of the floor slab under the cavity, measured at the axis. */
  floorThickness: number | null;
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

/** Fit goals the agent can change when the user's feedback asks for different ones. */
export type FitGoals = Omit<FitSettings, 'referenceId'>;

export type Confidence = 'high' | 'medium' | 'low';

/** A fit that replaced the model's mesh. The mesh from before is kept with its checkpoint. */
export interface MeshEdit {
  trianglesBefore: number;
  trianglesAfter: number;
}

export interface ReviewFinding {
  severity: 'major' | 'minor' | 'info';
  title: string;
  detail: string;
}

/** An independent review of a finished fit. */
export interface ReviewResult {
  verdict: 'pass' | 'concerns' | 'fail';
  summary: string;
  findings: ReviewFinding[];
  /** Instruction the user can send to the fitting agent; empty for a pass. */
  feedbackForFitter: string;
}

// ------------------------------------------------------------------ agent

/** What a thread does: fit an imported model, design a designed one, or review a fit. */
export type AgentRole = 'fit' | 'design' | 'review';

/** Claude Code's reasoning efforts (`claude --effort`). */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface AgentSettings {
  /** Empty or omitted values use the server's / Claude Code's defaults. */
  model?: string | null;
  effort?: AgentEffort | null;
}

export interface AgentModelOption {
  id: string;
  name: string;
}

/**
 * A change the agent applied with a tool (a fit, a mesh edit or a design), with what it replaced,
 * so it can be reverted. Kept in models/<id>/checkpoints/<id>/, and the tool call's structured result.
 */
export interface Checkpoint {
  id: string;
  modelId: string;
  threadId: string;
  toolCallId: string | null;
  kind: 'fit' | 'mesh-edit' | 'design';
  createdAt: string;
  /** What the agent said about it. */
  title?: string;
  summary: string;
  warnings: string[];
  confidence: Confidence;
  /** The model after the change, and before it. */
  transform: PotTransform;
  fit: FitSettings;
  transformBefore: PotTransform;
  fitBefore: FitSettings;
  paramsBefore: ParamValues | null;
  triangleCountBefore: number;
  meshEdit: MeshEdit | null;
  designReport: DesignReport | null;
  /** The server's measurements of the result. */
  metrics: FitMetrics | null;
  rating: 'accepted' | 'rejected' | null;
  revertedAt: string | null;
}

/** A one-off review in a thread of its own (or one reviewer of a screenshot review round). */
export interface Review {
  id: string;
  modelId: string;
  threadId: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error: string | null;
  /** The screenshot-review focus, for a visual reviewer. */
  focus: string | null;
  /** What was reviewed. */
  transform: PotTransform;
  fit: FitSettings;
  referenceId: string | null;
  metrics: FitMetrics | null;
  result: ReviewResult | null;
}

export interface ServerStatus {
  claude: { available: boolean; version: string | null; error: string | null; defaultModel: string | null; defaultEffort: string | null; models: AgentModelOption[] };
  /** Blender, which the agent can use to edit meshes and make parts for designs. */
  blender: { available: boolean; version: string | null; error: string | null };
  dataDir: string;
}

export interface ScreenshotReview {
  /** Optional user guidance applied to every reviewer and worker round. */
  prompt?: string;
  id: string;
  status: 'running' | 'done' | 'limit' | 'cancelled' | 'error';
  round: number;
  phase: string;
  error: string | null;
  rounds: { round: number; reviews: { focus: string; reviewId: string; result: ReviewResult }[]; workerAdjusted?: boolean }[];
}

/** A thread's state as /live tells it. */
export interface ThreadState {
  id: string;
  role: AgentRole;
  status: 'idle' | 'running' | 'waiting' | 'error';
  model?: string;
  effort?: string;
}

/** What /api/models/:id/live streams. */
export type LiveEvent =
  | { type: 'model'; model: PotModel; meshChanged: boolean }
  | { type: 'thread'; thread: ThreadState }
  | { type: 'checkpoint'; checkpoint: Checkpoint }
  | { type: 'review'; review: Review }
  | { type: 'loop'; state: ScreenshotReview };
