import { describe, expect, it } from "vitest";
import { buildSketch } from "../src/mcp/sketchShapes";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch } from "../src/sketch/solver";

const area = (s: ReturnType<typeof buildSketch>) => findRegions(s.data).regions.reduce((a, r) => a + r.outer.area - r.holes.reduce((h, l) => h + l.area, 0), 0);

describe("sketch shapes for Claude", () => {
  it("makes a fully defined rectangle at the origin with holes", () => {
    const s = buildSketch(
      [
        { type: "rectangle", corner: [0, 0], width: 60, height: 40 },
        { type: "circle", center: [5, 5], diameter: 4.5 },
      ],
      {},
    );
    expect(s.freedom).toBe(0);
    expect(analyzeSketch(s.data).freedom).toBe(0);
    expect(area(s)).toBeCloseTo(2400 - Math.PI * 2.25 * 2.25, -1);
    const dims = s.data.constraints.filter((c) => c.value !== undefined).map((c) => `${c.type}=${c.value}`);
    expect(dims).toContain("length=60");
    expect(dims).toContain("length=40");
    expect(dims).toContain("diameter=4.5");
  });

  it("keeps sizes typed as maths, and measures negative positions the other way", () => {
    const s = buildSketch([{ type: "rectangle", center: [-10, 0], width: "20 + 5", height: 10 }], {});
    expect(s.freedom).toBe(0);
    const xs = s.data.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-22.5, 6);
    expect(Math.max(...xs)).toBeCloseTo(2.5, 6);
    expect(s.data.constraints.some((c) => c.value === "20 + 5")).toBe(true);
    const h = s.data.constraints.find((c) => c.type === "horizontalDistance")!;
    expect(h.value).toBe("10");
    expect(h.extra).toEqual([-1]);
  });

  it("joins an outline's corners and an arc that meet, into one closed area", () => {
    const s = buildSketch(
      [
        { type: "outline", points: [[0, 10], [0, 0], [20, 0], [20, 10]], closed: false },
        { type: "arc", center: [10, 10], radius: 10, start_angle: 0, end_angle: 180 },
      ],
      {},
    );
    expect(findRegions(s.data).regions).toHaveLength(1);
    expect(area(s)).toBeCloseTo(200 + (Math.PI * 100) / 2, -1);
    expect(s.freedom).toBe(0);
  });

  it("makes slots, polygons, lines and points fully defined", () => {
    const s = buildSketch(
      [
        { type: "slot", from: [0, 0], to: [20, 0], width: 6 },
        { type: "polygon", center: [50, 0], sides: 6, diameter: 10, across: "flats" },
        { type: "line", from: [0, 20], to: [30, 25], construction: true },
        { type: "point", at: [40, 30] },
      ],
      {},
    );
    expect(s.freedom).toBe(0);
    expect(area(s)).toBeCloseTo(20 * 6 + Math.PI * 9 + (Math.sqrt(3) / 2) * 100, -1);
  });

  it("explains bad shapes in plain English", () => {
    expect(() => buildSketch([], {})).toThrow(/shapes is missing/);
    expect(() => buildSketch([{ type: "square", width: 3 }], {})).toThrow(/must be one of "rectangle"/);
    expect(() => buildSketch([{ type: "circle", center: [0, 0], diameter: -2 }], {})).toThrow(/diameter must be more than 0/);
    expect(() => buildSketch([{ type: "circle", center: [0], diameter: 2 }], {})).toThrow(/should be a point \[x, y\]/);
    expect(() => buildSketch([{ type: "circle", center: [0, 0], radius: 2 }], {})).toThrow(/"radius" isn't a setting here.*diameter/);
    expect(() => buildSketch([{ type: "rectangle", corner: [0, 0], center: [1, 1], width: 1, height: 1 }], {})).toThrow(/either "corner"/);
    expect(() => buildSketch([{ type: "circle", center: [0, 0], diameter: "wide" }], {})).toThrow(/can't be worked out/);
  });

  it("uses the design's variables", () => {
    const s = buildSketch([{ type: "circle", center: [0, 0], diameter: "d" }], { d: 12 });
    expect(s.data.curves[0].type === "circle" && s.data.curves[0].radius).toBeCloseTo(6, 9);
    expect(s.freedom).toBe(0);
  });
});
