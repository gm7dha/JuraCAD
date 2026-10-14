import { afterEach, describe, expect, it } from "vitest";

import { formatSize } from "../src/drawing/dimensions";
import { evaluate, hasUnitsOrNames } from "../src/model/expr";
import { createFeature, emptyDocument } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import {
  formatArea,
  formatLength,
  formatVolume,
  lengthNumber,
  setLengthUnit,
  showLength,
  startingLength,
  storeLength,
} from "../src/model/units";

afterEach(() => setLengthUnit("mm"));

describe("units in expressions", () => {
  it("lets a unit follow a bracket", () => {
    expect(evaluate("(1 + 1/4) in")).toEqual({ ok: true, value: 31.75 });
    expect(evaluate("(2) mm")).toEqual({ ok: true, value: 2 });
    expect(hasUnitsOrNames("2 + 3")).toBe(false);
    expect(hasUnitsOrNames("2 in")).toBe(true);
    expect(hasUnitsOrNames("wall * 2")).toBe(true);
    expect(hasUnitsOrNames("pi * 2")).toBe(false);
  });
});

describe("typing lengths in inches", () => {
  it("saves plain numbers with their unit, and shows them back as typed", () => {
    for (const typed of ["2", "0.25", "2 ", "1 + 1/4", "-3", "pi"]) {
      const stored = storeLength(typed, "in");
      expect(showLength(stored, "in")).toBe(typed);
      const plain = evaluate(typed);
      const saved = evaluate(stored);
      expect(plain.ok && saved.ok).toBe(true);
      if (plain.ok && saved.ok) expect(saved.value).toBeCloseTo(plain.value * 25.4, 6);
    }
    expect(storeLength("2", "in")).toBe("2 in");
    expect(storeLength("1 + 1/4", "in")).toBe("(1 + 1/4) in");
  });

  it("leaves alone what already has a unit or a variable, or doesn't work out", () => {
    for (const typed of ["25 mm", "1/4 in", "wall * 2", "2 +", ""]) {
      expect(storeLength(typed, "in")).toBe(typed);
      expect(showLength(typed, "in")).toBe(typed);
    }
  });

  it("shows older plain millimetre values as millimetres", () => {
    expect(showLength("20", "in")).toBe("20 mm");
    expect(showLength("0", "in")).toBe("0");
    // In millimetres nothing changes.
    expect(storeLength("20", "mm")).toBe("20");
    expect(showLength("2 in", "mm")).toBe("2 in");
  });

  it("formats sizes in the design's units", () => {
    expect(formatLength(25.4, "in")).toBe("1 in");
    expect(formatLength(12.3456, "mm")).toBe("12.346 mm");
    expect(lengthNumber(10, "in")).toBe("0.394");
    expect(formatArea(645.16, "in")).toBe("1 in²");
    expect(formatVolume(16387.064, "in")).toBe("1 in³");
    expect(startingLength(50.8, "in")).toBe("2 in");
    expect(startingLength(12.5, "mm")).toBe("12.5");
  });

  it("puts drawing sizes in inches when the design is", () => {
    setLengthUnit("in");
    expect(formatSize(25.4)).toBe("1");
    expect(formatSize(10)).toBe("0.394");
    setLengthUnit("mm");
    expect(formatSize(10)).toBe("10");
  });
});

describe("inch designs", () => {
  it("start new features at round inch sizes", () => {
    const box = defaultParams("box", "in");
    expect([box.width, box.depth, box.height, box.x]).toEqual(["1.5 in", "1.25 in", "0.8125 in", "0"]);
    expect(defaultParams("box").width).toBe("40");
    const doc = { ...emptyDocument(), units: "in" as const };
    expect(createFeature(doc, "extrude").params.draft).toBe("0");
  });

  it("are saved and opened as inch designs", () => {
    const doc = { ...emptyDocument(), units: "in" as const };
    const read = readDocumentFile(serializeDocument(doc));
    expect(read.ok && read.doc.units).toBe("in");
    const mm = readDocumentFile(serializeDocument(emptyDocument()));
    expect(mm.ok && mm.doc.units).toBeUndefined();
  });
});
