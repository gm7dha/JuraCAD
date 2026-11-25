/**
 * Insert SVG with files as real programs write them: Inkscape (mm page, layers
 * with transforms, a hidden layer), Illustrator (pt-sized user units with px or
 * no units, <style> classes, a hidden class), Cricut-style files (px, no units,
 * thousands of tiny paths) and JuraCAD's own Export for laser.
 */
import { describe, expect, it } from "vitest";

import { insertSvg, parseSvg, svgSummary } from "../src/sketch/svg";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch } from "../src/sketch/solver";
import { sketchAreas } from "../src/sketch/areas";
import { curveParam } from "../src/sketch/curves";
import { pointPos } from "../src/sketch/ops";
import { laserSvg } from "../src/laser/laserFiles";
import { layoutPieces } from "../src/laser/laser";
import { emptySketch, type SketchData } from "../src/sketch/types";

const insert = (text: string, scale = 1) => {
  const d = parseSvg(text);
  const r = insertSvg(emptySketch(), d, scale);
  if (r.error) throw new Error(r.error);
  return { d, r, s: r.sketch };
};
const box = (s: SketchData) => {
  const xs = s.points.map((p) => p.x);
  const ys = s.points.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
/** Areas round arcs are measured on a fine polygon, so allow a little. */
const about = (a: number, b: number) => expect(Math.abs(a - b) / b).toBeLessThan(0.003);
const netArea = (s: SketchData) => findRegions(s).regions.reduce((t, r) => t + r.outer.area - r.holes.reduce((h, x) => h + x.area, 0), 0);

describe("Insert SVG: Inkscape files", () => {
  const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg5"
   inkscape:version="1.3 (0e150ed6c4, 2023-07-21)" sodipodi:docname="plate.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:document-units="mm" />
  <defs id="defs2" />
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(-10,-20)">
    <path style="fill:none;stroke:#000000;stroke-width:0.264583" d="m 30,40 h 60 v 40 h -60 z" id="rect1" />
    <circle style="fill:none;stroke:#000000;stroke-width:0.264583" id="path2" cx="60" cy="60" r="10" />
    <path sodipodi:type="arc" style="fill:none;stroke:#000000" id="path3" sodipodi:cx="40" sodipodi:cy="50" sodipodi:rx="4" sodipodi:ry="4"
       d="M 44,50 A 4,4 0 0 1 40,54 4,4 0 0 1 36,50 4,4 0 0 1 40,46 4,4 0 0 1 44,50 Z" />
  </g>
  <g inkscape:groupmode="layer" id="layer2" inkscape:label="Hidden notes" style="display:none">
    <rect x="0" y="0" width="5" height="5" />
  </g>
</svg>`;

  it("comes in at true size, layer moves applied, hidden layers left out", () => {
    const { s, d, r } = insert(inkscape);
    expect(d.sized).toBe(true);
    expect(r.count).toBe(3);
    // Plate x 20…80, SVG y 20…60 → sketch y 297 − 60 … 297 − 20.
    const [x0, y0, x1, y1] = box(s);
    expect([x0, y0, x1, y1].map((v) => +v.toFixed(9))).toEqual([20, 237, 80, 277]);
    // The 4-arc path is a whole circle drawn as arcs: four arcs of r 4.
    const arcs = s.curves.filter((c) => c.type === "arc");
    expect(arcs).toHaveLength(4);
    about(netArea(s), 2400 - Math.PI * 100 - Math.PI * 16);
  });
});

describe("Insert SVG: Illustrator files", () => {
  // Illustrator's user unit is the point (1/72 in), but it writes px or nothing.
  const illustrator = (size: string) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 ${size} viewBox="0 0 283.46 141.73" style="enable-background:new 0 0 283.46 141.73;" xml:space="preserve">
<style type="text/css">
	.st0{fill:none;stroke:#000000;stroke-miterlimit:10;}
	.st1{display:none;}
	.st2 { fill : #FF0000 ; visibility : hidden }
</style>
<rect x="28.35" y="28.35" class="st0" width="226.77" height="85.04"/>
<g class="st1"><rect x="0" y="0" width="10" height="10"/></g>
<circle class="st2" cx="5" cy="5" r="3"/>
<polygon class="st0" points="141.73,42.52 170.08,99.21 113.39,99.21 "/>
</svg>`;

  it("reads its px (or plain numbers) as points, so the drawing is true size", () => {
    for (const size of ['width="283.46px" height="141.73px"', "", 'width="283.46" height="141.73"']) {
      const { s, d } = insert(illustrator(size));
      const [x0, , x1] = box(s);
      // The rectangle is 226.77 pt = 80 mm wide.
      expect(x1 - x0).toBeCloseTo(80, 2);
      expect(d.page![0]).toBeCloseTo(100, 2);
      expect(svgSummary(d, 2, 1)).toMatch(/Illustrator/);
    }
  });

  it("leaves out shapes a <style> class hides", () => {
    const { r, s } = insert(illustrator('width="283.46px" height="141.73px"'));
    expect(r.count).toBe(2);
    expect(s.curves.filter((c) => c.type === "circle")).toHaveLength(0);
  });

  it("a file sized in pt comes in at that size", () => {
    const { s, d } = insert(illustrator('width="283.46pt" height="141.73pt"'));
    expect(d.sized).toBe(true);
    const [x0, , x1] = box(s);
    expect(x1 - x0).toBeCloseTo(80, 2);
  });
});

/** A Cricut-style file: px with no units, every piece its own little path. */
function cricut(pieces: number): string {
  const paths: string[] = [];
  const cols = Math.ceil(Math.sqrt(pieces));
  for (let k = 0; k < pieces; k++) {
    const x = (k % cols) * 12;
    const y = Math.floor(k / cols) * 12;
    // A leaf: two cubics, closed.
    paths.push(`<path fill="#3B2F2A" d="M${x + 1},${y + 5}C${x + 3},${y + 1} ${x + 7},${y + 1} ${x + 9},${y + 5}C${x + 7},${y + 9} ${x + 3},${y + 9} ${x + 1},${y + 5}z"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * 12} ${cols * 12}">${paths.join("")}</svg>`;
}

describe("Insert SVG: Cricut-style files", () => {
  it("px with no units are read at 96 to the inch and every leaf is a closed shape", () => {
    const { s, d, r } = insert(cricut(16));
    expect(d.sized).toBe(false);
    expect(r.count).toBe(16);
    expect(findRegions(s).regions).toHaveLength(16);
    // 8 px = 8 × 25.4 / 96 mm across a leaf.
    const leaf = s.curves[0];
    expect(leaf.type).toBe("spline");
  });

  it("5,000 pieces come in, and the sketch's own checks stay quick", () => {
    const text = cricut(5000);
    let t = performance.now();
    const { s, r } = insert(text);
    const insertMs = performance.now() - t;
    expect(r.count).toBe(5000);
    t = performance.now();
    analyzeSketch(s);
    const analyzeMs = performance.now() - t;
    t = performance.now();
    const regions = findRegions(s).regions.length;
    const regionsMs = performance.now() - t;
    t = performance.now();
    sketchAreas(s);
    const areasMs = performance.now() - t;
    console.log(`5000 pieces: insert ${insertMs.toFixed(0)} ms, analyze ${analyzeMs.toFixed(0)} ms, regions ${regionsMs.toFixed(0)} ms, areas ${areasMs.toFixed(0)} ms`);
    expect(regions).toBe(5000);
    // Generous: CI machines are busy.
    expect(insertMs + analyzeMs + regionsMs + areasMs).toBeLessThan(60000);
  });
});

describe("Insert SVG: curves", () => {
  it("a sharp corner between two curves stays sharp, and the shape is exact", () => {
    const { s } = insert(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M10 50 C10 20 40 20 50 50 C60 20 90 20 90 50 Z"/></svg>`);
    const sp = s.curves.find((c) => c.type === "spline");
    if (!sp || sp.type !== "spline") throw new Error("no spline");
    // The corner at (50, 50): arriving and leaving handles differ.
    const corner = s.points.find((p) => Math.abs(p.x - 50) < 1e-9 && Math.abs(p.y - 50) < 1e-9)!;
    expect(sp.tangentsIn?.[corner.id]).toBeTruthy();
    const c = curveParam(s, sp)!;
    // The first curve's middle: B(0.5) = (10·1 + 3·10·1 + 3·40·1 + 50)/8 … in SVG y: (25.0, 27.5) → sketch y 72.5.
    const mid = c.at(0.5);
    expect(mid[0]).toBeCloseTo(26.25, 9);
    expect(mid[1]).toBeCloseTo(100 - 27.5, 9);
  });

  it("an all-curves outline that ends where it started without Z is still one closed shape", () => {
    const { s } = insert(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M10 50 C10 20 90 20 90 50 C90 80 10 80 10 50"/></svg>`);
    expect(findRegions(s).regions).toHaveLength(1);
  });

  it("zero-length curves, repeated points and retracted handles don't break the shape", () => {
    const { s } = insert(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M10 10 C10 10 10 10 10 10 L50 10 L50 10 C50 10 60 30 50 50 C50 50 50 50 50 50 L10 50 Z"/></svg>`,
    );
    expect(findRegions(s).regions).toHaveLength(1);
    expect(sketchAreas(s).areas.length).toBeGreaterThan(0);
  });

  it("overlapping shapes split the page into areas that can each be picked", () => {
    const { s } = insert(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><rect x="10" y="10" width="40" height="40"/><circle cx="50" cy="50" r="20"/></svg>`);
    // Square less the overlap, the overlap, circle less the overlap.
    expect(sketchAreas(s).areas).toHaveLength(3);
  });
});

describe("Insert SVG: JuraCAD's own laser files", () => {
  it("an Export for laser file comes back at exactly its size and place", () => {
    const sheet = layoutPieces([
      {
        name: "Plate",
        paths: [
          { layer: "outer", closed: true, segments: [
            { kind: "line", from: [0, 0], to: [40, 0] },
            { kind: "arc", from: [40, 0], mid: [50, 10], to: [40, 20] },
            { kind: "line", from: [40, 20], to: [0, 20] },
            { kind: "line", from: [0, 20], to: [0, 0] },
          ] },
          { layer: "inner", closed: true, segments: [{ kind: "circle", center: [10, 10], radius: 3 }] },
        ],
      },
    ]);
    const text = laserSvg(sheet);
    const { s, d } = insert(text);
    expect(d.sized).toBe(true);
    // Same box as the sheet's paths (which start at 0, 0).
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of s.curves)
      if (c.type === "circle") {
        const [cx, cy] = pointPos(s, c.center);
        xs.push(cx - c.radius, cx + c.radius);
        ys.push(cy - c.radius, cy + c.radius);
      }
    const [x0, y0, x1, y1] = box(s);
    const bx = [Math.min(x0, ...xs), Math.min(y0, ...ys), Math.max(x1, ...xs), Math.max(y1, ...ys)];
    // The arc bulges to x = 50 though its points stop at 40.
    expect(bx[0]).toBeCloseTo(0, 6);
    expect(bx[1]).toBeCloseTo(0, 6);
    expect(bx[3]).toBeCloseTo(20, 6);
    expect(s.curves.filter((c) => c.type === "arc")).toHaveLength(1);
    expect(s.curves.filter((c) => c.type === "circle")).toHaveLength(1);
    about(netArea(s), 800 + (Math.PI * 100) / 2 - Math.PI * 9);
  });
});
