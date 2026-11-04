/**
 * Recognising real faces in triangle meshes (pure: no OpenCascade), the
 * summary shown afterwards, and the setting kept in the file. The engine
 * side (building the solid) is in engineSimplify.test.ts.
 */
import { describe, expect, it } from "vitest";
import { MAX_TRIANGLES, NOTHING_TO_TIDY, planMesh, TOO_DETAILED, type MeshPlan } from "../src/geometry/meshSimplify";
import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { SIMPLIFY_TOLERANCES, simplifyReport } from "../src/model/simplify";
import { lumpyBall, washer } from "./support/meshShapes";

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

  it("doesn't try to tidy meshes that are too detailed, or where nothing fits", () => {
    // Over the limit: refused straight away, before looking at a single triangle.
    const big = lumpyBall(160, 240);
    expect(big.triangles.length / 3).toBeGreaterThan(MAX_TRIANGLES);
    expect(planMesh(big.vertices, big.triangles, SIMPLIFY_TOLERANCES.normal)).toBe(TOO_DETAILED);
    // An organic shape: it stops looking for round faces after a while, and there's nothing to gain.
    const blob = lumpyBall(48, 72);
    expect(planMesh(blob.vertices, blob.triangles, SIMPLIFY_TOLERANCES.normal)).toBe(NOTHING_TO_TIDY);
    // A budget of work (a count, the same on every machine) that runs out: also refused.
    expect(planMesh(blob.vertices, blob.triangles, SIMPLIFY_TOLERANCES.normal, { workLimit: 1000 })).toBe(TOO_DETAILED);
    // A real part is well within it.
    const m = washer();
    expect(typeof planMesh(m.vertices, m.triangles, SIMPLIFY_TOLERANCES.normal, { workLimit: 200_000 })).toBe("object");
  });

  it("keeps sizes that aren't round numbers (Ø5.06 stays Ø5.06)", () => {
    const m = washer(96, 0, 2.53);
    const plan = planMesh(m.vertices, m.triangles, SIMPLIFY_TOLERANCES.normal) as MeshPlan;
    const hole = plan.faces.find((f) => f.surface.kind === "cylinder" && f.concave)!;
    expect(hole.surface.kind === "cylinder" && Math.abs(hole.surface.radius - 2.53)).toBeLessThan(1e-3);
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
    expect(simplifyReport({ facesBefore: 100, faces: [{ kind: "plane" }, { kind: "plane", mesh: true }], recognised: true, gaveUp: 2 })).toMatch(/2 round shapes couldn't be rebuilt, so they're left as mesh\./);
  });

  it("says plainly when it changed nothing", () => {
    expect(simplifyReport({ facesBefore: 52_000, faces: [], recognised: false, tooDetailed: true })).toBe("52,000 faces: too detailed to tidy — brought in as it is.");
    expect(simplifyReport({ facesBefore: 12, faces: Array.from({ length: 12 }, () => ({ kind: "plane" as const })), recognised: false, unchanged: true })).toMatch(/nothing was changed/);
    expect(simplifyReport({ facesBefore: 0, faces: [], recognised: false, failed: true })).toMatch(/brought in as it is/);
    expect(simplifyReport({ facesBefore: 3, faces: Array.from({ length: 3 }, () => ({ kind: "plane" as const })), recognised: false, nothingFound: true })).toBe("3 faces: no flat areas or round shapes to tidy (an organic shape?) — brought in as it is.");
    // An open piece's faces are counted (not "→ 0 faces").
    expect(simplifyReport({ facesBefore: 385, faces: Array.from({ length: 385 }, () => ({ kind: "plane" as const, mesh: true })), recognised: false, openBodies: 1 })).toMatch(/^385 faces → 385 faces: 0 flat, 385 left as mesh\. One piece isn't closed/);
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
