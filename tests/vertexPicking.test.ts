/**
 * Corners (vertices) of parts, picked as in Onshape: finding them from a mesh, matching them again after a change,
 * what a click on one gives the newer planes / mate connectors / Move triad, when they can be picked, Select other's
 * list, Delete with dependents, copying features, and files that keep reading the same.
 */
import { describe, expect, it } from "vitest";
import { cornersFromEnds, matchVertex, meshCorners, nearestOnScreen, parseVertexPick, vertexDistance, type VertexRef } from "../src/geometry/vertexRef";
import { connectorFromClick, cornerWanted, lineFromClick, planeClick, pointFromClick } from "../src/model/geomClicks";
import { orderChoices, choiceLabel, type OtherHit } from "../src/viewport/selectOther";
import { allows, partHitAs } from "../src/viewport/selectionFilter";
import { findDependents } from "../src/model/dependents";
import { copyFeatures, pasteFeatures } from "../src/model/featureClipboard";
import { parseFeatures } from "../src/model/document";
import { spotFrame, directionOf } from "../src/model/transformPicks";
import type { Feature } from "../src/model/types";
import type { Vec3 } from "../src/geometry/topoRef";

/** A box's corners from its 12 edges (as the 3D view's mesh gives them), w × d × h from the origin. */
function boxMesh(w: number, d: number, h: number) {
  const P = (x: number, y: number, z: number): Vec3 => [x * w, y * d, z * h];
  const edges: [Vec3, Vec3][] = [];
  for (const [a, b] of [
    [[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]],
    [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
    [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]],
  ] as [number[], number[]][])
    edges.push([P(a[0], a[1], a[2]), P(b[0], b[1], b[2])]);
  const lines: number[] = [];
  const edgeGroups = edges.map(([a, b]) => {
    const start = lines.length / 3;
    lines.push(...a, ...b);
    return { start, count: 2 };
  });
  return {
    edgeRefs: edges.map(([a, b]) => ({ curve: "LINE", a, b })),
    edgeGroups,
    lines,
    vertices: [0, 0, 0, w, d, h],
  };
}

const at = (cs: VertexRef[], p: Vec3) => cs.findIndex((c) => Math.hypot(c.p[0] - p[0], c.p[1] - p[1], c.p[2] - p[2]) < 1e-6);

describe("corners from a mesh", () => {
  it("a box has 8 corners, each with its three edge directions and its place in the box", () => {
    const cs = meshCorners(boxMesh(10, 20, 5));
    expect(cs.length).toBe(8);
    const top = cs[at(cs, [10, 20, 5])];
    expect(top.rel).toEqual([1, 1, 1]);
    expect(top.dirs?.length).toBe(3);
    for (const d of top.dirs!) expect(Math.min(...d)).toBe(-1);
  });

  it("closed edges (a whole circle) have no corner; ends at the same place are one corner", () => {
    const cs = cornersFromEnds([{ p: [0, 0, 0], dir: [1, 0, 0] }, { p: [0, 0, 0.0001], dir: [0, 1, 0] }, { p: [5, 0, 0], dir: null }], [0, 0, 0], [5, 5, 5]);
    expect(cs.length).toBe(2);
    expect(cs[0].dirs?.length).toBe(2);
    const circle = meshCorners({ edgeRefs: [{ curve: "CIRCLE", a: [5, 0, 0], b: [5, 0, 0] }], edgeGroups: [{ start: 0, count: 2 }], lines: [5, 0, 0, 0, 5, 0], vertices: [] });
    expect(circle).toEqual([]);
  });
});

describe("finding a corner again", () => {
  it("a box's corner is followed when the box grows (by its place in the box)", () => {
    const was = meshCorners(boxMesh(10, 20, 5));
    const now = meshCorners(boxMesh(30, 20, 5));
    const want = was[at(was, [10, 20, 5])];
    const size = Math.hypot(30, 20, 5);
    expect(matchVertex(want, now, size)).toBe(at(now, [30, 20, 5]));
    // Unchanged: the very same corner.
    expect(matchVertex(want, was, Math.hypot(10, 20, 5))).toBe(at(was, [10, 20, 5]));
  });

  it("a corner whose edges leave it other ways isn't the same corner; far or unclear ones are lost", () => {
    const want: VertexRef = { kind: "vertex", p: [0, 0, 0], dirs: [[1, 0, 0], [0, 1, 0]] };
    expect(vertexDistance(want, { kind: "vertex", p: [0, 0, 0], dirs: [[-1, 0, 0], [0, 1, 0]] })).toBe(Infinity);
    expect(matchVertex(want, [{ kind: "vertex", p: [9, 0, 0], dirs: [[1, 0, 0], [0, 1, 0]] }], 20)).toBeNull();
    const two: VertexRef[] = [
      { kind: "vertex", p: [1, 0, 0], dirs: [[1, 0, 0], [0, 1, 0]] },
      { kind: "vertex", p: [-1, 0, 0], dirs: [[1, 0, 0], [0, 1, 0]] },
    ];
    expect(matchVertex(want, two, 30)).toBeNull();
  });

  it("reads picks from files carefully", () => {
    expect(parseVertexPick({ partId: "f1", ref: { kind: "vertex", p: [1, 2, 3], rel: [1, 0, 0.5], dirs: [[1, 0, 0], "x"] } })).toEqual({ partId: "f1", ref: { kind: "vertex", p: [1, 2, 3], rel: [1, 0, 0.5], dirs: [[1, 0, 0]] } });
    expect(parseVertexPick({ partId: "f1", ref: { kind: "edge", p: [1, 2, 3] } })).toBeNull();
    expect(parseVertexPick({ partId: 3, ref: { kind: "vertex", p: [1, 2, 3] } })).toBeNull();
  });

  it("the nearest point on screen within reach", () => {
    expect(nearestOnScreen([0, 0, 10, 10, 12, 11], 11, 10, 3)).toBe(1);
    expect(nearestOnScreen([0, 0, 10, 10], 50, 50, 3)).toBe(-1);
    expect(nearestOnScreen([NaN, 0, 10, 10], 0, 0, 3)).toBe(-1);
  });
});

const pick = { partId: "b1", ref: { kind: "vertex" as const, p: [10, 20, 5] as Vec3, rel: [1, 1, 1] as Vec3 } };

describe("clicks on a corner", () => {
  it("is a point for planes and mate connectors, never a line", () => {
    expect(pointFromClick({ kind: "corner", pick })).toEqual({ p: [10, 20, 5], vertex: pick });
    expect(typeof lineFromClick({ kind: "corner", pick })).toBe("string");
    const c = connectorFromClick({ kind: "corner", pick });
    expect(typeof c !== "string" && c.at).toEqual({ p: [10, 20, 5], vertex: pick });
    // Three point: clicking the same corner again takes it out.
    const one = planeClick({ mode: "threePoint", ref: { kind: "default", name: "Top" }, axis: "u" }, { kind: "corner", pick });
    expect(typeof one !== "string" && one.points?.length).toBe(1);
    const none = typeof one !== "string" ? planeClick(one, { kind: "corner", pick }) : one;
    expect(typeof none !== "string" && none.points?.length).toBe(0);
    // Point normal: a corner is always its point.
    const pn = planeClick({ mode: "pointNormal", ref: { kind: "default", name: "Top" }, axis: "u" }, { kind: "corner", pick });
    expect(typeof pn !== "string" && pn.points?.[0].vertex).toEqual(pick);
  });

  it("puts Move's triad on the corner, but gives no direction", () => {
    const f = spotFrame({ kind: "corner", p: [1, 2, 3] });
    expect(typeof f !== "string" && f.origin).toEqual([1, 2, 3]);
    expect(typeof directionOf({ kind: "corner", p: [1, 2, 3] })).toBe("string");
  });

  it("corners can be picked only with nothing open, or while what's open takes a point", () => {
    const draft = (f: Partial<Feature>) => ({ editing: { draft: { id: "d", name: "d", type: "fillet", operation: "new", suppressed: false, params: {}, ...f } as Feature }, sketch: null });
    expect(cornerWanted({ editing: null, sketch: null }, false)).toBe(true);
    expect(cornerWanted({ editing: null, sketch: null }, true)).toBe(false);
    expect(cornerWanted({ editing: null, sketch: {} }, false)).toBe(false);
    expect(cornerWanted(draft({}), false)).toBe(false);
    expect(cornerWanted(draft({ type: "extrude", extrude: { end: "upToVertex", flip: false } }), false)).toBe(true);
    expect(cornerWanted(draft({ type: "extrude", extrude: { end: "upToFace", flip: false } }), false)).toBe(false);
    expect(cornerWanted(draft({ type: "plane", planeDef: { mode: "threePoint", ref: { kind: "default", name: "Top" }, axis: "u" } }), false)).toBe(true);
    expect(cornerWanted(draft({ type: "plane", planeDef: { mode: "lineAngle", ref: { kind: "default", name: "Top" }, axis: "u" } }), false)).toBe(false);
    expect(cornerWanted(draft({ type: "mateConnector" }), false)).toBe(true);
    expect(cornerWanted(draft({ type: "transform", transform: { partId: "p", copy: false, picking: "triad" } as Feature["transform"] }), false)).toBe(true);
    expect(cornerWanted(draft({ type: "transform", transform: { partId: "p", copy: false } as Feature["transform"] }), false)).toBe(false);
  });
});

describe("Select other and the selection filter", () => {
  it("lists corners first, as 'Corner of …'", () => {
    const hits: OtherHit[] = [
      { kind: "face", partId: "p", index: 0, distance: 1, point: [0, 0, 0], local: [0, 0, 0] },
      { kind: "edge", partId: "p", index: 2, distance: 1, point: [0, 0, 0], local: [0, 0, 0] },
      { kind: "vertex", partId: "p", index: 4, distance: 1.5, point: [0, 0, 0], local: [0, 0, 0] },
    ];
    const list = orderChoices(hits, []);
    expect(list.map((c) => c.kind)).toEqual(["vertex", "edge", "face", "part"]);
    expect(choiceLabel(list[0], { part: () => "Part 1", feature: () => "" })).toBe("Corner of Part 1");
    // Filtered to corners: only the corner.
    expect(orderChoices(hits, ["vertex"]).map((c) => c.kind)).toEqual(["vertex"]);
    expect(allows(["vertex"], "vertex")).toBe(true);
    expect(allows(["face"], "vertex")).toBe(false);
    expect(partHitAs(["part"], "vertex")).toBe("whole");
  });
});

const box: Feature = { id: "b1", name: "Box 1", type: "box", operation: "new", suppressed: false, params: { width: "10", depth: "20", height: "5" } };
const sketch: Feature = { id: "sk", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: { points: [], curves: [], constraints: [] } } };
const upTo: Feature = { id: "ex", name: "Extrude 1", type: "extrude", operation: "new", suppressed: false, params: { depth: "5" }, sketchRef: "sk", extrude: { end: "upToVertex", flip: false, upToCorner: pick } };
const plane: Feature = { id: "pl", name: "Plane 1", type: "plane", operation: "new", suppressed: false, params: {}, planeDef: { mode: "point", ref: { kind: "default", name: "Top" }, axis: "u", points: [{ p: [10, 20, 5], vertex: pick }] } };

describe("features using corners", () => {
  it("Delete with dependents knows the corner's part", () => {
    const d = findDependents([box, sketch, upTo, plane], ["b1"]);
    expect(d.dependents).toEqual(["ex", "pl"]);
  });

  it("copying features keeps their corners on the copied part", () => {
    const copied = copyFeatures([box, sketch, upTo], ["b1", "sk", "ex"])!;
    let n = 0;
    const r = pasteFeatures([], copied.clip, { allIds: ["b1", "sk", "ex"], makeId: (p) => `${p}${++n}` });
    const newBox = r.pasted.find((f) => f.type === "box")!;
    const ex = r.pasted.find((f) => f.type === "extrude")!;
    expect(ex.extrude?.upToCorner?.partId).toBe(newBox.id);
  });

  it("files keep corners, and old ones read the same", () => {
    const back = parseFeatures(JSON.parse(JSON.stringify([box, sketch, upTo, plane])), new Set())!;
    expect(back[2].extrude?.upToCorner).toEqual(pick);
    expect(back[3].planeDef?.points?.[0].vertex).toEqual(pick);
    // An older up-to-vertex extrude (an edge's end) reads exactly as it was, with no corner.
    const old = { ...upTo, extrude: { end: "upToVertex", flip: false, upTo: { partId: "b1", ref: { kind: "edge", curve: "LINE", a: [0, 20, 5], b: [10, 20, 5], mid: [5, 20, 5] } }, upToEnd: "b" } };
    const read = parseFeatures(JSON.parse(JSON.stringify([box, sketch, old])), new Set())!;
    expect(JSON.stringify(read[2].extrude)).toBe(JSON.stringify(old.extrude));
  });
});
