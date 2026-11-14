/**
 * Mountain puzzle extras (pure): trimming the area in from each side before it's laid out, and the frame round the
 * finished puzzle — closed pieces that fit the bed, as tall as the puzzle along each edge, clear of it by the fit gap,
 * locked together by lugs that hit when pulled apart, and the words on the front a part of their own on filament 2.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { crossesItself, outlineGap, type P2 } from "../src/library/outlines";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { BORDER_WALL, borderWords, LUG_DEPTH, makeBorder, MIN_CAPS, RELIEF, type BorderPiece } from "../src/terrain/mountainBorder";
import { cropGrid, cropPixels, NO_TRIM } from "../src/terrain/mountainCrop";
import { layoutFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type Body, type MountainSpec } from "../src/terrain/mountainPuzzle";
import { BED_MARGIN, bandPlateFiles, platesFor } from "../src/terrain/puzzle3mf";

const W = 4000;
const H = 3000;
const hill = gridFrom({ e: 200000, n: 770000 }, W, H, 20, (e, n) => 300 + 1000 * Math.exp(-(((e - 201800) / 900) ** 2 + ((n - 771500) / 700) ** 2)) + 40 * Math.sin(e / 170));
const SPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256], snowline: 1000 };

function closed(b: { vertices: number[]; triangles: number[] }): { open: number; volume: number } {
  const m = weld(b.vertices, b.triangles);
  const edges = new Map<string, number>();
  let volume = 0;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const ids = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${ids[k]}>${ids[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const [A, B, C] = ids.map((i) => m.vertices.slice(i * 3, i * 3 + 3));
    volume += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
  }
  let open = 0;
  for (const [key, n] of edges) {
    const [a, c] = key.split(">");
    if (n !== 1 || edges.get(`${c}>${a}`) !== 1) open++;
  }
  return { open, volume };
}

describe("Trimming the area", () => {
  it("leaves everything as it was with nothing trimmed", () => {
    const c = cropGrid(hill, W, H, NO_TRIM);
    expect(c.grid).toBe(hill);
    expect([c.width, c.height, c.west, c.south]).toEqual([W, H, 0, 0]);
    const px = { grey: new Float32Array(12), width: 4, height: 3 };
    expect(cropPixels(px, NO_TRIM).pixels).toBe(px);
  });

  it("cuts in from each side by the share asked, keeping the heights exactly", () => {
    const c = cropGrid(hill, W, H, { n: 0.1, e: 0.25, s: 0.2, w: 0.05 });
    expect(c.west).toBe(200);
    expect(c.south).toBe(600);
    expect(c.width).toBe(W - 200 - 1000);
    expect(c.height).toBe(H - 600 - 300);
    expect(c.grid.e0).toBe(hill.e0 + 200);
    expect(c.grid.n0).toBe(hill.n0 + 600);
    for (const [e, n] of [
      [200400, 770700],
      [201234, 771800],
      [202700, 772600],
    ])
      expect(heightAt(c.grid, e, n)).toBeCloseTo(heightAt(hill, e, n), 4);
    // The puzzle is laid out again on the smaller area, by the same rules.
    const L = layoutFor(c.grid, c.width, c.height, SPEC);
    expect(L.e0).toBeGreaterThanOrEqual(c.grid.e0 - 1e-6);
    expect(L.e0 + L.width).toBeLessThanOrEqual(c.grid.e0 + c.width + 1e-6);
    expect(L.n0 + L.height).toBeLessThanOrEqual(c.grid.n0 + c.height + 1e-6);
    expect(L.k).toBeGreaterThan(layoutFor(hill, W, H, SPEC).k);
  });

  it("always leaves some of the area", () => {
    const c = cropGrid(hill, W, H, { n: 0.45, s: 0.45, e: 0.45, w: 0.45 });
    expect(c.width).toBeGreaterThanOrEqual(0.1 * W - 20);
    expect(c.height).toBeGreaterThanOrEqual(0.1 * H - 20);
  });

  it("trims a picture by whole pixels, north from its top rows", () => {
    const grey = new Float32Array(10 * 11).map((_, i) => i);
    const { pixels, west, south } = cropPixels({ grey, width: 10, height: 11 }, { n: 0.2, s: 0.1, e: 0, w: 0.3 });
    expect([west, south]).toEqual([2, 1]);
    expect(pixels.width).toBe(8);
    expect(pixels.height).toBe(11 - 2 - 1);
    expect(pixels.grey[0]).toBe(2 * 10 + 2);
  });
});

describe("Border round the puzzle", () => {
  const puzzle = makeMountainPuzzle(hill, W, H, SPEC);
  const words = borderWords("Test Hill", 1340, "NN 166 712", 25000);
  const border = makeBorder(puzzle, words);
  const fit = SPEC.fit;
  const PW = puzzle.layout.cols * SPEC.cube;
  const PH = puzzle.layout.rows * SPEC.cube;

  it("has no problems and a piece for each corner", () => {
    expect(border.problems).toEqual([]);
    for (const c of ["SW", "SE", "NE", "NW"]) expect(border.pieces.filter((p) => p.side === c)).toHaveLength(1);
    expect(words).toBe("Test Hill\n1340 m · NN 166 712 · 1:25,000");
  });

  it("is made of closed pieces with room inside", () => {
    for (const p of border.pieces) {
      expect(crossesItself(p.outline), p.name).toBe(false);
      for (const b of [...p.bodies, ...(p.words ? [p.words] : [])]) {
        const c = closed(b);
        expect(c.open, p.name).toBe(0);
        expect(c.volume, p.name).toBeGreaterThan(0);
      }
    }
  });

  it("fits every piece on the bed, standing at z 0", () => {
    for (const p of border.pieces) {
      const xs = p.outline.map((q) => q[0]);
      const ys = p.outline.map((q) => q[1]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(256 - 2 * BED_MARGIN);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(256 - 2 * BED_MARGIN);
      const zs = p.bodies[0].vertices.filter((_, i) => i % 3 === 2);
      expect(Math.min(...zs)).toBe(0);
      expect(Math.max(...zs)).toBe(p.height);
    }
    // At 100% the long sides need more than one piece.
    expect(border.pieces.length).toBeGreaterThan(4);
    const plates = platesFor(border.pieces, SPEC.bed);
    for (const plate of plates)
      for (const { piece, move } of plate.pieces) for (const [x, y] of piece.outline) expect(x + move[0] <= 256 && y + move[1] <= 256 && x + move[0] >= 0 && y + move[1] >= 0).toBe(true);
  });

  it("stands at least as high as the puzzle along each edge; corners take the higher side", () => {
    for (const s of ["S", "E", "N", "W"] as const) {
      expect(border.heights[s]).toBeGreaterThanOrEqual(border.peaks[s]);
      expect(border.peaks[s]).toBeGreaterThan(10);
      for (const p of border.pieces.filter((q) => q.side === s)) expect(p.height).toBe(border.heights[s]);
    }
    const sw = border.pieces.find((p) => p.side === "SW")!;
    expect(sw.height).toBe(Math.max(border.heights.S, border.heights.W));
    // The highest point really is near that edge.
    let top = 0;
    for (const p of puzzle.pieces) for (const b of p.bodies) for (let i = 0; i < b.vertices.length; i += 3) if (b.vertices[i + 1] <= fit + 0.5) top = Math.max(top, b.vertices[i + 2]);
    expect(border.peaks.S).toBeCloseTo(top, 6);
  });

  it("keeps the fit gap from the puzzle all round", () => {
    for (const p of border.pieces)
      for (const q of puzzle.pieces) {
        if (q.layer !== 0) continue;
        expect(outlineGap(p.outline, q.outline)).toBeGreaterThanOrEqual(fit - 1e-6);
      }
    // And sits close round it: the inside faces are 2 × fit from the puzzle's outside.
    const xs = border.pieces.filter((p) => p.side === "W").flatMap((p) => p.outline.map((q) => q[0]));
    expect(Math.max(...xs)).toBeCloseTo(-fit, 6);
    const ys = border.pieces.filter((p) => p.side === "N").flatMap((p) => p.outline.map((q) => q[1]));
    expect(Math.min(...ys)).toBeCloseTo(PH + fit, 6);
    expect(Math.min(...border.pieces.flatMap((p) => p.outline.map((q) => q[0])))).toBeCloseTo(-BORDER_WALL + fit, 6);
    expect(PW).toBeGreaterThan(0);
  });

  it("joins the pieces with lugs that leave a fit gap and lock when pulled apart", () => {
    const n = border.pieces.length;
    // Every piece is joined at both ends: a closed ring of joins.
    expect(border.joints).toHaveLength(n);
    const moved = (o: P2[], [dx, dy]: P2, by: number): P2[] => o.map(([x, y]) => [x + dx * by, y + dy * by]);
    for (const j of border.joints) {
      const a = border.pieces[j.lower].outline;
      const b = border.pieces[j.upper].outline;
      expect(outlineGap(a, b)).toBeGreaterThanOrEqual(2 * fit - 1e-6);
      // Pulled apart along the wall, the lug's head catches; nudged by less than the gap, nothing touches.
      expect(outlineGap(moved(a, j.dir, -(2 * fit + 0.05)), b)).toBe(0);
      expect(outlineGap(moved(a, j.dir, -fit), b)).toBeGreaterThan(0);
      // Lifted out upwards it comes free (it only drops in from above): the outlines never overlap.
    }
    for (const p of border.pieces.filter((q) => !q.side.length || q.side.length === 1)) {
      const xs = p.outline.map((q) => q[0]);
      const ys = p.outline.map((q) => q[1]);
      expect(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))).toBeGreaterThan(LUG_DEPTH + 3);
    }
  });

  it("puts the words on the front's outside face as their own part, on filament 2", () => {
    const withWords = border.pieces.filter((p) => p.words);
    expect(withWords).toHaveLength(1);
    const plate = withWords[0] as BorderPiece;
    expect(plate.side).toBe("S");
    expect(Math.min(...border.caps)).toBeGreaterThanOrEqual(MIN_CAPS);
    const v = plate.words!.vertices;
    const xs = plate.outline.map((q) => q[0]);
    for (let i = 0; i < v.length; i += 3) {
      expect(v[i + 1]).toBeLessThanOrEqual(border.face + 1e-6);
      expect(v[i + 1]).toBeGreaterThanOrEqual(border.face - RELIEF - 1e-6);
      expect(v[i]).toBeGreaterThan(Math.min(...xs));
      expect(v[i]).toBeLessThan(Math.max(...xs));
      expect(v[i + 2]).toBeGreaterThan(0);
      expect(v[i + 2]).toBeLessThan(plate.height);
    }
    // The face really is the wall's outside.
    expect(Math.min(...plate.outline.map((q) => q[1]))).toBeCloseTo(border.face, 6);
    const plates = platesFor(border.pieces, SPEC.bed);
    const parts = (p: { name: string; bodies: Body[] }) => {
      const b = p as BorderPiece;
      return [
        { filament: 1, label: "frame", ...weld(b.bodies[0].vertices, b.bodies[0].triangles) },
        ...(b.words ? [{ filament: 2, label: "words", ...weld(b.words.vertices, b.words.triangles) }] : []),
      ];
    };
    const files = plates.map((pl, i) => bandPlateFiles(pl, `Border ${i + 1}`, parts, () => ""));
    const all = files.map((f) => f.config).join("");
    expect(all).toContain('<metadata key="extruder" value="2"/>');
    expect(all.match(/words/g)?.length).toBe(1);
  });

  it("can be made without words, and refuses words too long for the front", () => {
    const plain = makeBorder(puzzle, "");
    expect(plain.problems).toEqual([]);
    expect(plain.pieces.every((p) => !p.words)).toBe(true);
    const long = makeBorder(puzzle, "A very long name for a hill that goes on and on and on and on and on and on and on and on and on and on".repeat(2));
    expect(long.problems[0]).toMatch(/too long/);
  });

  it("works at twice the size (more pieces) and on a small puzzle", () => {
    const big = makeMountainPuzzle(hill, W, H, { ...SPEC, scale: 2 });
    const b = makeBorder(big, words);
    expect(b.problems).toEqual([]);
    for (const p of b.pieces) expect(closed(p.bodies[0]).open).toBe(0);
    expect(b.joints).toHaveLength(b.pieces.length);
    const small = makeMountainPuzzle(hill, W, H, { ...SPEC, scale: 0.25 });
    const s = makeBorder(small, "");
    expect(s.problems).toEqual([]);
    for (const p of s.pieces) expect(closed(p.bodies[0]).open).toBe(0);
  });
});
