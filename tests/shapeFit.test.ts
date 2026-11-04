/** Fitting lines, circles, planes, cylinders, cones, spheres and tori to (noisy) points, and tidying sizes. */
import { describe, expect, it } from "vitest";
import {
  add,
  dot,
  fitCircle2D,
  fitCircle3D,
  fitCone,
  fitCylinder,
  fitLine,
  fitPlane,
  fitSphere,
  fitTorus,
  frameOf,
  norm,
  scale,
  snapDirection,
  snapNice,
  surfaceDistance,
  tidySurface,
  unit,
  type Vec3,
} from "../src/geometry/shapeFit";

/** Repeatable "random" numbers in −1…1. */
function noise(seed = 1) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x / 2147483648) * 2 - 1;
  };
}

describe("fitting shapes to points", () => {
  it("finds a plane through noisy points", () => {
    const rnd = noise(3);
    const n = unit([1, 2, 3]);
    const [u, v] = frameOf(n);
    const pts: Vec3[] = [];
    for (let i = 0; i < 200; i++) pts.push(add(add(scale(u, rnd() * 20), scale(v, rnd() * 20)), scale(n, 5 + rnd() * 0.01)));
    const f = fitPlane(pts, n)!;
    expect(dot(f.shape.normal, n)).toBeGreaterThan(0.99999);
    expect(f.maxError).toBeLessThan(0.02);
    expect(dot(f.shape.origin, n)).toBeCloseTo(5, 2);
  });

  it("finds a circle in 2D and in 3D, even from part of one", () => {
    const rnd = noise(5);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 50; i++) {
      const a = (i / 50) * 1.5; // a quarter turn or so
      const r = 4 + rnd() * 0.005;
      xs.push(10 + r * Math.cos(a));
      ys.push(-3 + r * Math.sin(a));
    }
    const c = fitCircle2D(xs, ys)!;
    expect(c.circle.cx).toBeCloseTo(10, 2);
    expect(c.circle.cy).toBeCloseTo(-3, 2);
    expect(Math.abs(c.circle.r - 4)).toBeLessThan(0.01);

    const n = unit([0, 1, 1]);
    const [u, v] = frameOf(n);
    const pts: Vec3[] = Array.from({ length: 40 }, (_, i) => add([1, 2, 3], add(scale(u, 2.5 * Math.cos(i / 6)), scale(v, 2.5 * Math.sin(i / 6)))));
    const c3 = fitCircle3D(pts)!;
    expect(c3.shape.radius).toBeCloseTo(2.5, 6);
    expect(Math.abs(dot(c3.shape.normal, n))).toBeCloseTo(1, 6);
    expect(norm(add(c3.shape.centre, [-1, -2, -3]))).toBeLessThan(1e-6);
  });

  it("finds a line", () => {
    const rnd = noise(7);
    const d = unit([1, -1, 0.5]);
    const pts: Vec3[] = Array.from({ length: 30 }, (_, i) => add(add([2, 0, 1], scale(d, i)), [rnd() * 0.001, rnd() * 0.001, 0]));
    const l = fitLine(pts)!;
    expect(Math.abs(dot(l.shape.dir, d))).toBeGreaterThan(0.99999);
    expect(l.maxError).toBeLessThan(0.002);
  });

  it("finds a cylinder from facets' corners and normals, with noise", () => {
    const rnd = noise(11);
    const axis = unit([0.2, 0.1, 1]);
    const [u, v] = frameOf(axis);
    const pts: Vec3[] = [];
    const normals: Vec3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 2 * Math.PI;
      const radial = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
      for (const h of [0, 12]) pts.push(add(add([5, 5, 0], scale(axis, h)), scale(radial, 3 + rnd() * 0.003)));
      // The facet between this corner and the next faces out through its middle (roughly, as from a noisy mesh).
      const mid = (a + Math.PI / 24) % (2 * Math.PI);
      normals.push(unit(add(add(scale(u, Math.cos(mid)), scale(v, Math.sin(mid))), [rnd() * 0.01, rnd() * 0.01, rnd() * 0.01])));
    }
    const f = fitCylinder(pts, normals)!;
    expect(Math.abs(f.shape.radius - 3)).toBeLessThan(0.01);
    expect(Math.abs(dot(f.shape.axis, axis))).toBeGreaterThan(0.9999);
    expect(f.maxError).toBeLessThan(0.01);
  });

  it("finds a cone (a countersink) and a sphere", () => {
    const rnd = noise(13);
    const pts: Vec3[] = [];
    const normals: Vec3[] = [];
    // Radius 2 at z = 0 growing to 5 at z = 3 (a 90° countersink).
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * 2 * Math.PI;
      for (const z of [0, 3]) pts.push([(2 + z + rnd() * 0.002) * Math.cos(a), (2 + z) * Math.sin(a), z]);
      normals.push(unit([Math.cos(a + Math.PI / 32), Math.sin(a + Math.PI / 32), -1]));
    }
    const cone = fitCone(pts, normals)!;
    expect(cone.maxError).toBeLessThan(0.01);
    expect(Math.abs(Math.abs(cone.shape.slope) - 1)).toBeLessThan(0.01);
    expect(Math.abs(Math.abs(cone.shape.axis[2]) - 1)).toBeLessThan(1e-4);

    const ball: Vec3[] = [];
    for (let i = 0; i < 300; i++) {
      const d = unit([rnd(), rnd(), rnd()]);
      ball.push(add([1, -2, 3], scale(d, 6 + rnd() * 0.004)));
    }
    const s = fitSphere(ball)!;
    expect(Math.abs(s.shape.radius - 6)).toBeLessThan(0.01);
    expect(norm(add(s.shape.centre, [-1, 2, -3]))).toBeLessThan(0.01);
  });

  it("finds a torus (a fillet round a boss) from facets' middles and normals", () => {
    const pts: Vec3[] = [];
    const middles: Vec3[] = [];
    const normals: Vec3[] = [];
    const R = 8.5;
    const r = 1.5;
    const at = (u: number, v: number): Vec3 => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), 6.5 + r * Math.sin(v)];
    for (let i = 0; i < 36; i++)
      for (let j = 0; j <= 6; j++) {
        const u = (i / 36) * 2 * Math.PI;
        const v = (j / 6) * (Math.PI / 2);
        pts.push(at(u, v));
        if (j < 6) {
          const um = u + Math.PI / 36;
          const vm = v + Math.PI / 24;
          middles.push(at(um, vm));
          normals.push([Math.cos(vm) * Math.cos(um), Math.cos(vm) * Math.sin(um), Math.sin(vm)]);
        }
      }
    const t = fitTorus(pts, middles, normals, 25)!;
    expect(Math.abs(t.shape.minor - r)).toBeLessThan(0.01);
    expect(Math.abs(t.shape.major - R)).toBeLessThan(0.01);
    expect(t.maxError).toBeLessThan(0.01);
    expect(pts.every((p) => surfaceDistance(t.shape, p) < 0.01)).toBe(true);
  });
});

describe("tidying sizes", () => {
  it("snaps sizes to round numbers only when they're that close", () => {
    expect(snapNice(4.9998, 0.01)).toBe(5);
    expect(snapNice(2.4999, 0.001)).toBe(2.5);
    expect(snapNice(3.14159, 0.001)).toBe(3.142);
    expect(snapNice(3.14159, 0.0001)).toBe(3.14159);
    expect(snapNice(-12.0004, 0.001)).toBe(-12);
  });

  it("snaps directions to X, Y or Z", () => {
    expect(snapDirection(unit([0.0001, 0, -1]), 0.001)).toEqual([0, 0, -1]);
    const slanted = unit([1, 1, 0]);
    expect(snapDirection(slanted, 0.001)).toEqual(slanted);
  });

  it("tidies a fitted hole to its drawn size: Ø5 on the Z axis", () => {
    const t = tidySurface({ kind: "cylinder", origin: [10.0003, 14.9998, 7], axis: unit([0.00001, 0, 1]), radius: 2.49991 }, 0.01, 0.002);
    expect(t).toEqual({ kind: "cylinder", origin: [10, 15, 0], axis: [0, 0, 1], radius: 2.5 });
  });
});
