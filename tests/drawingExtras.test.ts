import { describe, expect, it } from "vitest";

import { addDrawing, addRevision, numberInspections, parseDrawings, putDimension, putNote, removeDimension, setStandard, withProjection } from "../src/drawing/drawing";
import { clipToOutline, cropKeeps, cropOutline, insideOutline, parseCrop, smoothLoop, withoutCrop } from "../src/drawing/crop";
import { layoutSheet, withComma, type Prim } from "../src/drawing/sheet";
import { CsvError, parseCsv, parseTable } from "../src/drawing/tables";
import { applyTemplate, parseTemplates, putTemplate, serializeTemplates, templateFrom } from "../src/drawing/templates";
import { sheetDxf, sheetSvg } from "../src/drawing/export";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension, Drawing, ViewKind } from "../src/model/types";

function rectView(kind: ViewKind, x: number, y: number, w: number, h: number): ViewProjection {
  return { kind, visible: [[x, y, x + w, y, x + w, y + h, x, y + h, x, y]], hidden: [[x, y + h / 2, x + w, y + h / 2]], circles: [], points: [], bounds: [x, y, x + w, y + h] };
}
const block = {
  front: rectView("front", 0, 0, 40, 20),
  top: rectView("top", 0, 0, 40, 30),
  right: rectView("right", 0, 0, 30, 20),
  iso: rectView("iso", -20, -10, 50, 45),
};
const info = { designName: "Bracket design", subject: "Bracket", date: "14/10/2026" };
const newDrawing = (): Drawing => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
const texts = (prims: Prim[]) => prims.filter((p): p is Extract<Prim, { kind: "text" }> => p.kind === "text").map((p) => p.text);
const pt = (x: number, y: number, b = [0, 0, 40, 20]) => ({ at: [x, y] as [number, number], rel: [(x - b[0]) / (b[2] - b[0]), (y - b[1]) / (b[3] - b[1])] as [number, number] });

describe("crop view: clipping", () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it("keeps only the part of a line inside", () => {
    expect(clipToOutline([-5, 5, 15, 5], square)).toEqual([[0, 5, 10, 5]]);
    expect(clipToOutline([-5, -5, -1, -1], square)).toEqual([]);
    expect(clipToOutline([2, 2, 8, 8], square)).toEqual([[2, 2, 8, 8]]);
  });
  it("splits a polyline that leaves and comes back (an arc drawn as pieces)", () => {
    const arc: number[] = [];
    for (let i = 0; i <= 36; i++) arc.push(5 + 7 * Math.cos((i / 36) * 2 * Math.PI), 5 + 7 * Math.sin((i / 36) * 2 * Math.PI));
    const pieces = clipToOutline(arc, square);
    expect(pieces.length).toBe(4);
    for (const p of pieces) for (let i = 0; i < p.length; i += 2) expect(p[i] >= -1e-9 && p[i] <= 10 + 1e-9 && p[i + 1] >= -1e-9 && p[i + 1] <= 10 + 1e-9).toBe(true);
  });
  it("keeps a line lying exactly along the crop's edge", () => {
    const poly = cropOutline({ a: [0, 0], b: [0.5, 1] }, [0, 0, 40, 20]);
    // The 40 × 20 rectangle's outline: its top and bottom edges lie along the crop's.
    const kept = clipToOutline([0, 0, 40, 0, 40, 20, 0, 20, 0, 0], poly);
    const len = kept.reduce((sum, p) => sum + p.reduce((acc, _v, i) => (i >= 2 && i % 2 === 0 ? acc + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) : acc), 0), 0);
    expect(len).toBeCloseTo(20 + 20 + 20, 6);
    expect(clipToOutline([0, 20, 40, 20], poly)).toEqual([[0, 20, 20, 20]]);
  });
  it("works with a clicked outline that isn't convex, and a smooth one", () => {
    const L: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(insideOutline([7, 7], L)).toBe(false);
    expect(clipToOutline([2, 7, 9, 7], L)).toEqual([[2, 7, 4, 7]]);
    const smooth = smoothLoop(square);
    expect(smooth.length).toBe(32);
    expect(insideOutline([5, 5], smooth)).toBe(true);
  });
  it("turns fractions into the view's outline and keeps dimensions that touch it", () => {
    const poly = cropOutline({ a: [0.5, 0], b: [0, 1] }, [0, 0, 40, 20]);
    expect(poly).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ]);
    expect(cropKeeps([[30, 5]], poly)).toBe(false);
    expect(cropKeeps([[30, 5], [20, 5]], poly)).toBe(true);
    expect(cropKeeps([[30, 5]], null)).toBe(true);
  });
  it("reads crops from files carefully", () => {
    expect(parseCrop({ a: [0, 0], b: [1, 1] })).toEqual({ a: [0, 0], b: [1, 1] });
    expect(parseCrop({ a: [0, 0], b: [0, 1] })).toBeNull();
    expect(parseCrop({ points: [[0, 0], [1, 0]] })).toBeNull();
    expect(parseCrop({ points: [[0, 0], [1, 0], [1, "x"], [0, 1]], smooth: true })).toEqual({ points: [[0, 0], [1, 0], [0, 1]], smooth: true });
    expect(withoutCrop({ id: "v", crop: { a: [0, 0] as [number, number], b: [1, 1] as [number, number] } })).toEqual({ id: "v" });
  });
});

describe("crop view on the sheet", () => {
  const cropped = (d: Drawing): Drawing => ({ ...d, views: d.views.map((v) => (v.kind === "front" ? { ...v, crop: { a: [0, 0] as [number, number], b: [0.5, 1] as [number, number] } } : v)) });
  it("draws only the left half of the front view, and hides a dimension outside it", () => {
    let d = newDrawing();
    const dimIn: Dimension = { id: "in", view: "front", type: "horizontal", a: pt(0, 0), b: pt(10, 0), offset: -8 };
    const dimOut: Dimension = { id: "out", view: "front", type: "horizontal", a: pt(30, 0), b: pt(40, 0), offset: -8 };
    d = putDimension(putDimension(d, dimIn), dimOut);
    const plain = layoutSheet(d, block, info);
    const l = layoutSheet(cropped(d), block, info);
    const front = l.views.find((v) => v.key === "front")!;
    const whole = plain.views.find((v) => v.key === "front")!;
    expect(front.box[2] - front.box[0]).toBeCloseTo((whole.box[2] - whole.box[0]) / 2, 6);
    expect(l.dims.map((x) => x.id)).toEqual(["in"]);
    // Nothing of the front view's lines reaches its right half.
    const right = (whole.box[0] + whole.box[2]) / 2;
    const frontLines = l.prims.filter((p) => p.kind === "path" && p.style === "visible" && p.points.every((v, i) => (i % 2 ? v >= whole.box[1] - 1e-6 && v <= whole.box[3] + 1e-6 : v >= whole.box[0] - 1e-6 && v <= whole.box[2] + 1e-6)));
    for (const p of frontLines) if (p.kind === "path") for (let i = 0; i < p.points.length; i += 2) expect(p.points[i]).toBeLessThanOrEqual(right + 1e-6);
  });
  it("also crops the section line, a detail's circle and letter, and balloons on that view", () => {
    const base = cropped(newDrawing());
    const d: Drawing = {
      ...base,
      // (No 3D view, so the balloons go on the front view.)
      views: [...base.views.filter((v) => v.kind !== "iso"), { id: "sv", kind: "section", section: "s1" }, { id: "dv", kind: "detail", detail: "x1" }],
      sections: [{ id: "s1", letter: "A", host: "front", a: [0, 0.5], b: [1, 0.5] }],
      details: [{ id: "x1", letter: "B", host: "front", centre: [0.9, 0.5], radius: 2, zoom: 2 }],
    };
    const projections = { ...block, "section:s1": rectView("front", 0, 0, 40, 20), "detail:x1": { ...rectView("front", 34, 8, 4, 4), zoom: 2 } };
    const l = layoutSheet(d, projections, { ...info, balloons: [{ item: 1, at: [5, 0, 10] }, { item: 2, at: [35, 0, 10] }] });
    const front = l.views.find((v) => v.key === "front")!;
    // The cutting line (dashed "centre" style) stays within the crop, give or take its 5 mm overrun.
    const cutLines = l.prims.filter((p) => p.kind === "path" && p.style === "centre" && p.points.length === 4 && Math.abs(p.points[1] - p.points[3]) < 1e-6 && Math.abs(p.points[1] - (front.box[1] + front.box[3]) / 2) < 1e-6);
    expect(cutLines.length).toBe(1);
    for (const p of cutLines) if (p.kind === "path") expect(Math.max(p.points[0], p.points[2])).toBeLessThanOrEqual(front.box[2] + 5 + 1e-6);
    const t = texts(l.prims);
    // The detail's letter is outside the crop (its view's own name still says DETAIL B); balloon 2 points outside it too.
    expect(t.filter((x) => x === "B").length).toBe(0);
    expect(t).toContain("1");
    expect(t).not.toContain("2");
  });
  it("is saved with the view and reopened", () => {
    const d = cropped(newDrawing());
    const [read] = parseDrawings(JSON.parse(JSON.stringify([d])));
    expect(read).toEqual(d);
  });
});

describe("revision table", () => {
  it("adds rows with the next letter; the title block's REV follows the latest", () => {
    let d = addRevision(newDrawing(), "r1", { description: "First issue", date: "01/11/2026" });
    d = addRevision(d, "r2", { description: "Hole moved", date: "12/11/2026", by: "AB", approved: "CD" });
    expect(d.revisions!.map((r) => r.rev)).toEqual(["A", "B"]);
    const l = layoutSheet(d, block, info);
    const t = texts(l.prims);
    expect(t).toContain("BY");
    expect(t).toContain("APPROVED");
    expect(t).toContain("CD");
    const [read] = parseDrawings(JSON.parse(JSON.stringify([d])));
    expect(read.revisions).toEqual(d.revisions);
    // In the exports too.
    expect(sheetSvg(l.prims, l.size)).toContain("APPROVED");
    expect(sheetDxf(l.prims)).toContain("APPROVED");
  });
  it("keeps the old three-column table when no revision says who", () => {
    const d = addRevision(newDrawing(), "r1", { description: "First issue", date: "01/11/2026" });
    const t = texts(layoutSheet(d, block, info).prims);
    expect(t).not.toContain("BY");
    expect(t).toContain("DATE");
  });
});

describe("old drawings", () => {
  it("lay out exactly as before, and read back unchanged", () => {
    const d = newDrawing();
    const [read] = parseDrawings(JSON.parse(JSON.stringify([d])));
    expect(read).toEqual(d);
    expect(Object.keys(read)).not.toContain("standard");
    expect(Object.keys(read)).not.toContain("fields");
  });
});

describe("title block entries and templates", () => {
  it("shows the user's own entries in a row on top of the title block", () => {
    const d: Drawing = { ...newDrawing(), fields: [{ label: "Finish", value: "Anodised black" }, { label: "Checked by", value: "JS" }] };
    const l = layoutSheet(d, block, info);
    const t = texts(l.prims);
    expect(t).toContain("FINISH");
    expect(t).toContain("Anodised black");
    const [read] = parseDrawings(JSON.parse(JSON.stringify([d])));
    expect(read.fields).toEqual(d.fields);
    expect(parseDrawings([{ ...d, fields: [{ label: "", value: "x" }, 3] }])[0].fields).toBeUndefined();
  });
  it("saves a template and puts it on another drawing", () => {
    const src: Drawing = { ...setStandard(newDrawing(), "ansi"), projection: "third", sheet: "ANSI B", title: { company: "GTS", drawnBy: "Me", title: "Bracket" }, fields: [{ label: "Finish", value: "" }], decimalComma: true };
    const t = templateFrom(src, "t1", "  US shop ");
    expect(t.name).toBe("US shop");
    expect(t.title).toEqual({ company: "GTS", drawnBy: "Me" });
    const list = parseTemplates(JSON.parse(serializeTemplates([t])));
    expect(list).toEqual([t]);
    // (A hand-placed top view on sheet 2 goes back to its place when the projection changes.)
    const base = newDrawing();
    const other: Drawing = { ...base, title: { title: "Lid", material: "Oak" }, pages: [{ id: "p2", sheet: "A4", views: [{ id: "t", kind: "top", at: [50, 50] }, { id: "i", kind: "iso", at: [200, 100] }] }] };
    const out = applyTemplate(other, list[0]);
    expect([out.sheet, out.standard, out.projection, out.decimalComma]).toEqual(["ANSI B", "ansi", "third", true]);
    // (Material isn't in the template, so the drawing's stays.)
    expect(out.title).toEqual({ title: "Lid", material: "Oak", company: "GTS", drawnBy: "Me" });
    expect(out.pages![0].views).toEqual([{ id: "t", kind: "top" }, { id: "i", kind: "iso", at: [200, 100] }]);
    expect(out.fields).toEqual([{ label: "Finish", value: "" }]);
    expect(putTemplate(list, { ...t, id: "t2", name: "us SHOP", sheet: "A3" })).toEqual([{ ...t, name: "us SHOP", sheet: "A3" }]);
    expect(parseTemplates([{ id: 5 }, { id: "x", sheet: "A9" }, "junk"])).toEqual([{ id: "x", name: "My template", sheet: "A4", title: {} }]);
  });
});

describe("drawing standards", () => {
  it("the standard is its own choice: nothing moves, and choosing the one shown changes nothing", () => {
    const placed: Drawing = { ...newDrawing(), projection: "third", views: newDrawing().views.map((v) => (v.kind === "top" ? { ...v, at: [80, 150] as [number, number] } : v)) };
    expect(setStandard(placed, "iso")).toBe(placed);
    const a = setStandard(placed, "ansi");
    expect([a.standard, a.projection]).toEqual(["ansi", "third"]);
    expect(a.views).toEqual(placed.views);
    const i = setStandard({ ...a, projection: undefined }, "iso");
    expect(i.standard).toBeUndefined();
    expect(setStandard(a, "ansi")).toBe(a);
    // Inch designs start ANSI.
    const inch = addDrawing({ ...emptyDocument(), units: "in" }, "d1", null).drawings![0];
    expect([inch.standard, inch.projection, inch.sheet]).toEqual(["ansi", "third", "ANSI A"]);
  });
  it("switching projection re-places the lined-up views on every sheet, and nothing when it isn't changing", () => {
    const d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front", at: [100, 100] }, { id: "i", kind: "iso", at: [250, 150] }], pages: [{ id: "p2", sheet: "A3", views: [{ id: "r", kind: "right", at: [20, 20] }], fit: { down: true } }] };
    expect(withProjection(d, false)).toBe(d);
    const t = withProjection(d, true);
    expect(t.projection).toBe("third");
    expect(t.views).toEqual([{ id: "f", kind: "front" }, { id: "i", kind: "iso", at: [250, 150] }]);
    expect(t.pages).toEqual([{ id: "p2", sheet: "A3", views: [{ id: "r", kind: "right" }] }]);
  });
  it("ANSI writes an upright dimension's number across the sheet, in a gap in its line", () => {
    const dim: Dimension = { id: "v", view: "front", type: "vertical", a: pt(0, 0), b: pt(0, 20), offset: -8 };
    const iso = layoutSheet(putDimension(newDrawing(), dim), block, info);
    const ansi = layoutSheet(putDimension(setStandard(newDrawing(), "ansi"), dim), block, info);
    const num = (l: ReturnType<typeof layoutSheet>) => l.prims.slice(l.dims[0].from, l.dims[0].to).find((p) => p.kind === "text") as Extract<Prim, { kind: "text" }>;
    expect(num(iso).rotate).toBe(90);
    expect(num(ansi).rotate).toBeUndefined();
    const paths = (l: ReturnType<typeof layoutSheet>) => l.prims.slice(l.dims[0].from, l.dims[0].to).filter((p) => p.kind === "path").length;
    expect(paths(ansi)).toBe(paths(iso) + 1);
  });
  it("a decimal comma goes on every number the sheet works out, never on what the user typed", () => {
    const d: Drawing = { ...newDrawing(), scale: 2.5, title: { partNumber: "BRK-1.2" }, decimalComma: true, views: newDrawing().views.map((v) => (v.kind === "top" ? { ...v, scale: 1.5 } : v)) };
    const t = texts(layoutSheet(d, block, { ...info, bom: [{ item: 1, name: "Pin 2.5", quantity: 2, weight: "12.5 g" }] }).prims);
    expect(t).toContain("2,5:1");
    expect(t).toContain("SCALE 1,5:1");
    expect(t).toContain("12,5 g");
    expect(t).toContain("BRK-1.2");
    expect(t).toContain("Pin 2.5");
  });
  it("a decimal comma changes the numbers only", () => {
    expect(withComma({ kind: "text", x: 0, y: 0, text: "Ø12.5 [0.492]", size: 3, anchor: "middle" })).toMatchObject({ text: "Ø12,5 [0,492]" });
    expect(withComma({ kind: "text", x: 0, y: 0, text: "M6x1. THRU", size: 3, anchor: "middle" })).toMatchObject({ text: "M6x1. THRU" });
    const dim: Dimension = { id: "h", view: "front", type: "horizontal", a: pt(0, 0), b: pt(12.5, 0), offset: -8 };
    const l = layoutSheet({ ...putDimension(newDrawing(), dim), decimalComma: true }, block, info);
    expect(texts(l.prims.slice(l.dims[0].from, l.dims[0].to))).toContain("12,5");
  });
  it("inspection balloons keep their numbers across sheets, crops and deletes", () => {
    let d: Drawing = { ...newDrawing(), inspection: true };
    d = putDimension(d, { id: "a", view: "front", type: "horizontal", a: pt(0, 0), b: pt(10, 0), offset: -8 });
    d = putDimension(d, { id: "b", view: "front", type: "horizontal", a: pt(30, 0), b: pt(35, 0), offset: -8 });
    d = { ...d, pages: [{ id: "p2", sheet: "A4", views: [{ id: "f2", kind: "front" }], dimensions: [{ id: "c", view: "front", type: "vertical", a: pt(0, 0), b: pt(0, 20), offset: -8 }] }] };
    d = numberInspections(d);
    expect([...d.dimensions!.map((x) => x.check), d.pages![0].dimensions![0].check]).toEqual([1, 2, 3]);
    // A new one gets the next number; deleting one leaves the others alone.
    d = numberInspections(removeDimension(putDimension(d, { id: "e", view: "front", type: "vertical", a: pt(40, 0), b: pt(40, 20), offset: 8 }), "a"));
    expect(d.dimensions!.map((x) => [x.id, x.check])).toEqual([
      ["b", 2],
      ["e", 4],
    ]);
    // Cropping "b" out hides its balloon but doesn't renumber "e".
    const cropped: Drawing = { ...d, views: d.views.map((v) => (v.kind === "front" ? { ...v, crop: { a: [0.9, 0] as [number, number], b: [1.1, 1] as [number, number] } } : v)) };
    const t = texts(layoutSheet(cropped, block, info).prims);
    expect(t).toContain("4");
    expect(t).not.toContain("2");
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0].dimensions!.map((x) => x.check)).toEqual([2, 4]);
    // Off: nothing is numbered.
    expect(numberInspections({ ...d, inspection: undefined })).toEqual({ ...d, inspection: undefined });
  });
});

describe("tables from CSV", () => {
  it("reads commas, quotes, semicolons and tabs", () => {
    expect(parseCsv('Part,Qty\r\n"Bolt, M6",4\n\nNut,"4"\n')).toEqual([
      ["Part", "Qty"],
      ["Bolt, M6", "4"],
      ["Nut", "4"],
    ]);
    expect(parseCsv("a;b;c\n1,5;2;3")).toEqual([
      ["a", "b", "c"],
      ["1,5", "2", "3"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv('say ""hi""')).toEqual([['say ""hi""']]);
    expect(() => parseCsv("\n\n")).toThrow("nothing in it");
    expect(new CsvError("x") instanceof Error).toBe(true);
  });
  it("draws a table as a note and saves it", () => {
    const d = putNote(newDrawing(), { id: "t1", at: [20, 190], text: "", table: [["Part", "Qty"], ["Bolt", "4"]] });
    const l = layoutSheet(d, block, info);
    for (const w of ["Part", "Qty", "Bolt", "4"]) expect(texts(l.prims)).toContain(w);
    const box = l.notes.find((n) => n.id === "t1")!.box;
    expect(box[3] - box[1]).toBeCloseTo(12, 6);
    const [read] = parseDrawings(JSON.parse(JSON.stringify([d])));
    expect(read.notes).toEqual(d.notes);
    expect(parseTable([["a", 3, null]])).toEqual([["a", "3", ""]]);
    expect(parseTable("x")).toBeNull();
  });
});
