/**
 * The coastline from OpenStreetMap (pure): coastline ways (land on their left) joined and closed round the box's edge
 * into land, islands inside, a sea loch with a narrow mouth kept as sea where the heights would close it and fill it in,
 * and no coastline (inland) = exactly the old island.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { coastAgrees, coastMask, coastQuery, coastRings, joinCoast, LEFT_OUT } from "../src/terrain/coastline";
import { COAST_UNUSED, ISLAND_DEFAULTS, landBox, makeIslandPuzzle, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { trimmedIsland } from "../src/terrain/islandArea";
import { readOsm } from "../src/terrain/osm";
import { outlineSegs, type Seg } from "./support/outlineGeom";

type XY = [number, number];

const ring = (cx: number, cy: number, rx: number, ry: number, n = 48, ccw = true): XY[] => {
  const pts: XY[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? i : -i) * 2 * Math.PI) / n;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  pts.push(pts[0]);
  return pts;
};
const at = (mask: Uint8Array, nx: number, i: number, j: number) => mask[j * nx + i];

describe("coastline → land", () => {
  it("an island drawn anticlockwise is land; clockwise it'd be sea in land", () => {
    const m = coastMask([ring(50, 50, 30, 30)], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(m, 100, 50, 50)).toBe(1);
    expect(at(m, 100, 5, 5)).toBe(0);
    expect(at(m, 100, 95, 50)).toBe(0);
    // A clockwise ring (sea inside land) on its own: land nowhere.
    const cw = coastMask([ring(50, 50, 30, 30, 48, false)], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(cw, 100, 50, 50)).toBe(0);
  });

  it("ways in pieces are joined end to end, in any order", () => {
    const r = ring(50, 50, 30, 30);
    const ways = [r.slice(30), r.slice(0, 11), r.slice(10, 31)];
    const joined = joinCoast(ways);
    expect(joined.length).toBe(1);
    expect(joined[0][0]).toEqual(joined[0][joined[0].length - 1]);
    const m = coastMask(ways, { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(m, 100, 50, 50)).toBe(1);
  });

  it("a mainland coast running across the box: land on its left, closed round the box's edge", () => {
    // Going north along x = 60: land to the west (left).
    const coast: XY[] = [
      [60, -20],
      [60, 120],
    ];
    const m = coastMask([coast], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(m, 100, 10, 50)).toBe(1);
    expect(at(m, 100, 90, 50)).toBe(0);
    // The other way round: land to the east.
    const m2 = coastMask([[...coast].reverse()], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(m2, 100, 10, 50)).toBe(0);
    expect(at(m2, 100, 90, 50)).toBe(1);
    // Corners of the box are carried round: land in all three western corners' cells.
    expect(at(m, 100, 0, 0)).toBe(1);
    expect(at(m, 100, 0, 99)).toBe(1);
  });

  it("a cape crossing one side twice, a bay crossing it twice, and an island beside them", () => {
    // In from the south and back out: going up x = 30 the land is to the west, so as drawn this is a bay; reversed, a peninsula.
    const cape: XY[] = [
      [30, -10],
      [30, 40],
      [45, 40],
      [45, -10],
    ];
    const peninsula = [...cape].reverse();
    const island = ring(80, 70, 8, 8);
    const m = coastMask([peninsula, island], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(m, 100, 37, 20)).toBe(1);
    expect(at(m, 100, 10, 20)).toBe(0);
    expect(at(m, 100, 80, 70)).toBe(1);
    expect(at(m, 100, 60, 70)).toBe(0);
    const bay = coastMask([cape], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(bay, 100, 37, 20)).toBe(0);
    expect(at(bay, 100, 10, 20)).toBe(1);
    expect(at(bay, 100, 60, 90)).toBe(1);
  });

  it("a big island ring running off the box is cut to it", () => {
    const m = coastMask([ring(0, 50, 40, 40)], { e: 0, n: 0 }, 1, 100, 100)!;
    expect(at(m, 100, 5, 50)).toBe(1);
    expect(at(m, 100, 60, 50)).toBe(0);
    expect(at(m, 100, 5, 1)).toBe(0);
  });

  it("can't say: no coastline in the box, or one with a gap in it", () => {
    expect(coastMask([ring(500, 500, 10, 10)], { e: 0, n: 0 }, 1, 100, 100)).toBeNull();
    expect(coastMask([], { e: 0, n: 0 }, 1, 100, 100)).toBeNull();
    // A coast that stops in the middle of the box.
    expect(coastRings([[[60, -20], [60, 50]]], { x0: 0, y0: 0, x1: 100, y1: 100 })).toBeNull();
  });

  it("is checked against the heights: a coastline the wrong way round is refused", () => {
    const right = coastMask([ring(50, 50, 30, 30)], { e: 0, n: 0 }, 1, 100, 100)!;
    const wrong = coastMask([[[60, -20], [60, 120]]], { e: 0, n: 0 }, 1, 100, 100)!;
    const hill = (c: number) => (Math.hypot((c % 100) - 50, Math.floor(c / 100) - 50) < 28 ? 100 : -10);
    expect(coastAgrees(right, hill)).toBe(true);
    expect(coastAgrees(wrong, hill)).toBe(false);
  });

  it("reads coastline ways from a map file, in their own direction", () => {
    const osm = `<osm><node id="1" lat="56" lon="-6"/><node id="2" lat="56.1" lon="-6"/><node id="3" lat="56.1" lon="-5.9"/>
      <way id="9"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="natural" v="coastline"/></way></osm>`;
    const d = readOsm(osm);
    expect(d.coastline?.length).toBe(1);
    expect(d.coastline![0][0]).toEqual({ lat: 56, lon: -6 });
    expect(d.lines.length).toBe(0);
    expect(coastQuery({ e: 0, n: 0 }, 200_000, 10_000)).toBeNull();
    expect(coastQuery({ e: 350000, n: 670000 }, 40_000, 48_000)).toMatch(/natural"="coastline/);
  });
});

// A Jura-like island: long, with a sea loch cutting deep in from the west through a narrow mouth. The heights blend the
// land over the mouth (it reads as land a few metres high) and over much of the loch (low land, just above the sea line),
// so by the heights the loch is closed off and filled in.
const W = 8000;
const H = 6000;
const sw = { e: 350000, n: 680000 };
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] };
const CX = sw.e + W / 2;
const CY = sw.n + H / 2;
const RX = 3000;
const RY = 2200;
// The loch: a basin 1400 × 1000 m whose middle is 1300 m west of the island's middle, reached through a mouth 120 m wide.
const LOCH = { e: CX - 1300, n: CY, rx: 700, ry: 500 };
const MOUTH_HALF = 60;
const inLoch = (e: number, n: number) => ((e - LOCH.e) / LOCH.rx) ** 2 + ((n - LOCH.n) / LOCH.ry) ** 2 < 1;
const inMouth = (e: number, n: number) => Math.abs(n - CY) < MOUTH_HALF && e < LOCH.e && e > CX - RX - 200;
const onIsland = (e: number, n: number) => ((e - CX) / RX) ** 2 + ((n - CY) / RY) ** 2 < 1;
const juraHeight = (e: number, n: number) => {
  if (!onIsland(e, n)) return -20;
  if (inLoch(e, n)) return 0.8; // read as low land
  if (inMouth(e, n)) return 3; // read as land
  const r = Math.hypot((e - CX) / RX, (n - CY) / RY);
  return 5 + (1 - r) * 400;
};
const grid = gridFrom(sw, W, H, 25, juraHeight);

/** The island's coastline, anticlockwise (land on the left), with the loch and its mouth cut in from the west. */
function juraCoast(): XY[][] {
  const pts: XY[] = [];
  const n = 360;
  // Round the outside anticlockwise from the mouth's south side to its north side.
  const mouthA = Math.asin(MOUTH_HALF / RY);
  for (let i = 0; i <= n; i++) {
    const a = Math.PI + mouthA + ((2 * Math.PI - 2 * mouthA) * i) / n;
    pts.push([CX + RX * Math.cos(a), CY + RY * Math.sin(a)]);
  }
  // Now at the north side of the mouth (angle 3π − mouthA ≡ π − mouthA). Into the loch along the mouth's north bank…
  const north = pts[pts.length - 1];
  const loch: XY[] = [];
  const mouthEnd = LOCH.e - LOCH.rx * Math.sqrt(1 - (MOUTH_HALF / LOCH.ry) ** 2);
  loch.push([north[0], CY + MOUTH_HALF], [mouthEnd, CY + MOUTH_HALF]);
  // …round the loch's shore clockwise (the land is on the left going round a hole that way)…
  const b0 = Math.PI - Math.asin(MOUTH_HALF / LOCH.ry);
  const b1 = -Math.PI + Math.asin(MOUTH_HALF / LOCH.ry);
  for (let i = 1; i < 96; i++) {
    const b = b0 + ((b1 - b0) * i) / 96; // north-west round by the east to the south-west
    loch.push([LOCH.e + LOCH.rx * Math.cos(b), LOCH.n + LOCH.ry * Math.sin(b)]);
  }
  // …and back out along the mouth's south bank to where the outside began.
  loch.push([mouthEnd, CY - MOUTH_HALF], [pts[0][0], CY - MOUTH_HALF], pts[0]);
  return [[...pts, ...loch.slice(0, -1), pts[0]]];
}

/** Is (x, y) on the puzzle inside some piece's outline (even–odd over its underside's edge segments)? */
function onAPiece(p: IslandPuzzle, x: number, y: number): boolean {
  for (const q of p.pieces) {
    const segs: Seg[] = outlineSegs(q.bodies[0]);
    let inside = false;
    for (const [ax, ay, bx, by] of segs) if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
    if (inside) return true;
  }
  return false;
}

const meshHash = (p: IslandPuzzle, notes = true) => {
  const h = createHash("sha256");
  for (const q of p.pieces)
    for (const b of q.bodies) {
      h.update(new Uint8Array(new Float64Array(Array.from(b.vertices)).buffer));
      h.update(new Uint8Array(new Int32Array(Array.from(b.triangles)).buffer));
    }
  h.update(JSON.stringify(p.tabs));
  if (notes) h.update(JSON.stringify(p.warnings));
  return h.digest("hex");
};

describe("a sea loch with a narrow mouth", () => {
  const coast = juraCoast();
  const toPuzzle = (p: IslandPuzzle, e: number, n: number): [number, number] => [(e - p.origin.e) * p.k, (n - p.origin.n) * p.k];

  it("the coastline itself keeps the loch and its mouth as sea", () => {
    const cell = 10;
    const [nx, ny] = [W / cell, H / cell];
    const m = coastMask(coast, sw, cell, nx, ny)!;
    const cellAt = (e: number, n: number) => m[Math.floor((n - sw.n) / cell) * nx + Math.floor((e - sw.e) / cell)];
    expect(cellAt(LOCH.e, LOCH.n)).toBe(0);
    expect(cellAt(LOCH.e - LOCH.rx - 100, CY)).toBe(0);
    expect(cellAt(CX + 1000, CY)).toBe(1);
    expect(cellAt(CX, CY + 1500)).toBe(1);
    expect(cellAt(sw.e + 100, sw.n + 100)).toBe(0);
  });

  it("by the heights the loch is filled in as land; by the coastline it's sea", () => {
    const old = makeIslandPuzzle(grid, sw, W, H, SPEC);
    const byCoast = makeIslandPuzzle(grid, sw, W, H, SPEC, undefined, undefined, coast);
    expect(old.coastline).toBeUndefined();
    expect(byCoast.coastline).toBe(true);
    const loch = toPuzzle(old, LOCH.e, LOCH.n);
    const land = toPuzzle(old, CX + 1500, CY);
    expect(onAPiece(old, ...loch)).toBe(true);
    expect(onAPiece(byCoast, ...loch)).toBe(false);
    expect(onAPiece(byCoast, ...toPuzzle(byCoast, LOCH.e + LOCH.rx * 0.6, LOCH.n))).toBe(false);
    expect(onAPiece(byCoast, ...land)).toBe(true);
    // Still one island, all its pieces joined.
    expect(byCoast.warnings.join(" ")).not.toMatch(/filled in/);
  });

  it("put together, the land is boxed by the coastline too", () => {
    const b = landBox(grid, sw, W, H, SPEC.sea, SPEC.land, undefined, coast);
    expect(b.w).toBeGreaterThan(5800);
    const p = makeIslandPuzzle(grid, sw, W, H, { ...SPEC, inPlace: true }, undefined, undefined, coast);
    expect(p.coastline).toBe(true);
    expect(onAPiece(p, ...toPuzzle(p, LOCH.e, LOCH.n))).toBe(false);
  });

  it("no coastline in the area (inland), or none given: exactly the old island", () => {
    const old = makeIslandPuzzle(grid, sw, W, H, SPEC);
    const away = makeIslandPuzzle(grid, sw, W, H, SPEC, undefined, undefined, [ring(0, 0, 100, 100)]);
    // The same island, with a note saying the coastline wasn't used.
    expect(meshHash(away, false)).toBe(meshHash(old, false));
    expect(away.coastline).toBeUndefined();
    expect(away.warnings).toEqual([COAST_UNUSED, ...old.warnings]);
    // None given: byte for byte.
    expect(meshHash(makeIslandPuzzle(grid, sw, W, H, SPEC, undefined, undefined, undefined))).toBe(meshHash(old));
  });

  it("trimmed: land left out stays out though the coastline calls it land", () => {
    // A second island in the east, left out by a list island's keep point on the first.
    const two = gridFrom(sw, W, H, 25, (e, n) => (Math.hypot(e - (sw.e + 7600), n - CY) < 250 ? 50 : juraHeight(e, n)));
    const coast2 = [...coast, ring(sw.e + 7600, CY, 250, 250)];
    const t = trimmedIsland({ sw, width: W, height: H }, two, { n: 0.05, e: 0, s: 0.05, w: 0 }, { sea: 0.5, land: "islands", only: { keep: [{ e: CX, n: CY }] }, coast: coast2 });
    expect(t.decided).toBe(true);
    const i = Math.round((sw.e + 7600 - t.grid.e0) / t.grid.spacing);
    const j = Math.round((CY - t.grid.n0) / t.grid.spacing);
    expect(t.grid.h[j * t.grid.nx + i]).toBe(LEFT_OUT);
    const p = makeIslandPuzzle(t.grid, t.sw, t.width, t.height, { ...SPEC, land: "all" }, undefined, undefined, coast2);
    expect(p.coastline).toBe(true);
    expect(onAPiece(p, ...toPuzzle(p, sw.e + 7600, CY))).toBe(false);
    expect(onAPiece(p, ...toPuzzle(p, CX + 1500, CY))).toBe(true);
  });
});

describe("the coastline and holes", () => {
  const coast = juraCoast();
  const toPuzzle = (p: IslandPuzzle, e: number, n: number): [number, number] => [(e - p.origin.e) * p.k, (n - p.origin.n) * p.k];
  // A tidal pool the coastline rings (clockwise: sea inside the land), far too small to print as a hole; and a sea-level
  // gap in the heights inside the land (the owner's Arran print: holes through pieces).
  const POOL = { e: CX + 1200, n: CY + 600 };
  const GAP = { e: CX + 600, n: CY - 900 };
  const holey = gridFrom(sw, W, H, 25, (e, n) => (Math.hypot(e - GAP.e, n - GAP.n) < 60 ? -2 : juraHeight(e, n)));
  const withPool = [...coast, ring(POOL.e, POOL.n, 25, 25, 24, false)];

  // Round a point (±0.3 mm), mostly on a piece: a gap between two pieces (0.2 mm) covers at most three of the nine.
  const covered = (p: IslandPuzzle, e: number, n: number) => {
    const [x, y] = toPuzzle(p, e, n);
    let on = 0;
    for (const dx of [-0.3, 0, 0.3]) for (const dy of [-0.3, 0, 0.3]) if (onAPiece(p, x + dx, y + dy)) on++;
    return on >= 6;
  };

  it("a pool too small to print is filled in; the sea loch stays sea; a gap in the heights is land", () => {
    const p = makeIslandPuzzle(holey, sw, W, H, SPEC, undefined, undefined, withPool);
    expect(p.coastline).toBe(true);
    expect(covered(p, POOL.e, POOL.n)).toBe(true);
    expect(covered(p, GAP.e, GAP.n)).toBe(true);
    expect(onAPiece(p, ...toPuzzle(p, LOCH.e, LOCH.n))).toBe(false);
    expect(p.warnings.join(" ")).toMatch(/tiny bit of sea/);
    // Every piece one outline, no hole in it: the ground at the gap is at the sea line, not below.
    for (const q of p.pieces) expect(q.bodies.length).toBe(1);
    expect(p.groundAt(...toPuzzle(p, GAP.e, GAP.n))).toBeGreaterThan(0);
  });
});
