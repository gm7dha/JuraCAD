import { describe, expect, it } from "vitest";

import { dimLabel, dimPoint, dragDimension, dragDimensionText, drawDimension, formatSize, measureDim, pairFor, placeLength, resolveDim, sameTarget, snapPoints } from "../src/drawing/dimensions";
import { addDrawing, parseDrawings, putDimension, removeDimension, toggleView } from "../src/drawing/drawing";
import { sheetDxf, sheetPdf, sheetSvg } from "../src/drawing/export";
import { layoutSheet } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension } from "../src/model/types";

/** A 40 × 20 front view with a 10 mm hole centred at (10, 10). */
function view(w = 40, h = 20, hole: [number, number, number] = [10, 10, 5]): ViewProjection {
  return {
    kind: "front",
    visible: [[0, 0, w, 0, w, h, 0, h, 0, 0]],
    hidden: [],
    circles: [{ cx: hole[0], cy: hole[1], r: hole[2], hidden: false, full: true }],
    points: [0, 0, w, 0, w, 0, w, h, w, h, 0, h, 0, h, 0, 0],
    bounds: [0, 0, w, h],
  };
}

const length = (type: Dimension["type"], a: [number, number], b: [number, number], p = view()): Dimension => ({ id: "d", view: "front", type, a: dimPoint(a, p), b: dimPoint(b, p), offset: 8 });
const circle = (p = view()): Dimension => ({ id: "c", view: "front", type: "diameter", a: dimPoint([10, 10], p), r: 5, offset: 8 });

describe("dimension values", () => {
  it("formats sizes", () => {
    expect(formatSize(40)).toBe("40");
    expect(formatSize(12.504)).toBe("12.5");
    expect(formatSize(-0.001)).toBe("0");
    expect(dimLabel(circle(), 10)).toBe("Ø10");
    expect(dimLabel({ ...circle(), type: "radius" }, 5)).toBe("R5");
  });

  it("measures lengths and circles", () => {
    const p = view();
    expect(measureDim(length("horizontal", [0, 0], [40, 20]), resolveDim(length("horizontal", [0, 0], [40, 20]), p))).toBe(40);
    expect(measureDim(length("vertical", [0, 0], [40, 20]), resolveDim(length("vertical", [0, 0], [40, 20]), p))).toBe(20);
    expect(measureDim(length("aligned", [0, 0], [40, 20]), resolveDim(length("aligned", [0, 0], [40, 20]), p))).toBeCloseTo(Math.hypot(40, 20), 9);
    expect(measureDim(circle(), resolveDim(circle(), p))).toBe(10);
    expect(snapPoints(p)).toHaveLength(5);
  });

  it("follows the part when it changes size", () => {
    const dim = length("horizontal", [0, 0], [40, 0]);
    const wider = view(60, 20);
    const r = resolveDim(dim, wider);
    expect(r.found).toBe(true);
    expect(measureDim(dim, r)).toBe(60);
    // A bigger hole, moved a little, is still found.
    const c = resolveDim(circle(), view(60, 20, [14, 10, 6]));
    expect(c.found).toBe(true);
    expect(measureDim(circle(), c)).toBe(12);
  });

  it("says when what it measured has gone", () => {
    const p: ViewProjection = { ...view(), circles: [] };
    expect(resolveDim(circle(), p).found).toBe(false);
  });
});

describe("placing dimensions", () => {
  it("chooses horizontal, vertical or aligned from where the pointer is", () => {
    expect(placeLength([0, 0], [40, 20], [20, 30])).toEqual({ type: "horizontal", offset: 10 });
    expect(placeLength([0, 0], [40, 20], [20, -5])).toEqual({ type: "horizontal", offset: -5 });
    expect(placeLength([0, 0], [40, 20], [-6, 10])).toEqual({ type: "vertical", offset: 6 });
    expect(placeLength([0, 0], [40, 20], [50, 10])).toEqual({ type: "vertical", offset: -10 });
    expect(placeLength([0, 0], [40, 20], [20, 10]).type).toBe("aligned");
    // Two points level with each other always give a horizontal dimension.
    expect(placeLength([0, 0], [40, 0], [-10, 3])).toEqual({ type: "horizontal", offset: 3 });
  });

  it("draws a dimension line with extension lines, arrows and the number", () => {
    const dim = { ...length("horizontal", [0, 0], [40, 0]), offset: 10 };
    const r = resolveDim(dim, view());
    const d = drawDimension(dim, r, (p) => p, 40);
    const paths = d.prims.filter((p) => p.kind === "path");
    expect(paths.filter((p) => p.kind === "path" && p.fill)).toHaveLength(2);
    const text = d.prims.find((p) => p.kind === "text");
    expect(text && text.kind === "text" && text.text).toBe("40");
    // The number sits above the dimension line, 10 mm above the edge.
    expect(d.label[1]).toBeGreaterThan(10);
    const vertical = drawDimension({ ...dim, type: "vertical", b: dimPoint([0, 20], view()) }, resolveDim({ ...dim, type: "vertical", b: dimPoint([0, 20], view()) }, view()), (p) => p, 20);
    const vt = vertical.prims.find((p) => p.kind === "text");
    expect(vt && vt.kind === "text" && vt.rotate).toBe(90);
    const dia = drawDimension(circle(), resolveDim(circle(), view()), (p) => p, 10);
    expect(dia.prims.some((p) => p.kind === "text" && p.text === "Ø10")).toBe(true);
  });
});

describe("dimensions on drawings", () => {
  it("are kept in the drawing, saved, and removed with their view", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
    d = putDimension(d, length("horizontal", [0, 0], [40, 0]));
    d = putDimension(d, circle());
    expect(d.dimensions).toHaveLength(2);
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0].dimensions).toEqual(d.dimensions);
    expect(removeDimension(d, "c").dimensions).toHaveLength(1);
    expect(toggleView(d, "front").dimensions).toBeUndefined();
    expect(parseDrawings([{ ...d, dimensions: [{ id: "x", type: "diameter", view: "front", a: { at: [0, 0], rel: [0, 0] } }, { id: "y", type: "wobble" }] }])[0].dimensions).toBeUndefined();
  });

  it("appear on the sheet and in every file type", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
    d = putDimension(putDimension(d, length("horizontal", [0, 0], [40, 0])), circle());
    const l = layoutSheet(d, { front: view() }, { designName: "x", subject: "y", date: "1/1/2026" });
    expect(l.dims.map((x) => x.found)).toEqual([true, true]);
    expect(sheetSvg(l.prims, l.size)).toContain(">Ø10</text>");
    const pdf = new TextDecoder("latin1").decode(sheetPdf(l.prims, l.size));
    expect(pdf).toContain("(\\330" + "10) Tj");
    expect(pdf).toMatch(/ b\n/);
    const dxf = sheetDxf(l.prims);
    expect(dxf).toContain("%%c10");
    expect(dxf).toContain("\nLINE\n8\nVISIBLE\n");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });
});

describe("smart dimensions (two clicks)", () => {
  const hole = { kind: "circle" as const, centre: [10, 10] as [number, number], r: 5, full: true };
  const right = { kind: "line" as const, a: [40, 0] as [number, number], b: [40, 20] as [number, number] };
  const top = { kind: "line" as const, a: [0, 20] as [number, number], b: [40, 20] as [number, number] };
  const bottom = { kind: "line" as const, a: [40, 0] as [number, number], b: [0, 0] as [number, number] };

  it("measures from a hole's centre straight across to an edge", () => {
    expect(pairFor(hole, right)).toEqual({ a: [10, 10], b: [40, 0], force: "horizontal" });
    expect(pairFor(top, hole)).toEqual({ a: [10, 10], b: [0, 20], force: "vertical" });
    // Measured that way, it's the distance from the centre to the edge.
    const d = { id: "d", view: "front", type: "horizontal" as const, a: dimPoint([10, 10], view()), b: dimPoint([40, 0], view()), offset: 5 };
    expect(measureDim(d, resolveDim(d, view()))).toBe(30);
  });

  it("measures between holes, corners and parallel edges", () => {
    expect(pairFor(hole, { kind: "point", at: [40, 20] })).toEqual({ a: [10, 10], b: [40, 20] });
    expect(pairFor(top, bottom)).toEqual({ a: [0, 20], b: [0, 0], force: "vertical" });
    expect(pairFor(bottom, top)).toEqual({ a: [40, 0], b: [40, 20], force: "vertical" });
    expect("error" in pairFor(top, right)).toBe(true);
    expect("error" in pairFor(hole, { kind: "line", a: [0, 0], b: [40, 20] })).toBe(true);
    expect(sameTarget(top, { kind: "line", a: [40, 20], b: [0, 20] })).toBe(true);
    expect(sameTarget(hole, { ...hole, r: 6 })).toBe(false);
  });

  it("can be told which way to measure", () => {
    expect(placeLength([10, 10], [40, 0], [25, 30], "horizontal").type).toBe("horizontal");
    expect(placeLength([10, 10], [40, 0], [60, 5], "vertical")).toEqual({ type: "vertical", offset: -20 });
  });
});

describe("moving a dimension's number", () => {
  const dim: Dimension = { id: "d", view: "front", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [40, 0], rel: [1, 0] }, offset: 10 };
  const at = (p: [number, number]): [number, number] => p;

  it("slides along the line, snapping back to the middle near it", () => {
    expect(dragDimension(dim, [0, 0], [40, 0], 0, [21, 15])).toEqual({ offset: 15, textAlong: 0 });
    expect(dragDimension(dim, [0, 0], [40, 0], 0, [30, 15])).toEqual({ offset: 15, textAlong: 10 });
  });

  it("goes past the end, with the dimension line carried out to it", () => {
    const moved = { ...dim, textAlong: 40 };
    const r = resolveDim(moved, { kind: "front", visible: [], hidden: [], circles: [], points: [0, 0, 40, 0], bounds: [0, 0, 40, 0] });
    const drawn = drawDimension(moved, r, at, 40);
    const text = drawn.prims.find((p) => p.kind === "text")!;
    expect(text.kind === "text" && text.x).toBeCloseTo(60);
    // An extra piece of line reaching out beyond x = 40.
    const reach = drawn.prims.some((p) => p.kind === "path" && p.points.length === 4 && Math.max(p.points[0], p.points[2]) > 50 && p.points[1] === p.points[3]);
    expect(reach).toBe(true);
  });
});

describe("moving just a dimension's number (Shift-drag)", () => {
  const dim: Dimension = { id: "d", view: "front", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [40, 0], rel: [1, 0] }, offset: 10 };
  const v: ViewProjection = { kind: "front", visible: [], hidden: [], circles: [], points: [0, 0, 40, 0], bounds: [0, 0, 40, 0] };

  it("goes anywhere, with the line staying put", () => {
    // The line is at y = 10, its middle at x = 20; drag the number to (30, 25).
    const t = dragDimensionText(dim, [0, 0], [40, 0], [30, 25]);
    expect(t.textAlong).toBe(10);
    expect(t.textAcross).toBeGreaterThan(10);
    const moved = { ...dim, ...t };
    const drawn = drawDimension(moved, resolveDim(moved, v), (p) => p, 40);
    const text = drawn.prims.find((p) => p.kind === "text")!;
    expect(text.kind === "text" && Math.abs(text.x - 30) < 1e-6 && text.y > 20).toBe(true);
    // A leader from the dimension line (y = 10) up towards the number.
    const leader = drawn.prims.some((p) => p.kind === "path" && p.points.length === 4 && Math.abs(p.points[1] - 10) < 1e-6 && p.points[3] > 15);
    expect(leader).toBe(true);
  });

  it("drops back onto the line when let go close to it", () => {
    expect(dragDimensionText(dim, [0, 0], [40, 0], [20, 12.5]).textAcross).toBe(0);
  });
});

describe("tolerances and extra text", () => {
  const dim: Dimension = { id: "d", view: "front", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [40, 0], rel: [1, 0] }, offset: 10 };
  it("adds ± or +/− after the number, and text either side", () => {
    expect(dimLabel({ ...dim, tolerance: { plus: 0.1, minus: 0.1 } }, 40)).toBe("40 ±0.1");
    expect(dimLabel({ ...dim, tolerance: { plus: 0.2, minus: 0.05 } }, 40)).toBe("40 +0.2/−0.05");
    expect(dimLabel({ ...dim, type: "diameter", prefix: "4× ", suffix: " THRU" }, 6)).toBe("4× Ø6 THRU");
  });
  it("are kept when the drawing is saved and opened again", () => {
    const doc = addDrawing(emptyDocument(), "dr", null);
    const d = putDimension(doc.drawings![0], { ...dim, tolerance: { plus: 0.2, minus: 0.05 }, prefix: "2× " });
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0].dimensions![0];
    expect(back.tolerance).toEqual({ plus: 0.2, minus: 0.05 });
    expect(back.prefix).toBe("2× ");
  });
});
