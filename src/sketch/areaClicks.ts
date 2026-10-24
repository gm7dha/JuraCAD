/**
 * Clicking a sketch's areas in the 3D view (as in Onshape) while an Extrude,
 * Revolve or Sweep dialog is open: which area is under the pointer, how each
 * area is shaded, and when area clicks take priority over faces. Clicks are
 * turned into picks with the same `toggleArea` the 2D map uses, so the saved
 * picks are identical whichever way they were made.
 */
import type { Feature } from "../model/types";
import { areasUsedByAll, pickedAreas, sketchAreas, toggleArea, type AreaMap, type AreaPick } from "./areas";
import type { SketchLinkInfo } from "./links";
import { dot, toSketch, type PlaneFrame, type SketchPlane, type Vec3 } from "./planes";
import type { Pt } from "./regions";
import type { SketchData } from "./types";

/** How an area is drawn: picked (strong), used by "every closed shape" (medium), or just clickable (faint). */
export type AreaShade = "picked" | "used" | "none";

/**
 * Above this many areas (a fine grid of lines), "every closed shape" isn't
 * shaded: working out which areas it uses isn't worth the wait there.
 */
export const MAX_SHADED_AREAS = 1000;

/** Each area's shade (by index in `sketchAreas(sketch).areas`), the same rule as the 2D map. */
export function areaShades(sketch: SketchData, areas: (AreaPick | (number | string)[])[] | undefined): AreaShade[] {
  const map = sketchAreas(sketch);
  if (!areas?.length) {
    if (map.areas.length > MAX_SHADED_AREAS) return map.areas.map(() => "none");
    const used = areasUsedByAll(sketch);
    return map.areas.map((_a, i) => (used.has(i) ? "used" : "none"));
  }
  const { picked } = pickedAreas(map, areas);
  return map.areas.map((_a, i) => (picked.has(i) ? "picked" : "none"));
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
  if (!draft || !draft.sketchRef || draft.surface) return "off";
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
