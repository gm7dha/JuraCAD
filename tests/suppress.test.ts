import { describe, expect, it } from "vitest";

import { billOfMaterials, parseAssemblies, updateInstance } from "../src/assembly/assembly";
import { assemblyReport } from "../src/assembly/assemblyCheck";
import type { Frame } from "../src/assembly/connectors";
import { makeGroup } from "../src/assembly/groups";
import { IDENTITY, type Placement, type Vec3 } from "../src/assembly/math";
import { solveAssembly } from "../src/assembly/mates";
import { isSuppressed, mateInactive, setSuppressed, withoutSuppressed } from "../src/assembly/suppress";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, MateType } from "../src/model/types";

const at = (x: number, y: number, z: number): Placement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });
const inst = (id: string, placement: Placement = IDENTITY, fixed = false, partId = `p_${id}`): Instance => ({ id, partId, name: `${id} <1>`, placement, fixed });
const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const mate = (id: string, type: MateType, a: string, b: string): Mate => ({ id, name: id, type, a: { instanceId: a, pick }, b: { instanceId: b, pick }, flip: false, values: {} });
const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
const frames = (_m: Mate, side: "a" | "b") => (side === "a" ? top : bottom);

/** A fixed base with a lid fastened on top, and a knob fastened on the lid. */
const stack = (): Assembly => ({
  id: "asm",
  name: "A",
  instances: [inst("base", IDENTITY, true), inst("lid", at(50, 0, 0)), inst("knob", at(90, 0, 0))],
  mates: [mate("m1", "fastened", "base", "lid"), mate("m2", "fastened", "lid", "knob")],
  relations: [{ id: "r", name: "Gear 1", kind: "gear", driver: "m1", driven: "m2", ratio: "1" }],
});

describe("suppressed instances", () => {
  it("leave the solver: they stay put, their mates do nothing and report no error", () => {
    const asm = setSuppressed(stack(), ["lid"], true);
    expect(isSuppressed(asm, "lid")).toBe(true);
    const r = solveAssembly(asm, frames);
    // The lid stays where it was stored; nothing is placed by its mates.
    expect(r.placements.lid).toEqual(at(50, 0, 0));
    expect(r.drivenBy.lid).toBe(undefined);
    // The knob was held via the lid; now it's free and stays where it is.
    expect(r.placements.knob).toEqual(at(90, 0, 0));
    expect(r.drivenBy.knob).toBe(undefined);
    expect(r.mateErrors).toEqual({});
    expect(mateInactive(asm, asm.mates![0])).toBe("Not used while lid <1> is suppressed");
    expect(mateInactive(asm, asm.mates![1])).toBe("Not used while lid <1> is suppressed");
    // Back on: the mates place the lid and knob again.
    const on = setSuppressed(asm, ["lid"], false);
    expect(on.instances[1]).toEqual(stack().instances[1]);
    const r2 = solveAssembly(on, frames);
    expect(r2.placements.lid.position[2]).toBeCloseTo(10, 9);
    expect(r2.drivenBy.knob).toBe("m2");
    expect(mateInactive(on, on.mates![0])).toBe(null);
    expect(mateInactive(on, { ...on.mates![0], suppressed: true })).toBe("Suppressed — not used");
  });

  it("are taken out (with their mates, relations and group places) for the solver and checks", () => {
    const asm = setSuppressed(stack(), ["knob"], true);
    const active = withoutSuppressed(asm);
    expect(active.instances.map((i) => i.id)).toEqual(["base", "lid"]);
    expect(active.mates!.map((m) => m.id)).toEqual(["m1"]);
    expect(active.relations).toBe(undefined);
    // Nothing suppressed: the very same assembly.
    const plain = stack();
    expect(withoutSuppressed(plain)).toBe(plain);
    // A group's first part suppressed: the others keep their places relative to each other.
    const g0: Assembly = { id: "a", name: "A", instances: [inst("a", at(0, 0, 0)), inst("b", at(10, 0, 0)), inst("c", at(30, 0, 0))] };
    const grouped = makeGroup(g0, ["a", "b", "c"], Object.fromEntries(g0.instances.map((i) => [i.id, i.placement])), "g").assembly;
    const left = withoutSuppressed(setSuppressed(grouped, ["a"], true));
    expect(left.groups![0].members).toEqual(["b", "c"]);
    expect(left.groups![0].offsets.c.position[0]).toBeCloseTo(20, 9);
    // The saved group itself is untouched.
    expect(setSuppressed(grouped, ["a"], true).groups).toEqual(grouped.groups);
  });

  it("aren't in the parts list", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("b1", IDENTITY, true, "bolt"), inst("b2", IDENTITY, false, "bolt"), inst("n", IDENTITY, false, "nut")] };
    const names = { bolt: "Bolt", nut: "Nut" };
    expect(billOfMaterials(asm, names).map((r) => [r.name, r.quantity])).toEqual([["Bolt", 2], ["Nut", 1]]);
    const off = setSuppressed(asm, ["b2", "n"], true);
    expect(billOfMaterials(off, names).map((r) => [r.name, r.quantity])).toEqual([["Bolt", 1]]);
  });

  it("are saved and opened again; old files open unchanged", () => {
    const doc = { ...emptyDocument(), assemblies: [stack()] };
    const off = updateInstance(doc, "asm", "lid", { suppressed: true });
    const back = parseAssemblies(JSON.parse(JSON.stringify(off.assemblies)))[0];
    expect(back.instances.find((i) => i.id === "lid")!.suppressed).toBe(true);
    expect(back.instances.find((i) => i.id === "base")!.suppressed).toBe(undefined);
    // Unsuppressing removes the flag altogether (the file looks like it did before).
    const on = updateInstance(off, "asm", "lid", { suppressed: false });
    expect("suppressed" in on.assemblies![0].instances[1]).toBe(false);
    // A file saved before suppressing existed reads back exactly the same.
    const old = parseAssemblies(JSON.parse(JSON.stringify([stack()])))[0];
    expect(old).toEqual(stack());
    // Anything but true is ignored.
    const odd = parseAssemblies([{ ...stack(), instances: [{ ...stack().instances[0], suppressed: "yes" }] }])[0];
    expect(odd.instances[0].suppressed).toBe(undefined);
  });

  it("aren't counted by the check, and their mates aren't problems", () => {
    const asm = setSuppressed(stack(), ["knob"], true);
    // Even a mate error reported for an inactive mate isn't listed.
    const r = assemblyReport(asm, { placements: {}, mateErrors: { m2: "something" }, drivenBy: {} }, { p_base: "Base", p_lid: "Lid" }, [], undefined, { suppressed: 1 });
    expect(r.level).toBe("ok");
    expect(r.headline).toBe("Everything fits: 2 parts, no clashes.");
    expect(r.parts.find((p) => p.name === "Clashes")!.findings.map((f) => f.text)).toContain("Not checked: 1 suppressed part.");
  });
});
