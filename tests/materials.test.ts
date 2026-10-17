import { describe, expect, it } from "vitest";

import { formatMass, massGrams, materialOf, parseMaterials } from "../src/model/materials";

describe("materials", () => {
  it("work out what a part weighs", () => {
    // A 10 cm³ part.
    expect(formatMass(massGrams(10_000, "pla"))).toBe("12.4 g");
    expect(formatMass(massGrams(10_000, "steel"))).toBe("78.5 g");
    expect(formatMass(massGrams(1_000_000, "aluminium"))).toBe("2.7 kg");
    // No material set: PLA.
    expect(materialOf(undefined).key).toBe("pla");
  });
  it("only keep materials JuraCAD knows when a file is opened", () => {
    expect(parseMaterials({ p1: "steel", p2: "unobtainium", p3: 5 })).toEqual({ p1: "steel" });
  });
});
