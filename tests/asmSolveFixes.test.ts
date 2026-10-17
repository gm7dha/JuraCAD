/**
 * Loops of mates keep the amount you set, remember where they closed, and
 * relations work out in the right order (gear trains, linked sliders).
 */
import { describe, expect, it } from "vitest";

import { parseAssemblies, settleSolved } from "../src/assembly/assembly";
import type { Frame } from "../src/assembly/connectors";
import type { Vec3 } from "../src/assembly/math";
import { solveAssembly } from "../src/assembly/mates";
import { removePattern } from "../src/assembly/patterns";
import { applyRelations, canDrive, drivenValue, RELATION_KIND_NAMES } from "../src/assembly/relations";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, MateType, PartSmithDocument } from "../src/model/types";

const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const inst = (id: string, fixed = false): Instance => ({ id, partId: "p", name: id, placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed });
const mate = (id: string, type: MateType, a: string, b: string, values: Record<string, string> = {}, extra: Partial<Mate> = {}): Mate => ({
  id,
  name: id,
  type,
  a: { instanceId: a, pick },
  b: { instanceId: b, pick },
  flip: true,
  values,
  ...extra,
});

/**
 * A four-bar linkage on the ground G: crank C (10 long, hinged at the origin),
 * coupler L (30), rocker R (25, hinged to the ground 30 along X).
 */
const at = (x: number): Frame => ({ origin: [x, 0, 0], z: [0, 0, 1], x: [1, 0, 0] });
const fourBarFrames: Record<string, [Frame, Frame]> = { m1: [at(0), at(0)], m2: [at(10), at(0)], m3: [at(30), at(0)], m4: [at(25), at(30)] };
const fourBarLookup = (m: Mate, side: "a" | "b") => fourBarFrames[m.id]?.[side === "a" ? 0 : 1] ?? null;
function fourBar(crank: string, others: Record<string, string> = {}): Assembly {
  return {
    id: "A",
    name: "A",
    instances: [inst("G", true), inst("C"), inst("L"), inst("R")],
    mates: [
      mate("m1", "revolute", "G", "C", { angle: crank }),
      mate("m2", "revolute", "C", "L", { angle: others.m2 ?? "0" }),
      mate("m3", "revolute", "L", "R", { angle: others.m3 ?? "0" }),
      mate("m4", "revolute", "R", "G", { angle: others.m4 ?? "0" }),
    ],
  };
}

describe("closing a loop keeps the mate you set", () => {
  it("leaves a typed or dragged crank angle alone and moves the rest of the linkage", () => {
    for (const crank of [30, 90, 150]) {
      const r = solveAssembly(fourBar(String(crank)), fourBarLookup, { hold: ["m1"] });
      expect(r.mateErrors).toEqual({});
      // The coupler starts at the crank's tip: 10 mm out at the crank's angle.
      const rad = (crank * Math.PI) / 180;
      expect(r.placements.L.position[0]).toBeCloseTo(10 * Math.cos(rad), 5);
      expect(r.placements.L.position[1]).toBeCloseTo(10 * Math.sin(rad), 5);
      expect(r.adjusted?.m1).toBeUndefined();
    }
  });

  it("still moves a held mate when the loop can't close any other way", () => {
    // Fastened at 90° and hinged at 0° between the same two parts: only the held hinge can give.
    const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
    const asm: Assembly = { id: "A", name: "A", instances: [inst("a", true), inst("b")], mates: [mate("f", "fastened", "a", "b", { angle: "90" }), mate("h", "revolute", "a", "b")] };
    const r = solveAssembly(asm, () => top, { hold: ["h"] });
    expect(r.mateErrors).toEqual({});
    expect((((r.adjusted?.h.angle ?? 0) % 360) + 360) % 360).toBeCloseTo(90, 3);
  });

  it("says which limit stops a loop closing", () => {
    const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [inst("a", true), inst("b")],
      mates: [mate("f", "fastened", "a", "b", { angle: "90" }), mate("h", "revolute", "a", "b", {}, { name: "Hinge 1", limits: { angle: { min: "-30", max: "30" } } })],
    };
    const r = solveAssembly(asm, () => top);
    const msg = Object.values(r.mateErrors).join(" ");
    expect(msg).toContain("Hinge 1 (Angle) has reached its limit");
  });

  it("remembers where the loop closed, so the next solve starts there", () => {
    const solved = solveAssembly(fourBar("60"), fourBarLookup, { hold: ["m1"] });
    let doc: PartSmithDocument = { ...emptyDocument(), assemblies: [fourBar("60", { m3: "#rocker" })] };
    doc = settleSolved(doc, "A", solved);
    const mates = doc.assemblies![0].mates!;
    const value = (id: string) => mates.find((m) => m.id === id)!.values.angle;
    expect(value("m1")).toBe("60");
    expect(Number(value("m2"))).toBeCloseTo(solved.adjusted!.m2.angle, 5);
    expect(Number(value("m4"))).toBeCloseTo(solved.adjusted!.m4.angle, 5);
    // A variable stays a variable.
    expect(value("m3")).toBe("#rocker");
    // Solving again from the stored amounts changes nothing.
    const again = solveAssembly({ ...fourBar("60"), mates: fourBar("60").mates!.map((m) => ({ ...m, values: { angle: m.id === "m3" ? String(solved.adjusted!.m3.angle) : value(m.id) } })) }, fourBarLookup);
    expect(Object.keys(again.adjusted ?? {})).toEqual([]);
    expect(again.placements.R.position[0]).toBeCloseTo(solved.placements.R.position[0], 4);
    expect(again.placements.R.position[1]).toBeCloseTo(solved.placements.R.position[1], 4);
  });
});

describe("relations", () => {
  const train = (order: "forwards" | "backwards"): Assembly => {
    const r1 = { id: "r1", name: "Gear 1", kind: "gear" as const, driver: "m1", driven: "m2", ratio: "2" };
    const r2 = { id: "r2", name: "Gear 2", kind: "gear" as const, driver: "m2", driven: "m3", ratio: "0.5" };
    return {
      id: "A",
      name: "A",
      instances: [inst("g", true), inst("x"), inst("y"), inst("z")],
      mates: [mate("m1", "revolute", "g", "x", { angle: "10" }), mate("m2", "revolute", "g", "y"), mate("m3", "revolute", "g", "z")],
      relations: order === "forwards" ? [r1, r2] : [r2, r1],
    };
  };

  it("drives a gear train whatever order the relations were made in", () => {
    for (const order of ["forwards", "backwards"] as const) {
      const r = applyRelations(train(order));
      expect(r.errors).toEqual({});
      const angle = (id: string) => Number(r.assembly.mates!.find((m) => m.id === id)!.values.angle);
      expect(angle("m2")).toBe(-20);
      expect(angle("m3")).toBe(10);
    }
  });

  it("explains relations that drive each other round in a circle", () => {
    const a = train("forwards");
    const r = applyRelations({ ...a, relations: [...a.relations!, { id: "r3", name: "Gear 3", kind: "gear", driver: "m3", driven: "m1", ratio: "1" }] });
    expect(r.errors.r1).toContain("in a circle");
    expect(r.errors.r3).toContain("in a circle");
  });

  it("links two sliders with a Linear relation", () => {
    expect(RELATION_KIND_NAMES).toContain("linear");
    expect(drivenValue("linear", 2, 5, false)).toBe(10);
    expect(drivenValue("linear", 2, 5, true)).toBe(-10);
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [inst("g", true), inst("x"), inst("y")],
      mates: [mate("s1", "slider", "g", "x", { distance: "4" }), mate("s2", "slider", "g", "y"), mate("h", "revolute", "g", "x")],
      relations: [{ id: "r", name: "Linear 1", kind: "linear", driver: "s1", driven: "s2", ratio: "3" }],
    };
    const r = applyRelations(asm);
    expect(r.errors).toEqual({});
    expect(r.assembly.mates!.find((m) => m.id === "s2")!.values.distance).toBe("12");
    expect(canDrive(asm.mates![0], "linear")).toBe(true);
    expect(canDrive(asm.mates![2], "linear")).toBe(false);
    const bad = applyRelations({ ...asm, relations: [{ id: "r", name: "Linear 1", kind: "linear", driver: "h", driven: "s2", ratio: "3" }] });
    expect(bad.errors.r).toContain("doesn't slide");
    // Saved and read back.
    const back = parseAssemblies(JSON.parse(JSON.stringify([asm])));
    expect(back[0].relations?.[0].kind).toBe("linear");
  });

  it("drops relations on mates of pattern copies when the pattern goes", () => {
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [inst("g", true), inst("x"), { ...inst("x2"), copyOf: { pattern: "p", seed: "x", index: 1 } }],
      patterns: [{ id: "p", name: "Pattern 1", kind: "linear", seeds: ["x"], count: 2, amount: "20", axis: "x" }],
      mates: [mate("h1", "revolute", "g", "x"), mate("h2", "revolute", "g", "x2")],
      relations: [{ id: "r", name: "Gear 1", kind: "gear", driver: "h1", driven: "h2", ratio: "1" }],
    };
    const out = removePattern(asm, "p");
    expect(out.instances.map((i) => i.id)).toEqual(["g", "x"]);
    expect(out.mates?.map((m) => m.id)).toEqual(["h1"]);
    expect(out.relations).toBeUndefined();
  });
});
