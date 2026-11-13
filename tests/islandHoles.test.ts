/**
 * Island puzzle holes (pure): low ground the land closes round — low land below the sea line, a small gap in the height
 * data, a loch the map has — is filled in as land, so no piece has a hole through it, while a big patch at sea level (a sea
 * loch with a narrow mouth) stays sea; crumbs of pieces go to their neighbours without ever touching a dovetail; and an
 * island with no holes or crumbs is made exactly as before, mesh for mesh.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { fillEnclosed, ISLAND_DEFAULTS, makeIslandPuzzle, SMALL_HOLE, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { collides, outlineSegs, SegGrid, type Seg } from "./support/outlineGeom";

const W = 6000;
const H = 4000;
const sw = { e: 300000, n: 700000 };
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] };

const plainHeight = (e: number, n: number) => {
  const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r));
};
// The same island with: low land (0.2 m, under the 0.5 m sea line but not coded as sea) in the west; a small square of no
// data (0) in the east; a big lagoon at sea level (−5 m) in the south — a sea loch, kept; and the same in the north
// where the map has a loch — filled.
const HOLLOW = { e: sw.e + 0.36 * W, n: sw.n + 0.5 * H, r: 350 };
const GAP = { e: sw.e + 0.64 * W, n: sw.n + 0.52 * H, half: 100 };
const LAGOON = { e: sw.e + 0.5 * W, n: sw.n + 0.3 * H, r: 300 };
const LOCH = { e: sw.e + 0.5 * W, n: sw.n + 0.72 * H, r: 300 };
const near = (e: number, n: number, c: { e: number; n: number; r: number }, m = 0) => Math.hypot(e - c.e, n - c.n) < c.r + m;
const holed = gridFrom(sw, W, H, 25, (e, n) => {
  if (near(e, n, HOLLOW)) return 0.2;
  if (Math.abs(e - GAP.e) < GAP.half && Math.abs(n - GAP.n) < GAP.half) return 0;
  if (near(e, n, LAGOON) || near(e, n, LOCH)) return -5;
  return plainHeight(e, n);
});
const plain = gridFrom(sw, W, H, 25, plainHeight);
const lochOnMap = {
  lines: [],
  shapes: [{ kind: "water" as const, rings: [Array.from({ length: 24 }, (_, i): [number, number] => [LOCH.e + 330 * Math.cos((i * Math.PI) / 12), LOCH.n + 330 * Math.sin((i * Math.PI) / 12)])] }],
  names: [],
};

/** Each dovetail's piece pulled straight back out of its socket (islandPuzzle.test's check): how many slide out. */
function pullOut(p: IslandPuzzle): number {
  const O = p.pieces.map((q) => outlineSegs(q.bodies[0]));
  const G = O.map((s) => new SegGrid(s, 1));
  let free = 0;
  for (const t of p.tabs) {
    let d = 0;
    let hit = false;
    while (d < t.reach + 1 && !hit) {
      d += 0.05;
      hit = collides(O[t.from], G[t.into], -t.dir[0] * d, -t.dir[1] * d);
    }
    if (!hit) free++;
  }
  return free;
}

/** Every piece's mesh, tabs and notes, hashed. */
function meshHash(p: IslandPuzzle): string {
  const h = createHash("sha256");
  for (const q of p.pieces)
    for (const b of q.bodies) {
      h.update(new Uint8Array(new Float64Array(Array.from(b.vertices)).buffer));
      h.update(new Uint8Array(new Int32Array(Array.from(b.triangles)).buffer));
    }
  h.update(JSON.stringify(p.tabs));
  h.update(JSON.stringify(p.warnings));
  return h.digest("hex").slice(0, 16);
}

/** How many separate loops a piece's underside outline has (1 = no hole through it). */
function loops(segs: Seg[]): number {
  const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
  const up = new Map<string, string>();
  const find = (a: string): string => {
    while (up.get(a) !== a) a = up.get(a)!;
    return a;
  };
  for (const [ax, ay, bx, by] of segs) {
    const [a, b] = [key(ax, ay), key(bx, by)];
    if (!up.has(a)) up.set(a, a);
    if (!up.has(b)) up.set(b, b);
    up.set(find(a), find(b));
  }
  return new Set([...up.keys()].map(find)).size;
}

/** Is (x, y) inside a piece's underside (even–odd over its outline)? */
function inside(segs: Seg[], x: number, y: number): boolean {
  let n = 0;
  for (const [ax, ay, bx, by] of segs) if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) n++;
  return n % 2 === 1;
}

/** Points of the island's land (on a grid `step` mm apart, at least `margin` mm in from the coast) no piece covers. */
function uncovered(p: IslandPuzzle, isLand: (x: number, y: number) => boolean, step: number, margin: number, near: number) {
  const outlines = p.pieces.map((q) => outlineSegs(q.bodies[0]));
  const box = outlines.map((s) => {
    const xs = s.flatMap((g) => [g[0], g[2]]);
    const ys = s.flatMap((g) => [g[1], g[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const missed: [number, number][] = [];
  for (let y = step / 2; y < p.height; y += step)
    for (let x = step / 2; x < p.width; x += step) {
      if (![[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].every(([dx, dy]) => isLand(x + dx, y + dy))) continue;
      let ok = false;
      for (let i = 0; i < outlines.length && !ok; i++) {
        const [x0, y0, x1, y1] = box[i];
        if (x < x0 - near || x > x1 + near || y < y0 - near || y > y1 + near) continue;
        if (inside(outlines[i], x, y)) ok = true;
        // In the fit gap between two pieces.
        else ok = outlines[i].some(([ax, ay, bx, by]) => {
          const [dx, dy] = [bx - ax, by - ay];
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
          return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= near;
        });
      }
      if (!ok) missed.push([x, y]);
    }
  return missed;
}

/** Mesh hashes of the plain island (35 mm pieces; 15 mm, pattern 1) as JuraCAD made them before holes were filled. */
const OLD_PLAIN_35 = "eecb517303d8a51a";
const OLD_PLAIN_15 = "fc51e34758486848";

describe("holes in the land", () => {
  it("fills patches the land closes round (each no lower than its lowest shore) and leaves open sea (diagonal channels too) alone", () => {
    // 7 × 7: a ring of land round a 1-cell hole, and a sea channel reaching the edge only diagonally.
    const nx = 7;
    const L = [
      "0000000",
      "0111110",
      "0101110",
      "0111110",
      "0111010",
      "0111101",
      "0000000",
    ].reverse();
    const isLand = new Uint8Array(nx * nx);
    for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) isLand[j * nx + i] = L[j][i] === "1" ? 1 : 0;
    const f = fillEnclosed(isLand, nx, nx, (c) => 10 + c);
    expect(f.count).toBe(1);
    const hole = 4 * nx + 2;
    expect(isLand[hole]).toBe(1);
    // Its shore: the four cells beside it; the lowest is the one below.
    expect(f.level[0]).toBe(10 + 3 * nx + 2);
    // The cell at (4, 2) reaches the sea at (5, 1) diagonally: still sea.
    expect(isLand[2 * nx + 4]).toBe(0);
  });

  it("fills only what can't be the sea: low land, small patches, lochs on the map", () => {
    const nx = 20;
    const isLand = new Uint8Array(nx * nx).fill(1);
    // Two 3 × 3 holes, one coded as sea (0) and one as low land (0.2): only the low land is filled when small isn't enough.
    for (let j = 3; j < 6; j++) for (let i = 3; i < 6; i++) isLand[j * nx + i] = 0;
    for (let j = 10; j < 13; j++) for (let i = 10; i < 13; i++) isLand[j * nx + i] = 0;
    const f = fillEnclosed(isLand, nx, nx, (c) => (c % nx >= 10 ? 0.2 : 0), (_, lowest) => lowest > 0);
    expect([f.count, f.kept]).toEqual([1, 1]);
    expect(isLand[4 * nx + 4]).toBe(0);
    expect(isLand[11 * nx + 11]).toBe(1);
  });

  const p = makeIslandPuzzle(holed, sw, W, H, SPEC);
  const k = p.k;
  const centre = (c: { e: number; n: number }): [number, number] => [(c.e - sw.e) * k, (c.n - sw.n) * k];
  const covered = (q: IslandPuzzle, [x, y]: [number, number]) => q.pieces.some((r) => inside(outlineSegs(r.bodies[0]), x, y));
  // The plain island's land, less the patches left as sea.
  const landAt = (seaKept: { e: number; n: number; r: number }[]) => (x: number, y: number) => {
    const [e, n] = [sw.e + x / k, sw.n + y / k];
    return e > sw.e && n > sw.n && e < sw.e + W && n < sw.n + H && plainHeight(e, n) > SPEC.sea && !seaKept.some((c) => near(e, n, c, 120));
  };
  it("fills low land and a small gap in the data, keeps a big patch at sea level as sea, with no hole through any piece", () => {
    expect((GAP.half * 2 * k) ** 2).toBeLessThan(SMALL_HOLE);
    expect(Math.PI * (LAGOON.r * k) ** 2).toBeGreaterThan(SMALL_HOLE);
    const notes = p.warnings.join(" ");
    expect(notes).toMatch(/2 low patches inside the land .* were filled in/);
    expect(notes).toMatch(/2 big patches at sea level .* kept as sea/);
    for (const q of p.pieces) expect(loops(outlineSegs(q.bodies[0])), q.name).toBe(1);
    expect(covered(p, centre(HOLLOW))).toBe(true);
    expect(covered(p, centre(GAP))).toBe(true);
    expect(covered(p, centre(LAGOON))).toBe(false);
    expect(uncovered(p, landAt([LAGOON, LOCH]), 1.5, 1.2, SPEC.fit + 0.8)).toEqual([]);
  });
  it("fills a loch the map has, even a big one at sea level", () => {
    const m = makeIslandPuzzle(holed, sw, W, H, SPEC, undefined, lochOnMap);
    expect(m.warnings.join(" ")).toMatch(/3 low patches inside the land .* were filled in/);
    expect(m.warnings.join(" ")).toMatch(/A big patch at sea level .* was kept as sea/);
    expect(covered(m, centre(LOCH))).toBe(true);
    expect(covered(m, centre(LAGOON))).toBe(false);
    // It's on the map's marks as water, and pressed in a little below its shore.
    expect(m.marks.shapes.some((s) => s.kind === "water")).toBe(true);
    for (const q of m.pieces) expect(loops(outlineSegs(q.bodies[0])), q.name).toBe(1);
  });
  it("fills them smoothly from the ground round them, never down at the base", () => {
    const q = makeIslandPuzzle(plain, sw, W, H, SPEC);
    for (const c of [HOLLOW, GAP]) {
      const [x, y] = centre(c);
      expect(p.groundAt(x, y)).toBeGreaterThan(SPEC.base + 1);
      expect(Math.abs(p.groundAt(x, y) - q.groundAt(x, y))).toBeLessThan(1.5);
    }
  });
  it("gives crumbs left by wiggly boundary lines to a piece, so the only gaps are the fit gaps between pieces", () => {
    // Boundaries crossing the patches and the island, wiggling.
    const lines: [number, number][][] = [
      Array.from({ length: 30 }, (_, i): [number, number] => [HOLLOW.e + 80 * Math.sin(i), sw.n - 100 + (i * (H + 200)) / 29]),
      Array.from({ length: 30 }, (_, i): [number, number] => [sw.e - 100 + (i * (W + 200)) / 29, GAP.n + 60 * Math.cos(i * 1.3)]),
      Array.from({ length: 30 }, (_, i): [number, number] => [GAP.e + 50 * Math.cos(i * 0.7), sw.n - 100 + (i * (H + 200)) / 29]),
    ];
    const c = makeIslandPuzzle(holed, sw, W, H, SPEC, { lines, names: [] });
    expect(c.alongBoundaries).toBe(true);
    // One outline each — and another round each patch kept as sea (no map here, so the loch is too) a piece holds.
    for (const q of c.pieces) {
      const segs = outlineSegs(q.bodies[0]);
      const xs = segs.flatMap((g) => [g[0], g[2]]);
      const ys = segs.flatMap((g) => [g[1], g[3]]);
      const round = [LAGOON, LOCH].filter((p) => {
        const [lx, ly] = centre(p);
        return lx > Math.min(...xs) && lx < Math.max(...xs) && ly > Math.min(...ys) && ly < Math.max(...ys) && !inside(segs, lx, ly);
      }).length;
      expect(loops(segs), q.name).toBe(1 + round);
    }
    expect(uncovered(c, landAt([LAGOON, LOCH]), 1.5, 1.2, SPEC.fit + 0.8)).toEqual([]);
    expect(pullOut(c)).toBe(0);
  });
  it("never takes a dovetail away (15 mm pieces, pattern 1: every tab still catches)", () => {
    const q = makeIslandPuzzle(plain, sw, W, H, { ...SPEC, piece: 15, seed: 1 });
    expect(q.tabs.length).toBeGreaterThan(100);
    expect(pullOut(q)).toBe(0);
    expect(q.pieces.reduce((s, r) => s + r.joints, 0)).toBe(2 * q.joins);
  });
  it("makes islands with no holes or crumbs exactly as before, mesh for mesh", () => {
    // What the puzzle was before this change, for these islands (worked out with the old code).
    for (const [spec, before] of [
      [SPEC, OLD_PLAIN_35],
      [{ ...SPEC, piece: 15, seed: 1 }, OLD_PLAIN_15],
    ] as const) {
      const q = makeIslandPuzzle(plain, sw, W, H, spec);
      expect(q.warnings.join(" ")).not.toMatch(/filled in|kept as sea/);
      expect(meshHash(q)).toBe(before);
    }
  });
});
