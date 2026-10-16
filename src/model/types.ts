import type { TopoPick } from "../geometry/topoRef";
import type { Variable } from "./variables";
import type { Configuration } from "./configurations";
import type { HoleFit, HoleKind } from "./holes";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import type { Placement } from "../assembly/math";

/** The kinds of feature PartSmith can build. */
export type FeatureType = "box" | "cylinder" | "sphere" | "sketch" | "extrude" | "revolve" | "fillet" | "chamfer" | "shell" | "mirror" | "linearPattern" | "circularPattern" | "curvePattern" | "hole" | "transform" | "import" | "sweep" | "loft" | "text" | "plane" | "boolean" | "split" | "thicken" | "rib" | "draft" | "moveFace" | "replaceFace" | "deleteFace" | "thread" | "deletePart" | "fastener" | "coil";

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
  /** The folder it's shown in, in the feature list (just for tidiness; doesn't change the model). */
  folder?: string;
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
  /** Delete part: the parts it removes from the Part Studio. */
  deleteParts?: string[];
  /** Fastener: which standard part, and whether its thread is modelled. */
  fastener?: { kind: "bolt" | "nut" | "washer"; size: string; threaded: boolean };
  booleanDef?: BooleanOptions;
  /** Split: which part, and the plane that cuts it in two. */
  splitDef?: SplitOptions;
  /** Thicken, Rib and Draft: which way. */
  flipSide?: boolean;
  /**
   * Replace face: the flat face or plane the picked faces are moved onto
   * (null until one is picked), and what a click in the 3D view picks.
   */
  replaceDef?: { target: SketchPlane | null; picking?: "faces" | "target" };
  /** Draft: the neutral plane (the faces pivot where they meet it; the part pulls out along its normal). */
  neutral?: SketchPlane;
  /** Transform: move and/or turn a part (or a copy of it). */
  transform?: { partId?: string; axis: Axis; about: "origin" | "centre"; copy: boolean };
  /** Linear and circular patterns: the features to repeat, and along or around which axis. */
  pattern?: { sources: string[]; axis: Axis; flip: boolean; follow?: boolean };
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
  /** Part id → material key (see materials.ts); missing = PLA. */
  materials?: Record<string, string>;
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
  /** Versions of the design (variable values and suppressed features); at least two when present. */
  configurations?: Configuration[];
  /** The configuration on show (its id). */
  activeConfiguration?: string;
}

/** Which way a drawing view looks at the part. */
/** "section" is a view of the part cut through along a line drawn on another view (see Drawing.sections). */
export type ViewKind = "front" | "top" | "right" | "left" | "back" | "bottom" | "iso" | "section" | "detail";

/** One view on a drawing sheet. */
export interface DrawingView {
  id: string;
  kind: ViewKind;
  /** Section views: which section (its id in Drawing.sections). */
  section?: string;
  /** Detail views: which detail (its id in Drawing.details). */
  detail?: string;
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
  /** Detail views (each also has an entry in `views`). */
  details?: DetailView[];
  /** Text notes placed anywhere on the sheet. */
  notes?: DrawingNote[];
  /** Section cuts drawn on the views (optional: older saves have none). */
  sections?: SectionCut[];
  /** False hides centre marks and centre lines (missing = shown). */
  centreLines?: boolean;
  /** Revision history, oldest first (shown in a table above the title block). */
  revisions?: DrawingRevision[];
  /** Tag the holes on one view and list their positions and sizes in a table. */
  holeTable?: boolean;
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
/** A detail view: a circle on a view, shown again bigger. */
export interface DetailView {
  id: string;
  /** "B", "C"… (shared with section letters). */
  letter: string;
  host: ViewKind;
  /** The circle's centre as fractions of the host view's width and height, and its radius (model mm). */
  centre: [number, number];
  radius: number;
  /** How many times bigger than the rest of the sheet. */
  zoom: number;
}

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
  /**
   * An auxiliary view instead: the whole part seen square-on to the line
   * (for showing a sloping face at its true size), not cut. Shown as "VIEW A".
   */
  aux?: boolean;
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
  type: "horizontal" | "vertical" | "aligned" | "diameter" | "radius" | "ordinate" | "angle";
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
  /** Tolerance: how much bigger (plus) or smaller (minus) it may be, mm. Equal → "±". */
  tolerance?: { plus: number; minus: number };
  /** Text before and after the number, e.g. "4× " or " TYP". */
  prefix?: string;
  suffix?: string;
  /** Ordinate dimensions: measured across ("h") or up-and-down ("v"). */
  axis?: "h" | "v";
  /** Diameters: a hole callout — the hole's full description (count, depth, counterbore…) instead of just its size. */
  callout?: boolean;
  /** Angles: the second edge's ends (the first edge is a–b). */
  c?: DimPoint;
  d?: DimPoint;
  /** Angles: which way along each edge the measured angle opens (1 = towards its second end, -1 = away). */
  rays?: [number, number];
}

/** A note on a drawing sheet: its top-left corner (sheet mm, y up) and its lines of text. */
export interface DrawingNote {
  id: string;
  at: [number, number];
  text: string;
  /** A drawing symbol (datum, feature control frame, surface finish) instead of plain text. */
  symbol?: DrawingSymbol;
  /** Where its leader line points (sheet mm). */
  leader?: [number, number];
}

/** Geometric tolerance characteristics (GD&T). */
export type GdtCharacteristic =
  | "straightness"
  | "flatness"
  | "circularity"
  | "cylindricity"
  | "profileLine"
  | "profileSurface"
  | "perpendicularity"
  | "parallelism"
  | "angularity"
  | "position"
  | "concentricity"
  | "symmetry"
  | "runout"
  | "totalRunout";

export type DrawingSymbol =
  /** A datum feature symbol: a letter in a box, on a triangle touching the surface. */
  | { kind: "datum"; letter: string }
  /** A feature control frame: the characteristic, its tolerance (Ø for a round zone) and the datums it's measured from. */
  | { kind: "fcf"; characteristic: GdtCharacteristic; tolerance: string; diameter?: boolean; datums: string[] }
  /** A surface finish mark: the roughness (Ra, µm), and whether it's machined (the bar across). */
  | { kind: "finish"; ra: string; machined?: boolean };

export interface DimPoint {
  at: [number, number];
  /** Where it is as a fraction of the view's width and height. */
  rel: [number, number];
}

/** One change to a drawing: its letter (or number), what changed, and when. */
export interface DrawingRevision {
  id: string;
  rev: string;
  description: string;
  date: string;
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
  /** A copy made by a pattern: which pattern, the instance it copies, and which copy it is (1 = next to the original). */
  copyOf?: { pattern: string; seed: string; index: number };
  /** Show the part in this configuration (its id) instead of the one on show in the Part Studio. */
  configuration?: string;
  /** A copy made by Replicate: which replicate, and which of its copies (1, 2…). */
  replicaOf?: { replicate: string; index: number };
}

/**
 * Replicate (as in Onshape): a part mated into one hole, copied into every
 * other matching hole of the part it's mated to — each copy with its own mate.
 */
export interface Replicate {
  id: string;
  name: string;
  /** The original instance and the mate holding it in its hole. */
  seed: string;
  mate: string;
}

/**
 * Copies of some instances, repeated in a line or round an axis (Onshape's
 * linear and circular patterns in an assembly). The copies are ordinary
 * instances (`copyOf` says where they came from) that follow their original.
 */
export interface AssemblyPattern {
  id: string;
  name: string;
  kind: "linear" | "circular";
  /** The instances repeated. */
  seeds: string[];
  /** How many in each row, including the original. */
  count: number;
  /** Linear: the gap from one copy to the next (mm); circular: the angle they're spread over (360 = evenly all the way round). Typed values. */
  amount: string;
  /** The direction (linear) or the axis turned about (circular). */
  axis: "x" | "y" | "z";
  /** Go the other way. */
  flip?: boolean;
  /** Circular: a point the axis passes through (mm). */
  centre?: [number, number, number];
}

/** Kinds of mate (Onshape names in brackets where they differ): Fasten, Hinge (revolute), Slider, Cylindrical, Planar, Ball. */
export type MateType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "pinSlot" | "parallel" | "width";

/** One end of a mate: a face or edge on an instance, remembered by what it looks like. */
export interface MateConnector {
  instanceId: string;
  /** The face or edge (its partId is the Part Studio part). */
  pick: TopoPick;
  /** Width mates: the second flat face; the connector sits halfway between the two. */
  pick2?: TopoPick;
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
  /** Made by Replicate (its id) for one of its copies. */
  replicateOf?: string;
}

/** A saved arrangement of an assembly: each mate's amounts as they were. */
export interface NamedPosition {
  id: string;
  name: string;
  values: Record<string, Record<string, string>>;
}

/** One mate's movement driving another's (gears, rack and pinion, screws). */
export interface MateRelation {
  id: string;
  name: string;
  kind: "gear" | "rack" | "screw";
  /** The mate that turns (a hinge). */
  driver: string;
  /** The mate it moves. */
  driven: string;
  /** Gear ratio, pinion radius (mm) or travel per turn (mm), as typed. */
  ratio: string;
  reverse?: boolean;
}

/** An assembly tab: parts placed together. */
export interface Assembly {
  id: string;
  name: string;
  instances: Instance[];
  /** How the parts are joined (optional: older saves have none). */
  mates?: Mate[];
  /** Saved positions: each mate's amounts, to go back to (Onshape's named positions). */
  positions?: NamedPosition[];
  /** Mates driving other mates (gears, rack and pinion, screws). */
  relations?: MateRelation[];
  /** Exploded view: how far the parts are spread apart (1 = their distance from the middle again); missing = together. */
  explode?: number;
  /** Patterns of instances (optional: older saves have none). */
  patterns?: AssemblyPattern[];
  /** Parts copied into matching holes (optional: older saves have none). */
  replicates?: Replicate[];
  /** Parts locked together so they move as one (optional: older saves have none). */
  groups?: AssemblyGroup[];
}

/** Parts locked together where they were when grouped (Onshape's Group mate). */
export interface AssemblyGroup {
  id: string;
  name: string;
  /** The parts (instance ids); the first is the one the others are kept relative to. */
  members: string[];
  /** Where each other member sits relative to the first. */
  offsets: Record<string, import("../assembly/math").Placement>;
}

/** How finely curved surfaces are turned into triangles. */
export type MeshQuality = "coarse" | "normal" | "fine";

export const MESH_TOLERANCES: Record<MeshQuality | "display", { tolerance: number; angularTolerance: number }> = {
  display: { tolerance: 0.05, angularTolerance: 0.25 },
  coarse: { tolerance: 0.1, angularTolerance: 0.5 },
  normal: { tolerance: 0.02, angularTolerance: 0.2 },
  fine: { tolerance: 0.005, angularTolerance: 0.1 },
};
