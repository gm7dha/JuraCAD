import type { TopoPick } from "../geometry/topoRef";
import type { Variable } from "./variables";
import type { HoleFit, HoleKind } from "./holes";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import type { Placement } from "../assembly/math";

/** The kinds of feature PartSmith can build. */
export type FeatureType = "box" | "cylinder" | "sphere" | "sketch" | "extrude" | "revolve" | "fillet" | "chamfer" | "shell" | "mirror" | "linearPattern" | "circularPattern" | "hole" | "transform" | "import" | "sweep" | "loft" | "text" | "plane" | "boolean" | "split" | "thicken" | "rib" | "draft" | "moveFace" | "deleteFace" | "thread";

/**
 * A construction plane: a set distance from a plane or flat face ("offset"),
 * tilted about one of its directions ("angle"), or halfway between two
 * parallel faces ("midplane").
 */
export interface PlaneOptions {
  mode: "offset" | "angle" | "midplane";
  ref: SketchPlane;
  /** Midplane: the second face. */
  ref2?: SketchPlane;
  /** Angle: tilt about the reference's across (u) or up (v) direction. */
  axis: "u" | "v";
}

/**
 * Join parts into one ("union"), cut some parts with others ("subtract"), or
 * keep only where parts overlap ("intersect"), like Onshape's Boolean.
 */
export interface BooleanOptions {
  op: "union" | "subtract" | "intersect";
  /** The parts joined or intersected, or (subtract) the parts that are cut. */
  targets: string[];
  /** Subtract: the parts that do the cutting. */
  tools: string[];
  /** Subtract: keep the cutting parts too (otherwise they're used up). */
  keepTools: boolean;
  /** Which list a click in the 3D view adds to (subtract). */
  picking?: "targets" | "tools";
}

/** Split a part in two along a plane (or keep just one side). */
export interface SplitOptions {
  partId?: string;
  plane: SketchPlane;
  /** Keep both pieces as separate parts, or only the piece on the plane's front (normal) or back side. */
  keep: "both" | "front" | "back";
  /** What a click in the 3D view picks. */
  picking?: "part" | "plane";
}

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
export type ExtrudeEnd = "blind" | "symmetric" | "throughAll" | "upToFace";

/**
 * How a feature's solid combines with what's already there (like Onshape's
 * New / Add / Remove):
 *  - new:    becomes a new part
 *  - add:    merges into the most recent part
 *  - remove: is cut away from the most recent part
 */
/** What a feature does with its solid: a new part, added to the latest part, cut from it, or kept only where they overlap. */
export type Operation = "new" | "add" | "remove" | "intersect";

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
  /** Extrude, revolve and sweep (its profile): the sketch feature to use. */
  sketchRef?: string;
  /** Sweep: the sketch whose lines and arcs make the path. */
  pathRef?: string;
  /** Loft: the sketches to pass through, in order. */
  sections?: string[];
  /** Text: what it says, where it goes, and how. */
  text?: {
    value: string;
    plane: SketchPlane | null;
    bold: boolean;
    flip: boolean;
    /** Round (cylinder) face the text wraps around, instead of a plane. */
    face?: TopoPick;
  };
  /** Extrude features: one way or symmetric, and whether to flip. */
  extrude?: { end: ExtrudeEnd; flip: boolean; /** Up to face: the flat face to stop at. */ upTo?: TopoPick };
  /** Revolve features: the line to spin around ("vertical"/"horizontal" sketch axes, or a sketch line id) and which way. */
  revolve?: { axis: string; flip: boolean };
  /** Hole features: where (the points and circle centres of a sketch) and what kind. */
  hole?: HoleOptions;
  /** Plane features: where the plane is. */
  planeDef?: PlaneOptions;
  /** Boolean features: which parts, and what to do with them. */
  booleanDef?: BooleanOptions;
  /** Split: which part, and the plane that cuts it in two. */
  splitDef?: SplitOptions;
  /** Thicken, Rib and Draft: which way. */
  flipSide?: boolean;
  /** Draft: the neutral plane (the faces pivot where they meet it; the part pulls out along its normal). */
  neutral?: SketchPlane;
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
  /** Units shown and typed: inches, or (missing) millimetres. The model itself is always in millimetres. */
  units?: "in";
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
/** "section" is a view of the part cut through along a line drawn on another view (see Drawing.sections). */
export type ViewKind = "front" | "top" | "right" | "left" | "back" | "bottom" | "iso" | "section";

/** One view on a drawing sheet. */
export interface DrawingView {
  id: string;
  kind: ViewKind;
  /** Section views: which section (its id in Drawing.sections). */
  section?: string;
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
  /** Section cuts drawn on the views (optional: older saves have none). */
  sections?: SectionCut[];
  /** False hides centre marks and centre lines (missing = shown). */
  centreLines?: boolean;
  /** False hides the numbered balloons on assembly drawings (missing = shown). */
  balloons?: boolean;
  /** Assembly drawings: show the parts spread apart (the assembly's exploded view). */
  exploded?: boolean;
}

/**
 * A section: a cutting line drawn across one of the flat views (front, top…).
 * The part is cut along it, straight through, and the cut is shown as its own
 * view ("SECTION A-A"). The line's ends are kept as fractions across the
 * view it's drawn on, so the cut stays in the same place on the part when it
 * changes size.
 */
export interface SectionCut {
  id: string;
  /** "A", "B"… */
  letter: string;
  /** The view the cutting line is drawn on. */
  host: ViewKind;
  /** The line's ends, as fractions of the host view's width and height. */
  a: [number, number];
  b: [number, number];
  /** Look the other way (keep the other side of the cut). */
  flip?: boolean;
}

/**
 * A dimension on a drawing view. Points are in the view's own flat
 * coordinates (model mm), each also remembered as a fraction across the
 * view, so they can be found again when the part changes size.
 */
export interface Dimension {
  id: string;
  /** The view it's on: its kind, or "section:<id>" for a section view. */
  view: string;
  /** "ordinate": just the distance from datum `a` to point `b`, along `axis`, at the end of a leader. */
  type: "horizontal" | "vertical" | "aligned" | "diameter" | "radius" | "ordinate";
  a: DimPoint;
  /** Second point (lengths). */
  b?: DimPoint;
  /** Circle radius (diameters and radii). */
  r?: number;
  /** How far the dimension line sits from what it measures (paper mm; may be negative). For circles: leader length. */
  offset: number;
  /** Circles: direction of the leader (degrees). */
  angle?: number;
  /** Lengths: how far the number has been slid along the dimension line from the middle (paper mm). */
  textAlong?: number;
  /** Lengths: how far the number has been lifted off the dimension line (paper mm, + = above as read; joined by a leader). */
  textAcross?: number;
  /** Ordinate dimensions: measured across ("h") or up-and-down ("v"). */
  axis?: "h" | "v";
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
  /** How far each movement may go (typed like the amounts; blank = no limit). */
  limits?: Record<string, { min?: string; max?: string }>;
  suppressed?: boolean;
}

/** An assembly tab: parts placed together. */
export interface Assembly {
  id: string;
  name: string;
  instances: Instance[];
  /** How the parts are joined (optional: older saves have none). */
  mates?: Mate[];
  /** Exploded view: how far the parts are spread apart (1 = their distance from the middle again); missing = together. */
  explode?: number;
}

/** How finely curved surfaces are turned into triangles. */
export type MeshQuality = "coarse" | "normal" | "fine";

export const MESH_TOLERANCES: Record<MeshQuality | "display", { tolerance: number; angularTolerance: number }> = {
  display: { tolerance: 0.05, angularTolerance: 0.25 },
  coarse: { tolerance: 0.1, angularTolerance: 0.5 },
  normal: { tolerance: 0.02, angularTolerance: 0.2 },
  fine: { tolerance: 0.005, angularTolerance: 0.1 },
};
