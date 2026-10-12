/** The kinds of feature PartSmith can build. Phase 1: simple solids. */
export type FeatureType = "box" | "cylinder" | "sphere";

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
}

/** One Part Studio's worth of design. Saved as a .partsmith file later (Phase 4). */
export interface PartSmithDocument {
  format: "partsmith";
  version: 1;
  name: string;
  features: Feature[];
}

/** How finely curved surfaces are turned into triangles. */
export type MeshQuality = "coarse" | "normal" | "fine";

export const MESH_TOLERANCES: Record<MeshQuality | "display", { tolerance: number; angularTolerance: number }> = {
  display: { tolerance: 0.05, angularTolerance: 0.25 },
  coarse: { tolerance: 0.1, angularTolerance: 0.5 },
  normal: { tolerance: 0.02, angularTolerance: 0.2 },
  fine: { tolerance: 0.005, angularTolerance: 0.1 },
};
