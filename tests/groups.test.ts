import { describe, expect, it } from "vitest";

import { parseAssemblies, removeInstances, updateAssembly } from "../src/assembly/assembly";
import type { Frame } from "../src/assembly/connectors";
import { planDrag } from "../src/assembly/drag";
import { groupOf, makeGroup, removeGroup, tidyGroups } from "../src/assembly/groups";
import { applyPlacement, IDENTITY, quatFromEulerDeg, type Placement, type Vec3 } from "../src/assembly/math";
import { solveAssembly } from "../src/assembly/mates";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, PartSmithDocument } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number, turn = 0): Placement => ({ position: [x, y, z], rotation: quatFromEulerDeg(0, 0, turn) });
const inst = (id: string, placement: Placement, fixed = false): Instance => ({ id, partId: `p_${id}`, name: id, placement, fixed });
const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
const frames = () => (_m: Mate, side: "a" | "b") => (side === "a" ? top : bottom);
const placements = (a: Assembly) => Object.fromEntries(a.instances.map((i) => [i.id, i.placement]));

describe("groups", () => {
  it("lock parts together where they are: moving the first moves the rest with it", () => {
    let asm: Assembly = { id: "a", name: "A", instances: [inst("a", at(0, 0, 0)), inst("b", at(30, 0, 0, 90)), inst("c", at(0, 50, 5))] };
    const made = makeGroup(asm, ["a", "b"], placements(asm), "g1");
    expect(made.error).toBe(undefined);
    asm = made.assembly;
    expect([asm.groups![0].name, asm.groups![0].members]).toEqual(["Group 1", ["a", "b"]]);
    // Where they were grouped, nothing moves.
    let r = solveAssembly(asm, frames());
    close(r.placements.b.position, [30, 0, 0]);
    expect(r.drivenBy.b).toBe("group:g1");
    // Move and turn a: b keeps its place beside it, turned with it.
    asm = { ...asm, instances: asm.instances.map((i) => (i.id === "a" ? { ...i, placement: at(10, 10, 0, 90) } : i)) };
    r = solveAssembly(asm, frames());
    close(r.placements.b.position, [10, 40, 0]);
    close(applyPlacement(r.placements.b, [1, 0, 0]), applyPlacement(at(10, 40, 0, 180), [1, 0, 0]));
    // c isn't grouped, so it stays put.
    close(r.placements.c.position, [0, 50, 5]);
  });

  it("a mate on one grouped part carries the whole group; fixed parts anchor it", () => {
    // base is fixed; b is fastened on top of base; a is grouped with b, 20 mm to its side.
    const asm0: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("base", IDENTITY, true), inst("a", at(20, 0, 0)), inst("b", at(0, 0, 0))],
      mates: [{ id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "base", pick }, b: { instanceId: "b", pick }, flip: false, values: {} }],
    };
    const asm = makeGroup(asm0, ["a", "b"], placements(asm0), "g").assembly;
    const r = solveAssembly(asm, frames());
    expect(r.mateErrors).toEqual({});
    expect(r.groupErrors).toBe(undefined);
    // b sits on base's top (z = 10, flipped over); a follows, still 20 mm from b.
    close(r.placements.b.position, [0, 0, 10]);
    const gap = r.placements.a.position.map((v, k) => v - r.placements.b.position[k]);
    expect(Math.hypot(...gap)).toBeCloseTo(20, 6);
    // The group is held by the mate to the fixed base, so dragging it is refused, saying why.
    const plan = planDrag(asm, r, frames(), "a", [20, 0, 10], [0, 0, -1]);
    expect("refuse" in plan ? plan.refuse : "").toMatch(/held in place/);
    // Without the mate, dragging b moves the group's first part (a).
    const free = { ...asm, mates: [] };
    const plan2 = planDrag(free, solveAssembly(free, frames()), frames(), "b", [0, 0, 0], [0, 0, -1]);
    const change = "plan" in plan2 ? plan2.plan.update({ origin: [5, 0, 10], dir: [0, 0, -1] }) : null;
    expect(change?.kind === "instance" && change.id).toBe("a");
  });

  it("refuses parts already grouped, needs two, and tidies up when parts are removed", () => {
    const asm0: Assembly = { id: "a", name: "A", instances: [inst("a", at(0, 0, 0)), inst("b", at(10, 0, 0)), inst("c", at(20, 0, 0))] };
    const one = makeGroup(asm0, ["a", "b"], placements(asm0), "g1").assembly;
    expect(makeGroup(one, ["a", "c"], placements(one), "g2").error).toMatch(/two or more/);
    expect(groupOf(one, "b")?.id).toBe("g1");
    // Removing the first part: the group carries on with the others, keeping their places.
    const three = makeGroup(asm0, ["a", "b", "c"], placements(asm0), "g").assembly;
    const gone = tidyGroups({ ...three, instances: three.instances.filter((i) => i.id !== "a") });
    expect(gone.groups![0].members).toEqual(["b", "c"]);
    close(gone.groups![0].offsets.c.position, [10, 0, 0]);
    // Down to one part: no group.
    let doc: PartSmithDocument = { ...emptyDocument(), assemblies: [{ ...one, id: "asm" }] };
    doc = removeInstances(doc, "asm", ["a"]);
    expect(doc.assemblies![0].groups).toBe(undefined);
    expect(removeGroup(one, "g1").groups).toBe(undefined);
  });

  it("are saved and read back", () => {
    const asm0: Assembly = { id: "asm", name: "A", instances: [inst("a", at(0, 0, 0)), inst("b", at(10, 0, 0, 45))] };
    const asm = makeGroup(asm0, ["a", "b"], placements(asm0), "g1").assembly;
    const doc = updateAssembly({ ...emptyDocument(), assemblies: [asm] }, "asm", (x) => x);
    const back = parseAssemblies(JSON.parse(JSON.stringify(doc.assemblies)))[0];
    expect(back.groups![0].members).toEqual(["a", "b"]);
    close(back.groups![0].offsets.b.position, [10, 0, 0]);
    // A group naming a part that isn't there is dropped.
    const bad = parseAssemblies(JSON.parse(JSON.stringify([{ ...asm, groups: [{ ...asm.groups![0], members: ["a", "zz"] }] }])))[0];
    expect(bad.groups).toBe(undefined);
  });
});
