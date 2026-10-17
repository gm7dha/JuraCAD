/**
 * Drawing sheets: paper sizes, first- and third-angle layouts, the title
 * block, dimension precision/units/frames, and the files saved from them.
 */
import { describe, expect, it } from "vitest";

import { addDetail, detailProjection, withDetails } from "../src/drawing/details";
import { addDrawing, arrangeLinedUp, parseDrawings, projectionKinds, toggleView } from "../src/drawing/drawing";
import { autoDimensions } from "../src/drawing/autoDimension";
import { advanceRun, nextLinear, startRun } from "../src/drawing/linearDims";
import { calloutLines } from "../src/drawing/holeCallouts";
import { missedSections } from "../src/drawing/sections";
import { dimLabel, dimPoint, drawDimension, resolveDim } from "../src/drawing/dimensions";
import { dxfText, sheetDxf, sheetPdf } from "../src/drawing/export";
import { dimsClear, fitScale, fitSize, layoutSheet, projectionSymbol, SHEETS, type Prim, type Projections } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension, Drawing, ViewKind } from "../src/model/types";
import { setLengthUnit } from "../src/model/units";

function rectView(kind: ViewKind, w: number, h: number, extra: Partial<ViewProjection> = {}): ViewProjection {
  return { kind, visible: [[0, 0, w, 0, w, h, 0, h, 0, 0]], hidden: [], circles: [], points: [0, 0, w, 0, w, h, 0, h], bounds: [0, 0, w, h], ...extra };
}
/** A 40 (X) × 30 (Y) × 20 (Z) block. */
const block = { front: rectView("front", 40, 20), top: rectView("top", 40, 30), right: rectView("right", 30, 20), left: rectView("left", 30, 20), bottom: rectView("bottom", 40, 30), iso: rectView("iso", 50, 45) };
const info = { designName: "Bracket design", subject: "Bracket", date: "14/10/2026" };
const newDrawing = (): Drawing => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
const texts = (prims: Prim[]) => prims.flatMap((p) => (p.kind === "text" ? [p] : []));
const textOf = (prims: Prim[], t: string) => texts(prims).find((p) => p.text === t);

describe("paper sizes", () => {
  it("has ISO A0–A4 and US ANSI A–E sheets, and old files keep theirs", () => {
    expect(SHEETS.A0).toEqual([1189, 841]);
    expect(SHEETS.A1).toEqual([841, 594]);
    expect(SHEETS["ANSI A"]).toEqual([279.4, 215.9]);
    expect(SHEETS["ANSI E"]).toEqual([1117.6, 863.6]);
    const [d] = parseDrawings([{ ...newDrawing(), sheet: "ANSI B", projection: "third" }]);
    expect([d.sheet, d.projection]).toEqual(["ANSI B", "third"]);
    const [old] = parseDrawings([{ ...newDrawing(), sheet: "B5", projection: "fourth" }]);
    expect([old.sheet, old.projection]).toEqual(["A4", undefined]);
    // A big sheet fits a bigger scale.
    expect(fitScale(block, ["front", "top", "right"], "A0").scale).toBe(10);
  });

  it("starts designs in inches on US paper, arranged third-angle", () => {
    const d = addDrawing({ ...emptyDocument(), units: "in" }, "d1", null).drawings![0];
    expect([d.sheet, d.projection]).toEqual(["ANSI A", "third"]);
    expect(newDrawing().projection).toBeUndefined();
  });

  it("has scales for very small and very large parts", () => {
    const tiny = { front: rectView("front", 0.5, 0.3), top: rectView("top", 0.5, 0.4) };
    expect(fitScale(tiny, ["front", "top"], "A4").scale).toBe(100);
    const huge = { front: rectView("front", 20000, 2000) };
    expect(fitScale(huge, ["front"], "A4")).toEqual({ scale: 0.01, fits: true });
    const bigger = { front: rectView("front", 40000, 2000) };
    expect(fitScale(bigger, ["front"], "A4")).toEqual({ scale: 0.005, fits: true });
  });
});

describe("first- and third-angle layouts", () => {
  const views = ["front", "top", "right", "left", "bottom", "iso"].map((k) => ({ id: k, kind: k as ViewKind }));

  it("first angle: top below the front, right to its left", () => {
    const l = layoutSheet({ ...newDrawing(), sheet: "A3", views }, block, info);
    const at = (k: string) => l.views.find((v) => v.key === k)!;
    expect(at("top").box[3]).toBeLessThan(at("front").box[1]);
    expect(at("bottom").box[1]).toBeGreaterThan(at("front").box[3]);
    expect(at("right").box[2]).toBeLessThan(at("front").box[0]);
    expect(at("left").box[0]).toBeGreaterThan(at("front").box[2]);
  });

  it("third angle: top above the front, right to its right, still lined up", () => {
    const l = layoutSheet({ ...newDrawing(), sheet: "A3", views, projection: "third" }, block, info);
    const at = (k: string) => l.views.find((v) => v.key === k)!;
    const front = at("front");
    expect(at("top").box[1]).toBeGreaterThan(front.box[3]);
    expect(at("bottom").box[3]).toBeLessThan(front.box[1]);
    expect(at("right").box[0]).toBeGreaterThan(front.box[2]);
    expect(at("left").box[2]).toBeLessThan(front.box[0]);
    expect(at("top").centre[0]).toBeCloseTo(front.centre[0], 9);
    expect(at("right").centre[1]).toBeCloseTo(front.centre[1], 9);
    // The 3D view is still off to the side, clear of the others.
    for (const k of ["front", "top", "right", "left", "bottom"]) expect(at("iso").box[0]).toBeGreaterThan(at(k).box[2]);
  });

  it("draws the right projection symbol: first angle has the circles right of the cone, third angle left", () => {
    const centreX = (prims: Prim[]) => {
      const circle = prims[0] as Extract<Prim, { kind: "path" }>;
      const xs = circle.points.filter((_, i) => i % 2 === 0);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const cone = (prims: Prim[]) => (prims[2] as Extract<Prim, { kind: "path" }>).points;
    const first = projectionSymbol(0, 0, false);
    const third = projectionSymbol(0, 0, true);
    // The cone's narrow end is on its left in both.
    for (const p of [first, third]) {
      const pts = cone(p);
      expect(Math.abs(pts[1] - pts[7])).toBeLessThan(Math.abs(pts[3] - pts[5]));
      expect(pts[0]).toBeLessThan(pts[2]);
    }
    expect(centreX(first)).toBeGreaterThan(Math.max(...cone(first).filter((_, i) => i % 2 === 0)));
    expect(centreX(third)).toBeLessThan(Math.min(...cone(third).filter((_, i) => i % 2 === 0)));
  });
});

describe("title block", () => {
  it("shows the part number, company and latest revision, shrinking long text to fit", () => {
    const long = "A very long title that would never fit in the title block at full size";
    const d: Drawing = {
      ...newDrawing(),
      title: { title: long, partNumber: "BRK-001", company: "Sam's Workshop" },
      revisions: [
        { id: "r1", rev: "A", description: "First issue", date: "1/1/2026" },
        { id: "r2", rev: "B", description: "Hole moved", date: "2/1/2026" },
      ],
    };
    const l = layoutSheet(d, block, info);
    for (const t of ["PART NO.", "BRK-001", "COMPANY", "Sam's Workshop", "REV"]) expect(textOf(l.prims, t)).toBeDefined();
    // The REV box shows the latest letter (B), to the right of the part number.
    const revs = texts(l.prims).filter((t) => t.text === "B");
    expect(revs.some((t) => t.x > textOf(l.prims, "BRK-001")!.x)).toBe(true);
    // The long title is made smaller to fit its 118 mm box.
    const title = textOf(l.prims, long)!;
    expect(title.size).toBeLessThan(5);
    expect(fitSize(long, 115, 5, true)).toBe(title.size);
    expect(fitSize("Short", 115, 5)).toBe(5);
    // Saved and opened again.
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0].title).toEqual(d.title);
  });
});

describe("dimension formatting", () => {
  const view = rectView("front", 40, 20);
  const length: Dimension = { id: "x", view: "front", type: "horizontal", a: dimPoint([0, 0], view), b: dimPoint([40, 0], view), offset: 8 };
  const angle: Dimension = { ...length, type: "angle", c: dimPoint([0, 0], view), d: dimPoint([0, 20], view) };

  it("shows a set number of decimal places, for the drawing or one dimension", () => {
    expect(dimLabel(length, 40)).toBe("40");
    expect(dimLabel(length, 40, { places: 2 })).toBe("40.00");
    expect(dimLabel({ ...length, places: 1 }, 12.345, { places: 3 })).toBe("12.3");
    // A tolerance shows at least the set places, and as many more as it needs (never rounded).
    const tol = (places: number, plus: number, minus = plus, d: Dimension = length) => dimLabel({ ...d, places, tolerance: { plus, minus } }, d.type === "angle" ? 45 : 12.5);
    expect(tol(0, 0.1)).toBe("13 ±0.1");
    expect(tol(0, 0.5)).toBe("13 ±0.5");
    expect(tol(1, 0.25)).toBe("12.5 ±0.25");
    expect(tol(1, 0.15, 0.05)).toBe("12.5 +0.15/−0.05");
    expect(tol(0, 0.5, 0.5, angle)).toBe("45° ±0.5°");
    expect(tol(2, 0.1, 0)).toBe("12.50 +0.10/−0.00");
    expect(dimLabel({ ...length, type: "diameter", places: 2 }, 6)).toBe("Ø6.00");
    expect(dimLabel({ ...angle, places: 2 }, 45)).toBe("45.00°");
  });

  it("keeps an angle's tolerance in degrees when the design is in inches", () => {
    setLengthUnit("in");
    try {
      expect(dimLabel({ ...angle, tolerance: { plus: 0.5, minus: 0.5 } }, 45)).toBe("45° ±0.5°");
      expect(dimLabel({ ...length, tolerance: { plus: 0.254, minus: 0.127 } }, 25.4)).toBe("1 +0.01/−0.005");
    } finally {
      setLengthUnit("mm");
    }
  });

  it("can show both units", () => {
    expect(dimLabel(length, 40, { dual: true })).toBe("40 [1.575]");
    expect(dimLabel({ ...length, type: "diameter" }, 10, { dual: true })).toBe("Ø10 [Ø0.394]");
    expect(dimLabel(angle, 30, { dual: true })).toBe("30°");
    setLengthUnit("in");
    try {
      expect(dimLabel(length, 25.4, { dual: true, places: 3 })).toBe("1.000 [25.4]");
    } finally {
      setLengthUnit("mm");
    }
    // On the sheet: the drawing's settings reach every dimension.
    const d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front" }], dualUnits: true, places: 1, dimensions: [length] };
    const l = layoutSheet(d, { front: view }, info);
    expect(textOf(l.prims, "40.0 [1.575]")).toBeDefined();
  });

  it("draws a box (basic) or a rounded box (inspection) round the number", () => {
    const r = resolveDim(length, view);
    const plain = drawDimension(length, r, (p) => p, 40);
    const basic = drawDimension({ ...length, frame: "basic" }, r, (p) => p, 40);
    const check = drawDimension({ ...length, frame: "inspection" }, r, (p) => p, 40);
    expect(basic.prims.length).toBe(plain.prims.length + 1);
    const box = basic.prims[basic.prims.length - 1] as Extract<Prim, { kind: "path" }>;
    expect(box.closed).toBe(true);
    expect(box.points.length).toBe(8);
    // It surrounds the number.
    const t = texts(basic.prims)[0];
    const xs = box.points.filter((_, i) => i % 2 === 0);
    const ys = box.points.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeLessThan(t.x - 2);
    expect(Math.max(...xs)).toBeGreaterThan(t.x + 2);
    expect(Math.min(...ys)).toBeLessThan(t.y);
    expect(Math.max(...ys)).toBeGreaterThan(t.y + 2);
    const oval = check.prims[check.prims.length - 1] as Extract<Prim, { kind: "path" }>;
    expect(oval.points.length).toBeGreaterThan(16);
    // A turned (vertical) dimension's box turns with its number.
    const up: Dimension = { ...length, type: "vertical", b: dimPoint([0, 20], view), frame: "basic" };
    const upBox = drawDimension(up, resolveDim(up, view), (p) => p, 20).prims.at(-1) as Extract<Prim, { kind: "path" }>;
    const w = Math.max(...upBox.points.filter((_, i) => i % 2 === 0)) - Math.min(...upBox.points.filter((_, i) => i % 2 === 0));
    const h = Math.max(...upBox.points.filter((_, i) => i % 2 === 1)) - Math.min(...upBox.points.filter((_, i) => i % 2 === 1));
    expect(h).toBeGreaterThan(w);
  });

  it("gives a flat pattern's bend radii in the design's unit", () => {
    const flat = { ...rectView("flat", 100, 50), bends: [{ line: [50, 0, 50, 50] as [number, number, number, number], angle: 90, radius: 2.54, up: true }] };
    const d: Drawing = { ...newDrawing(), views: [{ id: "fl", kind: "flat" }] };
    setLengthUnit("in");
    try {
      expect(textOf(layoutSheet(d, { flat }, info).prims, "B1: UP 90°  R0.1")).toBeDefined();
    } finally {
      setLengthUnit("mm");
    }
    expect(textOf(layoutSheet(d, { flat }, info).prims, "B1: UP 90°  R2.54")).toBeDefined();
  });

  it("saves and reopens the new settings, dropping junk", () => {
    const d: Drawing = { ...newDrawing(), places: 3, dualUnits: true, tangentEdges: false, dimensions: [{ ...length, places: 2, frame: "inspection" }] };
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0]).toEqual(d);
    const [junk] = parseDrawings([{ ...d, places: 7, dualUnits: "yes", tangentEdges: 0, dimensions: [{ ...length, places: -1, frame: "circle" }] }]);
    expect([junk.places, junk.dualUnits, junk.tangentEdges]).toEqual([undefined, undefined, undefined]);
    expect([junk.dimensions![0].places, junk.dimensions![0].frame]).toEqual([undefined, undefined]);
  });
});

describe("files", () => {
  it("writes a tolerance's minus sign into the PDF as a plain hyphen, not a question mark", () => {
    const prims: Prim[] = [{ kind: "text", x: 10, y: 10, text: "40 +0.2/−0.1", size: 3.5, anchor: "start" }];
    const pdf = new TextDecoder("latin1").decode(sheetPdf(prims, [297, 210]));
    expect(pdf).toContain("(40 +0.2/-0.1) Tj");
  });

  it("writes DXF text as plain ASCII, with signs as DXF codes", () => {
    expect(dxfText("4× Ø6 THRU")).toBe("4\\U+00D7 %%c6 THRU");
    expect(dxfText("45° ±0.5°")).toBe("45%%d %%p0.5%%d");
    expect(dxfText("+0.2/−0.1")).toBe("+0.2/\\U+22120.1");
    const dxf = sheetDxf([{ kind: "text", x: 10, y: 10, text: "Ra 1.6 µm × 2", size: 3.5, anchor: "start" }]);
    expect(/[^\x00-\x7f]/.test(dxf)).toBe(false);
    expect(dxf).toContain("Ra 1.6 \\U+00B5m \\U+00D7 2");
  });
});

describe("detail views keep what their view shows", () => {
  const host = rectView("front", 40, 20, {
    axes: [[10, 0, 10, 20]],
    threadMarks: [{ line: [0, 5, 40, 5], hidden: false }],
    holes: [{ cx: 10, cy: 10, d: 4, through: true, depth: 20 }, { cx: 35, cy: 10, d: 4, through: true, depth: 20 }],
    circles: [{ cx: 10, cy: 10, r: 2, hidden: false, full: true }],
  });
  const detail = { id: "d1", letter: "B", host: "front" as const, centre: [0.25, 0.5] as [number, number], radius: 6, zoom: 2 };

  it("centre lines, thread marks and holes inside the circle", () => {
    const p = detailProjection(host, detail)!;
    expect(p.clipCircle).toEqual([10, 10, 6]);
    expect(p.axes).toEqual([[10, 4, 10, 16]]);
    expect(p.threadMarks!.length).toBe(1);
    expect(p.threadMarks![0].line[0]).toBeCloseTo(10 - Math.sqrt(11), 9);
    expect(p.holes!.map((h) => h.cx)).toEqual([10]);
  });

  it("draws them on the sheet, inside the detail's circle", () => {
    let d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front" }], scale: 1 };
    d = addDetail(d, detail);
    const l = layoutSheet(d, withDetails({ front: host }, d), info);
    const v = l.views.find((x) => x.key === "detail:d1")!;
    const [cx, cy] = v.centre;
    // Every line drawn in the detail view's box stays within its circle (12 mm across × 2).
    const inBox = l.prims.filter((p): p is Extract<Prim, { kind: "path" }> => p.kind === "path" && p.style !== "border" && p.points.every((x, i) => (i % 2 ? Math.abs(x - cy) < 14 : Math.abs(x - cx) < 14)));
    const centre = inBox.filter((p) => p.style === "centre");
    expect(centre.length).toBeGreaterThan(0);
    for (const p of inBox) for (let i = 0; i < p.points.length; i += 2) expect(Math.hypot(p.points[i] - cx, p.points[i + 1] - cy)).toBeLessThan(12 + 1e-6);
  });

  it("are still worked out when the view they're taken from is hidden", () => {
    let d = addDetail(newDrawing(), detail);
    expect(projectionKinds(d)).toEqual(["front", "top", "right", "iso"]);
    d = toggleView(d, "front");
    expect(projectionKinds(d)).toEqual(["top", "right", "iso", "front"]);
    // The front view itself isn't drawn, but its detail is.
    const l = layoutSheet(d, withDetails({ ...block, front: host }, d), info);
    expect(l.views.map((v) => v.key)).toEqual(["top", "right", "iso", "detail:d1"]);
  });
});

describe("review fixes", () => {
  const view = rectView("front", 40, 20);
  const length: Dimension = { id: "x", view: "front", type: "horizontal", a: dimPoint([0, 0], view), b: dimPoint([40, 0], view), offset: 8 };
  const angle: Dimension = { ...length, type: "angle", c: dimPoint([0, 0], view), d: dimPoint([0, 20], view) };
  /** A w × h rectangle drawn as four edges (as the engine gives them). */
  const edges = (kind: ViewKind, w: number, h: number) => rectView(kind, w, h, { visible: [[0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0]] });
  // A stepped front (three steps each way), so the rows of dimensions stack up past the gap between views.
  const pts = [0, 0, 40, 0, 40, 10, 25, 10, 25, 15, 10, 15, 10, 20, 0, 20];
  const stepped: number[][] = [];
  for (let i = 0; i < pts.length; i += 2) stepped.push([pts[i], pts[i + 1], pts[(i + 2) % pts.length], pts[(i + 3) % pts.length]]);
  const solid = { front: rectView("front", 40, 20, { visible: stepped, points: stepped.flat() }), top: edges("top", 40, 30), right: edges("right", 30, 20) };
  /** Lay out the block with auto dimensions; which dimensions run into another view's box. */
  const six = ["front", "top", "right", "left", "back", "bottom"];
  const all = { ...solid, left: edges("left", 30, 20), back: edges("back", 40, 20), bottom: edges("bottom", 40, 30) };
  function clashes(third: boolean, keys = ["front", "top", "right"]): string[] {
    const block = all;
    let n = 0;
    let d: Drawing = { ...newDrawing(), sheet: "A3", views: keys.map((k) => ({ id: k, kind: k as ViewKind })), ...(third ? { projection: "third" as const } : {}) };
    const first = layoutSheet(d, block, info);
    d = { ...d, dimensions: autoDimensions(block, keys, [], first.scale, () => `a${n++}`, third) };
    const l = layoutSheet(d, block, info);
    const out: string[] = [];
    for (const dim of l.dims) {
      const own = d.dimensions!.find((x) => x.id === dim.id)!.view;
      for (const v of l.views) {
        if (v.key === own) continue;
        const [x0, y0, x1, y1] = v.box;
        for (const p of l.prims.slice(dim.from, dim.to)) {
          const pts = p.kind === "path" ? p.points : [p.x, p.y];
          for (let i = 0; i < pts.length; i += 2) if (pts[i] > x0 + 0.5 && pts[i] < x1 - 0.5 && pts[i + 1] > y0 + 0.5 && pts[i + 1] < y1 - 0.5) out.push(`${own} → ${v.key}`);
        }
      }
    }
    expect(d.dimensions!.length).toBeGreaterThan(2);
    return [...new Set(out)];
  }

  it("third angle: auto dimensions stay clear of the neighbouring views (as in first angle)", () => {
    expect(clashes(false)).toEqual([]);
    expect(clashes(true)).toEqual([]);
  });

  it("with all six views, rows go where there's no view next door (the front's sizes move to a view with room)", () => {
    expect(clashes(false, six)).toEqual([]);
    expect(clashes(true, six)).toEqual([]);
  });

  it("third angle: baseline runs go on the far side from the neighbouring views", () => {
    const front = block.front;
    const run = (third: boolean) => {
      const r = startRun("front", "baseline", [0, 0], third);
      const [h] = nextLinear(r, front, [40, 0], 1, []);
      const [v] = nextLinear(startRun("front", "baseline", [0, 0], third), front, [0, 20], 1, []);
      expect(advanceRun(r, [40, 0], [h]).third).toBe(third ? true : undefined);
      return [Math.sign(h.offset), Math.sign(v.offset)];
    };
    // First angle: widths above (+), heights to the right (vertical offsets are measured leftwards, so −).
    expect(run(false)).toEqual([1, -1]);
    // Third angle: widths below (the top view is above), heights to the left (the right view is to the right).
    expect(run(true)).toEqual([-1, 1]);
  });

  it("only says a section misses the part once the views are up to date", () => {
    const d = { sections: [{ id: "s1", letter: "A", host: "top" as const, a: [0, 0.5] as [number, number], b: [1, 0.5] as [number, number] }] };
    expect([...missedSections(d, { front: { bounds: [0, 0, 1, 1] } }, false)]).toEqual([]);
    expect([...missedSections(d, { front: { bounds: [0, 0, 1, 1] } }, true)]).toEqual(["s1"]);
    expect([...missedSections(d, { "section:s1": { bounds: [0, 0, 1, 1] } }, true)]).toEqual([]);
    expect([...missedSections(d, { "section:s1": { bounds: null } }, true)]).toEqual(["s1"]);
  });

  it("writes characters beyond four hex digits into DXF as ?, and ™ into PDF", () => {
    expect(dxfText("Part 😀 A")).toBe("Part ? A");
    const pdf = new TextDecoder("latin1").decode(sheetPdf([{ kind: "text", x: 1, y: 1, text: "Brand™", size: 3, anchor: "start" }], [297, 210]));
    expect(pdf).toContain("(Brand\\231) Tj");
  });

  it("hole callouts follow the drawing's decimal places and both units", () => {
    const h = { cx: 0, cy: 0, d: 6.6, through: false, depth: 10, cbore: { diameter: 11, depth: 6.4 } };
    expect(calloutLines(h, 2, [])).toEqual(["2× Ø6.6 × 10 DEEP", "CBORE Ø11 × 6.4 DEEP"]);
    expect(calloutLines(h, 2, [], { places: 2 })).toEqual(["2× Ø6.60 × 10.00 DEEP", "CBORE Ø11.00 × 6.40 DEEP"]);
    expect(calloutLines({ ...h, cbore: undefined }, 1, [], { dual: true })).toEqual(["Ø6.6 [Ø0.26] × 10 [0.394] DEEP"]);
  });

  it("never shows a non-zero size as 0 at too few decimal places", () => {
    const h = { cx: 0, cy: 0, d: 6.6, through: true, depth: 10, cbore: { diameter: 11, depth: 6.4 }, csk: { diameter: 12.6, angle: 90 } };
    setLengthUnit("in");
    try {
      expect(calloutLines(h, 2, [], { places: 0 })).toEqual(["2× Ø0.26 THRU", "CBORE Ø0.433 × 0.252 DEEP", "CSK Ø0.496 × 90°"]);
      expect(dimLabel({ ...length, type: "diameter", places: 0 }, 6)).toBe("Ø0.236");
      // Sizes of an inch or more just round.
      expect(dimLabel({ ...length, places: 0 }, 40)).toBe("2");
    } finally {
      setLengthUnit("mm");
    }
    expect(dimLabel({ ...length, places: 0 }, 0.3)).toBe("0.3");
    expect(dimLabel({ ...length, places: 0 }, 0)).toBe("0");
    expect(dimLabel({ ...angle, places: 0 }, 0.25)).toBe("0.25°");
  });

  it("hatches a detail of a broken-out view at the usual spacing on paper", () => {
    // A 10 × 10 hatched square in the host view, shown 4 times bigger.
    const host = rectView("front", 20, 20, { cutFaces: [0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10] });
    let d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front" }], scale: 1 };
    d = addDetail(d, { id: "d1", letter: "B", host: "front", centre: [0.25, 0.25], radius: 4, zoom: 4 });
    const l = layoutSheet(d, withDetails({ front: host }, d), info);
    const box = l.views.find((v) => v.key === "detail:d1")!.box;
    const inside = (p: Prim) => p.kind === "path" && p.style === "thin" && p.points.length === 4 && p.points.every((v, i) => v >= box[i % 2] - 1e-6 && v <= box[2 + (i % 2)] + 1e-6);
    const vs = [...new Set(l.prims.filter(inside).map((p) => Math.round(((-(p as { points: number[] }).points[0] + (p as { points: number[] }).points[1]) / Math.SQRT2) * 1000) / 1000))].sort((a, b) => a - b);
    expect(vs.length).toBeGreaterThan(3);
    for (let i = 1; i < vs.length; i++) expect(vs[i] - vs[i - 1]).toBeCloseTo(2.5, 2);
  });

  it("switching first/third angle keeps where 3D, section and detail views were moved", () => {
    const d: Drawing = { ...newDrawing(), views: newDrawing().views.map((v) => ({ ...v, at: [100, 100] as [number, number] })) };
    const after = arrangeLinedUp(d);
    expect(after.views.map((v) => [v.kind, v.at])).toEqual([
      ["front", undefined],
      ["top", undefined],
      ["right", undefined],
      ["iso", [100, 100]],
    ]);
  });

  it("keeps automatic dimension rows inside the border and clear of other views, stepping down the scale if need be", () => {
    // A 60 × 40 × 25 stepped block with Ø8 and Ø5 holes from the top.
    const seg = (pts: number[]) => {
      const out: number[][] = [];
      for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1], pts[(i + 2) % pts.length], pts[(i + 3) % pts.length]]);
      return out;
    };
    const stepView = (kind: ViewKind, w: number, h: number, extra: Partial<ViewProjection> = {}) => {
      const lines = seg([0, 0, w, 0, w, h * 0.4, w * 0.6, h * 0.4, w * 0.6, h * 0.7, w * 0.3, h * 0.7, w * 0.3, h, 0, h]);
      return rectView(kind, w, h, { visible: lines, points: lines.flat(), ...extra });
    };
    const holes = {
      circles: [
        { cx: 15, cy: 20, r: 4, hidden: false, full: true },
        { cx: 45, cy: 20, r: 2.5, hidden: false, full: true },
      ],
      holes: [
        { cx: 15, cy: 20, d: 8, through: true, depth: 25 },
        { cx: 45, cy: 20, d: 5, through: true, depth: 25 },
      ],
    };
    const top = rectView("top", 60, 40, { visible: [...seg([0, 0, 60, 0, 60, 40, 0, 40])], points: [0, 0, 60, 0, 60, 40, 0, 40, 15, 20, 45, 20], ...holes });
    const views: Projections = {
      front: stepView("front", 60, 25),
      back: stepView("back", 60, 25),
      top,
      bottom: { ...top, kind: "bottom" },
      right: stepView("right", 40, 25),
      left: stepView("left", 40, 25),
      iso: rectView("iso", 70, 60),
    };
    const sets = [
      ["front", "top", "right", "left", "back", "bottom", "iso"],
      ["front", "top", "right", "left", "bottom", "iso"],
      ["front", "right", "left", "iso"],
      ["front", "top", "bottom", "iso"],
      ["front", "top", "right", "iso"],
    ];
    for (const sheet of ["A4", "A3"] as const)
      for (const third of [false, true])
        for (const keys of sets) {
          let n = 0;
          let d: Drawing = { ...newDrawing(), sheet, views: keys.map((k) => ({ id: k, kind: k as ViewKind })), ...(third ? { projection: "third" as const } : {}) };
          const plain = layoutSheet(d, views, info);
          d = { ...d, dimensions: autoDimensions(views, keys, [], plain.scale, () => `a${n++}`, third) };
          const l = layoutSheet(d, views, info);
          const where = `${sheet} ${third ? "third" : "first"} ${keys.join(",")} at ${l.scale}`;
          expect([where, dimsClear(l, d, 36)]).toEqual([where, true]);
          // Checked independently too: every dimension's lines and numbers inside the 10 mm border.
          for (const dim of l.dims)
            for (const p of l.prims.slice(dim.from, dim.to)) {
              const pts = p.kind === "path" ? p.points : [p.x, p.y];
              for (let i = 0; i < pts.length; i += 2) {
                expect([where, pts[i] >= 10 && pts[i] <= l.size[0] - 10]).toEqual([where, true]);
                expect([where, pts[i + 1] >= 10 && pts[i + 1] <= l.size[1] - 10]).toEqual([where, true]);
              }
            }
        }
    // A sheet whose dimensions already fit keeps its scale; a chosen scale is never changed.
    const d: Drawing = { ...newDrawing(), sheet: "A4", dimensions: [length], views: [{ id: "f", kind: "front" }] };
    expect(layoutSheet(d, { front: rectView("front", 40, 20) }, info).scale).toBe(fitScale({ front: rectView("front", 40, 20) }, ["front"], "A4").scale);
  });
});
