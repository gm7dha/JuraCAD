import { describe, expect, it } from "vitest";

import { TIGHT_STEPS, tightStep } from "../src/app/topBarFit";

describe("top bar fitting", () => {
  it("keeps the words when the bar fits", () => {
    expect(tightStep(() => true)).toBe(0);
  });
  it("takes the first step at which the bar fits", () => {
    const tried: number[] = [];
    expect(tightStep((s) => (tried.push(s), s >= 2))).toBe(2);
    expect(tried).toEqual([0, 1, 2]);
  });
  it("ends at the last step when nothing fits", () => {
    expect(tightStep(() => false)).toBe(TIGHT_STEPS);
  });
});
