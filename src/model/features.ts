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

/** Features that change an existing part's edges rather than adding a solid (no New/Add/Remove). */
export function isEdgeFeature(type: FeatureType): type is "fillet" | "chamfer" {
  return type === "fillet" || type === "chamfer";
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
