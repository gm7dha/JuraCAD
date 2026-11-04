/**
 * Export for laser, the pure parts: joining outline pieces into loops, outer
 * versus inner cuts, laying pieces out side by side, mirroring, and the SVG
 * and DXF files (true size, layer colours, exact arcs and circles).
 */
import { describe, expect, it } from "vitest";

import { chainEdges, layoutPieces, pathsBox, sortLoops, type LaserPiece } from "../src/laser/laser";
import { laserDxf, laserSvg, polylineOf } from "../src/laser/laserFiles";
import { outlinePiece, sketchPiece } from "../src/laser/sources";
import { parseDxf } from "../src/sketch/dxf";
import { addArc, addCircle, addLine, addRectangle } from "../src/sketch/ops";
import type { Segment } from "../src/sketch/regions";
import { emptySketch } from "../src/sketch/types";

type P = [number, number];
const line = (from: P, to: P): Segment => ({ kind: "line", from, to });
/** A rectangle's four sides, shuffled and some turned round, as OpenCascade may give them. */
const rectEdges = (x0: number, y0: number, w: number, h: number): Segment[] => [
  line([x0 + w, y0], [x0 + w, y0 + h]),
  line([x0, y0], [x0 + w, y0]),
  line([x0, y0], [x0, y0 + h]),
  line([x0 + w, y0 + h], [x0, y0 + h]),
];
const plate = (): LaserPiece =>
  outlinePiece({ ok: true, name: "Plate", partId: "p", wires: [rectEdges(0, 0, 80, 50), [{ kind: "circle", center: [20, 25], radius: 5 }], [{ kind: "circle", center: [60, 25], radius: 3 }]] });

describe("joining and sorting outlines", () => {
  it("joins shuffled pieces into one closed loop, end to end", () => {
    const { loops, open } = chainEdges(rectEdges(0, 0, 10, 5));
    expect(open).toHaveLength(0);
    expect(loops).toHaveLength(1);
    const l = loops[0];
    for (let i = 0; i < l.length; i++) {
      const a = l[i] as Extract<Segment, { kind: "line" }>;
      const b = l[(i + 1) % l.length] as Extract<Segment, { kind: "line" }>;
      expect(Math.hypot(a.to[0] - b.from[0], a.to[1] - b.from[1])).toBeLessThan(1e-9);
    }
  });

  it("keeps an open run open, joined from its middle both ways", () => {
    const { loops, open } = chainEdges([line([1, 0], [2, 0]), line([0, 0], [1, 0]), line([3, 0], [2, 0])]);
    expect(loops).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(open[0]).toHaveLength(3);
  });

  it("calls the biggest loop the outer cut and the loops inside it inner cuts", () => {
    const paths = plate().paths;
    expect(paths.map((p) => p.layer).sort()).toEqual(["inner", "inner", "outer"]);
    expect(paths.find((p) => p.layer === "outer")!.segments).toHaveLength(4);
    // Two separate pieces side by side are both outer cuts.
    const two = sortLoops([chainEdges(rectEdges(0, 0, 10, 10)).loops[0], chainEdges(rectEdges(20, 0, 10, 10)).loops[0]]);
    expect(two.map((p) => p.layer)).toEqual(["outer", "outer"]);
  });
});

describe("laying pieces out", () => {
  it("puts a single piece's corner at the origin, at its true size", () => {
    const sheet = layoutPieces([outlinePiece({ ok: true, name: "A", partId: "a", wires: [rectEdges(-40, 7, 80, 50)] })]);
    expect(sheet.size[0]).toBeCloseTo(80, 9);
    expect(sheet.size[1]).toBeCloseTo(50, 9);
    expect(pathsBox(sheet.paths)).toEqual([0, 0, 80, 50]);
  });

  it("lays several pieces side by side, the gap apart, never overlapping", () => {
    const pieces = [0, 1, 2].map((i) => outlinePiece({ ok: true, name: `P${i}`, partId: `p${i}`, wires: [rectEdges(0, 0, 30, 20)] }));
    const sheet = layoutPieces(pieces, { gap: 5 });
    expect(sheet.size[0]).toBeCloseTo(3 * 30 + 2 * 5, 6);
    expect(sheet.size[1]).toBeCloseTo(20, 6);
    const boxes = sheet.pieces.map((p) => p.box).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][0] - boxes[i - 1][2]).toBeCloseTo(5, 6);
    // Rows wrap at the width asked for.
    const rows = layoutPieces(pieces, { gap: 5, width: 70 });
    expect(rows.size[0]).toBeCloseTo(65, 6);
    expect(rows.size[1]).toBeCloseTo(20 + 5 + 20, 6);
  });

  it("mirrors left to right for engraving on the back", () => {
    const piece = outlinePiece({ ok: true, name: "A", partId: "a", wires: [rectEdges(0, 0, 100, 40), [{ kind: "circle", center: [10, 20], radius: 4 }]] });
    const plain = layoutPieces([piece]);
    const flipped = layoutPieces([piece], { mirror: true });
    const hole = (s: typeof plain) => s.paths.find((p) => p.layer === "inner")!.segments[0] as Extract<Segment, { kind: "circle" }>;
    expect(hole(plain).center[0]).toBeCloseTo(10, 9);
    expect(hole(flipped).center[0]).toBeCloseTo(90, 9);
    expect(flipped.size).toEqual(plain.size);
  });
});

describe("the SVG file", () => {
  it("is sized in millimetres with a matching viewBox, so it opens at true size", () => {
    const svg = laserSvg(layoutPieces([plate()]));
    expect(svg).toContain('width="80mm" height="50mm" viewBox="0 0 80 50"');
    // No title block, dimensions or text on the sheet: only cut lines.
    expect(svg).not.toContain("<text");
  });

  it("colours each layer and names its group: red outside, blue holes", () => {
    const svg = laserSvg(layoutPieces([plate()]));
    expect(svg).toMatch(/<g id="cut-outer"[^>]*inkscape:label="Outer cuts">\n<path d="M[^"]*Z" fill="none" stroke="#FF0000" stroke-width="0.05"/);
    expect(svg.match(/<circle [^>]*stroke="#0000FF"/g)).toHaveLength(2);
    // Holes before the outside (cut order).
    expect(svg.indexOf('id="cut-inner"')).toBeLessThan(svg.indexOf('id="cut-outer"'));
    // A hairline.
    for (const w of svg.match(/stroke-width="([\d.]+)"/g)!) expect(Number(w.match(/[\d.]+/)![0])).toBeLessThanOrEqual(0.1);
  });

  it("keeps circles as circles at their exact size (y measured down from the top)", () => {
    const svg = laserSvg(layoutPieces([plate()]));
    expect(svg).toContain('<circle cx="20" cy="25" r="5"');
    expect(svg).toContain('<circle cx="60" cy="25" r="3"');
  });

  it("writes arcs as SVG arcs and splines as cubic curves, not straight pieces", () => {
    // A slot: two straight sides and two half-round ends.
    const slot: Segment[] = [
      line([0, 0], [20, 0]),
      { kind: "arc", from: [20, 0], mid: [25, 5], to: [20, 10] },
      line([20, 10], [0, 10]),
      { kind: "arc", from: [0, 10], mid: [-5, 5], to: [0, 0] },
    ];
    const wave: Segment[] = [line([0, 0], [30, 0]), line([30, 0], [30, 10]), { kind: "bezier", from: [30, 10], c1: [20, 20], c2: [10, 0], to: [0, 10] }, line([0, 10], [0, 0])];
    const sheet = layoutPieces([{ name: "s", paths: sortLoops([slot]) }]);
    const svg = laserSvg(sheet);
    expect(sheet.size[0]).toBeCloseTo(30, 6);
    expect(svg.match(/ A5 5 0 0 0 /g)).toHaveLength(2);
    const svg2 = laserSvg(layoutPieces([{ name: "w", paths: sortLoops([wave]) }], {}));
    expect(svg2).toMatch(/ C20 -?[\d.]+ 10 -?[\d.]+ 0 -?[\d.]+ /);
    // The curve's real top (12.887 mm above its lowest point), not its control points.
    expect(laserSvg(layoutPieces([{ name: "w", paths: sortLoops([wave]) }]))).toContain('height="12.8868mm"');
  });

  it("draws an arc going clockwise with the other sweep, and a large arc as large", () => {
    // Three quarters of a circle, round the right-hand side (clockwise from the top).
    const big: Segment[] = [{ kind: "arc", from: [0, 10], mid: [10, 0], to: [-10, 0] }, line([-10, 0], [0, 10])];
    const svg = laserSvg(layoutPieces([{ name: "b", paths: sortLoops([big]) }]));
    expect(svg).toMatch(/ A10 10 0 1 1 /);
  });
});

describe("the DXF file", () => {
  it("is in millimetres, with the four laser layers, and reads back at the same size", () => {
    const dxf = laserDxf(layoutPieces([plate()]));
    expect(dxf).toContain("$INSUNITS\n70\n4\n");
    for (const name of ["CUT_OUTER", "CUT_INNER", "SCORE", "ENGRAVE"]) expect(dxf).toContain(`\n2\n${name}\n`);
    const back = parseDxf(dxf);
    expect(back.unitMm).toBe(1);
    const circles = back.entities.filter((e) => e.kind === "circle");
    expect(circles.map((c) => (c as { r: number }).r).sort()).toEqual([3, 5]);
    const poly = back.entities.find((e) => e.kind === "polyline") as Extract<(typeof back.entities)[number], { kind: "polyline" }>;
    expect(poly.closed).toBe(true);
    expect(poly.points).toHaveLength(4);
    // Each loop on its layer: the outline's polyline on CUT_OUTER, the holes' circles on CUT_INNER.
    expect(dxf).toMatch(/POLYLINE\n8\nCUT_OUTER/);
    expect(dxf.match(/CIRCLE\n8\nCUT_INNER/g)).toHaveLength(2);
  });

  it("keeps arcs exact as bulges", () => {
    const slot: Segment[] = [line([0, 0], [20, 0]), { kind: "arc", from: [20, 0], mid: [25, 5], to: [20, 10] }, line([20, 10], [0, 10]), { kind: "arc", from: [0, 10], mid: [-5, 5], to: [0, 0] }];
    const verts = polylineOf({ layer: "outer", segments: slot, closed: true });
    expect(verts).toHaveLength(4);
    expect(verts.filter((v) => Math.abs(v.bulge - 1) < 1e-9)).toHaveLength(2);
  });
});

describe("sketches", () => {
  it("cuts a sketch's closed shapes: the outline red, a circle inside it blue; construction lines left out", () => {
    let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 60, y: 40 }).sketch;
    s = addCircle(s, { x: 30, y: 20 }, 8).sketch;
    s = addLine(s, { x: -10, y: -10 }, { x: 100, y: 100 }, { construction: true }).sketch;
    const piece = sketchPiece("Sketch 1", s);
    expect(piece.paths.map((p) => p.layer).sort()).toEqual(["inner", "outer"]);
    const sheet = layoutPieces([piece]);
    expect(sheet.size).toEqual([60, 40]);
  });

  it("keeps lines that don't close, as cuts or as scores", () => {
    let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 60, y: 40 }).sketch;
    s = addLine(s, { x: 30, y: 0 }, { x: 30, y: 40 }).sketch;
    s = addArc(s, { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 10, y: 10 }).sketch;
    // The line across meets the rectangle's sides (a junction): its pieces come as open runs.
    const cut = sketchPiece("S", s);
    expect(cut.paths.some((p) => !p.closed && p.layer === "inner")).toBe(true);
    const scored = sketchPiece("S", s, { open: "score" });
    expect(scored.paths.some((p) => !p.closed && p.layer === "score")).toBe(true);
    const svg = laserSvg(layoutPieces([scored]));
    expect(svg).toContain('stroke="#00FF00"');
  });

  it("engraves shapes as black filled areas when asked", () => {
    let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 10 }).sketch;
    s = addCircle(s, { x: 5, y: 5 }, 2).sketch;
    const svg = laserSvg(layoutPieces([sketchPiece("S", s, { shapes: "engrave" })]));
    expect(svg).toMatch(/<g id="engrave"[^>]*>\n<path d="[^"]+" fill="#000000" fill-rule="evenodd" stroke="none"\/>/);
    expect(svg).not.toContain('stroke="#FF0000"');
  });
});

describe("flat patterns", () => {
  it("adds bend lines as green scores (or leaves them out)", () => {
    const outline = { ok: true as const, name: "Bracket flat pattern", partId: "b", wires: [rectEdges(0, 0, 120, 50)], bends: [[[40, 0], [40, 50]] as [P, P]] };
    const withBends = outlinePiece(outline);
    expect(withBends.paths.filter((p) => p.layer === "score")).toHaveLength(1);
    expect(outlinePiece(outline, { bends: false }).paths.filter((p) => p.layer === "score")).toHaveLength(0);
    const dxf = laserDxf(layoutPieces([withBends]));
    expect(dxf).toMatch(/POLYLINE\n8\nSCORE/);
  });
});

describe("sketches with lines meeting at a corner", () => {
  /** A 40 × 30 rectangle and the ids of its corner points. */
  const rectWithCorners = () => {
    const s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 30 }).sketch;
    const at = (x: number, y: number) => s.points.find((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6)!.id;
    return { s, at };
  };
  const snapTo = (x: number, y: number, id: string) => ({ x, y, snap: { kind: "point", id } }) as unknown as { x: number; y: number };

  it("a house (a roof on the rectangle's top corners) keeps one red outline round it all, the line under the roof inside", () => {
    const { s, at } = rectWithCorners();
    const l1 = addLine(s, snapTo(0, 30, at(0, 30)), { x: 20, y: 50 });
    const house = addLine(l1.sketch, snapTo(20, 50, l1.endId), snapTo(40, 30, at(40, 30))).sketch;
    for (const open of ["cut", "score"] as const) {
      const piece = sketchPiece("House", house, { open });
      const outer = piece.paths.filter((p) => p.layer === "outer");
      expect(outer).toHaveLength(1);
      expect(outer[0].closed).toBe(true);
      // The rectangle's three outside sides and the two roof lines.
      expect(outer[0].segments).toHaveLength(5);
      expect(pathsBox(outer)).toEqual([0, 0, 40, 50]);
      // The line under the roof has the house on both sides: a line inside, cut or scored.
      const inside = piece.paths.filter((p) => !p.closed);
      expect(inside).toHaveLength(1);
      expect(inside[0].layer).toBe(open === "score" ? "score" : "inner");
    }
  });

  it("a rectangle with a corner-to-corner diagonal is still cut out round its outside", () => {
    const { s, at } = rectWithCorners();
    const diag = addLine(s, snapTo(0, 0, at(0, 0)), snapTo(40, 30, at(40, 30))).sketch;
    const piece = sketchPiece("Diagonal", diag, { open: "score" });
    const outer = piece.paths.filter((p) => p.layer === "outer");
    expect(outer).toHaveLength(1);
    expect(outer[0].segments).toHaveLength(4);
    expect(piece.paths.filter((p) => p.layer === "score")).toHaveLength(1);
    expect(layoutPieces([piece]).size).toEqual([40, 30]);
  });
});

describe("cut order and odd sizes", () => {
  it("cuts an island inside a hole before the hole, and the outsides last", () => {
    const piece = outlinePiece({
      ok: true,
      name: "x",
      partId: "x",
      wires: [rectEdges(0, 0, 100, 100), [{ kind: "circle", center: [50, 50], radius: 30 }], [{ kind: "circle", center: [50, 50], radius: 10 }], rectEdges(200, 0, 20, 20)],
    });
    const order = piece.paths.map((p) => `${p.layer}:${p.segments[0].kind === "circle" ? (p.segments[0] as Extract<Segment, { kind: "circle" }>).radius : "rect"}`);
    expect(order).toEqual(["inner:10", "inner:30", "outer:rect", "outer:rect"]);
  });

  it("a piece wider than the rows still makes a sheet just big enough", () => {
    const big = outlinePiece({ ok: true, name: "big", partId: "a", wires: [rectEdges(0, 0, 700, 700)] });
    const small = outlinePiece({ ok: true, name: "small", partId: "b", wires: [rectEdges(0, 0, 20, 20)] });
    const sheet = layoutPieces([big, small], { gap: 5, width: 600 });
    // Rows widen to the big piece (700): the small one goes beside or below it, never half a kilometre away.
    expect(Math.min(...sheet.size)).toBeCloseTo(700, 6);
    expect(Math.max(...sheet.size)).toBeLessThanOrEqual(725 + 1e-6);
    // A long piece is turned to fit the rows rather than widening them.
    const long = outlinePiece({ ok: true, name: "long", partId: "c", wires: [rectEdges(0, 0, 800, 100)] });
    const s2 = layoutPieces([long, small], { gap: 5, width: 600 });
    expect(Math.max(...s2.size)).toBeLessThan(900);
  });
});

describe("sketch text", () => {
  it("engraves text as filled letters (holes in letters kept clear), or cuts the letters out", async () => {
    const { FONTS } = await import("../src/geometry/fonts");
    const { addText, DEFAULT_TEXT } = await import("../src/sketch/sketchText");
    // A tiny stand-in font: "O" a square with a square hole, "I" a bar.
    const font = {
      resolution: 1000,
      boundingBox: { yMin: 0, yMax: 1000 },
      glyphs: {
        O: { ha: 1200, o: "m 0 0 l 1000 0 l 1000 1000 l 0 1000 m 250 250 l 250 750 l 750 750 l 750 250" },
        I: { ha: 1200, o: "m 0 0 l 200 0 l 200 1000 l 0 1000" },
      },
    };
    FONTS.regular = font;
    FONTS.bold = font;
    let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 80, y: 30 }).sketch;
    s = addText(s, { x: 5, y: 10 }, { ...DEFAULT_TEXT, value: "OI", size: 10 }).sketch;
    const engraved = sketchPiece("Sign", s, { text: "engrave" });
    expect(engraved.paths.filter((p) => p.layer === "engrave")).toHaveLength(3);
    expect(engraved.paths.filter((p) => p.layer === "outer")).toHaveLength(1);
    const svg = laserSvg(layoutPieces([engraved]));
    // One filled shape for all the letters, even-odd, so the inside of the "O" isn't burnt.
    expect(svg.match(/fill="#000000" fill-rule="evenodd"/g)).toHaveLength(1);
    const cut = sketchPiece("Sign", s, { text: "cut" });
    expect(cut.paths.filter((p) => p.layer === "engrave")).toHaveLength(0);
    // Letters lie inside the sign's outline: inner cuts.
    expect(cut.paths.filter((p) => p.layer === "inner")).toHaveLength(3);
    expect(cut.paths.filter((p) => p.layer === "outer")).toHaveLength(1);
  });
});

describe("choosing what to cut", () => {
  it("drops a whole part when one of its faces is picked too, and the same face picked twice", async () => {
    const { uniqueSources } = await import("../src/laser/sources");
    const ref = { kind: "face" as const, surface: "PLANE", center: [0, 0, 1] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    const got = uniqueSources([
      { kind: "face", pick: { partId: "a", ref } },
      { kind: "part", partId: "a" },
      { kind: "face", pick: { partId: "a", ref } },
      { kind: "part", partId: "b" },
      { kind: "part", partId: "b" },
    ]);
    expect(got.map((g) => `${g.kind}:${g.kind === "face" ? g.pick.partId : g.partId}`)).toEqual(["face:a", "part:b"]);
  });
});
