import { describe, expect, it } from "vitest";

import { parseAssemblies } from "../src/assembly/assembly";
import { widthFrame, type Frame } from "../src/assembly/connectors";
import { applyPlacement, IDENTITY, type Placement, type Vec3 } from "../src/assembly/math";
import { pickWidthFace, solveAssembly } from "../src/assembly/mates";
import type { Assembly, Instance, Mate, MateConnector } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const face = (centre: Vec3, normal: Vec3) => ({ partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: centre, normal } });
const inst = (id: string, fixed = false, placement: Placement = IDENTITY): Instance => ({ id, partId: `p_${id}`, name: id, placement, fixed });

describe("width mates", () => {
  it("put the connector halfway between two parallel faces (and refuse faces that aren't)", () => {
    const left: Frame = { origin: [-5, 2, 3], z: [1, 0, 0], x: [0, 1, 0] };
    const right: Frame = { origin: [5, -4, 1], z: [-1, 0, 0], x: [0, 1, 0] };
    const mid = widthFrame(left, right)!;
    expect(mid.origin[0]).toBeCloseTo(0, 9);
    close(mid.z, [1, 0, 0]);
    expect(widthFrame(left, { origin: [5, 0, 0], z: [0, 0, 1], x: [1, 0, 0] })).toBe(null);
  });

  it("centre a tab between the sides of a slot", () => {
    // Slot in the fixed base: sides at x = 10 and x = 30 (its middle at x = 20). Tab: sides at x = 0 and 6 (middle at 3).
    const slotMid: Frame = { origin: [20, 0, 5], z: [1, 0, 0], x: [0, 1, 0] };
    const tabMid: Frame = { origin: [3, 0, 0], z: [1, 0, 0], x: [0, 1, 0] };
    const conn = (instanceId: string, x1: number, x2: number): MateConnector => ({ instanceId, pick: face([x1, 0, 0], [1, 0, 0]), pick2: face([x2, 0, 0], [-1, 0, 0]) });
    const mate: Mate = { id: "w", name: "Width 1", type: "width", a: conn("base", 10, 30), b: conn("tab", 0, 6), flip: true, values: {} };
    const asm: Assembly = { id: "asm", name: "A", instances: [inst("base", true), inst("tab")], mates: [mate] };
    const r = solveAssembly(asm, (_m, side) => (side === "a" ? slotMid : tabMid));
    expect(r.mateErrors).toEqual({});
    // The tab's middle (x = 3 on the part) ends up on the slot's middle (x = 20).
    expect(applyPlacement(r.placements.tab, [3, 0, 0])[0]).toBeCloseTo(20, 6);
    // Without the second faces it says what to pick.
    const half = { ...asm, mates: [{ ...mate, b: { instanceId: "tab", pick: mate.b.pick } }] };
    expect(solveAssembly(half, () => slotMid).mateErrors.w).toMatch(/two faces on each part/);
    // Saved and read back with both faces.
    const back = parseAssemblies(JSON.parse(JSON.stringify([asm])))[0];
    expect(back.mates![0].b.pick2?.ref).toEqual(mate.b.pick2!.ref);
  });

  it("take the faces in order: both sides of the slot, then both sides of the tab", () => {
    const c = (instanceId: string, x: number): MateConnector => ({ instanceId, pick: face([x, 0, 0], [1, 0, 0]) });
    const x = (p?: { ref: unknown }) => (p?.ref as { center?: Vec3 } | undefined)?.center?.[0];
    let m: { a?: MateConnector; b?: MateConnector } = {};
    m = pickWidthFace(m, c("base", 10));
    m = pickWidthFace(m, c("base", 30));
    expect([x(m.a?.pick), x(m.a?.pick2), m.b]).toEqual([10, 30, undefined]);
    m = pickWidthFace(m, c("tab", 0));
    m = pickWidthFace(m, c("tab", 6));
    expect([m.b?.instanceId, x(m.b?.pick), x(m.b?.pick2)]).toEqual(["tab", 0, 6]);
    // Clicking the same face twice doesn't count as the second side.
    const again = pickWidthFace({ a: c("base", 10) }, c("base", 10));
    expect(again.a?.pick2).toBe(undefined);
  });
});
