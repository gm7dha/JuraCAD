/**
 * Planes as sketch references with the real OpenCascade engine: a sketch dimensioned to Front's line builds where the
 * dimension puts it, a sketch tied to a Plane feature's line moves when the plane's offset changes, and a plane that's
 * gone (or further down the list) is said plainly.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, PlaneOptions } from "../src/model/types";
import { linkEdge } from "../src/sketch/links";
import { addRectangle, curveById } from "../src/sketch/ops";
import { planeRefs, PLANE_ITEM } from "../src/sketch/planeRefs";
import { planeFrame, type SketchPlane } from "../src/sketch/planes";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuildStudios([{ id: "main", features }]);
}
const r = (v: number[]) => v.map((n) => Math.round(n * 1e4) / 1e4 + 0);
const boundsOf = (parts: { id: string; vertices: Float32Array; triangles: Uint32Array }[], id: string) => {
  const p = parts.find((x) => x.id === id)!;
  const b = analyzeMesh(p.vertices, p.triangles).bounds!;
  return [r(b.min), r(b.max)];
};
const offsetPlane = (distance: number | string): Feature => ({
  ...feature("plane", { distance }),
  planeDef: { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" } as PlaneOptions,
});

/** A 10 × 4 rectangle at (x, y), its bottom-left corner tied to `lineId` by a distance `gap` (a dimension). */
function rectangleTo(data: SketchData, lineId: string, gap: number, x = 3, y = 2): SketchData {
  const rect = addRectangle(data, { x, y, snap: null }, { x: x + 10, y: y + 4, snap: null });
  const bottom = curveById(rect.sketch, rect.lineIds[0]) as SketchLine;
  const corner = bottom.p1;
  // Its sides sized, so it moves rather than stretches.
  const sizes = rect.lineIds.slice(0, 2).map((id, i) => ({ id: `size${i}`, type: "length" as const, refs: [id], value: String(i === 0 ? 10 : 4) }));
  const solved = solveSketch({ ...rect.sketch, constraints: [...rect.sketch.constraints, ...sizes, { id: "gap", type: "pointLineDistance", refs: [corner, lineId], value: String(gap) }] });
  expect(solved.ok).toBe(true);
  return solved.sketch;
}

describe("plane lines in a sketch", () => {
  it("a sketch on Top dimensioned 7 from Front's line builds there, and the line is found again", () => {
    const TOP: SketchPlane = { kind: "default", name: "Top" };
    const front = planeRefs(planeFrame(TOP)).find((e) => e.source?.sketch === "@Front")!;
    const used = linkEdge(emptySketch(), front, true);
    const data = rectangleTo(used.sketch, used.curveId, 7);
    const sk = sketchFeature(TOP, data);
    const ex = extrudeFeature(sk.id, 5);
    const res = build([sk, ex]);
    expect(res.featureErrors).toEqual({});
    expect(res.sketchLinks![sk.id].links[used.curveId]).not.toBeNull();
    const [min, max] = boundsOf(res.parts, ex.id);
    expect(min[1]).toBe(7);
    expect(max[2]).toBe(5);
  });

  it("a sketch on Front tied to a Plane feature's line moves when the plane's offset changes", () => {
    const FRONT: SketchPlane = { kind: "default", name: "Front" };
    const plane = offsetPlane(10);
    const frame = { ...planeFrame({ kind: "default", name: "Top" }), origin: [0, 0, 10] as [number, number, number] };
    const line = planeRefs(planeFrame(FRONT), [{ id: plane.id, name: plane.name, frame }]).find((e) => e.source?.sketch === plane.id)!;
    const used = linkEdge(emptySketch(), line, true);
    expect((curveById(used.sketch, used.curveId) as SketchLine).link).toEqual({ sketch: plane.id, item: PLANE_ITEM });
    // The rectangle's bottom 0 from the plane's line (it sits on it).
    const data = rectangleTo(used.sketch, used.curveId, 0, 3, 12);
    const sk = sketchFeature(FRONT, data);
    const ex = extrudeFeature(sk.id, 5);
    const first = build([plane, sk, ex]);
    expect(first.featureErrors).toEqual({});
    expect(boundsOf(first.parts, ex.id)[0][2]).toBe(10);
    // The plane is moved up to 25: the line, and the rectangle with it, follow in the same build.
    const moved = build([{ ...plane, params: { ...plane.params, distance: "25" } }, sk, ex]);
    expect(moved.featureErrors).toEqual({});
    expect(boundsOf(moved.parts, ex.id)[0][2]).toBe(25);
    // Further down the list than the sketch, or deleted: lost, said plainly, and the sketch stays where it was.
    const later = build([sk, plane, ex]);
    expect(later.sketchLinks![sk.id].links[used.curveId]).toBeNull();
    expect(later.featureErrors[sk.id]).toMatch(/^A line this sketch takes from a plane can't be found any more/);
    const gone = build([sk, ex]);
    expect(gone.featureErrors[sk.id]).toMatch(/move that plane back above this one\.$/);
    expect(boundsOf(gone.parts, ex.id)[0][2]).toBe(10);
  });
});
