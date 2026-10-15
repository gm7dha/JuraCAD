import { describe, expect, it } from "vitest";

import { addDrawing, arrangeViews, parseDrawings, putNote, removeNote, removeDrawing, renameDrawing, toggleView, updateDrawing } from "../src/drawing/drawing";
import { sheetPdf, sheetSvg, textWidth } from "../src/drawing/export";
import { fitScale, layoutSheet, scaleLabel, SHEETS, toSheet } from "../src/drawing/sheet";
import { projectPoint, viewUp } from "../src/drawing/cameras";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import type { Drawing, ViewKind } from "../src/model/types";

/** A fake view of a w × h rectangle starting at (x, y). */
function rectView(kind: ViewKind, x: number, y: number, w: number, h: number): ViewProjection {
  return { kind, visible: [[x, y, x + w, y, x + w, y + h, x, y + h, x, y]], hidden: [[x, y + h / 2, x + w, y + h / 2]], circles: [], points: [], bounds: [x, y, x + w, y + h] };
}
/** Views of a 40 (X) × 30 (Y) × 20 (Z) block. */
const block = {
  front: rectView("front", 0, 0, 40, 20),
  top: rectView("top", 0, 0, 40, 30),
  right: rectView("right", 0, 0, 30, 20),
  iso: rectView("iso", -20, -10, 50, 45),
};
const info = { designName: "Bracket design", subject: "Bracket", date: "14/10/2026" };

function newDrawing(): Drawing {
  return addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
}

describe("drawing documents", () => {
  it("adds, names, renames and removes drawings", () => {
    let doc = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" });
    doc = addDrawing(doc, "d2", null);
    expect(doc.drawings!.map((d) => d.name)).toEqual(["Drawing 1", "Drawing 2"]);
    expect(doc.drawings![0].views.map((v) => v.kind)).toEqual(["front", "top", "right", "iso"]);
    doc = renameDrawing(doc, "d2", " Base plate ");
    expect(doc.drawings![1].name).toBe("Base plate");
    doc = updateDrawing(doc, "d1", (d) => ({ ...d, sheet: "A3" }));
    expect(doc.drawings![0].sheet).toBe("A3");
    expect(removeDrawing(removeDrawing(doc, "d1"), "d2").drawings).toBeUndefined();
  });

  it("shows and hides views, and puts them back in place", () => {
    let d = toggleView(newDrawing(), "iso");
    expect(d.views.map((v) => v.kind)).toEqual(["front", "top", "right"]);
    d = toggleView(d, "left");
    d = { ...d, views: d.views.map((v) => (v.kind === "front" ? { ...v, at: [100, 100] as [number, number] } : v)) };
    expect(arrangeViews(d).views.every((v) => v.at === undefined)).toBe(true);
  });

  it("saves and reopens drawings, skipping junk", () => {
    const doc = updateDrawing(addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }), "d1", (d) => ({ ...d, scale: 0.5, title: { drawnBy: "Me", notes: "Deburr all edges" } }));
    const read = readDocumentFile(serializeDocument(doc));
    expect(read.ok && read.doc.drawings).toEqual(doc.drawings);
    const junk = parseDrawings([{ id: "x", sheet: "A9", scale: -1, source: { kind: "car" }, views: [{ id: "v", kind: "sideways" }, { id: "f", kind: "front", at: [1, "a"] }] }, 3]);
    expect(junk).toHaveLength(1);
    expect([junk[0].sheet, junk[0].source, junk[0].hiddenLines]).toEqual(["A4", null, true]);
    expect(junk[0].views).toEqual([{ id: "f", kind: "front" }]);
    expect(junk[0].scale).toBeUndefined();
  });
});

describe("view directions", () => {
  it("matches the usual drawing views", () => {
    expect(projectPoint("front", [1, 2, 3])).toEqual([1, 3]);
    expect(projectPoint("top", [1, 2, 3])).toEqual([1, 2]);
    expect(projectPoint("right", [1, 2, 3])).toEqual([2, 3]);
    expect(viewUp("left")).toEqual([0, 0, 1]);
    expect(viewUp("iso")[2]).toBeGreaterThan(0);
  });
});

describe("laying out a sheet", () => {
  it("picks the biggest standard scale that fits", () => {
    expect(scaleLabel(2)).toBe("2:1");
    expect(scaleLabel(0.5)).toBe("1:2");
    // At 2:1 the four views would need 270 mm across; the A4 frame has 267.
    expect(fitScale(block, ["front", "top", "right", "iso"], "A4")).toEqual({ scale: 1, fits: true });
    expect(fitScale(block, ["front", "top", "right"], "A4")).toEqual({ scale: 2, fits: true });
    const big = { front: rectView("front", 0, 0, 900, 300), top: rectView("top", 0, 0, 900, 100) };
    expect(fitScale(big, ["front", "top"], "A4").scale).toBe(0.2);
    expect(fitScale(big, ["front", "top"], "A2").scale).toBe(0.5);
  });

  it("puts the top view below the front, and the right view to its left (first angle)", () => {
    const d = newDrawing();
    const l = layoutSheet(d, block, info);
    const at = (k: ViewKind) => l.views.find((v) => v.kind === k)!;
    expect(l.size).toEqual(SHEETS.A4);
    const front = at("front");
    const top = at("top");
    const right = at("right");
    expect(top.centre[0]).toBeCloseTo(front.centre[0], 9);
    expect(top.box[3]).toBeLessThan(front.box[1]);
    expect(right.centre[1]).toBeCloseTo(front.centre[1], 9);
    expect(right.box[2]).toBeLessThan(front.box[0]);
    expect(at("iso").box[0]).toBeGreaterThan(front.box[2]);
    // Everything inside the frame.
    for (const v of l.views) {
      expect(v.box[0]).toBeGreaterThan(10);
      expect(v.box[2]).toBeLessThan(287);
      expect(v.box[1]).toBeGreaterThan(46);
      expect(v.box[3]).toBeLessThan(200);
    }
    // Front view is 40 × 20 mm at 1:1.
    expect(l.scale).toBe(1);
    expect(front.box[2] - front.box[0]).toBeCloseTo(40, 9);
    expect(toSheet(front, block.front, l.scale, 0, 0)).toEqual([front.box[0], front.box[1]]);
  });

  it("keeps lined-up views lined up when the front view moves", () => {
    const d = newDrawing();
    const moved = { ...d, views: d.views.map((v) => (v.kind === "front" ? { ...v, at: [150, 150] as [number, number] } : v.kind === "top" ? { ...v, at: [10, 60] as [number, number] } : v)) };
    const l = layoutSheet(moved, block, info);
    const at = (k: ViewKind) => l.views.find((v) => v.kind === k)!;
    expect(at("front").centre).toEqual([150, 150]);
    expect(at("top").centre).toEqual([150, 60]);
    expect(at("right").centre[1]).toBe(150);
  });

  it("draws hidden lines only when asked, and fills in the title block", () => {
    const d = { ...newDrawing(), title: { drawnBy: "Sam", material: "Nylon", notes: "Break sharp edges\nAll sizes mm" } };
    const with_ = layoutSheet(d, block, info);
    const without = layoutSheet({ ...d, hiddenLines: false }, block, info);
    const hidden = (l: typeof with_) => l.prims.filter((p) => p.kind === "path" && p.style === "hidden").length;
    expect(hidden(with_)).toBe(4);
    expect(hidden(without)).toBe(0);
    const texts = with_.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    for (const t of ["Bracket", "Bracket design", "Sam", "Nylon", "14/10/2026", "1:1", "A4", "mm", "Break sharp edges", "NOTES"]) expect(texts).toContain(t);
  });
});

describe("drawing files", () => {
  const l = layoutSheet(newDrawing(), block, info);

  it("writes an SVG at true size", () => {
    const svg = sheetSvg(l.prims, l.size, "Bracket <drawing>");
    expect(svg).toContain('width="297mm" height="210mm" viewBox="0 0 297 210"');
    expect(svg).toContain("Bracket &lt;drawing&gt;");
    expect(svg).toContain('stroke-dasharray="3 1.5"');
  });

  it("writes a PDF that lists every byte position correctly", () => {
    const bytes = sheetPdf(l.prims, l.size, "Bracket (v2) Ø10 ±0.1");
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 841.89 595.276]");
    // Each object starts where the cross-reference table says.
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // The stream length is right.
    const m = /<< \/Length (\d+) >>\nstream\n/.exec(text)!;
    const start = m.index + m[0].length;
    expect(text.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe("\nendstream");
    // Brackets escaped, and Ø and ± as Latin-1 codes.
    expect(text).toContain("Bracket \\(v2\\) \\330" + "10 \\261" + "0.1");
    expect(textWidth("MM", 10)).toBeGreaterThan(textWidth("ii", 10));
  });
});

describe("assembly drawings", () => {
  it("show a parts list above the title block, and keep views clear of it", () => {
    const d = newDrawing();
    const bom = [
      { item: 1, name: "Base", quantity: 1 },
      { item: 2, name: "Bolt M4", quantity: 4 },
    ];
    const l = layoutSheet({ ...d, title: { notes: "Deburr" } }, block, { ...info, bom });
    const texts = l.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    for (const t of ["ITEM", "PART", "QTY", "Base", "Bolt M4", "4", "NOTES", "Deburr"]) expect(texts).toContain(t);
    // Title block (36) + parts list (3 rows of 6, plus a gap) + notes (2 lines, plus a gap) are kept free.
    const lowest = Math.min(...l.views.map((v) => v.box[1]));
    expect(lowest).toBeGreaterThanOrEqual(10 + 36 + 21 + 12 + 5 - 1e-9);
  });
});

describe("notes on the sheet", () => {
  it("are drawn line by line from their corner, kept when saved, and can be removed", () => {
    const d = putNote(newDrawing(), { id: "n1", at: [30, 150], text: "Deburr all edges\nMaterial: PLA" });
    const l = layoutSheet(d, block, info);
    const texts = l.prims.filter((p) => p.kind === "text" && (p.text === "Deburr all edges" || p.text === "Material: PLA"));
    expect(texts.length).toBe(2);
    expect(l.notes[0].id).toBe("n1");
    expect(l.notes[0].box[3]).toBe(150);
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(back.notes).toEqual([{ id: "n1", at: [30, 150], text: "Deburr all edges\nMaterial: PLA" }]);
    expect(removeNote(d, "n1").notes).toBe(undefined);
  });
});
