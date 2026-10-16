import { describe, expect, it } from "vitest";

import { clipOut, cutsFromFractions, cutsOn, putShortening, removed, removeShortening, squeeze, unsqueeze, withShortenings } from "../src/drawing/shorten";
import { dimPoint } from "../src/drawing/dimensions";
import { addDrawing, parseDrawings, putDimension } from "../src/drawing/drawing";
import { fromSheet, layoutSheet, toSheet } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Drawing } from "../src/model/types";

describe("shortened views", () => {
  const bands = cutsOn([{ axis: 0, from: 20, to: 80 }], 0);

  it("moves what's past a band back, leaving a gap", () => {
    expect(squeeze(10, bands, 4)).toBe(10);
    expect(squeeze(20, bands, 4)).toBe(20);
    expect(squeeze(80, bands, 4)).toBe(24);
    expect(squeeze(100, bands, 4)).toBe(44);
    expect(squeeze(50, bands, 4)).toBeCloseTo(22, 9);
    expect(removed(bands)).toBe(60);
  });

  it("finds where a point on the shortened view really is", () => {
    for (const v of [0, 20, 35, 80, 100, 150]) expect(unsqueeze(squeeze(v, bands, 4), bands, 4)).toBeCloseTo(v, 9);
  });

  it("merges overlapping bands and keeps them in order", () => {
    expect(cutsOn([{ axis: 0, from: 50, to: 60 }, { axis: 0, from: 10, to: 30 }, { axis: 0, from: 25, to: 40 }, { axis: 1, from: 0, to: 5 }], 0)).toEqual([
      { from: 10, to: 40 },
      { from: 50, to: 60 },
    ]);
  });

  it("takes the band out of lines, leaving the pieces either side", () => {
    // A line along X from 0 to 100, through the band 20–80.
    expect(clipOut([0, 5, 100, 5], 0, bands)).toEqual([
      [0, 5, 20, 5],
      [80, 5, 100, 5],
    ]);
    // Across the band (up and down inside it): gone.
    expect(clipOut([50, 0, 50, 10], 0, bands)).toEqual([]);
    // Clear of it: kept whole.
    expect(clipOut([0, 0, 10, 10, 15, 0], 0, bands)).toEqual([[0, 0, 10, 10, 15, 0]]);
  });

  it("reads bands saved as fractions of the view", () => {
    expect(cutsFromFractions({ bounds: [0, 0, 200, 50] }, [{ axis: "x", from: 0.75, to: 0.25 }])).toEqual([{ axis: 0, from: 50, to: 150 }]);
  });
});

describe("shortened views on the sheet", () => {
  /** A long 400 × 20 bar seen from the front. */
  const bar = (): ViewProjection => ({
    kind: "front",
    visible: [[0, 0, 400, 0, 400, 20, 0, 20, 0, 0]],
    hidden: [],
    circles: [],
    points: [0, 0, 400, 0, 400, 20, 0, 20],
    bounds: [0, 0, 400, 20],
  });
  const drawingOf = (shortened?: Drawing["shortened"]): Drawing => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
    d = { ...d, views: d.views.filter((v) => v.kind === "front"), scale: 0.5, ...(shortened ? { shortened } : {}) };
    return putDimension(d, { id: "len", view: "front", type: "horizontal", a: dimPoint([0, 0], bar()), b: dimPoint([400, 0], bar()), offset: 8 });
  };
  const info = { designName: "x", subject: "y", date: "1/1/2026" };

  it("draws the view shorter, with break lines, but the dimension shows the real length", () => {
    const whole = layoutSheet(drawingOf(), { front: bar() }, info);
    const cut = drawingOf([{ id: "s1", host: "front", axis: "x", from: 0.25, to: 0.75 }]);
    const short = layoutSheet(cut, withShortenings({ front: bar() }, cut), info);
    const width = (l: typeof whole) => l.views[0].box[2] - l.views[0].box[0];
    // 400 at 1:2 is 200 wide; less 200 taken out (100 on paper), plus a 5 mm gap.
    expect(width(whole)).toBeCloseTo(200, 6);
    expect(width(short)).toBeCloseTo(105, 6);
    const texts = (l: typeof whole) => l.prims.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text);
    expect(texts(short)).toContain("400");
    // The outline is split in two around the gap, and there are break lines.
    expect(short.prims.length).toBeGreaterThan(whole.prims.length);
    // A point past the break is found where it's drawn, and back again.
    const p = withShortenings({ front: bar() }, cut).front!;
    const s = toSheet(short.views[0], p, 0.5, 350, 10);
    const back = fromSheet(short.views[0], p, 0.5, s[0], s[1]);
    expect(back[0]).toBeCloseTo(350, 6);
    expect(back[1]).toBeCloseTo(10, 6);
  });

  it("is kept in saved drawings, and can be taken off again", () => {
    const d = putShortening(drawingOf(), { id: "s1", host: "front", axis: "y", from: 0.2, to: 0.6 });
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(back.shortened).toEqual([{ id: "s1", host: "front", axis: "y", from: 0.2, to: 0.6 }]);
    expect(removeShortening(back, "s1").shortened).toBeUndefined();
  });
});
