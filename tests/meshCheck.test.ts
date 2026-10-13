import { describe, expect, it } from "vitest";

import { analyzeMesh, withoutDegenerateTriangles } from "../src/geometry/meshCheck";
import { readBinaryStl, writeBinaryStl } from "../src/geometry/stl";

/**
 * An axis-aligned box meshed like OpenCascade does it: each face has its own
 * four corners (duplicated between faces), two outward-facing triangles each.
 */
function boxMesh(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0) {
  const v: number[] = [];
  const t: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const base = v.length / 3;
    for (const p of [a, b, c, d]) v.push(p[0] * sx + ox, p[1] * sy + oy, p[2] * sz + oz);
    t.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]); // bottom (-Z)
  quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]); // top (+Z)
  quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]); // front (-Y)
  quad([0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]); // back (+Y)
  quad([0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]); // left (-X)
  quad([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]); // right (+X)
  return { vertices: v, triangles: t };
}

describe("mesh check", () => {
  it("passes a closed box and measures it", () => {
    const { vertices, triangles } = boxMesh(40, 30, 20);
    const a = analyzeMesh(vertices, triangles);
    expect(a.watertight).toBe(true);
    expect(a.triangleCount).toBe(12);
    expect(a.vertexCount).toBe(8); // duplicates welded
    expect(a.pieces).toBe(1);
    expect(a.volume).toBeCloseTo(24000, 6);
    expect(a.area).toBeCloseTo(2 * (40 * 30 + 40 * 20 + 30 * 20), 6);
    expect(a.bounds).toEqual({ min: [0, 0, 0], max: [40, 30, 20] });
  });

  it("finds holes", () => {
    const { vertices, triangles } = boxMesh(10, 10, 10);
    const a = analyzeMesh(vertices, triangles.slice(0, -6)); // drop the right face
    expect(a.watertight).toBe(false);
    expect(a.openEdges).toBe(4);
  });

  it("finds a face pointing the wrong way", () => {
    const { vertices, triangles } = boxMesh(10, 10, 10);
    const flipped = [...triangles];
    for (const i of [0, 3]) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2], flipped[i + 1]];
    const a = analyzeMesh(vertices, flipped);
    expect(a.watertight).toBe(false);
    expect(a.flippedEdges).toBeGreaterThan(0);
  });

  it("notices an inside-out solid", () => {
    const { vertices, triangles } = boxMesh(10, 10, 10);
    const inverted = [...triangles];
    for (let i = 0; i < inverted.length; i += 3) [inverted[i + 1], inverted[i + 2]] = [inverted[i + 2], inverted[i + 1]];
    const a = analyzeMesh(vertices, inverted);
    expect(a.volume).toBeLessThan(0);
    expect(a.watertight).toBe(false);
  });

  it("counts separate pieces", () => {
    const a = boxMesh(10, 10, 10);
    const b = boxMesh(5, 5, 5, 50, 0, 0);
    const offset = a.vertices.length / 3;
    const result = analyzeMesh([...a.vertices, ...b.vertices], [...a.triangles, ...b.triangles.map((i) => i + offset)]);
    expect(result.pieces).toBe(2);
    expect(result.watertight).toBe(true);
    expect(result.volume).toBeCloseTo(1000 + 125, 6);
  });

  it("ignores zero-area slivers like those at a sphere's pole", () => {
    const { vertices, triangles } = boxMesh(10, 10, 10);
    // Add a sliver that reuses one corner twice.
    const withSliver = [...triangles, 0, 0, 1];
    const a = analyzeMesh(vertices, withSliver);
    expect(a.degenerateTriangles).toBe(1);
    expect(a.watertight).toBe(true);
    expect(withoutDegenerateTriangles(vertices, withSliver)).toHaveLength(triangles.length);
  });

  it("handles an empty mesh", () => {
    const a = analyzeMesh([], []);
    expect(a.watertight).toBe(false);
    expect(a.bounds).toBeNull();
    expect(a.pieces).toBe(0);
  });
});

describe("STL files", () => {
  it("writes binary STL that reads back identically", () => {
    const box = boxMesh(40, 30, 20);
    const buffer = writeBinaryStl([box, boxMesh(1, 1, 1, 100, 0, 0)], "test header");
    expect(buffer.byteLength).toBe(84 + 24 * 50);
    expect(new TextDecoder().decode(new Uint8Array(buffer, 0, 11))).toBe("test header");
    const back = readBinaryStl(buffer);
    expect(back.triangleCount).toBe(24);
    // First triangle's first vertex matches the input.
    const [i] = box.triangles;
    expect(Array.from(back.vertices.slice(0, 3))).toEqual(box.vertices.slice(3 * i, 3 * i + 3));
    // Re-analysing what a slicer would read gives the same solid.
    const indices = Array.from({ length: back.triangleCount * 3 }, (_, k) => k);
    const a = analyzeMesh(back.vertices, indices);
    expect(a.watertight).toBe(true);
    expect(a.pieces).toBe(2);
  });

  it("writes outward normals", () => {
    const buffer = writeBinaryStl([boxMesh(10, 10, 10)]);
    const view = new DataView(buffer);
    // The first triangle is on the bottom face, so its normal points down.
    expect(view.getFloat32(84 + 8, true)).toBeCloseTo(-1, 6);
  });
});

describe("wall thickness", () => {
  /** A closed box mesh with outward-facing triangles. */
  function boxMesh(w: number, d: number, h: number) {
    const c = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    return { vertices: c.flat(), triangles: f.flat() };
  }

  it("finds the thinnest direction of a slab", async () => {
    const { estimateThickness } = await import("../src/geometry/meshCheck");
    const m = boxMesh(40, 30, 1.5);
    const r = estimateThickness(m.vertices, m.triangles);
    expect(r?.thickness).toBeCloseTo(1.5, 6);
  });

  it("measures a cube across", async () => {
    const { estimateThickness } = await import("../src/geometry/meshCheck");
    const m = boxMesh(10, 10, 10);
    expect(estimateThickness(m.vertices, m.triangles)?.thickness).toBeCloseTo(10, 6);
  });
});
