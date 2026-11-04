/**
 * Building blocks for the laser designs: sketches with many loose lines (a
 * living hinge's cuts, a gear's teeth, a ruler's marks), sketches put
 * together from several pieces, and extrudes of chosen areas of a sketch (a
 * plate with its letters engraved into it).
 */
import { sketchId } from "../sketch/ops";
import { pickOf, pointInside, sketchAreas, type AreaPick } from "../sketch/areas";
import { textContours, textsOf } from "../sketch/sketchText";
import type { SketchData, SketchLine } from "../sketch/types";
import { insidePolygon } from "./bridges";
import { stableIds } from "./stableIds";

type Pt = [number, number];

/**
 * Add runs of straight lines through the points (closed: back to the first). The points are left free — a sketch of
 * hundreds of lines held by "fix" relations would take seconds to check — so these sketches show as not fully
 * defined; they're remade exactly by "Edit design sizes".
 */
export function addLines(s: SketchData, runs: { points: Pt[]; closed?: boolean }[]): SketchData {
  const points = [...s.points];
  const curves = [...s.curves];
  for (const run of runs) {
    const ids = run.points.map((p) => {
      const id = sketchId("p");
      points.push({ id, x: p[0], y: p[1] });
      return id;
    });
    const n = run.closed ? ids.length : ids.length - 1;
    for (let i = 0; i < n; i++) curves.push({ id: sketchId("l"), type: "line", p1: ids[i], p2: ids[(i + 1) % ids.length], construction: false } satisfies SketchLine);
  }
  return { ...s, points, curves };
}

/** Several sketches drawn as one (their ids are all different already). */
export function joinSketches(...parts: SketchData[]): SketchData {
  const texts = parts.flatMap((p) => p.texts ?? []);
  return {
    points: parts.flatMap((p) => p.points),
    curves: parts.flatMap((p) => p.curves),
    constraints: parts.flatMap((p) => p.constraints),
    ...(texts.length ? { texts } : {}),
  };
}

/** How many of the sketch's letter outlines are round a point (odd = on a letter, even = outside, or in its hole). */
function letterDepth(s: SketchData, p: Pt): number {
  return textsOf(s)
    .filter((t) => !t.construction)
    .flatMap((t) => textContours(s, t))
    .filter((c) => insidePolygon(p, c)).length;
}

/**
 * The sketch with its final ids (as the library will give it: `stableIds`) and, for each test, picks of the areas
 * where it holds (asked with a point well inside each area and how many letter outlines are round it). Picks are
 * remembered by the curves round them, so the ids must be the ones the feature will have.
 */
export function pickAreas(s: SketchData, featureId: string, ...keeps: ((p: Pt, letters: number) => boolean)[]): { sketch: SketchData; picks: AreaPick[][] } {
  const sketch = stableIds(s, featureId);
  const map = sketchAreas(sketch);
  const inside = map.areas.map((a) => {
    const p = pointInside(a);
    return { a, p, letters: letterDepth(sketch, p) };
  });
  return { sketch, picks: keeps.map((keep) => inside.filter((x) => keep(x.p, x.letters)).map((x) => pickOf(x.a))) };
}

/** Picks of the letters of a sketch's text (not their holes): to engrave them. */
export const onLetters = (_p: Pt, letters: number) => letters % 2 === 1;
