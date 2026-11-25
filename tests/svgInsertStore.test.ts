import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { insertDrawingText } from "../src/app/sketchInsertFile";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
const square = '<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="1in" viewBox="0 0 10 10"><rect width="10" height="10"/><circle cx="5" cy="5" r="2"/><text>hi</text></svg>';

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
});

describe("Insert SVG into the open sketch", () => {
  it("adds the shapes at true size × the scale, selected, as one undo step, and says what came in", () => {
    s().setSketchOptions({ dxfScale: "2" });
    const past = s().sketch!.past.length;
    expect(insertDrawingText("svg", square)).toBe(true);
    const d = draftData();
    expect(d.curves.map((c) => c.type).sort()).toEqual(["circle", "line", "line", "line", "line"]);
    expect(s().sketch!.selection).toHaveLength(5);
    expect(s().sketch!.past.length).toBe(past + 1);
    // 1 inch × 2.
    expect(Math.max(...d.points.map((p) => p.x))).toBeCloseTo(50.8, 9);
    expect(s().sketch!.message?.text).toMatch(/Brought in 2 shapes\. It's at the size the file gives, scaled × 2\. Left out: 1 text\./);
  });

  it("a broken file or a bad scale is said plainly and changes nothing", () => {
    const before = draftData();
    expect(insertDrawingText("svg", "<html/>")).toBe(false);
    expect(s().sketch!.message?.text).toMatch(/doesn't look like an SVG/);
    s().setSketchOptions({ dxfScale: "0" });
    expect(insertDrawingText("svg", square)).toBe(false);
    expect(s().sketch!.message?.text).toMatch(/scale must be a number more than 0/);
    expect(draftData()).toBe(before);
  });

  it("Insert DXF still goes the same way", () => {
    const dxf = ["0", "SECTION", "2", "ENTITIES", "0", "CIRCLE", "10", "0", "20", "0", "40", "3", "0", "ENDSEC", "0", "EOF"].join("\n");
    expect(insertDrawingText("dxf", dxf)).toBe(true);
    expect(s().sketch!.message?.text).toMatch(/Brought in 1 shape\. The file doesn't say its units/);
  });
});
