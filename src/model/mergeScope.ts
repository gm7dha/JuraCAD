/**
 * Onshape's "Merge scope" for features that add, remove or intersect material
 * (pure). `Feature.mergeScope` = the parts (ids) it may change: Add joins only
 * them (a piece touching none of them is a new part), Remove and Intersect
 * cut only them. Missing = "Merge with all" — exactly the usual rules.
 */
import { isPatternFeature } from "./features";
import type { Feature } from "./types";

/** Types with a merge scope when they add, remove or intersect. */
const SCOPED_TYPES = new Set<Feature["type"]>(["extrude", "revolve", "sweep", "loft", "hole", "thicken", "rib"]);

/** Does this feature (as set up now) offer "Merge with all" / a merge scope? */
export function takesMergeScope(f: Feature): boolean {
  if (isPatternFeature(f.type)) {
    // Patterns and mirrors of features (not of whole parts or faces).
    if (f.pattern?.of || f.mirror?.of || f.mirror?.part !== undefined) return false;
    return true;
  }
  if (!SCOPED_TYPES.has(f.type) || f.surface) return false;
  if (f.type === "hole" || f.type === "rib") return true;
  return f.operation === "add" || f.operation === "remove" || f.operation === "intersect";
}

/** What the chosen parts are for, in words: "merge with", "cut", "intersect with" (patterns: "change"). */
export function scopeVerb(f: Feature): string {
  if (isPatternFeature(f.type)) return "change";
  if (f.type === "hole" || f.operation === "remove") return "cut";
  if (f.operation === "intersect") return "intersect with";
  return "merge with";
}

/** The box's heading: "Parts to merge with", "Parts to cut", … */
export function scopeHeading(f: Feature): string {
  return `Parts to ${scopeVerb(f)}`;
}

/** Tick or untick "Merge with all": ticked = no scope (the usual); unticked = an empty list to click parts into. */
export function setMergeWithAll(f: Feature, all: boolean): Feature {
  if (all) {
    if (f.mergeScope === undefined && f.mergeScopePicking === undefined) return f;
    const { mergeScope: _s, mergeScopePicking: _p, ...rest } = f;
    return rest;
  }
  return { ...f, mergeScope: f.mergeScope ?? [], mergeScopePicking: true };
}

/** A part clicked while the scope box picks: put in, or taken out again. */
export function toggleScopePart(f: Feature, partId: string): Feature {
  const list = f.mergeScope ?? [];
  return { ...f, mergeScope: list.includes(partId) ? list.filter((x) => x !== partId) : [...list, partId] };
}

/**
 * The scope's parts as they are now: each id followed through the parts it was
 * merged into (`mergedInto`: gone id → the part it joined), once each, in the
 * order picked. `lost` = ids no longer anywhere.
 */
export function resolveScope(ids: readonly string[], exists: (id: string) => boolean, mergedInto: ReadonlyMap<string, string>): { ids: string[]; lost: string[] } {
  const out: string[] = [];
  const lost: string[] = [];
  for (const id of ids) {
    let at: string | undefined = id;
    const seen = new Set<string>();
    while (at !== undefined && !exists(at) && !seen.has(at)) {
      seen.add(at);
      at = mergedInto.get(at);
    }
    if (at !== undefined && exists(at)) {
      if (!out.includes(at)) out.push(at);
    } else lost.push(id);
  }
  return { ids: out, lost };
}

/** The error (none of the parts left, or none picked) or warning (some lost) for a scope, in plain words. */
export function scopeMessage(f: Feature, picked: number, lost: number): { error?: string; warning?: string } {
  const verb = scopeVerb(f);
  if (picked === 0) return { error: `Click the parts to ${verb} (in the 3D view or the Parts list), or tick "Merge with all".` };
  if (lost >= picked)
    return { error: `${picked === 1 ? "The part" : "The parts"} it was to ${verb} no longer ${picked === 1 ? "exists" : "exist"} (deleted, or made later in the list). Edit it and pick again, or tick "Merge with all".` };
  if (lost > 0) return { warning: `${lost} of the ${picked} parts it was to ${verb} no longer ${lost === 1 ? "exists" : "exist"}, so ${lost === 1 ? "it was" : "they were"} left out.` };
  return {};
}
