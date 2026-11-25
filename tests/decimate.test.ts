import { describe, expect, it } from "vitest";
import { decimate, weldCorners } from "../src/geometry/decimate";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { bandedBall, lumpyBall, MeshBuilder } from "./support/meshShapes";

/** A box w × d × h with every face cut into an n × n grid of squares (two triangles each). */
function gridBox(w: number, d: number, h: number, n: number): MeshBuilder {
  const m = new MeshBuilder();
  const ids = new Map<string, number>();
  const at = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    let i = ids.get(key);
    if (i === undefined) ids.set(key, (i = m.point([x, y, z])));
    return i;
  };
  const steps = (s: number) => Array.from({ length: n + 1 }, (_, i) => (s * i) / n);
  // Each face: corners from (u, v) on it.
  const face = (pt: (u: number, v: number) => [number, number, number], us: number[], vs: number[], out: [number, number, number]) => {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = at(...pt(us[i], vs[j])), b = at(...pt(us[i + 1], vs[j])), c = at(...pt(us[i + 1], vs[j + 1])), e = at(...pt(us[i], vs[j + 1]));
        m.quad(a, b, c, e, out);
      }
  };
  face((u, v) => [u, v, 0], steps(w), steps(d), [0, 0, -1]);
  face((u, v) => [u, v, h], steps(w), steps(d), [0, 0, 1]);
  face((u, v) => [u, 0, v], steps(w), steps(h), [0, -1, 0]);
  face((u, v) => [u, d, v], steps(w), steps(h), [0, 1, 0]);
  face((u, v) => [0, u, v], steps(d), steps(h), [-1, 0, 0]);
  face((u, v) => [w, u, v], steps(d), steps(h), [1, 0, 0]);
  return m;
}

const sound = (vertices: number[], triangles: number[]) => {
  const a = analyzeMesh(vertices, triangles);
  expect(a.openEdges).toBe(0);
  expect(a.nonManifoldEdges).toBe(0);
  expect(a.flippedEdges).toBe(0);
  expect(a.degenerateTriangles).toBe(0);
  return a;
};

describe("reducing a mesh", () => {
  it("keeps a lumpy ball closed, with the triangles asked for and nearly the same volume", () => {
    const ball = lumpyBall(160, 320);
    const before = analyzeMesh(ball.vertices, ball.triangles);
    const r = decimate(ball.vertices, ball.triangles, 20_000);
    expect(r.triangles.length / 3).toBeLessThanOrEqual(20_000);
    expect(r.triangles.length / 3).toBeGreaterThan(19_000);
    const after = sound(r.vertices, r.triangles);
    expect(after.pieces).toBe(1);
    expect(Math.abs(after.volume - before.volume) / before.volume).toBeLessThan(0.02);
  });

  it("copes with a very rough, very fine mesh (no folds: the volume stays)", () => {
    // Corners a fraction of a millimetre apart jumping 0.4 mm in and out: a pathological scan.
    const ball = lumpyBall(250, 500);
    const before = analyzeMesh(ball.vertices, ball.triangles);
    const r = decimate(ball.vertices, ball.triangles, 5_000);
    const after = sound(r.vertices, r.triangles);
    expect(r.triangles.length / 3).toBeLessThanOrEqual(5_000);
    expect(Math.abs(after.volume - before.volume) / before.volume).toBeLessThan(0.03);
    for (let i = 0; i < r.vertices.length; i += 3) expect(Math.hypot(r.vertices[i], r.vertices[i + 1], r.vertices[i + 2])).toBeGreaterThan(7.9);
  });

  it("keeps a box's sharp edges and corners: same volume, every corner on its faces", () => {
    const box = gridBox(40, 30, 20, 30);
    const r = decimate(box.vertices, box.triangles, 100);
    expect(r.triangles.length / 3).toBeLessThanOrEqual(100);
    const a = sound(r.vertices, r.triangles);
    expect(a.volume).toBeCloseTo(40 * 30 * 20, 6);
    for (let i = 0; i < r.vertices.length; i += 3) {
      const [x, y, z] = [r.vertices[i], r.vertices[i + 1], r.vertices[i + 2]];
      const onFace = [x, 40 - x, y, 30 - y, z, 20 - z].some((d) => Math.abs(d) < 1e-9);
      expect(onFace).toBe(true);
    }
    for (const c of [[0, 0, 0], [40, 0, 0], [0, 30, 0], [40, 30, 0], [0, 0, 20], [40, 0, 20], [0, 30, 20], [40, 30, 20]]) {
      let found = false;
      for (let i = 0; i < r.vertices.length; i += 3) if (Math.hypot(r.vertices[i] - c[0], r.vertices[i + 1] - c[1], r.vertices[i + 2] - c[2]) < 1e-9) found = true;
      expect(found).toBe(true);
    }
  });

  it("doesn't go below a tetrahedron, and leaves a small mesh alone", () => {
    const box = gridBox(10, 10, 10, 2);
    const tiny = decimate(box.vertices, box.triangles, 1);
    expect(tiny.triangles.length / 3).toBeGreaterThanOrEqual(4);
    sound(tiny.vertices, tiny.triangles);
    const same = decimate(box.vertices, box.triangles, 10_000);
    expect(same.triangles.length).toBe(box.triangles.length);
  });

  it("keeps an open sheet's outline where it was", () => {
    const m = new MeshBuilder();
    const n = 40;
    const id = (i: number, j: number) => i * (n + 1) + j;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) m.point([i, j, Math.sin(i / 6) * 2]);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) m.quad(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1), [0, 0, 1]);
    const r = decimate(m.vertices, m.triangles, 400);
    expect(r.triangles.length / 3).toBeLessThanOrEqual(400);
    const a = analyzeMesh(r.vertices, r.triangles);
    expect(a.nonManifoldEdges).toBe(0);
    // Its four corners are still there.
    for (const [x, y] of [[0, 0], [n, 0], [0, n], [n, n]]) {
      let found = false;
      for (let i = 0; i < r.vertices.length; i += 3) if (Math.abs(r.vertices[i] - x) < 1e-9 && Math.abs(r.vertices[i + 1] - y) < 1e-9) found = true;
      expect(found).toBe(true);
    }
    // Every open corner still on the sheet's square outline.
    for (let i = 0; i < r.vertices.length; i += 3) {
      const [x, y] = [r.vertices[i], r.vertices[i + 1]];
      expect(x > -1e-9 && x < n + 1e-9 && y > -1e-9 && y < n + 1e-9).toBe(true);
    }
  });

  it("joins an STL's loose corners", () => {
    const ball = bandedBall(20, 40);
    const loose: number[] = [];
    for (const v of ball.triangles) loose.push(ball.vertices[3 * v], ball.vertices[3 * v + 1], ball.vertices[3 * v + 2]);
    const w = weldCorners(Float32Array.from(loose));
    expect(w.vertices.length).toBe(ball.vertices.length);
    expect(w.triangles.length).toBe(ball.triangles.length);
    sound(w.vertices, w.triangles);
  });
});
