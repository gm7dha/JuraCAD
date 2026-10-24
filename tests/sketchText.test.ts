import { describe, expect, it } from "vitest";

import { FONTS } from "../src/geometry/fonts";
import type { TypefaceFont } from "../src/geometry/text";
import { matchArea, pickOf, sketchAreas } from "../src/sketch/areas";
import { addRectangle, deleteItems, dragPoint, pointPos } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import {
  addImage,
  addText,
  changeImage,
  changeText,
  DEFAULT_TEXT,
  deleteWithExtras,
  imageAt,
  keepSketchExtras,
  textAt,
  textBox,
  textContours,
} from "../src/sketch/sketchText";
import { pruneReferences } from "../src/sketch/links";
import { parseSketchData } from "../src/sketch/validate";
import { emptySketch } from "../src/sketch/types";

/** "O": a 10 × 10 square with a 5 × 5 hole (at size 10); "I": a 2 × 10 bar. Letters are 12 apart. */
const font: TypefaceFont = {
  resolution: 1000,
  boundingBox: { yMin: 0, yMax: 1000 },
  glyphs: {
    O: { ha: 1200, o: "m 0 0 l 1000 0 l 1000 1000 l 0 1000 m 250 250 l 250 750 l 750 750 l 750 250" },
    I: { ha: 1200, o: "m 0 0 l 200 0 l 200 1000 l 0 1000" },
    " ": { ha: 500 },
  },
};
FONTS.regular = font;
FONTS.bold = font;

const round = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6);

describe("sketch text", () => {
  it("hangs from a point: outlines at the anchor, the size asked", () => {
    const r = addText(emptySketch(), { x: 3, y: 4 }, { ...DEFAULT_TEXT, value: "OI", size: 10 });
    expect(r.error).toBeUndefined();
    const t = r.sketch.texts![0];
    expect(round(pointPos(r.sketch, t.anchor))).toEqual([3, 4]);
    expect(r.sketch.points.find((p) => p.id === t.anchor)?.standalone).toBe(true);
    const cs = textContours(r.sketch, t);
    expect(cs).toHaveLength(3);
    expect(textBox(r.sketch, t).map(round)).toEqual([
      [3, 4],
      [17, 4],
      [17, 14],
      [3, 14],
    ]);
  });

  it("makes closed shapes: the O with its hole, and the I", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "OI", size: 10 });
    const { regions, problems } = findRegions(r.sketch);
    expect(problems).toEqual([]);
    expect(regions).toHaveLength(2);
    const areas = regions.map((g) => g.outer.area - g.holes.reduce((s, h) => s + h.area, 0)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(20, 9);
    expect(areas[1]).toBeCloseTo(75, 9);
    // The area picker sees the same two areas (the O's hole is a hole, not an area of its own).
    const map = sketchAreas(r.sketch);
    expect(map.areas.map((a) => Math.round(a.area * 1e6) / 1e6).sort((a, b) => a - b)).toEqual([20, 25, 75]);
  });

  it("a picked letter is found again after the text moves", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "OI", size: 10 });
    const map = sketchAreas(r.sketch);
    const bar = map.areas.findIndex((a) => Math.abs(a.area - 20) < 1e-6);
    const pick = pickOf(map.areas[bar]);
    const moved = dragPoint(r.sketch, r.sketch.texts![0].anchor, 1, 2);
    const again = sketchAreas(moved);
    const i = matchArea(again, pick);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(again.areas[i].area).toBeCloseTo(20, 9);
  });

  it("construction text makes no shapes", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O", size: 10 }, true);
    expect(findRegions(r.sketch).regions).toHaveLength(0);
    expect(sketchAreas(r.sketch).areas).toHaveLength(0);
  });

  it("turned and centred on its anchor", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "I", size: 10, angle: 90, anchorAt: "centre" });
    const box = textBox(r.sketch, r.sketch.texts![0]).map(round);
    // A 2 wide × 10 tall bar, turned a quarter: 10 across, 2 up, centred on (0, 0).
    expect(box).toEqual([
      [5, -1],
      [5, 1],
      [-5, 1],
      [-5, -1],
    ]);
  });

  it("is clicked inside its box", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "OI", size: 10 });
    const id = r.sketch.texts![0].id;
    expect(textAt(r.sketch, 7, 5, 0.1)).toBe(id);
    expect(textAt(r.sketch, 14.05, 5, 0.1)).toBe(id);
    expect(textAt(r.sketch, 20, 5, 0.1)).toBeNull();
  });

  it("can be changed: words, size, font, turn", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O", size: 10 });
    const id = r.sketch.texts![0].id;
    const c = changeText(r.sketch, id, { value: "II", size: 20, angle: 45, font: "bold" });
    expect(c.error).toBeUndefined();
    expect(c.sketch.texts![0]).toMatchObject({ value: "II", size: 20, angle: 45, font: "bold" });
    expect(changeText(r.sketch, id, { value: "  " }).error).toMatch(/Type some text/);
    expect(changeText(r.sketch, id, { size: 0 }).error).toMatch(/more than 0/);
    expect(addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "" }).error).toMatch(/Type some text/);
  });

  it("switching the anchor to the middle keeps the letters where they were", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O", size: 10 });
    const t = r.sketch.texts![0];
    const before = textBox(r.sketch, t).map(round);
    const c = changeText(r.sketch, t.id, { anchorAt: "centre" });
    expect(textBox(c.sketch, c.sketch.texts![0]).map(round)).toEqual(before);
    expect(round(pointPos(c.sketch, t.anchor))).toEqual([5, 5]);
  });

  it("edits that don't know about text keep it; deleting its anchor takes it away", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O", size: 10 });
    const t = r.sketch.texts![0];
    // An edit that builds a fresh sketch from points, curves and constraints only.
    const bare = { points: r.sketch.points, curves: r.sketch.curves, constraints: r.sketch.constraints };
    const rect = addRectangle(bare, { x: 20, y: 0 }, { x: 30, y: 10 }).sketch;
    expect(rect.texts).toBeUndefined();
    const kept = keepSketchExtras(r.sketch, rect);
    expect(kept.texts).toEqual([t]);
    const gone = keepSketchExtras(r.sketch, deleteItems(r.sketch, [t.anchor]));
    expect(gone.texts).toBeUndefined();
    // Unchanged when nothing needs carrying.
    expect(keepSketchExtras(r.sketch, r.sketch)).toBe(r.sketch);
  });

  it("deleting a text takes its anchor point too, but not a point a line uses", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O", size: 10 });
    const t = r.sketch.texts![0];
    const d = deleteWithExtras(r.sketch, [t.id]);
    expect(d.texts).toBeUndefined();
    expect(d.points).toHaveLength(0);

    const rect = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 10 }).sketch;
    const corner = rect.points[0];
    const onCorner = addText(rect, { x: corner.x, y: corner.y, snap: { kind: "point", id: corner.id } }, { ...DEFAULT_TEXT, value: "O" });
    expect(onCorner.sketch.texts![0].anchor).toBe(corner.id);
    const d2 = deleteWithExtras(onCorner.sketch, [onCorner.textId]);
    expect(d2.points.some((p) => p.id === corner.id)).toBe(true);
    expect(d2.curves).toHaveLength(4);
  });

  it("is saved and read back; older sketches have no texts field", () => {
    const r = addText(emptySketch(), { x: 1, y: 2 }, { ...DEFAULT_TEXT, value: "Hi there", size: 7.5, angle: 30, font: "bold", anchorAt: "centre" });
    const back = parseSketchData(JSON.parse(JSON.stringify(r.sketch)));
    expect(back).toEqual(r.sketch);
    expect(parseSketchData({ points: [], curves: [], constraints: [] })).toEqual({ points: [], curves: [], constraints: [] });
    // Badly formed texts are left out, not the whole sketch.
    expect(parseSketchData({ points: [], curves: [], constraints: [], texts: [{ id: "t", value: "x" }] })).toEqual({ points: [], curves: [], constraints: [] });
  });

  it("closing the sketch (dropping unused references) keeps the text", () => {
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O" });
    expect(pruneReferences(r.sketch)).toBe(r.sketch);
  });
});

describe("pictures to trace over", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("is laid on the sketch at the width asked, keeping its shape", () => {
    const r = addImage(emptySketch(), png, { width: 400, height: 200 }, 100, [10, 20], "logo.png");
    expect(r.error).toBeUndefined();
    expect(r.sketch.images![0]).toMatchObject({ x: -40, y: -5, width: 100, height: 50, opacity: 0.5, name: "logo.png" });
    expect(imageAt(r.sketch, 0, 0)).toBe(r.imageId);
    expect(imageAt(r.sketch, 70, 0)).toBeNull();
    // No shapes come from a picture.
    expect(findRegions(r.sketch).regions).toHaveLength(0);
  });

  it("resizes about its middle, and can be made more see-through", () => {
    const r = addImage(emptySketch(), png, { width: 400, height: 200 }, 100);
    const c = changeImage(r.sketch, r.imageId, { width: 50, opacity: 0.25 });
    expect(c.sketch.images![0]).toMatchObject({ x: -25, y: -12.5, width: 50, height: 25, opacity: 0.25 });
    expect(changeImage(r.sketch, r.imageId, { width: -1 }).error).toMatch(/more than 0/);
    expect(addImage(emptySketch(), png, { width: 0, height: 0 }, 10).error).toMatch(/couldn't be read/);
  });

  it("is saved and read back, and deleted", () => {
    const r = addImage(emptySketch(), png, { width: 10, height: 10 }, 20);
    expect(parseSketchData(JSON.parse(JSON.stringify(r.sketch)))).toEqual(r.sketch);
    expect(parseSketchData({ ...r.sketch, images: [{ ...r.sketch.images![0], src: "javascript:alert(1)" }] })!.images).toBeUndefined();
    expect(deleteWithExtras(r.sketch, [r.imageId]).images).toBeUndefined();
  });
});

describe("box selection", () => {
  it("takes text whose box is inside (or, dragged leftwards, touched)", async () => {
    const { sketchItemsInBox, rectOf } = await import("../src/viewport/boxSelect");
    const r = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "OI", size: 10 });
    expect(sketchItemsInBox(r.sketch, rectOf(-1, -1, 15, 11), false)).toEqual([r.textId]);
    expect(sketchItemsInBox(r.sketch, rectOf(-1, -1, 5, 11), false)).toEqual([]);
    expect(sketchItemsInBox(r.sketch, rectOf(-1, -1, 5, 11), true)).toEqual([r.textId]);
  });
});
