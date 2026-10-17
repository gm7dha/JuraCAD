/**
 * Part Studio modelling options and fixes, checked with the real OpenCascade
 * engine: exact volumes and positions wherever they can be worked out by hand.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TopoPick } from "../src/geometry/topoRef";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType, Operation } from "../src/model/types";
import { addRectangle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let n = 0;
function feature(type: FeatureType, params: Record<string, string | number>, operation: Operation = "new"): Feature {
  n++;
  return {
    id: `m${n}`,
    name: `${type} ${n}`,
    type,
    operation,
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}
function sketchFeature(plane: SketchPlane, data: SketchData): Feature {
  n++;
  return { id: `m${n}`, name: `Sketch ${n}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } };
}
const rect = (x0: number, y0: number, w: number, h: number) => addRectangle(emptySketch(), { x: x0, y: y0 }, { x: x0 + w, y: y0 + h }).sketch;

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volumes = () => engine.check("normal").parts.map((p) => p.exactVolume!);
const boundsOf = (r: ReturnType<typeof build>, i = 0) => analyzeMesh(r.parts[i].vertices, r.parts[i].triangles).bounds!;
/** The edge or face of a part whose middle is nearest `at`. */
function pickAt(r: ReturnType<typeof build>, kind: "edge" | "face", at: [number, number, number], i = 0): TopoPick {
  const part = r.parts[i];
  const refs = kind === "edge" ? part.edgeRefs : part.faceRefs;
  const pos = (x: (typeof refs)[number]) => (x.kind === "edge" ? x.mid : x.center);
  const best = [...refs].sort((p, q) => Math.hypot(...pos(p).map((v, k) => v - at[k])) - Math.hypot(...pos(q).map((v, k) => v - at[k])))[0];
  return { partId: part.id, ref: best };
}
/** Volume of a frustum of height h between areas a and b (similar shapes). */
const frustum = (h: number, a: number, b: number) => (h / 3) * (a + b + Math.sqrt(a * b));

describe("extrude both ways", () => {
  const top = () => sketchFeature({ kind: "default", name: "Top" }, rect(0, 0, 10, 10));
  const extrude = (sketchRef: string, params: Record<string, number>, extrude: Feature["extrude"]): Feature => ({ ...feature("extrude", params), sketchRef, extrude });

  it("tapers both halves of a symmetric extrude away from the sketch (it used to widen one side)", () => {
    const sk = top();
    const r = build([sk, extrude(sk.id, { depth: 10, draft: 5 }, { end: "symmetric", flip: false })]);
    expect(r.featureErrors).toEqual({});
    // Two 5 mm frustums, each from 10 × 10 at the sketch to (10 − 2 × 5 tan 5°)² at its end.
    const side = 10 - 2 * 5 * Math.tan((5 * Math.PI) / 180);
    expect(volumes()[0]).toBeCloseTo(2 * frustum(5, 100, side * side), 2);
    const b = boundsOf(r);
    expect(b.min[2]).toBeCloseTo(-5, 3);
    expect(b.max[2]).toBeCloseTo(5, 3);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });

  it("extrudes a second depth the other way", () => {
    const sk = top();
    const r = build([sk, extrude(sk.id, { depth: 10, depth2: 4 }, { end: "blind", flip: false, second: true })]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(1400, 3);
    expect(boundsOf(r).min[2]).toBeCloseTo(-4, 3);
    expect(boundsOf(r).max[2]).toBeCloseTo(10, 3);
    // Flipped: the first depth goes down.
    const flipped = build([sk, extrude(sk.id, { depth: 10, depth2: 4 }, { end: "blind", flip: true, second: true })]);
    expect(boundsOf(flipped).min[2]).toBeCloseTo(-10, 3);
    expect(boundsOf(flipped).max[2]).toBeCloseTo(4, 3);
    // With a taper, each way narrows away from the sketch.
    build([sk, extrude(sk.id, { depth: 10, depth2: 4, draft: 3 }, { end: "blind", flip: false, second: true })]);
    const t = Math.tan((3 * Math.PI) / 180);
    expect(volumes()[0]).toBeCloseTo(frustum(10, 100, (10 - 20 * t) ** 2) + frustum(4, 100, (10 - 8 * t) ** 2), 2);
    // Without the tick, the second depth is ignored.
    build([sk, extrude(sk.id, { depth: 10, depth2: 4 }, { end: "blind", flip: false })]);
    expect(volumes()[0]).toBeCloseTo(1000, 3);
  });
});

describe("revolve both ways", () => {
  it("spins half the angle each way from the sketch", () => {
    // On Front (y = 0), a 10 × 10 rectangle from x = 10 to 20, spun a quarter turn about Z.
    const sk = sketchFeature({ kind: "default", name: "Front" }, rect(10, 0, 10, 10));
    const rev = (symmetric: boolean): Feature => ({ ...feature("revolve", { angle: 90 }), sketchRef: sk.id, revolve: { axis: "vertical", flip: false, ...(symmetric ? { symmetric: true } : {}) } });
    const one = build([sk, rev(false)]);
    expect(volumes()[0]).toBeCloseTo((Math.PI * 300 * 10) / 4, 2);
    const ob = boundsOf(one);
    // One way: all on one side of the sketch plane.
    expect(Math.min(Math.abs(ob.min[1]), Math.abs(ob.max[1]))).toBeLessThan(1e-3);
    const both = build([sk, rev(true)]);
    expect(both.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo((Math.PI * 300 * 10) / 4, 2);
    const b = boundsOf(both);
    // 45° each way: out to 20 sin 45° on both sides of the sketch plane.
    expect(b.min[1]).toBeCloseTo(-20 * Math.SQRT1_2, 1);
    expect(b.max[1]).toBeCloseTo(20 * Math.SQRT1_2, 1);
  });
});

describe("chamfer types", () => {
  const box = feature("box", { width: 10, depth: 10, height: 10 });
  const chamfer = (picks: TopoPick[], params: Record<string, number>, chamferType?: Feature["chamferType"], flip = false): Feature => ({
    ...feature("chamfer", params, "add"),
    picks,
    ...(chamferType ? { chamferType } : {}),
    ...(flip ? { flipSide: true } : {}),
  });
  /** How high the front face (y = 0) reaches once the top front edge is bevelled. */
  const frontTop = (r: ReturnType<typeof build>) => {
    const front = r.parts[0].faceRefs.find((f) => f.surface === "PLANE" && f.normal[1] < -0.99)!;
    return 2 * front.center[2];
  };

  it("bevels with two different distances, the first along the upper face", () => {
    const edge = pickAt(build([box]), "edge", [5, 0, 10]);
    const r = build([box, chamfer([edge], { distance: 1, distance2: 3 }, "twoDistances")]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(1000 - 0.5 * 1 * 3 * 10, 3);
    // 1 mm in along the top, 3 mm down the front.
    expect(frontTop(r)).toBeCloseTo(7, 3);
    const flipped = build([box, chamfer([edge], { distance: 1, distance2: 3 }, "twoDistances", true)]);
    expect(frontTop(flipped)).toBeCloseTo(9, 3);
  });

  it("bevels with a distance and an angle", () => {
    const edge = pickAt(build([box]), "edge", [5, 0, 10]);
    const r = build([box, chamfer([edge], { distance: 2, angle: 30 }, "distanceAngle")]);
    expect(r.featureErrors).toEqual({});
    // 2 mm along the top; the cut is at 30° to the top face, so it goes 2 tan 30° down the front.
    const down = 2 * Math.tan(Math.PI / 6);
    expect(volumes()[0]).toBeCloseTo(1000 - 0.5 * 2 * down * 10, 3);
    expect(frontTop(r)).toBeCloseTo(10 - down, 3);
    const bad = chamfer([edge], { distance: 2, angle: 95 }, "distanceAngle");
    expect(build([box, bad]).featureErrors[bad.id]).toMatch(/between 0° and 90°/);
  });

  it("bevels every edge of a picked face, the first distance along that face", () => {
    const topFace = pickAt(build([box]), "face", [5, 5, 10]);
    const r = build([box, chamfer([topFace], { distance: 1, distance2: 2 }, "twoDistances")]);
    expect(r.featureErrors).toEqual({});
    // The top shrinks to 8 × 8 and the sides are cut 2 mm down: a 10 × 10 × 2 slab becomes a frustum.
    expect(volumes()[0]).toBeCloseTo(1000 - (200 - frustum(2, 100, 64)), 3);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });
});

describe("patterns", () => {
  it("repeats in a grid of rows", () => {
    const plate = feature("box", { width: 60, depth: 60, height: 10 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const grid: Feature = { ...feature("linearPattern", { count: 3, spacing: 20, count2: 2, spacing2: 25 }, "add"), pattern: { sources: [hole.id], axis: "x", flip: false, axis2: "y" } };
    const r = build([plate, hole, grid]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(36000 - 6 * Math.PI * 9 * 10, 2);
    // The second row is 25 mm along Y: a hole's rim reaches y = 35 + 3.
    const rims = r.parts[0].edgeRefs.filter((e) => e.curve === "CIRCLE" && e.mid[2] > 9.99);
    expect(rims).toHaveLength(6);
    const same: Feature = { ...grid, id: "same-axis", pattern: { ...grid.pattern!, axis2: "x" } };
    expect(build([plate, hole, same]).featureErrors["same-axis"]).toMatch(/different axis/);
    // One row (the default) is a plain line of copies.
    build([plate, hole, { ...grid, params: { ...grid.params, count2: "1" } }]);
    expect(volumes()[0]).toBeCloseTo(36000 - 3 * Math.PI * 9 * 10, 2);
  });

  it("goes round an axis through any point, not just the origin", () => {
    const disc = feature("cylinder", { diameter: 60, height: 10, x: 100, y: 50 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 120, y: 50 }, "remove");
    const round: Feature = { ...feature("circularPattern", { count: 4, angle: 360, cx: 100, cy: 50 }, "add"), pattern: { sources: [hole.id], axis: "z", flip: false } };
    const r = build([disc, hole, round]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(Math.PI * 900 * 10 - 4 * Math.PI * 9 * 10, 1);
  });

  it("still repeats a feature after its part was joined onto another (Boolean)", () => {
    const plate = feature("box", { width: 60, depth: 20, height: 10 });
    const boss = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10, z: 10 });
    const join: Feature = { ...feature("boolean", {}), booleanDef: { op: "union", targets: [plate.id, boss.id], tools: [], keepTools: false } };
    const row: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [boss.id], axis: "x", flip: false } };
    const r = build([plate, boss, join, row]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(volumes()[0]).toBeCloseTo(12000 + 3 * Math.PI * 9 * 5, 2);
  });
});

describe("shell outwards", () => {
  const box = feature("box", { width: 10, depth: 10, height: 10 });
  it("puts the walls outside an open shell, so the part becomes the space inside", () => {
    const topFace = pickAt(build([box]), "face", [5, 5, 10]);
    const shell: Feature = { ...feature("shell", { thickness: 1 }, "add"), picks: [topFace], flipSide: true };
    const r = build([box, shell]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(12 * 12 * 11 - 1000, 2);
    const b = boundsOf(r);
    expect(b.min.map((v) => Math.round(v * 1000) / 1000)).toEqual([-1, -1, -1]);
    expect(b.max.map((v) => Math.round(v * 1000) / 1000)).toEqual([11, 11, 10]);
  });

  it("works round curved parts too", () => {
    const can = feature("cylinder", { diameter: 20, height: 10 });
    const topFace = pickAt(build([can]), "face", [0, 0, 10]);
    const r = build([can, { ...feature("shell", { thickness: 2 }, "add"), picks: [topFace], flipSide: true }]);
    expect(r.featureErrors).toEqual({});
    // A cup 24 mm across and 12 mm tall round the 20 × 10 mm cylinder.
    expect(volumes()[0]).toBeCloseTo(Math.PI * (144 * 12 - 100 * 10), 1);
    const ball = feature("sphere", { diameter: 20 });
    build([ball, { ...feature("shell", { thickness: 1 }, "add"), picks: [], flipSide: true }]);
    expect(volumes()[0]).toBeCloseTo((4 / 3) * Math.PI * (11 ** 3 - 10 ** 3), 1);
  });

  it("hollows outwards closed all round", () => {
    const shell: Feature = { ...feature("shell", { thickness: 1 }, "add"), picks: [], flipSide: true };
    const r = build([box, shell]);
    expect(r.featureErrors).toEqual({});
    // The walls round a 10 mm cube, 1 mm thick, with sharp corners: a 12 mm cube with the part's space inside.
    expect(volumes()[0]).toBeCloseTo(12 ** 3 - 1000, 2);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });
});

describe("mirror a whole part", () => {
  const half = feature("box", { width: 10, depth: 20, height: 5 });
  const mirror = (join: boolean): Feature => ({
    ...feature("mirror", {}, "add"),
    mirror: { sources: [], plane: { kind: "default", name: "Right" }, part: half.id, ...(join ? { join: true } : {}) },
  });

  it("joins the mirror image onto the part (model half, mirror the rest)", () => {
    const r = build([half, mirror(true)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(volumes()[0]).toBeCloseTo(2000, 3);
    expect(boundsOf(r).min[0]).toBeCloseTo(-10, 3);
    expect(engine.check("normal").parts[0].mesh.pieces).toBe(1);
  });

  it("makes the mirror image a new part", () => {
    const r = build([half, mirror(false)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(boundsOf(r, 1).max[0]).toBeCloseTo(0, 3);
    expect(boundsOf(r, 1).min[0]).toBeCloseTo(-10, 3);
    const gone: Feature = { ...mirror(false), mirror: { sources: [], plane: { kind: "default", name: "Right" }, part: "nope" } };
    expect(build([half, gone]).featureErrors[gone.id]).toMatch(/no longer exists/);
    const unchosen: Feature = { ...mirror(false), mirror: { sources: [], plane: { kind: "default", name: "Right" }, part: "" } };
    expect(build([half, unchosen]).featureErrors[unchosen.id]).toMatch(/Choose the part/);
  });
});

describe("review follow-ups", () => {
  it("puts walls outside a box with all its top edges rounded, leaving the bottom open", () => {
    const box = feature("box", { width: 40, depth: 30, height: 20 });
    const round: Feature = { ...feature("fillet", { radius: 5 }, "add"), picks: [pickAt(build([box]), "face", [20, 15, 20])] };
    const bottom = pickAt(build([box, round]), "face", [20, 15, 0]);
    const shell: Feature = { ...feature("shell", { thickness: 2 }, "add"), picks: [bottom], flipSide: true };
    const r = build([box, round, shell]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    const b = boundsOf(r);
    expect(b.min.map((v) => Math.round(v * 100) / 100)).toEqual([-2, -2, 0]);
    expect(b.max.map((v) => Math.round(v * 100) / 100)).toEqual([42, 32, 22]);
    // A box W × D × H with its top edges rounded (radius r, sharp upright corners) has volume
    // W·D·H − (1 − π/4) r² · (edge lengths between the rounds) − 4 · r³/3. The walls are the grown part minus the part
    // (at most; the outside corners may come out rounded too).
    const rounded = (w: number, d: number, h: number, rr: number) => w * d * h - (1 - Math.PI / 4) * rr * rr * (2 * (w - 2 * rr) + 2 * (d - 2 * rr)) - (4 * rr ** 3) / 3;
    const v = volumes()[0];
    expect(v).toBeLessThanOrEqual(rounded(44, 34, 22, 7) - rounded(40, 30, 20, 5) + 0.01);
    expect(v).toBeGreaterThan(rounded(44, 34, 22, 7) - rounded(40, 30, 20, 5) - 150);
  });

  it("explains walls outside can't leave a curved face open", () => {
    const can = feature("cylinder", { diameter: 20, height: 10 });
    const side = build([can]).parts[0].faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const shell: Feature = { ...feature("shell", { thickness: 1 }, "add"), picks: [{ partId: can.id, ref: side }], flipSide: true };
    const err = build([can, shell]).featureErrors[shell.id];
    expect(err).toMatch(/flat faces open/);
    expect(err).not.toMatch(/thinner/);
  });

  it("says a ball's face has no edges to bevel", () => {
    const ball = feature("sphere", { diameter: 20 });
    const face = pickAt(build([ball]), "face", [0, 0, 10]);
    const ch: Feature = { ...feature("chamfer", { distance: 1, distance2: 2 }, "add"), picks: [face], chamferType: "twoDistances" };
    expect(build([ball, ch]).featureErrors[ch.id]).toMatch(/no edges here/);
  });

  it("won't join a mirror image that doesn't touch the part, or mirror sheet metal whole", () => {
    const away = feature("box", { width: 10, depth: 10, height: 5, x: 5 });
    const join: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [], plane: { kind: "default", name: "Right" }, part: away.id, join: true } };
    const r = build([away, join]);
    expect(r.featureErrors[join.id]).toMatch(/doesn't touch/);
    expect(volumes()[0]).toBeCloseTo(500, 3);
    const sk = sketchFeature({ kind: "default", name: "Top" }, rect(5, 0, 20, 10));
    const sheet: Feature = { ...feature("sheetMetal", {}), sketchRef: sk.id };
    const mirrorSheet: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [], plane: { kind: "default", name: "Right" }, part: sheet.id } };
    expect(build([sk, sheet, mirrorSheet]).featureErrors[mirrorSheet.id]).toMatch(/Sheet metal/);
  });

  it("doesn't hand an intersected part's features over (a pattern would add their whole solid back)", () => {
    const plate = feature("box", { width: 60, depth: 20, height: 10 });
    const boss = feature("cylinder", { diameter: 6, height: 20, x: 10, y: 10, z: -5 });
    const keep: Feature = { ...feature("boolean", {}), booleanDef: { op: "intersect", targets: [plate.id, boss.id], tools: [], keepTools: false } };
    const row: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [boss.id], axis: "x", flip: false } };
    const r = build([plate, boss, keep, row]);
    expect(r.featureErrors[row.id]).toMatch(/no longer exists/);
    expect(volumes()[0]).toBeCloseTo(Math.PI * 9 * 10, 2);
  });

  it("makes copies of a New feature separate parts when they don't touch it, and joins them when they do", () => {
    const cube = feature("box", { width: 10, depth: 10, height: 10 });
    const apart: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [cube.id], axis: "x", flip: false } };
    const r = build([cube, apart]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2", "Part 3"]);
    expect(volumes().map((v) => Math.round(v))).toEqual([1000, 1000, 1000]);
    expect(boundsOf(r, 2).min[0]).toBeCloseTo(40, 3);
    // A later New part is numbered after them.
    const later = feature("sphere", { diameter: 4, x: 100 });
    expect(build([cube, apart, later]).parts.map((p) => p.name)).toEqual(["Part 1", "Part 2", "Part 3", "Part 4"]);
    const touching: Feature = { ...apart, params: { ...apart.params, spacing: "10" } };
    const t = build([cube, touching]);
    expect(t.parts).toHaveLength(1);
    expect(volumes()[0]).toBeCloseTo(3000, 3);
  });
});
