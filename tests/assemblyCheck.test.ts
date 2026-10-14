import { describe, expect, it } from "vitest";

import { assemblyReport } from "../src/assembly/assemblyCheck";
import type { Assembly } from "../src/model/types";

const pick = { partId: "f1", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] } };
const asm: Assembly = {
  id: "a",
  name: "A",
  instances: [
    { id: "i1", partId: "f1", name: "Base <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
    { id: "i2", partId: "f1", name: "Base <2>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false },
  ],
  mates: [{ id: "m1", name: "Hinge 1", type: "revolute", a: { instanceId: "i1", pick }, b: { instanceId: "i2", pick }, flip: false, values: {} }],
};
const solvedOk = { placements: {}, mateErrors: {}, drivenBy: {} };

describe("assembly check", () => {
  it("says when everything fits", () => {
    const r = assemblyReport(asm, solvedOk, { f1: "Base" }, []);
    expect(r.level).toBe("ok");
    expect(r.headline).toBe("Everything fits: 2 parts, no clashes.");
    expect(r.parts.map((p) => p.name)).toEqual(["Mates", "Clashes"]);
  });

  it("warns about clashes", () => {
    const r = assemblyReport(asm, solvedOk, { f1: "Base" }, [{ a: "Base <1>", b: "Base <2>", volume: 2500 }]);
    expect(r.level).toBe("warn");
    expect(r.headline).toBe("1 clash found — some parts overlap.");
    expect(r.parts[1].findings[0].text).toBe("Base <1> and Base <2> overlap by 2.5 cm³ — they'd be in each other's way.");
  });

  it("lists broken mates and missing parts as problems", () => {
    const r = assemblyReport(asm, { ...solvedOk, mateErrors: { m1: "Both parts are fixed." } }, {}, [{ a: "x", b: "y", volume: 0.5 }]);
    expect(r.level).toBe("error");
    expect(r.headline).toBe("3 problems to fix, and 1 clash.");
    expect(r.parts[0].name).toBe("Missing parts");
    expect(r.parts[1].findings[0].text).toBe("Hinge 1: Both parts are fixed.");
    expect(r.parts[2].findings[0].text).toContain("0.5 mm³");
  });
});
