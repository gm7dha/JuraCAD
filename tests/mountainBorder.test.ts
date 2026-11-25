/**
 * Mountain puzzle extras (pure): trimming the area in from each side before it's laid out, and the frame round the
 * finished puzzle — closed pieces that fit the bed, their top one smooth line a little above the land all round, clear of it by the fit gap,
 * locked together by lugs that hit when pulled apart, and the words on the front a part of their own on filament 2.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { crossesItself, outlineGap, type P2 } from "../src/library/outlines";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { BORDER_WALL, borderWords, LUG_DEPTH, makeBorder, MAX_SLOPE, MIN_CAPS, MIN_PIECE, RELIEF, RISE, TEXT_MARGIN, type BorderPiece } from "../src/terrain/mountainBorder";
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

  it("follows the land along each edge, standing above it everywhere", () => {
    const T = BORDER_WALL;
    // Every corner of the puzzle near a face has the frame's top at least RISE above it, just outside that face.
    const near = fit + 0.5;
    let checked = 0;
    for (const p of puzzle.pieces)
      for (const b of p.bodies)
        for (let i = 0; i < b.vertices.length; i += 3) {
          const [x, y, z] = [b.vertices[i], b.vertices[i + 1], b.vertices[i + 2]];
          const at: [number, number][] = [];
          if (y <= near) at.push([x, -fit - 0.01]);
          if (y >= PH - near) at.push([x, PH + fit + 0.01]);
          if (x <= near) at.push([-fit - 0.01, y]);
          if (x >= PW - near) at.push([PW + fit + 0.01, y]);
          for (const [u, v] of at) {
            expect(border.topAt(u, v), `${u}, ${v}`).toBeGreaterThanOrEqual(z + RISE - 1e-6);
            expect(border.topAt(u, v - (v < 0 ? T / 2 : v > PH ? -T / 2 : 0))).toBeGreaterThanOrEqual(z + RISE - 1e-6);
            checked++;
          }
        }
    expect(checked).toBeGreaterThan(100);
    // It really follows the shape: each side's wall isn't one flat height, and never stands higher than the land needs.
    expect(Object.values(border.lows).some((low, i) => Object.values(border.heights)[i] - low > 3)).toBe(true);
    const need = Math.max(...Object.values(border.peaks)) + RISE;
    for (const s of ["E", "N", "W"] as const) {
      expect(border.heights[s]).toBeGreaterThanOrEqual(border.peaks[s] + RISE - 1e-6);
      expect(border.heights[s]).toBeLessThanOrEqual(need + 1e-6);
    }
    // The highest point really is near that edge.
    let top = 0;
    for (const p of puzzle.pieces) for (const b of p.bodies) for (let i = 0; i < b.vertices.length; i += 3) if (b.vertices[i + 1] <= fit + 0.5) top = Math.max(top, b.vertices[i + 2]);
    expect(border.peaks.S).toBeCloseTo(top, 6);
  });

  it("has a smooth top all the way round, with no step at any join or corner", () => {
    // Every piece's top is the one shared function.
    for (const p of border.pieces) {
      const v = p.bodies[0].vertices;
      for (let i = 0; i < v.length; i += 3) if (v[i + 2] > 0) expect(v[i + 2]).toBeCloseTo(border.topAt(v[i], v[i + 1]), 9);
    }
    // Walk round the frame's middle line in small steps: the height never jumps, and never climbs faster than MAX_SLOPE.
    const m = BORDER_WALL / 2;
    const loop: [number, number][] = [];
    const seg = (a: [number, number], b: [number, number]) => {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05);
      for (let i = 0; i < n; i++) loop.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
    };
    seg([-m, -m], [PW + m, -m]);
    seg([PW + m, -m], [PW + m, PH + m]);
    seg([PW + m, PH + m], [-m, PH + m]);
    seg([-m, PH + m], [-m, -m]);
    let steepest = 0;
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
      const dh = Math.abs(border.topAt(...a) - border.topAt(...b));
      steepest = Math.max(steepest, dh / Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    expect(steepest).toBeLessThanOrEqual(MAX_SLOPE + 1e-6);
    // At every join both pieces meet at exactly the same height: across the joint line and the lugs, inside to outside.
    for (const j of border.joints) {
      const a = border.pieces[j.lower];
      const b = border.pieces[j.upper];
      const tops = (p: BorderPiece) => {
        const v = p.bodies[0].vertices;
        const out: [number, number, number][] = [];
        for (let i = 0; i < v.length; i += 3) if (v[i + 2] > 0) out.push([v[i], v[i + 1], v[i + 2]]);
        return out;
      };
      // Where the two faces of the join are 2 × fit apart, their heights differ by no more than the slope allows.
      const ta = tops(a);
      const tb = tops(b);
      let pairs = 0;
      for (const [x, y, z] of ta)
        for (const [u, v, w] of tb) {
          const d = Math.hypot(x - u, y - v);
          if (d > 2 * fit + 1e-6) continue;
          expect(Math.abs(z - w)).toBeLessThanOrEqual(MAX_SLOPE * d + 1e-6);
          pairs++;
        }
      expect(pairs, `${a.name} / ${b.name}`).toBeGreaterThan(0);
      // And the shared height just either side of the join line is the same.
      const xs = (p: BorderPiece) => p.outline.map((q) => (j.dir[0] ? q[0] : q[1]));
      const s0 = Math.min(Math.max(...xs(a)), Math.max(...xs(b)));
      const t = j.side === "S" ? -m : j.side === "N" ? PH + m : j.side === "W" ? -m : PW + m;
      const at = (s: number): [number, number] => (j.dir[0] ? [s, t] : [t, s]);
      expect(Math.abs(border.topAt(...at(s0 - 1e-7)) - border.topAt(...at(s0 + 1e-7)))).toBeLessThan(1e-6);
    }
    // Corners: the two sides and the corner square are one height where they meet.
    for (const [cx, cy, sx, sy] of [
      [0, 0, -1, -1],
      [PW, 0, 1, -1],
      [PW, PH, 1, 1],
      [0, PH, -1, 1],
    ]) {
      const c = border.topAt(cx + sx * m, cy + sy * m);
      expect(Math.abs(border.topAt(cx - sx * 1e-7, cy + sy * m) - c)).toBeLessThan(1e-6);
      expect(Math.abs(border.topAt(cx + sx * m, cy - sy * 1e-7) - c)).toBeLessThan(1e-6);
    }
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
      expect(v[i + 2]).toBeGreaterThan(TEXT_MARGIN - 1e-6);
      expect(v[i + 2]).toBeLessThan(border.topAt(v[i], border.face) - TEXT_MARGIN + 1e-6);
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

  it("on rugged ground and a cliff at the edge: sound pieces, flat bottoms, a lip above every edge point, walls tall enough for the lugs", () => {
    const shapes = [
      (e: number, n: number) => 200 + 600 * Math.abs(Math.sin(e / 230) * Math.cos(n / 310)) + 150 * Math.sin(e / 47 + n / 61),
      (e: number, n: number) => 100 + (e < 200300 ? 900 : 0) + 300 * Math.exp(-(((n - 771500) / 300) ** 2)),
    ];
    for (const shape of shapes) {
      const ground = gridFrom({ e: 200000, n: 770000 }, W, H, 20, shape);
      const pz = makeMountainPuzzle(ground, W, H, SPEC);
      const b = makeBorder(pz, words);
      expect(b.problems).toEqual([]);
      const pw = pz.layout.cols * SPEC.cube;
      const ph = pz.layout.rows * SPEC.cube;
      for (const p of b.pieces) {
        const { vertices: v, triangles: t } = p.bodies[0];
        expect(closed(p.bodies[0]).open, p.name).toBe(0);
        for (let i = 0; i < t.length; i += 3) {
          const [a, c, e] = [t[i], t[i + 1], t[i + 2]].map((k) => [v[3 * k], v[3 * k + 1], v[3 * k + 2]]);
          const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const w = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
          expect(Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]), p.name).toBeGreaterThan(1e-9);
        }
        // Every point is on the bed or on the top; the lowest top leaves the full-height lugs plenty to hold by.
        for (let i = 2; i < v.length; i += 3) if (v[i] !== 0) expect(v[i]).toBeCloseTo(b.topAt(v[i - 2], v[i - 1]), 9);
        const tops = v.filter((z, i) => i % 3 === 2 && z > 0);
        expect(Math.min(...tops), p.name).toBeGreaterThanOrEqual(10);
      }
      const near = fit + 0.5;
      for (const p of pz.pieces)
        for (const body of p.bodies)
          for (let i = 0; i < body.vertices.length; i += 3) {
            const [x, y, z] = [body.vertices[i], body.vertices[i + 1], body.vertices[i + 2]];
            if (y <= near) expect(b.topAt(x, -fit - 0.01)).toBeGreaterThanOrEqual(z + RISE - 1e-6);
            if (y >= ph - near) expect(b.topAt(x, ph + fit + 0.01)).toBeGreaterThanOrEqual(z + RISE - 1e-6);
            if (x <= near) expect(b.topAt(-fit - 0.01, y)).toBeGreaterThanOrEqual(z + RISE - 1e-6);
            if (x >= pw - near) expect(b.topAt(pw + fit + 0.01, y)).toBeGreaterThanOrEqual(z + RISE - 1e-6);
          }
    }
  });
});

describe("Border on a small bed", () => {
  const bed: [number, number, number] = [180, 180, 180];
  const spans = (b: ReturnType<typeof makeBorder>) =>
    b.pieces
      .filter((p) => p.side.length === 1)
      .map((p) => {
        const xs = p.outline.map((q) => q[0]);
        const ys = p.outline.map((q) => q[1]);
        return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      });
  for (const scale of [1.2, 1.25, 1.3])
    for (const words of ["Carn Mor Dearg Arete and the North Face", borderWords("Carn Mor Dearg Arete and the North Face", 1220, "NN 177 722", 25000)])
      it(`leaves no sliver beside the name plate (scale ${scale}, ${words.includes("\n") ? "two lines" : "one line"})`, () => {
        const puzzle = makeMountainPuzzle(hill, W, H, { ...SPEC, bed, scale });
        const b = makeBorder(puzzle, words, bed);
        if (b.problems.length) {
          expect(b.problems[0]).toMatch(/too long|too short/);
          return;
        }
        for (const len of spans(b)) expect(len).toBeGreaterThanOrEqual(LUG_DEPTH + 2 * SPEC.fit + 3);
        for (const p of b.pieces) expect(crossesItself(p.outline), p.name).toBe(false);
        for (let i = 0; i < b.pieces.length; i++)
          for (let j = i + 1; j < b.pieces.length; j++) expect(outlineGap(b.pieces[i].outline, b.pieces[j].outline)).toBeGreaterThanOrEqual(2 * SPEC.fit - 1e-6);
        // Front pieces beside the plate are 0 or a proper piece.
        const front = b.pieces.filter((p) => p.side === "S");
        expect(front.filter((p) => p.words)).toHaveLength(1);
        for (const p of front) {
          const xs = p.outline.map((q) => q[0]);
          expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(MIN_PIECE);
        }
        // The words sit on their plate.
        const plate = front.find((p) => p.words)!;
        const xs = plate.outline.map((q) => q[0]);
        const wv = plate.words!.vertices.filter((_, i) => i % 3 === 0);
        expect(Math.min(...wv)).toBeGreaterThan(Math.min(...xs));
        expect(Math.max(...wv)).toBeLessThan(Math.max(...xs));
      });
});
