import { describe, expect, it } from "vitest";
import type { EdgeRef, TopoPick } from "../src/geometry/topoRef";
import { withoutGone } from "../src/model/dependents";
import { manipPatch, manipulatorsFor } from "../src/model/manipulators";
import type { FaceRef } from "../src/geometry/topoRef";
import { emptyDocument } from "../src/model/document";
import { defaultParams, visibleParamKeys } from "../src/model/features";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import type { Feature } from "../src/model/types";
import { applyVariables } from "../src/model/variables";
import {
  addRadiusPoint,
  clickRadiusPoint,
  edgeRadii,
  parseVariableFillet,
  pointsByEdge,
  radiusAt,
  runRadii,
  shareWords,
  tidyRadiusPoints,
} from "../src/model/variableFillet";

const edge = (partId: string, a: [number, number, number], b: [number, number, number], curve = "LINE"): TopoPick => ({
  partId,
  ref: { kind: "edge", curve, a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] },
});
const e1 = edge("box1", [0, 0, 10], [10, 0, 10]);
const e2 = edge("box1", [0, 10, 10], [10, 10, 10]);
const filletOf = (picks: TopoPick[], extra: Partial<Feature> = {}): Feature => ({
  id: "f2",
  name: "Fillet 1",
  type: "fillet",
  operation: "add",
  suppressed: false,
  params: { ...defaultParams("fillet"), radius: "2" },
  picks,
  ...extra,
});

describe("variable fillet (pure)", () => {
  it("reads its points from a file, dropping anything odd", () => {
    expect(parseVariableFillet(undefined)).toBeUndefined();
    const vf = parseVariableFillet({
      points: [
        { part: "box1", edge: [5, 0, 10], at: 0, radius: "1" },
        { part: "box1", edge: [5, 0, 10], at: 2, radius: "3 mm" },
        { part: "box1", edge: [5, 0], at: 0.5, radius: "1" },
        { part: 3, edge: [5, 0, 10], at: 0.5, radius: "1" },
        "nonsense",
      ],
      straight: true,
    });
    expect(vf).toEqual({ points: [{ part: "box1", edge: [5, 0, 10], at: 0, radius: "1" }, { part: "box1", edge: [5, 0, 10], at: 1, radius: "3 mm" }], straight: true });
  });

  it("leaves an old fillet's file byte for byte the same", () => {
    const doc = { ...emptyDocument(), features: [filletOf([e1])] };
    const at = new Date(0);
    const text = serializeDocument(doc, at);
    const read = readDocumentFile(text);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.doc.features[0].variableFillet).toBeUndefined();
      expect(serializeDocument(read.doc, at)).toBe(text);
    }
    // A variable one keeps its points.
    const points = [{ part: "box1", edge: [5, 0, 10] as [number, number, number], at: 0.25, radius: "wall" }];
    const vdoc = { ...emptyDocument(), features: [filletOf([e1], { variableFillet: { points, straight: true } })] };
    const vread = readDocumentFile(serializeDocument(vdoc, at));
    expect(vread.ok && vread.doc.features[0].variableFillet).toEqual({ points, straight: true });
  });

  it("puts a point where an edge it already rounds is clicked, snapping to the ends", () => {
    const f = filletOf([e1, e2], { variableFillet: { points: [] } });
    const near = clickRadiusPoint(f, { ...e1, at: [0.5, 0, 10] })!;
    expect(near.variableFillet!.points).toEqual([{ part: "box1", edge: [5, 0, 10], at: 0, radius: "2" }]);
    const along = clickRadiusPoint(near, { ...e1, at: [4.04, 0, 10] })!;
    expect(along.variableFillet!.points[1].at).toBe(0.4);
    expect(clickRadiusPoint(along, { ...e1, at: [9.9, 0, 10] })!.variableFillet!.points[2].at).toBe(1);
    // A point already there: nothing changes.
    expect(clickRadiusPoint(near, { ...e1, at: [0.2, 0, 10] })).toBe(near);
    // A new edge, a face, an ordinary fillet: the plain pick toggle.
    expect(clickRadiusPoint(f, { ...edge("box1", [0, 0, 0], [0, 0, 10]), at: [0, 0, 1] })).toBeNull();
    expect(clickRadiusPoint(filletOf([e1]), { ...e1, at: [0.5, 0, 10] })).toBeNull();
    // A curved edge: its ends, else its middle.
    const arc = edge("box1", [0, 0, 0], [10, 0, 0], "CIRCLE");
    const g = filletOf([arc], { variableFillet: { points: [] } });
    expect(clickRadiusPoint(g, { ...arc, at: [9, 0.5, 0] })!.variableFillet!.points[0].at).toBe(1);
    expect(clickRadiusPoint(g, { ...arc, at: [5, 6, 0] })!.variableFillet!.points[0].at).toBe(0.5);
  });

  it("drops points when their edge goes", () => {
    const f = addRadiusPoint(addRadiusPoint(filletOf([e1, e2], { variableFillet: { points: [] } }), e1, 0), e2, 1);
    expect(pointsByEdge(f).map((x) => [x.edge, x.point.at])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(tidyRadiusPoints(f)).toBe(f);
    const less = tidyRadiusPoints({ ...f, picks: [e2] });
    expect(less.variableFillet!.points.map((p) => p.edge)).toEqual([[5, 10, 10]]);
    // Delete with dependents: the part gone takes its picks and their points.
    const gone = withoutGone({ ...f, picks: [e1, edge("other", [0, 0, 0], [1, 0, 0])], variableFillet: { points: [...f.variableFillet!.points, { part: "other", edge: [0.5, 0, 0], at: 0, radius: "1" }] } }, new Set(["other"]));
    expect(gone.picks).toEqual([e1]);
    expect(gone.variableFillet!.points.map((p) => p.part)).toEqual(["box1"]);
  });

  it("renames variables used by its radii and hides the far-end box", () => {
    const f = filletOf([e1], { variableFillet: { points: [{ part: "box1", edge: [5, 0, 10], at: 0, radius: "big + 1" }] } });
    const doc = { ...emptyDocument(), variables: [{ id: "v1", name: "big", value: "3" }], features: [f] };
    const next = applyVariables(doc, [{ id: "v1", name: "huge", value: "3" }]);
    expect(next.features[0].variableFillet!.points[0].radius).toBe("huge + 1");
    expect(visibleParamKeys(filletOf([e1])).has("endRadius")).toBe(true);
    expect(visibleParamKeys(f).has("endRadius")).toBe(false);
  });

  it("works out the radii along a run", () => {
    expect(runRadii([{ u: 0.5, r: 3 }], 2, false)).toEqual([
      { u: 0, r: 2 },
      { u: 0.5, r: 3 },
      { u: 1, r: 2 },
    ]);
    expect(runRadii([{ u: 0.25, r: 3 }], 2, true)).toEqual([
      { u: 0, r: 2 },
      { u: 0.25, r: 3 },
      { u: 1, r: 2 },
    ]);
    // A closed run's ends are one place.
    expect(runRadii([{ u: 1, r: 4 }], 2, true)).toEqual([
      { u: 0, r: 4 },
      { u: 1, r: 4 },
    ]);
    expect(() => runRadii([{ u: 0, r: 1 }, { u: 1, r: 4 }], 2, true)).toThrow(/same place/);
    expect(() => runRadii([{ u: 0.5, r: 1 }, { u: 0.5, r: 4 }], 2, false)).toThrow(/same place/);
    expect(runRadii([{ u: 0.5, r: 1 }, { u: 0.5, r: 1 }], 2, false)).toHaveLength(3);
  });

  it("goes smoothly between points without overshooting, or in straight steps", () => {
    const radii = [
      { u: 0, r: 1 },
      { u: 0.5, r: 3 },
      { u: 0.6, r: 3 },
      { u: 1, r: 1 },
    ];
    for (let k = 0; k <= 100; k++) {
      const r = radiusAt(radii, k / 100, false);
      expect(r).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(r).toBeLessThanOrEqual(3 + 1e-9);
    }
    expect(radiusAt(radii, 0.55, false)).toBeCloseTo(3, 9);
    expect(radiusAt(radii, 0.25, true)).toBeCloseTo(2, 9);
    expect(radiusAt(radii, 0.25, false)).toBeGreaterThan(2);
    // Two radii only: a straight change, given as just its ends.
    expect(edgeRadii([{ u: 0, r: 1 }, { u: 1, r: 4 }], 0, 1, false)).toEqual([
      [0, 1],
      [1, 4],
    ]);
    // One edge of a longer run: its own ends, the points inside it and samples, all in its own shares.
    const part = edgeRadii(radii, 0.4, 0.8, true);
    expect(part[0]).toEqual([0, radiusAt(radii, 0.4, true)]);
    expect(part[part.length - 1][0]).toBe(1);
    expect(part.some(([x, r]) => Math.abs(x - 0.25) < 1e-9 && Math.abs(r - 3) < 1e-9)).toBe(true);
    expect(part.every(([x], i) => i === 0 || x > part[i - 1][0])).toBe(true);
  });

  it("says where a point is in plain words", () => {
    expect(shareWords(0)).toBe("start");
    expect(shareWords(1)).toBe("end");
    expect(shareWords(0.4)).toBe("40% along");
    expect((e1.ref as EdgeRef).mid).toEqual([5, 0, 10]);
  });

  it("shows a drag arrow at each radius point, which changes that point's radius", () => {
    const faces: FaceRef[] = [
      { kind: "face", surface: "PLANE", center: [5, 5, 10], normal: [0, 0, 1] },
      { kind: "face", surface: "PLANE", center: [5, 0, 5], normal: [0, -1, 0] },
    ];
    const f = filletOf([e1], { variableFillet: { points: [{ part: "box1", edge: [5, 0, 10], at: 1, radius: "3" }] } });
    const handles = manipulatorsFor(f, { sketch: null, parts: [{ id: "box1", faceRefs: faces }] });
    const point = handles.find((m) => m.key === "vf:0")!;
    expect(point.origin).toEqual([10, 0, 10]);
    expect(point.value).toBe(3);
    const patch = manipPatch(f, point, 4.5, false);
    expect(patch.fields?.variableFillet?.points[0].radius).toBe("4.5");
    expect(handles.some((m) => m.key === "radius")).toBe(true);
  });
});
