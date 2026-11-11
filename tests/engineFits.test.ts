/**
 * The fit check against the real OpenCascade engine: pins in a ⌀10 hole a
 * little too big (interference) or too small (clearance), measured all round
 * from their round faces; a flat overlap measured about; and marked press
 * fits judged in their range.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { assemblyReport, DEFAULT_CLASH_OPTIONS, judgeContacts } from "../src/assembly/assemblyCheck";
import { FIT_RANGE, judgeFits, measuredFit } from "../src/assembly/fits";
import { GeometryEngine } from "../src/kernel/engine";
import type { InstanceInput } from "../src/kernel/protocol";
import { DEFAULT_FITS } from "../src/model/printSettings";
import type { Assembly, Feature } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

// A 30 × 30 × 10 plate with a ⌀10 hole through its middle, and pins standing in it.
const plate = feature("box", { width: 30, depth: 30, height: 10, x: -15, y: -15, z: 0 });
const hole = feature("cylinder", { diameter: 10, height: 10, x: 0, y: 0, z: 0 }, "remove");
const pinBig = feature("cylinder", { diameter: 10.1, height: 20, x: 0, y: 0, z: -5 });
const pinSmall = feature("cylinder", { diameter: 9.8, height: 20, x: 0, y: 0, z: -5 });
const pinPress = feature("cylinder", { diameter: 10.08, height: 20, x: 0, y: 0, z: -5 });
const block = feature("box", { width: 10, depth: 10, height: 5, x: 0, y: 0, z: 9.8 });

const ID: [number, number, number, number] = [0, 0, 0, 1];
const put = (id: string, partId: string, name: string, dx = 0): InstanceInput => ({ id, partId, name, position: [dx, 0, 0], rotation: ID });

function setup(): Record<string, string> {
  engine = new GeometryEngine();
  const r = engine.rebuild([plate, hole, pinBig, pinSmall, pinPress, block] as Feature[]);
  expect(r.featureErrors).toEqual({});
  expect(r.parts).toHaveLength(5);
  return { plate: r.parts[0].id, big: r.parts[1].id, small: r.parts[2].id, press: r.parts[3].id, block: r.parts[4].id };
}

const measure = (instances: InstanceInput[]) => engine.clashes(instances, DEFAULT_CLASH_OPTIONS.tolerance, false, FIT_RANGE);

describe("fit check", () => {
  it("measures a pin 0.1 mm over its hole as 0.1 mm of interference on the diameter", () => {
    const p = setup();
    const m = measure([put("i1", p.plate, "Plate <1>"), put("i2", p.big, "Pin <1>")]);
    expect(m).toHaveLength(1);
    expect(m[0].ids).toEqual(["i1", "i2"]);
    const f = measuredFit(m[0])!;
    expect(f.kind).toBe("overlap");
    expect(f.round).toBe(true);
    expect(f.amount).toBeCloseTo(0.1, 6);
    expect(f.side).toBeCloseTo(0.05, 6);
    // Not marked: a clash, with the amount.
    const contacts = judgeContacts(m, DEFAULT_CLASH_OPTIONS);
    const asm: Assembly = { id: "a", name: "A", instances: [] };
    const report = assemblyReport(asm, { placements: {}, mateErrors: {}, drivenBy: {} }, {}, contacts);
    expect(report.parts.find((s) => s.name === "Clashes")!.findings[0].text).toMatch(/Plate <1> and Pin <1> overlap by .* \(the pin is 0.1 mm too big on the diameter, 0.05 mm a side\)/);
  });

  it("measures a pin 0.2 mm under its hole as a 0.1 mm gap a side (0.2 mm on the diameter)", () => {
    const p = setup();
    const m = measure([put("i1", p.plate, "Plate <1>"), put("i2", p.small, "Pin <1>")]);
    expect(m).toHaveLength(1);
    expect(m[0].gap).toBeCloseTo(0.1, 6);
    const f = measuredFit(m[0])!;
    expect(f).toMatchObject({ kind: "gap", round: true });
    expect(f.side).toBeCloseTo(0.1, 6);
    expect(f.amount).toBeCloseTo(0.2, 6);
    const fits = judgeFits({ measured: m, intended: [], tolerance: 0.01, printFits: DEFAULT_FITS, nameOf: () => undefined });
    expect(fits.findings[1].text).toBe("Plate <1> and Pin <1>: a gap of 0.2 mm on the diameter (0.1 mm a side) round the pin — about a snug fit for your printer (0.2 mm).");
    // Without the fit check nothing is measured there (as before).
    expect(engine.clashes([put("i1", p.plate, "Plate <1>"), put("i2", p.small, "Pin <1>")], 0.01, false)).toEqual([]);
  });

  it("says a marked press fit in its range is OK and leaves it out of the clashes", () => {
    const p = setup();
    const m = measure([put("i1", p.plate, "Plate <1>"), put("i2", p.press, "Pin <1>")]);
    const fits = judgeFits({ measured: m, intended: [{ id: "f", a: "i2", b: "i1", kind: "press", min: 0.05, max: 0.15 }], tolerance: 0.01, nameOf: () => undefined });
    expect(fits.warnings).toBe(0);
    expect(fits.findings[1].text).toBe("Pin <1> and Plate <1>: press fit OK — 0.08 mm on the diameter (0.04 mm a side) of interference (wanted 0.05–0.15 mm on the diameter).");
    const asm: Assembly = { id: "a", name: "A", instances: [] };
    const report = assemblyReport(asm, { placements: {}, mateErrors: {}, drivenBy: {} }, {}, judgeContacts(m, DEFAULT_CLASH_OPTIONS), DEFAULT_CLASH_OPTIONS, {}, [], fits);
    expect(report.level).toBe("ok");
    // Too tight for 0.02–0.05.
    const tight = judgeFits({ measured: m, intended: [{ id: "f", a: "i1", b: "i2", kind: "press", min: 0.02, max: 0.05 }], tolerance: 0.01, nameOf: () => undefined });
    expect(tight.findings[1].text).toMatch(/press fit too tight/);
  });

  it("estimates a flat overlap's depth and keeps it a clash", () => {
    const p = setup();
    // The block sinks 0.2 mm into the plate's top (away from the hole).
    const m = measure([put("i1", p.plate, "Plate <1>"), put("i3", p.block, "Block <1>", 3)]);
    expect(m).toHaveLength(1);
    const f = measuredFit(m[0])!;
    expect(f).toMatchObject({ kind: "overlap", round: false });
    expect(f.side).toBeCloseTo(0.2, 2);
    const contacts = judgeContacts(m, DEFAULT_CLASH_OPTIONS);
    expect(contacts[0].kind).toBe("overlap");
  });

  it("reads a stepped pin by its body, not its lead-in, and a lid with two pins by the tighter one", () => {
    engine = new GeometryEngine();
    // Plate as before; a ⌀9.96 lead-in (8 long, from below) under a ⌀10.1 body.
    const lead = feature("cylinder", { diameter: 9.96, height: 8, x: 0, y: 0, z: -5 });
    const body = feature("cylinder", { diameter: 10.1, height: 12, x: 0, y: 0, z: 3 }, "add");
    // A second plate with two ⌀6 holes 16 apart, and a lid with a ⌀6.1 pin and a ⌀5.96 pin in them.
    const plate2 = feature("box", { width: 30, depth: 20, height: 6, x: 50, y: -10, z: 0 });
    const holeA = feature("cylinder", { diameter: 6, height: 6, x: 57, y: 0, z: 0 }, "remove");
    const holeB = feature("cylinder", { diameter: 6, height: 6, x: 73, y: 0, z: 0 }, "remove");
    const lid = feature("box", { width: 30, depth: 20, height: 3, x: 50, y: -10, z: 6 });
    const pinA = feature("cylinder", { diameter: 6.1, height: 6, x: 57, y: 0, z: 0 }, "add");
    const pinB = feature("cylinder", { diameter: 5.96, height: 6, x: 73, y: 0, z: 0 }, "add");
    const r = engine.rebuild([plate, hole, lead, body, plate2, holeA, holeB, lid, pinA, pinB] as Feature[]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(4);
    const [p1, stepped, p2, lidPart] = r.parts.map((p) => p.id);
    const one = measure([put("i1", p1, "Plate <1>"), put("i2", stepped, "Pin <1>")]);
    const f1 = measuredFit(one[0])!;
    expect(f1).toMatchObject({ kind: "overlap", round: true });
    expect(f1.amount).toBeCloseTo(0.1, 6);
    const two = measure([put("i1", p2, "Plate <1>"), put("i2", lidPart, "Lid <1>")]);
    const f2 = measuredFit(two[0])!;
    expect(f2).toMatchObject({ kind: "overlap", round: true });
    expect(f2.amount).toBeCloseTo(0.1, 6);
    const ok = judgeFits({ measured: two, intended: [{ id: "f", a: "i1", b: "i2", kind: "press", min: 0.05, max: 0.15 }], tolerance: 0.01, nameOf: () => undefined });
    expect(ok.findings[1].text).toMatch(/press fit OK — 0.1 mm on the diameter/);
  });

  it("says when a pin isn't lined up with its hole instead of judging the amount", () => {
    const p = setup();
    // The ⌀9.8 pin 0.2 off the middle of the ⌀10 hole: it overlaps the hole's side by 0.1.
    const m = measure([put("i1", p.plate, "Plate <1>"), put("i2", p.small, "Pin <1>", 0.2)]);
    expect(m).toHaveLength(1);
    expect(m[0].offAxis?.off).toBeCloseTo(0.2, 6);
    const fits = judgeFits({ measured: m, intended: [{ id: "f", a: "i1", b: "i2", kind: "press", min: 0.05, max: 0.15 }], tolerance: 0.01, nameOf: () => undefined });
    expect(fits.warnings).toBe(1);
    expect(fits.findings[1].text).toMatch(/the pin isn't lined up with the hole \(off by 0.2 mm\)/);
    expect(fits.findings[1].level).toBe("warn");
  });

  it("measures only the marked pairs when asked to", () => {
    const p = setup();
    const both = [put("i1", p.plate, "Plate <1>"), put("i2", p.small, "Pin <1>")];
    expect(engine.clashes(both, 0.01, false, FIT_RANGE, [["i1", "i9"]])).toEqual([]);
    expect(engine.clashes(both, 0.01, false, FIT_RANGE, [["i2", "i1"]])).toHaveLength(1);
  });
});

