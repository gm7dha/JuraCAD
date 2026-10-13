import { describe, expect, it } from "vitest";

import type { MeshAnalysis } from "../src/geometry/meshCheck";
import type { PartCheck } from "../src/kernel/protocol";
import { buildCheckReport } from "../src/model/checkReport";

const goodMesh: MeshAnalysis = {
  triangleCount: 12,
  vertexCount: 8,
  openEdges: 0,
  nonManifoldEdges: 0,
  flippedEdges: 0,
  degenerateTriangles: 0,
  pieces: 1,
  volume: 24000,
  area: 5200,
  bounds: { min: [0, 0, 0], max: [40, 30, 20] },
  watertight: true,
};

const part = (overrides: Partial<PartCheck> = {}, mesh: Partial<MeshAnalysis> = {}): PartCheck => ({
  partId: "p1",
  name: "Part 1",
  geometryValid: true,
  exactVolume: 24000,
  mesh: { ...goodMesh, ...mesh },
  thinnest: null,
  ...overrides,
});

describe("check report", () => {
  it("says a good part is ready to export", () => {
    const r = buildCheckReport({ parts: [part()] }, 0);
    expect(r.level).toBe("ok");
    expect(r.headline).toBe("Ready to export.");
    expect(r.parts[0].size).toBe("40 × 30 × 20 mm");
    expect(r.parts[0].volume).toBe("24 cm³");
  });

  it("explains holes in plain English", () => {
    const r = buildCheckReport({ parts: [part({}, { watertight: false, openEdges: 3 })] }, 0);
    expect(r.level).toBe("error");
    expect(r.parts[0].findings.map((f) => f.text)).toContain("Has 3 gaps in its surface");
  });

  it("warns about separate pieces, thin parts and failed features", () => {
    const pieces = buildCheckReport({ parts: [part({}, { pieces: 2 })] }, 0);
    expect(pieces.level).toBe("warn");
    expect(pieces.parts[0].findings.some((f) => f.text.includes("2 separate pieces"))).toBe(true);

    const thin = buildCheckReport({ parts: [part({}, { bounds: { min: [0, 0, 0], max: [40, 30, 0.2] } })] }, 0);
    expect(thin.level).toBe("warn");

    const failed = buildCheckReport({ parts: [part()] }, 1);
    expect(failed.level).toBe("warn");
    expect(failed.headline).toMatch(/1 feature couldn't be built/);
  });

  it("handles an empty model", () => {
    const r = buildCheckReport({ parts: [] }, 0);
    expect(r.level).toBe("error");
    expect(r.headline).toMatch(/nothing to check/);
  });

  it("reports the thinnest wall, warning when it's very thin", () => {
    const ok = buildCheckReport({ parts: [part({ thinnest: { thickness: 2, at: [1, 2, 3] } })] }, 0);
    expect(ok.parts[0].findings.map((f) => f.text)).toContain("Thinnest wall is about 2 mm");
    expect(ok.level).toBe("ok");
    const thin = buildCheckReport({ parts: [part({ thinnest: { thickness: 0.3, at: [1, 2, 3] } })] }, 0);
    expect(thin.level).toBe("warn");
    expect(thin.parts[0].findings.some((f) => /about 0\.3 mm thick \(near 1, 2, 3\)/.test(f.text))).toBe(true);
  });

  it("warns about separate parts that overlap", () => {
    const r = buildCheckReport(
      { parts: [part(), part({ partId: "p2", name: "Part 2" })], overlaps: [{ a: "Part 1", b: "Part 2", volume: 1500 }] },
      0,
    );
    expect(r.level).toBe("warn");
    expect(r.parts[0].findings.some((f) => /Overlaps Part 2 by about 1.5 cm³/.test(f.text))).toBe(true);
    expect(r.parts[1].findings.some((f) => /Overlaps Part 1/.test(f.text))).toBe(true);
  });
});
