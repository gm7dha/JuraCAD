/**
 * Sketch data. Everything is stored in the sketch's own 2D coordinates (u, v)
 * in millimetres; `planes.ts` maps them into 3D.
 *
 * Points carry their current (solved) positions, so the geometry engine can
 * build solids without re-running the solver.
 */

/** ID of the fixed sketch origin point (0, 0). It is never stored in `points`. */
export const ORIGIN_ID = "origin";

export interface SketchPoint {
  id: string;
  x: number;
  y: number;
  /** A point the user placed on its own (not just a line or arc end). */
  standalone?: boolean;
}

export interface SketchLine {
  id: string;
  type: "line";
  p1: string;
  p2: string;
  construction: boolean;
}

export interface SketchCircle {
  id: string;
  type: "circle";
  center: string;
  radius: number;
  construction: boolean;
}

/** Arc running anticlockwise from `start` to `end` around `center`. */
export interface SketchArc {
  id: string;
  type: "arc";
  center: string;
  start: string;
  end: string;
  construction: boolean;
}

export type SketchCurve = SketchLine | SketchCircle | SketchArc;

/** Geometric relationships (no value). */
export type RelationType =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "concentric"
  | "midpoint"
  | "pointOnLine"
  | "pointOnCircle"
  | "fix";

/** Dimensions (have a value the user types). */
export type DimensionType = "distance" | "length" | "horizontalDistance" | "verticalDistance" | "radius" | "diameter" | "angle" | "pointLineDistance";

export type ConstraintType = RelationType | DimensionType;

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  /** IDs of the points / curves involved, in a type-specific order (see solver.ts). */
  refs: string[];
  /** Dimensions only: the value as typed, e.g. "20" or "10 + 5" (mm, or degrees for angles). */
  value?: string;
  /**
   * Extra numbers some constraints need, captured when they're created:
   *  - fix: [x, y] position to hold
   *  - horizontal/verticalDistance: [sign] so the dimension keeps its direction
   *  - angle: [sign] which way round the angle is measured
   *  - tangent (circle–circle): [1] internal, [0] external
   */
  extra?: number[];
  /** Dimensions only: where the label sits, relative to the measured geometry (sketch mm). */
  labelOffset?: { x: number; y: number };
}

export interface SketchData {
  points: SketchPoint[];
  curves: SketchCurve[];
  constraints: SketchConstraint[];
}

export const emptySketch = (): SketchData => ({ points: [], curves: [], constraints: [] });

export const DIMENSION_TYPES: ReadonlySet<ConstraintType> = new Set<ConstraintType>([
  "distance",
  "length",
  "horizontalDistance",
  "verticalDistance",
  "radius",
  "diameter",
  "angle",
  "pointLineDistance",
]);

export const isDimension = (c: SketchConstraint) => DIMENSION_TYPES.has(c.type);
