import { describe, expect, it } from "vitest";

import { addDetail, clipToCircle, detailProjection, removeDetail, withDetails } from "../src/drawing/details";
import { addDrawing, parseDrawings } from "../src/drawing/drawing";
import { layoutSheet } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";

const front: ViewProjection = {
  kind: "front",
  visible: [[0, 0, 40, 0, 40, 20, 0, 20, 0, 0]],
  hidden: [],
  circles: [{ cx: 35, cy: 15, r: 2, hidden: false, full: true }],
  points: [0, 0, 40, 0, 40, 20, 0, 20, 35, 15],
  bounds: [0, 0, 40, 20],
};

describe("detail views", () => {
  it("clips lines to the circle", () => {
    // A line straight through a circle of radius 5 at the origin keeps just the middle 10 mm.
    expect(clipToCircle([-20, 0, 20, 0], [0, 0], 5)).toEqual([[-5, 0, 5, 0]]);
    // A line that misses it is dropped.
    expect(clipToCircle([-20, 10, 20, 10], [0, 0], 5)).toEqual([]);
  });

  it("takes the host's lines near the circle, keeping true sizes, and is drawn bigger", () => {
    const detail = { id: "d1", letter: "B", host: "front" as const, centre: [1, 1] as [number, number], radius: 10, zoom: 2 };
    const p = detailProjection(front, detail)!;
    expect(p.bounds).toEqual([30, 10, 50, 30]);
    expect(p.zoom).toBe(2);
    // The hole is inside; the far corner (0, 0) isn't.
    expect(p.circles.length).toBe(1);
    expect(p.points.includes(0)).toBe(false);
    // On the sheet: the detail view is 2 × 20 mm across at 1 : 1, labelled with its own scale.
    let d = addDrawing(emptyDocument(), "dr", { kind: "part", id: "p" }).drawings![0];
    d = { ...d, views: [{ id: "v1", kind: "front" }], scale: 1 };
    d = addDetail(d, detail);
    const l = layoutSheet(d, withDetails({ front }, d), { designName: "x", subject: "y", date: "" });
    const v = l.views.find((x) => x.key === "detail:d1")!;
    expect(v.box[2] - v.box[0]).toBeCloseTo(40, 6);
    expect(l.prims.some((x) => x.kind === "text" && x.text === "DETAIL B (2:1)")).toBe(true);
    // Saved and opened again; removing it takes its view too.
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(back.details).toEqual([detail]);
    expect(back.views.some((x) => x.kind === "detail" && x.detail === "d1")).toBe(true);
    const gone = removeDetail(d, "d1");
    expect(gone.details).toBe(undefined);
    expect(gone.views.some((x) => x.kind === "detail")).toBe(false);
  });
});
