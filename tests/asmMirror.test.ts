import { describe, expect, it } from "vitest";

import { billOfMaterials, parseAssemblies } from "../src/assembly/assembly";
import { applyPlacement, quatFromAxisAngle, type Placement, type Vec3 } from "../src/assembly/math";
import { solveAssembly } from "../src/assembly/mates";
import { mirrorPlacement, syncPattern } from "../src/assembly/patterns";
import type { Assembly, AssemblyPattern, Instance } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const inst = (id: string, placement: Placement, fixed = false): Instance => ({ id, partId: `p_${id}`, name: `${id} <1>`, placement, fixed });
let n = 0;
const ids = () => `m${++n}`;
const mirror = (over: Partial<AssemblyPattern> = {}): AssemblyPattern => ({ id: "mr", name: "Mirror 1", kind: "mirror", seeds: ["arm"], count: 2, amount: "0", axis: "x", centre: [20, 0, 0], ...over });

/** Where a point of the part (its own coordinates) ends up for an instance, mirrored or not. */
const world = (p: Placement, local: Vec3, mirrored: boolean): Vec3 => applyPlacement(p, mirrored ? [-local[0], local[1], local[2]] : local);
const reflect = (v: Vec3, axis: 0 | 1 | 2, at: number): Vec3 => {
  const out = [...v] as Vec3;
  out[axis] = 2 * at - v[axis];
  return out;
};

describe("mirroring parts in an assembly", () => {
  it("puts the copy where the original's mirror image is, point for point", () => {
    const turned: Placement = { position: [10, 4, -3], rotation: quatFromAxisAngle([1, 2, 3].map((v) => v / Math.hypot(1, 2, 3)) as Vec3, 0.7) };
    for (const [axis, k] of [["x", 0], ["y", 1], ["z", 2]] as const) {
      const p = mirror({ axis, centre: [20, -5, 7] });
      const copy = mirrorPlacement(p, turned);
      for (const local of [[0, 0, 0], [1, 2, 3], [-4, 0.5, 9]] as Vec3[]) {
        close(world(copy, local, true), reflect(world(turned, local, false), k, [20, -5, 7][k]));
      }
      // Twice is back where it started.
      const back = mirrorPlacement(p, copy);
      close(back.position, turned.position);
      close(world(back, [1, 2, 3], false), world(turned, [1, 2, 3], false));
    }
  });

  it("makes a mirrored copy that follows its original, and lists it as its own part", () => {
    const a: Assembly = { id: "a", name: "A", instances: [inst("base", { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, true), inst("arm", { position: [5, 0, 0], rotation: [0, 0, 0, 1] })] };
    const made = syncPattern(a, mirror(), ids);
    const copy = made.instances.find((i) => i.copyOf)!;
    expect(copy.mirrored).toBe(true);
    close(copy.placement.position, [35, 0, 0]);
    // Moved original: the solver keeps the copy mirrored with it.
    const moved: Assembly = { ...made, instances: made.instances.map((i) => (i.id === "arm" ? { ...i, placement: { position: [12, 3, 0], rotation: [0, 0, 0, 1] } } : i)) };
    const solved = solveAssembly(moved, () => null);
    close(solved.placements[copy.id].position, [28, 3, 0]);
    const bom = billOfMaterials(made, { p_base: "Base", p_arm: "Arm" });
    expect(bom.map((r) => [r.name, r.quantity])).toEqual([
      ["Base", 1],
      ["Arm", 1],
      ["Arm (mirrored)", 1],
    ]);
    // Saved and opened again.
    const back = parseAssemblies(JSON.parse(JSON.stringify([made])))[0];
    expect(back.instances.find((i) => i.id === copy.id)?.mirrored).toBe(true);
    expect(back.patterns?.[0].kind).toBe("mirror");
  });
});
