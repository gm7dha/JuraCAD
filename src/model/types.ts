import type { AreaPick } from "../sketch/areas";
import type { FastenerKind } from "./fasteners";
import type { TopoPick } from "../geometry/topoRef";
import type { Variable } from "./variables";
import type { Configuration } from "./configurations";
import type { HoleFit, HoleKind } from "./holes";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import type { Placement } from "../assembly/math";
import type { SketchLineRef } from "./patternRefs";

/** The kinds of feature JuraCAD can build. */
export type FeatureType = "box" | "cylinder" | "sphere" | "sketch" | "extrude" | "revolve" | "fillet" | "chamfer" | "shell" | "mirror" | "linearPattern" | "circularPattern" | "curvePattern" | "hole" | "transform" | "import" | "sweep" | "loft" | "text" | "plane" | "boolean" | "split" | "thicken" | "rib" | "draft" | "moveFace" | "replaceFace" | "deleteFace" | "thread" | "deletePart" | "fastener" | "coil" | "sheetMetal" | "flange" | "hem" | "tab" | "fullRound" | "derived" | "wrap" | "fill" | "enclose" | "offsetSurface" | "extendSurface" | "ruled" | "cornerBreak" | "bend" | "jog";

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
  /** Split with a surface part (picked by clicking it) instead of the plane. */
  toolPartId?: string;
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
  /**
   * How deep: a set depth, right through (one way; `bothWays` for both), or
   * through the first wall the drill meets ("upToNext").
   */
  end: "blind" | "throughAll" | "upToNext";
  /** Drill out of the face instead of into it. */
  flip: boolean;
  /** Tapped holes: cut a real helical thread into the wall (for 3D printing) instead of just the tap-drill hole. */
  modelThread?: boolean;
  /** Through all: drill both ways from the sketch (for a sketch on a plane inside the part). Off: one way, as Onshape. */
  bothWays?: boolean;
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

/**
 * How an extrude runs: one way from the sketch (optionally flipped), equally
 * both ways, right through, or up to something — a face (flat or curved), the
 * next face it meets, a corner (vertex) or a part.
 */
export type ExtrudeEnd = "blind" | "symmetric" | "throughAll" | "upToFace" | "upToNext" | "upToVertex" | "upToPart";

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
  /**
   * Sketches and Plane features: shown in the 3D view (true) or hidden (false),
   * set with the eye in the feature list. Missing = automatic, as in Onshape: a
   * plane is shown, and a sketch is shown until a feature uses it (see visibility.ts).
   */
  visible?: boolean;
  /** Parameter values as typed, e.g. { width: "20", height: "10 + 5" }. */
  params: Record<string, string>;
  /** Sketch features: where the sketch is and what's drawn. A null plane means "not chosen yet". */
  sketch?: { plane: SketchPlane | null; data: SketchData };
  /** Extrude, revolve and sweep (its profile): the sketch feature to use. */
  sketchRef?: string;
  /**
   * Extrude, revolve and sweep: the areas of the sketch to use, each remembered
   * by a point inside it (sketch mm) and its size (mm²; older picks have just
   * the point), matched again on rebuild (see `matchArea`). Missing or empty:
   * every closed shape.
   */
  areas?: AreaPick[];
  /**
   * Extrude, revolve, sweep and hole: Onshape-style parts. With New, each
   * separate piece is its own part; with Add, each piece joins every part it
   * touches (merged into the oldest), or is a new part if it touches none;
   * with Remove (and holes), it cuts every solid part it reaches. Set on
   * features made since this was added; missing (older files) keeps the old
   * rules (one part; Add and Remove work on the latest part), so old designs
   * rebuild exactly as before.
   */
  apart?: boolean;
  /**
   * Extrude, revolve and sweep made since v0.29: Intersect keeps, in every
   * solid part the feature reaches, only the overlap (as Remove cuts every part
   * it reaches). Missing (older files): Intersect works on the latest part only.
   */
  intersectAll?: boolean;
  /**
   * Extrude: areas from other sketches as well as `sketchRef`'s (as Onshape
   * lets one extrude use regions of several sketches). Each is extruded from
   * its own sketch with the same settings. Missing: just `sketchRef`.
   */
  moreAreas?: { sketch: string; areas: AreaPick[] }[];
  /** Sweep: the sketch whose lines and arcs make the path. */
  pathRef?: string;
  /**
   * Sweep: how the profile is carried. `lockOrientation` keeps it facing the
   * same way all along, like Onshape's "Keep profile orientation" (then any
   * twist is ignored). Missing: it turns to follow the path, as before.
   * (The twist itself is the "twist" box, in degrees.)
   */
  sweepControl?: { lockOrientation?: boolean };
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
  extrude?: {
    end: ExtrudeEnd;
    flip: boolean;
    /**
     * Up to face: the face to stop at (flat or curved). Up to vertex: an edge,
     * whose end `upToEnd` ("a" or "b", as in the edge's ref) is the corner.
     * Up to part: any face of the part.
     */
    upTo?: TopoPick;
    upToEnd?: "a" | "b";
    /** One way (blind): also extrude the other way from the sketch, by the second depth (`depth2`). */
    second?: boolean;
  };
  /** Revolve features: the line to spin around ("vertical"/"horizontal" sketch axes, or a sketch line id) and which way. */
  revolve?: {
    axis: string;
    flip: boolean;
    /** Spin both ways from the sketch, half the angle each way. */
    symmetric?: boolean;
  };
  /**
   * Chamfer: an equal bevel (missing), two different distances, or a distance
   * and an angle. The first distance runs along the face that was clicked (or,
   * for an edge, the face beside it that faces most upwards); `flipSide` swaps.
   */
  chamferType?: "twoDistances" | "distanceAngle";
  /** Hole features: where (the points and circle centres of a sketch) and what kind. */
  hole?: HoleOptions;
  /** Plane features: where the plane is. */
  planeDef?: PlaneOptions;
  /** Boolean features: which parts, and what to do with them. */
  /** Delete part: the parts it removes from the Part Studio. */
  deleteParts?: string[];
  /** Fastener: which standard part, and whether its thread is modelled. */
  /** Extrude, Revolve, Sweep, Loft: make a thin surface (a skin with no inside) instead of a solid. */
  surface?: boolean;
  /** Derived: a part from another Part Studio (its id there), brought into this one. */
  derived?: { studioId: string; partId: string };
  fastener?: { kind: FastenerKind; size: string; threaded: boolean };
  booleanDef?: BooleanOptions;
  /** Split: which part, and the plane that cuts it in two. */
  splitDef?: SplitOptions;
  /** Thicken, Rib and Draft: which way. */
  flipSide?: boolean;
  /** Delete face: leave the hole open instead of healing it (a solid part becomes a surface). */
  leaveOpen?: boolean;
  /** Corner break: round the corners off (missing) or cut them off straight. */
  breakStyle?: "chamfer";
  /** Fill: meet the faces beside the edges smoothly (tangent to them) instead of at an angle. */
  continuity?: "tangent";
  /** Thicken: half the thickness each side of the face or surface (then which way doesn't matter). */
  bothSides?: boolean;
  /** Shell: hollow the part closed inside, keeping every face (no opening), whatever faces are picked. (Shell's `flipSide` puts the walls outside the part.) */
  hollow?: boolean;
  /** Flange: close the corners where these flanges meet other full-length right-angle flanges. */
  closeCorners?: boolean;
  /** Flange and Hem: mitre the corners where these meet flanges or hems on the next edges (trimmed along the corner's diagonal, `cornerGap` apart). */
  mitreCorners?: boolean;
  /** Extend surface: how far — up to a face (a flat face counts as its whole plane) or a solid part, instead of by a distance; `target` is a face picked on it. */
  extendTo?: { mode: "face" | "part"; target?: TopoPick };
  /** Bend and Jog: keep the other side of the line still (normally the smaller piece moves). */
  keepOtherSide?: boolean;
  /** Flange: the shape of the bend relief notches (missing = rectangle) and the relief cut where flanges meet at a corner. */
  reliefShape?: "rectangle" | "round" | "tear";
  cornerRelief?: "round" | "square";
  /** Flange: where it goes — bent off the edge (missing), or its outside or inside face flush with the edge (the sheet keeps its size). */
  flangePosition?: "outside" | "inside";
  /**
   * Replace face: the flat face or plane the picked faces are moved onto
   * (null until one is picked), and what a click in the 3D view picks.
   */
  replaceDef?: { target: SketchPlane | null; picking?: "faces" | "target" };
  /** Draft: the neutral plane (the faces pivot where they meet it; the part pulls out along its normal). Ruled surface: the strips run along this plane's normal. */
  neutral?: SketchPlane;
  /** Transform: move and/or turn a part (or a copy of it). */
  transform?: { partId?: string; axis: Axis; about: "origin" | "centre"; copy: boolean };
  /**
   * Linear and circular patterns: the features to repeat, and along or around
   * which axis (a circular pattern's axis passes through its cx, cy, cz).
   * Linear: `axis2`/`flip2` are the second direction of a grid (with `count2`
   * rows, `spacing2` apart).
   */
  pattern?: {
    sources: string[];
    axis: Axis;
    flip: boolean;
    follow?: boolean;
    axis2?: Axis;
    flip2?: boolean;
    /**
     * Picked in the 3D view instead of `axis`: a linear pattern's direction
     * (a straight edge, or a flat face's normal); a circular pattern's axis
     * (a round face or edge, or a straight edge). Followed as the part changes.
     */
    along?: TopoPick;
    /** Linear grid: the second direction picked in the 3D view instead of `axis2`. */
    along2?: TopoPick;
    /** A sketch line instead of `axis`/`along`: a linear pattern goes along it (as drawn), a circular one round it. */
    line?: SketchLineRef;
    /** Linear grid: the rows go along this sketch line. */
    line2?: SketchLineRef;
    /** Nothing chosen yet for the direction or axis (a new circular pattern, or cleared): it asks for one. */
    unset?: boolean;
    /** Copies left out, by number (the original is 1; in a grid, row by row). */
    skip?: number[];
    /** While editing a grid: a click in the 3D view sets the rows' direction (`along2`) instead of `along`. Not saved. */
    picking?: "along2";
  };
  /**
   * Mirror: the features to mirror, and the plane to mirror them across. Or,
   * with `part`, a whole part mirrored: as a new part, or joined onto the
   * original (`join`) — model half, mirror the rest.
   */
  mirror?: {
    sources: string[];
    /** The plane (for a clicked face or line: where it was when picked — the engine finds it again). */
    plane: SketchPlane;
    /** A flat face of a part clicked as the plane: followed as the part changes. */
    planePick?: TopoPick;
    /** A sketch line: mirrors across the plane through it, square to its sketch. */
    line?: SketchLineRef;
    /** No plane chosen yet (a new mirror, or cleared): it asks for one. */
    unset?: boolean;
    part?: string;
    join?: boolean;
  };
  /** Import: the file, stored in the design. */
  import?: ImportedFile;
  /** Fillet and chamfer: the edges (or faces, meaning all their edges) to round or bevel. Shell: the faces to remove. */
  picks?: TopoPick[];
}

/**
 * The app's old name for JuraCADDocument (the app used to be called PartSmith),
 * kept so work started before the rename still compiles. Use JuraCADDocument.
 * @deprecated
 */
export type PartSmithDocument = JuraCADDocument;

/** The whole design, as saved in a .juracad file. */
export interface JuraCADDocument {
  /**
   * Saved-file format id. It stays "partsmith" (the app's old name) so files
   * saved now still open in older versions, and older files keep opening.
   */
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
  /** Of the Origin and the Top/Front/Right planes, the ones hidden in the first Part Studio (missing = all shown). */
  hiddenDatums?: DatumName[];
  /** More Part Studios (optional: older saves have just the one). */
  partStudios?: PartStudio[];
  /** Names given to parts, by part id (parts without one are "Part 1", "Part 2"…). */
  partNames?: Record<string, string>;
  /** Part number, description and your own properties, by part id — shown in assembly parts lists. */
  partProperties?: Record<string, PartProperties>;
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
export type ViewKind = "front" | "top" | "right" | "left" | "back" | "bottom" | "iso" | "section" | "detail" | "flat";

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
  /** This view's own scale (2 = 2:1), noted under it; missing = the sheet's scale. */
  scale?: number;
}

/** ISO paper sizes, and the US (ANSI) sizes: A = 11 × 8.5 in (Letter), B = 17 × 11 in, and so on. */
export type SheetSize = "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI A" | "ANSI B" | "ANSI C" | "ANSI D" | "ANSI E";

/** A drawing tab: views of a part on a sheet, with a title block. */
export interface Drawing {
  id: string;
  name: string;
  /** The part drawn (its id), or an assembly (its id). */
  source: { kind: "part" | "assembly"; id: string } | null;
  sheet: SheetSize;
  /**
   * How the views are arranged: "third" = third-angle (US/ANSI: the top view
   * above the front, the right view to its right); missing = first-angle
   * (ISO, UK and Europe: the top view below, the right view to the left).
   */
  projection?: "third";
  /** Drawing scale (2 = 2:1, 0.5 = 1:2); missing = chosen to fit. */
  scale?: number;
  hiddenLines: boolean;
  views: DrawingView[];
  /** Title block entries. */
  title: { title?: string; drawnBy?: string; material?: string; notes?: string; partNumber?: string; company?: string };
  /** Dimensions (optional: older saves have none). */
  dimensions?: Dimension[];
  /** Detail views (each also has an entry in `views`). */
  details?: DetailView[];
  /** Text notes placed anywhere on the sheet. */
  notes?: DrawingNote[];
  /** Section cuts drawn on the views (optional: older saves have none). */
  sections?: SectionCut[];
  /** Broken-out cuts on views (optional: older saves have none). */
  breakouts?: BreakOut[];
  /** Shortened views: bands taken out of long views (optional: older saves have none). */
  shortened?: Shortening[];
  /** False hides centre marks and centre lines (missing = shown). */
  centreLines?: boolean;
  /** False hides the thread symbols on tapped holes (missing = shown). */
  threadSymbols?: boolean;
  /** Revision history, oldest first (shown in a table above the title block). */
  revisions?: DrawingRevision[];
  /** Tag the holes on one view and list their positions and sizes in a table. */
  holeTable?: boolean;
  /** False hides the numbered balloons on assembly drawings (missing = shown). */
  balloons?: boolean;
  /** Assembly drawings: show the parts spread apart (the assembly's exploded view). */
  exploded?: boolean;
  /** Assembly drawings: add each part's weight to the parts list (missing = not shown). */
  bomWeights?: boolean;
  /** Decimal places for dimensions (0–4, kept even when they're zeros); missing = as many as needed, up to 2 in mm or 3 in inches. */
  places?: number;
  /** Dimensions also give the size in the other unit, in brackets: "40 [1.575]". */
  dualUnits?: boolean;
  /** Where dimensions' arrows go unless a dimension says otherwise (see Dimension.arrows); missing = automatic (inside when there's room). */
  dimArrows?: "inside" | "outside";
  /**
   * How Fit to sheet makes room for the dimensions (decided when Auto dimension
   * runs or Fit to sheet is chosen): extra room beside the 3D column (paper mm)
   * and/or one scale smaller. Missing = neither.
   */
  fit?: { gap?: number; down?: true };
  /** False hides tangent edges (where a fillet or curved face meets a flat one smoothly); missing = shown. */
  tangentEdges?: boolean;
  /** Where the hole table's top-left corner was dragged to (sheet mm); missing = above the title block. */
  holeTableAt?: [number, number];
  /**
   * Sheets 2, 3… of the drawing (sheet 1 is the drawing's own views,
   * dimensions and so on, so older files open unchanged). Each has its own
   * paper size, scale, views and annotations, and may draw a different part
   * or assembly with its own title and part number; the rest of the title
   * block and the settings are shared.
   */
  pages?: DrawingPage[];
}

/** The parts of a drawing that belong to one sheet (see Drawing.pages and PAGE_FIELDS in drawing/pages.ts). */
export type PageField = "sheet" | "scale" | "fit" | "views" | "dimensions" | "notes" | "sections" | "details" | "breakouts" | "shortened" | "holeTable" | "holeTableAt";
/** Sheet 2, 3… of a drawing. */
export type DrawingPage = { id: string } & Pick<Drawing, "sheet" | "views"> &
  Partial<Pick<Drawing, Exclude<PageField, "sheet" | "views">>> & {
    /**
     * What this sheet draws, when it isn't the drawing's own part or assembly
     * (sheet 1's); missing = the same as sheet 1. Null = nothing chosen yet.
     */
    source?: Drawing["source"];
    /**
     * This sheet's own title and part number in its title block; missing =
     * sheet 1's (or, on a sheet with its own `source`, none: the title then
     * shows that part's name). The other title block entries are shared.
     */
    partTitle?: PartTitle;
  };
/** The title block entries each sheet has for itself. */
export type PartTitle = Pick<Drawing["title"], "title" | "partNumber">;

/**
 * A section: a cutting line drawn across one of the flat views (front, top…).
 * The part is cut along it, straight through, and the cut is shown as its own
 * view ("SECTION A-A"). The line's ends are kept as fractions across the
 * view it's drawn on, so the cut stays in the same place on the part when it
 * changes size.
 */
/**
 * A shortened (broken) view: a band taken out of the middle of a long view so
 * it fits, along its width (x) or height (y). Dimensions still show real sizes.
 */
export interface Shortening {
  id: string;
  host: ViewKind;
  axis: "x" | "y";
  /** The band's two edges, as fractions of the host view's width (x) or height (y). */
  from: number;
  to: number;
}

/**
 * A broken-out view: a rectangle on a view where the part is cut away down to
 * a depth, to show what's inside (the cut face is hatched).
 */
export interface BreakOut {
  id: string;
  host: ViewKind;
  /** Opposite corners as fractions of the host view's width and height. */
  a: [number, number];
  b: [number, number];
  /** How deep to cut, from the front of the part as the view sees it (mm). */
  depth: number;
}

/** A detail view: a circle on a view, shown again bigger. */
export interface DetailView {
  id: string;
  /** "B", "C"… (shared with section letters). */
  letter: string;
  host: ViewKind;
  /** The circle's centre as fractions of the host view's width and height, and its radius (model mm). */
  centre: [number, number];
  radius: number;
  /** How many times bigger than the view it's taken from (that view's own scale, or the sheet's). */
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
  /** "chamfer": a callout like "1 × 45°" on a slanted edge a–b; "arcLength": the length round an arc (centre a, radius r, b a point on it). */
  type: "horizontal" | "vertical" | "aligned" | "diameter" | "radius" | "ordinate" | "angle" | "chamfer" | "arcLength";
  a: DimPoint;
  /** Second point (lengths). */
  b?: DimPoint;
  /** Circle radius (diameters and radii). */
  r?: number;
  /** How far the dimension line sits from what it measures (paper mm; may be negative). For circles: leader length. */
  offset: number;
  /** Circles: direction of the leader (degrees). */
  angle?: number;
  /**
   * Lengths: how far the number has been slid along the dimension line from the middle (paper mm).
   * Ordinates: how far the number has been moved sideways off the leader's line (paper mm, + = right
   * of an upright leader, up from a level one); the leader then jogs across to it.
   */
  textAlong?: number;
  /**
   * Lengths: when the number has been slid past an extension line, the dimension line carries on
   * under the whole of it as measured (a stacked fit or limits too). Missing = the older rough
   * estimate of its width, so drawings dragged before still look exactly as they did.
   * Diameters and radii: the shoulder under the number is as long as the number as measured
   * (set when the number is dragged); missing = the older estimate.
   */
  fitText?: true;
  /**
   * Angles: measure the outside (reflex) angle — 360° less the angle the arms
   * make — with its arc the long way round. Missing = the angle between the arms.
   */
  reflex?: true;
  /**
   * Angles and arc lengths: how far the number is from the corner (or the
   * arc's centre), in paper mm, when it's been dragged nearer than the arc can
   * go (the arc then stays at its smallest and a short leader joins the number
   * to it). Missing = just outside the arc.
   */
  textR?: number;
  /**
   * Angles and arc lengths: where the number has been slid round the arc, in degrees from the arc's
   * middle (+ = anticlockwise on the sheet). Beyond the arc's ends the arc carries on out to it.
   * Missing = in the middle.
   */
  textAngle?: number;
  /** Lengths: how far the number has been lifted off the dimension line (paper mm, + = above as read; joined by a leader). */
  textAcross?: number;
  /**
   * Diameters and radii: where the number has been dragged to, from the
   * circle's centre — in the view's own millimetres (model mm, like the points),
   * so it stays the same distance out from the circle when the view's scale
   * changes. It's the point under the middle of its text (DimDrawing.label).
   * The leader then runs from the circle out (or in) to it. Missing = at the
   * end of the leader set by `angle` and `offset`. Chamfers: the same, from
   * the middle of the slanted edge (the leader runs from there).
   */
  textAt?: [number, number];
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
  /** Decimal places to show (0–4, kept even when they're zeros); missing = the drawing's setting. */
  places?: number;
  /** A box round the number: "basic" (a theoretically exact size, for GD&T) or "inspection" (a rounded box: check this one). */
  frame?: "basic" | "inspection";
  /**
   * A limits-and-fits tolerance (ISO 286): a hole or shaft class like "H7" or
   * "g6", or a fit "H7/g6" (shown stacked). `limits` also shows the largest
   * and smallest sizes it allows. Replaces `tolerance`.
   */
  limitsFit?: { class: string; limits?: true };
  /** Chamfers: the distance is measured along the edge across ("h") or up and down ("v"); missing = whichever gives the smaller angle. */
  along?: "h" | "v";
  /**
   * Lengths, diameters and radii: where the arrows go — "inside" (between the
   * extension lines, or inside the circle, pointing out) or "outside" (beyond
   * them pointing in, on a short leader). Missing = the drawing's setting.
   */
  arrows?: "inside" | "outside";
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
  /** Of the Origin and the Top/Front/Right planes, the ones hidden in this Part Studio (missing = all shown). */
  hiddenDatums?: DatumName[];
}

/** The default planes, as in Onshape. Top = XY, Front = XZ, Right = YZ. */
export type PlaneName = "Top" | "Front" | "Right";
/** Default geometry listed at the top of the feature list. */
export type DatumName = "Origin" | PlaneName;

/** One copy of a part placed in an assembly. */
export interface Instance {
  id: string;
  /** The Part Studio part it shows (the id of the feature that made the part); "" for a sub-assembly. */
  partId: string;
  /**
   * A sub-assembly (as in Onshape): this instance shows another assembly of the
   * document (its id), all its parts moving together as one piece, placed where
   * that assembly's own mates put them. Missing = an ordinary part.
   */
  subAssembly?: string;
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
  /** Shown as the part's mirror image (a copy made by a Mirror): the part is flipped across its own YZ plane, then placed. */
  mirrored?: boolean;
  /**
   * Switched off for now (Onshape's Suppress): hidden, and left out of the parts
   * list, exports, clash checks and the mate solver; mates on it do nothing.
   */
  suppressed?: boolean;
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
  /** Mirror: one copy of each, mirrored across the plane square to `axis` through `centre`. */
  kind: "linear" | "circular" | "mirror";
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
  /**
   * Mirror: across this flat face (on any part, also one inside a sub-assembly)
   * instead of the plane square to `axis` — it follows the face as its part moves.
   */
  plane?: MateConnector;
  /**
   * Mirror: copies of symmetric parts show the same part, turned to fill the
   * mirror image (Onshape's "mirror as instance"), rather than its mirror image,
   * so the parts list counts them as one part.
   */
  samePart?: boolean;
}

/** Kinds of mate (Onshape names in brackets where they differ): Fasten, Hinge (revolute), Slider, Cylindrical, Planar, Ball. */
export type MateType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "pinSlot" | "parallel" | "width" | "tangent";

/** One end of a mate: a face or edge on an instance, remembered by what it looks like. */
export interface MateConnector {
  instanceId: string;
  /**
   * When the instance is a sub-assembly: the instances inside it, one per level,
   * down to the part the face or edge is on (missing for an ordinary part).
   */
  path?: string[];
  /** The face or edge (its partId is the Part Studio part). */
  pick: TopoPick;
  /** Width mates: the second flat face; the connector sits halfway between the two. */
  pick2?: TopoPick;
  /**
   * Width mates on a sub-assembly: the way down to the second face's part, when
   * it's another part of the same copy than the first face's (a slot made by
   * two plates). Missing = the same part as `pick`.
   */
  path2?: string[];
  /**
   * Where on the face or edge the connector sits, when not its usual spot (a
   * face's centre, an edge's middle or a circle's centre): an edge's start or
   * end corner, halfway along a curved edge, or where it was clicked (`point`).
   * Only the connector's position changes, never its directions.
   */
  spot?: ConnectorSpot;
  /** Where the face or edge was clicked, in the part's own coordinates (mm). */
  point?: [number, number, number];
}

/** What a parts list says about a part besides its name (as in Onshape's part properties). */
export interface PartProperties {
  /** e.g. "BR-001". */
  number?: string;
  description?: string;
  /** Your own properties, e.g. Supplier: "Screwfix", in the order they were added. */
  custom?: { name: string; value: string }[];
}

export type ConnectorSpot = "start" | "end" | "middle" | "clicked";

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
  kind: "gear" | "rack" | "screw" | "linear";
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
  /** Exploded view: how far the parts are spread apart (1 = their distance from the middle again; 0 = only the steps below); missing = together. */
  explode?: number;
  /** Exploded view steps: chosen parts moved a set distance in a direction, one step after another (optional: older saves have none). */
  explodeSteps?: ExplodeStep[];
  /** Patterns of instances (optional: older saves have none). */
  patterns?: AssemblyPattern[];
  /** Parts copied into matching holes (optional: older saves have none). */
  replicates?: Replicate[];
  /** Parts locked together so they move as one (optional: older saves have none). */
  groups?: AssemblyGroup[];
}

/** One step of an exploded view: some parts moved along X, Y or Z by a distance. */
export interface ExplodeStep {
  id: string;
  /** The parts moved (instance ids; a sub-assembly moves as one piece). */
  instances: string[];
  /**
   * Parts inside sub-assemblies moved on their own (optional: older saves have
   * none): each one's sub-assembly (a top-level instance) and the instances
   * inside it, one per level, down to the part — like MateConnector.path.
   */
  parts?: { instanceId: string; path: string[] }[];
  axis: "x" | "y" | "z";
  /** Go the other way (−X…). */
  flip?: boolean;
  /** How far, as typed (mm, maths or variables). */
  distance: string;
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
