/**
 * Each sheet of a drawing can draw a different part or assembly, with its own
 * title and part number in its title block.
 */
import { describe, expect, it } from "vitest";

import { addDrawing, parseDrawings } from "../src/drawing/drawing";
import { sheetDxf, sheetSvg } from "../src/drawing/export";
import { addedSheetMessage, addPage, changePage, FIRST_PAGE, missingPartMessage, pageOf, removePage, sameSource } from "../src/drawing/pages";
import { layoutSheet, type Prim, type Projections } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Drawing } from "../src/model/types";

const bracket = { kind: "part" as const, id: "f1" };
const pin = { kind: "part" as const, id: "f2" };
const asm = { kind: "assembly" as const, id: "a1" };
const start = (): Drawing => ({ ...addDrawing(emptyDocument(), "d1", bracket).drawings![0], title: { title: "Bracket", partNumber: "BRK-1", drawnBy: "Sam" } });
const texts = (prims: Prim[]) => prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
function rectView(kind: string, w: number, h: number): ViewProjection {
  return { kind, visible: [[0, 0, w, 0, w, h, 0, h, 0, 0]], hidden: [], circles: [], points: [0, 0, w, 0, w, h, 0, h], bounds: [0, 0, w, h] };
}
const block: Projections = { front: rectView("front", 40, 20), top: rectView("top", 40, 30), right: rectView("right", 30, 20), iso: rectView("iso", 50, 45) };

describe("a sheet of another part", () => {
  it("is added with the usual views, drawing its own part, with none of sheet 1's title or part number", () => {
    const d = addPage(start(), "p2", FIRST_PAGE, pin);
    expect(d.pages).toEqual([{ id: "p2", sheet: "A4", views: ["front", "top", "right", "iso"].map((kind) => ({ id: `d1-${kind}`, kind })), source: pin }]);
    const p2 = pageOf(d, "p2");
    expect(p2.source).toEqual(pin);
    // Its title block: its own (empty) title and part number; who drew it is shared.
    expect(p2.title).toEqual({ drawnBy: "Sam" });
    // Sheet 1 is untouched.
    expect(pageOf(d, FIRST_PAGE)).toEqual(start());
    // Choosing sheet 1's part when adding is just a sheet of that part (nothing saved for it).
    expect(addPage(start(), "p2", FIRST_PAGE, bracket).pages![0].source).toBeUndefined();
  });

  it("keeps its own title and part number; the rest of the title block is shared", () => {
    let d = addPage(start(), "p2", FIRST_PAGE, pin);
    d = changePage(d, "p2", (p) => ({ ...p, title: { ...p.title, title: "Pin", partNumber: "PIN-7", material: "Brass" } }));
    expect(d.pages![0].partTitle).toEqual({ title: "Pin", partNumber: "PIN-7" });
    expect(pageOf(d, "p2").title).toEqual({ title: "Pin", drawnBy: "Sam", material: "Brass", partNumber: "PIN-7" });
    expect(d.title).toEqual({ title: "Bracket", partNumber: "BRK-1", drawnBy: "Sam", material: "Brass" });
    expect(d.source).toEqual(bracket);
    // Cleared again: nothing of its own saved (its part's name shows as the title).
    d = changePage(d, "p2", (p) => ({ ...p, title: { drawnBy: "Sam", material: "Brass" } }));
    expect(d.pages![0].partTitle).toBeUndefined();
    expect(pageOf(d, "p2").title).toEqual({ drawnBy: "Sam", material: "Brass" });
  });

  it("can choose its part from its own panel, leaving the others as they were", () => {
    // Sheet 2 starts as a sheet of sheet 1's part; choosing the assembly there makes it its own.
    let d = addPage(addPage(start(), "p2"), "p3");
    d = changePage(d, "p2", (p) => ({ ...p, source: asm }));
    expect(d.source).toEqual(bracket);
    expect(d.pages![0].source).toEqual(asm);
    // (Sheet 1's title and part number were the bracket's: the assembly's sheet doesn't take them.)
    expect(d.pages![0].partTitle).toBeUndefined();
    expect(pageOf(d, "p2").title).toEqual({ drawnBy: "Sam" });
    expect(d.title).toEqual(start().title);
    expect(pageOf(d, "p3").source).toEqual(bracket);
    // Choosing sheet 1's part again there: it follows sheet 1 again, nothing of its own saved, sheet 1's title back.
    const back = changePage(d, "p2", (p) => ({ ...p, source: bracket }));
    expect(back.pages![0]).toEqual({ id: "p2", sheet: "A4", views: [] });
    expect(sameSource(pageOf(back, "p2").source, bracket)).toBe(true);
    expect(pageOf(back, "p2").title).toEqual(start().title);
    expect(back.title).toEqual(start().title);
    // The same when it had a title of its own: that was the assembly's, so it goes too.
    const framed = changePage(d, "p2", (p) => ({ ...p, title: { ...p.title, title: "Frame" } }));
    expect(framed.pages![0].partTitle).toEqual({ title: "Frame" });
    const titled = changePage(framed, "p2", (p) => ({ ...p, source: bracket }));
    expect(titled.pages![0]).toEqual({ id: "p2", sheet: "A4", views: [] });
    expect(pageOf(titled, "p2").title).toEqual(start().title);
    expect(titled.title).toEqual(start().title);
    // Choosing another part with a new title typed at the same time keeps that title.
    const both = changePage(d, "p2", (p) => ({ ...p, source: pin, title: { ...p.title, title: "Pin" } }));
    expect(both.pages![0]).toMatchObject({ source: pin, partTitle: { title: "Pin" } });
  });

  it("a sheet of sheet 1's part shares sheet 1's title block: editing it there edits sheet 1's, as before", () => {
    let d = addPage(addPage(start(), "p2"), "p3");
    d = changePage(d, "p3", (p) => ({ ...p, title: { ...p.title, partNumber: "BRK-2", title: "Bracket mk2" } }));
    expect(d.title).toEqual({ title: "Bracket mk2", partNumber: "BRK-2", drawnBy: "Sam" });
    expect(d.pages).toEqual([
      { id: "p2", sheet: "A4", views: [] },
      { id: "p3", sheet: "A4", views: [] },
    ]);
    expect(pageOf(d, "p2").title).toEqual(d.title);
    // And from sheet 1, every such sheet follows.
    d = changePage(d, FIRST_PAGE, (p) => ({ ...p, title: { ...p.title, partNumber: "BRK-3" } }));
    expect(pageOf(d, "p3").title.partNumber).toBe("BRK-3");
    // A drawing saved before sheets had parts: editing sheet 2's title never splits it off.
    const old = parseDrawings([{ ...JSON.parse(JSON.stringify(start())), pages: [{ id: "p2", sheet: "A3", views: [{ id: "v", kind: "top" }] }] }])[0];
    const edited = changePage(old, "p2", (p) => ({ ...p, title: { ...p.title, title: "Shared" } }));
    expect(edited.pages).toEqual(old.pages);
    expect(edited.title.title).toBe("Shared");
  });

  it("says whose title block a new sheet has", () => {
    const d = start();
    expect(addedSheetMessage(d, 2, undefined, null)).toBe("Added sheet 2. Tick the views it shows in the panel on the left.");
    expect(addedSheetMessage(d, 2, bracket, "Bracket")).toBe("Added sheet 2 of Bracket, with the usual views. Its title and part number are sheet 1's.");
    expect(addedSheetMessage(d, 3, pin, "Pin")).toBe("Added sheet 3 of Pin. Its title and part number are its own: fill them in under Title block.");
    // (And that's what addPage does: a sheet of sheet 1's part shows sheet 1's title block.)
    expect(pageOf(addPage(d, "p2", FIRST_PAGE, bracket), "p2").title).toEqual(d.title);
  });

  it("names the sheet whose part has gone", () => {
    const d = addPage(addPage(start(), "p2"), "p3", FIRST_PAGE, pin);
    expect(missingPartMessage(d, "p3", true)).toBe("Sheet 3's part no longer exists — choose another in the panel on that sheet");
    expect(missingPartMessage(d, "p2", false)).toBe("Sheet 2 has nothing chosen to draw — choose a part in the panel on that sheet");
    expect(missingPartMessage(start(), FIRST_PAGE, true)).toBe("This drawing's part no longer exists — choose another in the panel on the left");
  });

  it("choosing another part on sheet 1 leaves the other sheets showing theirs", () => {
    let d = addPage(addPage(start(), "p2"), "p3", FIRST_PAGE, pin);
    d = changePage(d, FIRST_PAGE, (p) => ({ ...p, source: asm }));
    expect(d.source).toEqual(asm);
    // Sheet 2 was a sheet of the bracket: it still is, with the bracket's title and part number.
    expect(d.pages![0]).toMatchObject({ id: "p2", source: bracket, partTitle: { title: "Bracket", partNumber: "BRK-1" } });
    expect(pageOf(d, "p2").title).toEqual({ title: "Bracket", drawnBy: "Sam", partNumber: "BRK-1" });
    // Sheet 3 has its own part already: unchanged.
    expect(d.pages![1]).toEqual(addPage(addPage(start(), "p2"), "p3", FIRST_PAGE, pin).pages![1]);
  });

  it("removing sheet 1 makes sheet 2 the first, with its part and title; the others keep theirs", () => {
    let d = addPage(addPage(start(), "p2", FIRST_PAGE, pin), "p3");
    d = changePage(d, "p2", (p) => ({ ...p, title: { ...p.title, title: "Pin" } }));
    const rest = removePage(d, FIRST_PAGE);
    expect(rest.source).toEqual(pin);
    expect(rest.title).toEqual({ title: "Pin", drawnBy: "Sam" });
    expect(rest.views).toEqual(d.pages![0].views);
    // Sheet 3 was of the bracket: still is.
    expect(rest.pages).toEqual([{ id: "p3", sheet: "A4", views: [], source: bracket, partTitle: { title: "Bracket", partNumber: "BRK-1" } }]);
    expect(pageOf(rest, "p3").source).toEqual(bracket);
  });

  it("a new empty sheet added from a sheet of another part draws that part", () => {
    const d = addPage(changePage(addPage(start(), "p2", FIRST_PAGE, pin), "p2", (p) => ({ ...p, title: { ...p.title, title: "Pin" } })), "p3", "p2");
    expect(d.pages![1]).toEqual({ id: "p3", sheet: "A4", views: [], source: pin, partTitle: { title: "Pin" } });
  });

  it("is saved and opened again (a sheet with nothing chosen too)", () => {
    let d = addPage(addPage(start(), "p2", FIRST_PAGE, asm), "p3", FIRST_PAGE, null);
    d = changePage(d, "p2", (p) => ({ ...p, title: { ...p.title, title: "Frame", partNumber: "FR-1" } }));
    const read = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(read).toEqual(d);
    expect(pageOf(read, "p3").source).toBeNull();
    // Rubbish is ignored.
    const bad = parseDrawings([{ ...JSON.parse(JSON.stringify(d)), pages: [{ id: "p2", sheet: "A4", views: [], source: { kind: "car", id: 3 }, partTitle: { title: 5, partNumber: " X " } }] }])[0];
    expect(bad.pages).toEqual([{ id: "p2", sheet: "A4", views: [], partTitle: { partNumber: " X " } }]);
  });

  it("shows its own part's name, title and part number in its title block (the same in every file)", () => {
    let d = addPage(start(), "p2", FIRST_PAGE, pin);
    const info = { designName: "Design", subject: "Pin", date: "1/1/2026", sheetNo: 2, sheetCount: 2 };
    // No title of its own: the part's name.
    const plain = layoutSheet(pageOf(d, "p2"), block, info);
    expect(texts(plain.prims)).toContain("Pin");
    expect(texts(plain.prims)).not.toContain("BRK-1");
    expect(texts(plain.prims)).toContain("Sam");
    d = changePage(d, "p2", (p) => ({ ...p, title: { ...p.title, title: "Locating pin", partNumber: "PIN-7" } }));
    const own = layoutSheet(pageOf(d, "p2"), block, info);
    expect(texts(own.prims)).toContain("Locating pin");
    expect(texts(own.prims)).toContain("PIN-7");
    expect(sheetSvg(own.prims, own.size)).toContain(">PIN-7<");
    expect(sheetDxf(own.prims)).toContain("PIN-7");
    // Sheet 1 still says Bracket, BRK-1.
    const first = layoutSheet(pageOf(d, FIRST_PAGE), block, { ...info, subject: "Bracket", sheetNo: 1 });
    expect(texts(first.prims)).toContain("BRK-1");
    expect(texts(first.prims)).not.toContain("PIN-7");
  });
});
