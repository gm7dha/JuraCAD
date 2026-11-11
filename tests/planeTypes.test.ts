/**
 * Onshape's other Plane types and Part Studio mate connectors (pure maths):
 * frames from points, lines and faces; files with them read back; old files
 * read exactly as before; Delete with dependents knows what they use.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, parseDocument } from "../src/model/document";
import { deletePlan, findDependents, outsideLines } from "../src/model/dependents";
import { firstStudioId } from "../src/model/studios";
import { visibleParamKeys } from "../src/model/features";
import type { Feature, GeomPick, JuraCADDocument, PlaneOptions } from "../src/model/types";
import { planeFeatureFrame, refreshPlaneRefs, framesOf } from "../src/sketch/planeFeature";
import { connectorFrame, fitPlane, lineAngleReference, morePlaneFrame, rotateAbout } from "../src/sketch/planeTypes";
import type { Vec3 } from "../src/sketch/planes";
import { connectorFromClick, connectorWanted, fractionAlong, lineFromClick, nearEnd, planeClick, pointFromClick, type GeomClick } from "../src/model/geomClicks";

const r = (v: number[]) => v.map((n) => Math.round(n * 1e6) / 1e6 + 0);
const pt = (p: Vec3, extra: Partial<GeomPick> = {}): GeomPick => ({ p, ...extra });
const top = { kind: "default", name: "Top" } as const;
const def = (mode: PlaneOptions["mode"], extra: Partial<PlaneOptions>): PlaneOptions => ({ mode, ref: top, axis: "u", ...extra });
const frame = (d: PlaneOptions, values: { angle?: number; distance?: number } = {}) => {
  const f = planeFeatureFrame(d, values);
  if (typeof f === "string") throw new Error(f);
  return f;
};

function plane(id: string, planeDef: PlaneOptions, params: Record<string, string> = {}): Feature {
  return { id, name: id, type: "plane", operation: "new", suppressed: false, params, planeDef };
}

describe("Onshape's other plane types", () => {
  it("Plane point: through a point, parallel to the plane chosen", () => {
    const f = frame(def("point", { ref: { kind: "default", name: "Front" }, points: [pt([3, 7, 9])] }));
    expect(r(f.origin)).toEqual([3, 7, 9]);
    expect(r(f.n)).toEqual([0, -1, 0]);
    expect(planeFeatureFrame(def("point", {}), {})).toMatch(/Click a point/);
    // Flipped: facing the other way.
    expect(r(frame(def("point", { points: [pt([0, 0, 2])], flip: true })).n)).toEqual([0, 0, -1]);
  });

  it("Point normal: through a point, square to a line", () => {
    const f = frame(def("pointNormal", { points: [pt([1, 2, 3])], line: pt([0, 0, 0], { dir: [0, 0, 5] }) }));
    expect(r(f.origin)).toEqual([1, 2, 3]);
    expect(r(f.n)).toEqual([0, 0, 1]);
    // Its own directions are square to each other and to the normal.
    expect(Math.abs(f.u[0] * f.n[0] + f.u[1] * f.n[1] + f.u[2] * f.n[2])).toBeLessThan(1e-12);
    expect(planeFeatureFrame(def("pointNormal", { points: [pt([1, 2, 3])] }), {})).toMatch(/square to/);
  });

  it("Line angle: holds the line, turned from the upright plane through it", () => {
    const line = pt([0, 0, 0], { dir: [1, 0, 0] });
    // Along X: the upright plane holding it is the XZ plane (normal ±Y).
    expect(r(lineAngleReference([1, 0, 0]).map(Math.abs))).toEqual([0, 1, 0]);
    const flat = frame(def("lineAngle", { line }), { angle: 0 });
    expect(r(flat.u)).toEqual([1, 0, 0]);
    expect(Math.abs(flat.n[1])).toBeCloseTo(1, 12);
    const turned = frame(def("lineAngle", { line }), { angle: 90 });
    expect(Math.abs(turned.n[2])).toBeCloseTo(1, 12);
    // The line stays in the plane at every angle.
    for (const a of [15, 45, 130]) {
      const f = frame(def("lineAngle", { line: pt([0, 5, 0], { dir: [1, 0, 0] }) }), { angle: a });
      expect(Math.abs(f.n[0])).toBeLessThan(1e-12);
      expect(r(f.origin)).toEqual([0, 5, 0]);
    }
    // An upright line turns from the plane that holds X too.
    expect(r(lineAngleReference([0, 0, 1]).map(Math.abs))).toEqual([0, 1, 0]);
    expect(planeFeatureFrame(def("lineAngle", {}), {})).toMatch(/straight edge/);
  });

  it("Three point: through three points, or says why not", () => {
    const f = frame(def("threePoint", { points: [pt([0, 0, 1]), pt([4, 0, 1]), pt([0, 3, 1])] }));
    expect(r(f.origin)).toEqual([0, 0, 1]);
    expect(r(f.n)).toEqual([0, 0, 1]);
    expect(r(f.u)).toEqual([1, 0, 0]);
    expect(planeFeatureFrame(def("threePoint", { points: [pt([0, 0, 0]), pt([1, 1, 1]), pt([2, 2, 2])] }), {})).toMatch(/in a line/);
    expect(planeFeatureFrame(def("threePoint", { points: [pt([0, 0, 0])] }), {})).toMatch(/three points/);
  });

  it("Curve point: square to the edge at the point on it", () => {
    const f = frame(def("curvePoint", { points: [pt([2, 0, 0])], line: pt([2, 0, 0], { dir: [0, 1, 1] }) }));
    expect(r(f.n)).toEqual(r([0, Math.SQRT1_2, Math.SQRT1_2]));
    expect(r(f.origin)).toEqual([2, 0, 0]);
  });

  it("Fit: the best plane through points", () => {
    // Points on z = 0.5 x + 2, with a little up-and-down that cancels out.
    const pts: Vec3[] = [
      [0, 0, 2.1],
      [10, 0, 6.9],
      [0, 10, 1.9],
      [10, 10, 7.1],
    ];
    const fit = fitPlane(pts)!;
    const n = fit.n;
    const want = [-0.5, 0, 1].map((x) => x / Math.hypot(0.5, 1));
    // A least-squares fit of points nearly on the plane gives nearly its normal.
    expect(Math.abs(n[0] * want[0] + n[1] * want[1] + n[2] * want[2])).toBeGreaterThan(0.999);
    expect(r(fit.origin)).toEqual([5, 5, 4.5]);
    // Exactly on a plane: exactly that plane.
    const exact = fitPlane([[0, 0, 3], [1, 0, 3], [0, 1, 3], [5, 7, 3], [2, 9, 3]])!;
    expect(r(exact.n)).toEqual([0, 0, 1]);
    expect(fitPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])).toBeNull();
    expect(typeof morePlaneFrame({ mode: "fit", ref: top, axis: "u", points: pts.map((p) => pt(p)) }, {})).toBe("object");
  });

  it("shows only the boxes each type uses", () => {
    const keys = (mode: PlaneOptions["mode"]) => [...visibleParamKeys({ type: "plane", planeDef: def(mode, {}) } as Feature)].sort();
    expect(keys("offset")).toEqual(["distance"]);
    expect(keys("angle")).toEqual(["angle", "distance"]);
    expect(keys("lineAngle")).toEqual(["angle"]);
    expect(keys("threePoint")).toEqual([]);
  });

  it("is saved and read back; older planes read exactly as before", () => {
    const old = plane("p1", def("offset", {}), { distance: "20", angle: "30" });
    const read = parseDocument({ ...emptyDocument(), features: [old] })!;
    expect(read.features[0].planeDef).toEqual({ mode: "offset", ref: top, axis: "u" });
    const edge = { partId: "b", ref: { kind: "edge" as const, curve: "LINE", a: [0, 0, 0] as Vec3, b: [1, 0, 0] as Vec3, mid: [0.5, 0, 0] as Vec3 } };
    const newer = plane(
      "p2",
      def("threePoint", { points: [pt([0, 0, 0], { pick: edge, end: "a" }), pt([1, 0, 0], { sketchPoint: { sketch: "s", point: "q1" } }), pt([0, 1, 0], { connector: "mc" }), { p: [1, 2] } as unknown as GeomPick], flip: true, position: 3 }),
    );
    const back = parseDocument({ ...emptyDocument(), features: [newer] })!.features[0].planeDef!;
    expect(back.mode).toBe("threePoint");
    expect(back.points).toHaveLength(3);
    expect(back.points![0]).toEqual({ p: [0, 0, 0], pick: edge, end: "a" });
    expect(back.flip).toBe(true);
    expect(back.position).toBe(1);
    // An unknown type reads as Distance.
    expect(parseDocument({ ...emptyDocument(), features: [plane("p3", { ...def("offset", {}), mode: "tangent" as never })] })!.features[0].planeDef!.mode).toBe("offset");
  });
});

describe("Part Studio mate connectors", () => {
  const base = { origin: [1, 2, 3] as Vec3, x: [1, 0, 0] as Vec3, z: [0, 0, 1] as Vec3 };
  it("sits where it was found, then moves along and turns about its own axes", () => {
    const f = connectorFrame({ base }, { dx: 2, dz: 1 });
    expect(r(f.origin)).toEqual([3, 2, 4]);
    expect(r(f.y)).toEqual([0, 1, 0]);
    // Turned a quarter about its Z: X goes to Y.
    const t = connectorFrame({ base }, { rz: 90 });
    expect(r(t.x)).toEqual([0, 1, 0]);
    // Turned over: Z down, Y the other way, X as it was.
    const flipped = connectorFrame({ base, flipZ: true }, {});
    expect(r(flipped.z)).toEqual([0, 0, -1]);
    expect(r(flipped.y)).toEqual([0, -1, 0]);
    expect(r(rotateAbout([1, 0, 0], [0, 0, 1], 90))).toEqual([0, 1, 0]);
  });

  it("can be sketched on: its XY plane, and sketches on it follow it", () => {
    const mc: Feature = { id: "mc", name: "Mate connector 1", type: "mateConnector", operation: "new", suppressed: false, params: { dz: "5" }, connector: { at: { p: [0, 0, 0] }, plane: top, base } };
    const at = framesOf([mc]).get("mc")!;
    expect(r(at.origin)).toEqual([1, 2, 8]);
    const sketch: Feature = { id: "s", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "face", origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], label: "Mate connector 1", planeRef: "mc" }, data: { points: [], curves: [], constraints: [] } as never } };
    const moved = refreshPlaneRefs([mc, sketch]);
    const p = moved[1].sketch!.plane!;
    expect(p.kind === "face" && r(p.origin)).toEqual([1, 2, 8]);
  });

  it("is saved and read back", () => {
    const mc: Feature = {
      id: "mc",
      name: "Mate connector 1",
      type: "mateConnector",
      operation: "new",
      suppressed: false,
      params: { dx: "0", dy: "0", dz: "0", rx: "0", ry: "0", rz: "0" },
      connector: { at: { p: [5, 5, 5], pick: { partId: "b", ref: { kind: "face", surface: "PLANE", center: [5, 5, 5], normal: [0, 0, 1] } }, spot: "clicked", point: [1, 1, 5] }, owner: "b", flipZ: true, base },
    };
    const back = parseDocument({ ...emptyDocument(), features: [mc] })!.features[0];
    expect(back.connector).toEqual(mc.connector);
  });

  it("Delete with dependents: a plane or move using a connector, a sketch point or a part goes with it", () => {
    const box: Feature = { id: "b", name: "Box 1", type: "box", operation: "new", suppressed: false, params: {} };
    const mc: Feature = { id: "mc", name: "MC", type: "mateConnector", operation: "new", suppressed: false, params: {}, connector: { at: { p: [0, 0, 0], pick: { partId: "b", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } } }, base } };
    const sk: Feature = { id: "s", name: "Sketch", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: top, data: { points: [], curves: [], constraints: [] } as never } };
    const pl = plane("p", def("threePoint", { points: [pt([0, 0, 0], { connector: "mc" }), pt([1, 0, 0], { sketchPoint: { sketch: "s", point: "q" } }), pt([0, 1, 0])] }));
    const mv: Feature = { id: "m", name: "Move", type: "transform", operation: "add", suppressed: false, params: {}, transform: { partId: "x", axis: "z", about: "centre", copy: false, mode: "mates", toConnector: "mc" } };
    const list = [box, mc, sk, pl, mv];
    expect(findDependents(list, ["b"]).going.sort()).toEqual(["b", "m", "mc", "p"].sort());
    expect(findDependents(list, ["s"]).going.sort()).toEqual(["p", "s"]);
  });
});

describe("clicks for planes and mate connectors", () => {
  const edgeRef = { kind: "edge" as const, curve: "LINE", a: [0, 0, 0] as Vec3, b: [12, 0, 0] as Vec3, mid: [6, 0, 0] as Vec3 };
  const onEdge = (at: Vec3): GeomClick => ({ kind: "part", pick: { partId: "b", ref: edgeRef }, at, points: [[0, 0, 0], [12, 0, 0]] });
  const topFace: GeomClick = { kind: "part", pick: { partId: "b", ref: { kind: "face", surface: "PLANE", center: [6, 5, 3], normal: [0, 0, 1] } }, at: [2, 2, 3] };

  it("a click near an edge's end is its corner, else its middle; a flat face its centre", () => {
    expect(nearEnd(edgeRef, [1, 0, 0])).toBe("a");
    expect(nearEnd(edgeRef, [11.5, 0, 0])).toBe("b");
    expect(nearEnd(edgeRef, [5, 0, 0])).toBeNull();
    expect(pointFromClick(onEdge([11, 0, 0]))).toMatchObject({ p: [12, 0, 0], end: "b" });
    expect(pointFromClick(onEdge([5, 0, 0]))).toMatchObject({ p: [6, 0, 0], end: "mid" });
    expect(pointFromClick(topFace)).toMatchObject({ p: [6, 5, 3] });
    expect(lineFromClick(onEdge([5, 0, 0]))).toMatchObject({ p: [0, 0, 0], dir: [12, 0, 0] });
    expect(lineFromClick(topFace)).toMatchObject({ dir: [0, 0, 1] });
    expect(fractionAlong([[0, 0, 0], [10, 0, 0], [10, 10, 0]], [10, 5, 0])).toBe(0.75);
  });

  it("Point normal takes a corner as the point and an edge or face as the line; three point toggles points", () => {
    let d: PlaneOptions | string = def("pointNormal", {});
    d = planeClick(d as PlaneOptions, onEdge([11.8, 0, 0]));
    expect(typeof d !== "string" && d.points?.[0].p).toEqual([12, 0, 0]);
    d = planeClick(d as PlaneOptions, topFace);
    expect(typeof d !== "string" && d.line?.dir).toEqual([0, 0, 1]);
    expect(r((frame(d as PlaneOptions)).origin)).toEqual([12, 0, 0]);
    let t: PlaneOptions | string = def("threePoint", {});
    for (const at of [[0.5, 0, 0], [11.5, 0, 0]] as Vec3[]) t = planeClick(t as PlaneOptions, onEdge(at));
    t = planeClick(t as PlaneOptions, topFace);
    expect((t as PlaneOptions).points).toHaveLength(3);
    expect(planeClick(t as PlaneOptions, onEdge([6, 0, 0]))).toMatch(/already has three/);
    // Clicking a chosen point again takes it out.
    expect((planeClick(t as PlaneOptions, topFace) as PlaneOptions).points).toHaveLength(2);
    // Curve point: where along the edge it was clicked.
    const c = planeClick(def("curvePoint", {}), onEdge([3, 0, 0])) as PlaneOptions;
    expect(c.position).toBe(0.25);
  });

  it("a mate connector goes on a face's centre, an edge's end or a plane", () => {
    const f = connectorFromClick(topFace);
    expect(typeof f !== "string" && f.base.origin).toEqual([6, 5, 3]);
    const e = connectorFromClick(onEdge([11.9, 0, 0]));
    expect(typeof e !== "string" && e.at.spot).toBe("end");
    const p = connectorFromClick({ kind: "plane", plane: { kind: "default", name: "Front" }, frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] } });
    expect(typeof p !== "string" && p.plane).toEqual({ kind: "default", name: "Front" });
  });
});

describe("when a click can pick a mate connector", () => {
  const draft = (type: Feature["type"], extra: Partial<Feature> = {}) => ({ editing: { draft: { id: "d", name: "d", type, operation: "new", suppressed: false, params: {}, ...extra } as Feature }, sketch: null, mateDraft: null });
  it("only while the tool open takes one", () => {
    expect(connectorWanted({ editing: null, sketch: null, mateDraft: null }, false)).toBe(true);
    for (const t of ["mateConnector", "plane", "mirror", "text"] as const) expect(connectorWanted(draft(t), false)).toBe(true);
    for (const t of ["fillet", "extrude", "chamfer", "hole"] as const) expect(connectorWanted(draft(t), false)).toBe(false);
    expect(connectorWanted(draft("transform", { transform: { axis: "z", about: "centre", copy: false, mode: "mates", picking: "to" } }), false)).toBe(true);
    expect(connectorWanted(draft("transform", { transform: { axis: "z", about: "centre", copy: false, mode: "mates" } }), false)).toBe(false);
    // A sketch: only while it waits for its plane.
    expect(connectorWanted({ ...draft("sketch", { sketch: { plane: null, data: { points: [], curves: [], constraints: [] } as never } }), sketch: {} }, false)).toBe(true);
    expect(connectorWanted({ ...draft("sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: { points: [], curves: [], constraints: [] } as never } }), sketch: {} }, false)).toBe(false);
    // An assembly: while a mate is being made.
    expect(connectorWanted({ editing: null, sketch: null, mateDraft: null }, true)).toBe(false);
    expect(connectorWanted({ editing: null, sketch: null, mateDraft: {} }, true)).toBe(true);
  });
});

describe("deleting a mate connector used in an assembly", () => {
  it("the Delete question names the mates that use it", () => {
    const mc: Feature = { id: "mc", name: "Peg spot", type: "mateConnector", operation: "new", suppressed: false, params: {}, connector: { at: { p: [0, 0, 0] }, base: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } } };
    const end = { instanceId: "i1", pick: { partId: "b", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } } };
    const doc = {
      ...emptyDocument(),
      features: [mc],
      assemblies: [{ id: "a1", name: "Kit", instances: [], mates: [{ id: "m1", name: "Fasten 1", type: "fastened", a: { ...end, connector: "mc" }, b: end, flip: false, values: {} }] }],
    } as unknown as JuraCADDocument;
    const plan = deletePlan(doc, firstStudioId(doc), ["mc"]);
    expect(outsideLines(plan.outside).join(" ")).toMatch(/In Kit, Fasten 1 uses a mate connector that will go/);
    expect(outsideLines(deletePlan({ ...doc, assemblies: [] }, firstStudioId(doc), ["mc"]).outside)).toEqual([]);
  });
});
