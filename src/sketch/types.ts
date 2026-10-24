import type { TopoPick } from "../geometry/topoRef";

/**
 * Sketch data. Everything is stored in the sketch's own 2D coordinates (u, v)
 * in millimetres; `planes.ts` maps them into 3D.
 *
 * Points carry their current (solved) positions, so the geometry engine can
 * build solids without re-running the solver.
 */

/** ID of the fixed sketch origin point (0, 0). It is never stored in `points`. */
export const ORIGIN_ID = "origin";

/**
 * A line, circle or arc can follow a part's edge (Onshape's "Use", or an edge
 * of the face the sketch is on used as a reference): the edge it came from, found
 * again on every rebuild so the copy moves when the part changes.
 */
export type CurveLink = TopoPick;

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
  /** Follows this part edge (see CurveLink). */
  link?: CurveLink;
}

export interface SketchCircle {
  id: string;
  type: "circle";
  center: string;
  radius: number;
  construction: boolean;
  /** Follows this part edge (see CurveLink). */
  link?: CurveLink;
}

/** Arc running anticlockwise from `start` to `end` around `center`. */
export interface SketchArc {
  id: string;
  type: "arc";
  center: string;
  start: string;
  end: string;
  construction: boolean;
  /** Follows this part edge (see CurveLink). */
  link?: CurveLink;
}

/**
 * A smooth curve through its points, in order (closed: joined back to the first).
 * With `conic` it's a conic instead: from its first point to its last, pulled
 * towards the middle one (the corner) by that amount (0.5 = a parabola).
 */
export interface SketchSpline {
  id: string;
  type: "spline";
  points: string[];
  closed: boolean;
  construction: boolean;
  conic?: number;
  /**
   * Handles the user has dragged: for a point's id, the curve's direction and
   * speed there (a tangent vector, mm). Points not listed curve smoothly on
   * their own.
   */
  tangents?: Record<string, [number, number]>;
}

/** An ellipse: its centre and the ends of its two axes (kept square to each other). */
export interface SketchEllipse {
  id: string;
  type: "ellipse";
  center: string;
  major: string;
  minor: string;
  construction: boolean;
}

export type SketchCurve = SketchLine | SketchCircle | SketchArc | SketchSpline | SketchEllipse;

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
  | "symmetric"
  | "pointOnLine"
  | "pointOnCircle"
  /** A point held on a spline or ellipse: refs [point, curve]. */
  | "pointOnCurve"
  | "fix"
  /**
   * A circular pattern's copy of a point: refs [copy, original, centre]; extra [degrees].
   * The copy stays the original turned that far round the centre, so the
   * pattern follows when either moves.
   */
  | "patternCopy";

/** Dimensions (have a value the user types). */
export type DimensionType =
  | "distance"
  | "length"
  | "horizontalDistance"
  | "verticalDistance"
  | "radius"
  | "diameter"
  | "angle"
  | "pointLineDistance"
  /** How far an offset copy is from what it was copied from. refs: pairs of [copy, original] curves (lines, arcs, circles). */
  | "offset"
  /** How long an arc is, measured round it. refs: [arc]. */
  | "arcLength"
  /** How far round an arc goes, in degrees. refs: [arc]. */
  | "arcAngle"
  /**
   * The gap between two circles or arcs, or one and a line, measured to their
   * edges rather than their centres. refs: [circle or arc, circle, arc or line];
   * extra: [-1 nearest edges / +1 furthest edges, 1 when one circle is inside the other].
   */
  | "rimDistance";

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
   * Symmetric: refs are [point, point, mirror line].
   */
  extra?: number[];
  /** Dimensions only: where the label sits, relative to the measured geometry (sketch mm). */
  labelOffset?: { x: number; y: number };
  /**
   * Dimensions only: a reference ("driven") dimension. It shows the size as it
   * is, in brackets, and never changes the sketch; its value follows the geometry.
   */
  driven?: boolean;
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
  "offset",
  "arcLength",
  "arcAngle",
  "rimDistance",
]);

/** Dimensions measured in degrees (the rest are lengths). */
export const isAngleDimension = (c: Pick<SketchConstraint, "type">) => c.type === "angle" || c.type === "arcAngle";

export const isDimension = (c: SketchConstraint) => DIMENSION_TYPES.has(c.type);
