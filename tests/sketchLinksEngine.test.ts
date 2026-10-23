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
import { addCircle, addLine, curveById, pointPos, type Placed } from "../src/sketch/ops";
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

    // The box is made wider (60) and taller (15), and the hole moves to x = 14.
    const r = rebuild([...boxWithHole(60, 20, 15, 14), sketchFeature("sk", plane, data), extrudeFeature("ex", "sk", 5)]);
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
    expect(cx).toBeCloseTo(14, 6);
    expect(cy).toBeCloseTo(10, 6);
    // The extrude uses the sketch as it is now: a 3 mm circle on the new top face, 5 tall, at (14, 10).
    const pin = r.parts.find((p) => p.id !== "box");
    expect(pin).toBeDefined();
    const a = analyzeMesh(pin!.vertices, pin!.triangles);
    expect(a.volume).toBeCloseTo(Math.PI * 1.5 * 1.5 * 5, 0);
    expect(a.bounds!.min[2]).toBeCloseTo(15, 4);
    expect((a.bounds!.min[0] + a.bounds!.max[0]) / 2).toBeCloseTo(14, 1);
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
    // Said on the sketch in the feature list too, with what to do.
    expect(r.featureErrors.sk).toMatch(/A part edge this sketch uses can't be found any more, so its copy stays where it was\. Edit the sketch and delete it/);
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

/** A closed outline through these corners (sketch mm), as joined lines. */
function outlineSketch(corners: [number, number][]): SketchData {
  let s = emptySketch();
  let first: string | null = null;
  let prev: Placed | null = null;
  corners.forEach(([x, y], i) => {
    if (!prev) {
      prev = { x, y };
      return;
    }
    const r = addLine(s, prev, { x, y });
    s = r.sketch;
    const line = curveById(s, r.lineId) as SketchLine;
    if (i === 1) first = line.p1;
    prev = { x, y, snap: { kind: "point", id: line.p2 } };
  });
  const [x0, y0] = corners[0];
  return addLine(s, prev!, { x: x0, y: y0, snap: { kind: "point", id: first! } }).sketch;
}

/** A 40 long, 20 deep block whose top rises from `left` to `right` (mm), drawn on the Front plane. */
function block(left: number, right: number): Feature[] {
  const sk = sketchFeature("profile", { kind: "default", name: "Front" }, outlineSketch([[0, 0], [40, 0], [40, right], [0, left]]));
  return [sk, extrudeFeature("block", "profile", 20)];
}

describe("following a face: sloping faces and faces that go", () => {
  const topOf = (r: ReturnType<typeof rebuild>, steep: (nz: number) => boolean) => {
    const part = r.parts.find((p) => p.id === "block")!;
    const ref = part.faceRefs.find((f) => f.surface === "PLANE" && steep(f.normal[2]))!;
    return { pick: { partId: "block", ref } as TopoPick, plane: planeOnFace(ref.normal, ref.center, "Face of Part 1", { partId: "block", ref }) };
  };

  it("a sketch on a sloping face settles: rebuilding with the plane it was given asks for no further move", () => {
    const rise = 40 * Math.tan((17 * Math.PI) / 180);
    const first = rebuild(block(10, 10 + rise));
    const { plane } = topOf(first, (nz) => nz > 0.9 && nz < 0.99);
    const r1 = rebuild([...block(10, 10 + rise), sketchFeature("sk", plane, emptySketch())]);
    expect(r1.featureErrors).toEqual({});
    expect(r1.sketchLinks!.sk.edges.length).toBe(4);
    expect(r1.sketchLinks!.sk.plane).toBeUndefined();
    // The block is raised by 5: the sketch follows once, and then stays put.
    const r2 = rebuild([...block(15, 15 + rise), sketchFeature("sk", plane, emptySketch())]);
    const moved = r2.sketchLinks!.sk.plane!;
    expect(moved).toBeDefined();
    const r3 = rebuild([...block(15, 15 + rise), sketchFeature("sk", moved, emptySketch())]);
    expect(r3.sketchLinks!.sk.plane).toBeUndefined();
    expect(r3.sketchLinks!.sk.sketch).toBeUndefined();
  });

  it("a level face that becomes a slope is reported on the sketch, not followed", () => {
    const first = rebuild(block(10, 10));
    const { plane } = topOf(first, (nz) => nz > 0.999);
    const r = rebuild([...block(10, 30), sketchFeature("sk", plane, emptySketch())]);
    expect(r.sketchLinks!.sk.faceLost).toBe(true);
    expect(r.featureErrors.sk).toMatch(/The face this sketch was on can't be found any more.*Pick the face again/);
  });

  it("doesn't jump onto another face when its own has gone (a boss turned off)", () => {
    const box = feature("box", "box", { width: 40, depth: 20, height: 10, x: 0, y: 0, z: 0 });
    const boss = feature("boss", "box", { width: 10, depth: 10, height: 5, x: 5, y: 5, z: 10 }, "add");
    const bossTop: TopoPick = { partId: "box", ref: { kind: "face", surface: "PLANE", center: [10, 10, 15], normal: [0, 0, 1] } };
    const plane = planeOnFace([0, 0, 1], [10, 10, 15], "Face of Part 1", bossTop);
    const on = rebuild([box, boss, sketchFeature("sk", plane, emptySketch())]);
    expect(on.sketchLinks!.sk.faceLost).toBeUndefined();
    expect(on.sketchLinks!.sk.edges).toHaveLength(4);
    const off = rebuild([box, { ...boss, suppressed: true }, sketchFeature("sk", plane, emptySketch())]);
    expect(off.sketchLinks!.sk.faceLost).toBe(true);
    expect(off.sketchLinks!.sk.plane).toBeUndefined();
  });
});
