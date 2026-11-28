import { describe, expect, it } from "vitest";
import { Mesh } from "../src/terrain/mountainPuzzle";
import { undersideLoops } from "../src/terrain/topOutline";

const area = (l: Float64Array) => {
  let s = 0;
  for (let i = 0; i < l.length; i += 2) {
    const j = (i + 2) % l.length;
    s += l[i] * l[j + 1] - l[j] * l[i + 1];
  }
  return s / 2;
};

describe("undersideLoops", () => {
  it("gives a square with a hole as two loops running opposite ways", () => {
    const m = new Mesh();
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: [number, number][] = [[3, 3], [3, 7], [7, 7], [7, 3]];
    m.face(outer, [hole], 0, false);
    m.face(outer, [hole], 5, true);
    const loops = undersideLoops({ part: "rock", vertices: m.v, triangles: m.t });
    expect(loops.length).toBe(2);
    const areas = loops.map(area).sort((a, b) => Math.abs(b) - Math.abs(a));
    expect(Math.abs(areas[0])).toBeCloseTo(100, 9);
    expect(Math.abs(areas[1])).toBeCloseTo(16, 9);
    expect(Math.sign(areas[0])).toBe(-Math.sign(areas[1]));
  });
  it("joins corners at the same place even when the triangles don't share them", () => {
    const v = [0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0];
    const loops = undersideLoops({ part: "rock", vertices: v, triangles: [0, 2, 1, 3, 5, 4] });
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(8);
    expect(Math.abs(area(loops[0]))).toBeCloseTo(16, 9);
  });
  it("draws a one-piece island's underside quickly", () => {
    const m = new Mesh();
    // A 300 × 300 grid of squares, each two triangles facing down.
    const N = 300;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = m.point(x, y, 0), b = m.point(x + 1, y, 0), c = m.point(x + 1, y + 1, 0), d = m.point(x, y + 1, 0);
        m.tri(a, c, b);
        m.tri(a, d, c);
      }
    const loops = undersideLoops({ part: "rock", vertices: m.v, triangles: m.t });
    expect(loops.length).toBe(1);
    expect(Math.abs(area(loops[0]))).toBeCloseTo(N * N, 6);
  });
});
