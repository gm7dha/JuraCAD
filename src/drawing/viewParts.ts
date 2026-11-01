/**
 * Views of other parts. As in Onshape, a view on a sheet can show its own
 * part or assembly instead of the sheet's: that view (the "base" view) has a
 * `source`, and the views projected from it (`parent`) show the same thing.
 * Sections, details, broken-out cuts and shortenings follow the view they're
 * drawn on (their `host` is that view's key, "front@<base view id>").
 *
 * A sheet is worked on as several drawings, one per part drawn (`partDrawings`):
 * the sheet's own views, and one for each base view with its projected views,
 * each with its views named by kind as before — so the geometry engine is asked
 * for each exactly as for a drawing of that part, and the views come back under
 * their keys on the sheet (`rekeyed`). Drawings without views of other parts
 * are their own single part drawing, unchanged.
 */
import type { ViewProjection } from "../kernel/protocol";
import type { Dimension, Drawing, DrawingView, ViewHost, ViewKind } from "../model/types";
import { sameSource } from "./pages";
import { viewKey } from "./sections";

export type ViewSource = NonNullable<Drawing["source"]>;

/** The base view a view belongs to (its own id when it has a part of its own), or null for the sheet's part. */
export function groupOf(v: Pick<DrawingView, "id" | "source" | "parent">): string | null {
  return v.source ? v.id : (v.parent ?? null);
}

/** A view key split into its kind (or the whole key, for sections and details) and the base view it belongs to. */
export function splitKey(key: string): { kind: string; group: string | null } {
  if (key.startsWith("section:") || key.startsWith("detail:")) return { kind: key, group: null };
  const i = key.indexOf("@");
  return i < 0 ? { kind: key, group: null } : { kind: key.slice(0, i), group: key.slice(i + 1) };
}

/** The kind of view a host is ("front@vw1" → "front"). */
export const hostKind = (host: ViewHost | string): ViewKind => splitKey(host).kind as ViewKind;

/** A view's key from its kind and base view (null = the sheet's part). */
export const keyIn = (kind: string, group: string | null): string => (group ? `${kind}@${group}` : kind);

/** The base view a key on a sheet belongs to: a section or detail belongs to its host's. */
export function keyGroup(d: Pick<Drawing, "sections" | "details">, key: string): string | null {
  if (key.startsWith("section:")) {
    const host = d.sections?.find((c) => `section:${c.id}` === key)?.host;
    return host ? splitKey(host).group : null;
  }
  if (key.startsWith("detail:")) {
    const host = d.details?.find((c) => `detail:${c.id}` === key)?.host;
    return host ? splitKey(host).group : null;
  }
  return splitKey(key).group;
}

/** The views of other parts on a sheet: each base view, with what it shows. */
export function viewParts(d: Pick<Drawing, "views">): { id: string; kind: ViewKind; source: ViewSource }[] {
  return d.views.filter((v) => v.source).map((v) => ({ id: v.id, kind: v.kind, source: v.source! }));
}

/** The base view a sheet view belongs to: its own (`groupOf`), or for a section or detail view, its host's. */
function viewGroup(d: Pick<Drawing, "sections" | "details">, v: DrawingView): string | null {
  return v.kind === "section" || v.kind === "detail" ? keyGroup(d, viewKey(v)) : groupOf(v);
}

/** One part (or assembly) drawn on a sheet, as a drawing of its own: its views named by kind as usual. */
export interface PartDrawing {
  /** The base view (null = the sheet's own part). */
  group: string | null;
  drawing: Drawing;
}

const natural = <T extends { host: ViewHost }>(x: T): T => ({ ...x, host: hostKind(x.host) });

/**
 * A sheet as one drawing per part drawn: first the sheet's own part, then each
 * view of another part with the views projected from it. With no views of
 * other parts, that's just the sheet itself.
 */
export function partDrawings(d: Drawing): PartDrawing[] {
  const bases = viewParts(d);
  if (!bases.length) return [{ group: null, drawing: d }];
  const groups: (string | null)[] = [null, ...bases.map((b) => b.id)];
  return groups.map((group) => {
    const hosted = <T extends { host: ViewHost }>(list: T[] | undefined) => (list ?? []).filter((x) => splitKey(x.host).group === group).map(natural);
    const views = d.views
      .filter((v) => viewGroup(d, v) === group)
      .map(({ source: _s, parent: _p, ...v }) => v);
    const keys = new Set(d.views.filter((v) => viewGroup(d, v) === group).map(viewKey));
    const dims = (d.dimensions ?? []).filter((x) => keys.has(x.view)).map((x): Dimension => ({ ...x, view: splitKey(x.view).kind }));
    const out: Drawing = { ...d, views };
    const put = <K extends "sections" | "details" | "breakouts" | "shortened">(k: K, list: NonNullable<Drawing[K]>) => {
      if (list.length) out[k] = list;
      else delete out[k];
    };
    put("sections", hosted(d.sections));
    put("details", hosted(d.details));
    put("breakouts", hosted(d.breakouts));
    put("shortened", hosted(d.shortened));
    if (dims.length) out.dimensions = dims;
    else delete out.dimensions;
    if (group) out.source = bases.find((b) => b.id === group)!.source;
    return { group, drawing: out };
  });
}

/** A part drawing's views from the geometry engine, under their keys on the sheet. */
export function rekeyed(list: ViewProjection[], group: string | null): ViewProjection[] {
  if (!group) return list;
  return list.map((p) => (p.kind.startsWith("section:") || p.kind.startsWith("detail:") ? p : { ...p, kind: keyIn(p.kind, group) }));
}

/** A part drawing's dimensions (made on it, e.g. by Auto dimension) as dimensions on the sheet. */
export function onSheet(dims: Dimension[], group: string | null): Dimension[] {
  return group ? dims.map((x) => ({ ...x, view: x.view.startsWith("section:") || x.view.startsWith("detail:") ? x.view : keyIn(x.view, group) })) : dims;
}

/** A sheet's views as one part drawing sees them: the views of `group`, by kind. */
export function partProjections<T>(projections: Partial<Record<string, T>>, group: string | null): Partial<Record<string, T>> {
  if (!group) return projections;
  const out: Partial<Record<string, T>> = {};
  for (const [k, p] of Object.entries(projections)) {
    const s = splitKey(k);
    if (s.group === group) out[s.kind] = p;
    else if (s.group === null && (k.startsWith("section:") || k.startsWith("detail:"))) out[k] = p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changes (each returns the changed sheet)

/** The views a base view can have projected from it. */
export const PROJECTED_KINDS: ViewKind[] = ["front", "top", "right", "left", "back", "bottom", "iso", "flat"];

/**
 * Add a view of a part or assembly (`id` its new id), looking from `kind`
 * (default the front). Of the sheet's own part, it's simply that view of the
 * sheet's part (if it isn't shown already). Returns the sheet and the view's key.
 */
export function addViewOf(d: Drawing, id: string, source: ViewSource, kind: ViewKind = "front"): { drawing: Drawing; key: string } {
  if (sameSource(source, d.source) && !d.views.some((v) => groupOf(v) === null && v.kind === kind)) {
    return { drawing: withoutFitOf({ ...d, views: [...d.views, { id: `${d.id}-${kind}`, kind }] }), key: kind };
  }
  return { drawing: withoutFitOf({ ...d, views: [...d.views, { id, kind, source }] }), key: keyIn(kind, id) };
}

/** Show or hide a view projected from base view `group` (the base view itself stays: remove it with removeViewOf). */
export function toggleProjected(d: Drawing, group: string, kind: ViewKind): Drawing {
  const base = d.views.find((v) => v.id === group && v.source);
  if (!base || base.kind === kind) return d;
  const has = d.views.some((v) => v.parent === group && v.kind === kind);
  const next = withoutFitOf(d);
  if (!has) return { ...next, views: [...next.views, { id: `${group}-${kind}`, kind, parent: group }] };
  const key = keyIn(kind, group);
  const out: Drawing = { ...next, views: next.views.filter((v) => !(v.parent === group && v.kind === kind)) };
  const dims = (d.dimensions ?? []).filter((x) => x.view !== key);
  if (dims.length) out.dimensions = dims;
  else delete out.dimensions;
  return out;
}

/** Change what a base view (and the views projected from it) shows. */
export function setViewSource(d: Drawing, group: string, source: ViewSource): Drawing {
  return { ...d, views: d.views.map((v) => (v.id === group && v.source ? { ...v, source } : v)) };
}

/**
 * Remove a view of another part with everything that comes from it: the
 * views projected from it, the sections, details, cuts and shortenings drawn
 * on them (with their views), and the dimensions on all of those.
 */
export function removeViewOf(d: Drawing, group: string): Drawing {
  if (!d.views.some((v) => v.id === group && v.source)) return d;
  const mine = (host: ViewHost) => splitKey(host).group === group;
  const sections = (d.sections ?? []).filter((c) => !mine(c.host));
  const details = (d.details ?? []).filter((c) => !mine(c.host));
  const goneViews = new Set(d.views.filter((v) => viewGroup(d, v) === group).map(viewKey));
  const out: Drawing = { ...withoutFitOf(d), views: d.views.filter((v) => !goneViews.has(viewKey(v))) };
  const keep = <K extends "sections" | "details" | "breakouts" | "shortened" | "dimensions">(k: K, list: NonNullable<Drawing[K]>) => {
    if (list.length) out[k] = list;
    else delete out[k];
  };
  keep("sections", sections);
  keep("details", details);
  keep("breakouts", (d.breakouts ?? []).filter((c) => !mine(c.host)));
  keep("shortened", (d.shortened ?? []).filter((c) => !mine(c.host)));
  keep("dimensions", (d.dimensions ?? []).filter((x) => !goneViews.has(x.view)));
  return out;
}

function withoutFitOf(d: Drawing): Drawing {
  if (!d.fit) return d;
  const { fit: _old, ...rest } = d;
  return rest;
}

/**
 * How a view is named in lists: "Front", or "Front (Bracket)" for a view of
 * another part (`name` gives a part's or assembly's name).
 */
export function viewPartName(d: Pick<Drawing, "views" | "sections" | "details">, key: string, plain: string, name: (s: ViewSource) => string | null): string {
  const group = keyGroup(d, key);
  if (!group) return plain;
  const src = d.views.find((v) => v.id === group)?.source;
  const n = src ? name(src) : null;
  return `${plain} (${n ?? "missing part"})`;
}
