import { describe, expect, it } from "vitest";
import { densityFor, massIn, massRows, massSummary, printedGrams, rowsText, type PartMassProps } from "../src/model/massProps";
import { facesMadeBy, featureMatches, featureOfFace, matchingFeatures } from "../src/model/featureSearch";
import type { Feature } from "../src/model/types";

const box: PartMassProps = { partId: "a", name: "Part 1", volume: 6000, area: 2200, centre: [5, 10, 15], box: [[0, 0, 0], [10, 20, 30]] };
const far: PartMassProps = { partId: "b", name: "Part 2", volume: 1000, area: 600, centre: [105, 5, 5], box: [[100, 0, 0], [110, 10, 10]] };
const fmt = { length: (v: number) => `${Math.round(v * 100) / 100} mm`, area: (v: number) => `${v} mm²`, volume: (v: number) => `${v} mm³`, mass: (g: number) => `${Math.round(g * 100) / 100} g` };

describe("mass summary", () => {
  it("adds parts up and weights the centre by mass", () => {
    const s = massSummary([box, far], (id) => (id === "a" ? 1 : 6));
    expect(s.volume).toBe(7000);
    expect(s.area).toBe(2800);
    expect(s.mass).toBeCloseTo(6 + 6, 9);
    expect(s.centre![0]).toBeCloseTo((6 * 5 + 6 * 105) / 12, 9);
    expect(s.box).toEqual([[0, 0, 0], [110, 20, 30]]);
    expect(s.density).toBe(null);
  });

  it("one density: shown, and the centre is the volume's", () => {
    const s = massSummary([box], () => 1.24);
    expect(s.density).toBe(1.24);
    expect(s.centre).toEqual([5, 10, 15]);
    const rows = massRows(s, fmt);
    expect(rows.map((r) => r[0].trim())).toEqual(["Mass", "printed (about)", "Volume", "Surface area", "Density", "Centre of mass", "Size (X × Y × Z)"]);
    expect(rows.find((r) => r[0] === "Size (X × Y × Z)")![1]).toBe("10 mm × 20 mm × 30 mm");
    expect(rowsText("Mass properties", rows)).toMatch(/^Mass properties\nMass: 7\.44 g\nprinted \(about\): /);
  });

  it("surfaces have no mass, only an area and a centre", () => {
    const skin: PartMassProps = { ...far, volume: 0, surface: true };
    const s = massSummary([skin], () => 1.24);
    expect(s.mass).toBe(0);
    expect(s.centre).toEqual([105, 5, 5]);
    expect(massRows(s, fmt).map((r) => r[0])).not.toContain("Mass");
  });

  it("densities from each part's material, or one for all", () => {
    expect(densityFor({ kind: "own", materials: { a: "steel" } }, "a")).toBe(7.85);
    expect(densityFor({ kind: "own", materials: {} }, "a")).toBe(1.24);
    expect(densityFor({ kind: "all", density: 2.7 }, "a")).toBe(2.7);
  });

  it("a printed part weighs its walls plus 15% of the inside", () => {
    // 6000 mm³, skin 2200 × 0.84 = 1848 mm³ solid, the other 4152 at 15%.
    expect(printedGrams(6000, 2200, 1)).toBeCloseTo((1848 + 0.15 * 4152) / 1000, 9);
    // A thin plate is all wall.
    expect(printedGrams(100, 10000, 1)).toBeCloseTo(0.1, 9);
    expect(printedGrams(0, 10, 1)).toBe(0);
  });

  it("pounds and ounces for inch designs", () => {
    expect(massIn(453.59237, true, () => "")).toBe("1 lb");
    expect(massIn(28.349523125, true, () => "")).toBe("1 oz");
    expect(massIn(12, false, (g) => `${g} g`)).toBe("12 g");
  });
});

const f = (id: string, name: string, type: Feature["type"], folder?: string): Feature => ({ id, name, type, operation: "new", suppressed: false, params: {}, ...(folder ? { folder } : {}) });

describe("feature search", () => {
  const list = [f("s1", "Sketch 1", "sketch"), f("e1", "Base", "extrude"), f("h1", "Hole 1", "hole", "Holes"), f("fl", "Round the top", "fillet")];
  const label = (x: Feature) => ({ sketch: "Sketch", extrude: "Extrude", hole: "Hole", fillet: "Fillet" })[x.type as string] ?? "";

  it("matches names, kinds and folders, every word", () => {
    expect(matchingFeatures(list, "", label)).toBe(null);
    expect([...matchingFeatures(list, "extrude", label)!]).toEqual(["e1"]);
    expect([...matchingFeatures(list, "FILLET top", label)!]).toEqual(["fl"]);
    expect([...matchingFeatures(list, "holes", label)!]).toEqual(["h1"]);
    expect(matchingFeatures(list, "nothing here", label)!.size).toBe(0);
    expect(featureMatches(list[0], "  ", "Sketch")).toBe(true);
  });

  it("finds the feature that made a face, else the part's latest", () => {
    const part = { id: "p", featureIds: ["e1", "fl"], faceMakers: ["e1", "fl", "", "gone"] };
    expect(featureOfFace(part, 0, list)).toBe("e1");
    expect(featureOfFace(part, 1, list)).toBe("fl");
    expect(featureOfFace(part, 2, list)).toBe("fl");
    expect(featureOfFace(part, 3, list)).toBe("fl");
    expect(featureOfFace({ featureIds: [] }, 0, list)).toBe(null);
    expect(facesMadeBy([part], "fl")).toEqual(new Map([["p", [1]]]));
    expect(facesMadeBy([part], "s1")).toBe(null);
  });
});
