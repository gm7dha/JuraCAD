import { describe, expect, it } from "vitest";

import { describeRef, matchRefs, parsePick, refDistance, relativeTo, sameRef, type EdgeRef, type FaceRef, type Vec3 } from "../src/geometry/topoRef";

const line = (a: Vec3, b: Vec3): EdgeRef => ({
  kind: "edge",
  curve: "LINE",
  a,
  b,
  mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
});
const plane = (center: Vec3, normal: Vec3): FaceRef => ({ kind: "face", surface: "PLANE", center, normal });

/** The 12 edges of a box from the origin to (w, d, h): 4 along X, then 4 along Y, then 4 upright. */
function boxEdges(w: number, d: number, h: number): EdgeRef[] {
  const edges: EdgeRef[] = [];
  for (const y of [0, d]) for (const z of [0, h]) edges.push(line([0, y, z], [w, y, z]));
  for (const x of [0, w]) for (const z of [0, h]) edges.push(line([x, 0, z], [x, d, z]));
  for (const x of [0, w]) for (const y of [0, d]) edges.push(line([x, y, 0], [x, y, h]));
  return edges.map((e) => ({ ...e, rel: relativeTo(e.mid, [0, 0, 0], [w, d, h]) }));
}
const strip = ({ rel: _rel, ...e }: EdgeRef) => e;

describe("remembering picked edges and faces", () => {
  it("treats an edge as itself, whichever way round it was found", () => {
    const e = line([0, 0, 10], [10, 0, 10]);
    expect(sameRef(e, e)).toBe(true);
    expect(sameRef(e, line([10, 0, 10], [0, 0, 10]))).toBe(true);
    expect(sameRef(e, line([0, 10, 10], [10, 10, 10]))).toBe(false);
  });

  it("never matches different kinds or directions", () => {
    const e = line([0, 0, 0], [10, 0, 0]);
    expect(refDistance(e, line([0, 0, 0], [0, 10, 0]))).toBe(Infinity);
    expect(refDistance(e, { ...e, curve: "CIRCLE" })).toBe(Infinity);
    expect(refDistance(e, plane([5, 0, 0], [0, 0, 1]))).toBe(Infinity);
    expect(refDistance(plane([0, 0, 10], [0, 0, 1]), plane([0, 0, 10], [0, 0, -1]))).toBe(Infinity);
  });

  it("finds the same edges after the box is made wider and taller", () => {
    const before = boxEdges(10, 10, 10);
    const after = boxEdges(20, 10, 15);
    const wanted = [before[1], before[10]]; // top-front edge along X, and the upright edge at x=10, y=0
    const found = matchRefs(wanted, after, 30);
    expect(strip(after[found[0]!])).toEqual(line([0, 0, 15], [20, 0, 15]));
    expect(strip(after[found[1]!])).toEqual(line([20, 0, 0], [20, 0, 15]));
  });

  it("finds faces after the part changes size", () => {
    const top = plane([5, 5, 10], [0, 0, 1]);
    const candidates = [plane([10, 5, 0], [0, 0, -1]), plane([10, 5, 12], [0, 0, 1]), plane([10, 0, 6], [0, -1, 0])];
    expect(matchRefs([top], candidates, 25)).toEqual([1]);
  });

  it("uses each edge only once, and gives up on edges that have gone", () => {
    const e = line([0, 0, 10], [10, 0, 10]);
    expect(matchRefs([e, e], [e], 20)).toEqual([0, null]);
    expect(matchRefs([e], [line([0, 0, 40], [10, 0, 40])], 20)).toEqual([null]);
  });

  it("describes picks in plain words", () => {
    expect(describeRef(line([0, 0, 0], [1, 0, 0]))).toBe("Straight edge");
    expect(describeRef(plane([0, 0, 0], [0, 0, 1]))).toMatch(/Flat face/);
  });

  it("checks saved picks", () => {
    const ok = { partId: "f1", ref: line([0, 0, 0], [1, 0, 0]) };
    expect(parsePick(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    expect(parsePick({ partId: "f1", ref: { kind: "edge", curve: "LINE", a: [0, 0], b: [1, 0, 0], mid: [0, 0, 0] } })).toBeNull();
    expect(parsePick({ ref: ok.ref })).toBeNull();
    expect(parsePick(null)).toBeNull();
  });
});
