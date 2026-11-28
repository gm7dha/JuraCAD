/**
 * Measured variables (Onshape's Variable feature › Measured): a variable whose value is read from the model where it
 * sits in the feature list — the distance between two things, an edge's length, a round edge's or face's diameter or
 * radius, or the angle between two faces or edges. Features after it can use it by name, like any variable; features
 * before it can't (it measures the parts as built at that point). Pure: the engine measures (engine.ts `applyMeasured`).
 */
import { parsePick, type TopoPick } from "../geometry/topoRef";
import { parseVertexPick, type VertexPick } from "../geometry/vertexRef";
import { namesIn } from "./expr";
import { checkName } from "./variables";
import type { Feature } from "./types";

export type MeasureKind = "distance" | "length" | "diameter" | "radius" | "angle";
/** A distance: the shortest one, or how far apart along X, Y or Z (the shortest distance's part along that axis). */
export type MeasureAlong = "min" | "x" | "y" | "z";
/** A plane: "Top" / "Front" / "Right", or a Plane feature's id. */
export interface PlaneTarget {
  plane: string;
}
/** What's measured: a face or edge, a corner, or a plane. */
export type MeasureTarget = TopoPick | VertexPick | PlaneTarget;

export interface MeasuredDef {
  name: string;
  kind: MeasureKind;
  /** Distance only; missing = the shortest. */
  along?: Exclude<MeasureAlong, "min">;
  targets: MeasureTarget[];
}

/** The value a measured variable came to in the last build (by feature id, RebuildResult.measuredValues). */
export interface MeasuredValue {
  name: string;
  value: number;
  /** An angle (degrees). */
  angle?: true;
}

/** No measured variables (one shared object, so selectors stay stable). */
export const NO_MEASURED: Record<string, MeasuredValue> = {};

export const MEASURE_KINDS: readonly { kind: MeasureKind; label: string; hint: string }[] = [
  { kind: "distance", label: "Distance", hint: "Click two things: faces, edges, corners or planes." },
  { kind: "length", label: "Length", hint: "Click an edge (or several: their lengths are added up)." },
  { kind: "diameter", label: "Diameter", hint: "Click a round edge or a round face." },
  { kind: "radius", label: "Radius", hint: "Click a round edge or a round face." },
  {
    kind: "angle",
    label: "Angle",
    hint: "Click two flat faces or straight edges (or a plane). Between faces or planes it's the angle between them, 0–90°; between two edges meeting at a corner, the angle at that corner, 0–180°.",
  },
];

export const DEFAULT_PLANES = ["Top", "Front", "Right"] as const;

export const isPlaneTarget = (t: MeasureTarget): t is PlaneTarget => "plane" in t;
export const isCornerTarget = (t: MeasureTarget): t is VertexPick => !isPlaneTarget(t) && t.ref.kind === "vertex";

/** How many things a kind measures: [fewest, most]. */
export function targetsWanted(kind: MeasureKind): [number, number] {
  if (kind === "distance" || kind === "angle") return [2, 2];
  if (kind === "length") return [1, 50];
  return [1, 1];
}

/** A new measured variable's settings: Distance, nothing picked, a free name. */
export function newMeasuredDef(taken: readonly string[]): MeasuredDef {
  let n = 1;
  while (taken.includes(`measured_${n}`)) n++;
  return { name: `measured_${n}`, kind: "distance", targets: [] };
}

const same = (a: MeasureTarget, b: MeasureTarget): boolean => {
  if (isPlaneTarget(a) || isPlaneTarget(b)) return isPlaneTarget(a) && isPlaneTarget(b) && a.plane === b.plane;
  if (a.partId !== b.partId || a.ref.kind !== b.ref.kind) return false;
  return JSON.stringify(a.ref) === JSON.stringify(b.ref);
};

/** What a kind can't take, or null. */
function wrongKind(kind: MeasureKind, t: MeasureTarget): string | null {
  if (kind === "length") return !isPlaneTarget(t) && t.ref.kind === "edge" ? null : "A length is measured along edges: click an edge.";
  if (kind === "diameter" || kind === "radius") {
    if (isPlaneTarget(t) || t.ref.kind === "vertex") return "Click a round edge or a round face.";
    if (t.ref.kind === "edge" ? t.ref.curve !== "CIRCLE" : t.ref.surface !== "CYLINDRE") return "That isn't round: click a round edge or a round (cylinder) face.";
    return null;
  }
  if (kind === "angle") {
    if (isPlaneTarget(t)) return null;
    if (t.ref.kind === "vertex") return "An angle is between faces or edges: a corner has no direction.";
    if (t.ref.kind === "edge" ? t.ref.curve !== "LINE" : t.ref.surface !== "PLANE") return "Angles are between flat faces, straight edges and planes.";
  }
  return null;
}

/**
 * A click on something while the dialog is open: picked again = taken out; else put in (the oldest dropped once the kind
 * has as many as it takes). `error` says why a click can't be used for this kind.
 */
export function toggleTarget(def: MeasuredDef, t: MeasureTarget): { def: MeasuredDef; error?: string } {
  const had = def.targets.findIndex((x) => same(x, t));
  if (had >= 0) return { def: { ...def, targets: def.targets.filter((_, i) => i !== had) } };
  const error = wrongKind(def.kind, t);
  if (error) return { def, error };
  const most = targetsWanted(def.kind)[1];
  return { def: { ...def, targets: [...def.targets, t].slice(-most) } };
}

/** Switch what's measured, keeping the picks that still fit. */
export function withKind(def: MeasuredDef, kind: MeasureKind): MeasuredDef {
  const most = targetsWanted(kind)[1];
  const { along: _a, ...rest } = def;
  return { ...rest, ...(kind === "distance" && def.along ? { along: def.along } : {}), kind, targets: def.targets.filter((t) => !wrongKind(kind, t)).slice(0, most) };
}

/** What's still missing before it can be measured (for the dialog's Accept), or null. */
export function measuredProblem(def: MeasuredDef | undefined): string | null {
  if (!def) return "Choose what to measure.";
  const [least] = targetsWanted(def.kind);
  if (def.targets.length < least) {
    const label = MEASURE_KINDS.find((k) => k.kind === def.kind)!;
    return least === 2 && def.targets.length === 1 ? `Click one more thing to measure to. ${label.hint}` : label.hint;
  }
  for (const t of def.targets) {
    const why = wrongKind(def.kind, t);
    if (why) return why;
  }
  return null;
}

/** Short words for one pick, for the dialog's list. */
export function targetLabel(t: MeasureTarget, planeName: (id: string) => string = (id) => id): string {
  if (isPlaneTarget(t)) return (DEFAULT_PLANES as readonly string[]).includes(t.plane) ? `${t.plane} plane` : planeName(t.plane);
  if (t.ref.kind === "vertex") return "Corner";
  if (t.ref.kind === "edge") return t.ref.curve === "LINE" ? "Straight edge" : t.ref.curve === "CIRCLE" ? "Round edge" : "Curved edge";
  return t.ref.surface === "PLANE" ? "Flat face" : t.ref.surface === "CYLINDRE" ? "Round face" : "Curved face";
}

/** The value as shown: "40 mm", "35.5°". */
export function measuredText(v: Pick<MeasuredValue, "value" | "angle">): string {
  const r = Math.round(v.value * 1000) / 1000;
  return v.angle ? `${r}°` : `${r} mm`;
}

/** Every variable name a feature's boxes and sketch dimensions use. */
export function namesUsedBy(f: Feature): string[] {
  const out = new Set<string>();
  const add = (src: string | undefined) => {
    if (src) for (const n of namesIn(src)) out.add(n);
  };
  for (const v of Object.values(f.params ?? {})) add(v);
  for (const c of f.sketch?.data.constraints ?? []) add(c.value);
  for (const p of f.variableFillet?.points ?? []) add(p.radius);
  return [...out];
}

/** The measured variables in a feature list (switched on, with a name), by name, in order: the first of a name wins. */
export function measuredFeatures(features: readonly Feature[]): Map<string, Feature> {
  const out = new Map<string, Feature>();
  for (const f of features) {
    const name = f.type === "variable" && !f.suppressed ? f.measured?.name : undefined;
    if (name && !out.has(name)) out.set(name, f);
  }
  return out;
}

/**
 * Features that use a measured variable before it's measured (by feature id, with the plain reason). A variable the
 * design's own Variables table has is never a measured one here (`known`).
 */
export function usedTooEarly(features: readonly Feature[], known: ReadonlySet<string> = new Set()): Map<string, string> {
  const later = measuredFeatures(features);
  const out = new Map<string, string>();
  if (!later.size) return out;
  const done = new Set<string>();
  for (const f of features) {
    if (f.suppressed) continue;
    const early = namesUsedBy(f).find((n) => later.has(n) && !done.has(n) && !known.has(n) && later.get(n) !== f);
    if (early) out.set(f.id, tooEarlyMessage(early, later.get(early)!.name));
    if (f.type === "variable" && f.measured?.name && later.get(f.measured.name) === f) done.add(f.measured.name);
  }
  return out;
}

export const tooEarlyMessage = (name: string, by: string) =>
  `"${name}" is measured by ${by}, further down the list, so it can't be used here. Move this feature below ${by} (a measured variable can only be used by the features after it).`;

export const switchedOffMessage = (name: string, by: string) => `"${name}" is measured by ${by}, which is switched off, so this can't be built. Switch ${by} back on.`;

export const otherStudioMessage = (name: string) => `"${name}" is measured in another Part Studio, so it can't be used here (a measured variable belongs to its own Part Studio).`;

export const notMeasuredMessage = (name: string, by: string) => `"${name}" couldn't be measured (${by} has a problem), so this can't be built. Fix ${by} first.`;

/** Parts and features (Plane features) a measured variable needs. */
export function measuredUses(f: Feature): { parts: string[]; features: string[] } {
  const parts: string[] = [];
  const features: string[] = [];
  for (const t of f.measured?.targets ?? []) {
    if (isPlaneTarget(t)) {
      if (!(DEFAULT_PLANES as readonly string[]).includes(t.plane)) features.push(t.plane);
    } else parts.push(t.partId);
  }
  return { parts, features };
}

/** Plain settings from untrusted JSON (null if they don't make sense). */
export function parseMeasuredDef(raw: unknown): MeasuredDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const kind = MEASURE_KINDS.find((k) => k.kind === r.kind)?.kind ?? "distance";
  const along = r.along === "x" || r.along === "y" || r.along === "z" ? r.along : undefined;
  const targets: MeasureTarget[] = (Array.isArray(r.targets) ? r.targets : [])
    .map((t): MeasureTarget | null => {
      if (t && typeof t === "object" && typeof (t as Record<string, unknown>).plane === "string") return { plane: (t as { plane: string }).plane };
      const ref = (t as { ref?: { kind?: unknown } } | null)?.ref;
      return ref?.kind === "vertex" ? parseVertexPick(t) : parsePick(t);
    })
    .filter((t): t is MeasureTarget => !!t);
  return { name: r.name, kind, ...(kind === "distance" && along ? { along } : {}), targets };
}

/**
 * Why this measured variable's name can't be accepted, or null: not a usable name, a name the Variables table has
 * (`tableNames`), or one another measured variable in the Part Studio has (`otherMeasured`).
 */
export function measuredNameProblem(def: MeasuredDef | undefined, tableNames: readonly string[], otherMeasured: readonly string[]): string | null {
  if (!def) return null;
  const problem = checkName(def.name, []);
  if (problem) return `Variable name: ${problem}.`;
  if (tableNames.includes(def.name)) return `The Variables table already has a variable called "${def.name}". Give this one another name.`;
  if (otherMeasured.includes(def.name)) return `Another measured variable is already called "${def.name}". Give this one another name.`;
  return null;
}

/** The other measured variables' names in a feature list (all but `id`). */
export function otherMeasuredNames(features: readonly Feature[], id: string): string[] {
  return features.filter((f) => f.id !== id && f.type === "variable" && f.measured).map((f) => f.measured!.name);
}

/**
 * The measured variables a feature list's features can use by name, as last built (by name; angles marked as
 * expr.ts does): only those switched on and, with `before`, above that feature (all of them when it isn't in the list
 * yet — a new one goes at the end).
 */
export function measuredScopeFor(features: readonly Feature[], values: Readonly<Record<string, MeasuredValue>>, before?: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of features) {
    if (before && f.id === before) break;
    const v = f.type === "variable" && !f.suppressed ? values[f.id] : undefined;
    if (!v || v.name in out) continue;
    out[v.name] = v.value;
    if (v.angle) out[`°${v.name}`] = 1;
  }
  return out;
}

/** A direction measured: a straight edge's (`line`, leaving `corner` when two edges meet there) or a flat face's / plane's normal. */
export interface MeasuredDirection {
  dir: [number, number, number];
  kind: "line" | "plane";
}

/**
 * The angle (degrees) between two directions as Onshape measures it: two edges leaving the same corner, the angle at
 * that corner (0–180, `atCorner`); a line and a plane, the line's slope to it (0–90); otherwise the angle between the
 * lines or planes (0–90).
 */
export function measuredAngle(a: MeasuredDirection, b: MeasuredDirection, atCorner = false): number {
  const len = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);
  const d = (a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]) / (len(a.dir) * len(b.dir));
  const c = Math.max(-1, Math.min(1, atCorner && a.kind === "line" && b.kind === "line" ? d : Math.abs(d)));
  let deg = (Math.acos(c) * 180) / Math.PI;
  if (a.kind !== b.kind) deg = 90 - deg;
  return deg;
}
