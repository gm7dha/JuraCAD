/**
 * Keys in a dimension's value box while sizes are offered after drawing (Onshape's): typing then Tab/Enter keeps a size —
 * even the one it already had —, Enter ends the offering, Esc ends the drawing too, and a tool's letter typed before
 * anything else goes to the tool keys. The store side: Enter drops the sizes not kept; one Esc stops a chain of lines.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { BOX_WORDS, couldStartName, noteTyped, offeredBoxKey } from "../src/sketch/offeredBox";
import { viewportApi } from "../src/viewport/Viewport";
import { sketchEscape } from "../src/app/sketchActions";
import type { SketchData } from "../src/sketch/types";

const s = () => useStore.getState();
const d = (): SketchData => s().editing!.draft.sketch!.data;
const m = (x: number, y: number): SketchPointer => ({ x, y, mmPerPx: 0.1, shift: false, ctrl: false });
const click = (c: SketchController, x: number, y: number) => {
  c.pointerMove(m(x, y), false);
  c.pointerDown(m(x, y));
  c.pointerUp();
};
const lines = () => d().curves.filter((k) => k.type === "line");
const sizes = () => d().constraints.filter((k) => k.type === "length").map((k) => k.id);

const offered = { offered: true, typed: false, hasNext: true };

describe("keys in an offered size's box", () => {
  it("keeps a typed size on Tab and Enter, even when it's the size already drawn", () => {
    expect(offeredBoxKey({ key: "Tab" }, { ...offered, typed: true }, [])).toBe("keepNext");
    expect(offeredBoxKey({ key: "Tab" }, { offered: true, typed: true, hasNext: false }, [])).toBe("keepClose");
    expect(offeredBoxKey({ key: "Enter" }, { ...offered, typed: true }, [])).toBe("keepClose");
    expect(offeredBoxKey({ key: "Enter" }, offered, [])).toBe("keepClose");
  });

  it("moves on with Tab without keeping when nothing was typed (and stays on the only one)", () => {
    expect(offeredBoxKey({ key: "Tab" }, offered, [])).toBe("skipNext");
    expect(offeredBoxKey({ key: "Tab" }, { offered: true, typed: false, hasNext: false }, [])).toBe("stay");
  });

  it("Esc ends the drawing in an offered box, and just closes a dimension's own box", () => {
    expect(offeredBoxKey({ key: "Escape" }, offered, [])).toBe("escape");
    expect(offeredBoxKey({ key: "Escape" }, { offered: false, typed: true, hasNext: false }, [])).toBe("cancel");
    expect(offeredBoxKey({ key: "Tab" }, { offered: false, typed: true, hasNext: false }, [])).toBe(null);
  });

  it("passes tool letters on until something's typed, but never a letter a variable (or pi) starts with", () => {
    for (const key of ["l", "c", "r", "L", "x"]) expect(offeredBoxKey({ key, shift: key === "L" }, offered, ["width"])).toBe("shortcut");
    expect(offeredBoxKey({ key: "w" }, offered, ["width"])).toBe(null);
    expect(offeredBoxKey({ key: "W" }, offered, ["width"])).toBe(null);
    expect(offeredBoxKey({ key: "p" }, offered, [])).toBe(null);
    expect(couldStartName("p", [])).toBe(true);
    // Typing has begun, the box isn't an offered one, or a modifier is held: the box keeps the key.
    expect(offeredBoxKey({ key: "l" }, { ...offered, typed: true }, [])).toBe(null);
    expect(offeredBoxKey({ key: "l" }, { offered: false, typed: false, hasNext: false }, [])).toBe(null);
    expect(offeredBoxKey({ key: "c", ctrl: true }, offered, [])).toBe(null);
    for (const key of ["4", ".", "-", "(", " "]) expect(offeredBoxKey({ key }, offered, [])).toBe(null);
  });

  it("keeps every letter once the box was clicked, so a function or any name can be typed", () => {
    for (const key of ["l", "s", "c", "r"]) expect(offeredBoxKey({ key }, { ...offered, engaged: true }, [])).toBe(null);
    // Function names don't hold letters back by themselves (they'd swallow L, C, R, A, S, T and M): only pi and variables.
    expect(BOX_WORDS).toEqual(["pi"]);
    expect(offeredBoxKey({ key: "s" }, offered, [])).toBe("shortcut");
    expect(couldStartName("s", [], ["sqrt"])).toBe(true);
    expect(couldStartName("s", [])).toBe(false);
  });
});

describe("the offering in the store", () => {
  beforeEach(() => {
    useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
    s().startSketch({ kind: "default", name: "Top" });
    viewportApi.sketch = null;
  });

  it("Enter keeps the size and ends the offering: the others go and no box opens again", () => {
    s().setSketchTool("rectangle");
    const c = new SketchController();
    c.pointerDown(m(0, 0));
    c.pointerDown(m(40, 30));
    const [w, h] = s().sketch!.provisional;
    expect([w, h].every((id) => sizes().includes(id))).toBe(true);
    s().keepOfferedDimension(w, true);
    expect(s().sketch!.provisional).toEqual([]);
    expect(s().sketch!.editingDimension).toBe(null);
    expect(sizes()).toContain(w);
    expect(sizes()).not.toContain(h);
  });

  it("Tab-kept sizes stay when Enter closes the last one", () => {
    s().setSketchTool("rectangle");
    const c = new SketchController();
    c.pointerDown(m(0, 0));
    c.pointerDown(m(40, 30));
    const [w, h] = s().sketch!.provisional;
    s().keepOfferedDimension(w);
    expect(s().sketch!.editingDimension).toBe(h);
    s().keepOfferedDimension(h, true);
    expect([w, h].every((id) => sizes().includes(id))).toBe(true);
    // A later Esc drops nothing that was kept.
    sketchEscape();
    expect([w, h].every((id) => sizes().includes(id))).toBe(true);
  });

  it("carrying on drawing keeps a size typed in its box, and never brings back one that wasn't", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    viewportApi.sketch = c;
    click(c, 0, 0);
    click(c, 30, 0);
    // Not typed: the next click drops the first line's length (it used to come back with the second line).
    click(c, 30, 20);
    expect(lines()).toHaveLength(2);
    expect(sizes()).toEqual(s().sketch!.provisional);
    // Typed (not confirmed), then the next click: the size is set and kept, and the chain goes on from the line's end.
    const [typedId] = s().sketch!.provisional;
    noteTyped(typedId, "12");
    click(c, 60, 20);
    expect(lines()).toHaveLength(3);
    const kept = d().constraints.find((k) => k.id === typedId);
    expect(kept?.value).toBe("12");
    expect(s().sketch!.provisional).not.toContain(typedId);
    // Esc never keeps what was typed.
    const [last] = s().sketch!.provisional;
    noteTyped(last, "5");
    sketchEscape();
    expect(sizes()).toEqual([typedId]);
  });

  it("one Esc with a line's length offered drops it and ends the chain", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    viewportApi.sketch = c;
    click(c, 0, 0);
    click(c, 30, 0);
    expect(s().sketch!.provisional).toHaveLength(1);
    sketchEscape();
    expect(s().sketch!.provisional).toEqual([]);
    expect(sizes()).toEqual([]);
    // The next click starts a new line rather than carrying on from the last end.
    click(c, 30, 20);
    expect(lines()).toHaveLength(1);
    expect(s().sketch!.tool).toBe("line");
    // Esc again (nothing half drawn after this… the new start point is dropped), then back to Select.
    sketchEscape();
    sketchEscape();
    expect(s().sketch!.tool).toBe("select");
  });
});
