import { describe, expect, it } from "vitest";

import { FIRST_ROW, ROW_STEP } from "../src/drawing/autoDimension";
import { advanceRun, nextLinear, startRun } from "../src/drawing/linearDims";
import type { ViewProjection } from "../src/kernel/protocol";
import type { Dimension } from "../src/model/types";

const top: ViewProjection = { kind: "top", visible: [], hidden: [], circles: [], points: [0, 0, 40, 0, 40, 30, 0, 30], bounds: [0, 0, 40, 30] };

function run(kind: "baseline" | "chain" | "ordinate", targets: [number, number][]) {
  let r = startRun("top", kind, [0, 0]);
  const dims: Dimension[] = [];
  for (const t of targets) {
    const made = nextLinear(r, top, t, 1, dims);
    if (!made.length) continue;
    for (const d of made) dims.push({ ...d, id: `d${dims.length}` });
    r = advanceRun(r, t, made);
  }
  return dims;
}

describe("baseline and chain dimensions", () => {
  it("baseline: each from the datum, stacked outwards (below the top view)", () => {
    const dims = run("baseline", [
      [10, 0],
      [25, 30],
      [40, 0],
    ]);
    expect(dims.map((d) => d.type)).toEqual(["horizontal", "horizontal", "horizontal"]);
    expect(dims.map((d) => d.a.at)).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(dims.map((d) => d.b!.at[0])).toEqual([10, 25, 40]);
    expect(dims.map((d) => d.offset)).toEqual([-FIRST_ROW, -(FIRST_ROW + ROW_STEP), -(FIRST_ROW + 2 * ROW_STEP)]);
  });

  it("chain: each from the one before, in one row", () => {
    const dims = run("chain", [
      [10, 0],
      [25, 0],
      [40, 0],
    ]);
    expect(dims.map((d) => [d.a.at[0], d.b!.at[0]])).toEqual([
      [0, 10],
      [10, 25],
      [25, 40],
    ]);
    expect(new Set(dims.map((d) => d.offset)).size).toBe(1);
  });

  it("keeps the direction of the first dimension, skipping points level with the datum", () => {
    const dims = run("baseline", [
      [0, 10],
      [40, 10], // the same height again: nothing new
      [5, 0], // level with the datum: skipped
      [0, 30],
    ]);
    expect(dims.map((d) => d.type)).toEqual(["vertical", "vertical"]);
    expect(dims.map((d) => d.b!.at[1])).toEqual([10, 30]);
  });

  it("ordinate: 0 at the datum, then each distance, leaders ending on one line", () => {
    const dims = run("ordinate", [
      [10, 0],
      [25, 30],
      [40, 0],
    ]);
    expect(dims.map((d) => d.type)).toEqual(["ordinate", "ordinate", "ordinate", "ordinate"]);
    expect(dims.every((d) => d.axis === "h")).toBe(true);
    expect(dims.map((d) => d.b!.at[0])).toEqual([0, 10, 25, 40]);
    // Below the top view: every leader ends at the same height (the lower of the datum and point, minus the offset).
    const ends = dims.map((d) => Math.min(d.a.at[1], d.b!.at[1]) + d.offset);
    expect(new Set(ends).size).toBe(1);
  });
});
