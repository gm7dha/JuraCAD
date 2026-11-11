/**
 * Thin walls (Onshape's "Thin" on Extrude, Revolve and Sweep) and Revolve's two directions, with the real
 * OpenCascade engine: volumes, soundness, operations and ends.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { addCircle, addLine, addRectangle } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, relativeError, rectSketch, lineSketch, meshOf } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const top = { kind: "default", name: "Top" } as const;
const front = { kind: "default", name: "Front" } as const;
const right = { kind: "default", name: "Right" } as const;

/** A thin extrude of a sketch. */
function thinExtrude(sketchId: string, depth: number, thickness: number, extra: Partial<Feature> = {}, thickness2 = 0): Feature {
  const f = extrudeFeature(sketchId, depth, { operation: extra.operation });
  return { ...f, apart: true, intersectAll: true, thin: {}, ...extra, params: { ...f.params, thickness: String(thickness), thickness2: String(thickness2), ...(extra.params ?? {}) } };
}

/** Lines end to end (separate points at the same place join, as in the app's regions). */
function polyline(points: [number, number][]): SketchData {
  let s = emptySketch();
  for (let i = 1; i < points.length; i++) s = addLine(s, { x: points[i - 1][0], y: points[i - 1][1] }, { x: points[i][0], y: points[i][1] }).sketch;
  return s;
}

describe("thin extrude", () => {
  it("makes a wall from a single line (one side, centred, two sides)", () => {
    const sk = sketchFeature(top, lineSketch(0, 0, 40, 0));
    const one = build([sk, thinExtrude(sk.id, 10, 2)]);
    expect(one.featureErrors).toEqual({});
    const m = meshOf(one);
    expect(m.watertight).toBe(true);
    expect(m.volume).toBeCloseTo(800, 3);
    expect(m.bounds?.min[1]).toBeCloseTo(0, 6);
    expect(m.bounds?.max[1]).toBeCloseTo(2, 6);
    const mid = meshOf(build([sk, thinExtrude(sk.id, 10, 2, { thin: { midPlane: true } })]));
    expect(mid.bounds?.min[1]).toBeCloseTo(-1, 6);
    expect(mid.volume).toBeCloseTo(800, 3);
    const two = meshOf(build([sk, thinExtrude(sk.id, 10, 2, {}, 3)]));
    expect(two.volume).toBeCloseTo(40 * 5 * 10, 3);
    expect(two.bounds?.min[1]).toBeCloseTo(-3, 6);
    const flipped = meshOf(build([sk, thinExtrude(sk.id, 10, 2, { thin: { flip: true } })]));
    expect(flipped.bounds?.max[1]).toBeCloseTo(0, 6);
  });

  it("follows an L-shaped chain with a sharp corner", () => {
    const sk = sketchFeature(top, polyline([[0, 0], [40, 0], [40, 30]]));
    const r = build([sk, thinExtrude(sk.id, 10, 2, { thin: { midPlane: true } })]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const m = meshOf(r);
    expect(m.watertight).toBe(true);
    // A centred wall with a sharp (mitred) corner: centre-line length × thickness × depth.
    expect(m.volume).toBeCloseTo(70 * 2 * 10, 3);
    // Flat faces only: 6 sides + top + bottom.
    expect(r.parts[0].faceRefs).toHaveLength(8);
  });

  it("makes a closed rectangle into a tube (walls inside the outline)", () => {
    const sk = sketchFeature(top, rectSketch(0, 0, 40, 20));
    const r = build([sk, thinExtrude(sk.id, 10, 2)]);
    expect(r.featureErrors).toEqual({});
    const m = meshOf(r);
    expect(m.watertight).toBe(true);
    expect(m.volume).toBeCloseTo((800 - 36 * 16) * 10, 3);
    expect(r.parts[0].faceRefs).toHaveLength(10);
    expect(m.bounds?.max[0]).toBeCloseTo(40, 6);
    // A round tube from a circle.
    const ring = sketchFeature(top, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const t = meshOf(build([ring, thinExtrude(ring.id, 10, 2, { thin: { midPlane: true } })]));
    expect(relativeError(t.volume, Math.PI * (121 - 81) * 10)).toBeLessThan(0.01);
  });

  it("works with Remove (through all, every part it reaches) and Add, and symmetric depths", () => {
    const block = feature("box", { width: 50, depth: 50, height: 10 });
    const sk = sketchFeature(top, lineSketch(5, 25, 45, 25));
    const cut = thinExtrude(sk.id, 1, 2, { operation: "remove", thin: { midPlane: true }, extrude: { end: "throughAll", flip: false } });
    const r = build([block, sk, cut]);
    expect(r.featureErrors).toEqual({});
    expect(meshOf(r).volume).toBeCloseTo(25000 - 40 * 2 * 10, 2);
    // Add, symmetric 30 deep about the Top plane (z −15…15): joined into the block, adding what's outside it.
    const add = thinExtrude(sk.id, 30, 2, { operation: "add", thin: { midPlane: true }, extrude: { end: "symmetric", flip: false } });
    const a = build([block, sk, add]);
    expect(a.featureErrors).toEqual({});
    expect(a.parts).toHaveLength(1);
    expect(meshOf(a).volume).toBeCloseTo(25000 + 40 * 2 * 20, 2);
  });

  it("goes up to a face", () => {
    const block = { ...feature("box", { width: 50, depth: 50, height: 10, z: 20 }) };
    const pre = build([block]);
    const bottom = pre.parts[0].faceRefs.find((f) => f.normal && f.normal[2] < -0.9)!;
    const sk = sketchFeature(top, lineSketch(5, 25, 45, 25));
    const up = thinExtrude(sk.id, 1, 2, { operation: "add", thin: { midPlane: true }, extrude: { end: "upToFace", flip: false, upTo: { partId: pre.parts[0].id, ref: bottom } } });
    const r = build([block, sk, up]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(meshOf(r).volume).toBeCloseTo(25000 + 40 * 2 * 20, 2);
  });

  it("says plainly when the wall can't be made", () => {
    const sk = sketchFeature(top, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 4 }).sketch);
    const f = thinExtrude(sk.id, 10, 3);
    expect(build([sk, f]).featureErrors[f.id]).toMatch(/too thick/);
  });
});

describe("thin revolve and sweep", () => {
  it("revolves a line into a tube (the axis line left out)", () => {
    let d = emptySketch();
    const axis = addLine(d, { x: 0, y: -5 }, { x: 0, y: 30 }, { construction: true });
    d = axis.sketch;
    d = addLine(d, { x: 10, y: 0 }, { x: 10, y: 20 }).sketch;
    const sk = sketchFeature(front, d);
    const rev: Feature = { ...feature("revolve", { angle: 360, thickness: 2 }), sketchRef: sk.id, revolve: { axis: axis.lineId, flip: false }, apart: true, thin: {} };
    const r = build([sk, rev]);
    expect(r.featureErrors).toEqual({});
    const m = meshOf(r);
    expect(m.watertight).toBe(true);
    // Walked upwards, the first side is towards the axis: r 8 to 10.
    expect(relativeError(m.volume, Math.PI * (100 - 64) * 20)).toBeLessThan(0.01);
    expect(m.bounds?.max[0]).toBeCloseTo(10, 2);
  });

  it("sweeps a circle's wall along a path into a pipe", () => {
    const path = sketchFeature(top, lineSketch(0, 0, 40, 0));
    const profile = sketchFeature(right, addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    const sweep: Feature = { ...feature("sweep", { thickness: 1 }), sketchRef: profile.id, pathRef: path.id, apart: true, thin: {} };
    const r = build([path, profile, sweep]);
    expect(r.featureErrors).toEqual({});
    const m = meshOf(r);
    expect(m.watertight).toBe(true);
    expect(relativeError(m.volume, Math.PI * (9 - 4) * 40)).toBeLessThan(0.02);
  });
});

describe("revolve in two directions", () => {
  it("spins one angle each way from the sketch", () => {
    const sk = sketchFeature(front, rectSketch(10, 0, 10, 10));
    const rev: Feature = { ...feature("revolve", { angle: 90, angle2: 45 }), sketchRef: sk.id, revolve: { axis: "vertical", flip: false, second: true } };
    const r = build([sk, rev]);
    expect(r.featureErrors).toEqual({});
    const m = meshOf(r);
    expect(relativeError(m.volume, (135 / 360) * Math.PI * (400 - 100) * 10)).toBeLessThan(0.01);
    const ys = [Math.abs(m.bounds!.min[1]), Math.abs(m.bounds!.max[1])].sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(20 * Math.SQRT1_2, 1);
    expect(ys[1]).toBeCloseTo(20, 1);
    // Past a full turn: refused in plain words.
    const over = build([sk, { ...rev, params: { ...rev.params, angle: "300", angle2: "100" } }]);
    expect(over.featureErrors[rev.id]).toMatch(/more than a full turn/);
    // Without "second", the second angle is ignored (old files build as before).
    const plain = meshOf(build([sk, { ...rev, revolve: { axis: "vertical", flip: false } }]));
    expect(relativeError(plain.volume, (90 / 360) * Math.PI * 300 * 10)).toBeLessThan(0.01);
  });
});
