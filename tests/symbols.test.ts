import { describe, expect, it } from "vitest";

import { parseDrawings, putNote } from "../src/drawing/drawing";
import { sheetPdf } from "../src/drawing/export";
import { characteristicSign, describeSymbol, GDT_CHARACTERISTICS, nextDatumLetter, symbolPrims } from "../src/drawing/symbols";
import type { Drawing, DrawingNote } from "../src/model/types";

const base: Drawing = { id: "d", name: "D", source: null, sheet: "A4", hiddenLines: true, views: [], title: {} };

describe("drawing symbols", () => {
  it("draws every GD&T sign with lines only", () => {
    for (const c of GDT_CHARACTERISTICS) {
      const prims = characteristicSign(c.key, 0, 0);
      expect(prims.length).toBeGreaterThan(0);
      expect(prims.every((p) => p.kind === "path")).toBe(true);
    }
  });

  it("lays out a feature control frame in cells", () => {
    const note: DrawingNote = { id: "n", at: [50, 50], text: "", leader: [30, 40] };
    const { prims, box } = symbolPrims(note, { kind: "fcf", characteristic: "position", tolerance: "0.2", diameter: true, datums: ["A", "B", ""] });
    const texts = prims.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text);
    expect(texts).toEqual(["Ø0.2", "A", "B"]);
    expect(box[0]).toBe(50);
    expect(box[3]).toBe(50);
    expect(box[2] - box[0]).toBeGreaterThan(20);
    // A filled arrowhead where the leader points.
    expect(prims.some((p) => p.kind === "path" && p.fill && p.points.includes(30))).toBe(true);
  });

  it("datum triangle sits on the leader's end; surface finish shows Ra", () => {
    const d = symbolPrims({ at: [10, 30], leader: [13, 10] }, { kind: "datum", letter: "A" });
    expect(d.prims.some((p) => p.kind === "path" && p.fill)).toBe(true);
    expect(d.prims.some((p) => p.kind === "text" && p.text === "A")).toBe(true);
    const f = symbolPrims({ at: [10, 30] }, { kind: "finish", ra: "1.6" });
    expect(f.prims.some((p) => p.kind === "text" && p.text === "Ra 1.6")).toBe(true);
    expect(describeSymbol({ kind: "fcf", characteristic: "flatness", tolerance: "0.05", datums: [] })).toBe("Flatness 0.05");
  });

  it("picks the next free datum letter, skipping I, O and Q", () => {
    const notes = ["A", "B", "C", "D", "E", "F", "G", "H"].map((letter, i): DrawingNote => ({ id: `n${i}`, at: [0, 0], text: "", symbol: { kind: "datum", letter } }));
    expect(nextDatumLetter([])).toBe("A");
    expect(nextDatumLetter(notes)).toBe("J");
  });

  it("is saved with the drawing and goes into the PDF", () => {
    const d = putNote(base, { id: "n", at: [100, 100], text: "", symbol: { kind: "fcf", characteristic: "flatness", tolerance: "0.1", datums: [] }, leader: [80, 90] });
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(back.notes?.[0]).toEqual(d.notes?.[0]);
    // A symbol that isn't one is dropped back to plain text.
    const odd = parseDrawings([{ ...d, notes: [{ id: "x", at: [1, 1], text: "hi", symbol: { kind: "nonsense" } }] }])[0];
    expect(odd.notes?.[0]).toEqual({ id: "x", at: [1, 1], text: "hi" });
    const prims = symbolPrims(d.notes![0], d.notes![0].symbol!).prims;
    const pdf = new TextDecoder("latin1").decode(sheetPdf(prims, [297, 210]));
    expect(pdf).toContain("(0.1) Tj");
  });
});
