import { describe, expect, it } from "vitest";

import { failingFeatures, firstNew, nextOf, rollbackDrop, stepRow, stepSelection, uniqueIds } from "../src/model/featureList";
import { REMEMBERED_TYPES, rememberOptions, withRemembered } from "../src/model/lastOptions";
import { createFeature, emptyDocument } from "../src/model/document";
import type { Feature } from "../src/model/types";

const feat = (id: string, extra: Partial<Feature> = {}): Feature => ({ id, name: id, type: "box", operation: "new", suppressed: false, params: {}, ...extra });
const order = ["a", "b", "c", "d", "e"];

describe("arrow keys in the feature list", () => {
  it("steps one row, stopping at the ends", () => {
    expect(stepRow(order, "b", 1)).toBe("c");
    expect(stepRow(order, "e", 1)).toBe("e");
    expect(stepRow(order, "a", -1)).toBe("a");
    expect(stepRow(order, null, 1)).toBe("a");
    expect(stepRow(order, null, -1)).toBe("e");
    expect(stepRow(order, "gone", -1)).toBe("e");
    expect(stepRow([], "a", 1)).toBeNull();
  });

  it("moves the selection, or with Shift grows and shrinks it from where it started", () => {
    expect(stepSelection(order, "b", "b", 1, false)).toEqual({ selected: ["c"], anchor: "c", current: "c" });
    let r = stepSelection(order, "b", "b", 1, true);
    expect(r).toEqual({ selected: ["b", "c"], anchor: "b", current: "c" });
    r = stepSelection(order, r.anchor, r.current, 1, true);
    expect(r.selected).toEqual(["b", "c", "d"]);
    // Back up past the start: it now runs the other way.
    r = stepSelection(order, r.anchor, r.current, -1, true);
    r = stepSelection(order, r.anchor, r.current, -1, true);
    r = stepSelection(order, r.anchor, r.current, -1, true);
    expect(r).toEqual({ selected: ["a", "b"], anchor: "b", current: "a" });
    // A sketch listed under two parts ("Group by part"): each row once, so ↓ doesn't go round in circles.
    const grouped = ["sk1", "ex1", "sk1", "ex2", "fi1"];
    expect(uniqueIds(grouped)).toEqual(["sk1", "ex1", "ex2", "fi1"]);
    expect(stepRow(grouped, "ex1", 1)).toBe("ex2");
    expect(stepRow(grouped, "ex2", -1)).toBe("ex1");
    expect(stepSelection(grouped, "sk1", "ex1", 1, true).selected).toEqual(["sk1", "ex1", "ex2"]);
    // An anchor no longer listed: a plain step.
    expect(stepSelection(order, "zz", "c", 1, true).selected).toEqual(["d"]);
  });
});

describe("the error count", () => {
  const features = [feat("a"), feat("b"), feat("c", { suppressed: true }), feat("d"), feat("e")];
  const errors = new Set(["b", "c", "e"]);
  const failing = failingFeatures(features, (f) => errors.has(f.id));

  it("lists failed features in order, leaving out suppressed ones", () => {
    expect(failing).toEqual(["b", "e"]);
  });

  it("cycles through them from the one picked, going round", () => {
    expect(nextOf(order, failing, null)).toBe("b");
    expect(nextOf(order, failing, "b")).toBe("e");
    expect(nextOf(order, failing, "e")).toBe("b");
    // From a row that hasn't failed: the next one below it.
    expect(nextOf(order, failing, "c")).toBe("e");
    expect(nextOf(order, failing, "c", -1)).toBe("b");
    expect(nextOf(order, failing, "b", -1)).toBe("e");
    expect(nextOf(order, [], "a")).toBeNull();
  });

  it("finds a feature that has just started failing", () => {
    expect(firstNew(["b"], ["b", "e"])).toBe("e");
    expect(firstNew(["b", "e"], ["e"])).toBeNull();
    expect(firstNew([], ["d", "e"])).toBe("d");
  });
});

describe("dragging the rollback bar", () => {
  const features = [feat("a"), feat("b"), feat("c")];
  it("goes after the feature above the row it's dropped on", () => {
    expect(rollbackDrop(features, "c")).toEqual({ to: "b" });
    expect(rollbackDrop(features, "b")).toEqual({ to: "a" });
    expect(rollbackDrop(features, null)).toEqual({ to: null });
    expect("refused" in rollbackDrop(features, "a")).toBe(true);
  });
});

describe("dialogs remember their last options", () => {
  const doc = emptyDocument();
  it("starts the next fillet at the last radius", () => {
    const made = { ...createFeature(doc, "fillet"), params: { radius: "3 mm", endRadius: "0" } };
    const memory = rememberOptions({}, made);
    const next = withRemembered(createFeature(doc, "fillet"), memory);
    expect(next.params.radius).toBe("3 mm");
    // Other kinds are untouched.
    const chamfer = createFeature(doc, "chamfer");
    expect(withRemembered(chamfer, memory)).toBe(chamfer);
  });

  it("keeps an extrude's end and depth, but not an end that needs a face clicked, a variable or a thin wall", () => {
    const first = { ...createFeature(doc, "extrude"), operation: "remove" as const };
    let memory = rememberOptions({}, { ...first, params: { ...first.params, depth: "25", depth2: "width * 2", thickness: "4" }, extrude: { end: "throughAll", flip: true } });
    let next = withRemembered({ ...createFeature(doc, "extrude"), operation: "remove" }, memory);
    expect(next.extrude?.end).toBe("throughAll");
    // A new or added extrude can't go through all: it starts blind, at the remembered depth.
    const added = withRemembered({ ...createFeature(doc, "extrude"), operation: "add" }, memory);
    expect(added.extrude?.end).toBe("blind");
    expect(added.params.depth).toBe("25");
    // The side it goes is the geometry's, not a habit.
    expect(next.extrude?.flip).toBe(false);
    expect(next.params.depth).toBe("25");
    expect(next.params.depth2).toBe("10");
    expect(next.params.thickness).toBe("2");
    memory = rememberOptions(memory, { ...first, extrude: { end: "upToFace", flip: false } });
    next = withRemembered(createFeature(doc, "extrude"), memory);
    expect(next.extrude?.end).toBe("blind");
  });

  it("leaves surfaces and thin walls out of what's remembered", () => {
    const ex = { ...createFeature(doc, "extrude"), params: { depth: "40" } };
    expect(rememberOptions({}, { ...ex, surface: true })).toEqual({});
    expect(rememberOptions({}, { ...ex, thin: {} })).toEqual({});
    expect(rememberOptions({}, { ...ex, extrude: { end: "symmetric", flip: false } }).extrude?.extrude?.end).toBe("symmetric");
  });

  it("keeps a hole's kind and size, and a chamfer's type", () => {
    const hole = createFeature(doc, "hole");
    const memory = rememberOptions({}, { ...hole, hole: { ...hole.hole!, kind: "counterbore", standard: "M5", sketchRef: "s9" } });
    const next = withRemembered(createFeature(doc, "hole"), memory);
    expect(next.hole?.kind).toBe("counterbore");
    expect(next.hole?.standard).toBe("M5");
    expect(next.hole?.sketchRef).not.toBe("s9");
    const ch = rememberOptions({}, { ...createFeature(doc, "chamfer"), chamferType: "twoDistances" });
    expect(withRemembered(createFeature(doc, "chamfer"), ch).chamferType).toBe("twoDistances");
  });

  it("doesn't remember positions or kinds it shouldn't", () => {
    const circ = createFeature(doc, "circularPattern");
    const memory = rememberOptions({}, { ...circ, params: { ...circ.params, count: "8", cx: "40" } });
    const next = withRemembered(createFeature(doc, "circularPattern"), memory);
    expect(next.params.count).toBe("8");
    expect(next.params.cx).toBe("0");
    expect(REMEMBERED_TYPES).not.toContain("transform");
    const move = createFeature(doc, "transform");
    expect(rememberOptions({}, move)).toEqual({});
  });
});
