/**
 * Onshape keeps a dialog's last-used options for the next new feature of that kind: make a 3 mm fillet and the next
 * Fillet starts at 3 mm; extrude "Through all" and the next Extrude starts so. Kept for the session only (never saved).
 * Only plain sizes are carried over (a box holding a variable or a sum isn't), and only choices that need nothing
 * clicked: an extrude "up to" a face, say, starts at the usual depth again.
 */
import { FEATURE_DEFS } from "./features";
import { isPlainNumber } from "./manipulators";
import type { ExtrudeEnd, Feature, FeatureType, HoleOptions } from "./types";

/** The kinds whose last options are carried over. */
export const REMEMBERED_TYPES: readonly FeatureType[] = [
  "extrude",
  "revolve",
  "fillet",
  "chamfer",
  "shell",
  "hole",
  "thicken",
  "draft",
  "linearPattern",
  "circularPattern",
  "offsetSurface",
];

/** What's kept from one feature. */
export interface RememberedOptions {
  params: Record<string, string>;
  extrude?: { end: ExtrudeEnd; second?: boolean };
  revolve?: { symmetric?: boolean; second?: boolean };
  hole?: Pick<HoleOptions, "kind" | "standard" | "fit" | "end" | "bothWays">;
  chamferType?: Feature["chamferType"];
}

export type OptionsMemory = Partial<Record<FeatureType, RememberedOptions>>;

/** Extrude ends that need nothing clicked. */
const PLAIN_ENDS: readonly ExtrudeEnd[] = ["blind", "symmetric", "throughAll"];

/** The memory after `feature` was made (unchanged for kinds that aren't remembered, and for surfaces and thin walls). */
export function rememberOptions(memory: OptionsMemory, feature: Feature): OptionsMemory {
  if (!REMEMBERED_TYPES.includes(feature.type)) return memory;
  // Thin walls' thicknesses go with the thin choice, which isn't carried over; positions belong to where it was.
  const keys = new Set(FEATURE_DEFS[feature.type].params.filter((p) => p.group !== "thin" && p.group !== "position").map((p) => p.key));
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(feature.params)) {
    if (keys.has(key) && typeof value === "string" && value.trim() && isPlainNumber(value)) params[key] = value;
  }
  const kept: RememberedOptions = { params };
  if (feature.extrude && PLAIN_ENDS.includes(feature.extrude.end)) kept.extrude = { end: feature.extrude.end, ...(feature.extrude.second ? { second: true } : {}) };
  if (feature.revolve) kept.revolve = { ...(feature.revolve.symmetric ? { symmetric: true } : {}), ...(feature.revolve.second ? { second: true } : {}) };
  if (feature.hole && feature.hole.end !== "upToNext") {
    const { kind, standard, fit, end, bothWays } = feature.hole;
    kept.hole = { kind, standard, fit, end, ...(bothWays ? { bothWays } : {}) };
  }
  if (feature.type === "chamfer") kept.chamferType = feature.chamferType;
  return { ...memory, [feature.type]: kept };
}

/** A new feature's draft with the last options of its kind put in (the same object when there are none). */
export function withRemembered(draft: Feature, memory: OptionsMemory): Feature {
  const kept = memory[draft.type];
  if (!kept) return draft;
  const out: Feature = { ...draft, params: { ...draft.params, ...kept.params } };
  if (kept.extrude && out.extrude) {
    out.extrude = { ...out.extrude, end: kept.extrude.end };
    if (kept.extrude.second) out.extrude.second = true;
  }
  if (kept.revolve && out.revolve) out.revolve = { ...out.revolve, ...kept.revolve };
  if (kept.hole && out.hole) out.hole = { ...out.hole, ...kept.hole };
  if (draft.type === "chamfer") {
    if (kept.chamferType) out.chamferType = kept.chamferType;
    else delete out.chamferType;
  }
  return out;
}
