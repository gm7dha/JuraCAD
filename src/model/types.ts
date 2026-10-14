import type { TopoPick } from "../geometry/topoRef";
import type { Variable } from "./variables";
import type { HoleFit, HoleKind } from "./holes";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import type { Placement } from "../assembly/math";

/** The kinds of feature PartSmith can build. */
export type FeatureType = "box" | "cylinder" | "sphere" | "sketch" | "extrude" | "revolve" | "fillet" | "chamfer" | "shell" | "mirror" | "linearPattern" | "circularPattern" | "hole" | "transform" | "import";

export interface HoleOptions {
  sketchRef?: string;
  kind: HoleKind;
  /** Screw size such as "M4", or "Custom". */
  standard: string;
  fit: HoleFit;
  end: "blind" | "throughAll";
  /** Drill out of the face instead of into it. */
  flip: boolean;
}

/** A STEP or STL file brought in from another program, kept inside the design. */
export interface ImportedFile {
  fileName: string;
  format: "step" | "stl";
  /** STEP: the file's text. STL: the file's bytes in base64. */
  data: string;
  /** STL files have no units: what one unit in the file means. STEP files say for themselves. */
  units: "mm" | "in";
}

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
  /** Hole features: where (the points and circle centres of a sketch) and what kind. */
  hole?: HoleOptions;
  /** Transform: move and/or turn a part (or a copy of it). */
  transform?: { partId?: string; axis: Axis; about: "origin" | "centre"; copy: boolean };
  /** Linear and circular patterns: the features to repeat, and along or around which axis. */
  pattern?: { sources: string[]; axis: Axis; flip: boolean };
  /** Mirror: the features to mirror, and the plane to mirror them across. */
  mirror?: { sources: string[]; plane: SketchPlane };
  /** Import: the file, stored in the design. */
  import?: ImportedFile;
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
  /** Colour of each part ("#rrggbb"), by the id of the feature that made it. Parts without one are grey. */
  appearance?: Record<string, string>;
  /** Name of the first Part Studio (whose features are `features`); "Part Studio 1" when not set. */
  studioName?: string;
  /** More Part Studios (optional: older saves have just the one). */
  partStudios?: PartStudio[];
  /** Names given to parts, by part id (parts without one are "Part 1", "Part 2"…). */
  partNames?: Record<string, string>;
  /** Assembly tabs (optional: older saves have none). */
  assemblies?: Assembly[];
  /** Drawing tabs (optional: older saves have none). */
  drawings?: Drawing[];
}

/** Which way a drawing view looks at the part. */
export type ViewKind = "front" | "top" | "right" | "left" | "back" | "bottom" | "iso";

/** One view on a drawing sheet. */
export interface DrawingView {
  id: string;
  kind: ViewKind;
  /** Centre of the view on the sheet (mm from the bottom-left corner); missing = placed automatically. */
  at?: [number, number];
}

export type SheetSize = "A4" | "A3" | "A2";

/** A drawing tab: views of a part on a sheet, with a title block. */
export interface Drawing {
  id: string;
  name: string;
  /** The part drawn (its id), or an assembly (its id). */
  source: { kind: "part" | "assembly"; id: string } | null;
  sheet: SheetSize;
  /** Drawing scale (2 = 2:1, 0.5 = 1:2); missing = chosen to fit. */
  scale?: number;
  hiddenLines: boolean;
  views: DrawingView[];
  /** Title block entries. */
  title: { title?: string; drawnBy?: string; material?: string; notes?: string };
  /** Dimensions (optional: older saves have none). */
  dimensions?: Dimension[];
}

/**
 * A dimension on a drawing view. Points are in the view's own flat
 * coordinates (model mm), each also remembered as a fraction across the
 * view, so they can be found again when the part changes size.
 */
export interface Dimension {
  id: string;
  view: ViewKind;
  type: "horizontal" | "vertical" | "aligned" | "diameter" | "radius";
  a: DimPoint;
  /** Second point (lengths). */
  b?: DimPoint;
  /** Circle radius (diameters and radii). */
  r?: number;
  /** How far the dimension line sits from what it measures (paper mm; may be negative). For circles: leader length. */
  offset: number;
  /** Circles: direction of the leader (degrees). */
  angle?: number;
}

export interface DimPoint {
  at: [number, number];
  /** Where it is as a fraction of the view's width and height. */
  rel: [number, number];
}

/** A Part Studio tab after the first: its own list of features, making its own parts. */
export interface PartStudio {
  id: string;
  name: string;
  features: Feature[];
}

/** One copy of a part placed in an assembly. */
export interface Instance {
  id: string;
  /** The Part Studio part it shows (the id of the feature that made the part). */
  partId: string;
  /** e.g. "Part 1 <2>". */
  name: string;
  placement: Placement;
  /** Fixed instances stay where they are; others move to satisfy mates. */
  fixed: boolean;
}

/** Kinds of mate (Onshape names in brackets where they differ): Fasten, Hinge (revolute), Slider, Cylindrical, Planar, Ball. */
export type MateType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball";

/** One end of a mate: a face or edge on an instance, remembered by what it looks like. */
export interface MateConnector {
  instanceId: string;
  /** The face or edge (its partId is the Part Studio part). */
  pick: TopoPick;
}

export interface Mate {
  id: string;
  name: string;
  type: MateType;
  a: MateConnector;
  b: MateConnector;
  /** Point the two connectors the same way instead of face to face. */
  flip: boolean;
  /** Amounts as typed (angle, distance, gap…), like feature sizes. */
  values: Record<string, string>;
  suppressed?: boolean;
}

/** An assembly tab: parts placed together. */
export interface Assembly {
  id: string;
  name: string;
  instances: Instance[];
  /** How the parts are joined (optional: older saves have none). */
  mates?: Mate[];
}

/** How finely curved surfaces are turned into triangles. */
export type MeshQuality = "coarse" | "normal" | "fine";

export const MESH_TOLERANCES: Record<MeshQuality | "display", { tolerance: number; angularTolerance: number }> = {
  display: { tolerance: 0.05, angularTolerance: 0.25 },
  coarse: { tolerance: 0.1, angularTolerance: 0.5 },
  normal: { tolerance: 0.02, angularTolerance: 0.2 },
  fine: { tolerance: 0.005, angularTolerance: 0.1 },
};
