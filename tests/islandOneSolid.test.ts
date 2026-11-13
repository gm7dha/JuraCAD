/**
 * Every island piece prints as one solid with no hole through it (pure, heavy: its own file). Over three coasts — the
 * lumpy island, a ragged one and a low ragged one — at 15, 25, 35 and 60 mm pieces and patterns 1–3, and the reviewer's
 * two cases: a very flat coast where a dovetail's knob was cut off from its piece and sat as a loose plug in its socket,
 * and a low ragged coast with pinholes through a piece. Every dovetail left still catches.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { ISLAND_DEFAULTS, makeIslandPuzzle, type IslandPuzzle } from "../src/terrain/islandPuzzle";
import { collides, outlineSegs, SegGrid } from "./support/outlineGeom";

const W = 6000;
const H = 4000;
const sw = { e: 300000, n: 700000 };
const grid = (h: (x: number, y: number, a: number, e: number, n: number) => number) =>
  gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    return h(x, y, Math.atan2(y, x), e, n);
  });
const lumpy = grid((x, y, a, e) => {
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(a * 3);
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r)) + (Math.hypot(x - 0.44, y + 0.4) < 0.04 ? 30 : 0);
});
const ragged = grid((x, y, a, e, n) => Math.max(0, (1 - (Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 7) + 0.08 * Math.sin(a * 13 + 1) + 0.05 * Math.sin(e / 90) * Math.cos(n / 110))) * 300));
const low = grid((x, y, a, e, n) => Math.max(0, (1 - (Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 9) + 0.07 * Math.sin(a * 23 + 1) + 0.04 * Math.sin(e / 70) * Math.cos(n / 80))) * 25));
// The reviewer's: about 4 m high, and about 12 m.
const lowFlat = grid((x, y, a, e, n) => {
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.1 * Math.sin(11 * a) + 0.07 * Math.sin(e / 50) * Math.sin(n / 55);
  return Math.max(0, (1 - r) * 4 + 0.8 * Math.cos(e / 33) * Math.sin(n / 41));
});
const lowRagged = grid((x, y, a, e, n) => {
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(7 * a) + 0.08 * Math.sin(13 * a + 1) + 0.06 * Math.sin(e / 70) * Math.cos(n / 90);
  return Math.max(0, (1 - r) * 12 + 1.5 * Math.sin(e / 45 + n / 60));
});

/** A piece's underside outline as loops, each with its signed area (outlineSegs runs outer loops negative, holes positive). */
function loopAreas(b: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): number[] {
  const segs = outlineSegs(b);
  const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
  const up = new Map<string, string>();
  const find = (a: string): string => {
    while (up.get(a) !== a) a = up.get(a)!;
    return a;
  };
  for (const [ax, ay, bx, by] of segs) {
    const [a, c] = [key(ax, ay), key(bx, by)];
    if (!up.has(a)) up.set(a, a);
    if (!up.has(c)) up.set(c, c);
    up.set(find(a), find(c));
  }
  const area = new Map<string, number>();
  for (const [ax, ay, bx, by] of segs) {
    const r = find(key(ax, ay));
    area.set(r, (area.get(r) ?? 0) + (ax * by - bx * ay) / 2);
  }
  return [...area.values()];
}

/** Dovetails that slide straight out (islandPuzzle.test's check). */
function slideOut(p: IslandPuzzle): number {
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

function oneSolidEach(p: IslandPuzzle, label: string) {
  for (const q of p.pieces) {
    const loops = loopAreas(q.bodies[0]);
    expect(loops.filter((a) => a < 0).length, `${label}: piece ${q.name} in bits`).toBe(1);
    expect(loops.filter((a) => a > 0), `${label}: piece ${q.name} holes`).toEqual([]);
  }
  expect(slideOut(p), `${label}: dovetails sliding out`).toBe(0);
  expect(p.pieces.reduce((s, q) => s + q.joints, 0), label).toBe(2 * p.joins);
}

const SPEC = { ...ISLAND_DEFAULTS, bed: [200, 200, 200] as [number, number, number] };

describe("every island piece is one solid", () => {
  it("on a very flat coast: a knob cut off from its piece goes to the piece round it, not left as a loose plug", () => {
    const p = makeIslandPuzzle(lowFlat, sw, W, H, { ...SPEC, piece: 25, seed: 1 });
    oneSolidEach(p, "flat 25 mm pattern 1");
    expect(p.warnings.join(" ")).toMatch(/1 dovetail was too thin at the neck to hold/);
  });
  it("on a low ragged coast: no pinholes through a piece", () => {
    oneSolidEach(makeIslandPuzzle(lowRagged, sw, W, H, { ...SPEC, piece: 25, seed: 2 }), "low ragged 25 mm pattern 2");
  });
  for (const [name, g] of [
    ["lumpy", lumpy],
    ["ragged", ragged],
    ["low", low],
  ] as const)
    it(`on the ${name} coast at 15, 25, 35 and 60 mm, patterns 1–3`, () => {
      for (const piece of [15, 25, 35, 60]) for (const seed of [1, 2, 3]) oneSolidEach(makeIslandPuzzle(g, sw, W, H, { ...SPEC, piece, seed }), `${name} ${piece} mm pattern ${seed}`);
    });
});
