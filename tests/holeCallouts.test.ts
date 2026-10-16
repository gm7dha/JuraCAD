import { describe, expect, it } from "vitest";

import type { ViewHole, ViewProjection } from "../src/kernel/protocol";
import { autoDimensions } from "../src/drawing/autoDimension";
import { drawDimension } from "../src/drawing/dimensions";
import { parseDrawings } from "../src/drawing/drawing";
import { calloutLines, calloutText, holeOfCircle, matchingHoles, threadSymbols } from "../src/drawing/holeCallouts";
import type { Dimension } from "../src/model/types";

const hole = (cx: number, cy: number, over: Partial<ViewHole> = {}): ViewHole => ({ cx, cy, d: 6.6, through: true, depth: 20, ...over });

/** A 60 × 40 plate seen from the top, with the given holes (and their circles). */
function plate(holes: ViewHole[]): ViewProjection {
  const circles = holes.flatMap((h) =>
    [h.d, h.cbore?.diameter, h.csk?.diameter].filter((d): d is number => !!d).map((d) => ({ cx: h.cx, cy: h.cy, r: d / 2, hidden: false, full: true })),
  );
  const outline = [0, 0, 60, 0, 60, 40, 0, 40, 0, 0];
  return { kind: "top", visible: [outline], hidden: [], circles, points: [0, 0, 60, 0, 60, 40, 0, 40], bounds: [0, 0, 60, 40], holes };
}

describe("hole callouts", () => {
  it("describes plain, blind, counterbored, countersunk and tapped holes", () => {
    expect(calloutLines(hole(0, 0), 4, [])).toEqual(["4× Ø6.6 THRU"]);
    expect(calloutLines(hole(0, 0, { d: 5, through: false, depth: 12 }), 1, [])).toEqual(["Ø5 × 12 DEEP"]);
    expect(calloutLines(hole(0, 0, { cbore: { diameter: 11, depth: 6.4 } }), 2, [])).toEqual(["2× Ø6.6 THRU", "CBORE Ø11 × 6.4 DEEP"]);
    expect(calloutLines(hole(0, 0, { csk: { diameter: 12.6, angle: 90.0001 } }), 1, [])).toEqual(["Ø6.6 THRU", "CSK Ø12.6 × 90°"]);
    expect(calloutLines(hole(0, 0, { d: 5, through: false, depth: 10 }), 1, [{ drill: 5, thread: "M6 × 1", major: 6 }])).toEqual(["Ø5 × 10 DEEP", "M6 × 1 TAP"]);
  });

  it("counts matching holes and knows a hole's circles", () => {
    const p = plate([hole(10, 10), hole(50, 10), hole(30, 30, { cbore: { diameter: 11, depth: 6.4 } })]);
    expect(matchingHoles(p, p.holes![0])).toBe(2);
    expect(matchingHoles(p, p.holes![2])).toBe(1);
    expect(holeOfCircle(p, [30, 30], 5.5)).toBe(p.holes![2]);
    expect(holeOfCircle(p, [30, 30], 4)).toBe(null);
    expect(calloutText(p, [50, 10], [])).toEqual(["2× Ø6.6 THRU"]);
    expect(calloutText(p, [20, 20], [])).toBe(null);
  });

  it("stacks the lines above the leader", () => {
    const dim: Dimension = { id: "d", view: "top", type: "diameter", callout: true, a: { at: [0, 0], rel: [0, 0] }, r: 3.3, offset: 8, angle: 0, suffix: " TYP" };
    const drawn = drawDimension(dim, { a: [0, 0], r: 3.3, found: true }, (q) => q, 6.6, ["Ø6.6 THRU", "CBORE Ø11 × 6.4 DEEP"]);
    const texts = drawn.prims.filter((x): x is Extract<typeof x, { kind: "text" }> => x.kind === "text");
    expect(texts.map((t) => t.text)).toEqual(["Ø6.6 THRU", "CBORE Ø11 × 6.4 DEEP TYP"]);
    expect(texts[0].y).toBeGreaterThan(texts[1].y);
  });

  it("auto dimension gives each kind of hole one callout", () => {
    const p = plate([hole(10, 10), hole(50, 10), hole(30, 30, { cbore: { diameter: 11, depth: 6.4 } })]);
    let n = 0;
    const dims = autoDimensions({ top: p }, ["top"], [], 1, () => `d${++n}`);
    const callouts = dims.filter((d) => d.callout);
    expect(callouts).toHaveLength(2);
    // No separate diameter for the counterbore's circle.
    expect(dims.filter((d) => d.type === "diameter" && !d.callout)).toHaveLength(0);
  });

  it("is kept when the drawing is saved and opened", () => {
    const dim: Dimension = { id: "d", view: "top", type: "diameter", callout: true, a: { at: [10, 10], rel: [0.1, 0.2] }, r: 3.3, offset: 8 };
    const raw = [{ id: "dr", name: "D", source: null, sheet: "A4", hiddenLines: true, views: [{ id: "v", kind: "top" }], title: {}, dimensions: [dim] }];
    expect(parseDrawings(JSON.parse(JSON.stringify(raw)))[0].dimensions?.[0].callout).toBe(true);
  });
});

describe("thread symbols", () => {
  const taps = [{ drill: 5, thread: "M6 × 1", major: 6 }];
  const view = (): ViewProjection => ({
    kind: "top",
    visible: [],
    hidden: [],
    circles: [],
    points: [],
    bounds: [0, 0, 40, 20],
    holes: [
      { cx: 10, cy: 10, d: 5, through: false, depth: 10 },
      { cx: 30, cy: 10, d: 4, through: true, depth: 10 },
    ],
    sideHoles: [{ a: [10, 20], b: [10, 10], d: 5 }],
  });

  it("draws a three-quarter circle at the thread's size round tapped holes seen end-on", () => {
    const t = threadSymbols(view(), taps);
    expect(t.endOn).toHaveLength(1);
    const arc = t.endOn[0];
    for (let i = 0; i < arc.length; i += 2) expect(Math.hypot(arc[i] - 10, arc[i + 1] - 10)).toBeCloseTo(3, 9);
    // Starts at the top and goes round three quarters, ending on the right.
    expect([arc[0], arc[1]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 13]);
    expect([arc[arc.length - 2], arc[arc.length - 1]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([13, 10]);
  });

  it("draws lines along tapped holes seen from the side, at the thread's size", () => {
    const t = threadSymbols(view(), taps);
    expect(t.side).toHaveLength(2);
    expect(t.side.map((l) => Math.round(l[0] * 1e6) / 1e6).sort((a, b) => a - b)).toEqual([7, 13]);
    expect(threadSymbols(view(), [])).toEqual({ endOn: [], side: [] });
  });
});
