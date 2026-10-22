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
import { addCircle, addPoint, addRectangle } from "../src/sketch/ops";
import { grooveVolume } from "../src/kernel/thread";
import { HOLE_LEAD_IN } from "../src/model/holes";
import type { HoleOptions } from "../src/model/types";
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

  it("won't make walls outside that come apart: a boss's sleeve over an open top would float free", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const boss = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10, z: 10 }, "add");
    const top = pickAt(build([box, boss]), "face", [10, 10, 10]);
    const shell: Feature = { ...feature("shell", { thickness: 1 }, "add"), picks: [top], flipSide: true };
    const r = build([box, boss, shell]);
    // The walls would be the sides and bottom round the box (22 × 22 × 11 less the box) plus the boss's sleeve
    // and cap (π(4² − 3²) × 5 + π4² × 1 = 1484.22 mm³ in all) — but nothing joins the sleeve to the side walls once
    // the top is open, so it says so instead of making a part in two pieces.
    expect(r.featureErrors[shell.id]).toMatch(/come apart into separate pieces/);
    expect(volumes()[0]).toBeCloseTo(4000 + Math.PI * 9 * 5, 2);
    // With walls inside it works.
    const inside = build([box, boss, { ...shell, flipSide: undefined }]);
    expect(inside.featureErrors).toEqual({});
  });


  it("keeps an upright's wall down to an open step beside it", () => {
    // An L: a 30 × 10 × 5 base with a 10 × 10 × 15 upright at one end; the base's step top left open.
    const base = feature("box", { width: 30, depth: 10, height: 5 });
    const upright = feature("box", { width: 10, depth: 10, height: 20 }, "add");
    const step = pickAt(build([base, upright]), "face", [20, 5, 5]);
    const shell: Feature = { ...feature("shell", { thickness: 2 }, "add"), picks: [step], flipSide: true };
    const r = build([base, upright, shell]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].mesh.pieces).toBe(1);
    // The grown L (34 × 14 × 7 base, 14 × 14 × 24 upright, overlapping 14 × 14 × 7) up to z = 22 past the step,
    // minus the L: the walls stop at the step's plane only over the step.
    const grownBelow = 34 * 14 * 7;
    const uprightAbove = 14 * 14 * (22 - 5);
    expect(volumes()[0]).toBeCloseTo(grownBelow + uprightAbove - (30 * 10 * 5 + 10 * 10 * 15), 1);
  });

  it("cuts the walls cleanly at an open bottom when every edge is rounded", () => {
    const box = feature("box", { width: 30, depth: 30, height: 15 });
    const round: Feature = { ...feature("fillet", { radius: 3 }, "add"), picks: [pickAt(build([box]), "face", [15, 15, 15]), pickAt(build([box]), "face", [15, 15, 0])] };
    const bottom = pickAt(build([box, round]), "face", [15, 15, 0]);
    const shell: Feature = { ...feature("shell", { thickness: 2 }, "add"), picks: [bottom], flipSide: true };
    const r = build([box, round, shell]);
    expect(r.featureErrors).toEqual({});
    expect(boundsOf(r).min[2]).toBeCloseTo(0, 2);
    expect(boundsOf(r).max[2]).toBeCloseTo(17, 2);
  });

  describe("walls outside, open faces in the same plane as others", () => {
    // A U: a 30 × 10 × 5 base with prongs at x 0–5 and x 25–30 up to z = 15.
    const base = feature("box", { width: 30, depth: 10, height: 5 });
    const left = feature("box", { width: 5, depth: 10, height: 10, z: 5 }, "add");
    const right = feature("box", { width: 5, depth: 10, height: 10, x: 25, z: 5 }, "add");
    const u = [base, left, right];
    const open = (at: [number, number, number][]): Feature => {
      const r0 = build(u);
      return { ...feature("shell", { thickness: 2 }, "add"), picks: at.map((p) => pickAt(r0, "face", p)), flipSide: true };
    };
    const onePiece = (r: ReturnType<typeof build>) => {
      expect(r.featureErrors).toEqual({});
      expect(engine.check("normal").parts[0].mesh.pieces).toBe(1);
    };

    it("leaves the cover on the other prong when one prong's top is open", () => {
      onePiece(build([...u, open([[2.5, 5, 15]])]));
      expect(volumes()[0]).toBeCloseTo(4052, 1);
      // The right prong's cap (x 23–32, 14 mm deep, 2 mm thick) is still there.
      onePiece(build([...u, open([[2.5, 5, 15], [27.5, 5, 15]])]));
      expect(volumes()[0]).toBeCloseTo(4052 - 9 * 14 * 2, 1);
    });

    it("opens the floor between the prongs, keeping each prong's walls down to it", () => {
      onePiece(build([...u, open([[15, 5, 5]])]));
      expect(volumes()[0]).toBeCloseTo(3856, 1);
    });

    it("leaves the cover and rims on the other side of a T's underside", () => {
      // A T: stem x 10–20 up to z = 10, bar x 0–30 from z = 10 to 15; only the bar's left underside left open.
      const stem = feature("box", { width: 10, depth: 10, height: 10, x: 10 });
      const bar = feature("box", { width: 30, depth: 10, height: 5, z: 10 }, "add");
      const r0 = build([stem, bar]);
      const shell = (at: [number, number, number][]): Feature => ({ ...feature("shell", { thickness: 2 }, "add"), picks: at.map((p) => pickAt(r0, "face", p)), flipSide: true });
      onePiece(build([stem, bar, shell([[5, 5, 10]])]));
      expect(volumes()[0]).toBeCloseTo(3464, 1);
      // Both undersides open: the right one's cover and rims (x 18–32, 14 mm deep, 2 mm) go too.
      onePiece(build([stem, bar, shell([[5, 5, 10], [25, 5, 10]])]));
      expect(volumes()[0]).toBeCloseTo(3464 - 280, 1);
    });

    it("leaves the cover on the far side of a groove when only one side's top is open", () => {
      const block = feature("box", { width: 30, depth: 10, height: 10 });
      const groove = feature("box", { width: 4, depth: 10, height: 3, x: 13, z: 7 }, "remove");
      const r0 = build([block, groove]);
      const shell = (at: [number, number, number][]): Feature => ({ ...feature("shell", { thickness: 1 }, "add"), picks: at.map((p) => pickAt(r0, "face", p)), flipSide: true });
      onePiece(build([block, groove, shell([[6, 5, 10]])]));
      const leftOnly = volumes()[0];
      onePiece(build([block, groove, shell([[6, 5, 10], [24, 5, 10]])]));
      // The right top's cover: x 16–31 (with the groove wall's and the end wall's tops), 12 mm deep, 1 mm thick.
      expect(leftOnly - volumes()[0]).toBeCloseTo(15 * 12 * 1, 1);
    });
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

});

// ---------------------------------------------------------------------------
// Round 2: holes, extrude ends, picked directions, skipped copies

/** A flat-face sketch plane at height z (normal +Z, like a top face). */
const faceAt = (z: number): SketchPlane => ({ kind: "face", origin: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], label: `Face at z = ${z}` });
const points = (...at: [number, number][]) => at.reduce((s, [x, y]) => addPoint(s, { x, y }).sketch, emptySketch());
function holeFeature(sketchRef: string, params: Record<string, number>, hole: Partial<HoleOptions>): Feature {
  return { ...feature("hole", params, "remove"), hole: { sketchRef, kind: "simple", standard: "Custom", fit: "clearance", end: "throughAll", flip: false, ...hole } };
}
/** A 40 × 40 × 30 box with a closed 30 × 30 × 10 space inside it (walls 10 thick top and bottom). */
const hollowBox = () => [feature("box", { width: 40, depth: 40, height: 30 }), feature("box", { width: 30, depth: 30, height: 10, x: 5, y: 5, z: 10 }, "remove")];
const HOLLOW = 40 * 40 * 30 - 30 * 30 * 10;

describe("holes, round 2", () => {
  it("drills through all one way from the sketch (as in Onshape), the other way with Flip, or both ways if asked", () => {
    const block = feature("box", { width: 20, depth: 20, height: 20, z: -10 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, points([10, 10]));
    const hole = holeFeature(sk.id, { diameter: 4 }, { end: "throughAll" });
    expect(build([block, sk, hole]).featureErrors).toEqual({});
    // Down from the Top plane only, as it always has (starting a whisker above it, to cut cleanly from a face).
    const oneWay = 8000 - Math.PI * 4 * (10 + HOLE_LEAD_IN);
    expect(volumes()[0]).toBeCloseTo(oneWay, 3);
    expect(boundsOf(build([block, sk, { ...hole, hole: { ...hole.hole!, flip: true } }])).max[2]).toBeCloseTo(10, 3);
    expect(volumes()[0]).toBeCloseTo(oneWay, 3);
    // Both ways: right through, top to bottom.
    const r = build([block, sk, { ...hole, hole: { ...hole.hole!, bothWays: true } }]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(8000 - Math.PI * 4 * 20, 3);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });

  it("keeps through-all holes one way, so a bridge above the sketch isn't drilled", () => {
    // A slot floor at z = 10 with a bridge across above it (z 20..25): the hole drills the floor only.
    const block = feature("box", { width: 30, depth: 20, height: 25 });
    const slot = feature("box", { width: 30, depth: 20, height: 10, z: 10 }, "remove");
    const sk = sketchFeature(faceAt(10), points([15, 10]));
    build([block, slot, sk, holeFeature(sk.id, { diameter: 4 }, { end: "throughAll" })]);
    expect(volumes()[0]).toBeCloseTo(30 * 20 * 15 - Math.PI * 4 * 10, 3);
  });

  it("drills through all from a top face just as before (counterbored too)", () => {
    const block = feature("box", { width: 20, depth: 20, height: 20 });
    const sk = sketchFeature(faceAt(20), points([10, 10]));
    build([block, sk, holeFeature(sk.id, { diameter: 4 }, { end: "throughAll" })]);
    expect(volumes()[0]).toBeCloseTo(8000 - Math.PI * 4 * 20, 3);
    build([block, sk, holeFeature(sk.id, { diameter: 4, cboreDiameter: 8, cboreDepth: 5 }, { kind: "counterbore", end: "throughAll" })]);
    expect(volumes()[0]).toBeCloseTo(8000 - Math.PI * 4 * 15 - Math.PI * 16 * 5, 3);
  });

  it("up to next drills through the first wall only", () => {
    const sk = sketchFeature(faceAt(30), points([20, 20]));
    const r = build([...hollowBox(), sk, holeFeature(sk.id, { diameter: 4 }, { end: "upToNext" })]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(HOLLOW - Math.PI * 4 * 10, 3);
    // From a sketch above the part it crosses the gap first, then drills the same wall.
    const above = sketchFeature(faceAt(35), points([20, 20]));
    build([...hollowBox(), above, holeFeature(above.id, { diameter: 4 }, { end: "upToNext" })]);
    expect(volumes()[0]).toBeCloseTo(HOLLOW - Math.PI * 4 * 10, 3);
  });

  it("up to next says what to do when a hole misses the part", () => {
    const sk = sketchFeature(faceAt(30), points([60, 60]));
    const hole = holeFeature(sk.id, { diameter: 4 }, { end: "upToNext" });
    const r = build([...hollowBox(), sk, hole]);
    expect(r.featureErrors[hole.id]).toMatch(/doesn't meet the part.*Flip direction/);
    expect(volumes()[0]).toBeCloseTo(HOLLOW, 3);
  });

  it("won't make the thread deeper than a blind hole", () => {
    const block = feature("box", { width: 20, depth: 20, height: 10 });
    const sk = sketchFeature(faceAt(10), points([10, 10]));
    const hole = holeFeature(sk.id, { diameter: 2.5, depth: 6, threadDepth: 8 }, { standard: "M3", fit: "tapped", end: "blind" });
    expect(build([block, sk, hole]).featureErrors[hole.id]).toMatch(/thread \(8 mm\) is deeper than the hole \(6 mm\)/);
  });

  it("models a tapped hole's thread as a real helix, down to the thread depth", () => {
    const block = feature("box", { width: 20, depth: 20, height: 10 });
    const sk = sketchFeature(faceAt(10), points([10, 10]));
    const plain = holeFeature(sk.id, { diameter: 2.5, depth: 8, threadDepth: 6 }, { standard: "M3", fit: "tapped", end: "blind" });
    build([block, sk, plain]);
    const drilled = volumes()[0];
    const threaded = { ...plain, hole: { ...plain.hole!, modelThread: true } };
    const r = build([block, sk, threaded]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // The groove takes out about what a 60° V, 0.5 pitch, 6 mm down the wall should.
    const expected = grooveVolume({ origin: [10, 10, 10], axis: [0, 0, -1], radius: 1.25 }, 0.5, false, -0.5, 6, 0, 6);
    const removed = drilled - check.exactVolume!;
    expect(removed).toBeGreaterThan(0.75 * expected);
    expect(removed).toBeLessThan(1.25 * expected);
    // The outside of the block is untouched.
    const b = boundsOf(r);
    expect(b.min[2]).toBeCloseTo(0, 3);
    expect(b.max[0]).toBeCloseTo(20, 3);
  });

  it("threads a through hole all the way through", () => {
    const block = feature("box", { width: 20, depth: 20, height: 6 });
    const sk = sketchFeature(faceAt(6), points([10, 10]));
    const plain = holeFeature(sk.id, { diameter: 2.5 }, { standard: "M3", fit: "tapped", end: "throughAll" });
    build([block, sk, plain]);
    const drilled = volumes()[0];
    expect(drilled).toBeCloseTo(2400 - Math.PI * 1.25 * 1.25 * 6, 3);
    const r = build([block, sk, { ...plain, hole: { ...plain.hole!, modelThread: true } }]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    const expected = grooveVolume({ origin: [10, 10, 6], axis: [0, 0, -1], radius: 1.25 }, 0.5, false, -0.5, 6.5, 0, 6);
    const removed = drilled - volumes()[0];
    expect(removed).toBeGreaterThan(0.75 * expected);
    expect(removed).toBeLessThan(1.25 * expected);
  });
});

describe("modelled threads, round 2 review", () => {
  it("threads only the wall an up-to-next hole drills, not the walls past it", () => {
    const sk = sketchFeature(faceAt(30), points([20, 20]));
    const plain = holeFeature(sk.id, { diameter: 3.3 }, { standard: "M4", fit: "tapped", end: "upToNext" });
    build([...hollowBox(), sk, plain]);
    const drilled = volumes()[0];
    expect(drilled).toBeCloseTo(HOLLOW - Math.PI * 1.65 * 1.65 * 10, 3);
    const r = build([...hollowBox(), sk, { ...plain, hole: { ...plain.hole!, modelThread: true } }]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // One 10 mm wall's worth of groove (the bottom wall is untouched).
    const oneWall = grooveVolume({ origin: [20, 20, 30], axis: [0, 0, -1], radius: 1.65 }, 0.7, false, -0.7, 10.7, 0, 10);
    expect(drilled - volumes()[0]).toBeCloseTo(oneWall, 0);
    expect(Math.abs(drilled - volumes()[0] - oneWall)).toBeLessThan(0.05 * oneWall);
  });

  it("threads a both-ways hole from a middle plane right through, top and bottom", () => {
    const block = feature("box", { width: 20, depth: 20, height: 12, z: -6 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, points([10, 10]));
    const plain = holeFeature(sk.id, { diameter: 2.5 }, { standard: "M3", fit: "tapped", end: "throughAll", bothWays: true });
    build([block, sk, plain]);
    const drilled = volumes()[0];
    expect(drilled).toBeCloseTo(4800 - Math.PI * 1.25 * 1.25 * 12, 3);
    const r = build([block, sk, { ...plain, hole: { ...plain.hole!, modelThread: true } }]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    const full = grooveVolume({ origin: [10, 10, 6], axis: [0, 0, -1], radius: 1.25 }, 0.5, false, -0.5, 12.5, 0, 12);
    expect(Math.abs(drilled - volumes()[0] - full)).toBeLessThan(0.05 * full);
  });

  it("measures the thread depth from where the hole goes into the part", () => {
    // The sketch is 5 mm above the block: a 4 mm thread still runs 4 mm into the block.
    const block = feature("box", { width: 20, depth: 20, height: 10 });
    const sk = sketchFeature(faceAt(15), points([10, 10]));
    const plain = holeFeature(sk.id, { diameter: 2.5, threadDepth: 4 }, { standard: "M3", fit: "tapped", end: "throughAll" });
    build([block, sk, plain]);
    const drilled = volumes()[0];
    build([block, sk, { ...plain, hole: { ...plain.hole!, modelThread: true } }]);
    const fourMm = grooveVolume({ origin: [10, 10, 10], axis: [0, 0, -1], radius: 1.25 }, 0.5, false, -0.5, 4, 0, 4);
    expect(Math.abs(drilled - volumes()[0] - fourMm)).toBeLessThan(0.1 * fourMm);
  });

  for (const gap of [0.3, 0.5, 0.7, 1, 1.2, 1.5, 3]) {
    it(`threads an up-to-next hole cleanly with only ${gap} mm of room past the wall`, () => {
      const box = feature("box", { width: 40, depth: 40, height: 20 + gap });
      const cavity = feature("box", { width: 30, depth: 30, height: gap, x: 5, y: 5, z: 10 }, "remove");
      const sk = sketchFeature(faceAt(20 + gap), points([20, 20]));
      const plain = holeFeature(sk.id, { diameter: 3.3 }, { standard: "M4", fit: "tapped", end: "upToNext" });
      build([box, cavity, sk, plain]);
      const drilled = volumes()[0];
      const r = build([box, cavity, sk, { ...plain, hole: { ...plain.hole!, modelThread: true } }]);
      const check = engine.check("normal").parts[0];
      expect(check.geometryValid).toBe(true);
      expect(r.parts).toHaveLength(1);
      // The thread is cut, with no fallback: right through the wall when there's room for a whole turn of
      // run-out past it (1 mm or more for M4), otherwise ending a pitch inside the wall.
      expect(r.featureErrors).toEqual({});
      const oneWall = grooveVolume({ origin: [20, 20, 20 + gap], axis: [0, 0, -1], radius: 1.65 }, 0.7, false, -0.7, 10.7, 0, 10);
      const removed = drilled - check.exactVolume!;
      if (gap >= 1) expect(Math.abs(removed - oneWall)).toBeLessThan(0.05 * oneWall);
      else {
        expect(removed).toBeLessThan(oneWall);
        expect(removed).toBeGreaterThan(0.85 * oneWall);
      }
    });
  }

  it("copies the thread along with the hole in a pattern", () => {
    const plate = feature("box", { width: 30, depth: 20, height: 6 });
    const sk = sketchFeature(faceAt(6), points([5, 10]));
    const plain = holeFeature(sk.id, { diameter: 2.5 }, { standard: "M3", fit: "tapped", end: "throughAll" });
    const threaded = { ...plain, hole: { ...plain.hole!, modelThread: true } };
    const row: Feature = { ...feature("linearPattern", { count: 2, spacing: 15 }, "add"), pattern: { sources: [plain.id], axis: "x", flip: false } };
    build([plate, sk, plain, row]);
    const drilled = volumes()[0];
    build([plate, sk, threaded]);
    const one = 3600 - Math.PI * 1.25 * 1.25 * 6 - volumes()[0];
    const r = build([plate, sk, threaded, row]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    expect(drilled - volumes()[0]).toBeCloseTo(2 * one, 2);
  });

  it("cuts a single M4 thread through a 10 mm plate in a few seconds, and reuses it", () => {
    const plate = feature("box", { width: 30, depth: 20, height: 10 });
    const sk = sketchFeature(faceAt(10), points([10, 10]));
    const hole = holeFeature(sk.id, { diameter: 3.3 }, { standard: "M4", fit: "tapped", end: "throughAll", modelThread: true });
    engine = new GeometryEngine();
    let t = Date.now();
    expect(engine.rebuild([plate, sk, hole]).featureErrors).toEqual({});
    const cut = Date.now() - t;
    // Very generous: shared CI machines vary a lot in speed.
    expect(cut).toBeLessThan(60_000);
    const first = engine.check("normal").parts[0].exactVolume!;
    // Something added after it: the threaded hole isn't cut again, so it's far quicker.
    t = Date.now();
    engine.rebuild([plate, sk, hole, feature("box", { width: 5, depth: 5, height: 5, x: 25, z: 10 }, "add")]);
    expect(Date.now() - t).toBeLessThan(Math.max(cut / 3, 500));
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(first + 125, 3);
  });
});

describe("extrude ends, round 2", () => {
  const extrude = (sketchRef: string, params: Record<string, number>, ex: Feature["extrude"], op: Operation = "new"): Feature => ({ ...feature("extrude", params, op), sketchRef, extrude: ex });

  it("up to next adds a boss from a face up to the part above it", () => {
    const base = feature("box", { width: 40, depth: 40, height: 10 });
    const shelf = feature("box", { width: 40, depth: 40, height: 5, z: 30 });
    const sk = sketchFeature(faceAt(10), rect(10, 10, 10, 10));
    const r = build([base, shelf, sk, extrude(sk.id, {}, { end: "upToNext", flip: false }, "add")]);
    expect(r.featureErrors).toEqual({});
    // 20 mm tall: from the base's top (z = 10) to the shelf's underside (z = 30).
    expect(volumes().reduce((a, b) => a + b, 0)).toBeCloseTo(16000 + 8000 + 2000, 2);
  });

  it("up to next cuts through the first wall only", () => {
    const sk = sketchFeature(faceAt(30), rect(15, 15, 10, 10));
    const r = build([...hollowBox(), sk, extrude(sk.id, {}, { end: "upToNext", flip: true }, "remove")]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(HOLLOW - 1000, 3);
  });

  it("up to next stops under a shelf and doesn't fill the space above it", () => {
    // A shelf over half the sketch (x 0..15 at z 20..25) and a roof over all of it (z 40).
    const base = feature("box", { width: 40, depth: 40, height: 10 });
    const shelf = feature("box", { width: 15, depth: 40, height: 5, z: 20 });
    const roof = feature("box", { width: 40, depth: 40, height: 5, z: 40 });
    const sk = sketchFeature(faceAt(10), rect(10, 10, 10, 10));
    const ex = extrude(sk.id, {}, { end: "upToNext", flip: false });
    const r = build([base, shelf, roof, sk, ex]);
    expect(r.featureErrors).toEqual({});
    // x 10..15 stops at the shelf (10 tall), x 15..20 at the roof (30 tall).
    expect(volumes()[3]).toBeCloseTo(5 * 10 * 10 + 5 * 10 * 30, 3);
  });

  it("up to next cuts only the first stretch of material under each part of the sketch", () => {
    // A 40 × 40 × 20 block with a step taken out (x 20..40, z 10..20).
    const block = feature("box", { width: 40, depth: 40, height: 20 });
    const step = feature("box", { width: 20, depth: 40, height: 10, x: 20, z: 10 }, "remove");
    const sk = sketchFeature(faceAt(20), rect(10, 10, 20, 10));
    const r = build([block, step, sk, extrude(sk.id, {}, { end: "upToNext", flip: true }, "remove")]);
    expect(r.featureErrors).toEqual({});
    // x 10..20 starts in the block and cuts right down (2000); x 20..30 starts over the step, in the open: nothing.
    expect(volumes()[0]).toBeCloseTo(32000 - 8000 - 2000, 3);
  });

  it("up to next stops on a round bar lying across the sketch", () => {
    // A bar (Ø10, along Y) at x = 15, z = 30; the sketch (x 10..20) is right under it.
    const base = feature("box", { width: 40, depth: 40, height: 10 });
    const bar: Feature = { ...feature("extrude", {}), sketchRef: "bar-sk", extrude: { end: "symmetric", flip: false } };
    const barSketch: Feature = { ...sketchFeature({ kind: "default", name: "Front" }, emptySketch()), id: "bar-sk" };
    const front = { kind: "face" as const, origin: [0, 0, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number], label: "front" };
    barSketch.sketch = { plane: front, data: addCircle(emptySketch(), { x: 15, y: 30 }, 5).sketch };
    bar.params = { ...bar.params, depth: "100" };
    const sk = sketchFeature(faceAt(10), rect(10, 10, 10, 10));
    const ex = extrude(sk.id, {}, { end: "upToNext", flip: false });
    const r = build([base, barSketch, bar, sk, ex]);
    expect(r.featureErrors).toEqual({});
    // Up to the underside of the bar: z = 30 − √(25 − (x − 15)²), for x from 10 to 15 to 20, 10 deep.
    const underBar = 10 * (20 * 10 - (Math.PI * 25) / 2);
    expect(volumes()[2]).toBeCloseTo(underBar, 2);
  });

  it("says so when a Remove extrude is nowhere near any part", () => {
    const block = feature("box", { width: 20, depth: 20, height: 10 });
    const sk = sketchFeature(faceAt(10), rect(30, 5, 5, 5));
    const ex = extrude(sk.id, { depth: 5 }, { end: "blind", flip: true }, "remove");
    expect(build([block, sk, ex]).featureErrors[ex.id]).toMatch(/doesn't reach any part.*Flip/);
    expect(volumes()[0]).toBeCloseTo(4000, 3);
    // Touching the part (or inside a pocket already cut) isn't flagged.
    const near = sketchFeature(faceAt(10), rect(5, 5, 5, 5));
    expect(build([block, near, { ...extrude(near.id, { depth: 5 }, { end: "blind", flip: false }, "remove"), id: "up" }]).featureErrors).toEqual({});
  });

  it("keeps a seed cut off the part, so its pattern and mirror still cut", () => {
    const plate = feature("box", { width: 100, depth: 20, height: 5 });
    const sk = sketchFeature(faceAt(5), rect(-15, 5, 10, 10));
    const seed = extrude(sk.id, { depth: 5 }, { end: "blind", flip: true }, "remove");
    const row: Feature = { ...feature("linearPattern", { count: 4, spacing: 25 }, "add"), pattern: { sources: [seed.id], axis: "x", flip: false } };
    const r = build([plate, sk, seed, row]);
    expect(r.featureErrors).toEqual({});
    // Copies at x 10..20, 35..45 and 60..70 cut the plate (the seed itself is off it).
    expect(volumes()[0]).toBeCloseTo(10000 - 3 * 500, 3);
    const across: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [seed.id], plane: { kind: "default", name: "Right" } } };
    expect(build([plate, sk, seed, across]).featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(10000 - 500, 3);
  });

  it("up to next says when nothing stops it", () => {
    const base = feature("box", { width: 40, depth: 40, height: 10 });
    const sk = sketchFeature(faceAt(10), rect(10, 10, 10, 10));
    const ex = extrude(sk.id, {}, { end: "upToNext", flip: false }, "add");
    expect(build([base, sk, ex]).featureErrors[ex.id]).toMatch(/never meets a part.*Flip the direction/);
  });

  it("extrudes up to a corner (vertex), with an offset", () => {
    const block = feature("box", { width: 20, depth: 20, height: 20 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, rect(30, 0, 10, 10));
    const first = build([block]);
    const pick = pickAt(first, "edge", [20, 20, 10]);
    const ref = pick.ref as Extract<TopoPick["ref"], { kind: "edge" }>;
    const top = ref.a[2] > ref.b[2] ? "a" : "b";
    const ex = extrude(sk.id, {}, { end: "upToVertex", flip: false, upTo: pick, upToEnd: top });
    build([block, sk, ex]);
    expect(volumes()[1]).toBeCloseTo(100 * 20, 3);
    build([block, sk, { ...ex, params: { ...ex.params, offset: "-5" } }]);
    expect(volumes()[1]).toBeCloseTo(100 * 15, 3);
    // The bottom corner is level with the sketch: nothing to extrude.
    const low = { ...ex, extrude: { ...ex.extrude!, upToEnd: top === "a" ? ("b" as const) : ("a" as const) } };
    expect(build([block, sk, low]).featureErrors[ex.id]).toMatch(/level with the sketch/);
  });

  it("extrudes up to a part, and says so when some of the sketch misses it", () => {
    const roof = feature("box", { width: 40, depth: 40, height: 10, z: 20 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, rect(5, 5, 10, 10));
    const first = build([roof]);
    const ex = extrude(sk.id, {}, { end: "upToPart", flip: false, upTo: pickAt(first, "face", [20, 20, 30]) });
    const r = build([roof, sk, ex]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[1]).toBeCloseTo(100 * 20, 3);
    const off = sketchFeature({ kind: "default", name: "Top" }, rect(35, 5, 10, 10));
    expect(build([roof, off, { ...ex, sketchRef: off.id }]).featureErrors[ex.id]).toMatch(/never meets Part 1/);
  });

  it("extrudes up to a flat face with an offset (past it, or short of it)", () => {
    const roof = feature("box", { width: 40, depth: 40, height: 10, z: 20 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, rect(5, 5, 10, 10));
    const under = pickAt(build([roof]), "face", [20, 20, 20]);
    const ex = extrude(sk.id, { offset: -5 }, { end: "upToFace", flip: false, upTo: under });
    build([roof, sk, ex]);
    expect(volumes()[1]).toBeCloseTo(100 * 15, 3);
    build([roof, sk, { ...ex, params: { ...ex.params, offset: "2" } }]);
    expect(volumes()[1]).toBeCloseTo(100 * 22, 3);
    expect(build([roof, sk, { ...ex, params: { ...ex.params, offset: "-25" } }]).featureErrors[ex.id]).toMatch(/smaller than 20 mm/);
  });

  it("extrudes up to a slanted flat face", () => {
    // A 40 × 40 × 10 slab tilted 20° about X (about its centre, 20, 20, 5).
    const slab = feature("box", { width: 40, depth: 40, height: 10 });
    const tilt: Feature = { ...feature("transform", { rx: 20 }), transform: { partId: slab.id, axis: "x", about: "centre", copy: false } };
    const sk = sketchFeature(faceAt(50), rect(15, 15, 10, 10));
    const top = pickAt(build([slab, tilt]), "face", [20, 20, 10]);
    const ex = extrude(sk.id, {}, { end: "upToFace", flip: false, upTo: top });
    const r = build([slab, tilt, sk, ex]);
    expect(r.featureErrors).toEqual({});
    // Down from z = 50 to the tilted top, which is 5 / cos 20° above the centre where the sketch's middle is.
    const theta = (20 * Math.PI) / 180;
    expect(volumes()[1]).toBeCloseTo(100 * (50 - 5 - 5 / Math.cos(theta)), 3);
    // A draft needs a face parallel to the sketch.
    expect(build([slab, tilt, sk, { ...ex, params: { ...ex.params, draft: "3" } }]).featureErrors[ex.id]).toMatch(/Set the draft to 0/);
  });

  it("tells the inside and outside of a pipe apart by where the face was clicked", () => {
    const pipe = feature("cylinder", { diameter: 60, height: 20 });
    const bore = feature("cylinder", { diameter: 40, height: 20 }, "remove");
    const plane: SketchPlane = { kind: "face", origin: [0, -50, 0], u: [0, 0, 1], v: [1, 0, 0], label: "front" };
    const sk = sketchFeature(plane, rect(5, -1, 10, 2));
    const first = build([pipe, bore]);
    const rounds = first.parts[0].faceRefs.filter((f) => f.surface === "CYLINDRE");
    expect(rounds).toHaveLength(2);
    // Both round faces are described the same way (same axis, same centre): only the click point tells them apart.
    const under = (r: number) => 2 * (0.5 * Math.sqrt(r * r - 1) + ((r * r) / 2) * Math.asin(1 / r));
    for (const [at, r] of [[[0, -20, 10], 20], [[0, -30, 10], 30]] as [[number, number, number], number][]) {
      const ex = extrude(sk.id, {}, { end: "upToFace", flip: false, upTo: { partId: first.parts[0].id, ref: rounds[0], at } });
      const built = build([pipe, bore, sk, ex]);
      expect(built.featureErrors).toEqual({});
      expect(volumes()[1]).toBeCloseTo(10 * (2 * 50 - under(r)), 3);
    }
  });

  it("extrudes up to a curved (round) face", () => {
    const drum = feature("cylinder", { diameter: 40, height: 10, z: 20 });
    // A sketch facing +Y, 50 mm in front of the drum: x runs up (Z), y runs across (X).
    const plane: SketchPlane = { kind: "face", origin: [0, -50, 0], u: [0, 0, 1], v: [1, 0, 0], label: "front" };
    const sk = sketchFeature(plane, rect(22, -1, 6, 2));
    const side = pickAt(build([drum]), "face", [0, -20, 25]);
    const ex = extrude(sk.id, {}, { end: "upToFace", flip: false, upTo: side });
    const r = build([drum, sk, ex]);
    expect(r.featureErrors).toEqual({});
    // From y = −50 to the drum's side y = −√(400 − x²), for x from −1 to 1, 6 mm tall.
    const underArc = 2 * (0.5 * Math.sqrt(399) + 200 * Math.asin(1 / 20));
    expect(volumes()[1]).toBeCloseTo(6 * (2 * 50 - underArc), 3);
    expect(engine.check("normal").parts[1].geometryValid).toBe(true);
    expect(build([drum, sk, { ...ex, params: { ...ex.params, offset: "1" } }]).featureErrors[ex.id]).toMatch(/offset only works with a flat face/);
  });
});

describe("patterns, round 2", () => {
  it("runs a linear pattern along a clicked edge", () => {
    // A plate 20 wide (X) and 100 long (Y): copies along X would fall off it, along Y they're all in it.
    const plate = feature("box", { width: 20, depth: 100, height: 5 });
    const hole = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10 }, "remove");
    const edge = pickAt(build([plate]), "edge", [0, 50, 5]);
    const ref = edge.ref as Extract<TopoPick["ref"], { kind: "edge" }>;
    const flip = ref.b[1] < ref.a[1];
    const row: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [hole.id], axis: "x", flip, along: edge } };
    const r = build([plate, hole, row]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(10000 - 3 * Math.PI * 9 * 5, 2);
    // The last hole's rim reaches y = 50 + 3.
    const rims = r.parts[0].edgeRefs.filter((e) => e.curve === "CIRCLE" && e.mid[2] > 4.99);
    expect(Math.max(...rims.map((e) => Math.max(e.a[1], e.b[1], e.mid[1])))).toBeLessThan(53.01);
    expect(rims).toHaveLength(3);
  });

  it("goes round the axis of a clicked round face", () => {
    const disc = feature("cylinder", { diameter: 60, height: 10, x: 100, y: 50 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 120, y: 50 }, "remove");
    const side = pickAt(build([disc]), "face", [130, 50, 5]);
    // cx, cy are left at 0: the clicked face says where the axis is.
    const round: Feature = { ...feature("circularPattern", { count: 4, angle: 360 }, "add"), pattern: { sources: [hole.id], axis: "z", flip: false, along: side } };
    const r = build([disc, hole, round]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(Math.PI * 900 * 10 - 4 * Math.PI * 9 * 10, 1);
  });

  it("asks for a round face when the clicked face is flat", () => {
    const disc = feature("cylinder", { diameter: 60, height: 10, x: 100, y: 50 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 120, y: 50 }, "remove");
    const top = pickAt(build([disc]), "face", [100, 50, 10]);
    const round: Feature = { ...feature("circularPattern", { count: 4, angle: 360 }, "add"), pattern: { sources: [hole.id], axis: "z", flip: false, along: top } };
    expect(build([disc, hole, round]).featureErrors[round.id]).toMatch(/isn't round/);
  });

  it("mirrors a whole part across one of its faces (a clicked face becomes the plane)", () => {
    const block = feature("box", { width: 10, depth: 10, height: 10 });
    // The plane a click on the block's right-hand face (x = 10) gives.
    const right: SketchPlane = { kind: "face", origin: [10, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "Face of Part 1" };
    const join: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [], plane: right, part: block.id, join: true } };
    const r = build([block, join]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(2000, 3);
    expect(boundsOf(r).max[0]).toBeCloseTo(20, 3);
  });

  it("leaves out skipped copies", () => {
    const plate = feature("box", { width: 100, depth: 20, height: 5 });
    const hole = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10 }, "remove");
    const row: Feature = { ...feature("linearPattern", { count: 4, spacing: 20 }, "add"), pattern: { sources: [hole.id], axis: "x", flip: false, skip: [3] } };
    const r = build([plate, hole, row]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[0]).toBeCloseTo(10000 - 3 * Math.PI * 9 * 5, 2);
    // Copy 3 (at x = 50) is the one missing.
    const xs = r.parts[0].edgeRefs.filter((e) => e.curve === "CIRCLE" && e.mid[2] > 4.99).map((e) => Math.round((e.a[0] + e.mid[0]) / 2 / 10) * 10);
    expect(xs.some((x) => Math.abs(x - 50) < 5)).toBe(false);
    // In a circle, too.
    const disc = feature("cylinder", { diameter: 60, height: 10 });
    const pin = feature("cylinder", { diameter: 6, height: 10, x: 20 }, "remove");
    const ring: Feature = { ...feature("circularPattern", { count: 6, angle: 360 }, "add"), pattern: { sources: [pin.id], axis: "z", flip: false, skip: [2, 4] } };
    build([disc, pin, ring]);
    expect(volumes()[0]).toBeCloseTo(Math.PI * 900 * 10 - 4 * Math.PI * 9 * 10, 1);
    // Skipping everything is an error that says what to do.
    const none = { ...ring, pattern: { ...ring.pattern!, skip: [2, 3, 4, 5, 6] } };
    expect(build([disc, pin, none]).featureErrors[ring.id]).toMatch(/Every copy is skipped/);
  });
});
