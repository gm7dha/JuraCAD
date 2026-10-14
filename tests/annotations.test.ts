import { describe, expect, it } from "vitest";

import { centreLines, centreMarks, hatchLines, mergeSegments, placeBalloons, surfacePointNearCentre } from "../src/drawing/annotations";
import { addDrawing, parseDrawings, toggleView } from "../src/drawing/drawing";
import { sheetDxf } from "../src/drawing/export";
import { layoutSheet } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Drawing, ViewKind } from "../src/model/types";

function rectView(kind: ViewKind, w: number, h: number, extra: Partial<ViewProjection> = {}): ViewProjection {
  return { kind, visible: [[0, 0, w, 0, w, h, 0, h, 0, 0]], hidden: [], circles: [], points: [], bounds: [0, 0, w, h], ...extra };
}

const info = { designName: "D", subject: "S", date: "14/10/2026" };

describe("centre marks and lines", () => {
  it("puts one cross on each hole, sized to the biggest circle there", () => {
    const p = rectView("top", 40, 30, {
      circles: [
        { cx: 10, cy: 15, r: 3, hidden: false, full: true },
        { cx: 10, cy: 15, r: 5, hidden: false, full: true },
        { cx: 30, cy: 15, r: 0.5, hidden: false, full: true },
        { cx: 30, cy: 5, r: 4, hidden: true, full: true },
        { cx: 20, cy: 5, r: 4, hidden: false, full: false },
      ],
    });
    const marks = centreMarks(p, 1);
    expect(marks).toEqual([
      [3, 15, 17, 15],
      [10, 8, 10, 22],
    ]);
    // At 1:2 the overrun is still 2 mm on paper (4 mm in the view).
    expect(centreMarks(p, 0.5)[0]).toEqual([1, 15, 19, 15]);
  });

  it("joins centre lines on one axis and runs them past the ends", () => {
    expect(mergeSegments([[0, 0, 10, 0], [8, 0, 20, 0], [30, 0, 40, 0], [0, 5, 10, 5]], 1e-6)).toEqual([
      [0, 0, 20, 0],
      [30, 0, 40, 0],
      [0, 5, 10, 5],
    ]);
    // Pieces given back to front, and one that bridges two others.
    expect(mergeSegments([[10, 0, 0, 0], [30, 0, 20, 0], [5, 0, 25, 0]], 1e-6)).toEqual([[0, 0, 30, 0]]);
    const p = rectView("front", 40, 20, { axes: [[10, 10, 10, 20], [10, 0, 10, 10]] });
    expect(centreLines(p, 1)).toEqual([[10, -2, 10, 22]]);
  });
});

describe("section hatching", () => {
  it("fills a square with lines 45° apart, clipped to it", () => {
    // A 10 × 10 square as two triangles.
    const sq = [0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10];
    const lines = hatchLines(sq, 2);
    expect(lines.length).toBeGreaterThan(5);
    for (const [x0, y0, x1, y1] of lines) {
      // Each line runs at 45° and stays inside the square, from edge to edge (not split at the diagonal).
      expect(Math.abs(x1 - x0 - (y1 - y0))).toBeLessThan(1e-9);
      for (const v of [x0, y0, x1, y1]) {
        expect(v).toBeGreaterThan(-1e-9);
        expect(v).toBeLessThan(10 + 1e-9);
      }
      const onEdge = (x: number, y: number) => [x, y].some((v) => Math.abs(v) < 1e-9 || Math.abs(v - 10) < 1e-9);
      expect(onEdge(x0, y0) && onEdge(x1, y1)).toBe(true);
    }
    expect(hatchLines([], 2)).toEqual([]);
  });

  it("leaves holes in the cut face unhatched", () => {
    // A frame: 0–30 square less 10–20, as 8 triangles round the hole.
    const q = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];
    const frame = [...q(0, 0, 30, 10), ...q(0, 20, 30, 30), ...q(0, 10, 10, 20), ...q(20, 10, 30, 20)];
    for (const [x0, y0, x1, y1] of hatchLines(frame, 1.5)) {
      // No line passes through the middle of the hole.
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      expect(mx > 10.5 && mx < 19.5 && my > 10.5 && my < 19.5).toBe(false);
    }
  });
});

describe("balloons", () => {
  it("go just outside the view, apart from each other", () => {
    const box: [number, number, number, number] = [0, 0, 40, 20];
    const spots = placeBalloons(box, [
      [35, 15],
      [36, 15],
      [5, 5],
    ]);
    for (const [x, y] of spots) expect(x < -4 || x > 44 || y < -4 || y > 24).toBe(true);
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1])).toBeGreaterThanOrEqual(9 - 1e-9);
    // Up and to the right for the first; down and to the left for the last.
    expect(spots[0][0]).toBeGreaterThan(20);
    expect(spots[2][0]).toBeLessThan(20);
  });

  it("point at a spot on the part's surface", () => {
    // Corners of a 10 mm cube, plus one point on its top face.
    const v = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10, 5, 5, 10];
    expect(surfacePointNearCentre(v)).toEqual([5, 5, 10]);
    expect(surfacePointNearCentre([])).toBeNull();
  });
});

describe("drawing extras on the sheet", () => {
  const base = (): Drawing => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
  const holed = {
    front: rectView("front", 40, 20, { axes: [[10, 10, 10, 20]] }),
    top: rectView("top", 40, 30, { circles: [{ cx: 10, cy: 15, r: 5, hidden: false, full: true }] }),
    right: rectView("right", 30, 20),
    iso: rectView("iso", 50, 45),
    section: rectView("section", 40, 20, { cutAt: 15, cutFaces: [0, 0, 40, 0, 40, 20, 0, 0, 40, 20, 0, 20] }),
  };

  it("draws centre lines unless turned off", () => {
    const count = (d: Drawing) => layoutSheet(d, holed, info).prims.filter((p) => p.kind === "path" && p.style === "centre").length;
    expect(count(base())).toBe(3);
    expect(count({ ...base(), centreLines: false })).toBe(0);
  });

  it("adds a hatched section view, its name, and where it's cut", () => {
    const d = toggleView(base(), "section");
    const l = layoutSheet(d, holed, info);
    const section = l.views.find((v) => v.kind === "section")!;
    const iso = l.views.find((v) => v.kind === "iso")!;
    // Under the 3D view, in the same column.
    expect(section.box[3]).toBeLessThan(iso.box[1]);
    expect(section.centre[0]).toBeCloseTo(iso.centre[0] - (50 - 40) / 2 * l.scale, 9);
    const texts = l.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    expect(texts).toContain("SECTION A-A");
    expect(texts.filter((t) => t === "A")).toHaveLength(2);
    // Hatching inside the section view.
    const inside = (x: number, y: number) => x >= section.box[0] - 1e-6 && x <= section.box[2] + 1e-6 && y >= section.box[1] - 1e-6 && y <= section.box[3] + 1e-6;
    const hatch = l.prims.filter((p) => p.kind === "path" && p.style === "thin" && p.points.length === 4 && inside(p.points[0], p.points[1]) && inside(p.points[2], p.points[3]));
    expect(hatch.length).toBeGreaterThan(10);
    // The cutting line crosses the top view at y = 15 (its middle).
    const top = l.views.find((v) => v.kind === "top")!;
    const cut = l.prims.find((p) => p.kind === "path" && p.style === "centre" && p.points.length === 4 && p.points[1] === p.points[3] && p.points[0] < top.box[0]);
    expect(cut && cut.kind === "path" && cut.points[1]).toBeCloseTo((top.box[1] + top.box[3]) / 2, 9);
    // Everything still on the sheet.
    for (const v of l.views) expect(v.box[1]).toBeGreaterThan(10);
    // Saved and read back.
    const saved = parseDrawings(JSON.parse(JSON.stringify([{ ...d, sectionAt: 0.25, centreLines: false, balloons: false }])))[0];
    expect([saved.sectionAt, saved.centreLines, saved.balloons, saved.views.some((v) => v.kind === "section")]).toEqual([0.25, false, false, true]);
    expect(sheetDxf(l.prims)).toContain("\nLINE\n8\nCENTRE\n");
  });

  it("numbers the parts of an assembly with balloons", () => {
    const d = base();
    // iso view of a 50 × 45 outline; points that land inside it.
    const balloons = [
      { item: 1, at: [0, 0, 0] as [number, number, number] },
      { item: 2, at: [5, 5, 5] as [number, number, number] },
    ];
    const l = layoutSheet(d, holed, { ...info, bom: [{ item: 1, name: "Base", quantity: 1 }, { item: 2, name: "Pin", quantity: 2 }], balloons });
    const iso = l.views.find((v) => v.kind === "iso")!;
    const numbers = l.prims.filter((p) => p.kind === "text" && p.size === 3.5 && (p.text === "1" || p.text === "2") && (p.x < iso.box[0] || p.x > iso.box[2] || p.y < iso.box[1] || p.y > iso.box[3]));
    expect(numbers).toHaveLength(2);
    expect(layoutSheet({ ...d, balloons: false }, holed, { ...info, balloons }).prims.length).toBeLessThan(l.prims.length);
  });
});
