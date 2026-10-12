import type { MeshAnalysis } from "../geometry/meshCheck";
import type { Feature, MeshQuality } from "../model/types";

/** Display mesh for one part, ready to hand to three.js. */
export interface PartMesh {
  id: string;
  name: string;
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
}

export interface RebuildResult {
  parts: PartMesh[];
  /** Feature ID → plain-English reason it failed. */
  featureErrors: Record<string, string>;
  /** Milliseconds the rebuild took in the worker. */
  durationMs: number;
}

export interface PartCheck {
  partId: string;
  name: string;
  /** OpenCascade's own geometry check (null if it couldn't run). */
  geometryValid: boolean | null;
  /** Exact volume from the solid model, mm³. */
  exactVolume: number | null;
  mesh: MeshAnalysis;
}

export interface CheckResult {
  parts: PartCheck[];
}

export interface ExportResult {
  /** Binary STL file contents. */
  stl: ArrayBuffer;
  triangleCount: number;
}

export type KernelRequest =
  | { type: "rebuild"; features: Feature[] }
  | { type: "check"; quality: MeshQuality }
  | { type: "exportStl"; partIds: string[]; quality: MeshQuality };

export type KernelResponseBody =
  | { type: "rebuild"; result: RebuildResult }
  | { type: "check"; result: CheckResult }
  | { type: "exportStl"; result: ExportResult };

/** Messages sent from the main thread to the worker. */
export type ToWorker = { id: number; request: KernelRequest };

/** Messages sent from the worker back to the main thread. */
export type FromWorker =
  | { kind: "ready" }
  | { kind: "fatal"; error: string }
  | { kind: "response"; id: number; ok: true; body: KernelResponseBody }
  | { kind: "response"; id: number; ok: false; error: string };
