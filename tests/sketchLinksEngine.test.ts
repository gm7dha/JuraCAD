/**
 * Sketches on a part's face with the real OpenCascade engine: the face's
 * edges come into the sketch, and sketches using them follow the part when
 * it changes.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeMesh } from "../src/geometry/meshCheck";
import type { TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType, Operation } from "../src/model/types";
import { lostLinksMessage, linkEdge } from "../src/sketch/links";
import { addCircle, addLine, curveById, pointPos } from "../src/sketch/ops";
import { planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { snapAt } from "../src/sketch/snaps";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function feature(id: string, type: FeatureType, params: Record<string, number>, operation: Operation = "new"): Feature {
  return { id, name: id, type, operation, suppressed: false, params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) } };
}
const sketchFeature = (id: string, plane: SketchPlane, data: SketchData): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const extrudeFeature = (id: string, sketchRef: string, depth: number): Feature => ({
  ...feature(id, "extrude", { depth }, "new"),
  sketchRef,
  extrude: { end: "blind", flip: false },
});

/** A box w × d × h at the origin with a 6 mm hole through it at (10, 10). */
const boxWithHole = (w: number, d: number, h: number, holeX = 10) => [feature("box", "box", { width: w, depth: d, height: h, x: 0, y: 0, z: 0 }), feature("hole", "cylinder", { diameter: 6, height: h, x: holeX, y: 10, z: 0 }, "remove")];

const topFace = (h: number): TopoPick => ({ partId: "box", ref: { kind: "face", surface: "PLANE", center: [20, 10, h], normal: [0, 0, 1] } });

function rebuild(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("sketch on a part's face", () => {
  it("brings in the face's outline and the hole's edge", () => {
    const plane = planeOnFace([0, 0, 1], [0, 0, 10], "Face of Part 1", topFace(10));
    const r = rebuild([...boxWithHole(40, 20, 10), sketchFeature("sk", plane, emptySketch())]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].id).toBe("box");
    const info = r.sketchLinks?.sk;
    expect(info?.faceLost).toBeUndefined();
    const lines = info!.edges.filter((e) => e.kind === "line");
    const circles = info!.edges.filter((e) => e.kind === "circle" || e.kind === "arc");
    expect(lines).toHaveLength(4);
    const corners = lines.flatMap((e) => [e.a, e.b]).map(([x, y]) => `${Math.round(x * 1e4) / 1e4},${Math.round(y * 1e4) / 1e4}`);
    expect([...new Set(corners)].sort()).toEqual(["0,0", "0,20", "40,0", "40,20"]);
    expect(circles.length).toBeGreaterThan(0);
    for (const c of circles) {
      expect(c.centre![0]).toBeCloseTo(10, 6);
      expect(c.centre![1]).toBeCloseTo(10, 6);
      expect(c.radius).toBeCloseTo(3, 6);
    }
    // Nothing used yet, so the sketch is left as it was.
    expect(info?.sketch).toBeUndefined();
  });

  it("a sketch built on its edges follows the part when the box changes size", () => {
    const plane = planeOnFace([0, 0, 1], [0, 0, 10], "Face of Part 1", topFace(10));
    const first = rebuild([...boxWithHole(40, 20, 10), sketchFeature("sk", plane, emptySketch())]);
    const refs = first.sketchLinks!.sk.edges;
    // A line from the face's top-right corner to the middle of its left edge, and a circle on the hole's centre.
    const from = snapAt(emptySketch(), 40.1, 19.9, { pointTol: 1, curveTol: 0.5, refs }).placed;
    const to = snapAt(emptySketch(), 0.2, 10.1, { pointTol: 1, curveTol: 0.5, refs }).placed;
    expect(to.snap).toMatchObject({ kind: "ref", at: "mid" });
    const l = addLine(emptySketch(), from, to);
    const centre = snapAt(l.sketch, 10.1, 9.9, { pointTol: 1, curveTol: 0.5, refs }).placed;
    expect(centre.snap).toMatchObject({ kind: "ref", at: "centre" });
    const c = addCircle(l.sketch, centre, 1.5);
    const data = c.sketch;
    const line = curveById(data, l.lineId) as SketchLine;
    const circle = curveById(data, c.circleId);
    const circleCentre = circle?.type === "circle" ? circle.center : "";

    // The box is made wider (60) and taller (15), and the hole moves to x = 20.
    const r = rebuild([...boxWithHole(60, 20, 15, 20), sketchFeature("sk", plane, data), extrudeFeature("ex", "sk", 5)]);
    expect(r.featureErrors).toEqual({});
    const info = r.sketchLinks!.sk;
    expect(Object.values(info.links).every((e) => e !== null)).toBe(true);
    expect(lostLinksMessage(data, info)).toBeNull();
    // The sketch moved up with the face…
    expect(info.plane?.kind === "face" ? info.plane.origin[2] : NaN).toBeCloseTo(15, 6);
    // …and what's on its edges went with them.
    const now = info.sketch!.data;
    const [ax, ay] = pointPos(now, line.p1);
    const [bx, by] = pointPos(now, line.p2);
    expect([ax, ay].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([60, 20]);
    expect([bx, by].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 10]);
    const [cx, cy] = pointPos(now, circleCentre);
    expect(cx).toBeCloseTo(20, 6);
    expect(cy).toBeCloseTo(10, 6);
    // The extrude uses the sketch as it is now: a 3 mm circle on the new top face, 5 tall, at (20, 10).
    const pin = r.parts.find((p) => p.id !== "box");
    expect(pin).toBeDefined();
    const a = analyzeMesh(pin!.vertices, pin!.triangles);
    expect(a.volume).toBeCloseTo(Math.PI * 1.5 * 1.5 * 5, 0);
    expect(a.bounds!.min[2]).toBeCloseTo(15, 4);
    expect((a.bounds!.min[0] + a.bounds!.max[0]) / 2).toBeCloseTo(20, 1);
  });

  it("Use from the part follows its edge too, and says so kindly when the edge has gone", () => {
    const plane = planeOnFace([0, 0, 1], [0, 0, 10], "Face of Part 1", topFace(10));
    const first = rebuild([...boxWithHole(40, 20, 10), sketchFeature("sk", plane, emptySketch())]);
    const hole = first.sketchLinks!.sk.edges.find((e) => e.kind === "circle" || e.kind === "arc")!;
    const used = linkEdge(emptySketch(), hole, false);
    expect(used.error).toBeUndefined();
    // The hole is filled in (its feature turned off): the copy stays where it was.
    const [box, cyl] = boxWithHole(40, 20, 10);
    const r = rebuild([box, { ...cyl, suppressed: true }, sketchFeature("sk", plane, used.sketch)]);
    expect(r.featureErrors).toEqual({});
    const info = r.sketchLinks!.sk;
    expect(info.links[used.curveId]).toBeNull();
    expect(info.sketch).toBeUndefined();
    expect(lostLinksMessage(used.sketch, info)).toMatch(/1 edge this sketch uses has gone from the part/);
  });

  it("an old sketch on a face (no face remembered) builds just as before", () => {
    const old = { kind: "face" as const, origin: [0, 0, 10] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Top face" };
    const r = rebuild([...boxWithHole(40, 20, 10), sketchFeature("sk", old, addCircle(emptySketch(), { x: 30, y: 10 }, 2).sketch), extrudeFeature("ex", "sk", 4)]);
    expect(r.featureErrors).toEqual({});
    expect(r.sketchLinks?.sk).toBeUndefined();
    const pin = r.parts.find((p) => p.id !== "box")!;
    expect(analyzeMesh(pin.vertices, pin.triangles).bounds!.min[2]).toBeCloseTo(10, 4);
  });
});
