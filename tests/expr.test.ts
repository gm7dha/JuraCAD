import { describe, expect, it } from "vitest";

import { evaluate, formatMm } from "../src/model/expr";

const value = (src: string) => {
  const r = evaluate(src);
  if (!r.ok) throw new Error(`expected "${src}" to evaluate, got: ${r.error}`);
  return r.value;
};

describe("dimension expressions", () => {
  it("reads plain numbers", () => {
    expect(value("20")).toBe(20);
    expect(value("2.5")).toBe(2.5);
    expect(value(".5")).toBe(0.5);
    expect(value("  12  ")).toBe(12);
    expect(value("1e2")).toBe(100);
  });

  it("does arithmetic with the usual precedence", () => {
    expect(value("10 + 2")).toBe(12);
    expect(value("10 - 2 * 3")).toBe(4);
    expect(value("(10 - 2) * 3")).toBe(24);
    expect(value("2 ^ 3 ^ 2")).toBe(512); // right-associative
    expect(value("-5 + 8")).toBe(3);
    expect(value("0.1 + 0.2")).toBe(0.3);
    expect(value("7 / 2")).toBe(3.5);
  });

  it("converts units to millimetres", () => {
    expect(value("25.4 mm")).toBe(25.4);
    expect(value("1 in")).toBe(25.4);
    expect(value('2"')).toBe(50.8);
    expect(value("3 cm")).toBe(30);
    expect(value("0.5m")).toBe(500);
    expect(value("1 ft")).toBe(304.8);
    expect(value("1 in + 4.6 mm")).toBe(30);
  });

  it("explains mistakes in plain English", () => {
    for (const bad of ["", "abc", "10 +", "(2", "2)", "5 / 0", "10 mmm", "3 $"]) {
      const r = evaluate(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(3);
    }
  });

  it("formats millimetres neatly", () => {
    expect(formatMm(12)).toBe("12 mm");
    expect(formatMm(1 / 3)).toBe("0.333 mm");
    expect(formatMm(-0.0001)).toBe("0 mm");
  });
});
