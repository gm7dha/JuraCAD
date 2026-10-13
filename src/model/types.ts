import type { TopoPick } from "../geometry/topoRef";
import type { Variable } from "./variables";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";

/** The kinds of feature PartSmith can build. */
export type FeatureType = "box" | "cylinder" | "sphere" | "sketch" | "extrude" | "revolve" | "fillet" | "chamfer" | "shell" | "mirror" | "linearPattern" | "circularPattern";

/** A world axis, for patterns. */
export type Axis = "x" | "y" | "z";

/** How an extrude runs: one way from the sketch (optionally flipped), or equally both ways. */
export type ExtrudeEnd = "blind" | "symmetric" | "throughAll";

/**
 * How a feature's solid combines with what's already there (like Onshape's
 * New / Add / Remove):
 *  - new:    becomes a new part
 *  - add:    merges into the most recent part
 *  - remove: is cut away from the most recent part
 */
export type Operation = "new" | "add" | "remove";

export interface Feature {
  /** Permanent ID, never reused. */
  id: string;
  /** Name shown in the feature list, e.g. "Box 1". */
  name: string;
  type: FeatureType;
  operation: Operation;
  /** When true the feature is skipped during rebuild (greyed out in the list). */
  suppressed: boolean;
  /** Parameter values as typed, e.g. { width: "20", height: "10 + 5" }. */
  params: Record<string, string>;
  /** Sketch features: where the sketch is and what's drawn. A null plane means "not chosen yet". */
  sketch?: { plane: SketchPlane | null; data: SketchData };
  /** Extrude features: the sketch feature to extrude. */
  sketchRef?: string;
  /** Extrude features: one way or symmetric, and whether to flip. */
  extrude?: { end: ExtrudeEnd; flip: boolean };
  /** Revolve features: the line to spin around ("vertical"/"horizontal" sketch axes, or a sketch line id) and which way. */
  revolve?: { axis: string; flip: boolean };
  /** Linear and circular patterns: the features to repeat, and along or around which axis. */
  pattern?: { sources: string[]; axis: Axis; flip: boolean };
  /** Mirror: the features to mirror, and the plane to mirror them across. */
  mirror?: { sources: string[]; plane: SketchPlane };
  /** Fillet and chamfer: the edges (or faces, meaning all their edges) to round or bevel. Shell: the faces to remove. */
  picks?: TopoPick[];
}

/** One Part Studio's worth of design. Saved as a .partsmith file later (Phase 4). */
export interface PartSmithDocument {
  format: "partsmith";
  version: 1;
  name: string;
  features: Feature[];
  /** Named sizes usable in any box (optional: older saves have none). */
  variables?: Variable[];
}

/** How finely curved surfaces are turned into triangles. */
export type MeshQuality = "coarse" | "normal" | "fine";

export const MESH_TOLERANCES: Record<MeshQuality | "display", { tolerance: number; angularTolerance: number }> = {
  display: { tolerance: 0.05, angularTolerance: 0.25 },
  coarse: { tolerance: 0.1, angularTolerance: 0.5 },
  normal: { tolerance: 0.02, angularTolerance: 0.2 },
  fine: { tolerance: 0.005, angularTolerance: 0.1 },
};
