import { describe, expect, it } from "vitest";

import { parseAssemblies, removeInstances } from "../src/assembly/assembly";
import type { Frame } from "../src/assembly/connectors";
import { IDENTITY, type Placement, type Vec3 } from "../src/assembly/math";
import { solveAssembly } from "../src/assembly/mates";
import { patternStep, placeCopy, removePattern, syncPattern } from "../src/assembly/patterns";
import { emptyDocument } from "../src/model/document";
import type { Assembly, AssemblyPattern, Instance, Mate } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number): Placement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });
const inst = (id: string, fixed = false, placement: Placement = IDENTITY): Instance => ({ id, partId: `p_${id}`, name: `${id} <1>`, placement, fixed });
let n = 0;
const ids = () => `c${++n}`;

const linear = (over: Partial<AssemblyPattern> = {}): AssemblyPattern => ({ id: "pt", name: "Pattern 1", kind: "linear", seeds: ["bolt"], count: 4, amount: "25", axis: "x", ...over });

describe("assembly patterns", () => {
  it("works out the step", () => {
    expect(patternStep(linear())).toEqual({ step: 25 });
    expect(patternStep(linear({ kind: "circular", amount: "360", count: 6 }))).toEqual({ step: 60 });
    expect(patternStep(linear({ kind: "circular", amount: "90", count: 4 }))).toEqual({ step: 30 });
    expect("error" in patternStep(linear({ amount: "0" }))).toBe(true);
    expect("error" in patternStep(linear({ count: 1 }))).toBe(true);
  });

  it("places copies in a line or round an axis", () => {
    close(placeCopy(linear(), 25, at(1, 2, 3), 2).position, [51, 2, 3]);
    close(placeCopy(linear({ flip: true, axis: "z" }), 25, at(1, 2, 3), 1).position, [1, 2, -22]);
    const round = linear({ kind: "circular", axis: "z", centre: [10, 0, 0] });
    const p = placeCopy(round, 90, at(20, 0, 5), 1);
    close(p.position, [10, 10, 5]);
    // Turned with it: a quarter turn about Z.
    close(p.rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  });

  it("makes, keeps and drops copies as the pattern changes", () => {
    const a: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("bolt", false, at(5, 5, 0))] };
    const made = syncPattern(a, linear(), ids);
    const copies = made.instances.filter((i) => i.copyOf);
    expect(copies).toHaveLength(3);
    expect(copies.map((c) => c.name)).toEqual(["bolt <2>", "bolt <3>", "bolt <4>"]);
    close(copies[2].placement.position, [80, 5, 0]);
    // Fewer: the first copies stay (same ids), the last goes.
    const fewer = syncPattern(made, linear({ count: 3 }), ids);
    expect(fewer.instances.filter((i) => i.copyOf).map((i) => i.id)).toEqual(copies.slice(0, 2).map((c) => c.id));
    // Removing the original takes the copies and the pattern with it.
    const doc = { ...emptyDocument(), assemblies: [made] };
    const gone = removeInstances(doc, "a", ["bolt"]).assemblies![0];
    expect(gone.instances.map((i) => i.id)).toEqual(["base"]);
    expect(gone.patterns).toBe(undefined);
    // Removing the pattern removes just its copies.
    expect(removePattern(made, "pt").instances.map((i) => i.id)).toEqual(["base", "bolt"]);
    // And it all survives saving.
    const back = parseAssemblies(JSON.parse(JSON.stringify([made])))[0];
    expect(back.patterns).toEqual(made.patterns);
    expect(back.instances.filter((i) => i.copyOf)).toHaveLength(3);
  });

  it("copies follow their original when a mate moves it, and can carry mated parts", () => {
    const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
    const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
    const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
    const mate = (id: string, a: string, b: string): Mate => ({ id, name: id, type: "fastened", a: { instanceId: a, pick }, b: { instanceId: b, pick }, flip: false, values: {} });
    let a: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("bolt", false, at(100, 100, 100)), inst("nut", false, at(-50, 0, 0))] };
    a = syncPattern(a, linear({ count: 3 }), ids);
    const copy = a.instances.find((i) => i.copyOf?.index === 2)!;
    // The bolt sits on the base; a nut sits on the second copy.
    a = { ...a, mates: [mate("m1", "base", "bolt"), mate("m2", copy.id, "nut")] };
    const frames = (_m: Mate, side: "a" | "b") => (side === "a" ? top : bottom);
    const s = solveAssembly(a, frames);
    expect(s.mateErrors).toEqual({});
    expect(s.patternErrors).toBe(undefined);
    close(s.placements.bolt.position, [0, 0, 10]);
    close(s.placements[copy.id].position, [50, 0, 10]);
    close(s.placements.nut.position, [50, 0, 20]);
    expect(s.drivenBy[copy.id]).toBe("pattern:pt");
  });
});
