import { describe, expect, it } from "vitest";

import type { Frame } from "../src/assembly/connectors";
import { planDrag, rayPlane, withDragChange, type DragStart, type Ray } from "../src/assembly/drag";
import { IDENTITY, type Placement, type Vec3 } from "../src/assembly/math";
import { solveAssembly } from "../src/assembly/mates";
import type { Assembly, Instance, Mate, MateType } from "../src/model/types";

const inst = (id: string, fixed = false, placement: Placement = IDENTITY): Instance => ({ id, partId: `p_${id}`, name: id, placement, fixed });
const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const mate = (type: MateType, a: string, b: string, values: Record<string, string> = {}): Mate => ({ id: "m", name: "M", type, a: { instanceId: a, pick }, b: { instanceId: b, pick }, flip: false, values });

const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
const frames = (m: Mate, side: "a" | "b") => (side === "a" ? (m.a.instanceId === "base" ? top : bottom) : m.b.instanceId === "base" ? top : bottom);

/** Looking straight down from above, at screen point (x, y). */
const down = (x: number, y: number): Ray => ({ origin: [x, y, 1000], dir: [0, 0, -1] });
/** Looking along -Y (from the front), at (x, z). */
const front = (x: number, z: number): Ray => ({ origin: [x, 1000, z], dir: [0, -1, 0] });

function plan(asm: Assembly, id: string, grab: Vec3, view: Vec3, shift = false): DragStart {
  return planDrag(asm, solveAssembly(asm, frames), frames, id, grab, view, shift);
}

describe("dragging parts", () => {
  it("meets planes", () => {
    expect(rayPlane(down(3, 4), [0, 0, 5], [0, 0, 1])).toEqual([3, 4, 5]);
    expect(rayPlane(down(3, 4), [0, 0, 5], [1, 0, 0])).toBeNull();
  });

  it("slides a free part across the screen", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("free", false, { position: [50, 0, 0], rotation: [0, 0, 0, 1] })] };
    const r = plan(asm, "free", [55, 0, 5], [0, 0, -1]);
    if (!("plan" in r)) throw new Error("refused");
    const c = r.plan.update(down(65, 7));
    expect(c).toEqual({ kind: "instance", id: "free", placement: { position: [60, 7, 0], rotation: [0, 0, 0, 1] } });
  });

  it("won't drag a fixed part, or a fastened one", () => {
    const fixed = plan({ id: "a", name: "A", instances: [inst("base", true)] }, "base", [0, 0, 0], [0, 0, -1]);
    expect("refuse" in fixed && fixed.refuse).toMatch(/fixed/);
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("lid")], mates: [mate("fastened", "base", "lid")] };
    const r = plan(asm, "lid", [5, 0, 15], [0, 0, -1]);
    expect("refuse" in r && r.refuse).toMatch(/fastened/);
  });

  it("turns a hinge by the angle the pointer goes round", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("arm")], mates: [mate("revolute", "base", "arm", { angle: "10" })] };
    const r = plan(asm, "arm", [20, 0, 15], [0, 0, -1]);
    if (!("plan" in r)) throw new Error("refused");
    // A quarter turn anticlockwise seen from above, in two steps.
    r.plan.update(down(14, 14));
    const c = r.plan.update(down(0, 20));
    expect(c).toEqual({ kind: "mate", id: "m", values: { angle: "100" } });
    // Dragging the hinge's first part still turns it the way the pointer goes.
    const asm2: Assembly = { id: "a", name: "A", instances: [inst("arm"), inst("base", true)], mates: [mate("revolute", "arm", "base")] };
    const r2 = plan(asm2, "arm", [20, 0, 15], [0, 0, -1]);
    if (!("plan" in r2)) throw new Error("refused");
    expect(r2.plan.update(down(0, 20))).toEqual({ kind: "mate", id: "m", values: { angle: "90" } });
  });

  it("slides a slider along its axis", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("ram")], mates: [mate("slider", "base", "ram")] };
    const r = plan(asm, "ram", [3, 0, 12], [0, -1, 0]);
    if (!("plan" in r)) throw new Error("refused");
    // Sideways movement is ignored; only the part along the axis counts.
    expect(r.plan.update(front(40, 17))).toEqual({ kind: "mate", id: "m", values: { distance: "5" } });
    // Looking straight along the axis can't work.
    const along = plan(asm, "ram", [3, 0, 12], [0, 0, -1]);
    expect("refuse" in along).toBe(true);
  });

  it("cylindrical turns, or slides with Shift; planar slides on the face", () => {
    const cyl: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("pin")], mates: [mate("cylindrical", "base", "pin")] };
    const turn = plan(cyl, "pin", [20, 0, 15], [0, 0, -1]);
    if (!("plan" in turn)) throw new Error("refused");
    expect(turn.plan.update(down(0, 20))).toEqual({ kind: "mate", id: "m", values: { angle: "90" } });
    const slide = plan(cyl, "pin", [3, 0, 12], [0, -1, 0], true);
    if (!("plan" in slide)) throw new Error("refused");
    expect(slide.plan.update(front(3, 10))).toEqual({ kind: "mate", id: "m", values: { distance: "-2" } });

    const flat: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("puck")], mates: [mate("planar", "base", "puck")] };
    const p = plan(flat, "puck", [1, 1, 12], [0, 0, -1]);
    if (!("plan" in p)) throw new Error("refused");
    expect(p.plan.update(down(4, -1))).toEqual({ kind: "mate", id: "m", values: { dx: "3", dy: "-2" } });
  });

  it("shows a drag's change on the assembly", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("arm")], mates: [mate("revolute", "base", "arm")] };
    expect(withDragChange(asm, null)).toBe(asm);
    expect(withDragChange(asm, { kind: "mate", id: "m", values: { angle: "45" } }).mates![0].values.angle).toBe("45");
    expect(withDragChange(asm, { kind: "instance", id: "arm", placement: { position: [1, 1, 1], rotation: [0, 0, 0, 1] } }).instances[1].placement.position).toEqual([1, 1, 1]);
  });
});
