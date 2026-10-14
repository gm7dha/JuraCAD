import { describe, expect, it } from "vitest";

import { nestContours, polygonArea, textOutlines, type TypefaceFont } from "../src/geometry/text";
import { FONTS } from "../src/kernel/textSolid";

/** A tiny made-up font: "I" is a bar, "O" a square ring, "D" a curved shape. */
const font: TypefaceFont = {
  resolution: 100,
  boundingBox: { yMin: 0, yMax: 100 },
  glyphs: {
    I: { ha: 40, o: "m 10 0 l 30 0 l 30 100 l 10 100" },
    O: { ha: 100, o: "m 0 0 l 90 0 l 90 100 l 0 100 m 30 30 l 30 70 l 60 70 l 60 30" },
    D: { ha: 80, o: "m 0 0 q 0 100 70 50 l 0 100" },
    "?": { ha: 50, o: "m 0 0 l 40 0 l 20 50" },
    " ": { ha: 30 },
  },
};

describe("text outlines", () => {
  it("lays letters out along the line at the chosen size", () => {
    const { contours, width } = textOutlines(font, "IO", 10);
    expect(width).toBeCloseTo(14, 9);
    expect(contours).toHaveLength(3);
    // The bar: 2 mm wide (x 1…3), 10 mm tall.
    expect(contours[0]).toEqual([
      [1, 0],
      [3, 0],
      [3, 10],
      [1, 10],
    ]);
    // The O starts after the I's advance (4 mm).
    expect(contours[1][0]).toEqual([4, 0]);
  });

  it("smooths curves, and uses ? for letters the font doesn't have", () => {
    const d = textOutlines(font, "D", 10, 8).contours[0];
    // Start, eight steps along the curve; the line back to the curve's end repeats a point, so it's dropped.
    expect(d.length).toBe(1 + 8);
    expect(textOutlines(font, "Z", 10).contours).toHaveLength(1);
    expect(textOutlines(font, "  ", 10).contours).toHaveLength(0);
  });

  it("puts each line of text below the last", () => {
    const { contours, height } = textOutlines(font, "I\nI", 10);
    expect(contours[1][0][1]).toBeCloseTo(-10, 9);
    expect(height).toBeCloseTo(20, 9);
  });

  it("finds the holes in letters", () => {
    const shapes = nestContours(textOutlines(font, "OI", 10).contours);
    expect(shapes).toHaveLength(2);
    const o = shapes.find((s) => s.holes.length === 1)!;
    expect(Math.abs(polygonArea(o.outer))).toBeCloseTo(90, 9);
    expect(Math.abs(polygonArea(o.holes[0]))).toBeCloseTo(12, 9);
  });

  it("reads the real fonts", () => {
    for (const f of [FONTS.regular, FONTS.bold]) {
      const shapes = nestContours(textOutlines(f, "Ag8", 10).contours);
      // A has one hole, g one (or two), 8 two.
      expect(shapes.length).toBe(3);
      expect(shapes.reduce((n, s) => n + s.holes.length, 0)).toBeGreaterThanOrEqual(4);
    }
  });
});
