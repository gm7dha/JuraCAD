import { describe, expect, it } from "vitest";

import { CURVE_KINDS } from "../src/model/curves";
import { RELATION_LABELS, type RelationTool } from "../src/sketch/ops";
import {
  MAIN_RELATIONS,
  MORE_RELATIONS,
  SKETCH_FAMILIES,
  SKETCH_INSERT_TOOLS,
  STUDIO_TOOLBAR,
  STUDIO_TOOLS,
  toolsIn,
  type ToolbarSlot,
} from "../src/app/toolbarLayout";

const slots = STUDIO_TOOLBAR.filter((e): e is ToolbarSlot => typeof e !== "string");

describe("Part Studio toolbar layout", () => {
  it("has every tool exactly once", () => {
    const placed = toolsIn(STUDIO_TOOLBAR);
    const twice = placed.filter((t, i) => placed.indexOf(t) !== i);
    expect(twice).toEqual([]);
    expect([...placed].sort()).toEqual([...STUDIO_TOOLS].sort());
  });

  it("offers every kind of curve", () => {
    for (const k of CURVE_KINDS) expect(toolsIn(STUDIO_TOOLBAR)).toContain(`curve:${k.kind}`);
  });

  it("keeps the everyday tools one click away", () => {
    // Their own button, or the button a group shows until another of its tools is used.
    const firsts = slots.map((s) => s.tools[0]);
    for (const t of ["sketch", "extrude", "fillet", "hole", "transform", "undo", "fit"]) expect(firsts).toContain(t);
    for (const t of ["sketch", "extrude"]) expect(slots.find((s) => s.tools.includes(t))?.tools).toEqual([t]);
  });

  it("is short enough to fit a 1280 px window", () => {
    // About 22 buttons fit with their labels; each group's ▾ costs a little more.
    expect(slots.length).toBeLessThanOrEqual(22);
  });

  it("gives every group its own remembered id and a name, and only breaks lists at their own tools", () => {
    const ids = slots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of slots) {
      expect(s.name.length).toBeGreaterThan(0);
      for (const b of s.breaks ?? []) {
        expect(s.tools).toContain(b);
        expect(s.tools[0]).not.toBe(b);
      }
    }
  });

  it("has no divider at either end or two in a row", () => {
    const marks = STUDIO_TOOLBAR.map((e) => (typeof e === "string" ? e : "slot"));
    expect(marks[0]).toBe("slot");
    expect(marks.at(-1)).toBe("slot");
    for (let i = 1; i < marks.length; i++) expect(marks[i] !== "slot" && marks[i - 1] !== "slot").toBe(false);
  });
});

describe("sketch toolbar layout", () => {
  it("puts each tool in at most one family", () => {
    const all = [...SKETCH_FAMILIES.flatMap((f) => f.tools), ...SKETCH_INSERT_TOOLS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("offers every relation exactly once", () => {
    const shown = [...MAIN_RELATIONS, ...MORE_RELATIONS];
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual((Object.keys(RELATION_LABELS) as RelationTool[]).sort());
  });
});
