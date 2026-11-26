import { describe, expect, it } from "vitest";
import { meshCheck } from "../src/terrain/colour";
import { PINCH_SHIFT, splitWater } from "../src/terrain/waterPart";

const volume = (V: ArrayLike<number>, T: ArrayLike<number>) => meshCheck(V, T).volume;

describe("water slabs where a loch touches itself at one corner", () => {
  it("two squares of water meeting corner to corner: both parts closed, volumes add up", () => {
    // Water in cells (1,1) and (2,2) of a 4 × 4 block whose land is raised: they meet at the corner (2,2) only.
    const wet = (i: number, j: number) => (i === 1 && j === 1) || (i === 2 && j === 2);
    const m = pocket(4, wet);
    const split = splitWater(m, m.isWater, 0.4, 0);
    expect(split).not.toBeNull();
    const { main, waters } = split!;
    expect(meshCheck(main.vertices, main.triangles).open).toBe(0);
    expect(waters.length).toBe(1);
    expect(meshCheck(waters[0].mesh.vertices, waters[0].mesh.triangles).open).toBe(0);
    const whole = volume(m.vertices, m.triangles);
    const sum = volume(main.vertices, main.triangles) + volume(waters[0].mesh.vertices, waters[0].mesh.triangles);
    expect(Math.abs(sum - whole)).toBeLessThan(1e-9);
    // Each square is a slab 0.4 thick (the floor copies at the pinch moved only a hair).
    expect(Math.abs(volume(waters[0].mesh.vertices, waters[0].mesh.triangles) - 2 * 0.4)).toBeLessThan(1e-3);
    // Two floor copies of the pinch corner, PINCH_SHIFT apart from it, in their own squares.
    const W = waters[0].mesh.vertices;
    const near: [number, number][] = [];
    for (let i = 0; i < W.length; i += 3) if (Math.abs(W[i + 2] - 0.6) < 1e-9 && Math.hypot(W[i] - 2, W[i + 1] - 2) < 0.01) near.push([W[i], W[i + 1]]);
    expect(near.length).toBe(2);
    for (const [x, y] of near) expect(Math.abs(Math.hypot(x - 2, y - 2) - PINCH_SHIFT)).toBeLessThan(1e-9);
    expect(near.some(([x, y]) => x < 2 && y < 2) && near.some(([x, y]) => x > 2 && y > 2)).toBe(true);
  });
  it("a loch round a hill that touches itself at a corner, and lochs reaching the piece's corner", () => {
    // A ring of water round a 2 × 2 hill, with its corner cell (1, 1) left out: (2, 1) and (1, 2) meet only at the
    // corner (2, 2), so the ring closes there through a pinch; and two ponds on the block's sides meeting at (1, 7).
    const cells = new Set<string>(["0,6", "1,7"]);
    for (let k = 1; k <= 4; k++) for (const c of [`${k},1`, `${k},4`, `1,${k}`, `4,${k}`]) cells.add(c);
    cells.delete("1,1");
    const wet = (i: number, j: number) => cells.has(`${i},${j}`);
    const m = pocket(8, wet);
    const split = splitWater(m, m.isWater, 0.4, 0);
    expect(split).not.toBeNull();
    const { main, waters } = split!;
    expect(meshCheck(main.vertices, main.triangles).open).toBe(0);
    let sum = volume(main.vertices, main.triangles);
    for (const w of waters) {
      expect(meshCheck(w.mesh.vertices, w.mesh.triangles).open).toBe(0);
      sum += volume(w.mesh.vertices, w.mesh.triangles);
    }
    expect(Math.abs(sum - volume(m.vertices, m.triangles))).toBeLessThan(1e-9);
    expect(Math.abs(waters.reduce((s, w) => s + volume(w.mesh.vertices, w.mesh.triangles), 0) - cells.size * 0.4)).toBeLessThan(1e-3);
  });
});

/**
 * An `n × n` block of unit cells on the bed: a height field whose corners are at 1 where they touch a water cell, else at
 * 2, so each water cell is flat at 1 and the land slopes up from its shore (as a puzzle's ground does); upright sides and a
 * flat bottom. Water cells meeting only at a corner make a pinch: the loch touches itself at that one corner.
 */
function pocket(n: number, wet: (i: number, j: number) => boolean) {
  const vertices: number[] = [];
  const triangles: number[] = [];
  const at = (x: number, y: number, top: boolean) => (top ? 0 : (n + 1) ** 2) + x * (n + 1) + y;
  const touches = (x: number, y: number) => [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]].some(([i, j]) => i >= 0 && j >= 0 && i < n && j < n && wet(i, j));
  for (const top of [true, false]) for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) vertices.push(x, y, top ? (touches(x, y) ? 1 : 2) : 0);
  const quad = (a: number, b: number, c: number, d: number) => triangles.push(a, b, c, a, c, d);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const [a, b, c, d] = [at(i, j, true), at(i + 1, j, true), at(i + 1, j + 1, true), at(i, j + 1, true)];
      const low = (v: number) => vertices[v * 3 + 2] === 1;
      // Land cells take the diagonal that leaves no flat triangle at the water's height.
      if (!wet(i, j) && ((low(a) && low(b) && low(c)) || (low(a) && low(c) && low(d)))) quad(b, c, d, a);
      else quad(a, b, c, d);
      quad(at(i, j, false), at(i, j + 1, false), at(i + 1, j + 1, false), at(i + 1, j, false));
    }
  for (let k = 0; k < n; k++) {
    quad(at(k, 0, false), at(k + 1, 0, false), at(k + 1, 0, true), at(k, 0, true));
    quad(at(n, k, false), at(n, k + 1, false), at(n, k + 1, true), at(n, k, true));
    quad(at(k + 1, n, false), at(k, n, false), at(k, n, true), at(k + 1, n, true));
    quad(at(0, k + 1, false), at(0, k, false), at(0, k, true), at(0, k + 1, true));
  }
  return { vertices, triangles, isWater: (x: number, y: number) => wet(Math.floor(x), Math.floor(y)) };
}
