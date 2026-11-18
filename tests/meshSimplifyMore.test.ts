/**
 * Simplify's newer shapes (pure: no OpenCascade): slanted holes (a plane across a cylinder at a slant meets it
 * in an ellipse), round faces crossing each other (a T of two bars, a hole through a hole — curves on both
 * surfaces), and fillets that go only part way round a corner (part of a torus). Meshes made in code, in
 * tests/support/meshShapes.ts; the OpenCascade side is in engineSimplifyMore.test.ts.
 */
import { describe, expect, it } from "vitest";
import { meetEllipse, planMesh, type MeshPlan, type PlanCurve } from "../src/geometry/meshSimplify";
import { dist, ellipseParam, ellipsePoint, fitTorus, ontoBoth, projectOnEllipse, surfaceDistance, type CylinderSurface, type FitSurface, type PlaneSurface, type Vec3 } from "../src/geometry/shapeFit";
import { SIMPLIFY_TOLERANCES, simplifyReport } from "../src/model/simplify";
import { pipeTee, roundedPlate, slantedHolePlate, washer } from "./support/meshShapes";

const tol = SIMPLIFY_TOLERANCES.normal;
const kinds = (p: MeshPlan) => p.faces.map((f) => f.surface.kind).sort();
const curveKinds = (p: MeshPlan) => p.curves.map((c) => c.kind).sort();
const plan = (m: { vertices: number[]; triangles: number[] }) => {
  const r = planMesh(m.vertices, m.triangles, tol);
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("ellipses and crossing curves (the maths)", () => {
  it("works out a slanted cut's ellipse exactly, and finds points on it", () => {
    const cyl: CylinderSurface = { kind: "cylinder", origin: [0, 0, 3], axis: [0, 0.5, Math.sqrt(3) / 2], radius: 3 };
    const top: PlaneSurface = { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 6] };
    const e = meetEllipse(cyl, top, (2 * Math.PI) / 180)!;
    expect(e.minor).toBeCloseTo(3, 12);
    expect(e.major).toBeCloseTo(3 / Math.cos(Math.PI / 6), 12);
    // Every point of it lies on both surfaces.
    for (let t = 0; t < 2 * Math.PI; t += 0.3) {
      const p = ellipsePoint(e, t);
      expect(surfaceDistance(cyl, p)).toBeLessThan(1e-12);
      expect(surfaceDistance(top, p)).toBeLessThan(1e-12);
      expect(ellipseParam(e, p)).toBeCloseTo(((t + Math.PI) % (2 * Math.PI)) - Math.PI, 9);
    }
    // A point near it goes to the nearest point on it.
    const q = projectOnEllipse(e, [1, 4, 6.2]);
    expect(surfaceDistance(cyl, q)).toBeLessThan(1e-9);
    // Square to the axis it's a circle (left to the circle code), and along it there's no ellipse.
    expect(meetEllipse({ ...cyl, axis: [0, 0, 1] }, top, (2 * Math.PI) / 180)).toBeNull();
    expect(meetEllipse({ ...cyl, axis: [1, 0, 0] }, top, (2 * Math.PI) / 180)).toBeNull();
  });

  it("puts points exactly where two round surfaces cross, and refuses where they only touch", () => {
    const bar: CylinderSurface = { kind: "cylinder", origin: [0, 0, 0], axis: [1, 0, 0], radius: 5 };
    const pin: CylinderSurface = { kind: "cylinder", origin: [0, 0, 0], axis: [0, 0, 1], radius: 3 };
    const p = ontoBoth([2.95, 0.5, 4.95], bar, pin)!;
    expect(surfaceDistance(bar, p)).toBeLessThan(1e-9);
    expect(surfaceDistance(pin, p)).toBeLessThan(1e-9);
    expect(dist(p, [2.95, 0.5, 4.95])).toBeLessThan(0.2);
    // Two bars of the same size touch side by side at the saddle's sides: no clean crossing there.
    const same: CylinderSurface = { ...pin, radius: 5 };
    expect(ontoBoth([0, 5, 0.01], bar, same)).toBeNull();
  });

  it("fits a torus exactly from a few facets (polished on the points)", () => {
    // A torus of major radius 6 and tube 1 round (1, 2, 3), axis Z.
    const pts: Vec3[] = [];
    const middles: Vec3[] = [];
    const normals: Vec3[] = [];
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 4; j++) {
        // A quarter of the tube, a third of the way round.
        const a = (i / 12) * (2 * Math.PI) / 3;
        const b = (j / 4) * (Math.PI / 2);
        const n: Vec3 = [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
        const p: Vec3 = [1 + (6 + Math.cos(b)) * Math.cos(a), 2 + (6 + Math.cos(b)) * Math.sin(a), 3 + Math.sin(b)];
        pts.push(p);
        // Facets' middles sit a little inside the surface.
        middles.push([p[0] - 0.01 * n[0], p[1] - 0.01 * n[1], p[2] - 0.01 * n[2]]);
        normals.push(n);
      }
    const fit = fitTorus(pts, middles, normals, 20)!;
    expect(fit.maxError).toBeLessThan(1e-6);
    expect(fit.shape.minor).toBeCloseTo(1, 5);
    expect(fit.shape.major).toBeCloseTo(6, 5);
  });
});

/** The plan's curve where two of its faces of these kinds meet. */
const between = (p: MeshPlan, a: FitSurface["kind"], b: FitSurface["kind"]): PlanCurve[] => {
  const out: PlanCurve[] = [];
  p.curves.forEach((c, i) => {
    const on = p.faces.filter((f) => f.loops.some((l) => l.some((u) => u.curve === i))).map((f) => f.surface.kind).sort();
    if (on.join() === [a, b].sort().join()) out.push(c);
  });
  return out;
};

describe("recognising the newer shapes in a mesh", () => {
  it("rebuilds a slanted hole with exact ellipses round both ends", () => {
    const p = plan(slantedHolePlate());
    expect(kinds(p)).toEqual(["cylinder", "plane", "plane", "plane", "plane", "plane", "plane"]);
    const hole = p.faces.find((f) => f.surface.kind === "cylinder")!;
    expect(hole.full).toBe(true);
    expect(hole.concave).toBe(true);
    expect(hole.surface.kind === "cylinder" && hole.surface.radius).toBeCloseTo(3, 3);
    const rims = p.curves.filter((c) => c.kind === "ellipse");
    expect(rims).toHaveLength(2);
    for (const e of rims) {
      if (e.kind !== "ellipse") continue;
      expect(e.full).toBe(true);
      expect(e.minor).toBeCloseTo(3, 3);
      expect(e.major).toBeCloseTo(3 / Math.cos(Math.PI / 6), 3);
    }
    expect(p.gaveUp).toBe(0);
  });

  it("rebuilds a T of two round bars, with the curve where they meet lying on both", () => {
    for (const shift of [0, 1.5]) {
      const p = plan(pipeTee(shift));
      expect(kinds(p)).toEqual(["cylinder", "cylinder", "plane", "plane", "plane"]);
      const meet = between(p, "cylinder", "cylinder");
      expect(meet).toHaveLength(1);
      const c = meet[0];
      expect(c.kind).toBe("spline");
      if (c.kind !== "spline") continue;
      expect(c.closed).toBe(true);
      const [a, b] = p.faces.filter((f) => f.surface.kind === "cylinder").map((f) => f.surface);
      for (const q of c.points) {
        expect(surfaceDistance(a, q)).toBeLessThan(1e-7);
        expect(surfaceDistance(b, q)).toBeLessThan(1e-7);
      }
      // More points than the mesh had, so a spline through them stays on both.
      expect(c.points.length).toBeGreaterThan(100);
      expect(p.faces.every((f) => !f.mesh)).toBe(true);
    }
  });

  it("rebuilds a hole crossing a hole (the T as a hollow)", () => {
    const p = plan(pipeTee(0, 48, true));
    expect(kinds(p)).toEqual(["cylinder", "cylinder", "plane", "plane", "plane"]);
    expect(p.faces.filter((f) => f.surface.kind === "cylinder").every((f) => f.concave)).toBe(true);
    expect(between(p, "cylinder", "cylinder").map((c) => c.kind)).toEqual(["spline"]);
  });

  it("rebuilds fillets that go only part way round a corner (parts of a torus)", () => {
    const p = plan(roundedPlate());
    // 4 straight roundings + 4 corner rings on top, 4 flat sides + 4 round corners, top and bottom.
    expect(kinds(p).filter((k) => k === "torus")).toHaveLength(4);
    expect(kinds(p).filter((k) => k === "cylinder")).toHaveLength(8);
    expect(kinds(p).filter((k) => k === "plane")).toHaveLength(6);
    for (const f of p.faces) {
      if (f.surface.kind === "torus") {
        expect(f.surface.minor).toBeCloseTo(1.5, 3);
        expect(f.surface.major).toBeCloseTo(3.5, 3);
        expect(f.full).toBe(false);
      }
      if (f.surface.kind === "cylinder") expect([1.5, 5]).toContain(Number(f.surface.radius.toFixed(3)));
    }
    // Where a straight rounding runs into a corner's: the tube's own circle.
    expect(between(p, "cylinder", "torus").filter((c) => c.kind === "arc").length).toBeGreaterThanOrEqual(8);
    expect(p.faces.every((f) => !f.mesh)).toBe(true);
  });

  it("still plans what it planned before the same way", () => {
    const p = plan(washer());
    expect(kinds(p)).toEqual(["cylinder", "cylinder", "plane", "plane"]);
    expect(curveKinds(p)).toEqual(["arc", "arc", "arc", "arc"]);
  });
});

describe("the summary names the new kinds", () => {
  it("says slanted holes and where round faces meet", () => {
    const text = simplifyReport({
      facesBefore: 886,
      recognised: true,
      faces: [
        ...Array.from({ length: 6 }, () => ({ kind: "plane" as const })),
        { kind: "cylinder", radius: 4, full: true, concave: true, meets: 2 },
        { kind: "cylinder", radius: 3, full: true, concave: true, meets: 1 },
        { kind: "cylinder", radius: 3, full: true, concave: true, meets: 1 },
        { kind: "cylinder", radius: 2.5, full: true, concave: true, slanted: true },
      ],
    });
    expect(text).toBe("886 faces → 10 faces: 6 flat, 4 round (holes Ø6, Ø8, slanted hole Ø5, 2 curved edges where round faces meet).");
  });
});
