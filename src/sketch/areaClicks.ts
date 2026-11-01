/**
 * Clicking a sketch's areas in the 3D view (as in Onshape) while an Extrude,
 * Revolve or Sweep dialog is open: which area is under the pointer, how each
 * area is shaded, and when area clicks take priority over faces. Clicks are
 * turned into picks with the same `toggleArea` the 2D map uses, so the saved
 * picks are identical whichever way they were made.
 */
import type { Feature } from "../model/types";
import { areasUsedByAll, pickedAreas, pickOf, sketchAreas, toggleArea, type AreaMap, type AreaPick } from "./areas";
import { defaultAxis } from "./axis";
import type { SketchLinkInfo } from "./links";
import { dot, toSketch, type PlaneFrame, type SketchPlane, type Vec3 } from "./planes";
import type { Pt } from "./regions";
import type { SketchData } from "./types";

/**
 * How an area is drawn: picked (strong), used by "every closed shape" (medium),
 * already used by another feature ("taken": shaded grey, still clickable), or
 * just clickable (faint).
 */
export type AreaShade = "picked" | "used" | "taken" | "none";

const NO_AREAS: ReadonlySet<number> = new Set();

/**
 * Above this many areas (a fine grid of lines), "every closed shape" isn't
 * shaded: working out which areas it uses isn't worth the wait there.
 */
export const MAX_SHADED_AREAS = 1000;

/**
 * Each area's shade (by index in `sketchAreas(sketch).areas`), the same rule as
 * the 2D map. `taken`: areas other features already use (see `areasTaken`),
 * shown when this feature doesn't use them itself.
 */
export function areaShades(sketch: SketchData, areas: (AreaPick | (number | string)[])[] | undefined, taken: ReadonlySet<number> = NO_AREAS): AreaShade[] {
  const map = sketchAreas(sketch);
  const rest = (i: number): AreaShade => (taken.has(i) ? "taken" : "none");
  if (!areas?.length) {
    if (map.areas.length > MAX_SHADED_AREAS) return map.areas.map((_a, i) => rest(i));
    const used = areasUsedByAll(sketch);
    return map.areas.map((_a, i) => (used.has(i) ? "used" : rest(i)));
  }
  const { picked } = pickedAreas(map, areas);
  return map.areas.map((_a, i) => (picked.has(i) ? "picked" : rest(i)));
}

/** Whether a feature takes areas from its sketch (a solid Extrude, Revolve or Sweep). */
export function usesAreas(f: Pick<Feature, "type" | "surface">): boolean {
  return (f.type === "extrude" || f.type === "revolve" || f.type === "sweep") && !f.surface;
}

/**
 * The areas of a sketch (by index in `sketchAreas(data).areas`) that other
 * features already use: each unsuppressed solid Extrude, Revolve or Sweep of
 * it except `exceptId` — its picked areas, or with none picked the areas
 * "every closed shape" covers. Shown shaded so it's clear what's left.
 */
const takenCache = new WeakMap<Feature[], Map<string, { data: SketchData; taken: Set<number> }>>();
export function areasTaken(features: Feature[], sketchId: string, data: SketchData, exceptId?: string): Set<number> {
  // Worked out once per list of features (a dialog re-draws on every key pressed; the list only changes with the design).
  let known = takenCache.get(features);
  if (!known) takenCache.set(features, (known = new Map()));
  const key = `${sketchId}\u0000${exceptId ?? ""}`;
  const hit = known.get(key);
  if (hit && hit.data === data) return hit.taken;
  const taken = takenBy(features, sketchId, data, exceptId);
  known.set(key, { data, taken });
  return taken;
}

function takenBy(features: Feature[], sketchId: string, data: SketchData, exceptId?: string): Set<number> {
  const map = sketchAreas(data);
  const taken = new Set<number>();
  for (const f of features) {
    if (f.id === exceptId || f.suppressed || !usesAreas(f)) continue;
    // Areas it takes from this sketch as one of several.
    for (const m of f.moreAreas ?? []) if (m.sketch === sketchId) for (const i of pickedAreas(map, m.areas).picked) taken.add(i);
    if (f.sketchRef !== sketchId) continue;
    if (f.areas?.length) for (const i of pickedAreas(map, f.areas).picked) taken.add(i);
    else if (map.areas.length <= MAX_SHADED_AREAS) for (const i of areasUsedByAll(data)) taken.add(i);
  }
  return taken;
}

/**
 * What a new feature should start with when its sketch is already used by
 * other features: the areas "every closed shape" covers that nothing uses yet
 * (so a second Extrude of a sketch with two circles starts on the circle that's
 * left). Undefined (every closed shape, as before) when nothing is used yet,
 * when everything is, or for a very busy sketch.
 */
export function freeAreas(features: Feature[], sketchId: string, data: SketchData, exceptId?: string): AreaPick[] | undefined {
  const map = sketchAreas(data);
  if (map.areas.length > MAX_SHADED_AREAS) return undefined;
  const taken = areasTaken(features, sketchId, data, exceptId);
  if (!taken.size) return undefined;
  const all = [...areasUsedByAll(data)];
  const free = all.filter((i) => !taken.has(i));
  if (!free.length || free.length === all.length) return undefined;
  return free.map((i) => pickOf(map.areas[i]));
}

/** Where a line from the eye (`origin`, along `dir`) meets the sketch plane: sketch (x, y) and how far along. Null when it runs parallel or the plane is behind. */
export function rayOnPlane(frame: PlaneFrame, origin: Vec3, dir: Vec3): { at: Pt; distance: number } | null {
  const along = dot(dir, frame.n);
  if (Math.abs(along) < 1e-12) return null;
  const d: Vec3 = [frame.origin[0] - origin[0], frame.origin[1] - origin[1], frame.origin[2] - origin[2]];
  const t = dot(d, frame.n) / along;
  if (t < 0) return null;
  const hit: Vec3 = [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
  return { at: toSketch(frame, hit), distance: t * Math.hypot(dir[0], dir[1], dir[2]) };
}

/** The area under a line from the eye (index into the map's areas), with how far away it is; null when there's none. */
export function areaUnderRay(map: AreaMap, frame: PlaneFrame, origin: Vec3, dir: Vec3): { index: number; distance: number } | null {
  const hit = rayOnPlane(frame, origin, dir);
  if (!hit) return null;
  const index = map.areaAt(hit.at);
  return index >= 0 ? { index, distance: hit.distance } : null;
}

/** The feature's picks after clicking the area at a 3D point on the sketch plane (unchanged when no area is there). */
export function clickAreaAt(sketch: SketchData, frame: PlaneFrame, point: Vec3, areas: AreaPick[] | undefined): AreaPick[] | undefined {
  const map = sketchAreas(sketch);
  const index = map.areaAt(toSketch(frame, point));
  return index >= 0 ? toggleArea(map, areas, index) : areas;
}

/**
 * Whether a feature being edited takes area clicks in the 3D view, and how:
 * "first" — an area under the pointer wins over faces and edges (a preview of
 * the feature sits right on the areas); "afterParts" — the extrude's end is
 * being picked ("Up to face", "Up to vertex", "Up to part"), so faces win and
 * only clicks that miss every part reach the areas; "off" — no areas to click
 * (not an extrude, revolve or sweep, a surface, or no sketch chosen yet).
 */
export function areaClickMode(draft: Pick<Feature, "type" | "sketchRef" | "surface" | "extrude"> | null | undefined): "off" | "first" | "afterParts" {
  // No sketch chosen yet is fine: clicking an area of any sketch chooses it (as in Onshape).
  if (!draft || draft.surface) return "off";
  if (draft.type !== "extrude" && draft.type !== "revolve" && draft.type !== "sweep") return "off";
  const end = draft.type === "extrude" ? draft.extrude?.end : undefined;
  return end === "upToFace" || end === "upToVertex" || end === "upToPart" ? "afterParts" : "first";
}

/**
 * The sketch an Extrude, Revolve or Sweep really uses: a sketch on a part's
 * face follows the face, so when the engine moved it (`SketchLinkInfo.sketch`)
 * its areas are there, not where the sketch was saved. The 3D view, its clicks
 * and the 2D map all use this, so area numbers mean the same everywhere.
 */
export function followedSketch(feature: Pick<Feature, "id" | "sketch"> | undefined, links: Record<string, SketchLinkInfo | undefined>): { plane: SketchPlane | null; data: SketchData } | null {
  const saved = feature?.sketch;
  if (!feature || !saved) return null;
  const link = links[feature.id];
  if (link?.sketch) return link.sketch;
  return { plane: link?.plane ?? saved.plane ?? null, data: saved.data };
}

/** Each area's outline and holes, as one array per area map (the same array each time, so drawings can be kept). */
const outlinesOf = new WeakMap<AreaMap, { outer: Pt[]; holes: Pt[][] }[]>();
export function areaOutlines(map: AreaMap): { outer: Pt[]; holes: Pt[][] }[] {
  let o = outlinesOf.get(map);
  if (!o) outlinesOf.set(map, (o = map.areas.map((a) => ({ outer: a.outer.polygon, holes: a.holes.map((h) => h.polygon) }))));
  return o;
}

/**
 * The sketches whose areas can be clicked while `draft` is open (as in Onshape,
 * hidden ones too — those show only under the pointer, and only while the dialog is open):
 * unsuppressed sketches with a plane above the feature in the list (all of
 * them for a new one, but none below the rollback bar), the feature's own
 * sketch first. A sweep's path sketch is left out (its profile must be
 * another sketch).
 */
export function clickableAreaSketches(features: Feature[], draft: Pick<Feature, "id"> & Partial<Pick<Feature, "sketchRef" | "pathRef">>, rollbackTo?: string | null): Feature[] {
  // Never below the rollback bar (features after it aren't built).
  const bar = rollbackTo ? features.findIndex((f) => f.id === rollbackTo) : -1;
  const built = bar >= 0 ? features.slice(0, bar + 1) : features;
  const at = built.findIndex((f) => f.id === draft.id);
  const before = at >= 0 ? built.slice(0, at) : built;
  const list = before.filter((f) => f.type === "sketch" && !f.suppressed && f.sketch?.plane && (f.id === draft.sketchRef || f.id !== draft.pathRef));
  const own = list.filter((f) => f.id === draft.sketchRef);
  return own.length ? [...own, ...list.filter((f) => f.id !== draft.sketchRef)] : list;
}

/**
 * Clicking area `index` of sketch `sketchId` (its areas worked out from
 * `data`) while a feature is open: the same sketch toggles the area, as the 2D
 * map does. Another sketch: an Extrude, Revolve or Sweep (solid) with areas
 * already picked takes areas of several sketches (as in Onshape), so the area
 * is added to (or taken out of) `moreAreas`; otherwise that sketch becomes the feature's sketch, with
 * just that area picked, and `message` says so when a sketch was already chosen.
 * When the feature's own sketch is left with nothing picked while other
 * sketches still have areas, the next of those becomes its sketch (nothing
 * picked would mean every closed shape).
 */
export function areaClickChange(
  draft: Pick<Feature, "type" | "name" | "sketchRef" | "areas" | "revolve" | "pathRef" | "moreAreas" | "surface">,
  sketch: { id: string; name: string },
  data: SketchData,
  index: number,
): { patch: Partial<Pick<Feature, "sketchRef" | "areas" | "revolve" | "moreAreas">>; message?: string } {
  const map = sketchAreas(data);
  const more = draft.moreAreas ?? [];
  const tidy = (sketchRef: string | undefined, areas: AreaPick[] | undefined, rest: { sketch: string; areas: AreaPick[] }[]) => {
    const kept = rest.filter((m) => m.areas.length);
    if (!areas?.length && kept.length) return { sketchRef: kept[0].sketch, areas: kept[0].areas, moreAreas: kept.length > 1 ? kept.slice(1) : undefined };
    return { sketchRef, areas, moreAreas: kept.length ? kept : undefined };
  };
  if (sketch.id === draft.sketchRef) {
    const areas = toggleArea(map, draft.areas, index);
    return { patch: more.length ? tidy(draft.sketchRef, areas, more) : { areas } };
  }
  // Several sketches: a solid extrude, revolve or sweep whose own areas are picked, or a sketch it already takes areas from.
  const inMore = more.find((m) => m.sketch === sketch.id);
  if (takesSeveral(draft) && (draft.areas?.length || inMore)) {
    const toggled = toggleArea(map, inMore?.areas, index) ?? [];
    const rest = inMore ? more.map((m) => (m.sketch === sketch.id ? { ...m, areas: toggled } : m)) : [...more, { sketch: sketch.id, areas: toggled }];
    return { patch: tidy(draft.sketchRef, draft.areas, rest) };
  }
  const patch: Partial<Pick<Feature, "sketchRef" | "areas" | "revolve" | "moreAreas">> = { sketchRef: sketch.id, areas: toggleArea(map, undefined, index), ...(more.length ? { moreAreas: undefined } : {}) };
  if (draft.type === "revolve") patch.revolve = { ...(draft.revolve ?? { flip: false }), axis: defaultAxis(data) };
  const message = draft.sketchRef
    ? `${draft.name} now uses ${sketch.name}. ${takesSeveral(draft) ? "To use areas of several sketches, pick an area of the first sketch, then click areas in the others." : "A surface takes its shapes from one sketch."}`
    : undefined;
  return { patch, ...(message ? { message } : {}) };
}

/** Whether a feature can take areas of several sketches (`moreAreas`): a solid extrude, revolve or sweep. */
export function takesSeveral(draft: Pick<Feature, "type" | "surface">): boolean {
  return (draft.type === "extrude" || draft.type === "revolve" || draft.type === "sweep") && !draft.surface;
}

/**
 * Areas clicked in the 3D view with no dialog open, waiting for Extrude,
 * Revolve or Sweep (as in Onshape): those of the first sketch clicked, and
 * (`more`, missing when none) those of any other sketches, in click order.
 */
export interface AreaSelection {
  sketch: string;
  areas: AreaPick[];
  more?: { sketch: string; areas: AreaPick[] }[];
}

/**
 * Click an area with nothing open: select it, or unselect it if it was
 * selected. Areas of several sketches can be selected together (as in
 * Onshape); when the first sketch has none left, the next one with areas
 * selected takes its place. Null when nothing is left.
 */
export function selectArea(selection: AreaSelection | null, sketchId: string, data: SketchData, index: number): AreaSelection | null {
  const map = sketchAreas(data);
  const all = selection ? [{ sketch: selection.sketch, areas: selection.areas }, ...(selection.more ?? [])] : [];
  const at = all.findIndex((x) => x.sketch === sketchId);
  const toggled = toggleArea(map, at >= 0 ? all[at].areas : undefined, index) ?? [];
  const next = at >= 0 ? all.map((x, i) => (i === at ? { sketch: sketchId, areas: toggled } : x)) : [...all, { sketch: sketchId, areas: toggled }];
  const kept = next.filter((x) => x.areas.length);
  if (!kept.length) return null;
  const [first, ...rest] = kept;
  return rest.length ? { ...first, more: rest } : first;
}

/** The areas selected in one sketch (none: an empty list). */
export function selectedIn(selection: AreaSelection | null, sketchId: string): AreaPick[] {
  if (!selection) return [];
  if (selection.sketch === sketchId) return selection.areas;
  return selection.more?.find((m) => m.sketch === sketchId)?.areas ?? [];
}

/** How many areas are selected, in all the sketches. */
export function selectedCount(selection: AreaSelection | null): number {
  return selection ? selection.areas.length + (selection.more ?? []).reduce((n, m) => n + m.areas.length, 0) : 0;
}

/** The areas of a sketch that are selected (by index), for shading. */
export function selectedAreaShades(selection: AreaSelection | null, sketchId: string, data: SketchData): AreaShade[] {
  const map = sketchAreas(data);
  const mine = selectedIn(selection, sketchId);
  const picked = mine.length ? pickedAreas(map, mine).picked : NO_AREAS;
  return map.areas.map((_a, i) => (picked.has(i) ? "picked" : "none"));
}

/**
 * What a new Extrude, Revolve or Sweep starts with from areas selected
 * beforehand: the first usable sketch's areas as its own, the rest as
 * `moreAreas`. `usable` says whether a sketch can be used (there, unsuppressed,
 * with a plane); a sweep's path is left out by the caller. Null when no
 * selected sketch is usable. A surface takes just the first.
 */
export function selectionStart(
  selection: AreaSelection,
  usable: (sketchId: string) => boolean,
  several: boolean,
): { sketchRef: string; areas: AreaPick[]; moreAreas?: { sketch: string; areas: AreaPick[] }[] } | null {
  const list = [{ sketch: selection.sketch, areas: selection.areas }, ...(selection.more ?? [])].filter((x) => x.areas.length && usable(x.sketch));
  if (!list.length) return null;
  const [first, ...rest] = list;
  return { sketchRef: first.sketch, areas: first.areas, ...(several && rest.length ? { moreAreas: rest } : {}) };
}

/**
 * Whether areas selected with nothing open should be let go after a store
 * change from `before` to `now`: the design changed (undo, redo, a new or
 * opened file, a change from Claude), another tab is on show, a sketch or a
 * feature dialog opened, or a feature was picked in the list.
 */
export function areaSelectionLapses(
  before: { history: { present: unknown }; activeTab: unknown; editing: unknown; sketch: unknown; selectedFeatureId: string | null },
  now: { history: { present: unknown }; activeTab: unknown; editing: unknown; sketch: unknown; selectedFeatureId: string | null },
): boolean {
  return (
    now.history.present !== before.history.present ||
    now.activeTab !== before.activeTab ||
    (!!now.editing && !before.editing) ||
    (!!now.sketch && !before.sketch) ||
    (!!now.selectedFeatureId && now.selectedFeatureId !== before.selectedFeatureId)
  );
}

/**
 * The sketches a feature's dialog offers: those above the feature in the list
 * when it's being edited; for a new feature, every sketch above the rollback
 * bar (it goes in there), or all of them.
 */
export function sketchesOffered(features: Feature[], draftId: string, editing: boolean, rollbackTo?: string | null): Feature[] {
  const at = features.findIndex((f) => f.id === draftId);
  const bar = rollbackTo ? features.findIndex((f) => f.id === rollbackTo) : -1;
  const before = editing && at >= 0 ? features.slice(0, at) : bar >= 0 ? features.slice(0, bar + 1) : features;
  return before.filter((f) => f.type === "sketch");
}

/**
 * A sweep's path set to `pathRef`: a sketch can't be both a profile and the
 * path, so if it was one of the extra profiles (`moreAreas`) it's left out.
 */
export function pathChange(draft: Pick<Feature, "moreAreas">, pathRef: string | undefined): Partial<Pick<Feature, "pathRef" | "moreAreas">> {
  if (!pathRef || !draft.moreAreas?.some((m) => m.sketch === pathRef)) return { pathRef };
  const rest = draft.moreAreas.filter((m) => m.sketch !== pathRef);
  return { pathRef, moreAreas: rest.length ? rest : undefined };
}
