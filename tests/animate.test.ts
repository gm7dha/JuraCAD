import { describe, expect, it } from "vitest";

import { animatedValues, animationRange, SWEEP_MS } from "../src/assembly/animate";
import type { Mate } from "../src/model/types";

const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] } };
const mate = (type: Mate["type"], values: Record<string, string> = {}, limits?: Mate["limits"]): Mate => ({
  id: "m",
  name: "m",
  type,
  a: { instanceId: "a", pick },
  b: { instanceId: "b", pick },
  flip: false,
  values,
  ...(limits ? { limits } : {}),
});

describe("animating mates", () => {
  it("sweeps a hinge a full turn, or between its limits", () => {
    expect(animationRange(mate("revolute"))).toEqual({ key: "angle", from: 0, to: 360 });
    expect(animationRange(mate("revolute", {}, { angle: { min: "-30", max: "45" } }))).toEqual({ key: "angle", from: -30, to: 45 });
  });

  it("slides a slider either side of where it is, and fastened mates don't move", () => {
    expect(animationRange(mate("slider", { distance: "5" }))).toEqual({ key: "distance", from: -15, to: 25 });
    expect(animationRange(mate("fastened"))).toBe(null);
  });

  it("goes out and back", () => {
    const m = mate("revolute");
    const r = animationRange(m)!;
    expect(animatedValues(m, r, 0).angle).toBe("0");
    expect(animatedValues(m, r, SWEEP_MS / 2).angle).toBe("360");
    expect(animatedValues(m, r, SWEEP_MS).angle).toBe("0");
  });
});
