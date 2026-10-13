import { describe, expect, it } from "vitest";

import { angleBetween, centreGap, circleThrough3D } from "../src/geometry/measureMath";
import type { EdgeRef, FaceRef, Vec3 } from "../src/geometry/topoRef";

const line = (a: Vec3, b: Vec3): EdgeRef => ({ kind: "edge", curve: "LINE", a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
const plane = (normal: Vec3): FaceRef => ({ kind: "face", surface: "PLANE", center: [0, 0, 0], normal });

describe("measuring maths", () => {
  it("finds a circle's centre and radius from three points, tilted in 3D", () => {
    const r = 6.5;
    const pts = [0, 1.3, 2.9].map((t): Vec3 => [10 + r * Math.cos(t), 5, 3 + r * Math.sin(t)]);
    const c = circleThrough3D(pts[0], pts[1], pts[2])!;
    expect(c.radius).toBeCloseTo(6.5, 9);
    expect(c.centre[0]).toBeCloseTo(10, 9);
    expect(c.centre[1]).toBeCloseTo(5, 9);
    expect(c.centre[2]).toBeCloseTo(3, 9);
    expect(circleThrough3D([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
  });

  it("measures angles between edges and faces", () => {
    expect(angleBetween(line([0, 0, 0], [1, 0, 0]), line([0, 0, 0], [0, 5, 0]))).toBe(90);
    expect(angleBetween(line([0, 0, 0], [1, 0, 0]), line([3, 3, 0], [4, 4, 0]))).toBeCloseTo(45, 6);
    expect(angleBetween(plane([0, 0, 1]), plane([0, 0, -1]))).toBe(0);
    expect(angleBetween(plane([0, 0, 1]), plane([1, 0, 0]))).toBe(90);
    // A vertical edge stands at 90° to a flat floor.
    expect(angleBetween(line([0, 0, 0], [0, 0, 7]), plane([0, 0, 1]))).toBe(90);
    expect(angleBetween(plane([0, 0, 1]), { kind: "face", surface: "CYLINDRE", center: [0, 0, 0], normal: [1, 0, 0] })).toBeNull();
  });

  it("splits a centre-to-centre distance into X, Y and Z", () => {
    expect(centreGap([0, 0, 0], [30, -40, 0])).toEqual({ total: 50, dx: 30, dy: 40, dz: 0 });
  });
});
