import { hasLength } from "./fasteners";
import { evaluate, type Scope } from "./expr";
import type { Feature, FeatureType, Operation } from "./types";

export interface ParamDef {
  key: string;
  label: string;
  /** Default expression for new features. */
  defaultValue: string;
  /** Must be greater than zero (sizes). Positions may be any value. */
  positive?: boolean;
  /** Grouping in the dialog. */
  group: "size" | "position";
  /** Unit shown beside the box (millimetres unless it's an angle or a count). */
  unit?: "mm" | "°" | "";
  /** Must be a whole number. */
  integer?: boolean;
  /** Smallest allowed value. */
  min?: number;
}

export interface FeatureDef {
  type: FeatureType;
  label: string;
  /** Prefix for automatic names: "Box" → "Box 1", "Box 2"… */
  namePrefix: string;
  description: string;
  params: ParamDef[];
}

export const FEATURE_DEFS: Record<FeatureType, FeatureDef> = {
  box: {
    type: "box",
    label: "Box",
    namePrefix: "Box",
    description: "A rectangular block. Its corner sits at the position you give.",
    params: [
      { key: "width", label: "Width (X)", defaultValue: "40", positive: true, group: "size" },
      { key: "depth", label: "Depth (Y)", defaultValue: "30", positive: true, group: "size" },
      { key: "height", label: "Height (Z)", defaultValue: "20", positive: true, group: "size" },
      { key: "x", label: "Corner X", defaultValue: "0", group: "position" },
      { key: "y", label: "Corner Y", defaultValue: "0", group: "position" },
      { key: "z", label: "Corner Z", defaultValue: "0", group: "position" },
    ],
  },
  cylinder: {
    type: "cylinder",
    label: "Cylinder",
    namePrefix: "Cylinder",
    description: "An upright cylinder. Its base centre sits at the position you give.",
    params: [
      { key: "diameter", label: "Diameter", defaultValue: "20", positive: true, group: "size" },
      { key: "height", label: "Height (Z)", defaultValue: "30", positive: true, group: "size" },
      { key: "x", label: "Base centre X", defaultValue: "0", group: "position" },
      { key: "y", label: "Base centre Y", defaultValue: "0", group: "position" },
      { key: "z", label: "Base centre Z", defaultValue: "0", group: "position" },
    ],
  },
  sketch: {
    type: "sketch",
    label: "Sketch",
    namePrefix: "Sketch",
    description: "A 2D drawing on a plane or flat face, used by Extrude.",
    params: [],
  },
  extrude: {
    type: "extrude",
    label: "Extrude",
    namePrefix: "Extrude",
    description: "Pushes the closed shapes of a sketch out into a solid.",
    params: [
      { key: "depth", label: "Depth", defaultValue: "10", positive: true, group: "size" },
      { key: "depth2", label: "Depth the other way", defaultValue: "10", positive: true, group: "size" },
      { key: "draft", label: "Draft (taper)", defaultValue: "0", group: "size", unit: "°" },
    ],
  },
  revolve: {
    type: "revolve",
    label: "Revolve",
    namePrefix: "Revolve",
    description: "Spins the closed shapes of a sketch around a line, for round parts.",
    params: [{ key: "angle", label: "Angle", defaultValue: "360", positive: true, group: "size", unit: "°" }],
  },
  shell: {
    type: "shell",
    label: "Shell",
    namePrefix: "Shell",
    description: "Hollows out a part, leaving walls of the thickness you choose — open at the faces you pick, or closed inside if you pick none (or every face, as on a ball).",
    params: [{ key: "thickness", label: "Wall thickness", defaultValue: "2", positive: true, group: "size" }],
  },
  hole: {
    type: "hole",
    label: "Hole",
    namePrefix: "Hole",
    description: "Drills holes at a sketch's points and circle centres — plain, counterbored, countersunk or tapped.",
    params: [
      { key: "diameter", label: "Hole diameter", defaultValue: "3.4", positive: true, group: "size" },
      { key: "depth", label: "Depth", defaultValue: "10", positive: true, group: "size" },
      { key: "cboreDiameter", label: "Counterbore diameter", defaultValue: "6.5", positive: true, group: "size" },
      { key: "cboreDepth", label: "Counterbore depth", defaultValue: "3.4", positive: true, group: "size" },
      { key: "cskDiameter", label: "Countersink diameter", defaultValue: "6.3", positive: true, group: "size" },
      { key: "cskAngle", label: "Countersink angle", defaultValue: "90", positive: true, group: "size", unit: "°" },
    ],
  },
  transform: {
    type: "transform",
    label: "Move / copy",
    namePrefix: "Transform",
    description: "Moves and/or turns a part, or a copy of it. Turns are about X, then Y, then Z.",
    params: [
      { key: "rx", label: "Turn about X (red)", defaultValue: "0", group: "size", unit: "°" },
      { key: "ry", label: "Turn about Y (green)", defaultValue: "0", group: "size", unit: "°" },
      { key: "rz", label: "Turn about Z (blue)", defaultValue: "0", group: "size", unit: "°" },
      { key: "dx", label: "Move X (red)", defaultValue: "0", group: "position" },
      { key: "dy", label: "Move Y (green)", defaultValue: "0", group: "position" },
      { key: "dz", label: "Move Z (blue)", defaultValue: "0", group: "position" },
    ],
  },
  mirror: {
    type: "mirror",
    label: "Mirror",
    namePrefix: "Mirror",
    description: "Makes a mirror-image copy of features — or of a whole part — across a plane.",
    params: [],
  },
  linearPattern: {
    type: "linearPattern",
    label: "Linear pattern",
    namePrefix: "Linear pattern",
    description: "Repeats features in a straight line, evenly spaced — or in a grid of rows.",
    params: [
      { key: "count", label: "How many (including the original)", defaultValue: "3", positive: true, integer: true, min: 2, group: "size", unit: "" },
      { key: "spacing", label: "Spacing", defaultValue: "20", positive: true, group: "size" },
      { key: "count2", label: "Rows in the second direction (1 = just one row)", defaultValue: "1", positive: true, integer: true, min: 1, group: "size", unit: "" },
      { key: "spacing2", label: "Spacing between rows", defaultValue: "20", positive: true, group: "size" },
    ],
  },
  circularPattern: {
    type: "circularPattern",
    label: "Circular pattern",
    namePrefix: "Circular pattern",
    description: "Repeats features around an axis, evenly spaced. The axis can go through any point.",
    params: [
      { key: "count", label: "How many (including the original)", defaultValue: "6", positive: true, integer: true, min: 2, group: "size", unit: "" },
      { key: "angle", label: "Spread over", defaultValue: "360", positive: true, group: "size", unit: "°" },
      { key: "cx", label: "Axis goes through X", defaultValue: "0", group: "position" },
      { key: "cy", label: "Axis goes through Y", defaultValue: "0", group: "position" },
      { key: "cz", label: "Axis goes through Z", defaultValue: "0", group: "position" },
    ],
  },
  curvePattern: {
    type: "curvePattern",
    label: "Curve pattern",
    namePrefix: "Curve pattern",
    description: "Repeats features along a path drawn in a sketch, evenly spaced.",
    params: [{ key: "count", label: "How many (including the original)", defaultValue: "5", positive: true, integer: true, min: 2, group: "size", unit: "" }],
  },
  sweep: {
    type: "sweep",
    label: "Sweep",
    namePrefix: "Sweep",
    description: "Carries a sketch's closed shape along a path drawn in another sketch — for pipes, handles and rails.",
    params: [],
  },
  loft: {
    type: "loft",
    label: "Loft",
    namePrefix: "Loft",
    description: "Makes a smooth solid joining shapes drawn on different sketches — for example a square base blending into a round top.",
    params: [],
  },
  text: {
    type: "text",
    label: "Text",
    namePrefix: "Text",
    description: "Raised or engraved lettering on a plane or flat face.",
    params: [
      { key: "size", label: "Letter size", defaultValue: "10", positive: true, group: "size" },
      { key: "depth", label: "Depth", defaultValue: "2", positive: true, group: "size" },
      { key: "angle", label: "Turn", defaultValue: "0", group: "size", unit: "°" },
      { key: "x", label: "Start X (on the plane)", defaultValue: "0", group: "position" },
      { key: "y", label: "Start Y (on the plane)", defaultValue: "0", group: "position" },
    ],
  },
  fill: {
    type: "fill",
    label: "Fill",
    namePrefix: "Fill",
    description: "A surface spanning a ring of edges — flat if they lie in a plane, else a smooth patch — to close an opening or make a skin (a new surface part).",
    params: [],
  },
  enclose: {
    type: "enclose",
    label: "Enclose",
    namePrefix: "Enclose",
    description: "Closes surfaces up into one solid: click a face of each surface. They must meet at their edges all the way round.",
    params: [],
  },
  offsetSurface: {
    type: "offsetSurface",
    label: "Offset surface",
    namePrefix: "Offset surface",
    description: "A copy of a surface moved a set distance along its normal everywhere (minus for the other side), as a new surface part.",
    params: [{ key: "distance", label: "Distance", defaultValue: "2", group: "size" }],
  },
  extendSurface: {
    type: "extendSurface",
    label: "Extend surface",
    namePrefix: "Extend",
    description: "Grows a surface out past its edges: click the edges to extend and how far (straight on, along the surface).",
    params: [{ key: "distance", label: "Distance", defaultValue: "5", positive: true, group: "size" }],
  },
  ruled: {
    type: "ruled",
    label: "Ruled surface",
    namePrefix: "Ruled surface",
    description: "Straight strips swept from edges in one direction (square to a plane), optionally tilted by an angle, as a new surface part. For walls, drafted sides or a guide for Split.",
    params: [
      { key: "distance", label: "Distance", defaultValue: "10", positive: true, group: "size" },
      { key: "angle", label: "Tilt", defaultValue: "0", group: "size", unit: "°" },
    ],
  },
  wrap: {
    type: "wrap",
    label: "Wrap",
    namePrefix: "Wrap",
    description: "Wraps a sketch's closed shapes round a round face — a logo or pattern on a rod, boss or the inside of a hole — raised or engraved.",
    params: [
      { key: "depth", label: "Depth", defaultValue: "1", positive: true, group: "size" },
      { key: "angle", label: "Turn", defaultValue: "0", group: "size", unit: "°" },
      { key: "x", label: "Move round the face", defaultValue: "0", group: "position" },
      { key: "y", label: "Move along the face", defaultValue: "0", group: "position" },
    ],
  },
  fillet: {
    type: "fillet",
    label: "Fillet",
    namePrefix: "Fillet",
    description: "Rounds off sharp edges — the same all along, or growing from one radius to another.",
    params: [
      { key: "radius", label: "Radius", defaultValue: "2", positive: true, group: "size" },
      { key: "endRadius", label: "Radius at the far end (0 = the same all along)", defaultValue: "0", min: 0, group: "size" },
    ],
  },
  fullRound: {
    type: "fullRound",
    label: "Full round",
    namePrefix: "Full round",
    description: "Rounds the top of a rib or wall right over, from one side to the other: click its flat top face.",
    params: [],
  },
  chamfer: {
    type: "chamfer",
    label: "Chamfer",
    namePrefix: "Chamfer",
    description: "Bevels sharp edges with a flat cut — the same distance both ways, two different distances, or a distance and an angle.",
    params: [
      { key: "distance", label: "Distance", defaultValue: "1", positive: true, group: "size" },
      { key: "distance2", label: "Second distance", defaultValue: "2", positive: true, group: "size" },
      { key: "angle", label: "Angle", defaultValue: "30", positive: true, group: "size", unit: "°" },
    ],
  },
  import: {
    type: "import",
    label: "Import",
    namePrefix: "Import",
    description: "A STEP or STL file from another program, brought in as a part.",
    params: [],
  },
  draft: {
    type: "draft",
    label: "Draft",
    namePrefix: "Draft",
    description: "Tapers faces by an angle so the part pulls out of a mould: the faces pivot where they meet the neutral plane.",
    params: [{ key: "angle", label: "Angle", defaultValue: "3", group: "size", unit: "°" }],
  },
  moveFace: {
    type: "moveFace",
    label: "Move face",
    namePrefix: "Move face",
    description: "Moves flat faces straight out (or in, with a minus distance), growing or shrinking the part.",
    params: [{ key: "distance", label: "Distance", defaultValue: "2", group: "size" }],
  },
  replaceFace: {
    type: "replaceFace",
    label: "Replace face",
    namePrefix: "Replace face",
    description: "Moves flat faces onto another flat face or plane that's parallel to them — to line a part up with another, or level it with a face.",
    params: [{ key: "offset", label: "Offset (past the face, or short of it with a minus amount)", defaultValue: "0", group: "size" }],
  },
  thread: {
    type: "thread",
    label: "Thread",
    namePrefix: "Thread",
    description: "Cuts a screw thread (60°, metric) round a rod for a bolt, or inside a hole for a nut.",
    params: [
      { key: "pitch", label: "Pitch", defaultValue: "1.25", positive: true, group: "size" },
      { key: "length", label: "Length (0 = whole face)", defaultValue: "0", group: "size" },
    ],
  },
  deleteFace: {
    type: "deleteFace",
    label: "Delete face",
    namePrefix: "Delete face",
    description: "Removes faces and closes the gap — takes away fillets, chamfers, holes and bosses.",
    params: [],
  },
  split: {
    type: "split",
    label: "Split",
    namePrefix: "Split",
    description: "Cuts a part in two along a plane or flat face, making two parts (or keeping one side).",
    params: [],
  },
  sheetMetal: {
    type: "sheetMetal",
    label: "Sheet metal",
    namePrefix: "Sheet metal",
    description:
      "A sheet metal part from a sketch: a closed shape makes a flat sheet; connected lines (the side view of an L, U or Z…) make a bent sheet, its corners becoming bends. Then bend flanges off its edges.",
    params: [
      { key: "thickness", label: "Thickness", defaultValue: "1.5", positive: true, group: "size" },
      { key: "depth", label: "Depth (for an outline of lines)", defaultValue: "30", positive: true, group: "size" },
      { key: "radius", label: "Bend radius (inside)", defaultValue: "1.5", positive: true, group: "size" },
      { key: "kFactor", label: "K-factor (0.45 is usual)", defaultValue: "0.45", min: 0, group: "size", unit: "" },
    ],
  },
  flange: {
    type: "flange",
    label: "Flange",
    namePrefix: "Flange",
    description: "Bends a wall up (or down) off straight edges of a sheet metal part.",
    params: [
      { key: "length", label: "Length (outside, to the tip)", defaultValue: "20", positive: true, group: "size" },
      { key: "angle", label: "Bend angle", defaultValue: "90", positive: true, group: "size", unit: "°" },
      { key: "inset", label: "Shorten each end by (a relief is cut so it can bend)", defaultValue: "0", min: 0, group: "size" },
    ],
  },
  tab: {
    type: "tab",
    label: "Tab",
    namePrefix: "Tab",
    description: "Joins flat shapes onto a sheet metal wall: sketch them on the wall's face, overlapping or meeting its edge.",
    params: [],
  },
  hem: {
    type: "hem",
    label: "Hem",
    namePrefix: "Hem",
    description: "Folds straight edges of a sheet metal part right back on themselves, for a safe, stiff edge.",
    params: [
      { key: "length", label: "Length of the folded-over part", defaultValue: "8", positive: true, group: "size" },
      { key: "gap", label: "Gap inside the fold (0 = folded flat)", defaultValue: "0", min: 0, group: "size" },
      { key: "inset", label: "Shorten each end by (a relief is cut so it can fold)", defaultValue: "0", min: 0, group: "size" },
    ],
  },
  thicken: {
    type: "thicken",
    label: "Thicken",
    namePrefix: "Thicken",
    description: "Grows flat faces into a solid of a set thickness (a new part, or added to or cut from the part).",
    params: [{ key: "thickness", label: "Thickness", defaultValue: "2", positive: true, group: "size" }],
  },
  rib: {
    type: "rib",
    label: "Rib",
    namePrefix: "Rib",
    description: "A thin strengthening wall from the lines of a sketch, filling the space up to the part (gussets, webs).",
    params: [{ key: "thickness", label: "Thickness", defaultValue: "3", positive: true, group: "size" }],
  },
  derived: {
    type: "derived",
    label: "Derived",
    namePrefix: "Derived",
    description: "A part from another Part Studio brought into this one, where it was made (moved by X, Y, Z if you like). It updates when the original changes.",
    params: [
      { key: "x", label: "Move X", defaultValue: "0", group: "position" },
      { key: "y", label: "Move Y", defaultValue: "0", group: "position" },
      { key: "z", label: "Move Z", defaultValue: "0", group: "position" },
    ],
  },
  fastener: {
    type: "fastener",
    label: "Fastener",
    namePrefix: "Fastener",
    description: "A standard metric bolt, screw (socket cap, button head, countersunk, pan head, grub), nut or washer (M3–M12), as a new part — optionally with its thread modelled.",
    params: [
      { key: "length", label: "Length", defaultValue: "20", positive: true, group: "size" },
      { key: "x", label: "X", defaultValue: "0", group: "position" },
      { key: "y", label: "Y", defaultValue: "0", group: "position" },
      { key: "z", label: "Z", defaultValue: "0", group: "position" },
    ],
  },
  deletePart: {
    type: "deletePart",
    label: "Delete part",
    namePrefix: "Delete part",
    description: "Removes whole parts from the Part Studio (from this point on in the feature list).",
    params: [],
  },
  boolean: {
    type: "boolean",
    label: "Boolean",
    namePrefix: "Boolean",
    description: "Join parts into one, cut some parts with others, or keep just where parts overlap.",
    params: [],
  },
  plane: {
    type: "plane",
    label: "Plane",
    namePrefix: "Plane",
    description: "A flat construction plane to sketch on: set a distance away from a plane or flat face, tilted, or halfway between two faces.",
    params: [
      { key: "distance", label: "Distance", defaultValue: "20", group: "size" },
      { key: "angle", label: "Tilt", defaultValue: "30", group: "size", unit: "°" },
    ],
  },
  coil: {
    type: "coil",
    label: "Coil",
    namePrefix: "Coil",
    description: "A spring or coil: round wire wound in a helix. Its bottom sits at the position you give, winding up.",
    params: [
      { key: "diameter", label: "Coil diameter", defaultValue: "20", positive: true, group: "size" },
      { key: "wire", label: "Wire thickness", defaultValue: "2", positive: true, group: "size" },
      { key: "pitch", label: "Pitch (rise per turn)", defaultValue: "5", positive: true, group: "size" },
      { key: "turns", label: "Turns", defaultValue: "5", positive: true, group: "size" },
      { key: "x", label: "Centre X", defaultValue: "0", group: "position" },
      { key: "y", label: "Centre Y", defaultValue: "0", group: "position" },
      { key: "z", label: "Bottom Z", defaultValue: "0", group: "position" },
    ],
  },
  sphere: {
    type: "sphere",
    label: "Sphere",
    namePrefix: "Sphere",
    description: "A ball. Its centre sits at the position you give.",
    params: [
      { key: "diameter", label: "Diameter", defaultValue: "20", positive: true, group: "size" },
      { key: "x", label: "Centre X", defaultValue: "0", group: "position" },
      { key: "y", label: "Centre Y", defaultValue: "0", group: "position" },
      { key: "z", label: "Centre Z", defaultValue: "0", group: "position" },
    ],
  },
};

export const OPERATION_LABELS: Record<Operation, string> = {
  new: "New",
  add: "Add",
  remove: "Remove",
  intersect: "Intersect",
};

/** Features that round or bevel edges. */
export function isEdgeFeature(type: FeatureType): type is "fillet" | "chamfer" {
  return type === "fillet" || type === "chamfer";
}

/** Features that change faces or edges picked on an existing part, rather than adding a solid (no New/Add/Remove). */
export function isPickFeature(type: FeatureType): type is "fillet" | "chamfer" | "shell" {
  return type === "fillet" || type === "chamfer" || type === "shell";
}

/** Features that repeat earlier features (no New/Add/Remove of their own: each copy does what the original did). */
export function isPatternFeature(type: FeatureType): type is "mirror" | "linearPattern" | "circularPattern" | "curvePattern" {
  return type === "mirror" || type === "linearPattern" || type === "circularPattern" || type === "curvePattern";
}

/** Features that build a solid of their own, so they can be patterned or mirrored. */
export function isSolidFeature(type: FeatureType): boolean {
  return (
    type === "box" ||
    type === "cylinder" ||
    type === "sphere" ||
    type === "extrude" ||
    type === "revolve" ||
    type === "hole" ||
    type === "import" ||
    type === "sweep" ||
    type === "loft" ||
    type === "text"
  );
}

/** The size boxes worth showing for a feature as it's set up now (e.g. no depth for "through all"). */
export function visibleParamKeys(f: Pick<Feature, "type" | "extrude" | "hole" | "planeDef" | "fastener" | "surface"> & Partial<Pick<Feature, "pattern" | "chamferType">>): Set<string> {
  const keys = new Set(FEATURE_DEFS[f.type].params.map((p) => p.key));
  if (f.type === "extrude" && (f.extrude?.end === "throughAll" || f.extrude?.end === "upToFace")) keys.delete("depth");
  if (f.type === "extrude" && !(f.extrude?.end === "blind" && f.extrude.second && !f.surface)) keys.delete("depth2");
  if (f.type === "extrude" && f.surface) keys.delete("draft");
  // A circular pattern's axis: where along it doesn't matter, so that box is hidden.
  if (f.type === "circularPattern") keys.delete(`c${f.pattern?.axis ?? "z"}`);
  if (f.type === "chamfer") {
    if (f.chamferType !== "twoDistances") keys.delete("distance2");
    if (f.chamferType !== "distanceAngle") keys.delete("angle");
  }
  if (f.type === "plane" && f.planeDef?.mode !== "angle") keys.delete("angle");
  if (f.type === "fastener" && f.fastener && !hasLength(f.fastener.kind)) keys.delete("length");
  if (f.type === "hole" && f.hole) {
    if (f.hole.end === "throughAll") keys.delete("depth");
    if (f.hole.kind !== "counterbore") ["cboreDiameter", "cboreDepth"].forEach((k) => keys.delete(k));
    if (f.hole.kind !== "countersink") ["cskDiameter", "cskAngle"].forEach((k) => keys.delete(k));
  }
  return keys;
}

/** Features made from a sketch (they have New/Add/Remove and a sketch to choose). */
export function isSketchSolid(type: FeatureType): type is "extrude" | "revolve" {
  return type === "extrude" || type === "revolve";
}

export interface ResolvedParams {
  values: Record<string, number>;
  /** Per-parameter problems, in plain English. Empty when all is well. */
  errors: Record<string, string>;
}

/** Turn a feature's typed expressions into millimetre values, checking each one. */
export function resolveParams(feature: Pick<Feature, "type" | "params">, scope?: Scope): ResolvedParams {
  const def = FEATURE_DEFS[feature.type];
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const p of def.params) {
    const src = feature.params[p.key] ?? p.defaultValue;
    const r = scope ? evaluate(src, scope) : evaluate(src);
    if (!r.ok) {
      errors[p.key] = r.error;
      continue;
    }
    if (p.positive && r.value <= 0) {
      errors[p.key] = `${p.label} must be more than 0`;
      continue;
    }
    if (p.integer && !Number.isInteger(r.value)) {
      errors[p.key] = "Must be a whole number";
      continue;
    }
    if (p.min !== undefined && r.value < p.min) {
      errors[p.key] = `Must be at least ${p.min}`;
      continue;
    }
    values[p.key] = r.value;
  }
  return { values, errors };
}

/** A one-line summary of a feature's problems, for the feature list tooltip. */
export function describeParamErrors(feature: Feature): string | null {
  const { errors } = resolveParams(feature);
  const def = FEATURE_DEFS[feature.type];
  const first = def.params.find((p) => errors[p.key]);
  if (!first) return null;
  return `${first.label}: ${errors[first.key]}`;
}

/**
 * Starting values for a feature's boxes. In an inch design, sizes start at a
 * round number of inches near the usual millimetre default (and are saved with
 * "in", see units.ts).
 */
export function defaultParams(type: FeatureType, unit: "mm" | "in" = "mm"): Record<string, string> {
  return Object.fromEntries(
    FEATURE_DEFS[type].params.map((p) => {
      const isLength = p.unit === undefined || p.unit === "mm";
      const mm = Number(p.defaultValue);
      if (unit === "mm" || !isLength || !mm) return [p.key, p.defaultValue];
      const inches = mm / 25.4;
      const step = inches >= 1 ? 4 : 16;
      const nice = Math.max(1 / 16, Math.round(inches * step) / step);
      return [p.key, `${nice} in`];
    }),
  );
}
