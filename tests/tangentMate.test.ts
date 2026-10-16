import { describe, expect, it } from "vitest";

import type { Frame } from "../src/assembly/connectors";
import { applyPlacement, cross, dot, IDENTITY, length, rotate, scale, type Vec3 } from "../src/assembly/math";
import { MATE_ORDER, solveAssembly } from "../src/assembly/mates";
import { parseAssemblies } from "../src/assembly/assembly";
import type { Assembly, Instance, Mate } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const inst = (id: string, fixed = false): Instance => ({ id, partId: `p_${id}`, name: id, placement: IDENTITY, fixed });
const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const tangent = (a: string, b: string, values: Record<string, string> = {}): Mate => ({ id: "m", name: "Tangent 1", type: "tangent", a: { instanceId: a, pick }, b: { instanceId: b, pick }, flip: false, values });

/** The top of a plate, 10 up. */
const plateTop: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0], surface: "plane" };
/** A roller of radius r about its own Y axis. */
const roller = (r: number): Frame => ({ origin: [0, 0, 0], z: [0, 1, 0], x: [1, 0, 0], surface: "cylinder", radius: r });
const solve = (asm: Assembly, fa: Frame, fb: Frame) => solveAssembly(asm, (_m, side) => (side === "a" ? fa : fb));

describe("Tangent mates", () => {
  it("sit a roller on a flat face, its axis level, and let it slide and roll", () => {
    const asm = (values: Record<string, string>): Assembly => ({ id: "a", name: "A", instances: [inst("plate", true), inst("roller")], mates: [tangent("plate", "roller", values)] });
    const r = solve(asm({}), plateTop, roller(5));
    expect(r.mateErrors).toEqual({});
    const p = r.placements.roller;
    close(p.position, [0, 0, 15]);
    // Its axis lies along the face.
    expect(Math.abs(rotate(p.rotation, [0, 1, 0])[2])).toBeLessThan(1e-9);
    close(solve(asm({ dx: "3", dy: "4" }), plateTop, roller(5)).placements.roller.position, [3, 4, 15]);
    // Rolling turns it about its own axis, which stays put.
    const rolled = solve(asm({ roll: "90" }), plateTop, roller(5)).placements.roller;
    close(rolled.position, [0, 0, 15]);
    close(rotate(rolled.rotation, [0, 1, 0]), rotate(p.rotation, [0, 1, 0]));
    expect(dot(rotate(rolled.rotation, [1, 0, 0]), rotate(p.rotation, [1, 0, 0]))).toBeCloseTo(0, 6);
    // A gap lifts it off.
    close(solve(asm({ gap: "1" }), plateTop, roller(5)).placements.roller.position, [0, 0, 16]);
  });

  it("works the other way round: a flat face resting on a fixed roller", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("roller", true), inst("plate")], mates: [tangent("roller", "plate", { dx: "2" })] };
    const r = solve(asm, roller(5), plateTop);
    expect(r.mateErrors).toEqual({});
    const p = r.placements.plate;
    // The plate's top touches the roller: 5 from the roller's axis (the Y axis), facing it.
    const touch = applyPlacement(p, [0, 0, 10]);
    const fromAxis: Vec3 = [touch[0], 0, touch[2]];
    expect(length(fromAxis)).toBeCloseTo(5, 6);
    close(rotate(p.rotation, [0, 0, 1]), scale(fromAxis, -1 / 5));
  });

  it("keeps two rollers touching, their axes parallel and the radii apart", () => {
    const asm = (values: Record<string, string>): Assembly => ({ id: "a", name: "A", instances: [inst("big", true), inst("small")], mates: [tangent("big", "small", values)] });
    for (const dy of ["0", "5"]) {
      const p = solve(asm({ dy }), roller(5), roller(3)).placements.small;
      const axis = rotate(p.rotation, [0, 1, 0]);
      expect(length(cross(axis, [0, 1, 0]))).toBeLessThan(1e-9);
      const c = p.position;
      expect(Math.hypot(c[0], c[2])).toBeCloseTo(8, 6);
    }
    // Sliding sideways goes round the big roller: 5 mm of its surface (radius 5) is 1 radian.
    const a0 = solve(asm({}), roller(5), roller(3)).placements.small.position;
    const a1 = solve(asm({ dy: "5" }), roller(5), roller(3)).placements.small.position;
    expect(Math.acos(dot(a0, a1) / 64)).toBeCloseTo(1, 6);
  });

  it("rolls a ball on a flat", () => {
    const ball: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0], surface: "sphere", radius: 4 };
    const asm: Assembly = { id: "a", name: "A", instances: [inst("plate", true), inst("ball")], mates: [tangent("plate", "ball", { dx: "1" })] };
    close(solve(asm, plateTop, ball).placements.ball.position, [1, 0, 14]);
  });

  it("needs a round face", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("a", true), inst("b")], mates: [tangent("a", "b")] };
    expect(solve(asm, plateTop, plateTop).mateErrors.m).toMatch(/round/);
    const edge: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
    expect(solve(asm, plateTop, edge).mateErrors.m).toMatch(/round/);
  });

  it("is offered and kept in saved files", () => {
    expect(MATE_ORDER).toContain("tangent");
    const asm: Assembly = { id: "a", name: "A", instances: [inst("a", true), inst("b")], mates: [tangent("a", "b", { roll: "30" })] };
    const back = parseAssemblies(JSON.parse(JSON.stringify([asm])));
    expect(back?.[0].mates?.[0].type).toBe("tangent");
  });
});
