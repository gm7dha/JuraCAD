import { describe, expect, it } from "vitest";

import { findRegions } from "../src/sketch/regions";
import { loopArea, MITRE_LIMIT, thinAmounts, thinLoops, thinSketches } from "../src/sketch/thin";
import { pickOf, sketchAreas } from "../src/sketch/areas";
import { areasTaken, freeAreas } from "../src/sketch/areaClicks";
import { revolveWay } from "../src/model/features";
import type { Feature } from "../src/model/types";
import type { SketchCurve, SketchData, SketchPoint } from "../src/sketch/types";

/** A sketch from points (id → [x, y]) and curves. */
function sketch(pts: Record<string, [number, number]>, curves: SketchCurve[]): SketchData {
  const points: SketchPoint[] = Object.entries(pts).map(([id, [x, y]]) => ({ id, x, y }));
  return { points, curves, constraints: [] };
}
const line = (id: string, p1: string, p2: string, construction = false): SketchCurve => ({ id, type: "line", p1, p2, construction });

/** The wall's area: every closed shape of every run's sketch (outer minus holes). */
function wallArea(pieces: SketchData[]): number {
  let a = 0;
  for (const p of pieces) {
    const { regions, problems } = findRegions(p);
    expect(problems).toEqual([]);
    for (const r of regions) a += r.outer.area - r.holes.reduce((s, h) => s + h.area, 0);
  }
  return a;
}
function box(pieces: SketchData[]) {
  const ids = new Set(pieces.flatMap((p) => p.curves.filter((c) => c.id.startsWith("thin:")).flatMap((c) => (c.type === "line" ? [c.p1, c.p2] : c.type === "arc" ? [c.start, c.end] : []))));
  const pts = pieces.flatMap((p) => p.points.filter((q) => ids.has(q.id)));
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(Math.min(...pts.map((p) => p.x))), r(Math.min(...pts.map((p) => p.y))), r(Math.max(...pts.map((p) => p.x))), r(Math.max(...pts.map((p) => p.y)))];
}

describe("thin walls (pure)", () => {
  it("works out each side's amount: one side, two, centred, flipped", () => {
    expect(thinAmounts({ thickness: 2, thickness2: 0 })).toEqual([2, 0]);
    expect(thinAmounts({ thickness: 2, thickness2: 1 })).toEqual([2, 1]);
    expect(thinAmounts({ thickness: 2, thickness2: 1, flip: true })).toEqual([1, 2]);
    expect(thinAmounts({ thickness: 3, thickness2: 9, midPlane: true })).toEqual([1.5, 1.5]);
  });

  it("makes a straight line into a rectangle with square ends, on its first side (above a left-to-right line)", () => {
    const s = sketch({ a: [40, 0], b: [0, 0] }, [line("l", "a", "b")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(pieces).toHaveLength(1);
    expect(wallArea(pieces)).toBeCloseTo(80, 9);
    expect(box(pieces)).toEqual([0, 0, 40, 2]);
    expect(box(thinSketches(s, { thickness: 2, thickness2: 0, flip: true }))).toEqual([0, -2, 40, 0]);
    expect(box(thinSketches(s, { thickness: 2, thickness2: 0, midPlane: true }))).toEqual([0, -1, 40, 1]);
    expect(box(thinSketches(s, { thickness: 2, thickness2: 3 }))).toEqual([0, -3, 40, 2]);
  });

  it("keeps an L's corner sharp (mitred), so a centred wall's area is its length × thickness", () => {
    const s = sketch({ a: [0, 0], b: [40, 0], c: [40, 30] }, [line("l1", "a", "b"), line("l2", "b", "c")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0, midPlane: true });
    expect(wallArea(pieces)).toBeCloseTo(140, 9);
    // Six corners: two square ends of two corners each, plus the sharp outside and inside corners.
    expect(pieces[0].curves.filter((c) => c.id.startsWith("thin:"))).toHaveLength(6);
    expect(box(pieces)).toEqual([0, -1, 41, 30]);
    // All on one side: the area changes by the corner square.
    const one = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(wallArea(one)).toBeCloseTo(70 * 2 - 4, 9);
  });

  it("makes a closed rectangle into a ring: inside by default, outside when flipped", () => {
    const s = sketch({ a: [0, 0], b: [40, 0], c: [40, 20], d: [0, 20] }, [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "c", "d"), line("l4", "d", "a")]);
    const inside = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(wallArea(inside)).toBeCloseTo(800 - 36 * 16, 9);
    expect(box(inside)).toEqual([0, 0, 40, 20]);
    const outside = thinSketches(s, { thickness: 2, thickness2: 0, flip: true });
    expect(wallArea(outside)).toBeCloseTo(44 * 24 - 800, 9);
    expect(box(outside)).toEqual([-2, -2, 42, 22]);
    const both = thinSketches(s, { thickness: 2, thickness2: 0, midPlane: true });
    expect(wallArea(both)).toBeCloseTo(42 * 22 - 38 * 18, 9);
  });

  it("keeps arcs as arcs and circles as circles", () => {
    const circle = sketch({ o: [5, 5] }, [{ id: "c", type: "circle", center: "o", radius: 10, construction: false }]);
    const ring = thinSketches(circle, { thickness: 2, thickness2: 0, midPlane: true });
    expect(ring[0].curves.filter((c) => c.type === "circle" && c.id.startsWith("thin:")).map((c) => (c as { radius: number }).radius).sort()).toEqual([11, 9]);
    expect(wallArea(ring)).toBeCloseTo(Math.PI * (121 - 81), 0);
    // A half circle: an arc of a ring, its ends square.
    const half = sketch({ o: [0, 0], s: [10, 0], e: [-10, 0] }, [{ id: "a", type: "arc", center: "o", start: "s", end: "e", construction: false }]);
    const band = thinSketches(half, { thickness: 2, thickness2: 0, midPlane: true });
    expect(band[0].curves.filter((c) => c.type === "arc" && c.id.startsWith("thin:"))).toHaveLength(2);
    expect(wallArea(band)).toBeCloseTo((Math.PI * (121 - 81)) / 2, 0);
    const loops = thinLoops([{ kind: "arc", from: [10, 0], mid: [0, 10], to: [-10, 0] }], false, [1, 1]);
    expect(loopArea(loops[0])).toBeCloseTo((Math.PI * (121 - 81)) / 2, 9);
  });

  it("joins a line and a tangent arc smoothly (no extra corner)", () => {
    // A J: down a line, then round a half circle.
    const loops = thinLoops([{ kind: "line", from: [0, 20], to: [0, 0] }, { kind: "arc", from: [0, 0], mid: [5, -5], to: [10, 0] }], false, [1, 1]);
    if (!("prims" in loops[0])) throw new Error("expected pieces");
    // line, arc, end, arc back, line back, end.
    expect(loops[0].prims.map((p) => p.kind)).toEqual(["line", "arc", "line", "arc", "line", "line"]);
    expect(loopArea(loops[0])).toBeCloseTo(2 * (20 + Math.PI * 5), 9);
  });

  it("refuses walls too thick for the shape, splines, and nothing drawn, in plain words", () => {
    const circle = sketch({ o: [0, 0] }, [{ id: "c", type: "circle", center: "o", radius: 3, construction: false }]);
    expect(() => thinSketches(circle, { thickness: 4, thickness2: 0 })).toThrow(/too thick for a circle/);
    const s = sketch({ a: [0, 0], b: [10, 0], c: [10, 4], d: [0, 4] }, [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "c", "d"), line("l4", "d", "a")]);
    expect(() => thinSketches(s, { thickness: 3, thickness2: 0 })).toThrow(/too thick/);
    const spline = sketch({ a: [0, 0], b: [5, 5], c: [10, 0] }, [{ id: "s", type: "spline", points: ["a", "b", "c"], closed: false } as SketchCurve]);
    expect(() => thinSketches(spline, { thickness: 1, thickness2: 0 })).toThrow(/splines/);
    const onlyConstruction = sketch({ a: [0, 0], b: [10, 0] }, [line("l", "a", "b", true)]);
    expect(() => thinSketches(onlyConstruction, { thickness: 1, thickness2: 0 })).toThrow(/no lines/);
    expect(() => thinSketches(s, { thickness: 0, thickness2: 0 })).toThrow(/thickness/);
  });

  it("leaves a revolve's axis line out of the wall but keeps it in the sketch", () => {
    const s = sketch({ a: [0, -10], b: [0, 10], c: [10, 0], d: [10, 20] }, [line("axis", "a", "b"), line("l", "c", "d")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 }, { keep: "axis" });
    expect(pieces).toHaveLength(1);
    expect(pieces[0].curves.find((c) => c.id === "axis")?.construction).toBe(true);
    expect(wallArea(pieces)).toBeCloseTo(40, 9);
  });

  it("makes separate walls for separate runs, and for each line at a junction", () => {
    const s = sketch({ a: [0, 0], b: [10, 0], c: [0, 5], d: [10, 5] }, [line("l1", "a", "b"), line("l2", "c", "d")]);
    expect(thinSketches(s, { thickness: 1, thickness2: 0 })).toHaveLength(2);
    const t = sketch({ a: [0, 0], b: [10, 0], c: [20, 0], d: [10, 10] }, [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "b", "d")]);
    expect(thinSketches(t, { thickness: 1, thickness2: 0 })).toHaveLength(3);
  });
});

/** Every corner of the wall's outlines (lines' ends), from all the pieces. */
function corners(pieces: SketchData[]): [number, number][] {
  return pieces.flatMap((p) => {
    const ids = new Set(p.curves.filter((c) => c.id.startsWith("thin:")).flatMap((c) => (c.type === "line" ? [c.p1, c.p2] : c.type === "arc" ? [c.start, c.end] : [])));
    return p.points.filter((q) => ids.has(q.id)).map((q) => [q.x, q.y] as [number, number]);
  });
}
const rect = (w: number, h: number): Record<string, [number, number]> => ({ a: [0, 0], b: [w, 0], c: [w, h], d: [0, h] });
const rectLines = () => [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "c", "d"), line("l4", "d", "a")];

describe("thin walls at junctions (pure)", () => {
  it("keeps a rectangle whole when a short line hangs off a corner (it's still one closed shape)", () => {
    const s = sketch({ ...rect(40, 20), t: [-5, 0] }, [...rectLines(), line("t", "t", "a")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(pieces).toHaveLength(2);
    // The rectangle comes back as a ring (outer + inner loop), the short line as a strip.
    expect(wallArea([pieces[0]]) + wallArea([pieces[1]])).toBeCloseTo(224 + 10, 9);
  });

  it("chains through points where only two curves meet, splitting only at real junctions", () => {
    // A rectangle with a diagonal: junctions at two corners only — two L-shaped runs and the diagonal.
    const s = sketch(rect(40, 20), [...rectLines(), line("dg", "a", "c")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(pieces).toHaveLength(3);
    // Every wall stays inside the rectangle: the L's walls go inwards (the side with the shape), and the diagonal's
    // ends are cut to meet them rather than poking out past the edges.
    for (const [x, y] of corners(pieces)) {
      expect(x).toBeGreaterThan(-1e-9);
      expect(x).toBeLessThan(40 + 1e-9);
      expect(y).toBeGreaterThan(-1e-9);
      expect(y).toBeLessThan(20 + 1e-9);
    }
  });

  it("turns a house's walls into the rooms: the shared line between them goes up into the roof", () => {
    const s = sketch({ ...rect(40, 30), r: [20, 45] }, [...rectLines(), line("r1", "d", "r"), line("r2", "r", "c")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(pieces).toHaveLength(3);
    for (const [x, y] of corners(pieces)) {
      expect(x).toBeGreaterThan(-1e-9);
      expect(x).toBeLessThan(40 + 1e-9);
      expect(y).toBeGreaterThan(-1e-9);
      // Never above the roof line.
      expect(y).toBeLessThan(30 + 0.75 * Math.min(x, 40 - x) + 1e-6);
    }
  });

  it("cuts very sharp outside corners off square, MITRE_LIMIT × the thickness out", () => {
    // A narrow V: 10° between its arms.
    const ang = (10 * Math.PI) / 180;
    const s = sketch({ a: [100, 0], b: [0, 0], c: [100 * Math.cos(ang), 100 * Math.sin(ang)] }, [line("l1", "a", "b"), line("l2", "b", "c")]);
    const pieces = thinSketches(s, { thickness: 1, thickness2: 0, midPlane: true });
    // How far past the corner, measured along the line halfway between the arms (away from them).
    const half = ang / 2;
    const reach = Math.max(...corners(pieces).map(([x, y]) => -(x * Math.cos(half) + y * Math.sin(half))));
    expect(reach).toBeLessThan(MITRE_LIMIT * 0.5 + 1e-6);
    expect(reach).toBeGreaterThan(0);
  });
});

describe("thin walls round picked areas (pure)", () => {
  // A 40 × 20 plate with a hole of radius 5 at (20, 10).
  const plate = sketch({ ...rect(40, 20), o: [20, 10] }, [...rectLines(), { id: "h", type: "circle", center: "o", radius: 5, construction: false }]);
  const map = sketchAreas(plate);
  const pickAt = (x: number, y: number) => pickOf(map.areas[map.areaAt([x, y])]);

  it("goes round a picked area's outline and its holes, into the area", () => {
    const pieces = thinSketches(plate, { thickness: 2, thickness2: 0 }, { areas: [pickAt(2, 2)] });
    expect(pieces).toHaveLength(2);
    // The plate's edge inwards, the hole's edge outwards (into the plate).
    expect(wallArea(pieces)).toBeCloseTo(224 + Math.PI * (49 - 25), 0);
  });

  it("goes round just the hole when that's the area picked", () => {
    const pieces = thinSketches(plate, { thickness: 2, thickness2: 0 }, { areas: [pickAt(20, 10)] });
    expect(pieces).toHaveLength(1);
    expect(wallArea(pieces)).toBeCloseTo(Math.PI * (25 - 9), 0);
  });

  it("says when a picked area has gone", () => {
    expect(() => thinSketches(plate, { thickness: 1, thickness2: 0 }, { areas: [[100, 100, 5, "zz+"]] })).toThrow(/area/);
  });
});

describe("thin revolves and two-way revolves (pure)", () => {
  it("leaves out lines lying on the sketch's own axis", () => {
    const s = sketch({ a: [0, 0], b: [0, 20], c: [10, 0], d: [10, 20] }, [line("onAxis", "a", "b"), line("l", "c", "d")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 }, { keep: "vertical", axis: { at: [0, 0], dir: [0, 1] } });
    expect(pieces).toHaveLength(1);
    expect(wallArea(pieces)).toBeCloseTo(40, 9);
  });

  it("keeps two ways within a full turn: a new revolve's 360° becomes 180° + 90°", () => {
    const fresh = { revolve: { axis: "vertical", flip: false }, params: { angle: "360", angle2: "90" } };
    expect(revolveWay(fresh, "two")).toEqual({ revolve: { axis: "vertical", flip: false, second: true }, params: { angle: "180" } });
    // Already fits: left alone. Symmetric / one way: no second angle.
    expect(revolveWay({ ...fresh, params: { angle: "90", angle2: "45" } }, "two").params).toEqual({});
    expect(revolveWay({ ...fresh, revolve: { ...fresh.revolve, second: true } }, "symmetric").revolve).toEqual({ axis: "vertical", flip: false, symmetric: true });
    expect(revolveWay({ ...fresh, revolve: { ...fresh.revolve, symmetric: true } }, "one").revolve).toEqual({ axis: "vertical", flip: false });
    // A big second angle comes down too.
    expect(revolveWay({ ...fresh, params: { angle: "300", angle2: "270" } }, "two").params).toEqual({ angle: "180", angle2: "90" });
  });
});

describe("thin walls and the areas other features use", () => {
  it("doesn't mark the sketch's areas as taken, so a later Extrude (a floor inside the wall) starts with them", () => {
    const s = sketch(rect(40, 20), rectLines());
    const sk: Feature = { id: "s1", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: s } };
    const wall: Feature = { id: "e1", name: "Extrude 1", type: "extrude", operation: "new", suppressed: false, params: { depth: "10" }, sketchRef: "s1", extrude: { end: "blind", flip: false }, thin: {} };
    expect(areasTaken([sk, wall], "s1", s).size).toBe(0);
    expect(freeAreas([sk, wall], "s1", s)).toBeUndefined();
    // A solid extrude still takes them.
    expect(areasTaken([sk, { ...wall, thin: undefined }], "s1", s).size).toBe(1);
  });
});
