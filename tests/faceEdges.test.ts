import { describe, expect, it } from "vitest";

import { edgesOfFace, type FaceEdgeMesh } from "../src/model/faceEdges";

/** A 10 × 10 × 10 box's display mesh: 6 faces of 2 triangles, 12 straight edges. */
function box(): FaceEdgeMesh {
  const v: number[][] = [];
  for (let i = 0; i < 8; i++) v.push([i & 1 ? 10 : 0, i & 2 ? 10 : 0, i & 4 ? 10 : 0]);
  const quads = [
    [0, 1, 3, 2], // bottom z = 0
    [4, 5, 7, 6], // top z = 10
    [0, 1, 5, 4], // y = 0
    [2, 3, 7, 6], // y = 10
    [0, 2, 6, 4], // x = 0
    [1, 3, 7, 5], // x = 10
  ];
  const triangles: number[] = [];
  const faceGroups = quads.map((q) => {
    const start = triangles.length;
    triangles.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    return { start, count: 6 };
  });
  const pairs = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const lines: number[] = [];
  const edgeGroups = pairs.map(([a, b], i) => {
    lines.push(...v[a], ...v[b]);
    return { start: 2 * i, count: 2 };
  });
  return { vertices: Float32Array.from(v.flat()), triangles: Uint32Array.from(triangles), faceGroups, lines: Float32Array.from(lines), edgeGroups };
}

describe("the edges round a face", () => {
  it("finds the four edges of a box's top and of a side, not the ones only touching a corner", () => {
    const m = box();
    expect(edgesOfFace(m, 1)).toEqual([4, 5, 6, 7]);
    expect(edgesOfFace(m, 2).sort((a, b) => a - b)).toEqual([0, 4, 8, 9]);
    expect(edgesOfFace(m, 9)).toEqual([]);
  });
});
