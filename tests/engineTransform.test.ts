/**
 * Engine tests: Move / copy's newer ways of moving (Onshape's Transform types,
 * and a triad put somewhere with "Move triad"), and that older designs are
 * built exactly as before. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument, parseDocument } from "../src/model/document";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, TransformDef } from "../src/model/types";
import { loadOpenCascade, feature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const move = (partId: string, t: Partial<TransformDef>, params: Record<string, number>): Feature => ({
  ...feature("transform", params, "add"),
  transform: { partId, axis: "z", about: "centre", copy: false, ...t },
});
const box = () => feature("box", { width: 10, depth: 20, height: 5 });
const boundsOf = (r: ReturnType<typeof build>, i = 0) => {
  const b = analyzeMesh(r.parts[i].vertices, r.parts[i].triangles).bounds!;
  const tidy = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000 + 0);
  return [tidy(b.min), tidy(b.max)];
};

describe("Move / copy: ways of moving", () => {
  it("builds older designs exactly as before, and tells the 3D view where the turns go about", () => {
    const b = box();
    const old = move(b.id, {}, { rz: 90, dx: 3 });
    const r = build([b, old]);
    expect(r.featureErrors).toEqual({});
    // 10 × 20 turned a quarter about its centre (5, 10), then 3 along X.
    expect(boundsOf(r)).toEqual([[-2, 5, 0], [18, 15, 5]]);
    expect(r.transformCentres?.[old.id]).toEqual([5, 10, 2.5]);
    // A file with none of the newer choices reads back with none (so it rebuilds the same).
    const doc = parseDocument({ ...emptyDocument(), features: [b, old] })!;
    expect(doc.features[1].transform).toEqual({ partId: b.id, axis: "z", about: "centre", copy: false });
    // The new ones are kept, and odd values are left out.
    const extra = { ...old, transform: { ...old.transform!, mode: "rotate", along: { dir: [0, 0, 1], through: [1, 2, 3] }, flip: true, triad: { origin: [0, 0, 0], x: [1, 0, 0], z: [1, 0, 0] }, line: { a: [0, 0], b: [1, 1, 1] } } };
    const read = parseDocument({ ...emptyDocument(), features: [b, extra] })!.features[1].transform!;
    expect(read).toEqual({ partId: b.id, axis: "z", about: "centre", copy: false, mode: "rotate", along: { dir: [0, 0, 1], through: [1, 2, 3] }, flip: true });
  });

  it("moves and turns along a triad put somewhere else", () => {
    const b = box();
    // The triad at the origin, turned a quarter: its X points along world Y.
    const triad = { origin: [0, 0, 0] as [number, number, number], x: [0, 1, 0] as [number, number, number], z: [0, 0, 1] as [number, number, number] };
    expect(boundsOf(build([b, move(b.id, { triad }, { dx: 10 })]))).toEqual([[0, 10, 0], [10, 30, 5]]);
    // Turned about its Z through the origin (not the part's centre).
    expect(boundsOf(build([b, move(b.id, { triad }, { rz: 90 })]))).toEqual([[-20, 0, 0], [0, 10, 5]]);
  });

  it("Translate by XYZ only moves; by distance goes along X/Y/Z or a clicked direction", () => {
    const b = box();
    expect(boundsOf(build([b, move(b.id, { mode: "xyz" }, { dx: 5, rz: 90 })]))).toEqual([[5, 0, 0], [15, 20, 5]]);
    expect(boundsOf(build([b, move(b.id, { mode: "distance", along: { axis: "z" } }, { distance: 7 })]))).toEqual([[0, 0, 7], [10, 20, 12]]);
    const slope = move(b.id, { mode: "distance", along: { dir: [3, 4, 0], through: [0, 0, 0] }, flip: true }, { distance: 10 });
    expect(boundsOf(build([b, slope]))).toEqual([[-6, -8, 0], [4, 12, 5]]);
  });

  it("Translate by line, Rotate, and Transform by mate connectors", () => {
    const b = box();
    expect(boundsOf(build([b, move(b.id, { mode: "line", line: { a: [0, 0, 0], b: [0, 0, 20] } }, {})]))).toEqual([[0, 0, 20], [10, 20, 25]]);
    const turn = move(b.id, { mode: "rotate", along: { dir: [0, 0, 1], through: [0, 0, 0] } }, { turn: 90 });
    expect(boundsOf(build([b, turn]))).toEqual([[-20, 0, 0], [0, 10, 5]]);
    // The top face's middle onto (100, 0, 0), turned over: the box stands on that point, upside down.
    const mates = move(b.id, { mode: "mates", from: { origin: [5, 10, 5], x: [1, 0, 0], z: [0, 0, 1] }, to: { origin: [100, 0, 0], x: [1, 0, 0], z: [0, 0, 1] }, flip: true }, {});
    expect(boundsOf(build([b, mates]))).toEqual([[95, -10, 0], [105, 10, 5]]);
  });

  it("copies with any way of moving, and says what's missing", () => {
    const b = box();
    const copy = move(b.id, { mode: "line", line: { a: [0, 0, 0], b: [30, 0, 0] }, copy: true }, {});
    const r = build([b, copy]);
    expect(r.parts).toHaveLength(2);
    expect(boundsOf(r, 1)).toEqual([[30, 0, 0], [40, 20, 5]]);
    const noLine = move(b.id, { mode: "line" }, {});
    expect(build([b, noLine]).featureErrors[noLine.id]).toMatch(/straight edge/);
    const still = move(b.id, { mode: "distance" }, { distance: 0 });
    expect(build([b, still]).featureErrors[still.id]).toMatch(/Nothing to do yet/);
  });
});
