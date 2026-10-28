/**
 * Dragging angle, arc-length, chamfer and ordinate dimensions by their number
 * (lengths, diameters and radii are in dimensionText.test.ts): the number stays
 * under the pointer and the arc, leader or jog follows it. Missing fields =
 * drawn exactly as before.
 */
import { describe, expect, it } from "vitest";

import { angleArc, arcBeyond, dimensionPaperScale, dimPoint, dragDimensionLabel, drawDimension, measureDim, resolveDim, TEXT_SIZE, withDimPatch, type DimDrawing, type DragPlace } from "../src/drawing/dimensions";
import { addDrawing, parseDrawings, putDimension } from "../src/drawing/drawing";
import { sheetDxf, sheetSvg, textWidth } from "../src/drawing/export";
import { layoutSheet, type Prim } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension } from "../src/model/types";
import { setLengthUnit } from "../src/model/units";

type P2 = [number, number];
const same = (p: P2) => p;
const twice = (p: P2): P2 => [p[0] * 2, p[1] * 2];
const DEG = Math.PI / 180;

function proj(points: number[], circles: { cx: number; cy: number; r: number; full?: boolean }[] = [], visible: number[][] = []): ViewProjection {
  return { kind: "front", visible, hidden: [], circles: circles.map((c) => ({ hidden: false, full: true, ...c })), points, bounds: [-50, -50, 50, 50] };
}
function draw(dim: Dimension, p: ViewProjection, at: (q: P2) => P2 = same): DimDrawing {
  const r = resolveDim(dim, p);
  return drawDimension(dim, r, at, measureDim(dim, r));
}
const texts = (d: DimDrawing) => d.prims.filter((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text");
const paths = (d: DimDrawing) => d.prims.filter((x): x is Extract<Prim, { kind: "path" }> => x.kind === "path");
function drag(dim: Dimension, placed: DragPlace, to: P2, lift = false, scale = 1): Dimension {
  const patch = dragDimensionLabel(dim, placed, to, lift, scale);
  expect(patch).toBeTruthy();
  return withDimPatch(dim, patch!);
}
const close = (a: P2, b: P2, digits = 9) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

// ---------------------------------------------------------------------------
describe("dragging an angle's number", () => {
  // Two edges from the origin: along +x, and up at 45°.
  const p = proj([0, 0, 40, 0, 30, 30]);
  const dim: Dimension = { id: "g", view: "front", type: "angle", a: dimPoint([0, 0], p), b: dimPoint([40, 0], p), c: dimPoint([0, 0], p), d: dimPoint([30, 30], p), offset: 8 };
  const placed: DragPlace = { a: [0, 0], b: [40, 0], rad: 0, cd: [[0, 0], [30, 30]] };
  /** Where the label goes for the number's middle `r` out from the corner in direction `deg`. */
  const spot = (r: number, deg: number): P2 => [r * Math.cos(deg * DEG), r * Math.sin(deg * DEG) - TEXT_SIZE * 0.35];

  it("starts where it always was (3 mm beyond the middle of the arc), with nothing new saved", () => {
    close(draw(dim, p).label, spot(11, 22.5));
    expect(texts(draw(dim, p))[0].text).toBe("45°");
  });

  it("follows the pointer: its distance sets the arc's radius, its direction slides the number round the arc", () => {
    const moved = drag(dim, placed, spot(23, 30));
    expect(moved.offset).toBe(20);
    expect(moved.rays).toEqual([1, 1]);
    expect(moved.textAngle).toBe(7.5);
    const drawn = draw(moved, p);
    close(drawn.label, spot(23, 30));
    // The arc is now 20 mm out, from the first arm round to the second.
    const arc = paths(drawn)[0].points;
    close([arc[0], arc[1]], [20, 0]);
    close([arc[arc.length - 2], arc[arc.length - 1]], [20 * Math.cos(45 * DEG), 20 * Math.sin(45 * DEG)]);
  });

  it("snaps back to the middle within 2 mm (round the arc) of it", () => {
    expect(drag(dim, placed, spot(23, 25)).textAngle).toBeUndefined();
  });

  it("into the supplementary angle (across one line) measures that instead, as Onshape does", () => {
    const moved = drag(dim, placed, spot(23, 120));
    expect(moved.rays).toEqual([-1, 1]);
    expect(moved.textAngle).toBe(7.5);
    const drawn = draw(moved, p);
    expect(texts(drawn)[0].text).toBe("135°");
    close(drawn.label, spot(23, 120));
  });

  it("into the opposite angle (across both lines) measures that one", () => {
    const moved = drag(dim, placed, spot(23, 200));
    expect(moved.rays).toEqual([-1, -1]);
    // (2.5° off the middle at 20 mm is under 2 mm: snapped to the middle.)
    expect(moved.textAngle).toBeUndefined();
    const drawn = draw(moved, p);
    expect(texts(drawn)[0].text).toBe("45°");
    close(drawn.label, spot(23, 202.5));
  });

  it("with Shift keeps the angle measured and lets the number go past an arm, the arc carrying on out to it", () => {
    const moved = drag(dim, placed, spot(23, 90), true);
    expect(moved.rays).toEqual([1, 1]);
    expect(moved.textAngle).toBe(67.5);
    const drawn = draw(moved, p);
    expect(texts(drawn)[0].text).toBe("45°");
    close(drawn.label, spot(23, 90));
    // From the second arm (45°) round to under the far side of the number.
    const half = textWidth("45°", TEXT_SIZE) / 2 + 1;
    const over = arcBeyond(0, Math.PI / 4, Math.PI / 2, 20, textWidth("45°", TEXT_SIZE))!;
    expect(over[0]).toBeCloseTo(Math.PI / 4, 12);
    expect(over[1]).toBeCloseTo(Math.PI / 2 + half / 20, 12);
    const ext = paths(drawn).find((x) => {
      const n = x.points.length;
      return Math.abs(x.points[0] - 20 * Math.cos(Math.PI / 4)) < 1e-9 && Math.abs(x.points[n - 1] - 20 * Math.sin(over[1])) < 1e-9;
    });
    expect(ext).toBeDefined();
    expect(ext!.points[ext!.points.length - 2]).toBeCloseTo(20 * Math.cos(over[1]), 9);
    // Not dragged past: no extra arc.
    expect(paths(draw(withDimPatch(dim, { textAngle: 10 }), p))).toHaveLength(paths(draw(dim, p)).length);
  });

  it("angleArc gives the arc the drawing uses (the shorter way round)", () => {
    expect(angleArc([1, 0], [0, 1])).toEqual({ a1: 0, sweep: Math.PI / 2 });
    const back = angleArc([0, 1], [1, 0]);
    expect(back.a1).toBe(0);
    expect(back.sweep).toBeCloseTo(Math.PI / 2, 12);
  });

  it("is in degrees round the arc, so it stays put relative to the corner at any view scale", () => {
    const moved = withDimPatch(dim, { offset: 20, textAngle: 7.5 });
    // At 2:1 the corner is still at the origin; the number is still 7.5° past the middle, 23 mm out (paper).
    close(draw(moved, p, twice).label, spot(23, 30));
  });
});

// ---------------------------------------------------------------------------
describe("dragging an arc length's number", () => {
  // A quarter arc of radius 10 round the origin, from 0° to 90°.
  const arcPts: number[] = [];
  for (let i = 0; i <= 18; i++) arcPts.push(10 * Math.cos((i * 5) * DEG), 10 * Math.sin((i * 5) * DEG));
  const p = proj([0, 0, 10, 0, 0, 10], [{ cx: 0, cy: 0, r: 10, full: false }], [arcPts]);
  const dim: Dimension = { id: "l", view: "front", type: "arcLength", a: dimPoint([0, 0], p), r: 10, b: dimPoint([10 * Math.cos(Math.PI / 4), 10 * Math.sin(Math.PI / 4)], p), offset: 8 };
  const text = "15.71";
  const w = textWidth(text, TEXT_SIZE);
  /** Where the label is for the arc `R` out and the number's direction `deg` (the drawing's own rule). */
  const spot = (R: number, deg: number): P2 => {
    const t = deg * DEG;
    const reach = R + 1.5 + (Math.abs(Math.cos(t)) * w) / 2 + (Math.abs(Math.sin(t)) * (TEXT_SIZE * 0.75 + 1.6)) / 2;
    return [reach * Math.cos(t), reach * Math.sin(t) - TEXT_SIZE * 0.375 - 0.4];
  };
  const laid = (): DragPlace => {
    const r = resolveDim(dim, p);
    const drawn = draw(dim, p);
    return { a: [0, 0], b: r.b!, rad: 10, arc: r.arc, width: drawn.width };
  };

  it("starts where it always was", () => {
    const drawn = draw(dim, p);
    expect(texts(drawn)[0].text).toBe(text);
    expect(drawn.width).toBeCloseTo(w, 12);
    close(drawn.label, spot(18, 45));
  });

  it("follows the pointer round the arc and out from it", () => {
    const moved = drag(dim, laid(), spot(25, 75));
    expect(moved.offset).toBe(15);
    expect(moved.textAngle).toBe(30);
    close(draw(moved, p).label, spot(25, 75));
  });

  it("past the arc's end, the dimension arc carries on out under the number", () => {
    const moved = drag(dim, laid(), spot(25, 105));
    expect(moved.textAngle).toBe(60);
    const drawn = draw(moved, p);
    close(drawn.label, spot(25, 105));
    const over = arcBeyond(0, Math.PI / 2, 105 * DEG, 25, w)!;
    expect(over[0]).toBeCloseTo(Math.PI / 2, 9);
    const ext = paths(drawn).find((x) => !x.fill && x.points.length > 4 && Math.abs(x.points[0]) < 1e-6 && Math.abs(x.points[1] - 25) < 1e-6);
    expect(ext).toBeDefined();
    close([ext!.points[ext!.points.length - 2], ext!.points[ext!.points.length - 1]], [25 * Math.cos(over[1]), 25 * Math.sin(over[1])]);
  });

  it("is laid out with what dragging needs (the arc and the number's width)", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
    d = putDimension(d, dim);
    const l = layoutSheet(d, { front: p }, { designName: "x", subject: "y", date: "1/1/2026" });
    expect(l.dims[0].arc!.sweep).toBeCloseTo(Math.PI / 2, 9);
    expect(l.dims[0].width).toBeCloseTo(w, 12);
  });
});

// ---------------------------------------------------------------------------
describe("dragging a chamfer's number", () => {
  // A 4 × 45° chamfer from (0, 0) to (4, 4): its middle at (2, 2).
  const p = proj([0, 0, 4, 4]);
  const dim: Dimension = { id: "c", view: "front", type: "chamfer", a: dimPoint([0, 0], p), b: dimPoint([4, 4], p), offset: 8, angle: 45 };
  const text = "4 × 45°";
  const w = textWidth(text, TEXT_SIZE);

  it("goes exactly where it's dropped, the leader running from the edge's middle to its shoulder", () => {
    const moved = drag(dim, { a: [0, 0], b: [4, 4], rad: 0 }, [20, 10]);
    expect(moved.textAt).toEqual([18, 8]);
    const drawn = draw(moved, p);
    expect(drawn.label).toEqual([20, 10]);
    expect(texts(drawn)[0]).toMatchObject({ x: 20, y: 10, text, anchor: "middle" });
    const leader = paths(drawn)[0].points;
    const s = (2 + w) / 2;
    [2, 2, 20 - s, 9, 20 + s, 9].forEach((v, i) => expect(leader[i]).toBeCloseTo(v, 12));
    // The arrow's tip is on the edge's middle.
    expect(paths(drawn)[1].points.slice(0, 2)).toEqual([2, 2]);
  });

  it("on the left, leads in from the number's right-hand end", () => {
    const drawn = draw(drag(dim, { a: [0, 0], b: [4, 4], rad: 0 }, [-20, 10]), p);
    const leader = paths(drawn)[0].points;
    expect(leader[2]).toBeCloseTo(-20 + (2 + w) / 2, 12);
    expect(leader[4]).toBeCloseTo(-20 - (2 + w) / 2, 12);
  });

  it("is kept in the view's millimetres, so it stays put relative to the edge when the scale changes", () => {
    // At 2:1 the edge's middle is at (4, 4) on paper; dropped at (40, 20) it's saved as (18, 8) mm.
    expect(dimensionPaperScale(dim, { a: [0, 0], b: [8, 8], rad: 0 }, p)).toBeCloseTo(2, 12);
    const moved = drag(dim, { a: [0, 0], b: [8, 8], rad: 0 }, [40, 20], false, 2);
    expect(moved.textAt).toEqual([18, 8]);
    expect(draw(moved, p, twice).label).toEqual([40, 20]);
    expect(draw(moved, p).label).toEqual([20, 10]);
  });

  it("right on the edge's middle still has an arrow pointing at it", () => {
    const s = (2 + w) / 2;
    const drawn = draw(withDimPatch(dim, { textAt: [s, 1] }), p);
    const tip = paths(drawn)[1].points;
    expect(tip.slice(0, 2)).toEqual([2, 2]);
    expect(tip.every((v) => Number.isFinite(v))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("dragging an ordinate's number", () => {
  // Datum at the origin, the point at (30, 10); measured across, so the leader runs up from the point.
  const p = proj([0, 0, 30, 10]);
  const dim: Dimension = { id: "o", view: "front", type: "ordinate", a: dimPoint([0, 0], p), b: dimPoint([30, 10], p), offset: 8, axis: "h" };
  const placed: DragPlace = { a: [0, 0], b: [30, 10], rad: 0 };

  it("starts where it always was (1 mm beyond the leader's end), with a straight leader", () => {
    const drawn = draw(dim, p);
    expect(drawn.label).toEqual([30, 19]);
    expect(paths(drawn)[0].points).toEqual([30, 11, 30, 18]);
  });

  it("out along the leader moves its end; sideways, the leader jogs across to it", () => {
    const moved = drag(dim, placed, [36, 29]);
    expect(moved.offset).toBe(18);
    expect(moved.textAlong).toBe(6);
    const drawn = draw(moved, p);
    expect(drawn.label).toEqual([36, 29]);
    // Straight up, a 3 mm slanted dog-leg 6 mm across, and 3 mm straight up again to the number.
    expect(paths(drawn)[0].points).toEqual([30, 11, 30, 22, 36, 25, 36, 28]);
    expect(texts(drawn)[0]).toMatchObject({ x: 36 + TEXT_SIZE * 0.35, y: 29, rotate: 90, anchor: "start", text: "30" });
  });

  it("below the point, the leader runs down; within 1 mm sideways it's straight", () => {
    const moved = drag(dim, placed, [30.5, -20]);
    expect(moved.offset).toBe(-19);
    expect(moved.textAlong).toBeUndefined();
    const drawn = draw(moved, p);
    expect(drawn.label).toEqual([30, -20]);
    expect(paths(drawn)[0].points).toEqual([30, 9, 30, -19]);
  });

  it("measured up and down, the leader runs sideways and jogs up or down", () => {
    const v: Dimension = { ...dim, axis: "v" };
    // Left of the part: the leader runs left from (30, 10) to x = -8 and jogs 5 mm up.
    const moved = drag(v, placed, [-9, 15]);
    expect(moved.offset).toBe(8);
    expect(moved.textAlong).toBe(5);
    const drawn = draw(moved, p);
    expect(drawn.label).toEqual([-9, 15]);
    expect(paths(drawn)[0].points).toEqual([29, 10, -2, 10, -5, 15, -8, 15]);
    expect(texts(drawn)[0].text).toBe("10");
  });

  it("a short leader keeps its dog-leg inside it", () => {
    const moved = withDimPatch(dim, { offset: 2, textAlong: 4 });
    // Base at 12: it runs 1 mm (from 11), so each straight piece is a third of that.
    const pts = paths(draw(moved, p))[0].points;
    [30, 11, 30, 11 + 1 / 3, 34, 12 - 1 / 3, 34, 12].forEach((x, i) => expect(pts[i]).toBeCloseTo(x, 12));
  });
});

// ---------------------------------------------------------------------------
describe("a length's line carried out to its slid number uses the number's real width", () => {
  const p = proj([0, 0, 40, 0]);
  const dim: Dimension = { id: "d", view: "front", type: "horizontal", a: dimPoint([0, 0], p), b: dimPoint([40, 0], p), offset: 10, limitsFit: { class: "H7/g6" } };
  const placed = { a: [0, 0] as P2, b: [40, 0] as P2, rad: 0 };
  const lineTo = (d: DimDrawing) => paths(d).find((x) => x.points.length === 4 && x.points[0] === 40 && x.points[1] === 10 && x.points[3] === 10)!.points[2];

  it("dragged now: under the whole number, stacked fit and all, and a millimetre more", () => {
    const moved = drag(dim, placed, [60, 11.2]);
    expect(moved.textAlong).toBe(40);
    expect(moved.fitText).toBe(true);
    const drawn = draw(moved, p);
    // "40", then H7 over g6 in small text.
    const t = texts(drawn);
    expect(t.map((x) => x.text)).toEqual(["40", "H7", "g6"]);
    const right = Math.max(...t.slice(1).map((x) => x.x + textWidth(x.text, x.size)));
    expect(lineTo(drawn)).toBeCloseTo(right + 1, 9);
    expect(lineTo(drawn)).toBeCloseTo(60 + (textWidth("40", TEXT_SIZE) + 1.2 + textWidth("H7", 2.5)) / 2 + 1, 9);
  });

  it("dragged before (no fitText): exactly as it was drawn then", () => {
    const old = { ...dim, textAlong: 40 };
    expect(lineTo(draw(old, p))).toBeCloseTo(60 + (2 * TEXT_SIZE * 0.55) / 2 + 1, 12);
  });

  it("slid back to the middle, nothing extra is saved", () => {
    expect(drag(dim, placed, [20, 11.2])).toEqual({ ...dim, offset: 10 });
  });
});

// ---------------------------------------------------------------------------
describe("saving, opening and exporting moved numbers", () => {
  const pt = (x: number, y: number) => ({ at: [x, y] as P2, rel: [0, 0] as P2 });
  const base = () => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];

  it("keeps each new field only on the dimensions it belongs to, and tidies odd values", () => {
    const dims: Dimension[] = [
      { id: "g", view: "front", type: "angle", a: pt(0, 0), b: pt(40, 0), c: pt(0, 0), d: pt(30, 30), offset: 20, textAngle: 370 },
      { id: "l", view: "front", type: "arcLength", a: pt(0, 0), b: pt(7, 7), r: 10, offset: 8, textAngle: -30 },
      { id: "c", view: "front", type: "chamfer", a: pt(0, 0), b: pt(4, 4), offset: 8, textAt: [18, 8] },
      { id: "o", view: "front", type: "ordinate", a: pt(0, 0), b: pt(30, 10), offset: 18, axis: "h", textAlong: 6 },
      { id: "h", view: "front", type: "horizontal", a: pt(0, 0), b: pt(40, 0), offset: 10, textAlong: 40, fitText: true, textAngle: 10 },
      { id: "v", view: "front", type: "vertical", a: pt(0, 0), b: pt(0, 40), offset: 10, textAt: [1, 1] as P2, fitText: "yes" as unknown as true },
      { id: "z", view: "front", type: "angle", a: pt(0, 0), b: pt(40, 0), c: pt(0, 0), d: pt(30, 30), offset: 20, textAngle: 720 },
    ];
    const back = parseDrawings(JSON.parse(JSON.stringify([{ ...base(), dimensions: dims }])))[0].dimensions!;
    const by = (id: string) => back.find((x) => x.id === id)!;
    expect(by("g").textAngle).toBe(10);
    expect(by("l").textAngle).toBe(-30);
    expect(by("c").textAt).toEqual([18, 8]);
    expect(by("o").textAlong).toBe(6);
    expect(by("h").fitText).toBe(true);
    expect(by("h").textAngle).toBeUndefined();
    expect(by("v").textAt).toBeUndefined();
    expect(by("v").fitText).toBeUndefined();
    // (A whole number of turns is just "in the middle".)
    expect(by("z").textAngle).toBeUndefined();
  });

  it("draws a dragged angle's number in the SVG and DXF exactly where it is on screen", () => {
    const p = proj([0, 0, 40, 0, 30, 30]);
    const dim: Dimension = { id: "g", view: "front", type: "angle", a: dimPoint([0, 0], p), b: dimPoint([40, 0], p), c: dimPoint([0, 0], p), d: dimPoint([30, 30], p), offset: 20, rays: [-1, 1], textAngle: 7.5 };
    const l = layoutSheet(putDimension(base(), dim), { front: p }, { designName: "x", subject: "y", date: "1/1/2026" });
    const placed = l.dims[0];
    const t = l.prims.slice(placed.from, placed.to).find((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text")!;
    expect(t.text).toBe("135°");
    expect(placed.label).toEqual([t.x, t.y]);
    // 23 mm out from the corner at 120° on the sheet, whatever the sheet's scale (the corner is placed[a]'s line's start).
    const corner = placed.a;
    expect(Math.hypot(t.x - corner[0], t.y + TEXT_SIZE * 0.35 - corner[1])).toBeCloseTo(23, 9);
    expect(Math.atan2(t.y + TEXT_SIZE * 0.35 - corner[1], t.x - corner[0]) / DEG).toBeCloseTo(120, 9);
    const svg = sheetSvg(l.prims, l.size);
    const m = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>135°<\/text>/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(t.x, 2);
    expect(Number(m![2])).toBeCloseTo(l.size[1] - t.y, 2);
    expect(sheetDxf(l.prims)).toContain("135%%d");
  });

  it("in inches: the same places (positions never depend on the unit shown)", () => {
    const p = proj([0, 0, 30, 10]);
    const dim: Dimension = { id: "o", view: "front", type: "ordinate", a: dimPoint([0, 0], p), b: dimPoint([30, 10], p), offset: 8, axis: "h" };
    setLengthUnit("in");
    try {
      const moved = drag(dim, { a: [0, 0], b: [30, 10], rad: 0 }, [36, 29]);
      expect(moved.offset).toBe(18);
      expect(moved.textAlong).toBe(6);
      const drawn = draw(moved, p);
      expect(drawn.label).toEqual([36, 29]);
      expect(texts(drawn)[0].text).toBe("1.181");
    } finally {
      setLengthUnit("mm");
    }
  });
});
