import { describe, expect, it } from "vitest";

import { parseAssemblies, removeInstances, removeMate } from "../src/assembly/assembly";
import { IDENTITY } from "../src/assembly/math";
import { emptyDocument } from "../src/model/document";
import type { Vec3 } from "../src/assembly/math";
import { applyRelations, drivenValue, nextRelationName } from "../src/assembly/relations";
import type { Assembly, Mate, MateType } from "../src/model/types";

const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const mate = (id: string, type: MateType, values: Record<string, string> = {}): Mate => ({
  id,
  name: id,
  type,
  a: { instanceId: "base", pick },
  b: { instanceId: `i_${id}`, pick },
  flip: false,
  values,
});
const asm = (mates: Mate[], relations: Assembly["relations"]): Assembly => ({
  id: "a",
  name: "A",
  instances: [
    { id: "base", partId: "p", name: "base", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
    ...mates.map((m) => ({ id: `i_${m.id}`, partId: "p", name: m.id, placement: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] }, fixed: false })),
  ],
  mates,
  relations,
});

describe("mate relations", () => {
  it("works out the driven amounts", () => {
    expect(drivenValue("gear", 2, 30, false)).toBe(-60);
    expect(drivenValue("gear", 2, 30, true)).toBe(60);
    expect(drivenValue("rack", 10, 180, false)).toBeCloseTo(10 * Math.PI);
    expect(drivenValue("screw", 1.5, 720, false)).toBeCloseTo(3);
  });

  it("drives one mate from another", () => {
    const a = asm([mate("g1", "revolute", { angle: "45" }), mate("g2", "revolute"), mate("nut", "slider")], [
      { id: "r1", name: "Gear 1", kind: "gear", driver: "g1", driven: "g2", ratio: "0.5" },
      { id: "r2", name: "Screw 1", kind: "screw", driver: "g1", driven: "nut", ratio: "2" },
    ]);
    const r = applyRelations(a);
    expect(r.errors).toEqual({});
    const v = (id: string, key: string) => Number(r.assembly.mates!.find((m) => m.id === id)!.values[key]);
    expect(v("g2", "angle")).toBe(-22.5);
    expect(v("nut", "distance")).toBe(0.25);
    expect([...r.driven].sort()).toEqual(["g2:angle", "nut:distance"]);
  });

  it("explains mates that can't drive or be driven", () => {
    const a = asm([mate("f", "fastened"), mate("s", "slider"), mate("h", "revolute")], [
      { id: "r1", name: "Gear 1", kind: "gear", driver: "f", driven: "h", ratio: "1" },
      { id: "r2", name: "Gear 2", kind: "gear", driver: "h", driven: "s", ratio: "1" },
      { id: "r3", name: "Gear 3", kind: "gear", driver: "h", driven: "gone", ratio: "1" },
    ]);
    const r = applyRelations(a);
    expect(r.errors.r1).toMatch(/doesn't turn/);
    expect(r.errors.r2).toMatch(/doesn't turn/);
    expect(r.errors.r3).toMatch(/deleted/);
  });

  it("are saved and read back, dropping ones whose mates are gone", () => {
    const a = asm([mate("g1", "revolute"), mate("g2", "revolute")], [
      { id: "r1", name: "Gear 1", kind: "gear", driver: "g1", driven: "g2", ratio: "2", reverse: true },
      { id: "r2", name: "Gear 2", kind: "gear", driver: "g1", driven: "missing", ratio: "2" },
    ]);
    const [back] = parseAssemblies(JSON.parse(JSON.stringify([a])));
    expect(back.relations).toEqual([{ id: "r1", name: "Gear 1", kind: "gear", driver: "g1", driven: "g2", ratio: "2", reverse: true }]);
    expect(nextRelationName(back, "gear")).toBe("Gear 2");
  });

  it("go when a mate they link (or its part) is deleted", () => {
    const doc = { ...emptyDocument(), assemblies: [asm([mate("g1", "revolute"), mate("g2", "revolute"), mate("g3", "revolute")], [
      { id: "r1", name: "Gear 1", kind: "gear" as const, driver: "g1", driven: "g2", ratio: "2" },
      { id: "r2", name: "Gear 2", kind: "gear" as const, driver: "g1", driven: "g3", ratio: "3" },
    ])] };
    doc.assemblies[0].instances = [{ id: "base", partId: "p", name: "base", placement: IDENTITY, fixed: true }, ...["g1", "g2", "g3"].map((m) => ({ id: `i_${m}`, partId: "p", name: m, placement: IDENTITY, fixed: false }))];
    const noG2 = removeMate(doc, "a", "g2").assemblies![0];
    expect(noG2.relations?.map((r) => r.id)).toEqual(["r2"]);
    const noG1 = removeInstances(doc, "a", ["i_g1"]).assemblies![0];
    expect(noG1.relations).toBe(undefined);
  });
});
