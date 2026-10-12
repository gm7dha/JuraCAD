import { describe, expect, it } from "vitest";

import { findRegions } from "../src/sketch/regions";
import type { SketchData } from "../src/sketch/types";

function rect(prefix: string, x0: number, y0: number, w: number, h: number, construction = false): SketchData {
  const ids = ["a", "b", "c", "d"].map((n) => `${prefix}${n}`);
  const pos = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
  return {
    points: ids.map((id, i) => ({ id, x: pos[i][0], y: pos[i][1] })),
    curves: ids.map((id, i) => ({ id: `${prefix}l${i}`, type: "line" as const, p1: id, p2: ids[(i + 1) % 4], construction })),
    constraints: [],
  };
}

const merge = (...parts: SketchData[]): SketchData => ({
  points: parts.flatMap((p) => p.points),
  curves: parts.flatMap((p) => p.curves),
  constraints: [],
});

const circle = (id: string, x: number, y: number, r: number): SketchData => ({
  points: [{ id: `${id}c`, x, y }],
  curves: [{ id, type: "circle", center: `${id}c`, radius: r, construction: false }],
  constraints: [],
});

describe("closed shapes", () => {
  it("finds a rectangle", () => {
    const r = findRegions(rect("r", 0, 0, 40, 30));
    expect(r.problems).toEqual([]);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].outer.segments).toHaveLength(4);
    expect(r.regions[0].outer.area).toBeCloseTo(1200, 6);
    expect(r.regions[0].holes).toHaveLength(0);
  });

  it("turns a circle inside a rectangle into a hole", () => {
    const r = findRegions(merge(rect("r", 0, 0, 40, 30), circle("k", 20, 15, 5)));
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].holes).toHaveLength(1);
    expect(r.regions[0].holes[0].segments[0].kind).toBe("circle");
  });

  it("treats a shape inside a hole as a separate island", () => {
    const r = findRegions(merge(rect("o", 0, 0, 100, 100), rect("h", 20, 20, 60, 60), circle("k", 50, 50, 10)));
    expect(r.regions).toHaveLength(2);
    const big = r.regions.find((x) => x.outer.area > 5000)!;
    expect(big.holes).toHaveLength(1);
    const island = r.regions.find((x) => x.outer.area < 5000)!;
    expect(island.outer.segments[0].kind).toBe("circle");
  });

  it("keeps separate shapes separate", () => {
    const r = findRegions(merge(rect("a", 0, 0, 10, 10), rect("b", 50, 0, 10, 10)));
    expect(r.regions).toHaveLength(2);
  });

  it("joins lines and arcs into a slot", () => {
    // Slot: two straight sides and two semicircular ends (arcs run anticlockwise).
    const s: SketchData = {
      points: [
        { id: "p1", x: 0, y: -5 },
        { id: "p2", x: 30, y: -5 },
        { id: "p3", x: 30, y: 5 },
        { id: "p4", x: 0, y: 5 },
        { id: "c1", x: 30, y: 0 },
        { id: "c2", x: 0, y: 0 },
      ],
      curves: [
        { id: "bottom", type: "line", p1: "p1", p2: "p2", construction: false },
        { id: "right", type: "arc", center: "c1", start: "p2", end: "p3", construction: false },
        { id: "top", type: "line", p1: "p3", p2: "p4", construction: false },
        { id: "left", type: "arc", center: "c2", start: "p4", end: "p1", construction: false },
      ],
      constraints: [],
    };
    const r = findRegions(s);
    expect(r.problems).toEqual([]);
    expect(r.regions).toHaveLength(1);
    const kinds = r.regions[0].outer.segments.map((x) => x.kind).sort();
    expect(kinds).toEqual(["arc", "arc", "line", "line"]);
    // 30 × 10 rectangle plus a full circle of radius 5.
    expect(r.regions[0].outer.area).toBeCloseTo(300 + Math.PI * 25, 0);
    const arc = r.regions[0].outer.segments.find((x) => x.kind === "arc")!;
    if (arc.kind === "arc") expect(Math.hypot(arc.mid[0] - 30, arc.mid[1]) || Math.hypot(arc.mid[0], arc.mid[1])).toBeCloseTo(5, 6);
  });

  it("ignores construction geometry and explains open shapes", () => {
    const open = rect("o", 0, 0, 10, 10);
    open.curves.pop(); // remove one side
    const r = findRegions(merge(rect("c", 0, 0, 50, 50, true), open));
    expect(r.regions).toHaveLength(0);
    expect(r.problems[0]).toMatch(/isn't closed/);
  });

  it("joins lines whose ends are separate points in the same place", () => {
    const s = rect("r", 0, 0, 10, 10);
    // Give the last line its own copy of the first corner.
    s.points.push({ id: "copy", x: 0, y: 0 });
    (s.curves[3] as { p2: string }).p2 = "copy";
    const r = findRegions(s);
    expect(r.regions).toHaveLength(1);
  });
});
