/**
 * Clicking a sketch's areas in the 3D view (as in Onshape) while an Extrude,
 * Revolve or Sweep dialog is open: which area is under the pointer, how each
 * area is shaded, and when area clicks take priority over faces. Clicks are
 * turned into picks with the same `toggleArea` the 2D map uses, so the saved
 * picks are identical whichever way they were made.
 */
import type { Feature } from "../model/types";
import { areasUsedByAll, pickedAreas, sketchAreas, toggleArea, type AreaMap, type AreaPick } from "./areas";
import { dot, toSketch, type PlaneFrame, type Vec3 } from "./planes";
import type { Pt } from "./regions";
import type { SketchData } from "./types";

/** How an area is drawn: picked (strong), used by "every closed shape" (medium), or just clickable (faint). */
export type AreaShade = "picked" | "used" | "none";

/** Each area's shade (by index in `sketchAreas(sketch).areas`), the same rule as the 2D map. */
export function areaShades(sketch: SketchData, areas: (AreaPick | (number | string)[])[] | undefined): AreaShade[] {
  const map = sketchAreas(sketch);
  if (!areas?.length) {
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
