/**
 * Planes and the origin as sketch references (Onshape's): where Top, Front, Right and Plane features cross a sketch,
 * and the origin seen in it — offered, snapped onto, brought in and dimensioned to, and found again.
 */
import { describe, expect, it } from "vitest";

import { bringIn, snapAt } from "../src/sketch/snaps";
import { linkEdge, linkProblem, lostLinksMessage, parseRefId, pruneReferences, refSketch } from "../src/sketch/links";
import { addLine, addPoint, curveById, pointPos } from "../src/sketch/ops";
import { isPlaneRef, ORIGIN_REF, PLANE_ITEM, PLANE_LINE_HALF, planeCrossing, planeRefs, seePlaneLink } from "../src/sketch/planeRefs";
import { sketchPlaneRefs } from "../src/sketch/planeRefsFor";
import { planeFrame, type PlaneFrame } from "../src/sketch/planes";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchLine } from "../src/sketch/types";
import type { Feature } from "../src/model/types";

const TOP = planeFrame({ kind: "default", name: "Top" });
const FRONT = planeFrame({ kind: "default", name: "Front" });
const r6 = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);
const tol = { pointTol: 1, curveTol: 0.5 };

describe("where planes cross a sketch", () => {
  it("a sketch on Top gets Front's line along X and Right's along Y, and nothing from Top itself", () => {
    const refs = planeRefs(TOP);
    expect(refs.map((r) => r.source?.sketch)).toEqual(["@Front", "@Right"]);
    const [front, right] = refs;
    expect(front.kind).toBe("line");
    expect(r6(front.a)).toEqual([-PLANE_LINE_HALF, 0]);
    expect(r6(front.b)).toEqual([PLANE_LINE_HALF, 0]);
    expect(r6(right.a)).toEqual([0, -PLANE_LINE_HALF]);
    expect(r6(right.b)).toEqual([0, PLANE_LINE_HALF]);
    // The origin is the sketch's own origin here, so it isn't offered again.
    expect(refs.some((r) => r.kind === "point")).toBe(false);
    expect(refs.every(isPlaneRef)).toBe(true);
  });

  it("a plane lying flat to the sketch gives nothing; a slanted one gives its line", () => {
    const raised: PlaneFrame = { ...TOP, origin: [0, 0, 10] };
    expect(planeCrossing(TOP, raised)).toBeNull();
    // A plane through (0, 0, 0) at 45° about X: it crosses Top along X.
    const s = Math.SQRT1_2;
    const slanted: PlaneFrame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, s, s], n: [0, -s, s] };
    const l = planeCrossing(TOP, slanted)!;
    expect(r6(l.mid)).toEqual([0, 0]);
    expect(r6(l.b)).toEqual([PLANE_LINE_HALF, 0]);
  });

  it("an offset Plane feature's line moves with it; on Front, Top shows as the X axis", () => {
    const up10: PlaneFrame = { ...TOP, origin: [0, 0, 10] };
    const refs = planeRefs(FRONT, [{ id: "pl", name: "Plane 1", frame: up10 }]);
    const pl = refs.find((r) => r.source?.sketch === "pl")!;
    expect(r6(pl.a)).toEqual([-PLANE_LINE_HALF, 10]);
    expect(pl.source?.name).toBe("Plane 1");
    const top = refs.find((r) => r.source?.sketch === "@Top")!;
    expect(r6(top.mid)).toEqual([0, 0]);
    // Found again where the plane is now; gone or later = lost.
    const up20: PlaneFrame = { ...TOP, origin: [0, 0, 20] };
    expect(r6(seePlaneLink(FRONT, { sketch: "pl", item: PLANE_ITEM }, new Map([["pl", up20]]))!.a)).toEqual([-PLANE_LINE_HALF, 20]);
    expect(seePlaneLink(FRONT, { sketch: "pl", item: PLANE_ITEM }, new Map())).toBeNull();
    expect(seePlaneLink(FRONT, { sketch: "@Front", item: PLANE_ITEM }, new Map())).toBeNull();
  });

  it("on a face away from the origin, the origin is offered as a point", () => {
    // Straight across from the origin it's the sketch's own origin: not offered again.
    const face: PlaneFrame = { origin: [5, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] };
    expect(planeRefs(face).some((r) => r.kind === "point")).toBe(false);
    const off: PlaneFrame = { ...face, origin: [5, 3, 4] };
    const o = planeRefs(off).find((r) => r.kind === "point")!;
    expect(o.source).toMatchObject({ sketch: ORIGIN_REF, item: ORIGIN_REF });
    expect(r6(o.a)).toEqual([-3, -4]);
    expect(r6(seePlaneLink(off, { sketch: ORIGIN_REF, item: ORIGIN_REF }, new Map())!.a)).toEqual([-3, -4]);
  });

  it("a plane line has no ends or middle to snap to, only the line", () => {
    const refs = planeRefs(TOP);
    const virt = refSketch(refs);
    expect(virt.points.every((p) => parseRefId(p.id)?.what === "q")).toBe(true);
    // Near the line's far end: no snap to an end, but onto the line.
    const near = snapAt(emptySketch(), PLANE_LINE_HALF - 0.2, 0.3, { ...tol, refs }).placed;
    expect(near.snap).toMatchObject({ kind: "ref", at: "on" });
    // At its middle (away from the origin, which is the sketch's own): onto it, never a "middle".
    const mid = snapAt(emptySketch(), 40, 0.2, { ...tol, refs }).placed;
    expect(mid.snap).toMatchObject({ kind: "ref", at: "on" });
    expect(mid.y).toBeCloseTo(0, 9);
  });
});

describe("using them in a sketch", () => {
  it("drawing onto Front's line ties the point to it (Coincident), and the line follows a moved plane", () => {
    // A sketch on Right: Top's line is the horizontal axis there, an offset plane's line 10 above it.
    const RIGHT = planeFrame({ kind: "default", name: "Right" });
    const up10: PlaneFrame = { ...TOP, origin: [0, 0, 10] };
    const refs = planeRefs(RIGHT, [{ id: "pl", name: "Plane 1", frame: up10 }]);
    const at = snapAt(emptySketch(), 30, 10.3, { ...tol, refs }).placed;
    expect(at.snap).toMatchObject({ kind: "ref", at: "on" });
    const l = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at);
    const line = curveById(l.sketch, l.lineId) as SketchLine;
    const brought = l.sketch.curves.find((c) => c.type === "line" && "link" in c && c.link)! as SketchLine;
    expect(brought.construction).toBe(true);
    expect(brought.link).toEqual({ sketch: "pl", item: PLANE_ITEM });
    expect(l.sketch.constraints.some((k) => k.type === "pointOnLine" && k.refs[0] === line.p2 && k.refs[1] === brought.id)).toBe(true);
    expect(pointPos(l.sketch, line.p2)[1]).toBeCloseTo(10, 6);
    // Kept when the sketch closes (it's used).
    expect(pruneReferences(l.sketch).curves.some((c) => c.id === brought.id)).toBe(true);
  });

  it("dimensioning a point to Front's line brings it in; the distance holds", () => {
    const refs = planeRefs(TOP);
    const p = addPoint(emptySketch(), { x: 12, y: 7, snap: null });
    const idx = refs.findIndex((r) => r.source?.sketch === "@Front");
    const b = bringIn(p.sketch, `ref:${idx}`, refs);
    expect(b.error).toBeUndefined();
    const lineId = b.id;
    const dims = { ...b.sketch, constraints: [...b.sketch.constraints, { id: "d1", type: "pointLineDistance" as const, refs: [p.pointId, lineId], value: "20" }] };
    const solved = solveSketch(dims);
    expect(solved.ok).toBe(true);
    expect(Math.abs(pointPos(solved.sketch, p.pointId)[1])).toBeCloseTo(20, 6);
  });

  it("the same plane brought in twice is one line", () => {
    const refs = planeRefs(TOP);
    const a = linkEdge(emptySketch(), refs[0], true);
    const b = linkEdge(a.sketch, refs[0], true);
    expect(b.curveId).toBe(a.curveId);
  });

  it("a lost plane line is said plainly", () => {
    const refs = planeRefs(FRONT, [{ id: "pl", name: "Plane 1", frame: { ...TOP, origin: [0, 0, 10] } }]);
    const used = linkEdge(emptySketch(), refs.find((r) => r.source?.sketch === "pl")!, true);
    const info = { edges: [], links: { [used.curveId]: null } };
    expect(lostLinksMessage(used.sketch, info)).toMatch(/^A line this sketch takes from a plane can't be found any more/);
    expect(linkProblem(info, used.sketch)).toMatch(/move that plane back above this one\.$/);
  });

  it("a later Plane feature is offered but says why it can't be used", () => {
    const plane = (id: string, distance: number): Feature => ({
      id,
      name: id,
      type: "plane",
      operation: "new",
      suppressed: false,
      params: { distance: String(distance) },
      planeDef: { mode: "offset", axis: "u", ref: { kind: "default", name: "Top" } },
    } as unknown as Feature);
    const sk = { id: "sk", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Front" }, data: emptySketch() } } as unknown as Feature;
    const refs = sketchPlaneRefs({ kind: "default", name: "Front" }, [plane("p1", 5), sk, plane("p2", 9)], "sk");
    const p1 = refs.find((r) => r.source?.sketch === "p1")!;
    const p2 = refs.find((r) => r.source?.sketch === "p2")!;
    expect(r6(p1.mid)).toEqual([0, 5]);
    expect(p1.source?.later).toBeUndefined();
    expect(p2.source?.later).toBe(true);
    expect(linkEdge(emptySketch(), p2, true).error).toMatch(/comes after this sketch/);
  });
});
