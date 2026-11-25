import { describe, expect, it } from "vitest";

import { ANGLE_KEY, evaluate, FUNCTION_NAMES, hasUnitsOrNames, namesIn } from "../src/model/expr";
import { isAngleVariable, renameInExpression, resolveVariables } from "../src/model/variables";
import { completeWith, functionMatches, suggestionsAt, wordAt } from "../src/model/varComplete";
import { storeLength } from "../src/model/units";
import { resolveParams } from "../src/model/features";

const value = (src: string, scope: Record<string, number> = {}) => {
  const r = evaluate(src, scope);
  if (!r.ok) throw new Error(`expected "${src}" to evaluate, got: ${r.error}`);
  return r.value;
};
const error = (src: string, scope: Record<string, number> = {}) => {
  const r = evaluate(src, scope);
  if (r.ok) throw new Error(`expected "${src}" to fail, got ${r.value}`);
  return r.error;
};
const isAngle = (src: string, scope: Record<string, number> = {}) => {
  const r = evaluate(src, scope);
  return r.ok && r.angle === true;
};

describe("functions in expressions", () => {
  it("has the trig functions, taking angles (a plain number is degrees, as in Onshape's boxes)", () => {
    expect(value("sin(30 deg)")).toBe(0.5);
    expect(value("cos(60 deg)")).toBe(0.5);
    expect(value("tan(45 deg)")).toBe(1);
    expect(value("sin(30°)")).toBe(0.5);
    expect(value("sin(30)")).toBe(0.5);
    expect(value("cos(60)")).toBe(0.5);
    expect(value("tan(45)")).toBe(1);
    expect(value("sin(asin(1))")).toBe(1);
    expect(value("cos(pi rad)")).toBe(-1);
    expect(value("cos((pi) rad)")).toBe(-1);
    expect(value("sin(0.5 rad)")).toBe(Math.round(Math.sin(0.5) * 1e9) / 1e9);
    expect(value("sin(pi / 6 rad)")).toBe(0.5);
    expect(value("sin(30 degrees) + cos(60 degree)")).toBe(1);
    expect(value("sin(0.5 radians)")).toBe(value("sin(0.5 radian)"));
    expect(value("cos(90 deg)")).toBe(0);
    expect(isAngle("sin(30 deg)")).toBe(false);
  });

  it("gives angles from the inverse functions, shown in degrees", () => {
    expect(value("asin(0.5)")).toBe(30);
    expect(isAngle("asin(0.5)")).toBe(true);
    expect(value("acos(0.5)")).toBe(60);
    expect(value("atan(1)")).toBe(45);
    expect(value("atan2(1, 1)")).toBe(45);
    expect(value("atan2(3, -3)")).toBe(135);
    expect(value("atan2(10 mm, 10 mm)")).toBe(45);
    expect(value("asin(sin(25 deg))")).toBe(25);
  });

  it("has the other functions", () => {
    expect(value("sqrt(16)")).toBe(4);
    expect(value("sqrt(3^2 + 4^2)")).toBe(5);
    expect(value("abs(-5)")).toBe(5);
    expect(value("min(4, 2, 8)")).toBe(2);
    expect(value("max(4, 2, 8)")).toBe(8);
    expect(value("max(1 in, 20)")).toBe(25.4);
    expect(value("round(12.6)")).toBe(13);
    expect(value("round(12.4)")).toBe(12);
    expect(value("floor(12.6)")).toBe(12);
    expect(value("ceil(12.2)")).toBe(13);
    expect(value("log(exp(2))")).toBe(2);
    expect(value("ln(1)")).toBe(0);
    expect(value("log10(1000)")).toBe(3);
    expect(value("exp(0)")).toBe(1);
    expect(value("pow(2, 10)")).toBe(1024);
    expect(value("SQRT(9)")).toBe(3);
    for (const f of FUNCTION_NAMES) expect(evaluate(`${f}()`).ok, f).toBe(false);
  });

  it("follows the usual precedence and nesting", () => {
    expect(value("2 * sqrt(9) + 1")).toBe(7);
    expect(value("-sqrt(4) ^ 2")).toBe(4); // unary minus binds tighter, as before
    expect(value("max(1, min(5, 3)) * 2")).toBe(6);
    expect(value("sqrt(2) * sqrt(2)")).toBe(2);
    expect(value("100 * cos(60 deg) mm")).toBe(50);
    expect(value("(10 + 2) * sin(30 deg)")).toBe(6);
    expect(value("max(width, 2 * wall)", { width: 10, wall: 7 })).toBe(14);
  });

  it("works with angle units", () => {
    expect(value("30 deg")).toBe(30);
    expect(isAngle("30 deg")).toBe(true);
    expect(value("0.5 rad")).toBeCloseTo((0.5 * 180) / Math.PI, 9);
    expect(value("(pi) rad / 2")).toBe(90);
    expect(value("(1 + 1/2) rad / pi")).toBeCloseTo(270 / Math.PI ** 2, 6);
    expect(value("30 deg + 15 deg")).toBe(45);
    expect(value("30 deg + 5")).toBe(35); // a plain number beside an angle counts as degrees
    expect(value("2 * 30 deg")).toBe(60);
    expect(value("90 deg / 2")).toBe(45);
    expect(value("(90 deg) / (30 deg)")).toBe(3);
    // Natural ways of writing things (an angle unit after "<angle> / <number>" goes with that number).
    expect(value("90 deg / 30 deg")).toBe(3);
    expect(isAngle("90 deg / 30 deg")).toBe(false);
    expect(value("lean / 2 deg", { lean: 30, [ANGLE_KEY("lean")]: 1 })).toBe(15);
    expect(value("30 deg * 2")).toBe(60);
    expect(value("360 / 12 deg")).toBe(30);
    expect(value("asin(0.5) * 2")).toBe(60);
    expect(value("(180 deg) - 30 deg")).toBe(150);
    expect(value("cos(lean) * 50 mm", { lean: 60, [ANGLE_KEY("lean")]: 1 })).toBe(25);
    expect(value("50 * cos(lean)", { lean: 60, [ANGLE_KEY("lean")]: 1 })).toBe(25);
    expect(value("atan(10 / 20)")).toBeCloseTo(26.565051177, 9);
    expect(isAngle("(90 deg) / (30 deg)")).toBe(false);
    expect(value("-30 deg")).toBe(-30);
    expect(value("abs(-30 deg)")).toBe(30);
    expect(value("round(30.4 deg)")).toBe(30);
    expect(value("max(10 deg, 20)")).toBe(20);
    expect(isAngle("max(10 deg, 20)")).toBe(true);
  });

  it("explains mistakes in plain English", () => {
    expect(error("sin()")).toBe("sin needs an angle, like sin(30 deg)");
    expect(error("sqrt(1, 2)")).toBe("sqrt needs one value, like sqrt(16)");
    expect(error("min(1)")).toBe("min needs at least 2 values, like min(10, width / 2)");
    expect(error("foo(2)")).toMatch(/no function called "foo"/);
    expect(error("sqrt(-1)")).toMatch(/square root/);
    expect(error("asin(2)")).toBe("asin needs a number from -1 to 1");
    expect(error("log(0)")).toBe("log needs a number above 0");
    expect(error("tan(90 deg)")).toMatch(/endless/);
    expect(error("sqrt(30 deg)")).toMatch(/not an angle/);
    expect(error("(30 deg) * (2 deg)")).toMatch(/two angles/);
    expect(error("30 deg * 2 deg")).toMatch(/two angles/);
    expect(error("2 / (30 deg)")).toMatch(/divide by an angle/);
    expect(error("(30 deg) ^ 2")).toMatch(/power/);
    expect(error("(30 deg) mm")).toMatch(/already an angle/);
    expect(error("sqrt")).toBe("sqrt needs brackets, like sqrt(16)");
    expect(error("sqrt(4")).toMatch(/closing bracket/);
    expect(error("1, 2")).toMatch(/comma/);
    expect(error("deg")).toMatch(/Put a number before "deg"/);
    expect(error("°")).toMatch(/number before °/);
    expect(error("atan2(0, 0)")).toMatch(/not to be 0/);
  });

  it("leaves older expressions exactly as they were", () => {
    const old: [string, number][] = [
      ["20", 20], ["10 - 2 * 3", 4], ["2 ^ 3 ^ 2", 512], ["0.1 + 0.2", 0.3], ["1/4 in", 6.35], ["(1 + 1/4) in", 31.75],
      ['2"', 50.8], ["1 in + 4.6 mm", 30], ["-2 ^ 2", 4], ["pi * 2", Math.round(Math.PI * 2 * 1e9) / 1e9], ["wall * 2", 4],
      ["max * 2", 6], ["rad + 1", 4], ["deg / 2", 1], ["sin", 7],
    ];
    const scope = { wall: 2, max: 3, rad: 3, deg: 2, sin: 7 };
    for (const [src, v] of old) {
      expect(evaluate(src, scope), src).toEqual({ ok: true, value: v });
    }
    for (const bad of ["", "abc", "10 +", "(2", "2)", "5 / 0", "10 mmm", "3 $"]) expect(evaluate(bad).ok, bad).toBe(false);
  });

  it("knows which names are variables", () => {
    expect(namesIn("sin(a) + max(b, 2)")).toEqual(["a", "b"]);
    expect(namesIn("max * 2")).toEqual(["max"]);
    expect(namesIn("30 deg")).toEqual([]);
    expect(hasUnitsOrNames("sqrt(2)")).toBe(false);
    expect(hasUnitsOrNames("30 deg")).toBe(false); // angle units don't depend on the design's length unit
    expect(hasUnitsOrNames("2 in")).toBe(true);
    expect(hasUnitsOrNames("sqrt(a)")).toBe(true);
    expect(storeLength("sqrt(2)", "in")).toBe("(sqrt(2)) in");
    expect(storeLength("sin(30 deg) * 2", "in")).toBe("(sin(30 deg) * 2) in");
    expect(evaluate(storeLength("sin(30 deg) * 2", "in"), {})).toEqual({ ok: true, value: 25.4 });
    expect(storeLength("30 deg", "in")).toBe("30 deg"); // left for the box to refuse plainly
    expect(renameInExpression("sin(sin) + sin", "sin", "s")).toBe("sin(s) + s");
  });
});

describe("variables holding angles", () => {
  it("are marked and work inside trig", () => {
    const { values, errors } = resolveVariables([
      { id: "1", name: "lean", value: "30 deg" },
      { id: "2", name: "rise", value: "100 * sin(lean)" },
      { id: "3", name: "half", value: "lean / 2" },
      { id: "4", name: "w", value: "20" },
    ]);
    expect(errors).toEqual({});
    expect(values.lean).toBe(30);
    expect(values.rise).toBe(50);
    expect(values.half).toBe(15);
    expect(isAngleVariable(values, "lean")).toBe(true);
    expect(isAngleVariable(values, "half")).toBe(true);
    expect(isAngleVariable(values, "rise")).toBe(false);
    expect(values[ANGLE_KEY("rise")]).toBeUndefined();
    expect(evaluate("lean", values)).toEqual({ ok: true, value: 30, angle: true });
  });

  it("leave plain variables' values as before (no extra keys)", () => {
    const { values } = resolveVariables([
      { id: "1", name: "a", value: "2" },
      { id: "2", name: "b", value: "a * 3 + 1/4 in" },
    ]);
    expect(values).toEqual({ a: 2, b: 12.35 });
  });

  it("angle boxes take deg and rad; length boxes refuse angles", () => {
    const r = resolveParams({ id: "x", type: "revolve", name: "Revolve 1", params: { angle: "0.5 rad * 2 / pi * 180 / 180 * pi" } } as never);
    expect(r.errors.angle).toBeUndefined();
    const ok = resolveParams({ id: "x", type: "revolve", name: "Revolve 1", params: { angle: "90 deg" } } as never);
    expect(ok.values.angle).toBe(90);
    const bad = resolveParams({ id: "x", type: "extrude", name: "Extrude 1", params: { depth: "30 deg" } } as never);
    expect(bad.errors.depth).toMatch(/angle/);
  });
});

describe("functions offered while typing", () => {
  it("offers functions starting with the word, after the variables", () => {
    expect(suggestionsAt("sq", 2, []).names).toEqual(["sqrt("]);
    expect(suggestionsAt("a", 1, ["area"]).names).toEqual(["area", "asin(", "acos(", "atan(", "atan2(", "abs("]);
    expect(suggestionsAt("10 + co", 7, []).names).toEqual(["cos("]);
    const s = suggestionsAt("2 * si", 6, []);
    expect(completeWith("2 * si", s.word!, s.names[0])).toEqual({ text: "2 * sin(", caret: 8 });
  });

  it("keeps a variable typed in full first, so Enter sets the size", () => {
    expect(suggestionsAt("a", 1, ["a"]).names.slice(0, 2)).toEqual(["a", "asin("]);
    expect(suggestionsAt("2 * max", 7, ["max"]).names).toEqual(["max", "max("]);
    expect(suggestionsAt("a", 1, []).names[0]).toBe("asin(");
    expect(suggestionsAt("w", 1, ["w"]).names).toEqual([]); // nothing else to offer: no list, as before
    expect(suggestionsAt("10", 2, ["a"]).names).toEqual([]);
    expect(suggestionsAt("1e3", 3, ["e"]).names).toEqual([]);
  });

  it("never where a unit goes, and no second bracket", () => {
    expect(suggestionsAt("1 in", 4, []).names).toEqual([]);
    expect(suggestionsAt("5 m", 3, []).names).toEqual([]);
    expect(suggestionsAt("(2) m", 5, []).names).toEqual([]);
    expect(functionMatches("si(30 deg)", wordAt("si(30 deg)", 2)!)).toEqual(["sin"]);
    expect(functionMatches("sin(30 deg)", wordAt("sin(30 deg)", 3)!)).toEqual([]);
  });
});
