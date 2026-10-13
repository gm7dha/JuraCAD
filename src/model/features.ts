import { evaluate } from "./expr";
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
    params: [{ key: "depth", label: "Depth", defaultValue: "10", positive: true, group: "size" }],
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
    description: "Hollows out a part, leaving walls of the thickness you choose.",
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
    description: "Moves and/or turns a part, or a copy of it.",
    params: [
      { key: "angle", label: "Turn by", defaultValue: "0", group: "size", unit: "°" },
      { key: "dx", label: "Move X (red)", defaultValue: "0", group: "position" },
      { key: "dy", label: "Move Y (green)", defaultValue: "0", group: "position" },
      { key: "dz", label: "Move Z (blue)", defaultValue: "0", group: "position" },
    ],
  },
  mirror: {
    type: "mirror",
    label: "Mirror",
    namePrefix: "Mirror",
    description: "Makes a mirror-image copy of features across a plane.",
    params: [],
  },
  linearPattern: {
    type: "linearPattern",
    label: "Linear pattern",
    namePrefix: "Linear pattern",
    description: "Repeats features in a straight line, evenly spaced.",
    params: [
      { key: "count", label: "How many (including the original)", defaultValue: "3", positive: true, integer: true, min: 2, group: "size", unit: "" },
      { key: "spacing", label: "Spacing", defaultValue: "20", positive: true, group: "size" },
    ],
  },
  circularPattern: {
    type: "circularPattern",
    label: "Circular pattern",
    namePrefix: "Circular pattern",
    description: "Repeats features around an axis, evenly spaced.",
    params: [
      { key: "count", label: "How many (including the original)", defaultValue: "6", positive: true, integer: true, min: 2, group: "size", unit: "" },
      { key: "angle", label: "Spread over", defaultValue: "360", positive: true, group: "size", unit: "°" },
    ],
  },
  fillet: {
    type: "fillet",
    label: "Fillet",
    namePrefix: "Fillet",
    description: "Rounds off sharp edges.",
    params: [{ key: "radius", label: "Radius", defaultValue: "2", positive: true, group: "size" }],
  },
  chamfer: {
    type: "chamfer",
    label: "Chamfer",
    namePrefix: "Chamfer",
    description: "Bevels sharp edges with a flat cut.",
    params: [{ key: "distance", label: "Distance", defaultValue: "1", positive: true, group: "size" }],
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
export function isPatternFeature(type: FeatureType): type is "mirror" | "linearPattern" | "circularPattern" {
  return type === "mirror" || type === "linearPattern" || type === "circularPattern";
}

/** Features that build a solid of their own, so they can be patterned or mirrored. */
export function isSolidFeature(type: FeatureType): boolean {
  return type === "box" || type === "cylinder" || type === "sphere" || type === "extrude" || type === "revolve" || type === "hole";
}

/** The size boxes worth showing for a feature as it's set up now (e.g. no depth for "through all"). */
export function visibleParamKeys(f: Pick<Feature, "type" | "extrude" | "hole">): Set<string> {
  const keys = new Set(FEATURE_DEFS[f.type].params.map((p) => p.key));
  if (f.type === "extrude" && f.extrude?.end === "throughAll") keys.delete("depth");
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
export function resolveParams(feature: Pick<Feature, "type" | "params">): ResolvedParams {
  const def = FEATURE_DEFS[feature.type];
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const p of def.params) {
    const src = feature.params[p.key] ?? p.defaultValue;
    const r = evaluate(src);
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

export function defaultParams(type: FeatureType): Record<string, string> {
  return Object.fromEntries(FEATURE_DEFS[type].params.map((p) => [p.key, p.defaultValue]));
}
