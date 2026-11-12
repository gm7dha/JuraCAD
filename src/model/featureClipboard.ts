/**
 * Copy and paste features (Onshape's Ctrl+C / Ctrl+V in the feature list), within a Part Studio, into another one,
 * or into another design in the same browser. Pure: the clip is plain JSON text, so it goes on the system clipboard
 * (and a copy is kept in the browser in case the clipboard can't be read).
 *
 * Copying takes the picked features, in list order, plus the sketches they're made from (an Extrude's sketch, a
 * Sweep's path…), and the variables their sizes use. Pasting gives every feature a new id and points references
 * between the pasted features at the new ones; references to features outside the copy are kept when the Part Studio
 * pasted into has them (pasting in the same Part Studio), else lists lose the missing items (as Delete with dependents
 * does) and a feature that can't do without one is named so the user picks it again.
 */
import { withoutGone } from "./dependents";
import { parseFeatures } from "./document";
import type { Feature } from "./types";
import type { Variable } from "./variables";

export const CLIP_FORMAT = "juracad-features";

export interface FeatureClip {
  format: typeof CLIP_FORMAT;
  version: 1;
  features: Feature[];
  /** The variables the features' sizes use (with what they use in turn). */
  variables: Variable[];
  /** Ids of features outside the copy that it refers to. */
  outside: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern for any of `ids` standing as a word of its own in some text: not inside a longer id ("f_1" isn't found in
 * "f_12"), but it may be followed by "_" ("<id>_p3": its sketch's points), "~" or "@" (its parts).
 */
function idPattern(ids: Iterable<string>): RegExp | null {
  const list = [...ids].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(`(^|[^A-Za-z0-9_])(${list.map(escape).join("|")})(?![A-Za-z0-9])`, "g");
}

/** The ids among `ids` mentioned anywhere in a feature (any string or key in it). */
export function idsMentioned(value: unknown, ids: Iterable<string>): Set<string> {
  const found = new Set<string>();
  const re = idPattern(ids);
  if (!re) return found;
  const text = JSON.stringify(value);
  for (const m of text.matchAll(re)) found.add(m[2]);
  return found;
}

/** Every id in `map` replaced by its new one, in any string or key. */
export function remapIds<T>(value: T, map: Map<string, string>): T {
  const re = idPattern(map.keys());
  if (!re) return value;
  const text = JSON.stringify(value).replace(re, (_m, before: string, id: string) => before + (map.get(id) ?? id));
  return JSON.parse(text) as T;
}

/** Words in a feature's typed sizes that could be variable names. */
function wordsIn(value: unknown): Set<string> {
  const words = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) words.add(m[0]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return words;
}

/** The variables named in these features (and those named in their values in turn), in the design's order. */
export function variablesUsed(features: Feature[], variables: Variable[]): Variable[] {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const used = new Set<string>();
  const queue = [...wordsIn(features)].filter((w) => byName.has(w));
  while (queue.length) {
    const name = queue.pop()!;
    if (used.has(name)) continue;
    used.add(name);
    for (const w of wordsIn(byName.get(name)!.value)) if (byName.has(w) && !used.has(w)) queue.push(w);
  }
  return variables.filter((v) => used.has(v.name));
}

/** Types whose features are what others are made from, so they come along when a feature using them is copied. */
const MADE_FROM = new Set<Feature["type"]>(["sketch", "curve"]);

/**
 * What to copy: the picked features (in list order) plus the sketches and curves they use. `added` = the names of
 * those that came along without being picked.
 */
export function copyFeatures(features: Feature[], ids: string[], variables: Variable[] = []): { clip: FeatureClip; added: string[] } | null {
  const picked = new Set(ids.filter((id) => features.some((f) => f.id === id)));
  if (!picked.size) return null;
  const sources = features.filter((f) => MADE_FROM.has(f.type) && !picked.has(f.id)).map((f) => f.id);
  const take = new Set(picked);
  for (const f of features) {
    if (!picked.has(f.id) || MADE_FROM.has(f.type)) continue;
    for (const id of idsMentioned(f, sources)) take.add(id);
  }
  const list = features.filter((f) => take.has(f.id));
  const others = features.filter((f) => !take.has(f.id)).map((f) => f.id);
  const outside = [...idsMentioned(list, others)];
  const clip: FeatureClip = { format: CLIP_FORMAT, version: 1, features: list, variables: variablesUsed(list, variables), outside };
  return { clip, added: list.filter((f) => !picked.has(f.id)).map((f) => f.name) };
}

export function clipText(clip: FeatureClip): string {
  return JSON.stringify(clip);
}

/** A clip read back from text (the clipboard's, or the browser's copy); null if it isn't one. */
export function readClip(text: string | null | undefined): FeatureClip | null {
  if (!text || !text.includes(CLIP_FORMAT)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== CLIP_FORMAT || r.version !== 1 || !Array.isArray(r.features) || !r.features.length) return null;
  const features = parseFeatures(r.features, new Set());
  if (!features) return null;
  const variables = (Array.isArray(r.variables) ? r.variables : [])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .filter((v) => typeof v.id === "string" && typeof v.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name) && typeof v.value === "string")
    .map((v) => ({ id: v.id as string, name: v.name as string, value: v.value as string }));
  const outside = Array.isArray(r.outside) ? r.outside.filter((x): x is string => typeof x === "string") : [];
  return { format: CLIP_FORMAT, version: 1, features, variables, outside };
}

/** The variables a clip uses that the design doesn't have (by name). */
export function missingVariables(clip: FeatureClip, have: Variable[]): Variable[] {
  const names = new Set(have.map((v) => v.name));
  return clip.variables.filter((v) => !names.has(v.name));
}

/** A name not yet used: "Extrude 1" → "Extrude 3" when 1 and 2 are taken; "Lid" → "Lid (2)". */
export function freeName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const m = /^(.*\S) (\d+)$/.exec(name);
  if (m) {
    for (let n = Number(m[2]) + 1; ; n++) if (!used.has(`${m[1]} ${n}`)) return `${m[1]} ${n}`;
  }
  for (let n = 2; ; n++) if (!used.has(`${name} (${n})`)) return `${name} (${n})`;
}

export interface PasteResult {
  /** The Part Studio's features with the pasted ones in. */
  features: Feature[];
  /** The pasted features (new ids). */
  pasted: Feature[];
  /** Variables to add to the design (new ids), when asked to. */
  addVariables: Variable[];
  /** Names of pasted features that used something this Part Studio doesn't have: they need it picked again. */
  needsPick: string[];
}

/**
 * Paste a clip into a Part Studio's features: after `after` (the rollback bar's feature) or at the end. `allIds`: every
 * feature id in the design (ids are unique across Part Studios). `makeId` gives fresh ids (features, then variables).
 */
export function pasteFeatures(
  features: Feature[],
  clip: FeatureClip,
  opts: { after?: string | null; allIds: Iterable<string>; makeId: (prefix: string) => string; variables?: Variable[]; addVariables?: boolean },
): PasteResult {
  const taken = new Set(opts.allIds);
  const map = new Map<string, string>();
  for (const f of clip.features) {
    let id = opts.makeId("f");
    while (taken.has(id)) id = opts.makeId("f");
    taken.add(id);
    map.set(f.id, id);
  }
  const here = new Set(features.map((f) => f.id));
  const gone = new Set(clip.outside.filter((id) => !here.has(id)));
  const used = new Set(features.map((f) => f.name));
  const needsPick: string[] = [];
  const pasted = clip.features.map((f) => {
    const name = freeName(f.name, used);
    used.add(name);
    let out = remapIds({ ...f, name }, map);
    if (gone.size) {
      const kept = withoutGone(out, gone);
      // Lost some of its picks, or still names something missing (its sketch, a part it works on…).
      if (kept !== out || idsMentioned(kept, gone).size) needsPick.push(name);
      out = kept;
    }
    return out;
  });
  const at = opts.after ? features.findIndex((f) => f.id === opts.after) : -1;
  const next = at >= 0 ? [...features.slice(0, at + 1), ...pasted, ...features.slice(at + 1)] : [...features, ...pasted];
  const addVariables = opts.addVariables ? missingVariables(clip, opts.variables ?? []).map((v) => ({ ...v, id: opts.makeId("v") })) : [];
  return { features: next, pasted, addVariables, needsPick };
}

/** The toast after a paste: what came in, and what needs looking at. */
export function pasteMessage(r: PasteResult, skippedVariables: string[] = []): string {
  const names = r.pasted.map((f) => f.name);
  const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  const parts = [`Pasted ${list}.`];
  if (r.addVariables.length) parts.push(`Added the variable${r.addVariables.length === 1 ? "" : "s"} ${r.addVariables.map((v) => v.name).join(", ")}.`);
  if (skippedVariables.length) parts.push(`They use ${skippedVariables.join(", ")}, which this design doesn't have yet — add ${skippedVariables.length === 1 ? "it" : "them"} in Variables.`);
  if (r.needsPick.length)
    parts.push(`${r.needsPick.join(", ")} ${r.needsPick.length === 1 ? "used something" : "used things"} that isn't in this Part Studio: open ${r.needsPick.length === 1 ? "it" : "them"} and pick ${r.needsPick.length === 1 ? "it" : "them"} again.`);
  return parts.join(" ");
}
