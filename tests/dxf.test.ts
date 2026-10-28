import { describe, expect, it } from "vitest";

import { insertDxf, insertSummary, parseDxf, sampleSpline } from "../src/sketch/dxf";
import { pointPos, radiusOf } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { emptySketch, type SketchData } from "../src/sketch/types";

/** A DXF file from its entities' group codes (code, value, code, value…), with optional $INSUNITS. */
function dxf(entities: (string | number)[][], units?: number): string {
  const head = units === undefined ? [] : ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(units), "0", "ENDSEC"];
  const body = entities.flatMap((e) => e.map(String));
  return [...head, "0", "SECTION", "2", "ENTITIES", ...body, "0", "ENDSEC", "0", "EOF"].join("\n");
}

const rect = [
  ["0", "LINE", 8, "0", 10, 0, 20, 0, 11, 40, 21, 0],
  ["0", "LINE", 8, "0", 10, 40, 20, 0, 11, 40, 21, 20],
  ["0", "LINE", 8, "0", 10, 40, 20, 20, 11, 0, 21, 20],
  ["0", "LINE", 8, "0", 10, 0, 20, 20, 11, 0, 21, 0],
];
const pos = (s: SketchData, id: string) => pointPos(s, id).map((v) => Math.round(v * 1e6) / 1e6);
const areaOf = (s: SketchData) => findRegions(s).regions.reduce((t, r) => t + r.outer.area - r.holes.reduce((h, x) => h + x.area, 0), 0);

describe("Insert DXF", () => {
  it("brings in lines joined at their corners, so the outline is closed", () => {
    const d = parseDxf(dxf(rect));
    expect(d.entities).toHaveLength(4);
    const r = insertDxf(emptySketch(), d, 1);
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(4);
    expect(r.sketch.points).toHaveLength(4);
    expect(r.sketch.constraints).toHaveLength(0);
    expect(areaOf(r.sketch)).toBeCloseTo(800, 9);
  });

  it("uses the file's units, times the scale", () => {
    const inches = parseDxf(dxf(rect, 1));
    expect(inches.unitMm).toBe(25.4);
    const r = insertDxf(emptySketch(), inches, 0.5);
    const xs = r.sketch.points.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(40 * 25.4 * 0.5, 9);
    expect(insertSummary(inches, r.count, 0.5)).toBe("Brought in 4 shapes. The file is in inches, scaled × 0.5.");
    const plain = parseDxf(dxf(rect));
    expect(plain.unitMm).toBeNull();
    expect(insertSummary(plain, 4, 1)).toBe("Brought in 4 shapes. The file doesn't say its units, so 1 unit = 1 mm.");
    expect(insertDxf(emptySketch(), plain, 0).error).toMatch(/scale must be more than 0/);
  });

  it("circles and arcs (anticlockwise, in degrees)", () => {
    const d = parseDxf(
      dxf([
        ["0", "CIRCLE", 10, 5, 20, 6, 40, 3],
        ["0", "ARC", 10, 0, 20, 0, 40, 10, 50, 0, 51, 90],
      ]),
    );
    const r = insertDxf(emptySketch(), d, 2);
    const circle = r.sketch.curves.find((c) => c.type === "circle")!;
    const arc = r.sketch.curves.find((c) => c.type === "arc")!;
    expect(circle.type === "circle" && circle.radius).toBe(6);
    expect(circle.type === "circle" && pos(r.sketch, circle.center)).toEqual([10, 12]);
    if (arc.type !== "arc") throw new Error("no arc");
    expect(pos(r.sketch, arc.start)).toEqual([20, 0]);
    expect(pos(r.sketch, arc.end)).toEqual([0, 20]);
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(20, 9);
  });

  it("a closed polyline with a bulge (a slot: two straight sides and two half circles)", () => {
    // From (0,0) to (20,0), half circle up to (20,10), back to (0,10), half circle down to (0,0).
    const d = parseDxf(dxf([["0", "LWPOLYLINE", 90, 4, 70, 1, 10, 0, 20, 0, 10, 20, 20, 0, 42, 1, 10, 20, 20, 10, 10, 0, 20, 10, 42, 1]]));
    const r = insertDxf(emptySketch(), d, 1);
    expect(r.sketch.curves.map((c) => c.type)).toEqual(["line", "arc", "line", "arc"]);
    const arcs = r.sketch.curves.filter((c) => c.type === "arc");
    const centres = arcs.map((a) => (a.type === "arc" ? pos(r.sketch, a.center) : []));
    expect(centres).toEqual([
      [20, 5],
      [0, 5],
    ]);
    // 20 × 10 plus a whole circle of radius 5.
    expect(areaOf(r.sketch)).toBeCloseTo(200 + Math.PI * 25, 0); // (round pieces are measured as straight pieces)
    for (const a of arcs) expect(a.type === "arc" && radiusOf(r.sketch, a)).toBeCloseTo(5, 9);
  });

  it("an old-style POLYLINE with VERTEX entities", () => {
    const d = parseDxf(
      dxf([
        ["0", "POLYLINE", 66, 1, 70, 1],
        ["0", "VERTEX", 10, 0, 20, 0],
        ["0", "VERTEX", 10, 10, 20, 0],
        ["0", "VERTEX", 10, 0, 20, 10],
        ["0", "SEQEND"],
      ]),
    );
    expect(d.entities).toHaveLength(1);
    const r = insertDxf(emptySketch(), d, 1);
    expect(r.sketch.curves).toHaveLength(3);
    expect(areaOf(r.sketch)).toBeCloseTo(50, 9);
  });

  it("splines: through their fit points, or along their control points", () => {
    const fit = parseDxf(dxf([["0", "SPLINE", 70, 8, 71, 3, 74, 3, 11, 0, 21, 0, 11, 5, 21, 5, 11, 10, 21, 0]]));
    const r = insertDxf(emptySketch(), fit, 1);
    const sp = r.sketch.curves[0];
    expect(sp.type).toBe("spline");
    if (sp.type !== "spline") return;
    expect(sp.points.map((id) => pos(r.sketch, id))).toEqual([
      [0, 0],
      [5, 5],
      [10, 0],
    ]);
    // A quadratic Bézier as a B-spline: (0,0) (5,10) (10,0); its middle is at (5, 5).
    const ctl = parseDxf(dxf([["0", "SPLINE", 70, 8, 71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 10, 0, 20, 0, 10, 5, 20, 10, 10, 10, 20, 0]]));
    const e = ctl.entities[0];
    if (e.kind !== "spline") throw new Error("no spline");
    const pts = sampleSpline(e);
    expect(pts[0]).toEqual([0, 0]);
    const mid = pts[(pts.length - 1) / 2];
    expect(mid[0]).toBeCloseTo(5, 9);
    expect(mid[1]).toBeCloseTo(5, 9);
    expect(pts[pts.length - 1][0]).toBeCloseTo(10, 6);
  });

  it("a whole ellipse comes in as an ellipse", () => {
    const d = parseDxf(dxf([["0", "ELLIPSE", 10, 1, 20, 2, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, 6.283185307179586]]));
    const r = insertDxf(emptySketch(), d, 1);
    const el = r.sketch.curves[0];
    expect(el.type).toBe("ellipse");
    if (el.type !== "ellipse") return;
    expect(pos(r.sketch, el.major)).toEqual([11, 2]);
    expect(pos(r.sketch, el.minor)).toEqual([1, 7]);
    expect(areaOf(r.sketch)).toBeCloseTo(Math.PI * 10 * 5, 0);
  });

  it("part of an ellipse comes in as part of an ellipse, its ends joined to what meets them", () => {
    // Half an ellipse (long axis 10 along X turned 90°: along Y), from the top round the left to the bottom, closed by a line.
    const d = parseDxf(
      dxf([
        ["0", "ELLIPSE", 10, 0, 20, 0, 11, 0, 21, 10, 40, 0.5, 41, 0, 42, Math.PI],
        ["0", "LINE", 10, 0, 20, -10, 11, 0, 21, 10],
      ]),
    );
    const r = insertDxf(emptySketch(), d, 2);
    expect(r.count).toBe(2);
    const [el, ln] = r.sketch.curves;
    expect(el.type).toBe("ellipse");
    if (el.type !== "ellipse" || ln.type !== "line") return;
    expect(pos(r.sketch, el.center)).toEqual([0, 0]);
    expect(pos(r.sketch, el.major)).toEqual([0, 20]);
    expect(pos(r.sketch, el.minor)).toEqual([-10, 0]);
    expect(pos(r.sketch, el.start!)).toEqual([0, 20]);
    expect(pos(r.sketch, el.end!)).toEqual([0, -20]);
    // The line's ends are the arc's ends (one point each), so the half ellipse is a closed shape.
    expect([ln.p1, ln.p2].sort()).toEqual([el.start!, el.end!].sort());
    expect(r.sketch.points).toHaveLength(5);
    // (Areas are measured on the outline drawn as short straight pieces.)
    expect(areaOf(r.sketch)).toBeCloseTo((Math.PI * 20 * 10) / 2, 0);
  });

  it("part of an ellipse running past a whole turn's start still goes anticlockwise", () => {
    // From 3/2·π round through 0 to ½π: the right-hand half.
    const d = parseDxf(dxf([["0", "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 1.5 * Math.PI, 42, 0.5 * Math.PI]]));
    const r = insertDxf(emptySketch(), d, 1);
    const el = r.sketch.curves[0];
    if (el.type !== "ellipse") throw new Error("not an ellipse");
    expect(pos(r.sketch, el.start!)).toEqual([0, -5]);
    expect(pos(r.sketch, el.end!)).toEqual([0, 5]);
  });

  it("says what it left out, and explains a file it can't use", () => {
    const d = parseDxf(dxf([...rect, ["0", "TEXT", 1, "hello"], ["0", "HATCH"], ["0", "HATCH"]]));
    expect(d.skipped).toEqual({ TEXT: 1, HATCH: 2 });
    expect(insertSummary(d, 4, 1)).toMatch(/Left out: 1 TEXT, 2 HATCH/);
    const onlyText = parseDxf(dxf([["0", "TEXT", 1, "hello"]]));
    expect(insertDxf(emptySketch(), onlyText, 1).error).toMatch(/only has TEXT/);
    expect(() => parseDxf("hello\nworld")).toThrow(/doesn't look like a DXF/);
  });

  it("adds to what's already in the sketch", () => {
    const first = insertDxf(emptySketch(), parseDxf(dxf(rect)), 1).sketch;
    const second = insertDxf(first, parseDxf(dxf([["0", "CIRCLE", 10, 20, 20, 10, 40, 4]])), 1);
    expect(second.sketch.curves).toHaveLength(5);
    expect(areaOf(second.sketch)).toBeCloseTo(800 - Math.PI * 16, 0);
  });
});

describe("Insert DXF with broken or huge files", () => {
  it("huge angles don't hang: arcs and ellipses come in within one turn", () => {
    for (const a0 of [1e20, 1e300]) {
      const d = parseDxf(dxf([["0", "ARC", 10, 0, 20, 0, 40, 10, 50, a0, 51, 90]]));
      const r = insertDxf(emptySketch(), d, 1);
      expect(r.error).toBeUndefined();
      expect(r.sketch.curves[0].type).toBe("arc");
    }
    const e = parseDxf(dxf([["0", "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 1e18, 42, 1e18 + 1]]));
    expect(insertDxf(emptySketch(), e, 1).count).toBe(1);
    // Parameters 0 to 1e9 (far more than a turn): a whole ellipse.
    const big = parseDxf(dxf([["0", "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, 1e9]]));
    const r = insertDxf(emptySketch(), big, 1);
    expect(r.sketch.curves.map((c) => c.type)).toEqual(["ellipse"]);
    // Part of an ellipse with huge but close parameters: part of an ellipse, its ends within one turn.
    const part = parseDxf(dxf([["0", "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 1e6, 42, 1e6 + 1]]));
    const pr = insertDxf(emptySketch(), part, 1).sketch;
    const el = pr.curves[0];
    expect(el.type === "ellipse" && !!el.start && !!el.end).toBe(true);
    if (el.type !== "ellipse") return;
    const t0 = 1e6 % (2 * Math.PI);
    expect(pointPos(pr, el.start!)[0]).toBeCloseTo(10 * Math.cos(t0), 6);
    expect(pointPos(pr, el.start!)[1]).toBeCloseTo(5 * Math.sin(t0), 6);
  });

  it("shapes with numbers that aren't numbers are left out, and said so", () => {
    const d = parseDxf(dxf([...rect, ["0", "LWPOLYLINE", 90, 2, 70, 0, 10, "abc", 20, 0, 10, 5, 20, 5], ["0", "LINE", 10, 0, 20, "1e999", 11, 1, 21, 1]]));
    expect(d.entities).toHaveLength(4);
    expect(d.skipped).toEqual({ "shapes with unreadable numbers": 2 });
    const r = insertDxf(emptySketch(), d, 1);
    expect(r.sketch.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it("refuses drawings with too many shapes, or too big a file, kindly", () => {
    const many = Array.from({ length: 20001 }, (_, i) => ["0", "LINE", 10, i, 20, 0, 11, i, 21, 1]);
    expect(() => parseDxf(dxf(many))).toThrow(/more than 20,000 shapes/);
    const lines = Array.from({ length: 20000 }, (_, i) => ["0", "LINE", 10, i, 20, 0, 11, i, 21, 1]);
    expect(parseDxf(dxf(lines)).entities).toHaveLength(20000);
    expect(() => parseDxf("0\nSECTION\n" + " ".repeat(21 * 1024 * 1024))).toThrow(/too big/);
  });
});

describe("Insert DXF: one very long polyline", () => {
  it("is refused kindly when it has too many points", () => {
    const pts = Array.from({ length: 50001 }, (_, i) => [10, i, 20, i % 2]).flat();
    expect(() => parseDxf(dxf([["0", "LWPOLYLINE", 90, 50001, 70, 0, ...pts]]))).toThrow(/more than 50,000 points/);
  });
});
