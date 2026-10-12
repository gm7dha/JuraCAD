import { describe, expect, it } from "vitest";

import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { ORIGIN_ID, type SketchConstraint, type SketchData } from "../src/sketch/types";

let k = 0;
const c = (type: SketchConstraint["type"], refs: string[], extra: Partial<SketchConstraint> = {}): SketchConstraint => ({
  id: `c${++k}`,
  type,
  refs,
  ...extra,
});

/** A rough, slightly wonky rectangle: 4 points, 4 lines, nothing constrained yet. */
function roughRectangle(): SketchData {
  return {
    points: [
      { id: "a", x: 0.3, y: -0.2 },
      { id: "b", x: 41, y: 0.4 },
      { id: "c", x: 39.5, y: 29 },
      { id: "d", x: -0.4, y: 31 },
    ],
    curves: [
      { id: "ab", type: "line", p1: "a", p2: "b", construction: false },
      { id: "bc", type: "line", p1: "b", p2: "c", construction: false },
      { id: "cd", type: "line", p1: "c", p2: "d", construction: false },
      { id: "da", type: "line", p1: "d", p2: "a", construction: false },
    ],
    constraints: [],
  };
}

const pt = (s: SketchData, id: string) => s.points.find((p) => p.id === id)!;

describe("sketch solver", () => {
  it("squares up a rectangle with horizontal/vertical constraints and dimensions", () => {
    const s = roughRectangle();
    s.constraints = [
      c("horizontal", ["ab"]),
      c("horizontal", ["cd"]),
      c("vertical", ["bc"]),
      c("vertical", ["da"]),
      c("coincident", ["a", ORIGIN_ID]),
      c("length", ["ab"], { value: "40" }),
      c("length", ["bc"], { value: "15 * 2" }),
    ];
    const r = solveSketch(s);
    expect(r.ok).toBe(true);
    expect(pt(r.sketch, "a").x).toBeCloseTo(0, 6);
    expect(pt(r.sketch, "a").y).toBeCloseTo(0, 6);
    expect(pt(r.sketch, "b").x).toBeCloseTo(40, 6);
    expect(pt(r.sketch, "c").y).toBeCloseTo(30, 6);
    expect(pt(r.sketch, "d").x).toBeCloseTo(0, 6);

    const a = analyzeSketch(r.sketch);
    expect(a.freedom).toBe(0);
    expect(a.definedCurves.size).toBe(4);
  });

  it("counts remaining freedom and which geometry is still free", () => {
    const s = roughRectangle();
    s.constraints = [
      c("horizontal", ["ab"]),
      c("horizontal", ["cd"]),
      c("vertical", ["bc"]),
      c("vertical", ["da"]),
    ];
    const r = solveSketch(s);
    expect(r.ok).toBe(true);
    // A free rectangle can move (2) and stretch (2).
    const a = analyzeSketch(r.sketch);
    expect(a.freedom).toBe(4);
    expect(a.definedCurves.size).toBe(0);

    // Pin one corner: only the size is free, the pinned corner is defined.
    r.sketch.constraints.push(c("coincident", ["a", ORIGIN_ID]));
    const pinned = analyzeSketch(solveSketch(r.sketch).sketch);
    expect(pinned.freedom).toBe(2);
    expect(pinned.definedPoints.has("a")).toBe(true);
    expect(pinned.definedPoints.has("c")).toBe(false);
  });

  it("detects rotation as a remaining freedom", () => {
    const s: SketchData = {
      points: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 1 },
      ],
      curves: [{ id: "l", type: "line", p1: "a", p2: "b", construction: false }],
      constraints: [c("coincident", ["a", ORIGIN_ID]), c("length", ["l"], { value: "10" })],
    };
    const a = analyzeSketch(solveSketch(s).sketch);
    expect(a.freedom).toBe(1);
    expect(a.definedPoints.has("a")).toBe(true);
    expect(a.definedPoints.has("b")).toBe(false);
  });

  it("handles circles: radius, diameter, tangent, concentric, equal", () => {
    const s: SketchData = {
      points: [
        { id: "c1", x: 1, y: 2 },
        { id: "c2", x: 30, y: 1 },
        { id: "l1", x: -20, y: -11 },
        { id: "l2", x: 50, y: -9 },
      ],
      curves: [
        { id: "k1", type: "circle", center: "c1", radius: 7, construction: false },
        { id: "k2", type: "circle", center: "c2", radius: 4, construction: false },
        { id: "base", type: "line", p1: "l1", p2: "l2", construction: false },
      ],
      constraints: [
        c("coincident", ["c1", ORIGIN_ID]),
        c("diameter", ["k1"], { value: "20" }),
        c("equal", ["k1", "k2"]),
        c("horizontal", ["base"]),
        c("tangent", ["base", "k1"]),
        c("tangent", ["base", "k2"]),
        c("tangent", ["k1", "k2"], { extra: [0] }),
      ],
    };
    const r = solveSketch(s);
    expect(r.ok).toBe(true);
    const k1 = r.sketch.curves.find((x) => x.id === "k1") as { radius: number };
    const k2 = r.sketch.curves.find((x) => x.id === "k2") as { radius: number };
    expect(k1.radius).toBeCloseTo(10, 6);
    expect(k2.radius).toBeCloseTo(10, 6);
    // Line tangent below both circles, circles touching: centres 20 apart.
    expect(Math.abs(pt(r.sketch, "l1").y)).toBeCloseTo(10, 6);
    const d = Math.hypot(pt(r.sketch, "c2").x - 0, pt(r.sketch, "c2").y - 0);
    expect(d).toBeCloseTo(20, 6);
  });

  it("keeps arc ends on the same radius", () => {
    const s: SketchData = {
      points: [
        { id: "o", x: 0, y: 0 },
        { id: "s", x: 10, y: 0 },
        { id: "e", x: 0, y: 12 },
      ],
      curves: [{ id: "arc", type: "arc", center: "o", start: "s", end: "e", construction: false }],
      constraints: [c("coincident", ["o", ORIGIN_ID]), c("radius", ["arc"], { value: "15" })],
    };
    const r = solveSketch(s);
    expect(r.ok).toBe(true);
    expect(Math.hypot(pt(r.sketch, "s").x, pt(r.sketch, "s").y)).toBeCloseTo(15, 6);
    expect(Math.hypot(pt(r.sketch, "e").x, pt(r.sketch, "e").y)).toBeCloseTo(15, 6);
  });

  it("sets angles, parallels, perpendiculars, midpoints and point-on-line", () => {
    const s: SketchData = {
      points: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 0.5 },
        { id: "c", x: 0, y: 0 },
        { id: "d", x: 8, y: 7 },
        { id: "e", x: 3, y: 4 },
        { id: "f", x: 9, y: 4.5 },
        { id: "m", x: 4, y: 1 },
      ],
      curves: [
        { id: "ab", type: "line", p1: "a", p2: "b", construction: false },
        { id: "cd", type: "line", p1: "c", p2: "d", construction: false },
        { id: "ef", type: "line", p1: "e", p2: "f", construction: false },
      ],
      constraints: [
        c("coincident", ["a", ORIGIN_ID]),
        c("coincident", ["c", ORIGIN_ID]),
        c("horizontal", ["ab"]),
        c("angle", ["ab", "cd"], { value: "30", extra: [1] }),
        c("parallel", ["ef", "cd"]),
        c("midpoint", ["m", "ab"]),
        c("pointOnLine", ["e", "cd"]),
      ],
    };
    const r = solveSketch(s);
    expect(r.ok).toBe(true);
    const d = pt(r.sketch, "d");
    expect((Math.atan2(d.y, d.x) * 180) / Math.PI).toBeCloseTo(30, 5);
    const e = pt(r.sketch, "e");
    const f = pt(r.sketch, "f");
    expect((Math.atan2(f.y - e.y, f.x - e.x) * 180) / Math.PI).toBeCloseTo(30, 5);
    expect((Math.atan2(e.y, e.x) * 180) / Math.PI).toBeCloseTo(30, 5);
    expect(pt(r.sketch, "m").x).toBeCloseTo(pt(r.sketch, "b").x / 2, 6);

    // Perpendicular instead of the angle.
    const p = solveSketch({
      ...r.sketch,
      constraints: r.sketch.constraints.filter((x) => x.type !== "angle").concat(c("perpendicular", ["ab", "cd"])),
    });
    expect(p.ok).toBe(true);
    expect(pt(p.sketch, "d").x).toBeCloseTo(0, 6);
  });

  it("drags a point while keeping constraints, moving other geometry as little as possible", () => {
    const s = roughRectangle();
    s.constraints = [
      c("horizontal", ["ab"]),
      c("horizontal", ["cd"]),
      c("vertical", ["bc"]),
      c("vertical", ["da"]),
      c("coincident", ["a", ORIGIN_ID]),
    ];
    const settled = solveSketch(s).sketch;
    const r = solveSketch(settled, { drag: { pointId: "c", x: 60, y: 45 } });
    expect(r.ok).toBe(true);
    expect(pt(r.sketch, "c").x).toBeCloseTo(60, 4);
    expect(pt(r.sketch, "c").y).toBeCloseTo(45, 4);
    expect(pt(r.sketch, "a").x).toBeCloseTo(0, 6);
    expect(pt(r.sketch, "b").x).toBeCloseTo(60, 4);
    expect(pt(r.sketch, "d").y).toBeCloseTo(45, 4);
  });

  it("can't drag a fully defined point away", () => {
    const s: SketchData = {
      points: [{ id: "p", x: 5, y: 5 }],
      curves: [],
      constraints: [c("fix", ["p"], { extra: [5, 5] })],
    };
    const r = solveSketch(s, { drag: { pointId: "p", x: 50, y: 50 } });
    expect(r.ok).toBe(true);
    expect(pt(r.sketch, "p").x).toBeCloseTo(5, 6);
  });

  it("reports conflicts instead of pretending", () => {
    const s = roughRectangle();
    s.constraints = [
      c("horizontal", ["ab"]),
      c("vertical", ["ab"]),
      c("length", ["ab"], { value: "10" }),
    ];
    const r = solveSketch(s);
    expect(r.ok).toBe(false);
    expect(r.failing.length).toBeGreaterThan(0);
  });

  it("skips dimensions whose value can't be read", () => {
    const s = roughRectangle();
    const bad = c("length", ["ab"], { value: "oops" });
    s.constraints = [bad];
    const r = solveSketch(s);
    expect(r.ok).toBe(false);
    expect(r.skipped.has(bad.id)).toBe(true);
  });
});
