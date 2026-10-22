import type { MeshAnalysis, ThicknessEstimate } from "../geometry/meshCheck";
import type { EdgeRef, FaceRef, TopoPick } from "../geometry/topoRef";
import type { Measurement } from "../geometry/measureMath";
import type { Feature, MeshQuality, ViewKind } from "../model/types";
import type { BreakOutRequest, SectionRequest } from "../drawing/sections";

/** A copy of a part placed in an assembly, for exports and clash checks. */
export interface InstanceInput {
  id: string;
  partId: string;
  name: string;
  position: [number, number, number];
  /** Quaternion x, y, z, w. */
  rotation: [number, number, number, number];
  /** The part's mirror image (flipped across its own YZ plane before it's placed). */
  mirrored?: boolean;
}

/** A drawing view's lines, in the view's own flat coordinates (mm; x right, y up on the paper). */
export interface ViewProjection {
  /** The view's kind, or "section:<id>" for a section view. */
  kind: string;
  /** Visible lines, each a flat list of points x0, y0, x1, y1… */
  visible: number[][];
  /** Lines hidden behind the part (drawn dashed). */
  hidden: number[][];
  /** Circles and arcs, for dimensions. */
  circles: { cx: number; cy: number; r: number; hidden: boolean; full: boolean }[];
  /** Corner and end points, for dimensions to snap to. */
  points: number[];
  /** minX, minY, maxX, maxY — null when there's nothing to draw. */
  bounds: [number, number, number, number] | null;
  /** Centre lines of round faces seen from the side: x0, y0, x1, y1 each. */
  axes?: number[][];
  /** Detail views: drawn this many times bigger than the sheet's scale. */
  zoom?: number;
  /** Section views: the faces made by the cut, as triangles (x, y × 3 each). */
  cutFaces?: number[];
  /** Holes seen end-on (centre of the opening), for hole callouts. */
  holes?: ViewHole[];
  /** Threads on rods and in holes, drawn the standard way: thin lines (dashed when inside the part). */
  threadMarks?: { line: number[]; hidden: boolean }[];
  /** Holes seen from the side: where each starts and ends on the view, and its diameter (for thread symbols). */
  sideHoles?: { a: [number, number]; b: [number, number]; d: number }[];
  /** How far the part reaches front to back as the view sees it (mm), for broken-out cuts' depths. */
  depth?: number;
  /** Broken-out cuts on this view: each one's outline (x0, y0, x1, y1…, closed). */
  breakLines?: number[][];
  /** Flat pattern views: the bends, each a line across the pattern (x0, y0, x1, y1), its angle (degrees), inside radius, and whether it bends up. */
  bends?: { line: [number, number, number, number]; angle: number; radius: number; up: boolean }[];
  /** Detail views: anything drawn on the view is kept inside this circle (centre x, y and radius, view mm). */
  clipCircle?: [number, number, number];
  /** Shortened views: bands taken out of the middle (added by the drawing, not the engine). */
  shorten?: { axis: 0 | 1; from: number; to: number }[];
}

/** A hole as seen on a view: where its opening is and its sizes (mm; angle in degrees). */
export interface ViewHole {
  cx: number;
  cy: number;
  d: number;
  through: boolean;
  depth: number;
  cbore?: { diameter: number; depth: number };
  csk?: { diameter: number; angle: number };
}

/** One Part Studio's features, for a rebuild. */
export interface StudioInput {
  id: string;
  features: Feature[];
  /** A Part Studio built again in another configuration: its variables, and what's added to its parts' ids ("@<configuration>"). */
  variables?: Record<string, number>;
  partSuffix?: string;
}

/** Display mesh for one part, ready to hand to three.js. */
export interface PartMesh {
  id: string;
  name: string;
  /** The Part Studio it belongs to. */
  studioId?: string;
  /** Built in another configuration (for assemblies): that configuration's id. */
  configuration?: string;
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
  /** Sheet metal parts: the flat pattern (for laser cutting). */
  flat?: FlatPatternData;
  /** A surface: a thin skin with no inside (thicken or enclose it to make a solid). */
  surface?: boolean;
  /** Exact volume of a solid part (mm³), from the solid model rather than the display mesh — for weights. */
  volume?: number;
}

/** A sheet metal part laid out flat (mm): the outline to cut, holes, and where it bends. */
export interface FlatPatternData {
  outline: [number, number][];
  holes: [number, number][][];
  bendLines: [[number, number], [number, number]][];
  bends: { line: [[number, number], [number, number]]; angle: number; radius: number; up: boolean }[];
  /** Cuts made in the part after it was a sheet (holes, notches…), as line pieces. */
  cuts?: [[number, number], [number, number]][];
  /** When present (sheets with tabs), every line to cut — outline, holes and cuts — instead of `outline`, `holes` and `cuts`. */
  boundary?: [[number, number], [number, number]][];
  thickness: number;
  radius: number;
  k: number;
  /** Features that changed the part after it was made from sheet (cuts and the like): not in the flat pattern. */
  notShown: string[];
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
  /** A surface (a skin with no inside), not a solid. */
  surface?: boolean;
}

export interface CheckResult {
  parts: PartCheck[];
  /** Pairs of separate parts that occupy the same space. */
  overlaps?: { a: string; b: string; volume: number }[];
}

/**
 * How two placed parts in an assembly meet, as measured for the clash check
 * (src/kernel/clash.ts). Only pairs that overlap, or come within the
 * tolerance of each other, are measured.
 */
export interface ContactMeasure {
  a: string;
  b: string;
  /** a / b is a surface (a skin with no inside). When only one is, it's a. */
  surfaceA?: boolean;
  surfaceB?: boolean;
  /** Two solids: the volume they share (mm³) and that shared piece's surface area (mm²). */
  volume?: number;
  /** Two solids: the smallest side of the tightest (turned-to-fit) box round the shared piece (mm). */
  boxMin?: number;
  /** Two solids: the shared piece's area; a surface and a solid: how much of the surface is inside (mm²). */
  area?: number;
  /** A surface and a solid: how far inside the solid the surface goes (mm, about). */
  depth?: number;
  /** Two surfaces: the length of the lines they cross along (mm). */
  crossLength?: number;
  /** Parts that don't overlap: the gap between them (mm), within the tolerance. */
  gap?: number;
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

/** Fillet / Chamfer features in the way of a Delete face (`blockers`), or that made the picked face (`makers`). */
export interface DeleteFaceBlockers {
  blockers: string[];
  makers: string[];
}

export type KernelRequest =
  | { type: "rebuild"; studios: StudioInput[]; variables: Record<string, number>; partNames?: Record<string, string> }
  | { type: "check"; quality: MeshQuality; partIds?: string[] }
  | { type: "exportStl"; partIds: string[]; quality: MeshQuality; instances?: InstanceInput[] }
  | { type: "exportStep"; partIds: string[]; colours?: Record<string, string>; instances?: InstanceInput[] }
  | { type: "clashes"; instances: InstanceInput[]; tolerance?: number; withGaps?: boolean }
  | { type: "project"; partIds: string[]; instances?: InstanceInput[]; views: ViewKind[]; hidden: boolean; sections?: SectionRequest[]; breakouts?: BreakOutRequest[]; tangent?: boolean }
  | { type: "measure"; picks: TopoPick[] }
  | { type: "measureParts"; partIds: string[] }
  | { type: "unfold"; partId: string }
  | { type: "deleteFaceBlockers"; features: Feature[]; featureId: string; variables: Record<string, number> }
  | { type: "export3mf"; partIds: string[]; quality: MeshQuality; title: string; colours?: Record<string, string>; instances?: InstanceInput[] };

export type KernelResponseBody =
  | { type: "rebuild"; result: RebuildResult }
  | { type: "check"; result: CheckResult }
  | { type: "exportStl"; result: ExportResult }
  | { type: "exportStep"; result: StepResult }
  | { type: "measure"; result: Measurement }
  | { type: "unfold"; result: PartMesh | null }
  | { type: "deleteFaceBlockers"; result: DeleteFaceBlockers }
  | { type: "export3mf"; result: ThreeMfResult }
  | { type: "clashes"; result: ContactMeasure[] }
  | { type: "project"; result: ViewProjection[] };

/** Messages sent from the main thread to the worker. */
export type ToWorker = { id: number; request: KernelRequest };

/** Messages sent from the worker back to the main thread. */
export type FromWorker =
  | { kind: "ready" }
  | { kind: "fatal"; error: string }
  | { kind: "response"; id: number; ok: true; body: KernelResponseBody }
  | { kind: "response"; id: number; ok: false; error: string };
