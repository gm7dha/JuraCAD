import { describe, expect, it } from "vitest";

import { assemblyReport, DEFAULT_CLASH_OPTIONS, judgeContact, judgeContacts, parseClashOptions } from "../src/assembly/assemblyCheck";
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

  it("judges overlaps thinner than the tolerance, and small gaps, as touching", () => {
    // A 10 × 10 × 0.005 sliver: 2V/A ≈ 0.005 mm thick.
    const sliver = { a: "A", b: "B", volume: 0.5, area: 200.2 };
    expect(judgeContact(sliver, 0.01)).toEqual({ kind: "touch", a: "A", b: "B" });
    expect(judgeContact(sliver, 0.001)).toEqual({ kind: "overlap", a: "A", b: "B", volume: 0.5 });
    expect(judgeContact({ a: "A", b: "B", volume: 500, area: 400 }, 0.01)?.kind).toBe("overlap");
    expect(judgeContact({ a: "A", b: "B", volume: 0, area: 0, gap: 0.004 }, 0.01)?.kind).toBe("touch");
    expect(judgeContact({ a: "A", b: "B", volume: 0, area: 0, gap: 0.02 }, 0.01)).toBe(null);
    // Surfaces: through a solid when deeper than the tolerance; crossing when longer than it.
    expect(judgeContact({ a: "S", b: "B", surfaceA: true, area: 50, depth: 2.5 }, 0.01)).toEqual({ kind: "through", a: "S", b: "B", area: 50 });
    expect(judgeContact({ a: "S", b: "B", surfaceA: true, area: 50, depth: 0.005 }, 0.01)?.kind).toBe("touch");
    expect(judgeContact({ a: "S", b: "T", surfaceA: true, surfaceB: true, crossLength: 5 }, 0.01)).toEqual({ kind: "cross", a: "S", b: "T", length: 5 });
    expect(judgeContact({ a: "S", b: "T", surfaceA: true, surfaceB: true, crossLength: 0, gap: 0 }, 0.01)?.kind).toBe("touch");
    // Touching pairs are dropped unless asked for.
    const both = [sliver, { a: "C", b: "D", volume: 100, area: 130 }];
    expect(judgeContacts(both, DEFAULT_CLASH_OPTIONS).map((c) => c.kind)).toEqual(["overlap"]);
    expect(judgeContacts(both, { ...DEFAULT_CLASH_OPTIONS, ignoreTouching: false }).map((c) => c.kind)).toEqual(["touch", "overlap"]);
  });

  it("describes surfaces, touching parts and what was left out", () => {
    const r = assemblyReport(
      asm,
      solvedOk,
      { f1: "Base" },
      [
        { kind: "through", a: "Skin <1>", b: "Base <1>", area: 50 },
        { kind: "cross", a: "Skin <1>", b: "Skin <2>", length: 5 },
        { kind: "touch", a: "Base <1>", b: "Base <2>" },
      ],
      { ...DEFAULT_CLASH_OPTIONS, ignoreTouching: false },
      { hidden: 2 },
    );
    expect(r.headline).toBe("2 clashes found — some parts overlap.");
    expect(r.parts[1].findings.map((f) => [f.level, f.text])).toEqual([
      ["warn", "The surface Skin <1> goes through Base <1> (50 mm² of it is inside) — they'd be in each other's way."],
      ["warn", "The surfaces Skin <1> and Skin <2> cross each other (along 5 mm)."],
      ["ok", "Base <1> and Base <2> touch."],
      ["ok", "Not checked: 2 hidden parts."],
    ]);
    // Only touching: everything fits, and the tolerance is explained.
    const ok = assemblyReport(asm, solvedOk, { f1: "Base" }, [], DEFAULT_CLASH_OPTIONS);
    expect(ok.level).toBe("ok");
    expect(ok.parts[1].findings[1].text).toBe("Parts that only touch aren't listed (gaps and overlaps up to 0.01 mm count as touching).");
  });

  it("reads clash options safely", () => {
    expect(parseClashOptions(null)).toEqual(DEFAULT_CLASH_OPTIONS);
    expect(parseClashOptions({ ignoreTouching: false, tolerance: 0.2, skipHidden: true })).toEqual({ ignoreTouching: false, tolerance: 0.2, skipHidden: true });
    expect(parseClashOptions({ tolerance: -1 }).tolerance).toBe(0.01);
    expect(parseClashOptions({ tolerance: 99 }).tolerance).toBe(10);
    expect(parseClashOptions({ tolerance: "x", ignoreTouching: "no" })).toEqual(DEFAULT_CLASH_OPTIONS);
  });
});
