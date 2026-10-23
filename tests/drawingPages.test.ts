/**
 * Drawings with several sheets, views at their own scale, and hole tables
 * that wrap into columns or are dragged out of the way.
 */
import { describe, expect, it } from "vitest";

import { addDrawing, parseDrawings, putDimension } from "../src/drawing/drawing";
import { autoDimensions } from "../src/drawing/autoDimension";
import { sheetPdf, sheetsPdf, sheetSvg, sheetDxf } from "../src/drawing/export";
import { addPage, changePage, FIRST_PAGE, knownPage, nextLetterOnAnySheet, pageIds, pageNumber, pageOf, removePage, withPage } from "../src/drawing/pages";
import { addSection } from "../src/drawing/sections";
import { holeTableShape, HOLE_BLOCK_W, layoutSheet, offSheetMessage, resizedScale, scaleView, SHEETS, viewClear, viewOnPaper, type Prim, type Projections } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument, parseDocument } from "../src/model/document";
import type { Drawing, ViewKind } from "../src/model/types";

function rectView(kind: string, w: number, h: number, extra: Partial<ViewProjection> = {}): ViewProjection {
  return { kind, visible: [[0, 0, w, 0, w, h, 0, h, 0, 0]], hidden: [], circles: [], points: [0, 0, w, 0, w, h, 0, h], bounds: [0, 0, w, h], ...extra };
}
const block: Projections = { front: rectView("front", 40, 20), top: rectView("top", 40, 30), right: rectView("right", 30, 20), iso: rectView("iso", 50, 45) };
const info = { designName: "Bracket design", subject: "Bracket", date: "14/10/2026" };
const newDrawing = (): Drawing => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
const texts = (prims: Prim[]) => prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
const overlap = (a: number[], b: number[]) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;

describe("sheets", () => {
  it("adds sheets with their own views, keeping sheet 1 as the drawing's own", () => {
    const d1 = newDrawing();
    const d2 = addPage(d1, "p2");
    expect(pageIds(d2)).toEqual([FIRST_PAGE, "p2"]);
    // Sheet 1 is untouched; sheet 2 starts empty on the same paper.
    expect(pageOf(d2, FIRST_PAGE)).toEqual(d1);
    expect(pageOf(d2, "p2").views).toEqual([]);
    expect(pageOf(d2, "p2").sheet).toBe("A4");
    // Work on sheet 2: its own views, scale and paper.
    const d3 = changePage(d2, "p2", (p) => ({ ...p, sheet: "A3", scale: 2, views: [{ id: "v", kind: "top" }] }));
    expect(d3.views).toEqual(d1.views);
    expect(d3.sheet).toBe("A4");
    expect(d3.scale).toBeUndefined();
    expect(d3.pages).toEqual([{ id: "p2", sheet: "A3", scale: 2, views: [{ id: "v", kind: "top" }] }]);
    // The title block and settings are shared: changing them on sheet 2 changes them for all.
    const d4 = changePage(d3, "p2", (p) => ({ ...p, title: { title: "Shared" }, hiddenLines: false }));
    expect(pageOf(d4, FIRST_PAGE).title).toEqual({ title: "Shared" });
    expect(pageOf(d4, FIRST_PAGE).hiddenLines).toBe(false);
    // Removing something on a sheet removes it (not just leaves sheet 1's).
    const withDim = changePage(d4, FIRST_PAGE, (p) => putDimension(p, { id: "x", view: "front", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [40, 0], rel: [1, 0] }, offset: 8 }));
    expect(withDim.dimensions).toHaveLength(1);
    expect(pageOf(withDim, "p2").dimensions).toBeUndefined();
    const balloonsOff = changePage(withDim, "p2", (p) => ({ ...p, balloons: false }));
    const back = changePage(balloonsOff, "p2", (p) => (({ balloons: _b, ...rest }) => rest)(p) as Drawing);
    expect(back.balloons).toBeUndefined();
    expect(withPage(back, "p2", pageOf(back, "p2"))).toEqual(back);
  });

  it("removes sheets: sheet 2 becomes the first when sheet 1 goes; the last one stays", () => {
    const d = changePage(addPage(addPage(newDrawing(), "p2"), "p3"), "p2", (p) => ({ ...p, views: [{ id: "s2", kind: "right" }], sheet: "A3" }));
    expect(pageNumber(d, "p3")).toBe(3);
    const noSecond = removePage(d, "p2");
    expect(pageIds(noSecond)).toEqual([FIRST_PAGE, "p3"]);
    expect(noSecond.views).toEqual(d.views);
    const noFirst = removePage(d, FIRST_PAGE);
    expect(pageIds(noFirst)).toEqual([FIRST_PAGE, "p3"]);
    expect(noFirst.views).toEqual([{ id: "s2", kind: "right" }]);
    expect(noFirst.sheet).toBe("A3");
    expect(noFirst.title).toEqual(d.title);
    const one = newDrawing();
    expect(removePage(one, FIRST_PAGE)).toBe(one);
    const single = removePage(removePage(noFirst, "p3"), FIRST_PAGE);
    expect(single.pages).toBeUndefined();
    // A sheet that's gone (after undo, say) falls back to sheet 1.
    expect(knownPage(single, "p3")).toBe(FIRST_PAGE);
  });

  it("letters sections and details across every sheet", () => {
    let d = addPage(newDrawing(), "p2");
    d = changePage(d, FIRST_PAGE, (p) => addSection(p, { id: "s1", host: "top", a: [0, 0.5], b: [1, 0.5] }));
    expect(d.sections![0].letter).toBe("A");
    expect(nextLetterOnAnySheet(d)).toBe("B");
    d = changePage(d, "p2", (p) => addSection(p, { id: "s2", host: "front", a: [0.5, 0], b: [0.5, 1], letter: nextLetterOnAnySheet(d) }));
    expect(pageOf(d, "p2").sections![0].letter).toBe("B");
    expect(nextLetterOnAnySheet(d)).toBe("C");
  });

  it("saves and opens every sheet, and old single-sheet drawings unchanged", () => {
    const old = newDrawing();
    expect(parseDrawings([old])).toEqual([old]);
    expect(parseDrawings([old])[0].pages).toBeUndefined();
    let d = addPage(old, "p2");
    d = changePage(d, "p2", (p) =>
      addSection(
        { ...p, sheet: "A3", scale: 0.5, holeTable: true, holeTableAt: [20, 200], views: [{ id: "t", kind: "top", at: [100, 100], scale: 2 }] },
        { id: "s1", host: "top", a: [0, 0.5], b: [1, 0.5] },
      ),
    );
    const doc = { ...emptyDocument(), drawings: [d] };
    const reopened = parseDocument(JSON.parse(JSON.stringify(doc)))!.drawings![0];
    expect(reopened).toEqual(d);
    // Junk is dropped: bad sheets, repeated ids, a sheet called sheet 1, sheets inside sheets.
    const [junk] = parseDrawings([{ ...old, pages: [null, { id: 3 }, { id: "p2", sheet: "B9", views: [{ id: "x", kind: "nope" }], pages: [{ id: "deep" }] }, { id: "p2" }, { id: FIRST_PAGE }] }]);
    expect(junk.pages).toEqual([{ id: "p2", sheet: "A4", views: [] }]);
  });

  it("numbers the sheets in the title block, and keeps single sheets as they were", () => {
    const one = layoutSheet(newDrawing(), block, info);
    expect(texts(one.prims)).toContain("SHEET");
    expect(texts(one.prims)).toContain("A4");
    const two = layoutSheet(newDrawing(), block, { ...info, sheetNo: 2, sheetCount: 3 });
    expect(texts(two.prims)).toContain("2 OF 3");
    expect(texts(two.prims)).toContain("SHEET A4");
    // The label shrinks to fit its box on US paper.
    const us = layoutSheet({ ...newDrawing(), sheet: "ANSI A" }, block, { ...info, sheetNo: 1, sheetCount: 2 });
    const label = us.prims.find((p) => p.kind === "text" && p.text === "SHEET ANSI A");
    expect(label && label.kind === "text" ? label.size : 0).toBeLessThan(2.2);
  });

  it("saves every sheet in one PDF, a page each at its own size", () => {
    const a = layoutSheet(newDrawing(), block, { ...info, sheetNo: 1, sheetCount: 2 });
    const b = layoutSheet({ ...newDrawing(), sheet: "A3", views: [{ id: "t", kind: "top" }] }, block, { ...info, sheetNo: 2, sheetCount: 2 });
    const pdf = new TextDecoder("latin1").decode(sheetsPdf([a, b].map((l) => ({ prims: l.prims, size: l.size }))));
    expect(pdf).toContain("/Count 2");
    expect(pdf.match(/\/Type \/Page /g)).toHaveLength(2);
    expect(pdf).toContain("/MediaBox [0 0 841.89 595.276]");
    expect(pdf).toContain("/MediaBox [0 0 1190.551 841.89]");
    expect(pdf).toContain("(1 OF 2) Tj");
    expect(pdf).toContain("(2 OF 2) Tj");
    // Its cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(pdf.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // One sheet: the same file as before.
    expect(sheetsPdf([{ prims: a.prims, size: a.size }], "x")).toEqual(sheetPdf(a.prims, a.size, "x"));
  });
});

describe("views at their own scale", () => {
  const views = (scale?: number) => [
    { id: "f", kind: "front" as ViewKind },
    { id: "t", kind: "top" as ViewKind },
    { id: "i", kind: "iso" as ViewKind, ...(scale ? { scale } : {}) },
  ];

  it("draws a view at its own scale with a note under it; the rest stay at the sheet's", () => {
    const plain = layoutSheet({ ...newDrawing(), scale: 1, views: views() }, block, info);
    const own = layoutSheet({ ...newDrawing(), scale: 1, views: views(0.5) }, block, info);
    const iso = own.views.find((v) => v.key === "iso")!;
    expect(iso.scale).toBe(0.5);
    expect(iso.box[2] - iso.box[0]).toBeCloseTo(25, 6);
    expect(iso.box[3] - iso.box[1]).toBeCloseTo(22.5, 6);
    // The others are the same size as before.
    const size = (l: typeof own, k: string) => ((b) => [b[2] - b[0], b[3] - b[1]])(l.views.find((v) => v.key === k)!.box);
    for (const k of ["front", "top"]) expect(size(own, k)).toEqual(size(plain, k));
    const note = own.prims.find((p) => p.kind === "text" && p.text === "SCALE 1:2");
    expect(note).toBeDefined();
    if (note?.kind === "text") {
      expect(note.x).toBeCloseTo((iso.box[0] + iso.box[2]) / 2, 6);
      expect(note.y).toBeLessThan(iso.box[1]);
    }
    // The title block keeps the sheet's scale.
    expect(texts(own.prims)).toContain("1:1");
    // Set to the sheet's own scale, there's nothing to say.
    const same = layoutSheet({ ...newDrawing(), scale: 0.5, views: views(0.5) }, block, info);
    expect(texts(same.prims).some((t) => t.startsWith("SCALE "))).toBe(false);
  });

  it("fits the sheet round a view's own scale, and puts its dimensions where its lines are", () => {
    const big: Projections = { front: rectView("front", 200, 100), top: rectView("top", 200, 100) };
    const d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front" }, { id: "t", kind: "top", scale: 1 }] };
    const l = layoutSheet(d, big, info);
    const top = l.views.find((v) => v.key === "top")!;
    const front = l.views.find((v) => v.key === "front")!;
    expect(top.box[2] - top.box[0]).toBeCloseTo(200, 6);
    expect(front.scale).toBe(l.scale);
    expect(l.scale).toBeLessThan(1);
    // Lined up views still line up (centres).
    expect(top.centre[0]).toBeCloseTo(front.centre[0], 6);
    const withDim = putDimension(d, { id: "w", view: "top", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [200, 0], rel: [1, 0] }, offset: -8 });
    const dl = layoutSheet(withDim, big, info);
    const placed = dl.dims[0];
    const t2 = dl.views.find((v) => v.key === "top")!;
    expect(placed.a[0]).toBeCloseTo(t2.box[0], 6);
    expect(placed.b![0]).toBeCloseTo(t2.box[2], 6);
    expect(texts(dl.prims)).toContain("200");
  });

  it("gives the sheet a sensible scale when every view has its own", () => {
    const d: Drawing = { ...newDrawing(), views: [{ id: "t", kind: "top", scale: 0.1 }] };
    const l = layoutSheet(d, block, info);
    // What the top view alone would fit at (not 100:1 just because nothing's at the sheet's scale).
    expect(l.scale).toBe(layoutSheet({ ...d, views: [{ id: "t", kind: "top" }] }, block, info).scale);
    expect(texts(l.prims)).toContain("SCALE 1:10");
  });

  it("keeps lined-up views at their own scale clear of their neighbours", () => {
    const all = (own: Record<string, number>): Drawing => ({
      ...newDrawing(),
      sheet: "A3",
      scale: 1,
      views: (["front", "top", "right", "iso"] as ViewKind[]).map((k) => ({ id: k, kind: k, ...(own[k] ? { scale: own[k] } : {}) })),
    });
    for (const own of [{ top: 5 }, { right: 5 }, { front: 5 }] as Record<string, number>[]) {
      const l = layoutSheet(all(own), block, info);
      for (const a of l.views) for (const b of l.views) if (a !== b) expect(overlap(a.box, b.box)).toBe(false);
      // Still lined up with the front.
      const at = (k: string) => l.views.find((v) => v.key === k)!;
      expect(at("top").centre[0]).toBeCloseTo(at("front").centre[0], 9);
      expect(at("right").centre[1]).toBeCloseTo(at("front").centre[1], 9);
    }
    // Third angle too.
    const third = layoutSheet({ ...all({ top: 5 }), projection: "third" }, block, info);
    for (const a of third.views) for (const b of third.views) if (a !== b) expect(overlap(a.box, b.box)).toBe(false);
  });

  it("draws a detail bigger than the view it's taken from, at that view's own scale", () => {
    const projections: Projections = { ...block, "detail:d1": { ...rectView("front", 8, 8), zoom: 2 } };
    const d: Drawing = {
      ...newDrawing(),
      sheet: "A2",
      scale: 1,
      views: [{ id: "f", kind: "front", scale: 5 }, { id: "dd", kind: "detail", detail: "d1" }],
      details: [{ id: "d1", letter: "B", host: "front", centre: [0.5, 0.5], radius: 4, zoom: 2 }],
    };
    const l = layoutSheet(d, projections, info);
    const detail = l.views.find((v) => v.key === "detail:d1")!;
    expect(detail.scale).toBe(5);
    // 8 mm across at 5 × 2 = 80 mm on paper (the host is 200 mm wide).
    expect(detail.box[2] - detail.box[0]).toBeCloseTo(80, 9);
    expect(texts(l.prims)).toContain("DETAIL B (10:1)");
    // The circle on the host matches its scale.
    for (const a of l.views) for (const b of l.views) if (a !== b) expect(overlap(a.box, b.box)).toBe(false);
  });

  it("draws a section at the scale of the view it's cut from, unless it has its own", () => {
    const projections: Projections = { ...block, "section:s1": rectView("section", 30, 20) };
    let d: Drawing = { ...newDrawing(), sheet: "A3", scale: 1, views: [{ id: "f", kind: "front" }, { id: "t", kind: "top", scale: 2 }] };
    d = addSection(d, { id: "s1", host: "top", a: [0, 0.5], b: [1, 0.5] });
    const l = layoutSheet(d, projections, info);
    const sec = l.views.find((v) => v.kind === "section")!;
    expect(sec.scale).toBe(2);
    expect(sec.box[2] - sec.box[0]).toBeCloseTo(60, 9);
    expect(texts(l.prims)).toContain("SECTION A-A  SCALE 2:1");
    // Its own scale wins.
    const own = layoutSheet({ ...d, views: d.views.map((v) => (v.kind === "section" ? { ...v, scale: 1 } : v)) }, projections, info);
    expect(own.views.find((v) => v.kind === "section")!.scale).toBe(1);
    expect(texts(own.prims)).toContain("SECTION A-A");
  });

  it("only makes room for a scale note when a view's scale differs from the sheet's", () => {
    const base: Drawing = { ...newDrawing(), scale: 1, views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }, { id: "i", kind: "iso" }] };
    const plain = layoutSheet(base, block, info);
    const same = layoutSheet({ ...base, views: base.views.map((v) => (v.kind === "top" || v.kind === "iso" ? { ...v, scale: 1 } : v)) }, block, info);
    expect(same.views.map((v) => v.box)).toEqual(plain.views.map((v) => v.box));
  });

  it("says when it's a view's own scale that doesn't fit", () => {
    const d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front", scale: 20 }, { id: "t", kind: "top" }] };
    const l = layoutSheet(d, block, info);
    expect(l.tooBig).toBe(true);
    expect(l.ownTooBig).toBe(true);
    const fine = layoutSheet({ ...d, views: [{ id: "f", kind: "front", scale: 2 }, { id: "t", kind: "top" }] }, block, info);
    expect(fine.tooBig).toBe(false);
    expect(fine.ownTooBig).toBeUndefined();
  });

  it("names a section at its own scale", () => {
    const projections: Projections = { ...block, "section:s1": rectView("section", 30, 20) };
    let d: Drawing = { ...newDrawing(), scale: 1, views: [{ id: "t", kind: "top" }] };
    d = addSection(d, { id: "s1", host: "top", a: [0, 0.5], b: [1, 0.5] });
    d = { ...d, views: d.views.map((v) => (v.kind === "section" ? { ...v, scale: 2 } : v)) };
    const l = layoutSheet(d, projections, info);
    expect(texts(l.prims)).toContain("SECTION A-A  SCALE 2:1");
    expect(l.views.find((v) => v.kind === "section")!.box[2] - l.views.find((v) => v.kind === "section")!.box[0]).toBeCloseTo(60, 6);
  });

  it("is kept in saved files (not on detail views, which have their enlargement)", () => {
    const d = { ...newDrawing(), views: [{ id: "f", kind: "front", scale: 2 }, { id: "t", kind: "top", scale: -1 }, { id: "i", kind: "iso", scale: "big" }] };
    expect(parseDrawings([d])[0].views).toEqual([{ id: "f", kind: "front", scale: 2 }, { id: "t", kind: "top" }, { id: "i", kind: "iso" }]);
  });

  it("auto dimension spaces each view's rows for its own scale", () => {
    // L-shaped front and top views (a step in each), drawn as separate edges.
    const seg = (pts: number[]) => pts.slice(0, -2).map((_, i) => (i % 2 ? null : pts.slice(i, i + 4))).filter((x): x is number[] => !!x && x.length === 4);
    const ell = [0, 0, 40, 0, 40, 10, 20, 10, 20, 20, 0, 20, 0, 0];
    const views: Projections = {
      front: { kind: "front", visible: seg(ell), hidden: [], circles: [], points: ell.slice(0, -2), bounds: [0, 0, 40, 20] },
      top: { kind: "top", visible: seg(ell), hidden: [], circles: [], points: ell.slice(0, -2), bounds: [0, 0, 40, 20] },
    };
    const keys = ["front", "top"];
    const same = autoDimensions(views, keys, [], 1, () => "x");
    const own = autoDimensions(views, keys, [], (k) => (k === "top" ? 2 : 1), () => "x");
    const offsets = (list: typeof same, view: string) => list.filter((d) => d.view === view).map((d) => d.offset);
    expect(offsets(own, "front").length).toBeGreaterThan(0);
    expect(offsets(own, "front")).toEqual(offsets(same, "front"));
    // The top view at 2:1 has its rows spaced as on a 2:1 sheet.
    expect(offsets(own, "top").length).toBeGreaterThan(0);
    expect(offsets(own, "top")).toEqual(offsets(autoDimensions(views, keys, [], 2, () => "x"), "top"));
    expect(offsets(own, "top")).not.toEqual(offsets(same, "top"));
  });
});

describe("long hole tables", () => {
  /** A 150 × 100 plate with `n` holes in rows of 10. */
  const plate = (n: number): Projections => {
    const circles = [];
    for (let i = 0; i < n; i++) circles.push({ cx: 8 + (i % 10) * 14, cy: 8 + Math.floor(i / 10) * 14, r: i % 2 ? 2 : 3, hidden: false, full: true });
    return { front: rectView("front", 150, 10), top: rectView("top", 150, 100, { circles }) };
  };
  const drawing = (extra: Partial<Drawing> = {}): Drawing => ({ ...newDrawing(), views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }], holeTable: true, ...extra });

  it("keeps a short table in one column across the title block, as before", () => {
    expect(holeTableShape(9, SHEETS.A4)).toEqual({ columns: 1, rows: 9, w: 180, h: 60, tall: false });
    expect(holeTableShape(11, SHEETS.A4).columns).toBe(1);
    const l = layoutSheet(drawing(), plate(9), info);
    expect(l.holeTable!.box[2] - l.holeTable!.box[0]).toBe(180);
  });

  it("wraps 25 holes on A4 into columns so the views still fit", () => {
    const shape = holeTableShape(25, SHEETS.A4);
    expect(shape.columns).toBe(3);
    expect(shape.rows).toBe(9);
    expect(shape.tall).toBe(false);
    const l = layoutSheet(drawing(), plate(25), info);
    expect(l.tooBig).toBe(false);
    const t = l.holeTable!.box;
    expect(t[2] - t[0]).toBe(3 * HOLE_BLOCK_W);
    // Inside the border, sitting on the title block, and clear of every view.
    expect(t[0]).toBeGreaterThan(10);
    expect(t[1]).toBeCloseTo(10 + 36, 6);
    expect(t[3]).toBeLessThan(210 - 10);
    for (const v of l.views) {
      expect(overlap(v.box, t)).toBe(false);
      expect(v.box[1]).toBeGreaterThan(t[3]);
      expect(v.box[3]).toBeLessThan(200);
    }
    // Every hole's in it once, with three headings.
    const tx = texts(l.prims);
    expect(tx.filter((x) => x === "HOLE")).toHaveLength(3);
    const tags = tx.filter((x) => /^[AB]\d+$/.test(x));
    // (Each tag twice: by its hole on the view and in the table; and "A4" a third time, the paper size.)
    expect(new Set(tags).size).toBe(25);
    expect(tags).toHaveLength(51);
  });

  it("says when a table is too long even in columns", () => {
    expect(holeTableShape(100, SHEETS.A4).tall).toBe(true);
    expect(layoutSheet(drawing(), plate(100), info).holeTable!.tall).toBe(true);
    expect(holeTableShape(100, SHEETS.A1).tall).toBe(false);
  });

  it("can be dragged anywhere, giving its room back to the views", () => {
    const fixed = layoutSheet(drawing(), plate(25), info);
    const moved = layoutSheet(drawing({ holeTableAt: [20, 120] }), plate(25), info);
    expect(moved.holeTable!.box[0]).toBe(20);
    expect(moved.holeTable!.box[3]).toBe(120);
    expect(moved.holeTable!.box[2] - moved.holeTable!.box[0]).toBe(fixed.holeTable!.box[2] - fixed.holeTable!.box[0]);
    // The views can use the room above the title block again.
    const lowest = (l: typeof fixed) => Math.min(...l.views.map((v) => v.box[1]));
    expect(lowest(moved)).toBeLessThan(lowest(fixed));
    expect(moved.scale).toBeGreaterThanOrEqual(fixed.scale);
    // Saved files keep where it went.
    expect(parseDrawings([drawing({ holeTableAt: [20, 120] })])[0].holeTableAt).toEqual([20, 120]);
    expect(parseDrawings([{ ...drawing(), holeTableAt: [1, "x"] }])[0].holeTableAt).toBeUndefined();
  });

  it("is the same in every file type", () => {
    const l = layoutSheet(drawing(), plate(25), info);
    expect(sheetSvg(l.prims, l.size)).toContain(">B12</text>");
    expect(sheetDxf(l.prims)).toContain("\nB12\n");
    expect(new TextDecoder("latin1").decode(sheetPdf(l.prims, l.size))).toContain("(B12) Tj");
  });
});

describe("the 3D view at its own scale", () => {
  const four = (iso: Partial<Drawing["views"][number]> = {}, extra: Partial<Drawing> = {}): Drawing => ({
    ...newDrawing(),
    views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }, { id: "r", kind: "right" }, { id: "i", kind: "iso", ...iso }],
    ...extra,
  });
  const box = (l: ReturnType<typeof layoutSheet>, k: string) => l.views.find((v) => v.key === k)!.box;
  const clearAll = (l: ReturnType<typeof layoutSheet>) => {
    for (const a of l.views) for (const b of l.views) if (a !== b) expect(overlap(a.box, b.box)).toBe(false);
    for (const v of l.views) expect(viewClear(l, v.key)).toBe(true);
  };

  it("draws just the 3D view bigger or smaller, noted under it, clear of the others and inside the border", () => {
    for (const sheet of ["A4", "A3"] as const)
      for (const [sheetScale, iso] of [
        [1, 2],
        [1, 0.5],
        [2, 1],
        [undefined, 2],
        [undefined, 0.5],
      ] as const) {
        const plain = layoutSheet(four({}, { sheet, ...(sheetScale ? { scale: sheetScale } : {}) }), block, info);
        const l = layoutSheet(four({ scale: iso }, { sheet, ...(sheetScale ? { scale: sheetScale } : {}) }), block, info);
        expect(l.tooBig).toBe(false);
        const b = box(l, "iso");
        // 50 × 45 at its own scale, whatever the sheet's.
        expect(b[2] - b[0]).toBeCloseTo(50 * iso, 9);
        expect(b[3] - b[1]).toBeCloseTo(45 * iso, 9);
        if (l.scale !== iso) {
          const note = l.prims.find((p) => p.kind === "text" && p.text.startsWith("SCALE "));
          expect(note?.kind === "text" && note.text).toBe(`SCALE ${iso >= 1 ? `${iso}:1` : `1:${1 / iso}`}`);
          if (note?.kind === "text") {
            expect(note.x).toBeCloseTo((b[0] + b[2]) / 2, 9);
            expect(note.y).toBeCloseTo(b[1] - 6, 9);
          }
        }
        // The other views are as they'd be at the same sheet scale.
        if (l.scale === plain.scale) for (const k of ["front", "top", "right"]) expect(box(l, k)[2] - box(l, k)[0]).toBeCloseTo(box(plain, k)[2] - box(plain, k)[0], 9);
        clearAll(l);
      }
  });

  it("fits the sheet round the 3D view's own size", () => {
    // On A4 the 3D view at the sheet's scale holds it to 1:1; drawn smaller, the rest can go up to 2:1.
    expect(layoutSheet(four(), block, info).scale).toBe(1);
    const small = layoutSheet(four({ scale: 0.5 }), block, info);
    expect(small.scale).toBe(2);
    clearAll(small);
    const big = layoutSheet(four({ scale: 2 }), block, info);
    expect(big.scale).toBe(1);
    clearAll(big);
    // Too big for the sheet at any scale: it says so, and that it's the view's own scale.
    const huge = layoutSheet(four({ scale: 5 }), block, info);
    expect(huge.tooBig).toBe(true);
    expect(huge.ownTooBig).toBe(true);
  });

  it("picks the standard scale nearest to where its corner is dragged", () => {
    const c: [number, number] = [100, 100];
    const corner: [number, number] = [125, 122.5];
    expect(resizedScale(1, c, corner, corner)).toBe(1);
    expect(resizedScale(1, c, corner, [150, 145])).toBe(2);
    expect(resizedScale(1, c, corner, [100 + 25 * 1.3, 100 + 22.5 * 1.3])).toBe(1);
    expect(resizedScale(1, c, corner, [100 + 25 * 1.6, 100 + 22.5 * 1.6])).toBe(2);
    expect(resizedScale(1, c, corner, [100 + 25 * 3.5, 100 + 22.5 * 3.5])).toBe(5);
    expect(resizedScale(2, c, corner, [100 + 25 * 0.5, 100 + 22.5 * 0.5])).toBe(1);
    expect(resizedScale(1, c, corner, [100 + 25 * 0.4, 100 + 22.5 * 0.4])).toBe(0.5);
    // Dragged right into the middle: the smallest there is, not nothing.
    expect(resizedScale(1, c, corner, c)).toBe(0.001);
    // A view with no size keeps its scale.
    expect(resizedScale(1, c, c, [200, 200])).toBe(1);
  });

  it("sets and clears a view's own scale, keeping a moved 3D view where it is while it has room", () => {
    const base = four({}, { sheet: "A3", scale: 1 });
    const set = scaleView(base, "i", 2, block, info);
    expect(set.views.find((v) => v.id === "i")).toEqual({ id: "i", kind: "iso", scale: 2 });
    expect(scaleView(set, "i", undefined, block, info).views.find((v) => v.id === "i")).toEqual({ id: "i", kind: "iso" });
    // Moved by hand into open paper: stays there at its new size.
    const moved = four({ at: [300, 230] }, { sheet: "A3", scale: 1 });
    const kept = scaleView(moved, "i", 2, block, info);
    expect(kept.views.find((v) => v.id === "i")).toEqual({ id: "i", kind: "iso", at: [300, 230], scale: 2 });
    clearAll(layoutSheet(kept, block, info));
    // Moved next to the front view: at 2:1 it would cover it, so it goes back to its own place beside the others.
    // (The lined-up views shift a little when the 3D view's size changes, so this is measured with it at 2:1:
    // 27 mm from the front view's right side to its middle — 2 mm clear at 1:1, 50 mm wide at 2:1.)
    const front = layoutSheet(four({ scale: 2 }, { sheet: "A3", scale: 1 }), block, info).views.find((v) => v.key === "front")!;
    const near = four({ at: [front.box[2] + 27, front.centre[1]] }, { sheet: "A3", scale: 1 });
    expect(viewClear(layoutSheet({ ...near, views: near.views.map((v) => (v.id === "i" ? { ...v, scale: 2 } : v)) }, block, info), "iso")).toBe(false);
    const back = scaleView(near, "i", 2, block, info);
    expect(back.views.find((v) => v.id === "i")).toEqual({ id: "i", kind: "iso", scale: 2 });
    clearAll(layoutSheet(back, block, info));
    // Near the edge of the paper: the same.
    const edge = scaleView(four({ at: [390, 260] }, { sheet: "A3", scale: 1 }), "i", 5, block, info);
    expect(edge.views.find((v) => v.id === "i")!.at).toBeUndefined();
    // Other views and settings untouched.
    expect(back.views.filter((v) => v.id !== "i")).toEqual(near.views.filter((v) => v.id !== "i"));
  });

  it("opens an old drawing laid out exactly as before", () => {
    const old = four({ at: [300, 230] }, { sheet: "A3" });
    const again = parseDrawings(JSON.parse(JSON.stringify([old])))[0];
    expect(layoutSheet(again, block, info)).toEqual(layoutSheet(old, block, info));
  });
});

describe("views off the sheet at a chosen scale", () => {
  const four = (sheet: Drawing["sheet"], scale: number | undefined, iso: Partial<Drawing["views"][number]> = {}): Drawing => ({
    ...newDrawing(),
    sheet,
    ...(scale !== undefined ? { scale } : {}),
    views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }, { id: "r", kind: "right" }, { id: "i", kind: "iso", ...iso }],
  });
  const names: Record<string, string> = { front: "Front", top: "Top", right: "Right", iso: "3D (isometric)" };
  const say = (l: ReturnType<typeof layoutSheet>) => offSheetMessage(l, (v) => names[v.key]);

  it("names a 3D view at its own scale that runs off the paper", () => {
    // A4 at 1:1, the 3D view at 5:1 (250 × 225): taller than the sheet.
    const l = layoutSheet(four("A4", 1, { scale: 5 }), block, info);
    expect(l.tooBig).toBe(false);
    expect(l.offSheet).toEqual(["iso"]);
    expect(say(l)).toBe("The 3D (isometric) view runs off the sheet at 5:1. Click it and choose a smaller scale, or choose a bigger sheet.");
  });

  it("counts sitting on the title block as off the sheet", () => {
    // A3 at 1:1, the 3D view moved to (330, 60) at 2:1: 100 × 90, from y 15 — inside the border, over the title block.
    const l = layoutSheet(four("A3", 1, { scale: 2, at: [330, 60] }), block, info);
    const iso = l.views.find((v) => v.key === "iso")!;
    expect(iso.box[1]).toBeCloseTo(15, 9);
    expect(iso.box[0]).toBeGreaterThan(10);
    expect(l.offSheet).toEqual(["iso"]);
    expect(say(l)).toBe("The 3D (isometric) view runs off the sheet at 2:1. Click it and choose a smaller scale, or choose a bigger sheet.");
    // Moved up clear of it: nothing to say (and no field at all).
    const fine = layoutSheet(four("A3", 1, { scale: 2, at: [330, 200] }), block, info);
    expect("offSheet" in fine).toBe(false);
    expect(say(fine)).toBeNull();
  });

  it("speaks of the sheet's scale when it's views at that scale that don't fit", () => {
    // At the sheet's own scale, moved onto the title block.
    const placed = layoutSheet(four("A3", 1, { at: [330, 40] }), block, info);
    expect(placed.offSheet).toEqual(["iso"]);
    expect(say(placed)).toBe("The views run off the sheet at 1:1. Choose a smaller scale (or Fit to sheet), drag them into the free space, or choose a bigger sheet.");
    // A4 at 5:1: the front, top and 3D views run off.
    const big = layoutSheet(four("A4", 5), block, info);
    expect(big.offSheet).toEqual(["front", "top", "iso"]);
    expect(say(big)).toMatch(/^The views run off the sheet at 5:1\./);
  });

  it("says nothing when they fit, and leaves Fit to sheet to its own warning", () => {
    for (const [sheet, scale, iso] of [
      ["A3", 1, 2],
      ["A4", 0.5, 2],
      ["A4", 2, 1],
      ["A3", 2, 2],
    ] as const) {
      const l = layoutSheet(four(sheet, scale, { scale: iso }), block, info);
      expect("offSheet" in l).toBe(false);
      for (const v of l.views) expect(viewOnPaper(l, v.key)).toBe(true);
    }
    const fit = layoutSheet(four("A4", undefined, { scale: 5 }), block, info);
    expect(fit.tooBig).toBe(true);
    expect("offSheet" in fit).toBe(false);
  });
});
