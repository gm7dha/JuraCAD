import { describe, expect, it } from "vitest";

import { insertSvg, MAX_SVG_SIZE, parseSvg, svgSummary } from "../src/sketch/svg";
import { splinePieces } from "../src/sketch/curves";
import { ellipseSpan } from "../src/sketch/curves";
import { pointPos } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { emptySketch, type SketchData } from "../src/sketch/types";

const svg = (body: string, attrs = 'width="100mm" height="50mm" viewBox="0 0 100 50"') => `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const insert = (text: string, scale = 1) => {
  const d = parseSvg(text);
  const r = insertSvg(emptySketch(), d, scale);
  if (r.error) throw new Error(r.error);
  return { d, r, s: r.sketch };
};
const areaOf = (s: SketchData) => findRegions(s).regions.reduce((t, r) => t + r.outer.area - r.holes.reduce((h, x) => h + x.area, 0), 0);
/** Areas round arcs are measured on a fine polygon, so allow a little. */
const about = (a: number, b: number) => expect(Math.abs(a - b) / b).toBeLessThan(0.003);
const kinds = (s: SketchData) => s.curves.map((c) => c.type).sort().join(",");
const xs = (s: SketchData) => s.points.map((p) => p.x);
const ys = (s: SketchData) => s.points.map((p) => p.y);

describe("Insert SVG: shapes", () => {
  it("a rectangle comes in as four joined lines, the right way up, page corner on the origin", () => {
    const { s, r } = insert(svg('<rect x="10" y="5" width="30" height="20" fill="none" stroke="black"/>'));
    expect(r.count).toBe(1);
    expect(kinds(s)).toBe("line,line,line,line");
    expect(s.points).toHaveLength(4);
    expect(areaOf(s)).toBeCloseTo(600, 9);
    // SVG y 5…25 on a 50 tall page = sketch y 25…45.
    expect(Math.min(...ys(s))).toBeCloseTo(25, 9);
    expect(Math.max(...ys(s))).toBeCloseTo(45, 9);
    expect(Math.min(...xs(s))).toBeCloseTo(10, 9);
  });

  it("circles stay circles, ellipses stay ellipses", () => {
    const { s } = insert(svg('<circle cx="20" cy="20" r="8"/><ellipse cx="60" cy="25" rx="15" ry="5"/>'));
    expect(kinds(s)).toBe("circle,ellipse");
    const c = s.curves.find((x) => x.type === "circle")!;
    expect(c.type === "circle" && c.radius).toBeCloseTo(8, 12);
    expect(c.type === "circle" && pointPos(s, c.center)).toEqual([20, 30]);
    const e = s.curves.find((x) => x.type === "ellipse")!;
    if (e.type !== "ellipse") throw new Error();
    const { g, whole } = ellipseSpan(s, e);
    expect(whole).toBe(true);
    expect(g.rx).toBeCloseTo(15, 9);
    expect(g.ry).toBeCloseTo(5, 9);
    about(areaOf(s), Math.PI * 64 + Math.PI * 75);
  });

  it("lines, polylines and polygons", () => {
    const { s, r } = insert(svg('<line x1="0" y1="0" x2="10" y2="0"/><polyline points="0,10 10,10 10,20"/><polygon points="50,10 70,10 60,30"/>'));
    expect(r.count).toBe(3);
    expect(s.curves.filter((c) => c.type === "line")).toHaveLength(1 + 2 + 3);
    expect(areaOf(s)).toBeCloseTo(200, 9);
  });

  it("rounded rectangles: straight sides and quarter-circle arcs", () => {
    const { s } = insert(svg('<rect x="10" y="10" width="40" height="20" rx="5"/>'));
    expect(s.curves.filter((c) => c.type === "arc")).toHaveLength(4);
    expect(s.curves.filter((c) => c.type === "line")).toHaveLength(4);
    about(areaOf(s), 800 - (4 - Math.PI) * 25);
  });

  it("text and pictures are left out and said so", () => {
    const { d, r } = insert(svg('<text x="1" y="1">Hi</text><image href="a.png"/><rect width="5" height="5"/>'));
    expect(d.skipped).toEqual({ text: 1, pictures: 1 });
    expect(svgSummary(d, r.count, 1)).toMatch(/Brought in 1 shape\. It's at the size the file gives\. Left out: 1 text, 1 picture\..*Object to Path/);
    const only = parseSvg(svg("<text>Hi</text>"));
    expect(insertSvg(emptySketch(), only, 1).error).toMatch(/only has text.*Object to Path/);
  });
});

describe("Insert SVG: paths", () => {
  it("relative commands, H/V and implicit lineto make a closed outline", () => {
    const { s } = insert(svg('<path d="m10 10 20 0 0 10 h-20 z"/>'));
    expect(s.curves).toHaveLength(4);
    expect(areaOf(s)).toBeCloseTo(200, 9);
  });

  it("cubic curves become one spline with exactly the same pieces", () => {
    const { s } = insert(svg('<path d="M0 0 C10 0 20 10 20 20 S30 40 40 40" fill="none"/>', 'width="50mm" height="50mm" viewBox="0 0 50 50"'));
    expect(kinds(s)).toBe("spline");
    const sp = s.curves[0];
    if (sp.type !== "spline") throw new Error();
    const pieces = splinePieces(s, sp);
    // y flipped about the 50 tall page.
    const f = ([x, y]: number[]) => [x, 50 - y];
    const want = [
      [[0, 0], [10, 0], [20, 10], [20, 20]],
      [[20, 20], [20, 30], [30, 40], [40, 40]],
    ].map((b) => b.map(f));
    pieces.forEach((b, i) => b.forEach((p, j) => p.forEach((v, k) => expect(v).toBeCloseTo(want[i][j][k], 9))));
  });

  it("quadratic curves are cubics exactly", () => {
    const { s } = insert(svg('<path d="M0 50 Q25 0 50 50" fill="none"/>', 'width="50mm" height="50mm" viewBox="0 0 50 50"'));
    const sp = s.curves[0];
    if (sp.type !== "spline") throw new Error();
    const [b] = splinePieces(s, sp);
    expect(b[1][0]).toBeCloseTo(50 / 3, 9);
    expect(b[1][1]).toBeCloseTo((2 / 3) * 50, 9);
    expect(b[2][0]).toBeCloseTo(100 / 3, 9);
  });

  it("a closed path of curves is a closed spline", () => {
    const k = 0.5522847498;
    const d = `M10 0 C10 ${10 * k} ${10 * k} 10 0 10 C${-10 * k} 10 -10 ${10 * k} -10 0 C-10 ${-10 * k} ${-10 * k} -10 0 -10 C${10 * k} -10 10 ${-10 * k} 10 0 Z`;
    const { s } = insert(svg(`<path d="${d}"/>`, ""));
    const sp = s.curves[0];
    expect(s.curves).toHaveLength(1);
    expect(sp.type === "spline" && sp.closed).toBe(true);
  });

  it("circular arcs (A) are sketch arcs, joined to the lines round them", () => {
    // A slot: two half circles of r 5 and two lines.
    const { s } = insert(svg('<path d="M10 10 H30 A5 5 0 0 1 30 20 H10 A5 5 0 0 1 10 10 Z"/>'));
    expect(kinds(s)).toBe("arc,arc,line,line");
    expect(s.points.filter((p) => !s.curves.some((c) => c.type === "arc" && c.center === p.id))).toHaveLength(4);
    about(areaOf(s), 200 + Math.PI * 25);
  });

  it("arc flags written run together are read", () => {
    const { s } = insert(svg('<path d="M10 10a5 5 0 105 5" fill="none"/>'));
    expect(kinds(s)).toBe("arc");
  });

  it("elliptical arcs are parts of ellipses", () => {
    // Top half of an ellipse 20 × 10, closed by a line.
    const { s } = insert(svg('<path d="M10 30 A10 5 0 0 1 30 30 Z"/>'));
    expect(kinds(s)).toBe("ellipse,line");
    about(areaOf(s), (Math.PI * 10 * 5) / 2);
  });

  it("a square with a round hole: one area with a hole (a compound path)", () => {
    const { s } = insert(svg('<path fill-rule="evenodd" d="M0 0H40V40H0Z M20 10 A10 10 0 1 1 20 30 A10 10 0 1 1 20 10 Z"/>', 'width="40mm" height="40mm" viewBox="0 0 40 40"'));
    expect(s.curves.filter((c) => c.type === "arc")).toHaveLength(2);
    about(areaOf(s), 1600 - Math.PI * 100);
  });

  it("an unknown command is a plain error", () => {
    expect(() => parseSvg(svg('<path d="M0 0 X5 5"/>'))).toThrow(/./);
    expect(() => parseSvg(svg('<path d="5 5 L 1 1"/>'))).toThrow(/doesn't start with a move/);
  });

  it("curves that are really straight lines come in as lines", () => {
    const { s } = insert(svg('<path d="M0 0 C 5 0 10 0 20 0" fill="none"/>'));
    expect(kinds(s)).toBe("line");
  });
});

describe("Insert SVG: groups, transforms, copies and units", () => {
  it("groups and transforms (translate, scale, rotate) are applied", () => {
    const { s } = insert(svg('<g transform="translate(10 10)"><g transform="scale(2)"><rect width="5" height="5"/></g></g>'));
    expect(Math.min(...xs(s))).toBeCloseTo(10, 9);
    expect(Math.max(...xs(s))).toBeCloseTo(20, 9);
    expect(areaOf(s)).toBeCloseTo(100, 9);
    const turned = insert(svg('<rect x="0" y="0" width="10" height="5" transform="rotate(30 5 2.5)"/>')).s;
    expect(areaOf(turned)).toBeCloseTo(50, 9);
  });

  it("a circle squashed by a transform becomes an ellipse; turned it stays a circle", () => {
    expect(kinds(insert(svg('<circle cx="10" cy="10" r="5" transform="scale(2 1)"/>')).s)).toBe("ellipse");
    const c = insert(svg('<circle cx="10" cy="10" r="5" transform="rotate(20) scale(3)"/>')).s.curves[0];
    expect(c.type === "circle" && c.radius).toBeCloseTo(15, 9);
  });

  it("a skewed arc becomes part of an ellipse and still closes", () => {
    const { s } = insert(svg('<path transform="skewX(20)" d="M10 10 H30 A5 5 0 0 1 30 20 H10 A5 5 0 0 1 10 10 Z"/>'));
    expect(kinds(s)).toBe("ellipse,ellipse,line,line");
    // Skewing keeps areas.
    about(areaOf(s), 200 + Math.PI * 25);
  });

  it("a mirrored arc runs the right way round", () => {
    const { s } = insert(svg('<path transform="scale(-1 1) translate(-60 0)" d="M10 10 H30 A5 5 0 0 1 30 20 H10 A5 5 0 0 1 10 10 Z"/>'));
    about(areaOf(s), 200 + Math.PI * 25);
  });

  it("use copies the shape it points at (and a symbol's shapes)", () => {
    const { s, r } = insert(
      svg('<defs><rect id="r" width="5" height="5"/><symbol id="sy"><circle cx="2" cy="2" r="1"/></symbol></defs><use href="#r" x="10"/><use xlink:href="#r" x="20" y="10"/><use href="#sy" x="40"/><use href="#missing"/>'),
    );
    expect(r.count).toBe(3);
    expect(kinds(s)).toBe("circle,line,line,line,line,line,line,line,line");
    expect(svgSummary(parseSvg(svg('<use href="#missing"/><rect width="1" height="1"/>')), 1, 1)).toMatch(/1 copy whose original is missing/);
  });

  it("a use that uses itself stops", () => {
    const d = parseSvg(svg('<g id="a"><rect width="1" height="1"/><use href="#a" x="2"/></g>'));
    expect(d.shapes.length).toBeLessThan(20);
  });

  it("hidden layers are left out", () => {
    const { s } = insert(svg('<g style="display:none"><rect width="5" height="5"/></g><rect width="1" height="1"/>'));
    expect(areaOf(s)).toBeCloseTo(1, 9);
  });

  it("units: mm, inches, a viewBox in other units, and plain pixels at 96 to the inch", () => {
    const inches = insert(svg('<rect width="1" height="1"/>', 'width="2in" height="2in" viewBox="0 0 2 2"'));
    expect(Math.max(...xs(inches.s))).toBeCloseTo(25.4, 9);
    expect(inches.d.sized).toBe(true);
    const scaled = insert(svg('<rect width="100" height="100"/>', 'width="10cm" height="10cm" viewBox="0 0 1000 1000"'));
    expect(Math.max(...xs(scaled.s))).toBeCloseTo(10, 9);
    const px = insert(svg('<rect width="96" height="96"/>', 'width="96" height="96"'));
    expect(Math.max(...xs(px.s))).toBeCloseTo(25.4, 9);
    expect(px.d.sized).toBe(false);
    expect(svgSummary(px.d, 1, 1)).toMatch(/96 pixels to the inch/);
    const pt = insert(svg('<rect width="72" height="72"/>', 'width="72pt" height="72pt" viewBox="0 0 72 72"'));
    expect(Math.max(...xs(pt.s))).toBeCloseTo(25.4, 9);
  });

  it("a viewBox not at 0, 0 still puts the page corner on the origin", () => {
    const { s } = insert(svg('<rect x="-10" y="-10" width="10" height="10"/>', 'width="20mm" height="20mm" viewBox="-10 -10 20 20"'));
    expect(Math.min(...xs(s))).toBeCloseTo(0, 9);
    expect(Math.max(...ys(s))).toBeCloseTo(20, 9);
  });

  it("no page size: the shapes' bottom-left corner on the origin", () => {
    const { s } = insert('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="100" cy="100" r="10"/></svg>');
    const c = s.curves[0];
    if (c.type !== "circle") throw new Error();
    pointPos(s, c.center).forEach((v) => expect(v).toBeCloseTo((10 * 25.4) / 96, 9));
  });

  it("the scale multiplies everything", () => {
    const { s } = insert(svg('<rect width="10" height="10"/>'), 2.5);
    expect(areaOf(s)).toBeCloseTo(625, 9);
    expect(insertSvg(emptySketch(), parseSvg(svg('<rect width="1" height="1"/>')), 0).error).toMatch(/scale/);
  });
});

describe("Insert SVG: limits and errors", () => {
  it("not an SVG", () => {
    expect(() => parseSvg("hello")).toThrow(/doesn't look like an SVG/);
    expect(() => parseSvg("<html><body/></html>")).toThrow(/./);
  });

  it("too big, too many shapes, too many pieces", () => {
    expect(() => parseSvg(" ".repeat(MAX_SVG_SIZE + 1))).toThrow(/too big/);
    expect(() => parseSvg(svg('<line x2="1"/>'.repeat(20001)))).toThrow(/more than 20,000 shapes/);
    const long = "M0 0" + " l1 0".repeat(50001);
    expect(() => parseSvg(svg(`<path d="${long}"/>`))).toThrow(/more than 50,000 lines and curves/);
  });

  it("an empty drawing says so", () => {
    expect(insertSvg(emptySketch(), parseSvg(svg("")), 1).error).toMatch(/no shapes/);
  });

  it("adds to what the sketch has already", () => {
    const first = insert(svg('<rect width="1" height="1"/>')).s;
    const r = insertSvg(first, parseSvg(svg('<rect x="5" width="1" height="1"/>')), 1);
    expect(r.sketch.curves).toHaveLength(8);
    expect(r.curveIds).toHaveLength(4);
  });
});
