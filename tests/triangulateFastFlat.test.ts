import { describe, expect, it } from "vitest";
import { triangulateFast } from "../src/terrain/triangulateFast";

type P2 = [number, number];
/** Every edge of the outline (walked anticlockwise) is an edge of some triangle, the same way round. */
function everyEdgeUsed(outline: P2[], tris: [number, number, number][]): boolean {
  const ccw = outline.reduce((s, p, i) => s + p[0] * outline[(i + 1) % outline.length][1] - outline[(i + 1) % outline.length][0] * p[1], 0) >= 0;
  const used = new Set<string>();
  for (const [a, b, c] of tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) used.add(`${p},${q}`);
  return outline.every((_, i) => {
    const j = (i + 1) % outline.length;
    return ccw ? used.has(`${i},${j}`) : used.has(`${j},${i}`);
  });
}

describe("triangulateFast with corners in a line", () => {
  it("an outline with no area still gets triangles along it (so the cap closes)", () => {
    const line: P2[] = [[0, 0], [0, 2], [0, 1]];
    const tris = triangulateFast(line);
    expect(tris.length).toBe(1);
    const strip: P2[] = [[5, 0], [5, 1], [5, 1.000004], [5, 2], [5, 0.5]];
    expect(triangulateFast(strip).length).toBe(3);
  });
  it("a square with a run of corners along one side a hair apart: every edge used, area kept", () => {
    const square: P2[] = [[0, 0], [1, 0], [1, 0.25], [1, 0.249996], [1, 0.5], [1, 0.500588], [1, 1], [0, 1]];
    const tris = triangulateFast(square);
    expect(everyEdgeUsed(square, tris)).toBe(true);
    const area = tris.reduce((s, [a, b, c]) => s + ((square[b][0] - square[a][0]) * (square[c][1] - square[a][1]) - (square[b][1] - square[a][1]) * (square[c][0] - square[a][0])) / 2, 0);
    expect(area).toBeCloseTo(1, 9);
  });
  it("an ordinary outline is triangulated as before", () => {
    const l: P2[] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const tris = triangulateFast(l);
    expect(tris.length).toBe(4);
    expect(everyEdgeUsed(l, tris)).toBe(true);
  });
});
