/**
 * Compare two designs (two versions, or a version with now): which features
 * were added, removed or changed — and which of their settings, old → new —
 * which variables changed, and which parts were added or removed. Pure.
 *
 * Features, variables, drawings and assemblies are matched by their permanent
 * ids, so a renamed feature is "changed (name)", not "removed + added".
 */
import { FEATURE_DEFS } from "./features";
import { studiosOf } from "./studios";
import type { Feature, JuraCADDocument } from "./types";
import { designOf } from "./versions";

export interface SettingChange {
  /** What changed, in words: "Width (X)", "Name", "Suppressed", "Sketch". */
  what: string;
  from: string;
  to: string;
}

export interface FeatureChange {
  id: string;
  /** Its name now (in the newer design), or its last name when removed. */
  name: string;
  /** "Box", "Extrude"… */
  kind: string;
  studio: string;
  change: "added" | "removed" | "changed";
  /** Changed only: the settings that differ (at most MAX_SETTINGS, then one "…and N more"). */
  settings: SettingChange[];
}

export interface VariableChange {
  name: string;
  change: "added" | "removed" | "changed";
  from?: string;
  to?: string;
}

export interface PartChange {
  id: string;
  name: string;
  change: "added" | "removed";
}

export interface DesignChanges {
  features: FeatureChange[];
  variables: VariableChange[];
  /** Null when the parts of one side aren't known (not built yet). */
  parts: PartChange[] | null;
  /** Anything else, in words: "Drawing 1 changed", "Part Studio 2 added", "Units changed to inches". */
  other: string[];
  /** Nothing at all differs (versions ignored). */
  same: boolean;
}

/** A built part, as far as the comparison needs: its id and the name shown. */
export interface PartInfo {
  id: string;
  name: string;
}

export const MAX_SETTINGS = 12;
const VALUE_CHARS = 48;

/** "upTo" → "up to", "dx" → "dx". */
function words(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function shortValue(v: unknown): string {
  if (v === undefined) return "(none)";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v.length > VALUE_CHARS ? v.slice(0, VALUE_CHARS - 1) + "…" : v || "(empty)";
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return shortValue(v.join(", "));
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  return "set";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a sketch holds, in words ("4 lines, 1 circle, 3 dimensions"). */
function sketchSummary(f: Feature | undefined): string {
  const d = f?.sketch?.data;
  if (!d) return "(none)";
  const curves = new Map<string, number>();
  for (const c of d.curves) curves.set(c.type, (curves.get(c.type) ?? 0) + 1);
  const dims = d.constraints.filter((c) => c.value !== undefined).length;
  const parts = [...curves].map(([t, n]) => `${n} ${words(t)}${n === 1 ? "" : "s"}`);
  if (dims) parts.push(`${dims} dimension${dims === 1 ? "" : "s"}`);
  if (d.texts?.length) parts.push(`${d.texts.length} text${d.texts.length === 1 ? "" : "s"}`);
  return parts.join(", ") || "empty";
}

/** The settings that differ between two copies of one feature. */
export function featureSettingChanges(a: Feature, b: Feature): SettingChange[] {
  const out: SettingChange[] = [];
  const labels = new Map((FEATURE_DEFS[b.type]?.params ?? FEATURE_DEFS[a.type]?.params ?? []).map((p) => [p.key, p.label]));
  if (a.name !== b.name) out.push({ what: "Name", from: a.name, to: b.name });
  if (a.type !== b.type) out.push({ what: "Kind", from: FEATURE_DEFS[a.type]?.label ?? a.type, to: FEATURE_DEFS[b.type]?.label ?? b.type });
  if (a.operation !== b.operation) out.push({ what: "Operation", from: a.operation, to: b.operation });
  if (!!a.suppressed !== !!b.suppressed) out.push({ what: "Suppressed", from: shortValue(!!a.suppressed), to: shortValue(!!b.suppressed) });
  // Typed values, in the order the dialog lists them.
  const keys = [...new Set([...labels.keys(), ...Object.keys(a.params ?? {}), ...Object.keys(b.params ?? {})])];
  for (const k of keys) {
    const x = a.params?.[k];
    const y = b.params?.[k];
    if (x !== y && (x !== undefined || y !== undefined)) out.push({ what: labels.get(k) ?? words(k), from: shortValue(x), to: shortValue(y) });
  }
  // The sketch itself: dimension values by dimension, then the shapes as a whole.
  if (!same(a.sketch, b.sketch)) {
    const dimsA = new Map((a.sketch?.data.constraints ?? []).filter((c) => c.value !== undefined).map((c) => [c.id, c]));
    let dimChanges = 0;
    for (const c of b.sketch?.data.constraints ?? []) {
      const old = dimsA.get(c.id);
      if (c.value !== undefined && old && old.value !== c.value) {
        out.push({ what: `Sketch ${words(c.type)} dimension`, from: shortValue(old.value), to: shortValue(c.value) });
        dimChanges++;
      }
    }
    const sa = sketchSummary(a);
    const sb = sketchSummary(b);
    if (sa !== sb) out.push({ what: "Sketch", from: sa, to: sb });
    else if (!dimChanges) {
      const plane = !same(a.sketch?.plane, b.sketch?.plane);
      out.push({ what: plane ? "Sketch plane" : "Sketch shapes", from: plane ? "before" : "as before", to: plane ? "moved" : "moved or reshaped" });
    }
  }
  // Everything else on the feature (picked edges, the sketch used, hole and pattern settings…), one line per field.
  const skip = new Set(["id", "name", "type", "operation", "suppressed", "params", "sketch", "folder", "visible"]);
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !skip.has(k));
  for (const k of fields) {
    const x = (a as unknown as Record<string, unknown>)[k];
    const y = (b as unknown as Record<string, unknown>)[k];
    if (same(x, y)) continue;
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      // One level down: "hole › diameter"-style settings.
      const inner = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const ik of inner) {
        const xi = (x as Record<string, unknown>)[ik];
        const yi = (y as Record<string, unknown>)[ik];
        if (!same(xi, yi)) out.push({ what: `${words(k)} › ${words(ik)}`, ...pair(xi, yi) });
      }
    } else out.push({ what: k === "picks" ? "Picked faces and edges" : k === "sketchRef" ? "Sketch used" : words(k), ...pair(x, y) });
  }
  if (out.length > MAX_SETTINGS) {
    const more = out.length - (MAX_SETTINGS - 1);
    return [...out.slice(0, MAX_SETTINGS - 1), { what: `…and ${more} more`, from: "", to: "" }];
  }
  return out;
}

/** Old → new for values that may be objects (shown as "changed" when they can't be shortened). */
function pair(x: unknown, y: unknown): { from: string; to: string } {
  const from = shortValue(x);
  const to = shortValue(y);
  return from === to ? { from: "before", to: "changed" } : { from, to };
}

/**
 * What changed going from `older` to `newer`. Parts are compared when both
 * sides' built parts are given (null for either = not known yet).
 */
export function compareDesigns(
  older: JuraCADDocument,
  newer: JuraCADDocument,
  partsOlder: readonly PartInfo[] | null = null,
  partsNewer: readonly PartInfo[] | null = null,
): DesignChanges {
  const a = designOf(older);
  const b = designOf(newer);
  const features: FeatureChange[] = [];
  const studiosA = studiosOf(a);
  const studiosB = studiosOf(b);
  const where = (doc: typeof studiosA) => {
    const m = new Map<string, { f: Feature; studio: string }>();
    for (const st of doc) for (const f of st.features) m.set(f.id, { f, studio: st.name });
    return m;
  };
  const fa = where(studiosA);
  const fb = where(studiosB);
  const kind = (f: Feature) => FEATURE_DEFS[f.type]?.label ?? f.type;
  // In the newer design's order, with removed ones after.
  for (const [id, { f, studio }] of fb) {
    const old = fa.get(id);
    if (!old) features.push({ id, name: f.name, kind: kind(f), studio, change: "added", settings: [] });
    else if (!same(old.f, f)) {
      const settings = featureSettingChanges(old.f, f);
      // Only list it when something that matters changed (not just the folder it's shown in or its eye).
      if (settings.length) features.push({ id, name: f.name, kind: kind(f), studio, change: "changed", settings });
    }
  }
  for (const [id, { f, studio }] of fa) if (!fb.has(id)) features.push({ id, name: f.name, kind: kind(f), studio, change: "removed", settings: [] });

  const variables: VariableChange[] = [];
  const va = new Map((a.variables ?? []).map((v) => [v.id, v]));
  const vb = new Map((b.variables ?? []).map((v) => [v.id, v]));
  for (const [id, v] of vb) {
    const old = va.get(id);
    if (!old) variables.push({ name: v.name, change: "added", to: v.value });
    else if (old.value !== v.value || old.name !== v.name)
      variables.push({ name: old.name === v.name ? v.name : `${old.name} → ${v.name}`, change: "changed", from: old.value, to: v.value });
  }
  for (const [id, v] of va) if (!vb.has(id)) variables.push({ name: v.name, change: "removed", from: v.value });

  let parts: PartChange[] | null = null;
  if (partsOlder && partsNewer) {
    const ids = new Set(partsOlder.map((p) => p.id));
    const idsNew = new Set(partsNewer.map((p) => p.id));
    parts = [
      ...partsNewer.filter((p) => !ids.has(p.id)).map((p) => ({ id: p.id, name: p.name, change: "added" as const })),
      ...partsOlder.filter((p) => !idsNew.has(p.id)).map((p) => ({ id: p.id, name: p.name, change: "removed" as const })),
    ];
  }

  const other: string[] = [];
  const tabs = (label: string, xs: { id: string; name: string }[] | undefined, ys: { id: string; name: string }[] | undefined) => {
    const mx = new Map((xs ?? []).map((x) => [x.id, x]));
    const my = new Map((ys ?? []).map((y) => [y.id, y]));
    for (const [id, y] of my) {
      const x = mx.get(id);
      if (!x) other.push(`${label} "${y.name}" added`);
      else if (!same(x, y)) other.push(x.name !== y.name ? `${label} "${x.name}" renamed to "${y.name}"${same({ ...x, name: "" }, { ...y, name: "" }) ? "" : " and changed"}` : `${label} "${y.name}" changed`);
    }
    for (const [id, x] of mx) if (!my.has(id)) other.push(`${label} "${x.name}" removed`);
  };
  tabs("Part Studio", studiosA.map((s) => ({ id: s.id, name: s.name })), studiosB.map((s) => ({ id: s.id, name: s.name })));
  tabs("Assembly", a.assemblies, b.assemblies);
  tabs("Drawing", a.drawings, b.drawings);
  if (a.name !== b.name) other.push(`Design renamed from "${a.name}" to "${b.name}"`);
  if ((a.units ?? "mm") !== (b.units ?? "mm")) other.push(`Units changed to ${b.units === "in" ? "inches" : "millimetres"}`);
  if (!same(a.appearance ?? {}, b.appearance ?? {})) other.push("Part colours changed");
  if (!same(a.materials ?? {}, b.materials ?? {})) other.push("Materials changed");
  if (!same(a.partNames ?? {}, b.partNames ?? {})) other.push("Part names changed");
  if (!same(a.partProperties ?? {}, b.partProperties ?? {})) other.push("Part numbers or properties changed");
  if (!same(a.configurations ?? [], b.configurations ?? []) || a.activeConfiguration !== b.activeConfiguration) other.push("Configurations changed");

  return {
    features,
    variables,
    parts,
    other,
    same: same(a, b),
  };
}
