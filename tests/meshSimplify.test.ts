/**
 * Recognising real faces in triangle meshes (pure: no OpenCascade), the
 * summary shown afterwards, and the setting kept in the file. The engine
 * side (building the solid) is in engineSimplify.test.ts.
 */
import { describe, expect, it } from "vitest";
import { planMesh, type MeshPlan } from "../src/geometry/meshSimplify";
import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { SIMPLIFY_TOLERANCES, simplifyReport } from "../src/model/simplify";
import { washer } from "./support/meshShapes";

const kinds = (p: MeshPlan) => p.faces.map((f) => f.surface.kind).sort();

describe("recognising faces in a mesh", () => {
  it("finds a washer's two flat faces, its outside and its hole", () => {
    const m = washer();
    const plan = planMesh(m.vertices, m.triangles, SIMPLIFY_TOLERANCES.normal) as MeshPlan;
    expect(typeof plan).toBe("object");
    expect(kinds(plan)).toEqual(["cylinder", "cylinder", "plane", "plane"]);
    const round = plan.faces.filter((f) => f.surface.kind === "cylinder");
    const radii = round.map((f) => (f.surface.kind === "cylinder" ? f.surface.radius : 0)).sort((a, b) => a - b);
    expect(radii).toEqual([4, 10]);
    expect(round.every((f) => f.full)).toBe(true);
    expect(round.find((f) => f.surface.kind === "cylinder" && f.surface.radius === 4)!.concave).toBe(true);
    expect(round.find((f) => f.surface.kind === "cylinder" && f.surface.radius === 10)!.concave).toBe(false);
    // Each round face is bounded by two whole circles; the flat faces by a circle each side.
    expect(plan.curves.filter((c) => c.kind === "arc" && c.full)).toHaveLength(4);
    expect(plan.volume).toBeGreaterThan(Math.PI * (100 - 16) * 3 * 0.99);
  });

  it("still finds them with a little noise, but not with more than the tolerance", () => {
    const noisy = washer(48, 0.004);
    const plan = planMesh(noisy.vertices, noisy.triangles, SIMPLIFY_TOLERANCES.normal) as MeshPlan;
    expect(kinds(plan)).toEqual(["cylinder", "cylinder", "plane", "plane"]);
    const rough = washer(48, 0.2);
    const fine = planMesh(rough.vertices, rough.triangles, SIMPLIFY_TOLERANCES.fine) as MeshPlan;
    expect(fine.faces.filter((f) => f.surface.kind === "cylinder")).toHaveLength(0);
    expect(fine.faces.some((f) => f.mesh)).toBe(true);
  });

  it("doesn't take a hexagonal prism for a cylinder", () => {
    const hex = washer(6);
    const plan = planMesh(hex.vertices, hex.triangles, SIMPLIFY_TOLERANCES.normal) as MeshPlan;
    expect(plan.faces.filter((f) => f.surface.kind !== "plane")).toHaveLength(0);
    expect(plan.faces).toHaveLength(14);
  });

  it("gives a reason for an open mesh", () => {
    const m = washer();
    const open = planMesh(m.vertices, m.triangles.slice(0, -3), SIMPLIFY_TOLERANCES.normal);
    expect(open).toMatch(/isn't closed/);
  });
});

describe("the summary", () => {
  it("counts flat and round faces and names hole and fillet sizes", () => {
    const text = simplifyReport({
      facesBefore: 4812,
      recognised: true,
      faces: [
        ...Array.from({ length: 22 }, () => ({ kind: "plane" as const })),
        { kind: "cylinder", radius: 2.5, full: true, concave: true },
        { kind: "cylinder", radius: 4, full: true, concave: true },
        { kind: "cylinder", radius: 2.5, full: true, concave: true },
        ...Array.from({ length: 9 }, () => ({ kind: "cylinder" as const, radius: 2, full: false })),
        { kind: "torus", radius: 1.5, full: true },
        ...Array.from({ length: 4 }, () => ({ kind: "plane" as const, mesh: true })),
      ],
    });
    expect(text).toBe("4,812 faces → 39 faces: 22 flat, 13 round (holes Ø5, Ø8, fillets R1.5, R2), 4 left as mesh.");
  });

  it("says when round shapes couldn't be rebuilt", () => {
    expect(simplifyReport({ facesBefore: 100, faces: [{ kind: "plane" }], recognised: false, fellBack: true })).toMatch(/only flat areas were joined/);
  });
});

describe("in the file", () => {
  it("keeps Simplify's settings, and old imports come in as they were", () => {
    const doc = emptyDocument();
    const imp = { ...createFeature(doc, "import"), import: { fileName: "a.stl", format: "stl" as const, data: "AAAA", units: "mm" as const }, simplify: "coarse" as const };
    const plain = { ...createFeature(doc, "import"), id: "plain", import: { fileName: "b.stl", format: "stl" as const, data: "AAAA", units: "mm" as const } };
    const simplify = { ...createFeature(doc, "simplify"), id: "s1", simplifyParts: [imp.id], simplify: "fine" as const };
    const back = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [imp, plain, simplify] })));
    const [a, b, c] = back!.features;
    expect(a.simplify).toBe("coarse");
    expect(b.simplify).toBeUndefined();
    expect(c.type).toBe("simplify");
    expect(c.simplifyParts).toEqual([imp.id]);
    expect(c.simplify).toBe("fine");
  });
});
