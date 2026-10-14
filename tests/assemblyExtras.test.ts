import { describe, expect, it } from "vitest";

import { parseAssemblies, setExplode } from "../src/assembly/assembly";
import type { Frame } from "../src/assembly/connectors";
import { planDrag, type Ray } from "../src/assembly/drag";
import { explodedPlacements, explodeOffsets } from "../src/assembly/explode";
import { IDENTITY, type Placement, type Vec3 } from "../src/assembly/math";
import { clampToLimits, mateLimits, mateValues, solveAssembly } from "../src/assembly/mates";
import { parseDrawings } from "../src/drawing/drawing";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, MateType, PartSmithDocument } from "../src/model/types";

const inst = (id: string, fixed = false, placement: Placement = IDENTITY): Instance => ({ id, partId: `p_${id}`, name: id, placement, fixed });
const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const mate = (type: MateType, values: Record<string, string> = {}, limits?: Mate["limits"]): Mate => ({
  id: "m",
  name: "M",
  type,
  a: { instanceId: "base", pick },
  b: { instanceId: "arm", pick },
  flip: false,
  values,
  ...(limits ? { limits } : {}),
});
const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
const frames = (_m: Mate, side: "a" | "b") => (side === "a" ? top : bottom);
const down = (x: number, y: number): Ray => ({ origin: [x, y, 1000], dir: [0, 0, -1] });
const front = (x: number, z: number): Ray => ({ origin: [x, 1000, z], dir: [0, -1, 0] });

describe("mate limits", () => {
  it("are worked out from what's typed, and keep amounts inside them", () => {
    const m = mate("revolute", { angle: "120" }, { angle: { min: "-45", max: "30*3" } });
    expect(mateLimits(m).limits).toEqual({ angle: { min: -45, max: 90 } });
    expect(mateValues(m).values.angle).toBe(90);
    expect(clampToLimits(m, "angle", -60)).toBe(-45);
    expect(clampToLimits(m, "angle", 10)).toBe(10);
    // One end only.
    expect(mateValues(mate("slider", { distance: "-5" }, { distance: { min: "0" } })).values.distance).toBe(0);
    // Not for fixed amounts like a gap.
    expect(mateLimits(mate("revolute", {}, { gap: { min: "1" } })).limits).toEqual({});
  });

  it("explain bad limits", () => {
    expect(mateValues(mate("revolute", {}, { angle: { min: "oops" } })).errors.angle).toMatch(/Lowest limit/);
    expect(mateValues(mate("revolute", {}, { angle: { min: "10", max: "5" } })).errors.angle).toMatch(/more than/);
  });

  it("stop a dragged hinge or slider", () => {
    const asm = (m: Mate): Assembly => ({ id: "a", name: "A", instances: [inst("base", true), inst("arm")], mates: [m] });
    const hinge = asm(mate("revolute", { angle: "0" }, { angle: { min: "0", max: "45" } }));
    const r = planDrag(hinge, solveAssembly(hinge, frames), frames, "arm", [20, 0, 15], [0, 0, -1]);
    if (!("plan" in r)) throw new Error("refused");
    r.plan.update(down(14, 14));
    expect(r.plan.update(down(0, 20))).toEqual({ kind: "mate", id: "m", values: { angle: "45" } });
    const slider = asm(mate("slider", { distance: "0" }, { distance: { max: "12" } }));
    const s = planDrag(slider, solveAssembly(slider, frames), frames, "arm", [0, 0, 15], [0, 1, 0]);
    if (!("plan" in s)) throw new Error("refused");
    expect(s.plan.update(front(0, 40))).toEqual({ kind: "mate", id: "m", values: { distance: "12" } });
  });

  it("are saved and read back, junk dropped", () => {
    const m = mate("revolute", { angle: "0" }, { angle: { min: "-10", max: "10" } });
    const a: Assembly = { id: "a", name: "A", instances: [inst("base", true), inst("arm")], mates: [m] };
    expect(parseAssemblies(JSON.parse(JSON.stringify([a])))[0].mates![0].limits).toEqual({ angle: { min: "-10", max: "10" } });
    const junk = parseAssemblies([{ ...a, mates: [{ ...m, limits: { angle: { min: 5, max: {} }, x: 3 } }] }]);
    expect(junk[0].mates![0].limits).toEqual({ angle: { min: "5" } });
  });
});

describe("exploded views", () => {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ min: [x0, y0, z0] as Vec3, max: [x1, y1, z1] as Vec3 });
  const at = (x: number, y: number, z: number): Placement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });

  it("moves parts straight out from the middle", () => {
    const items = [
      { id: "left", placement: at(-20, 0, 0), box: box(-5, -5, -5, 5, 5, 5) },
      { id: "right", placement: at(20, 0, 0), box: box(-5, -5, -5, 5, 5, 5) },
      { id: "middle", placement: at(0, 0, 0), box: box(-5, -5, -5, 5, 5, 5) },
    ];
    const off = explodeOffsets(items, 1);
    expect(off).toEqual({ left: [-20, 0, 0], right: [20, 0, 0] });
    expect(explodeOffsets(items, 0.5).right).toEqual([10, 0, 0]);
    expect(explodeOffsets(items, 0)).toEqual({});
    const moved = explodedPlacements(Object.fromEntries(items.map((i) => [i.id, i.placement])), off);
    expect(moved.right.position).toEqual([40, 0, 0]);
    expect(moved.middle).toBe(items[2].placement);
  });

  it("keeps fixed parts still and spreads the rest from them", () => {
    const items = [
      { id: "plate", placement: at(0, 0, 0), box: box(-50, -50, 0, 50, 50, 5), fixed: true },
      { id: "bolt", placement: at(20, 0, 5), box: box(-2, -2, 0, 2, 2, 20) },
    ];
    // Plate middle (0, 0, 2.5); bolt middle (20, 0, 15).
    expect(explodeOffsets(items, 2)).toEqual({ bolt: [40, 0, 25] });
  });

  it("is kept with the assembly, and drawings can show it", () => {
    let doc: PartSmithDocument = { ...emptyDocument(), assemblies: [{ id: "a", name: "A", instances: [] }] };
    doc = setExplode(doc, "a", 1.5);
    expect(doc.assemblies![0].explode).toBe(1.5);
    expect(parseAssemblies(JSON.parse(JSON.stringify(doc.assemblies)))[0].explode).toBe(1.5);
    expect(setExplode(doc, "a", null).assemblies![0].explode).toBeUndefined();
    const d = parseDrawings([{ id: "d", name: "D", source: { kind: "assembly", id: "a" }, sheet: "A4", hiddenLines: true, views: [], title: {}, exploded: true }])[0];
    expect(d.exploded).toBe(true);
  });
});
