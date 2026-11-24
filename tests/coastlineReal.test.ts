/**
 * The coastline against shapes like the real map's: a mainland coast crossing the box many times (through its corners
 * and along its edges exactly too), split into many ways given in any order, with doubled points, islands touching the
 * edge, and only the ways a query round the box would return. Every cell is checked against the true land.
 */
import { describe, expect, it } from "vitest";
import { coastMask, joinCoast } from "../src/terrain/coastline";

type XY = [number, number];

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Even–odd: is p inside the closed ring? */
const inRing = (r: XY[], p: XY) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [a, b] = [r[i], r[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
};

/** A wiggly anticlockwise land outline round (cx, cy), some points snapped onto the box's lines. */
function wiggly(seed: number, cx: number, cy: number, r0: number, amp: number, n: number, snap: number[]): XY[] {
  const rand = rng(seed);
  const pts: XY[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    const r = r0 + amp * (rand() * 2 - 1);
    let x = cx + r * Math.cos(a);
    let y = cy + r * Math.sin(a);
    // Now and then exactly on a line of the box (its edges, through its corners).
    if (rand() < 0.15) for (const s of snap) if (Math.abs(x - s) < 3) x = s;
    if (rand() < 0.15) for (const s of snap) if (Math.abs(y - s) < 3) y = s;
    pts.push([x, y]);
    if (rand() < 0.05) pts.push([x, y]); // a doubled point
  }
  pts.push(pts[0]);
  return pts;
}

/** The ring cut into ways of a few points each (sharing their end points), shuffled. */
function asWays(seed: number, r: XY[], most = 6): XY[][] {
  const rand = rng(seed);
  const ways: XY[][] = [];
  let i = 0;
  while (i < r.length - 1) {
    const len = 1 + Math.floor(rand() * most);
    const j = Math.min(r.length - 1, i + len);
    ways.push(r.slice(i, j + 1));
    i = j;
  }
  for (let k = ways.length - 1; k > 0; k--) {
    const m = Math.floor(rand() * (k + 1));
    [ways[k], ways[m]] = [ways[m], ways[k]];
  }
  return ways;
}

/** Only the ways a query for the box grown by `margin` would return (a point inside it). */
const fetched = (ways: XY[][], x0: number, y0: number, x1: number, y1: number, margin: number) =>
  ways.filter((w) => w.some(([x, y]) => x >= x0 - margin && x <= x1 + margin && y >= y0 - margin && y <= y1 + margin));

function check(land: XY[][], ways: XY[][], box: [number, number, number, number], cell: number) {
  const [x0, y0, x1, y1] = box;
  const nx = Math.round((x1 - x0) / cell);
  const ny = Math.round((y1 - y0) / cell);
  const m = coastMask(ways, { e: x0, n: y0 }, cell, nx, ny);
  expect(m).not.toBeNull();
  let wrong = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p: XY = [x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell];
      // Land: inside an odd number of the outlines (an outline inside land drawn the other way round is sea).
      const want = land.filter((r) => inRing(r, p)).length % 2;
      if (m![j * nx + i] !== want) wrong++;
    }
  return wrong;
}

const SNAP = [0, 100, 80];
describe("coastline on map-like shapes", () => {
  it("a mainland coast crossing every side of the box many times, through its corners and along its edges", () => {
    for (let seed = 1; seed <= 40; seed++) {
      // Land centred off the box so its coast wanders in and out across the box's sides and corners.
      const box: [number, number, number, number] = [0, 0, 100, 80];
      const coast = wiggly(seed, 30 + (seed % 5) * 10, 20 + (seed % 3) * 15, 55, 25, 120, SNAP);
      const ways = fetched(asWays(seed * 7, coast), ...box, 5);
      expect(check([coast], ways, box, 1)).toBe(0);
      // The ways in the opposite order, and reversed within the list: the same land.
      expect(check([coast], [...ways].reverse(), box, 1), `seed ${seed} reversed list`).toBe(0);
    }
  });

  it("a coast lying along the box's edge for a stretch, either way round", () => {
    const box: [number, number, number, number] = [0, 0, 100, 100];
    // Land to the north of y = 0 for a while: the coast runs east along the box's south edge, then up and out.
    const a: XY[] = [[-20, -10], [0, 0], [40, 0], [60, 0], [60, 50], [130, 50], [130, 150], [-20, 150], [-20, -10]];
    expect(check([a], [a.slice(0, 6)], box, 1)).toBe(0);
    // Land to the south: it runs west along the edge (outside the box: only the sea is inside, but the coast touches).
    const b: XY[] = [[130, -10], [130, 50], [60, 50], [60, 0], [40, 0], [0, 0], [-20, -10], [-20, -50], [130, -50], [130, -10]];
    expect(check([b], [b.slice(0, 7)], box, 1)).toBe(0);
  });

  it("an island touching the box's edge at one point, and one at a corner", () => {
    const box: [number, number, number, number] = [0, 0, 100, 100];
    const isle: XY[] = [[50, 0], [70, 20], [50, 40], [30, 20], [50, 0]];
    expect(check([isle], [isle], box, 1)).toBe(0);
    const corner: XY[] = [[100, 100], [80, 90], [70, 70], [90, 80], [100, 100]];
    expect(check([corner], [corner], box, 1)).toBe(0);
    // A ring of sea in land (the land outside it, as a lake of sea would be) touching the edge at a point.
    const land: XY[] = [[-50, -50], [150, -50], [150, 150], [-50, 150], [-50, -50]];
    const pool: XY[] = [[50, 0], [30, 20], [50, 40], [70, 20], [50, 0]];
    expect(check([land, pool], [pool, land], box, 1)).toBe(0);
  });

  it("many small ways are joined in reasonable time", () => {
    const coast = wiggly(3, 0, 0, 20000, 300, 200_000, []);
    const ways = asWays(5, coast, 400);
    const t = Date.now();
    const joined = joinCoast(ways);
    expect(joined.length).toBe(1);
    expect(joined[0].length).toBe(coast.length);
    expect(Date.now() - t).toBeLessThan(20_000);
  });
});
