import { describe, expect, it } from "vitest";

import { putMate, removeInstances, removeMate, settlePlacements, parseAssemblies, insertInstance, addAssembly } from "../src/assembly/assembly";
import type { Frame } from "../src/assembly/connectors";
import { applyPlacement, IDENTITY, quatFromEulerDeg, type Placement, type Vec3 } from "../src/assembly/math";
import { MATE_TYPES, mateValues, nextMateName, solveAssembly } from "../src/assembly/mates";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, MateType } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

const inst = (id: string, fixed = false, placement: Placement = IDENTITY): Instance => ({ id, partId: `p_${id}`, name: id, placement, fixed });
const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };

function mate(id: string, type: MateType, a: string, b: string, values: Record<string, string> = {}, flip = false): Mate {
  return { id, name: id, type, a: { instanceId: a, pick }, b: { instanceId: b, pick }, flip, values };
}

const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };

/** Frames by mate id and side. */
function lookup(frames: Record<string, [Frame | null, Frame | null]>) {
  return (m: Mate, side: "a" | "b") => frames[m.id]?.[side === "a" ? 0 : 1] ?? null;
}

describe("closing loops of mates", () => {
  it("turns a hinge so the loop closes", () => {
    // b is fastened to a turned 90°, and also hinged to a (at 0°): the hinge has to turn to 90° to fit.
    const asm: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("a", true), inst("b")],
      mates: [mate("m1", "fastened", "a", "b", { angle: "90" }), mate("m2", "revolute", "a", "b", { angle: "0" })],
    };
    const r = solveAssembly(asm, lookup({ m1: [top, bottom], m2: [top, bottom] }));
    expect(r.mateErrors).toEqual({});
    expect(((r.adjusted?.m2.angle ?? 0) % 360 + 360) % 360).toBeCloseTo(90, 3);
  });

  it("slides a slider along so a chain of parts meets back up", () => {
    // a (fixed) → b by a Fasten with a 10 mm gap; a → b also by a Slider at 0: the slider must slide 10.
    const asm: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("a", true), inst("b")],
      mates: [mate("m1", "fastened", "a", "b", { gap: "10" }), mate("m2", "slider", "a", "b", { distance: "0" })],
    };
    const r = solveAssembly(asm, lookup({ m1: [top, bottom], m2: [top, bottom] }));
    expect(r.mateErrors).toEqual({});
    expect(r.adjusted?.m2.distance).toBeCloseTo(10, 4);
    close(r.placements.b.position, [0, 0, 20], 4);
  });
});

describe("pin slot and parallel mates", () => {
  it("slide along the slot, or move anywhere keeping the axes parallel", () => {
    const base = inst("base", true);
    const arm = inst("arm");
    const slot = solveAssembly({ id: "a", name: "A", instances: [base, arm], mates: [mate("m", "pinSlot", "base", "arm", { dx: "7" })] }, lookup({ m: [top, bottom] }));
    close(slot.placements.arm.position, [7, 0, 10]);
    const par = solveAssembly(
      { id: "a", name: "A", instances: [base, arm], mates: [mate("m", "parallel", "base", "arm", { dx: "1", dy: "2", distance: "3" })] },
      lookup({ m: [top, bottom] }),
    );
    close(par.placements.arm.position, [1, 2, 13]);
    expect(MATE_TYPES.pinSlot.values.filter((v) => v.free).map((v) => v.key)).toEqual(["dx", "angle"]);
  });
});

describe("solving mates", () => {
  it("fastens one part on top of another, face to face", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("lid")], mates: [mate("m1", "fastened", "base", "lid")] };
    const r = solveAssembly(asm, lookup({ m1: [top, bottom] }));
    expect(r.mateErrors).toEqual({});
    close(r.placements.lid.position, [0, 0, 10]);
    close(applyPlacement(r.placements.lid, [1, 2, 0]), [1, 2, 10]);
    expect(r.drivenBy).toEqual({ lid: "m1" });
  });

  it("flip points the connectors the same way", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("lid")], mates: [mate("m1", "fastened", "base", "lid", {}, true)] };
    const r = solveAssembly(asm, lookup({ m1: [top, bottom] }));
    // Lid turned upside down: its bottom face now faces up, sitting on the top.
    close(applyPlacement(r.placements.lid, [0, 0, 0]), [0, 0, 10]);
    close(applyPlacement(r.placements.lid, [0, 0, 5]), [0, 0, 5]);
  });

  it("applies a gap, a hinge angle and a slide", () => {
    const base = inst("base", true);
    const arm = inst("arm");
    const gap = solveAssembly({ id: "a", name: "A", instances: [base, arm], mates: [mate("m", "fastened", "base", "arm", { gap: "2" })] }, lookup({ m: [top, bottom] }));
    close(gap.placements.arm.position, [0, 0, 12]);

    const hinge = solveAssembly({ id: "a", name: "A", instances: [base, arm], mates: [mate("m", "revolute", "base", "arm", { angle: "90" })] }, lookup({ m: [top, bottom] }));
    // The arm's +X now points along +Y (turned 90° about the shared axis)… seen from the base's side.
    const p = applyPlacement(hinge.placements.arm, [5, 0, 0]);
    close([p[2]], [10]);
    close([Math.hypot(p[0], p[1])], [5]);
    expect(Math.abs(p[0])).toBeLessThan(1e-9);

    const slide = solveAssembly({ id: "a", name: "A", instances: [base, arm], mates: [mate("m", "slider", "base", "arm", { distance: "1 cm" })] }, lookup({ m: [top, bottom] }));
    close(slide.placements.arm.position, [0, 0, 20]);
  });

  it("works whichever way round the mate was made", () => {
    // The moving part is the mate's first connector this time.
    const asm: Assembly = { id: "a", name: "A", instances: [inst("lid"), inst("base", true)], mates: [mate("m1", "fastened", "lid", "base")] };
    const r = solveAssembly(asm, lookup({ m1: [bottom, top] }));
    close(r.placements.lid.position, [0, 0, 10]);
    close(r.placements.base.position, [0, 0, 0]);
  });

  it("follows chains of mates from the fixed part", () => {
    const asm: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("c"), inst("b"), inst("a", true, { position: [100, 0, 0], rotation: [0, 0, 0, 1] })],
      mates: [mate("m1", "fastened", "a", "b"), mate("m2", "fastened", "b", "c")],
    };
    const r = solveAssembly(asm, lookup({ m1: [top, bottom], m2: [top, bottom] }));
    close(r.placements.b.position, [100, 0, 10]);
    close(r.placements.c.position, [100, 0, 20]);
  });

  it("reports mates that disagree, or join two fixed parts", () => {
    const loop: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("a", true), inst("b")],
      mates: [mate("m1", "fastened", "a", "b"), mate("m2", "fastened", "a", "b", { gap: "5" })],
    };
    const r = solveAssembly(loop, lookup({ m1: [top, bottom], m2: [top, bottom] }));
    expect(r.mateErrors.m1).toBeUndefined();
    expect(r.mateErrors.m2).toMatch(/can't be met/);
    // Agreeing loops are fine.
    const ok = solveAssembly({ ...loop, mates: [mate("m1", "fastened", "a", "b"), mate("m2", "revolute", "a", "b")] }, lookup({ m1: [top, bottom], m2: [top, bottom] }));
    expect(ok.mateErrors).toEqual({});

    const twoFixed = solveAssembly(
      { id: "a", name: "A", instances: [inst("a", true), inst("b", true, { position: [50, 0, 0], rotation: [0, 0, 0, 1] })], mates: [mate("m1", "fastened", "a", "b")] },
      lookup({ m1: [top, bottom] }),
    );
    expect(twoFixed.mateErrors.m1).toMatch(/Both parts are fixed/);
    close(twoFixed.placements.b.position, [50, 0, 0]);
  });

  it("explains missing parts, faces and bad values", () => {
    const asm: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("a", true), inst("b")],
      mates: [mate("gone", "fastened", "a", "zzz"), mate("noface", "fastened", "a", "b"), mate("bad", "revolute", "a", "b", { angle: "1 +" }), mate("self", "fastened", "a", "a")],
    };
    const r = solveAssembly(asm, lookup({ noface: [top, null], bad: [top, bottom], self: [top, top] }));
    expect(r.mateErrors.gone).toMatch(/removed/);
    expect(r.mateErrors.noface).toMatch(/can't be found/);
    expect(r.mateErrors.bad).toMatch(/^Angle:/);
    expect(r.mateErrors.self).toMatch(/same part/);
    // b had no usable mate, so it stays where it was put.
    close(r.placements.b.position, [0, 0, 0]);
    expect(r.drivenBy).toEqual({});
  });

  it("skips suppressed mates", () => {
    const m = { ...mate("m1", "fastened", "base", "lid"), suppressed: true };
    const r = solveAssembly({ id: "a", name: "A", instances: [inst("base", true), inst("lid", false, { position: [7, 0, 0], rotation: quatFromEulerDeg(0, 0, 0) })], mates: [m] }, lookup({ m1: [top, bottom] }));
    close(r.placements.lid.position, [7, 0, 0]);
  });

  it("works out values with maths and units, blank as 0", () => {
    expect(mateValues({ type: "cylindrical", values: { distance: "1 in", angle: "" } }).values).toEqual({ distance: 25.4, angle: 0 });
    expect(Object.keys(MATE_TYPES)).toHaveLength(8);
  });
});

describe("mates in documents", () => {
  const base = () => {
    let doc = addAssembly(emptyDocument(), "a1");
    doc = insertInstance(doc, "a1", { id: "f1", name: "Part 1" }, undefined, "i1");
    doc = insertInstance(doc, "a1", { id: "f1", name: "Part 1" }, undefined, "i2");
    return doc;
  };

  it("adds, replaces, removes and names mates", () => {
    let doc = putMate(base(), "a1", mate("m1", "revolute", "i1", "i2"));
    expect(nextMateName(doc.assemblies![0], "revolute")).toBe("Hinge 1");
    doc = putMate(doc, "a1", { ...mate("m1", "revolute", "i1", "i2"), name: "Hinge 1" });
    expect(doc.assemblies![0].mates).toHaveLength(1);
    expect(nextMateName(doc.assemblies![0], "revolute")).toBe("Hinge 2");
    doc = removeMate(doc, "a1", "m1");
    expect(doc.assemblies![0].mates).toBeUndefined();
  });

  it("removing a part removes its mates", () => {
    const doc = removeInstances(putMate(base(), "a1", mate("m1", "fastened", "i1", "i2")), "a1", ["i2"]);
    expect(doc.assemblies![0].mates).toBeUndefined();
  });

  it("stores solved positions (but never moves a fixed part)", () => {
    const doc = settlePlacements(base(), "a1", {
      i1: { position: [9, 9, 9], rotation: [0, 0, 0, 1] },
      i2: { position: [1, 2, 3], rotation: [0, 0, 0, 1] },
    });
    expect(doc.assemblies![0].instances[0].placement.position).toEqual([0, 0, 0]);
    expect(doc.assemblies![0].instances[1].placement.position).toEqual([1, 2, 3]);
  });

  it("saves and reads mates, dropping broken ones", () => {
    const doc = putMate(base(), "a1", mate("m1", "slider", "i1", "i2", { distance: "5" }, true));
    const back = parseAssemblies(JSON.parse(JSON.stringify(doc.assemblies)));
    expect(back).toEqual(doc.assemblies);
    const broken = parseAssemblies([{ id: "a", instances: [], mates: [{ id: "m", type: "warp", a: {}, b: {} }, { id: "m2", type: "ball", a: { instanceId: "x" }, b: { instanceId: "y", pick } }] }]);
    expect(broken[0].mates).toBeUndefined();
  });
});
