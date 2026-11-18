/** Import's Scale and File units, and Move / copy's Scale uniformly (pure maths). */
import { describe, expect, it } from "vitest";
import { defaultParams, resolveParams, visibleParamKeys } from "../src/model/features";
import { fileUnitMm, fileUnitOf, importScaleFactor, sizeText, stepLengthUnit } from "../src/model/importScale";
import { applyPoint, compose, invert, isClassicTransform, scaleOf, transformKeys, transformMotion, transformTriad } from "../src/model/transformMath";
import { emptyDocument, parseDocument } from "../src/model/document";
import type { Feature, ImportedFile, TransformDef } from "../src/model/types";

const mmStep = "ISO-10303-21;\nDATA;\n#5=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));\nENDSEC;";
const mStep = "DATA;\n#7 = ( LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( $, .METRE. ) );\n";
const inStep = "DATA;\n#3=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);\n#4=(CONVERSION_BASED_UNIT('INCH',#9)LENGTH_UNIT()NAMED_UNIT(#3));\n";
const step = (data: string): ImportedFile => ({ fileName: "a.step", format: "step", data, units: "mm" });
const stl = (units: "mm" | "in"): ImportedFile => ({ fileName: "a.stl", format: "stl", data: "AAAA", units });

describe("Import: scale and file units", () => {
  it("reads the units a STEP file says it's in", () => {
    expect(stepLengthUnit(mmStep)).toBe(1);
    expect(stepLengthUnit(mStep)).toBe(1000);
    expect(stepLengthUnit(inStep)).toBe(25.4);
    expect(stepLengthUnit("DATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));")).toBeNull();
    expect(fileUnitMm(step("nothing"))).toBe(1);
    expect(fileUnitOf(step(inStep))).toBe("in");
    expect(fileUnitOf(stl("in"))).toBe("in");
  });

  it("works out how much bigger the part is made", () => {
    // Nothing chosen: exactly 1, so older imports build as before.
    expect(importScaleFactor(step(mmStep), undefined)).toBe(1);
    expect(importScaleFactor(step(mmStep), undefined, 2)).toBe(2);
    // An STL read in millimetres, taken as inches: 25.4 times bigger.
    expect(importScaleFactor(stl("mm"), "in")).toBeCloseTo(25.4, 12);
    // The same units as the file: no change.
    expect(importScaleFactor(stl("in"), "in", 3)).toBe(3);
    expect(importScaleFactor(step(inStep), "in")).toBe(1);
    // A STEP file in metres read as millimetres: a thousand times smaller.
    expect(importScaleFactor(step(mStep), "mm")).toBeCloseTo(0.001, 15);
    expect(importScaleFactor(step(mmStep), "cm", 0.5)).toBeCloseTo(5, 12);
  });

  it("has a Scale box that must be more than 0 and isn't saved until typed", () => {
    expect(defaultParams("import")).toEqual({});
    const f = { id: "i", name: "Import 1", type: "import" as const, operation: "new" as const, suppressed: false, params: {} };
    expect(resolveParams(f).values.scale).toBe(1);
    expect(resolveParams({ ...f, params: { scale: "0" } }).errors.scale).toMatch(/more than 0/);
    expect(resolveParams({ ...f, params: { scale: "-2" } }).errors.scale).toMatch(/more than 0/);
    expect(resolveParams({ ...f, params: { scale: "1 / 4" } }).values.scale).toBe(0.25);
  });

  it("keeps the file units in a saved design, and leaves odd ones out", () => {
    const file = step(mmStep);
    const base: Feature = { id: "i", name: "Import 1", type: "import", operation: "new", suppressed: false, params: {}, import: file };
    const read = (f: object) => parseDocument({ ...emptyDocument(), features: [f] })!.features[0];
    expect(read(base)).toEqual(base);
    expect(read({ ...base, importUnits: "ft" }).importUnits).toBe("ft");
    expect(read({ ...base, importUnits: "furlong" }).importUnits).toBeUndefined();
  });

  it("says a size", () => {
    expect(sizeText([0, 0, 0], [120, 40, 10], (n) => String(n))).toBe("120 × 40 × 10");
  });
});

describe("Move / copy: Scale uniformly", () => {
  const t = (extra: Partial<TransformDef> = {}): TransformDef => ({ partId: "p", axis: "z", about: "centre", copy: false, mode: "scale", ...extra });

  it("scales about the part's centre, or a clicked point", () => {
    const m = transformMotion(t(), { factor: 2 }, [5, 5, 5]);
    if (typeof m === "string") throw new Error(m);
    expect(applyPoint(m, [5, 5, 5])).toEqual([5, 5, 5]);
    expect(applyPoint(m, [10, 5, 5])).toEqual([15, 5, 5]);
    const at = transformMotion(t({ triad: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } }), { factor: 3 }, [5, 5, 5]);
    if (typeof at === "string") throw new Error(at);
    expect(applyPoint(at, [1, 2, 3])).toEqual([3, 6, 9]);
    // Undone exactly.
    const back = compose(invert(m), m);
    expect(applyPoint(back, [7, -3, 2]).map((n) => Math.round(n * 1e9) / 1e9)).toEqual([7, -3, 2]);
  });

  it("refuses 0 or less, has just the Scale box and no triad, and is never the classic move", () => {
    expect(scaleOf(t(), { factor: 0 }, [0, 0, 0])).toMatch(/more than 0/);
    expect(scaleOf(t(), { factor: -1 }, [0, 0, 0])).toMatch(/more than 0/);
    expect(transformKeys(t())).toEqual(["factor"]);
    expect([...visibleParamKeys({ type: "transform", transform: t() } as Feature)]).toEqual(["factor"]);
    expect(transformTriad(t(), { factor: 2 }, [0, 0, 0])).toBeNull();
    expect(isClassicTransform(t())).toBe(false);
    // Older transforms don't save a Scale box.
    expect(defaultParams("transform").factor).toBeUndefined();
    // Read back from a file.
    const f: Feature = { id: "m", name: "Transform 1", type: "transform", operation: "new", suppressed: false, params: { factor: "2" }, transform: t() };
    expect(parseDocument({ ...emptyDocument(), features: [f] })!.features[0].transform?.mode).toBe("scale");
  });

  it("leaves a plain move's inverse exactly as before", () => {
    const m = { r: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [1, 2, 3] as [number, number, number] };
    expect(invert(m)).toEqual({ r: [0, 1, 0, -1, 0, 0, 0, 0, 1], t: [-2, 1, -3] });
  });
});
