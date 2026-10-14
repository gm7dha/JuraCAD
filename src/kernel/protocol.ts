import type { MeshAnalysis, ThicknessEstimate } from "../geometry/meshCheck";
import type { EdgeRef, FaceRef, TopoPick } from "../geometry/topoRef";
import type { Measurement } from "../geometry/measureMath";
import type { Feature, MeshQuality } from "../model/types";

/** A copy of a part placed in an assembly, for exports and clash checks. */
export interface InstanceInput {
  id: string;
  partId: string;
  name: string;
  position: [number, number, number];
  /** Quaternion x, y, z, w. */
  rotation: [number, number, number, number];
}

/** One Part Studio's features, for a rebuild. */
export interface StudioInput {
  id: string;
  features: Feature[];
}

/** Display mesh for one part, ready to hand to three.js. */
export interface PartMesh {
  id: string;
  name: string;
  /** The Part Studio it belongs to. */
  studioId?: string;
  /** IDs of the features that built or changed this part. */
  featureIds: string[];
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  /** One entry per B-rep face: triangle-index range [start, start + count). */
  faceGroups: { start: number; count: number; faceId: number }[];
  /** Edge polylines as line segments (pairs of points). */
  lines: Float32Array;
  /** One entry per B-rep edge: vertex range in `lines`. */
  edgeGroups: { start: number; count: number; edgeId: number }[];
  /** What each face looks like (same order as faceGroups), so picks can be remembered across rebuilds. */
  faceRefs: FaceRef[];
  /** What each edge looks like (same order as edgeGroups). */
  edgeRefs: EdgeRef[];
}

export interface RebuildResult {
  parts: PartMesh[];
  /** Feature ID → plain-English reason it failed. */
  featureErrors: Record<string, string>;
  /** Milliseconds the rebuild took in the worker. */
  durationMs: number;
  /** Part Studios that were rebuilt (`parts` holds only theirs); the others are as before. */
  rebuilt?: string[];
  /** Every Part Studio, in order. */
  studioOrder?: string[];
}

export interface PartCheck {
  partId: string;
  name: string;
  /** OpenCascade's own geometry check (null if it couldn't run). */
  geometryValid: boolean | null;
  /** Exact volume from the solid model, mm³. */
  exactVolume: number | null;
  mesh: MeshAnalysis;
  /** Thinnest wall found (approximate), or null if it couldn't be measured. */
  thinnest: ThicknessEstimate | null;
}

export interface CheckResult {
  parts: PartCheck[];
  /** Pairs of separate parts that occupy the same space. */
  overlaps?: { a: string; b: string; volume: number }[];
}

export interface ExportResult {
  /** Binary STL file contents. */
  stl: ArrayBuffer;
  triangleCount: number;
}

export interface StepResult {
  /** STEP file contents (exact shapes, millimetres). */
  step: ArrayBuffer;
  partCount: number;
}

export interface ThreeMfResult {
  /** .3mf file contents. */
  data: ArrayBuffer;
  triangleCount: number;
}

export type { Measurement } from "../geometry/measureMath";

export type KernelRequest =
  | { type: "rebuild"; studios: StudioInput[]; variables: Record<string, number>; partNames?: Record<string, string> }
  | { type: "check"; quality: MeshQuality; partIds?: string[] }
  | { type: "exportStl"; partIds: string[]; quality: MeshQuality; instances?: InstanceInput[] }
  | { type: "exportStep"; partIds: string[]; colours?: Record<string, string>; instances?: InstanceInput[] }
  | { type: "clashes"; instances: InstanceInput[] }
  | { type: "measure"; picks: TopoPick[] }
  | { type: "export3mf"; partIds: string[]; quality: MeshQuality; title: string; colours?: Record<string, string>; instances?: InstanceInput[] };

export type KernelResponseBody =
  | { type: "rebuild"; result: RebuildResult }
  | { type: "check"; result: CheckResult }
  | { type: "exportStl"; result: ExportResult }
  | { type: "exportStep"; result: StepResult }
  | { type: "measure"; result: Measurement }
  | { type: "export3mf"; result: ThreeMfResult }
  | { type: "clashes"; result: NonNullable<CheckResult["overlaps"]> };

/** Messages sent from the main thread to the worker. */
export type ToWorker = { id: number; request: KernelRequest };

/** Messages sent from the worker back to the main thread. */
export type FromWorker =
  | { kind: "ready" }
  | { kind: "fatal"; error: string }
  | { kind: "response"; id: number; ok: true; body: KernelResponseBody }
  | { kind: "response"; id: number; ok: false; error: string };
