/**
 * More dimension types on drawings: chamfer callouts ("1 × 45°"), arc
 * lengths, and limits-and-fits classes (H7, g6, H7/g6) with their limits.
 */
import { afterEach, describe, expect, it } from "vitest";

import { addDrawing, parseDrawings, putDimension } from "../src/drawing/drawing";
import { ARROW_LEADER, arcOf, arrowsFor, chamferLabel, chamferSize, dimLabel, dimPoint, dragDimension, drawDimension, fitOf, flipArrows, measureDim, resolveDim } from "../src/drawing/dimensions";
import { deviation, limitSizes, parseFitClass } from "../src/drawing/fits";
import { sheetDxf, sheetPdf, sheetSvg } from "../src/drawing/export";
import { dimStyle, layoutSheet, type Prim } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension, Drawing } from "../src/model/types";
import { setLengthUnit } from "../src/model/units";

afterEach(() => setLengthUnit("mm"));

const texts = (prims: Prim[]) => prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
const newDrawing = (): Drawing => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
const info = { designName: "D", subject: "S", date: "1/1/2026" };

/** An arc of radius r round (cx, cy) from angle a0 to a1 (degrees), as the engine draws one: a run of points on it. */
function arcLine(cx: number, cy: number, r: number, a0: number, a1: number, steps = 24): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return out;
}

/** A 40 × 20 side view with a rounded top-right corner (radius r) and a 2 × 45° chamfer on the top-left corner. */
function sideView(r = 5): ViewProjection {
  const arc = arcLine(40 - r, 20 - r, r, 0, 90);
  return {
    kind: "front",
    visible: [[2, 20, 40 - r, 20], arc, [40, 20 - r, 40, 0], [40, 0, 0, 0], [0, 0, 0, 18], [0, 18, 2, 20]],
    hidden: [],
    circles: [{ cx: 40 - r, cy: 20 - r, r, hidden: false, full: false }],
    points: [2, 20, 40 - r, 20, 40, 20 - r, 40, 20 - r, 40, 0, 40, 0, 0, 0, 0, 0, 0, 18, 0, 18, 2, 20],
    bounds: [0, 0, 40, 20],
  };
}

describe("limits and fits (ISO 286)", () => {
  const um = (size: number, cls: string) => {
    const c = parseFitClass(cls);
    if ("error" in c) throw new Error(c.error);
    const d = deviation(size, (c.hole ?? c.shaft)!);
    if ("error" in d) throw new Error(d.error);
    return [Math.round(d.upper * 1000), Math.round(d.lower * 1000)];
  };

  it("gives the standard's deviations for common holes and shafts", () => {
    expect(um(20, "H7")).toEqual([21, 0]);
    expect(um(20, "g6")).toEqual([-7, -20]);
    expect(um(25, "f7")).toEqual([-20, -41]);
    expect(um(20, "k6")).toEqual([15, 2]);
    expect(um(20, "n6")).toEqual([28, 15]);
    expect(um(20, "p6")).toEqual([35, 22]);
    expect(um(50, "H8")).toEqual([39, 0]);
    expect(um(50, "e8")).toEqual([-50, -89]);
    expect(um(10, "d9")).toEqual([-40, -76]);
    expect(um(10, "F8")).toEqual([35, 13]);
    expect(um(20, "G7")).toEqual([28, 7]);
    expect(um(100, "h6")).toEqual([0, -22]);
    expect(um(100, "m6")).toEqual([35, 13]);
    // JS and js: half the band either side.
    const js = deviation(20, { letter: "JS", grade: 7, hole: true });
    expect(js).toEqual({ upper: 0.0105, lower: -0.0105 });
    // Size steps: up to and including each step's top (10 is in 6–10, 10.001 in 10–18).
    expect(um(10, "H7")).toEqual([15, 0]);
    expect(um(10.001, "H7")).toEqual([18, 0]);
    expect(um(3, "h6")).toEqual([0, -6]);
    // k is 0 below the size for grades above 7.
    expect(um(20, "k8")).toEqual([33, 0]);
  });

  it("gives the largest and smallest sizes", () => {
    const c = parseFitClass("H7");
    if ("error" in c) throw new Error();
    const l = limitSizes(20, c.hole!);
    if ("error" in l) throw new Error();
    expect(l.max).toBeCloseTo(20.021, 9);
    expect(l.min).toBeCloseTo(20, 9);
  });

  it("reads classes and fits, and says plainly what's wrong", () => {
    expect(parseFitClass(" H7 / g6 ")).toEqual({ hole: { letter: "H", grade: 7, hole: true }, shaft: { letter: "g", grade: 6, hole: false } });
    expect(parseFitClass("js6")).toEqual({ shaft: { letter: "js", grade: 6, hole: false } });
    const error = (s: string) => {
      const r = parseFitClass(s);
      return "error" in r ? r.error : "";
    };
    expect(error("Z7")).toMatch(/doesn't know the hole letter "Z"/);
    expect(error("H13")).toMatch(/Grade 13 isn't covered/);
    expect(error("g6/H7")).toMatch(/hole first/);
    expect(error("H7/G7")).toMatch(/hole first/);
    expect(error("7H")).toMatch(/isn't a tolerance class/);
    expect(error("")).toMatch(/Type a class/);
    const big = deviation(600, { letter: "H", grade: 7, hole: true });
    expect("error" in big && big.error).toMatch(/up to 500 mm/);
  });

  const dia = (cls: string, limits = false): Dimension => ({ id: "d", view: "top", type: "diameter", a: { at: [0, 0], rel: [0.5, 0.5] }, r: 10, offset: 8, limitsFit: { class: cls, ...(limits ? { limits: true as const } : {}) } });

  it("shows a class after the size, a fit stacked, and limits when asked", () => {
    expect(dimLabel(dia("H7"), 20)).toBe("Ø20 H7");
    expect(fitOf(dia("H7"), 20)).toEqual({ inline: " H7", stack: null, fraction: false });
    expect(fitOf(dia("H7", true), 20)).toEqual({ inline: " H7", stack: ["20.021", "20.000"], fraction: false });
    expect(dimLabel(dia("H7/g6"), 20)).toBe("Ø20");
    expect(fitOf(dia("H7/g6"), 20)).toEqual({ inline: "", stack: ["H7", "g6"], fraction: true });
    expect(fitOf(dia("H7/g6", true), 20)!.stack).toEqual(["H7 20.021/20.000", "g6 19.993/19.980"]);
    // It replaces a ± tolerance.
    expect(dimLabel({ ...dia("h6"), tolerance: { plus: 0.1, minus: 0.1 } }, 20)).toBe("Ø20 h6");
    // In inches, limits to four places.
    setLengthUnit("in");
    expect(fitOf(dia("H7", true), 25.4)!.stack).toEqual(["1.0008", "1.0000"]);
    setLengthUnit("mm");
    // Something it can't work out shows as typed, with the reason.
    const bad = fitOf(dia("Q9"), 20)!;
    expect(bad.inline).toBe(" Q9");
    expect(bad.error).toMatch(/hole letter "Q"/);
    expect(fitOf(dia("H7", true), 700)!.error).toMatch(/500 mm/);
    expect(fitOf(dia("H7", true), 700)!.stack).toBeNull();
    // Not on angles or positions.
    expect(fitOf({ type: "angle", limitsFit: { class: "H7" } }, 20)).toBeNull();
  });

  it("draws the stack after the number, with a line between a fit's classes, in every file type", () => {
    const top: ViewProjection = { kind: "top", visible: [], hidden: [], circles: [{ cx: 20, cy: 20, r: 10, hidden: false, full: true }], points: [], bounds: [0, 0, 40, 40] };
    const dim = dia("H7/g6");
    const r = resolveDim(dim, top);
    const drawn = drawDimension(dim, r, (p) => p, measureDim(dim, r));
    const t = drawn.prims.filter((p): p is Extract<Prim, { kind: "text" }> => p.kind === "text");
    expect(t.map((x) => x.text)).toEqual(["Ø20", "H7", "g6"]);
    // H7 above g6, both just right of the number, smaller.
    expect(t[1].y).toBeGreaterThan(t[2].y);
    expect(t[1].x).toBeCloseTo(t[2].x, 9);
    expect(t[1].x).toBeGreaterThan(t[0].x + 3);
    expect(t[1].size).toBeLessThan(t[0].size);
    // The fraction line sits between them.
    const lines = drawn.prims.filter((p): p is Extract<Prim, { kind: "path" }> => p.kind === "path" && p.points.length === 4 && Math.abs(p.points[1] - p.points[3]) < 1e-9);
    expect(lines.some((l) => l.points[1] < t[1].y && l.points[1] > t[2].y + t[2].size * 0.75 - 1e-9)).toBe(true);
    // On a sheet, and in the files.
    const d = putDimension({ ...newDrawing(), views: [{ id: "t", kind: "top" }] }, { ...dim, view: "top" });
    const l = layoutSheet(d, { top }, info);
    expect(texts(l.prims)).toContain("g6");
    expect(sheetSvg(l.prims, l.size)).toContain(">H7</text>");
    expect(sheetDxf(l.prims)).toContain("\ng6\n");
    expect(new TextDecoder("latin1").decode(sheetPdf(l.prims, l.size))).toContain("(H7) Tj");
  });

  it("boxes just the number of a basic size with a stacked fit", () => {
    const top: ViewProjection = { kind: "top", visible: [], hidden: [], circles: [{ cx: 20, cy: 20, r: 10, hidden: false, full: true }], points: [], bounds: [0, 0, 40, 40] };
    const dim: Dimension = { ...dia("H7/g6"), frame: "basic" };
    const r = resolveDim(dim, top);
    const drawn = drawDimension(dim, r, (p) => p, measureDim(dim, r));
    const box = drawn.prims[drawn.prims.length - 1];
    const number = drawn.prims.find((p): p is Extract<Prim, { kind: "text" }> => p.kind === "text" && p.text === "Ø20")!;
    const stack = drawn.prims.find((p): p is Extract<Prim, { kind: "text" }> => p.kind === "text" && p.text === "H7")!;
    expect(box.kind === "path" && box.closed).toBe(true);
    const xs = box.kind === "path" ? box.points.filter((_, i) => i % 2 === 0) : [];
    expect(Math.min(...xs)).toBeLessThan(number.x);
    expect(Math.max(...xs)).toBeLessThan(stack.x);
  });

  it("keeps the stack the right way up on an upright dimension", () => {
    const p: ViewProjection = { kind: "front", visible: [[0, 0, 0, 30]], hidden: [], circles: [], points: [0, 0, 0, 30], bounds: [0, 0, 10, 30] };
    const dim: Dimension = { id: "v", view: "front", type: "vertical", a: dimPoint([0, 0], p), b: dimPoint([0, 30], p), offset: 10, limitsFit: { class: "h7" } };
    const r = resolveDim(dim, p);
    const t = drawDimension(dim, r, (q) => q, 30).prims.filter((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text");
    expect(t.map((x) => x.text)).toEqual(["30 h7"]);
    const lim: Dimension = { ...dim, limitsFit: { class: "h7", limits: true } };
    const t2 = drawDimension(lim, r, (q) => q, 30).prims.filter((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text");
    expect(t2.map((x) => x.text)).toEqual(["30 h7", "30.000", "29.979"]);
    // Turned with the number (reading upwards): the stack runs up the page, the upper limit further left.
    expect(t2.every((x) => x.rotate === 90)).toBe(true);
    expect(t2[1].y).toBeGreaterThan(t2[0].y);
    expect(t2[1].x).toBeLessThan(t2[2].x);
  });

  it("is kept in saved files, on sizes only", () => {
    const d = putDimension(newDrawing(), { ...dia("H7/g6", true), view: "front" });
    expect(parseDrawings([d])[0].dimensions![0].limitsFit).toEqual({ class: "H7/g6", limits: true });
    const angle = { id: "a", view: "front", type: "angle", a: { at: [0, 0], rel: [0, 0] }, b: { at: [1, 0], rel: [1, 0] }, c: { at: [0, 0], rel: [0, 0] }, d: { at: [0, 1], rel: [0, 1] }, offset: 8, limitsFit: { class: "H7" } };
    expect(parseDrawings([{ ...newDrawing(), dimensions: [angle] }])[0].dimensions![0].limitsFit).toBeUndefined();
  });
});

describe("chamfer callouts", () => {
  it("gives the distance and angle of a slanted edge", () => {
    expect(chamferSize([0, 18], [2, 20])).toEqual({ distance: 2, angle: 45, along: "h" });
    const c30 = chamferSize([0, 0], [2, 2 * Math.tan(Math.PI / 6)]);
    expect(c30.distance).toBe(2);
    expect(c30.angle).toBeCloseTo(30, 9);
    // Measured the other way: the other leg and the other angle.
    const c60 = chamferSize([0, 0], [2, 2 * Math.tan(Math.PI / 6)], "v");
    expect(c60.distance).toBeCloseTo(1.1547, 4);
    expect(c60.angle).toBeCloseTo(60, 9);
    // The longer leg by default (so the angle is 45° or less).
    expect(chamferSize([0, 0], [1, 3]).along).toBe("v");
  });

  it("labels it and draws a leader from the middle of the edge", () => {
    const p = sideView();
    const dim: Dimension = { id: "c", view: "front", type: "chamfer", a: dimPoint([0, 18], p), b: dimPoint([2, 20], p), offset: 8, angle: 135 };
    const r = resolveDim(dim, p);
    expect(r.found).toBe(true);
    expect(chamferLabel(dim, r)).toBe("2 × 45°");
    expect(measureDim(dim, r)).toBe(2);
    expect(chamferLabel({ ...dim, places: 1 }, r)).toBe("2.0 × 45.0°");
    expect(chamferLabel(dim, r, { dual: true })).toBe("2 [0.079] × 45°");
    const drawn = drawDimension(dim, r, (q) => q, measureDim(dim, r));
    expect(texts(drawn.prims)).toEqual(["2 × 45°"]);
    // The leader starts at the middle of the edge with an arrow on it.
    const leader = drawn.prims.find((x) => x.kind === "path" && !x.fill)!;
    expect(leader.kind === "path" && leader.points.slice(0, 2)).toEqual([1, 19]);
    // Dragging the label moves the leader round the edge's middle.
    expect(dragDimension(dim, [0, 18], [2, 20], 0, [11, 19])).toEqual({ offset: 10, angle: 0 });
    // The same in files (× as a Latin-1 character in PDF, a code in DXF).
    const d = putDimension({ ...newDrawing(), scale: 1, views: [{ id: "f", kind: "front" }] }, dim);
    const l = layoutSheet(d, { front: p }, info);
    expect(texts(l.prims)).toContain("2 × 45°");
    expect(new TextDecoder("latin1").decode(sheetPdf(l.prims, l.size))).toContain("(2 \\327 45\\260) Tj");
    expect(sheetDxf(l.prims)).toContain("2 \\U+00D7 45%%d");
    expect(parseDrawings([{ ...d, dimensions: [{ ...dim, along: "v" }] }])[0].dimensions![0]).toEqual({ ...dim, along: "v" });
  });
});

describe("arc lengths", () => {
  it("finds an arc's ends from its drawn line, and its length", () => {
    const p = sideView(5);
    const arc = arcOf(p, [35, 15], 5, [40, 20])!;
    expect(arc.from).toBeCloseTo(0, 9);
    expect(arc.sweep).toBeCloseTo(Math.PI / 2, 9);
    expect(arc.mid[0]).toBeCloseTo(35 + 5 * Math.SQRT1_2, 9);
    // Drawn the other way round, it's the same arc.
    const back = { ...p, visible: [arcLine(35, 15, 5, 90, 0)] };
    expect(arcOf(back, [35, 15], 5, [40, 20])!.from).toBeCloseTo(0, 9);
    // Across the ±180° line.
    const left = { ...p, visible: [arcLine(0, 0, 5, 150, 210)] };
    const la = arcOf(left, [0, 0], 5, [-5, 0])!;
    expect(la.sweep).toBeCloseTo(Math.PI / 3, 9);
    expect(la.mid[0]).toBeCloseTo(-5, 9);
    // A whole circle isn't an arc.
    expect(arcOf({ ...p, visible: [arcLine(0, 0, 5, 0, 360)] }, [0, 0], 5, [5, 0])).toBeNull();
  });

  it("measures round the arc and follows it when the part changes", () => {
    const p = sideView(5);
    const arc = arcOf(p, [35, 15], 5, [40, 20])!;
    const dim: Dimension = { id: "l", view: "front", type: "arcLength", a: dimPoint([35, 15], p), r: 5, b: dimPoint(arc.mid, p), offset: 6 };
    const r = resolveDim(dim, p);
    expect(r.found).toBe(true);
    expect(measureDim(dim, r)).toBeCloseTo((5 * Math.PI) / 2, 9);
    expect(dimLabel(dim, measureDim(dim, r))).toBe("7.85");
    // A bigger round: found again (by where it was across the view), measured again.
    const bigger = sideView(8);
    const r2 = resolveDim(dim, bigger);
    expect(r2.found).toBe(true);
    expect(measureDim(dim, r2)).toBeCloseTo((8 * Math.PI) / 2, 9);
    // Gone (a sharp corner): marked as lost.
    const sharp: ViewProjection = { ...p, visible: [[0, 0, 40, 0, 40, 20, 0, 20, 0, 0]], circles: [] };
    expect(resolveDim(dim, sharp).found).toBe(false);
  });

  it("draws an arc round it, with the arc sign over the number", () => {
    const p = sideView(5);
    const arc = arcOf(p, [35, 15], 5, [40, 20])!;
    const dim: Dimension = { id: "l", view: "front", type: "arcLength", a: dimPoint([35, 15], p), r: 5, b: dimPoint(arc.mid, p), offset: 6 };
    const r = resolveDim(dim, p);
    const drawn = drawDimension(dim, r, (q) => q, measureDim(dim, r));
    const paths = drawn.prims.filter((x): x is Extract<Prim, { kind: "path" }> => x.kind === "path");
    // The dimension arc: every point 11 from the centre, a quarter turn.
    const dimArc = paths.find((x) => x.points.length > 10 && x.points.every((v, i) => (i % 2 ? true : Math.abs(Math.hypot(v - 35, x.points[i + 1] - 15) - 11) < 1e-9)))!;
    expect(dimArc).toBeDefined();
    expect(dimArc.points.slice(0, 2).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([46, 15]);
    // Two lines out from the arc's ends, two arrows.
    expect(paths.filter((x) => x.fill)).toHaveLength(2);
    const t = drawn.prims.find((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text")!;
    expect(t.text).toBe("7.85");
    // Outside the arc, beyond its middle.
    expect(Math.hypot(t.x - 35, t.y - 15)).toBeGreaterThan(11);
    // The arc sign: a small curve just above the number.
    const sign = paths[paths.length - 1];
    expect(Math.min(...sign.points.filter((_, i) => i % 2 === 1))).toBeGreaterThan(t.y + t.size * 0.75);
    expect(dragDimension(dim, [35, 15], null, 5, [35, 35])).toEqual({ offset: 15 });
    // Saved and opened again.
    const d = putDimension({ ...newDrawing(), views: [{ id: "f", kind: "front" }] }, dim);
    expect(parseDrawings([d])[0].dimensions).toEqual([dim]);
    // (An arc length without its point on the arc isn't kept.)
    expect(parseDrawings([{ ...d, dimensions: [{ ...dim, b: undefined }] }])[0].dimensions).toBeUndefined();
  });
});

describe("dimension arrows inside or outside", () => {
  type P = [number, number];
  const same = (p: P) => p;
  /** The filled arrowheads: tip, and the middle of the back (the side the arrow comes from). */
  const heads = (prims: Prim[]) =>
    prims.flatMap((p) => (p.kind === "path" && p.fill ? [{ tip: [p.points[0], p.points[1]] as P, back: [(p.points[2] + p.points[4]) / 2, (p.points[3] + p.points[5]) / 2] as P }] : []));
  const lines = (prims: Prim[]) => prims.flatMap((p) => (p.kind === "path" && !p.fill ? [p.points] : []));
  const close = (a: P, b: P) => {
    expect(a[0]).toBeCloseTo(b[0], 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
  };
  const pt = (x: number, y: number) => ({ at: [x, y] as P, rel: [0, 0] as P });
  const length = (b: number, extra: Partial<Dimension> = {}): Dimension => ({ id: "w", view: "front", type: "horizontal", a: pt(0, 0), b: pt(b, 0), offset: 8, ...extra });
  const draw = (dim: Dimension, style = {}) => drawDimension(dim, { a: dim.a.at, b: dim.b?.at, r: dim.r, found: true }, same, 0, null, style);

  it("draws a long length's arrows inside, pointing out, unless set outside", () => {
    // The dimension line runs from (0, 8) to (40, 8).
    const auto = draw(length(40));
    expect(auto.arrows).toBe("inside");
    const [h1, h2] = heads(auto.prims);
    close(h1.tip, [0, 8]);
    close(h1.back, [3, 8]);
    close(h2.tip, [40, 8]);
    close(h2.back, [37, 8]);
    // Inside is what automatic draws here, exactly.
    expect(draw(length(40, { arrows: "inside" })).prims).toEqual(auto.prims);

    const out = draw(length(40, { arrows: "outside" }));
    expect(out.arrows).toBe("outside");
    const [o1, o2] = heads(out.prims);
    close(o1.tip, [0, 8]);
    close(o1.back, [-3, 8]);
    close(o2.tip, [40, 8]);
    close(o2.back, [43, 8]);
    // A short leader past each extension line, under its arrow (6 mm: twice the arrow).
    expect(ARROW_LEADER).toBe(6);
    const extra = lines(out.prims).filter((l) => !lines(auto.prims).some((m) => JSON.stringify(m) === JSON.stringify(l)));
    expect(extra).toEqual([
      [0, 8, -6, 8],
      [40, 8, 46, 8],
    ]);
    // Nothing else changes: the extension lines, the dimension line and the number are where they were.
    expect(out.prims.filter((p) => !(p.kind === "path" && p.fill)).length).toBe(auto.prims.filter((p) => !(p.kind === "path" && p.fill)).length + 2);
    expect(out.label).toEqual(auto.label);
  });

  it("points a short length's arrows in from outside automatically (no leaders, as before), or inside when asked", () => {
    const auto = draw(length(4));
    expect(auto.arrows).toBe("outside");
    const [a1, a2] = heads(auto.prims);
    close(a1.back, [-3, 8]);
    close(a2.back, [7, 8]);
    // Automatic draws no leaders (exactly as before); set outside, it does.
    expect(lines(auto.prims)).toHaveLength(3);
    expect(lines(draw(length(4, { arrows: "outside" })).prims)).toHaveLength(5);
    const inside = draw(length(4, { arrows: "inside" }));
    expect(inside.arrows).toBe("inside");
    const [i1, i2] = heads(inside.prims);
    close(i1.tip, [0, 8]);
    close(i1.back, [3, 8]);
    close(i2.tip, [4, 8]);
    close(i2.back, [1, 8]);
  });

  it("runs a slanted (aligned) dimension's leaders along it", () => {
    // From (0, 0) to (30, 40): 50 long; the line sits 8 out to its left.
    const dim: Dimension = { id: "s", view: "front", type: "aligned", a: pt(0, 0), b: pt(30, 40), offset: 8 };
    const out = draw({ ...dim, arrows: "outside" });
    const u: P = [0.6, 0.8];
    const la: P = [-0.8 * 8, 0.6 * 8];
    const lb: P = [30 + la[0], 40 + la[1]];
    const [h1, h2] = heads(out.prims);
    close(h1.tip, la);
    close(h1.back, [la[0] - 3 * u[0], la[1] - 3 * u[1]]);
    close(h2.tip, lb);
    close(h2.back, [lb[0] + 3 * u[0], lb[1] + 3 * u[1]]);
    const leaders = lines(out.prims).slice(-2);
    const [s0, s1] = [leaders[0], leaders[1]];
    close([s0[0], s0[1]], la);
    close([s0[2], s0[3]], [la[0] - 6 * u[0], la[1] - 6 * u[1]]);
    close([s1[0], s1[1]], lb);
    close([s1[2], s1[3]], [lb[0] + 6 * u[0], lb[1] + 6 * u[1]]);
  });

  it("puts a radius's arrow outside the arc pointing in (as before), or inside pointing out", () => {
    // Radius 10 round (0, 0), leader at 0° (straight out to the right).
    const dim: Dimension = { id: "r", view: "front", type: "radius", a: pt(0, 0), r: 10, offset: 5, angle: 0 };
    const auto = draw(dim);
    expect(auto.arrows).toBe("outside");
    const [h] = heads(auto.prims);
    close(h.tip, [10, 0]);
    close(h.back, [13, 0]);
    expect(draw({ ...dim, arrows: "outside" }).prims).toEqual(auto.prims);
    const inside = draw({ ...dim, arrows: "inside" });
    expect(inside.arrows).toBe("inside");
    const [i] = heads(inside.prims);
    close(i.tip, [10, 0]);
    close(i.back, [7, 0]);
    // Same leader and number.
    expect(lines(inside.prims)).toEqual(lines(auto.prims));
    expect(inside.label).toEqual(auto.label);
  });

  it("puts a diameter's arrows outside (as before, plus a leader past the far side when set) or across inside", () => {
    const dim: Dimension = { id: "d", view: "front", type: "diameter", a: pt(0, 0), r: 10, offset: 5, angle: 0 };
    const auto = draw(dim);
    expect(auto.arrows).toBe("outside");
    const [n1, f1] = heads(auto.prims);
    close(n1.tip, [10, 0]);
    close(n1.back, [13, 0]);
    close(f1.tip, [-10, 0]);
    close(f1.back, [-13, 0]);
    const inside = draw({ ...dim, arrows: "inside" });
    const [n2, f2] = heads(inside.prims);
    close(n2.tip, [10, 0]);
    close(n2.back, [7, 0]);
    close(f2.tip, [-10, 0]);
    close(f2.back, [-7, 0]);
    const out = draw({ ...dim, arrows: "outside" });
    expect(heads(out.prims)).toEqual(heads(auto.prims));
    expect(lines(out.prims)).toEqual([...lines(auto.prims), [-10, 0, -16, 0]]);
  });

  it("follows the drawing's setting unless the dimension has its own, and only for lengths, diameters and radii", () => {
    expect(dimStyle({ dimArrows: "outside" })).toEqual({ arrows: "outside" });
    expect(dimStyle({})).toEqual({});
    expect(arrowsFor(length(40), dimStyle({ dimArrows: "outside" }))).toBe("outside");
    expect(arrowsFor(length(40, { arrows: "inside" }), dimStyle({ dimArrows: "outside" }))).toBe("inside");
    expect(arrowsFor(length(40), {})).toBeUndefined();
    expect(draw(length(40), { arrows: "outside" }).prims).toEqual(draw(length(40, { arrows: "outside" })).prims);
    // Angles, ordinates, chamfers and arc lengths aren't changed by it.
    const angle: Dimension = { id: "a", view: "front", type: "angle", a: pt(0, 0), b: pt(10, 0), c: pt(0, 0), d: pt(10, 10), offset: 10 };
    expect(arrowsFor(angle, { arrows: "outside" })).toBeUndefined();
    const r = { a: angle.a.at, b: angle.b!.at, c: angle.c!.at, d: angle.d!.at, found: true };
    expect(drawDimension(angle, r, same, 45, null, { arrows: "outside" }).prims).toEqual(drawDimension(angle, r, same, 45, null, {}).prims);
    const ord: Dimension = { id: "o", view: "front", type: "ordinate", a: pt(0, 0), b: pt(10, 5), offset: 8, axis: "h" };
    expect(draw(ord, { arrows: "inside" }).prims).toEqual(draw(ord).prims);
    expect(draw(ord).arrows).toBeUndefined();
  });

  it("flips to the other way from how they're drawn", () => {
    expect(flipArrows("inside")).toBe("outside");
    expect(flipArrows("outside")).toBe("inside");
  });

  it("is kept in saved files (dimensions and the drawing's setting), and old files have neither", () => {
    const d = { ...newDrawing(), dimArrows: "outside" as const, dimensions: [length(40, { arrows: "inside" }), { ...length(30), id: "x" }] };
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(back.dimArrows).toBe("outside");
    expect(back.dimensions![0].arrows).toBe("inside");
    expect("arrows" in back.dimensions![1]).toBe(false);
    // Nonsense, or on a dimension without arrows to set, is dropped.
    const odd = parseDrawings([{ ...d, dimArrows: "sideways", dimensions: [{ ...length(40), arrows: "up" }, { id: "o", view: "front", type: "ordinate", a: pt(0, 0), b: pt(1, 1), offset: 8, axis: "h", arrows: "inside" }] }])[0];
    expect("dimArrows" in odd).toBe(false);
    expect(odd.dimensions!.every((x) => !("arrows" in x))).toBe(true);
    const old = parseDrawings([{ ...newDrawing(), dimensions: [length(40)] }])[0];
    expect("dimArrows" in old).toBe(false);
    expect("arrows" in old.dimensions![0]).toBe(false);
  });

  it("draws the same on the sheet and in SVG, DXF and PDF, and reports which way they went", () => {
    const front: ViewProjection = { kind: "front", visible: [[0, 0, 40, 0, 40, 20, 0, 20, 0, 0]], hidden: [], circles: [], points: [0, 0, 40, 0, 40, 20, 0, 20], bounds: [0, 0, 40, 20] };
    const base: Drawing = { ...newDrawing(), scale: 1, views: [{ id: "f", kind: "front" }] };
    const dim: Dimension = { id: "w", view: "front", type: "horizontal", a: dimPoint([0, 20], front), b: dimPoint([40, 20], front), offset: 8 };
    const auto = layoutSheet(putDimension(base, dim), { front }, info);
    const out = layoutSheet(putDimension(base, { ...dim, arrows: "outside" }), { front }, info);
    expect(auto.dims[0].arrows).toBe("inside");
    expect(out.dims[0].arrows).toBe("outside");
    const [la, lb] = [auto.dims[0].a, auto.dims[0].b!].map((p) => [p[0], p[1] + 8] as P);
    const mine = out.prims.slice(out.dims[0].from, out.dims[0].to);
    const leaders = lines(mine).filter((l) => l.length === 4 && Math.abs(Math.abs(l[2] - l[0]) - 6) < 1e-9 && l[1] === l[3]);
    expect(leaders).toHaveLength(2);
    close([leaders[0][2], leaders[0][3]], [la[0] - 6, la[1]]);
    close([leaders[1][2], leaders[1][3]], [lb[0] + 6, lb[1]]);
    // Every file is made from the same shapes, so each has the leaders.
    const f = (v: number) => String(Math.round(v * 1000) / 1000);
    const svg = sheetSvg(out.prims, out.size);
    expect(svg).toContain(`points="${f(la[0])},${f(out.size[1] - la[1])} ${f(la[0] - 6)},${f(out.size[1] - la[1])}"`);
    expect(sheetSvg(auto.prims, auto.size)).not.toContain(`${f(la[0] - 6)},${f(out.size[1] - la[1])}`);
    const dxf = sheetDxf(out.prims);
    expect(dxf).toContain(`10\n${f(lb[0])}\n20\n${f(lb[1])}\n30\n0\n11\n${f(lb[0] + 6)}\n21\n${f(lb[1])}`);
    const pdf = new TextDecoder().decode(sheetPdf(out.prims, out.size));
    const autoPdf = new TextDecoder().decode(sheetPdf(auto.prims, auto.size));
    const pt = (v: number) => String(Math.round(v * (72 / 25.4) * 1000) / 1000);
    const leaderOp = `${pt(la[0])} ${pt(la[1])} m ${pt(la[0] - 6)} ${pt(la[1])} l S`;
    expect(pdf).toContain(leaderOp);
    expect(autoPdf).not.toContain(leaderOp);
  });

  it("leaves a drawing without the setting exactly as it was", () => {
    // A 40 mm length and a 10 mm diameter: shapes pinned to the numbers they've always had.
    const auto = draw(length(40));
    expect(heads(auto.prims).map((h) => [...h.tip, ...h.back])).toEqual([
      [0, 8, 3, 8],
      [40, 8, 37, 8],
    ]);
    expect(lines(auto.prims)).toEqual([
      [0, 1, 0, 10],
      [40, 1, 40, 10],
      [0, 8, 40, 8],
    ]);
  });
});
