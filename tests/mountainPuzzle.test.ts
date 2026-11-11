/**
 * Mountain puzzle (pure): OS grid references, reading terrarium height tiles, flat faces into triangles, and the
 * puzzle itself — every part watertight, pieces in a layer clear of each other by the fit gap, each key right under
 * its pocket and fitting no neighbour's, snow only above the snow line, sizes refused or warned about, and the pieces laid out on plates and written
 * as 3MF files with the snow on filament 2.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { insideGap, outlineGap, type P2 as LP2 } from "../src/library/outlines";
import { areaProblem, gridFrom, heightAt, readHeights, terrariumHeight, tilesFor, worldPixel, type TilePixels } from "../src/terrain/elevation";
import {
  baseFor,
  plateFor,
  PLATE_MIN,
  layoutFor,
  makeMountainPuzzle,
  mountainChecks,
  MOUNTAIN_DEFAULTS,
  neckFor,
  smallestCube,
  MIN_NECK,
  GOOD_NECK,
  keyLoop,
  WALL,
  type Key,
  type MountainSpec,
  type Body,
} from "../src/terrain/mountainPuzzle";
import { formatGridRef, gridToLatLon, parseGridRef } from "../src/terrain/osGrid";
import { PEAKS } from "../src/terrain/peaks";
import { FILAMENT, plate3mf, plateFiles, platesFor } from "../src/terrain/puzzle3mf";
import { triangulate, type P2 } from "../src/terrain/triangulate";

describe("OS grid references", () => {
  it("reads letters and digits, and plain eastings/northings", () => {
    expect(parseGridRef("NN 16667 71283")).toEqual({ e: 216667, n: 771283 });
    expect(parseGridRef("nn166712")).toEqual({ e: 216600, n: 771200 });
    expect(parseGridRef("NN 1671")).toEqual({ e: 216000, n: 771000 });
    expect(parseGridRef("SH 609 543")).toEqual({ e: 260900, n: 354300 });
    expect(parseGridRef("216667, 771283")).toEqual({ e: 216667, n: 771283 });
    expect(parseGridRef("NN 123")).toBeNull();
    expect(parseGridRef("hello")).toBeNull();
    expect(formatGridRef({ e: 216667, n: 771283 })).toBe("NN 16667 71283");
    expect(formatGridRef({ e: 530080, n: 180390 }, 6)).toBe("TQ 300 803");
  });

  it("finds summits where the maps put them (WGS84, within ~10 m)", () => {
    const near = (ref: string, lat: number, lon: number) => {
      const ll = gridToLatLon(parseGridRef(ref)!);
      expect(Math.abs(ll.lat - lat)).toBeLessThan(0.0001);
      expect(Math.abs(ll.lon - lon)).toBeLessThan(0.00015);
    };
    near("NN 16667 71283", 56.79685, -5.00368); // Ben Nevis
    near("SH 60971 54366", 53.06839, -4.07644); // Snowdon
    near("TQ 30080 80390", 51.50748, -0.12706); // Trafalgar Square
  });

  it("every listed peak is a real reference", () => {
    for (const p of PEAKS) expect(parseGridRef(p.ref), p.name).not.toBeNull();
  });
});

describe("Height tiles", () => {
  it("decodes terrarium colours and places tiles", () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(133, 65, 128)).toBeCloseTo(1345.5, 6);
    expect(worldPixel(0, 0, 0)).toEqual([128, 128]);
    const [x, y] = worldPixel(85.0511287798, 180, 1);
    expect(x).toBeCloseTo(512, 6);
    expect(y).toBeCloseTo(0, 3);
    expect(tilesFor(parseGridRef("NN 16667 71283")!, 5000, 4000).length).toBeLessThanOrEqual(9);
  });

  it("reads an area's heights through the loader, smoothly between pixels", async () => {
    // Fake tiles whose height rises steadily across the world pixels: easy to check after the map projection.
    const z12 = 12;
    const sw = parseGridRef("NN 15 70")!;
    const sll = gridToLatLon(sw);
    const [ox, oy] = worldPixel(sll.lat, sll.lon, z12).map((v) => Math.floor(v) - 300);
    const f = (px: number, py: number) => 100 + (px - ox) * 0.5 + (py - oy) * 0.25;
    const loader = async (z: number, tx: number, ty: number): Promise<TilePixels> => {
      expect(z).toBe(z12);
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let j = 0; j < 256; j++)
        for (let i = 0; i < 256; i++) {
          const v = f(tx * 256 + i + 0.5, ty * 256 + j + 0.5) + 32768;
          const k = (j * 256 + i) * 4;
          data[k] = Math.floor(v / 256);
          data[k + 1] = Math.floor(v) % 256;
          data[k + 2] = Math.floor((v % 1) * 256);
          data[k + 3] = 255;
        }
      return { width: 256, height: 256, data };
    };
    const grid = await readHeights(loader, sw, 2000, 1500, 50);
    expect(grid.nx).toBe(41);
    expect(grid.ny).toBe(31);
    for (const [de, dn] of [
      [300, 200],
      [1234, 987],
    ]) {
      const ll = gridToLatLon({ e: sw.e + de, n: sw.n + dn });
      const [px, py] = worldPixel(ll.lat, ll.lon, z12);
      expect(heightAt(grid, sw.e + de, sw.n + dn)).toBeCloseTo(f(px, py), 0);
    }
  });

  it("says when an area won't do", () => {
    expect(areaProblem(null, 1000, 1000)).toMatch(/grid reference/);
    expect(areaProblem({ e: 200000, n: 700000 }, 100, 1000)).toMatch(/200 m/);
    expect(areaProblem({ e: 200000, n: 700000 }, 50000, 1000)).toMatch(/40 km/);
    expect(areaProblem({ e: 200000, n: 700000 }, 5000, 4000)).toBeNull();
  });
});

describe("Flat faces into triangles", () => {
  const area = (p: P2[]) => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2;
  const circle = (cx: number, cy: number, r: number): P2[] => Array.from({ length: 16 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 8), cy + r * Math.sin((i * Math.PI) / 8)]);
  it("joins several holes in a row without covering any of them (each edge used once each way)", () => {
    for (const [ax, ay, bx, by] of [
      [14, 10, 6, 10.4],
      [14, 6, 6, 14],
      [15, 10, 9, 10],
      [12, 12, 6, 12.3],
    ]) {
      const outer: P2[] = [[0, 0], [10, 0], [20, 0], [20, 10], [20, 20], [10, 20], [0, 20]];
      const holes = [circle(ax, ay, 2), circle(bx, by, 2)];
      const tris = triangulate(outer, holes);
      const count = new Map<string, number>();
      for (const t of tris) for (let k = 0; k < 3; k++) count.set(`${t[k]}>${t[(k + 1) % 3]}`, (count.get(`${t[k]}>${t[(k + 1) % 3]}`) ?? 0) + 1);
      const ring = (start: number, n: number, ccw: boolean) =>
        Array.from({ length: n }, (_, i) => (ccw ? [start + i, start + ((i + 1) % n)] : [start + ((i + 1) % n), start + i]));
      const boundary = [...ring(0, 7, true), ...ring(7, 16, false), ...ring(23, 16, false)];
      for (const [a, b] of boundary) {
        expect(count.get(`${a}>${b}`) ?? 0, `edge ${a}>${b}`).toBe(1);
        expect(count.get(`${b}>${a}`) ?? 0, `edge ${b}>${a}`).toBe(0);
      }
      for (const [key, n] of count) {
        const [a, b] = key.split(">");
        const onBoundary = boundary.some(([x, y]) => `${x}>${y}` === key);
        if (!onBoundary) expect(count.get(`${b}>${a}`), key).toBe(n);
      }
    }
  });

  it("covers an outline less its holes exactly, using every corner, all anticlockwise", () => {
    const outer: P2[] = [];
    for (let i = 0; i < 6; i++) outer.push([i * 5, 0]);
    for (let i = 0; i < 6; i++) outer.push([30, i * 5]);
    outer.push([30, 30], [15, 18], [0, 30]); // a notch turning inwards
    const holes = [circle(6, 6, 2), circle(24, 6, 2)];
    const pts = [outer, ...holes].flat();
    const tris = triangulate([...outer].reverse(), holes);
    const ptsRev = [[...outer].reverse(), ...holes].flat();
    let sum = 0;
    for (const [a, b, c] of tris) {
      const A = area([ptsRev[a], ptsRev[b], ptsRev[c]]);
      expect(A).toBeGreaterThanOrEqual(-1e-9);
      sum += A;
    }
    expect(sum).toBeCloseTo(Math.abs(area(outer)) - holes.reduce((s, h) => s + Math.abs(area(h)), 0), 6);
    expect(new Set(tris.flat()).size).toBe(pts.length);
  });
});

// A smooth hill with a ripple, on 4 × 3 km.
const W = 4000;
const H = 3000;
const hill = gridFrom({ e: 200000, n: 770000 }, W, H, 20, (e, n) => 300 + 1000 * Math.exp(-(((e - 201800) / 900) ** 2 + ((n - 771500) / 700) ** 2)) + 40 * Math.sin(e / 170));
const SPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256], snowline: 1000 };

/** Every edge used by exactly one triangle each way; and the enclosed volume. */
function closed(b: Body): { open: number; volume: number } {
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

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

describe("Mountain puzzle", () => {
  const puzzle = makeMountainPuzzle(hill, W, H, SPEC);

  it("fits the bed in whole cubes and stands on a jigsaw layer", () => {
    const L = layoutFor(hill, W, H, SPEC);
    expect(L.cols).toBe(8);
    expect(L.rows).toBe(6);
    expect(L.cols * SPEC.cube).toBeLessThanOrEqual(256);
    expect(L.width).toBeLessThanOrEqual(W + 1e-6);
    expect(L.height).toBeLessThanOrEqual(H + 1e-6);
    // Twice the scale: twice as many cubes across.
    expect(layoutFor(hill, W, H, { ...SPEC, scale: 2 }).cols).toBe(16);
    // Only 10 mm of plain side under the lowest ground: the bottom layer is a thin jigsaw plate.
    expect(baseFor(SPEC)).toBe(10);
    // Chunky dovetail tabs: necks a quarter of the cube or more.
    expect(puzzle.neck).toBeGreaterThan(7);
    expect(plateFor(SPEC)).toBeGreaterThanOrEqual(PLATE_MIN);
    let lowest = Infinity;
    for (const p of puzzle.pieces) {
      if (p.layer === 0) expect(p.height - (p.key ? puzzle.keys.h : 0), p.name).toBeCloseTo(plateFor(SPEC), 6);
      if (p.top) for (const b of p.bodies) for (let i = 2; i < b.vertices.length; i += 3) if (b.vertices[i] > p.z0 + puzzle.keys.depth + 0.01) lowest = Math.min(lowest, b.vertices[i]);
    }
    expect(lowest).toBeLessThanOrEqual(10 + 0.5);
    expect(lowest).toBeGreaterThanOrEqual(10 - 0.1);
    // Every column has a whole jigsaw cube at the bottom.
    for (let r = 0; r < L.rows; r++)
      for (let c = 0; c < L.cols; c++) {
        const bottom = puzzle.pieces.find((p) => p.col === c && p.row === r && p.layer === 0)!;
        expect(bottom.top).toBe(false);
      }
  });

  it("makes every part a closed, solid mesh", () => {
    expect(puzzle.pieces.length).toBeGreaterThan(48);
    for (const p of puzzle.pieces)
      for (const b of p.bodies) {
        const { open, volume } = closed(b);
        expect(open, `${p.name} ${b.part}`).toBe(0);
        expect(volume, `${p.name} ${b.part}`).toBeGreaterThan(0);
      }
  });

  it("keeps pieces of a layer the fit gap apart, with real tabs between whole cubes", () => {
    const fit = SPEC.fit;
    let tabs = 0;
    for (const a of puzzle.pieces)
      for (const b of puzzle.pieces) {
        if (a === b || a.layer !== b.layer || Math.abs(a.col - b.col) + Math.abs(a.row - b.row) !== 1 || a.name > b.name) continue;
        // A top piece stands beside whole cubes of the same layer too: compare whatever shares the layer's heights.
        const gap = outlineGap(a.outline as LP2[], b.outline as LP2[]);
        expect(gap, `${a.name} / ${b.name}`).toBeGreaterThan(2 * fit * 0.9);
        expect(gap, `${a.name} / ${b.name}`).toBeLessThan(2 * fit * 1.1 + 1e-6);
        if (!a.top && !b.top) tabs++;
      }
    expect(tabs).toBeGreaterThan(0);
    expect(puzzle.neck).toBeGreaterThanOrEqual(MIN_NECK);
    // Tab pieces have far more corners than a plain square.
    expect(Math.max(...puzzle.pieces.filter((p) => !p.top).map((p) => p.outline.length))).toBeGreaterThan(30);
  });

  it("puts a key under every piece above the bottom, right under its pocket, clear of every tab", () => {
    const g = puzzle.keys;
    for (const p of puzzle.pieces) {
      if (p.layer === 0) expect(p.pocket).toBeNull();
      else expect(p.pocket, p.name).not.toBeNull();
      const above = puzzle.pieces.find((q) => q.col === p.col && q.row === p.row && q.layer === p.layer + 1);
      // The same key: the pocket of the piece above is exactly where (and as big as) the key below is.
      expect(p.key).toBe(above ? above.pocket : null);
      if (p.key) {
        expect(p.key.half).toBeGreaterThanOrEqual(g.least);
        expect(p.key.half).toBeLessThanOrEqual(g.most);
        // Its foot inside this piece, its pocket's mouth inside the one above, both clear of their edges.
        expect(outlineGap(keyLoop(p.key.c, p.key.half, 2) as LP2[], p.outline as LP2[])).toBe(0);
        expect(insideGap(keyLoop(p.key.c, p.key.half, 2) as LP2[], p.outline as LP2[])).toBeGreaterThan(WALL * 0.9);
        expect(insideGap(keyLoop(p.key.c, p.key.half + g.fit, 2) as LP2[], above!.outline as LP2[])).toBeGreaterThan(WALL * 0.9);
      }
    }
    // Low and wide, with sloping sides: nothing thin to snap, and it steers itself in.
    expect(g.h).toBeLessThanOrEqual(3.5);
    expect(Math.min(...puzzle.pieces.filter((p) => p.key).map((p) => p.key!.half * 2))).toBeGreaterThan(2 * g.h);
    expect(g.slope / g.h).toBeGreaterThan(0.5);
    expect(puzzle.warnings).toEqual([]);
  });

  it("gives every piece with tabs a shape no other piece has, however it's turned", () => {
    const blocks = puzzle.pieces.filter((p) => !p.top && p.outline.length > 4);
    expect(blocks.length).toBeGreaterThan(20);
    const shapes = new Map<string, string>();
    const h = SPEC.cube / 2 + 0.25 * SPEC.cube;
    for (const p of blocks) {
      const [cx, cy] = [(p.col + 0.5) * SPEC.cube, (p.row + 0.5) * SPEC.cube];
      const masks = [0, 1, 2, 3].map((k) => {
        let bits = "";
        for (let y = -h; y <= h; y += 1)
          for (let x = -h; x <= h; x += 1) {
            // The point turned back by k quarter turns, so the mask is the piece turned by k.
            const [u, v] = k === 0 ? [x, y] : k === 1 ? [y, -x] : k === 2 ? [-x, -y] : [-y, x];
            bits += inside([cx + u, cy + v], p.outline) ? "1" : "0";
          }
        return `${(p.height - (p.key ? puzzle.keys.h : 0)).toFixed(2)}:${bits}`;
      });
      const own = new Set(masks);
      for (const m of own) {
        const other = shapes.get(m);
        expect(other, `${p.name} has the same shape as ${other}`).toBeUndefined();
      }
      for (const m of own) shapes.set(m, p.name);
    }
    expect(puzzle.warnings.some((w) => w.includes("same tabs"))).toBe(false);
  });

  it("makes every piece fit only its own place: a neighbour's key won't go into its pocket, nor its own turned round", () => {
    const g = puzzle.keys;
    const foot = (k: Key) => keyLoop(k.c, k.half, 2, k.cut) as LP2[];
    const mouth = (k: Key) => keyLoop(k.c, k.half + g.fit, 2 + g.fit, k.cut) as LP2[];
    // Seen from the piece's own place: its pocket is at the same spot as the key under it, so compare shapes there.
    const at = (k: Key, c: LP2): Key => ({ ...k, c: [c[0] + (k.c[0] - Math.floor(k.c[0] / SPEC.cube) * SPEC.cube), c[1] + (k.c[1] - Math.floor(k.c[1] / SPEC.cube) * SPEC.cube)] });
    let checked = 0;
    for (const p of puzzle.pieces) {
      if (!p.pocket) continue;
      // Its own key goes in, with the fit gap all round.
      expect(insideGap(foot(p.pocket), mouth(p.pocket))).toBeGreaterThan(g.fit * 0.6);
      // Turned a quarter turn, it doesn't (the cut corner is somewhere else).
      const turned = { ...p.pocket, cut: (p.pocket.cut + 1) % 4 };
      expect(insideGap(foot(turned), mouth(p.pocket))).toBe(0);
      // The keys of the pieces round about (moved to this place) don't go into this pocket.
      for (const q of puzzle.pieces) {
        if (!q.pocket || q === p || Math.abs(q.col - p.col) > 1 || Math.abs(q.row - p.row) > 1 || Math.abs(q.layer - p.layer) > 1) continue;
        const here: LP2 = [p.col * SPEC.cube, p.row * SPEC.cube];
        const theirs = at(q.pocket, here);
        expect(insideGap(foot(theirs), mouth(p.pocket)), `${q.name} on ${p.name}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("puts the snow only above the snow line, and only some pieces have it", () => {
    let snowy = 0;
    for (const p of puzzle.pieces)
      for (const b of p.bodies) {
        if (b.part !== "snow") continue;
        snowy++;
        for (let i = 2; i < b.vertices.length; i += 3) expect(b.vertices[i]).toBeGreaterThanOrEqual(puzzle.snowZ - 1e-6);
      }
    expect(snowy).toBeGreaterThan(0);
    expect(snowy).toBeLessThan(puzzle.pieces.length / 4);
    const none = makeMountainPuzzle(hill, W, H, { ...SPEC, snowline: null });
    expect(none.pieces.every((p) => p.bodies.every((b) => b.part === "rock"))).toBe(true);
  });

  it("refuses cubes too small for the tabs, and warns when they're fragile", () => {
    expect(neckFor(SPEC.cube, SPEC.fit)).toBeGreaterThan(GOOD_NECK);
    const smallest = smallestCube(SPEC.fit);
    expect(neckFor(smallest, SPEC.fit)).toBeGreaterThanOrEqual(MIN_NECK);
    expect(neckFor(smallest - 1, SPEC.fit)).toBeLessThan(MIN_NECK);
    expect(mountainChecks({ ...SPEC, cube: smallest - 1 }).problems[0]).toMatch(/too small/);
    expect(mountainChecks({ ...SPEC, cube: smallest }).problems).toEqual([]);
    expect(mountainChecks({ ...SPEC, cube: smallest }).warnings[0]).toMatch(/necks/);
    expect(mountainChecks(SPEC)).toEqual({ problems: [], warnings: [] });
    expect(() => makeMountainPuzzle(hill, W, H, { ...SPEC, cube: 10 })).toThrow(/too small/);
  });

  it("lays the pieces out on plates and writes them for Bambu Studio", () => {
    const bed: [number, number, number] = [256, 256, 256];
    const plates = platesFor(puzzle.pieces, bed);
    expect(plates.flatMap((p) => p.pieces).length).toBe(puzzle.pieces.length);
    for (const plate of plates) {
      const boxes = plate.pieces.map(({ piece, move }) => {
        const xs = piece.outline.map((q) => q[0] + move[0]);
        const ys = piece.outline.map((q) => q[1] + move[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      });
      for (const b of boxes) {
        expect(b[0]).toBeGreaterThanOrEqual(0);
        expect(b[1]).toBeGreaterThanOrEqual(0);
        expect(b[2]).toBeLessThanOrEqual(bed[0]);
        expect(b[3]).toBeLessThanOrEqual(bed[1]);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i], boxes[j]];
          expect(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]).toBe(true);
        }
      for (const { piece, move } of plate.pieces) expect(piece.z0 + move[2]).toBe(0);
    }
    const snowPlate = plates.find((p) => p.pieces.some((x) => x.piece.bodies.some((b) => b.part === "snow")))!;
    const files = plateFiles(snowPlate, "Test");
    expect(files.config).toContain(`<metadata key="extruder" value="${FILAMENT.snow}"/>`);
    expect(files.model).toContain("<components>");
    const zip = plate3mf(snowPlate, "Test");
    const text = new TextDecoder().decode(zip);
    expect(text).toContain("3D/3dmodel.model");
    expect(text).toContain("Metadata/model_settings.config");
  });
});

describe("Mountain puzzle: every piece held", () => {
  /** Distance from p to a closed outline, and whether it's inside. */
  const toOutline = (p: [number, number], poly: [number, number][]) => {
    let d = Infinity;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [a, b] = [poly[j], poly[i]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return { d, inside };
  };
  const ridge = gridFrom({ e: 200000, n: 770000 }, W, H, 20, (e, n) => 200 + 700 * Math.exp(-(((n - 771500) / 500) ** 2)) * (0.6 + 0.4 * Math.sin(e / 400)));
  for (const [name, grid, seed] of [["hill", hill, 1], ["hill", hill, 4], ["ridge", ridge, 2]] as const)
    it(`dovetails every piece to those beside it at its level, top pieces too (${name}, pattern ${seed})`, () => {
      const p = makeMountainPuzzle(grid, W, H, { ...SPEC, seed });
      const cube = SPEC.cube;
      const at = new Map(p.pieces.map((q) => [`${q.col},${q.row},${q.layer}`, q]));
      let topTabs = 0;
      for (const q of p.pieces) {
        // The rule: two dovetails, or one where a piece has only one beside it.
        if (q.neighbours) expect(q.joints!, q.name).toBeGreaterThanOrEqual(Math.min(2, q.neighbours));
        expect(q.joints).toBe(q.neighbours);
        // And each really is there: on every side shared with such a piece, one of the two reaches into the other's square.
        let seen = 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const o = at.get(`${q.col + dc},${q.row + dr},${q.layer}`);
          if (!o || o.top !== q.top || o.z0 !== q.z0) continue;
          const into = (a: typeof q, b: typeof q) => a.outline.some(([x, y]) => x > b.col * cube + 1 && x < (b.col + 1) * cube - 1 && y > b.row * cube + 1 && y < (b.row + 1) * cube - 1);
          if (into(q, o) || into(o, q)) seen++;
          if (q.top) {
            // The printed footprints keep the fit gap: no point of one inside the other, none nearer than ~2 × fit.
            for (let i = 0; i < q.bodies[0].vertices.length; i += 3) {
              if (q.bodies[0].vertices[i + 2] !== q.z0) continue;
              const r = toOutline([q.bodies[0].vertices[i], q.bodies[0].vertices[i + 1]], o.outline);
              expect(r.inside, q.name).toBe(false);
              expect(r.d, `${q.name} beside ${o.name}`).toBeGreaterThan(SPEC.fit * 2 * 0.75);
            }
          }
        }
        expect(seen, q.name).toBe(q.neighbours);
        if (q.top) topTabs += q.joints!;
        for (const b of q.bodies) expect(closed(b).open, `${q.name} ${b.part}`).toBe(0);
      }
      // Top pieces are dovetailed now (they used to be plain squares held only by their key).
      expect(topTabs).toBeGreaterThan(0);
    });
});
