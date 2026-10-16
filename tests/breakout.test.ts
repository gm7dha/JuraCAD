import { describe, expect, it } from "vitest";

import { addDrawing, parseDrawings } from "../src/drawing/drawing";
import { breakOutRequests, putBreakOut, removeBreakOut } from "../src/drawing/sections";
import { layoutSheet } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";

const front: ViewProjection = {
  kind: "front",
  visible: [[0, 0, 40, 0, 40, 20, 0, 20, 0, 0]],
  hidden: [],
  circles: [],
  points: [],
  bounds: [0, 0, 40, 20],
  // A broken-out cut: its outline, and the cut face at the bottom (two triangles).
  breakLines: [[10, 5, 30, 5, 30, 15, 10, 15, 10, 5]],
  cutFaces: [10, 5, 30, 5, 30, 15, 10, 5, 30, 15, 10, 15],
};

describe("broken-out views", () => {
  it("are added, changed, removed and saved, and only asked for on views on show", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "p" }).drawings![0];
    d = putBreakOut(d, { id: "b1", host: "front", a: [0.25, 0.25], b: [0.75, 0.75], depth: 10 });
    d = putBreakOut(d, { id: "b1", host: "front", a: [0.25, 0.25], b: [0.75, 0.75], depth: 12 });
    expect(d.breakouts).toEqual([{ id: "b1", host: "front", a: [0.25, 0.25], b: [0.75, 0.75], depth: 12 }]);
    expect(breakOutRequests(d)).toEqual([{ host: "front", a: [0.25, 0.25], b: [0.75, 0.75], depth: 12 }]);
    expect(breakOutRequests({ ...d, views: d.views.filter((v) => v.kind !== "front") })).toEqual([]);
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0].breakouts).toEqual(d.breakouts);
    expect(parseDrawings(JSON.parse(JSON.stringify([{ ...d, breakouts: [{ ...d.breakouts![0], depth: -1 }] }])))[0].breakouts).toBe(undefined);
    expect(removeBreakOut(d, "b1").breakouts).toBe(undefined);
  });

  it("draw the cut's outline as a thin line and hatch its floor", () => {
    const d = { ...addDrawing(emptyDocument(), "d1", { kind: "part", id: "p" }).drawings![0], views: [{ id: "f", kind: "front" as const }] };
    const l = layoutSheet(d, { front }, { designName: "D", subject: "S", date: "16/10/2026" });
    const thin = l.prims.filter((p) => p.kind === "path" && p.style === "thin");
    // The outline (5 points) and some hatching inside it.
    expect(thin.some((p) => p.kind === "path" && p.points.length === 10)).toBe(true);
    expect(thin.filter((p) => p.kind === "path" && p.points.length === 4).length).toBeGreaterThan(3);
  });
});
