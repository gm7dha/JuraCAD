import { describe, expect, it } from "vitest";

import { addCircle, addDimension, addLine, addPoint, measure, relationsFor, type Placed } from "../src/sketch/ops";
import { canBeCentreline, scaledValue, setCentrelineDimension, switchRoundDimension } from "../src/sketch/dimensionKinds";
import { sketchHitsAt, sketchItemLabel, sketchMenuItems, type SketchMenuContext } from "../src/sketch/sketchMenu";
import { expressionText, keyLabel, readSketchView, relationKey, SKETCH_KEYS, SKETCH_VIEW_DEFAULTS, SKETCH_VIEW_KEY, sketchKeyFor, tiedIds, writeSketchView } from "../src/sketch/sketchView";
import { solveSketch } from "../src/sketch/solver";
import { dimensionLayout } from "../src/sketch/layout";
import { parseSketchData } from "../src/sketch/validate";
import { emptySketch } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const ctx: SketchMenuContext = { busy: false, canPaste: false, showConstraints: true, showDimensions: true, under: 0 };

function twoLines() {
  const a = addLine(emptySketch(), at(0, 0), at(10, 1));
  const b = addLine(a.sketch, at(0, 5), at(9, 7));
  return { s: b.sketch, a: a.lineId, b: b.lineId };
}

describe("relations that fit the selection", () => {
  it("two lines: parallel, perpendicular, equal and so on — not concentric or midpoint", () => {
    const { s, a, b } = twoLines();
    const r = relationsFor(s, [a, b]);
    for (const x of ["horizontal", "vertical", "parallel", "perpendicular", "equal", "fix"]) expect(r).toContain(x);
    expect(r).not.toContain("concentric");
    expect(r).not.toContain("midpoint");
    expect(r).not.toContain("coincident");
    expect(r).not.toContain("pierce");
  });

  it("two circles: equal, tangent, concentric; a point and a line: coincident, midpoint", () => {
    const c1 = addCircle(emptySketch(), at(0, 0), 3);
    const c2 = addCircle(c1.sketch, at(10, 0), 2);
    const r = relationsFor(c2.sketch, [c1.circleId, c2.circleId]);
    for (const x of ["equal", "tangent", "concentric"]) expect(r).toContain(x);
    expect(r).not.toContain("parallel");
    const l = addLine(c2.sketch, at(0, 10), at(10, 10));
    const p = addPoint(l.sketch, at(3, 15));
    const r2 = relationsFor(p.sketch, [p.pointId, l.lineId]);
    for (const x of ["coincident", "midpoint"]) expect(r2).toContain(x);
    expect(r2).not.toContain("equal");
  });

  it("nothing selected, or only a dimension: none", () => {
    const { s, a } = twoLines();
    expect(relationsFor(s, [])).toEqual([]);
    const d = addDimension(s, [a]);
    expect(relationsFor(d.sketch, [d.dimensionId])).toEqual([]);
  });
});

describe("the right-click menu", () => {
  it("lists the fitting relations with their keys, construction, edit and view choices", () => {
    const { s, a, b } = twoLines();
    const items = sketchMenuItems(s, [a, b], { ...ctx, canPaste: true, under: 2 });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Parallel");
    expect(items.find((i) => i.label === "Parallel")?.key).toBe("B");
    expect(items.find((i) => i.label === "Perpendicular")?.key).toBe("Shift+L");
    expect(labels).toContain("Make it construction");
    for (const x of ["Copy", "Paste", "Delete", "Hide constraints", "Hide dimensions", "Select other…"]) expect(labels).toContain(x);
    expect(labels).not.toContain("Finish");
    // Groups are divided.
    expect(items.filter((i) => i.divider).length).toBeGreaterThanOrEqual(3);
  });

  it("nothing selected: Finish while drawing, and the view choices", () => {
    const items = sketchMenuItems(emptySketch(), [], { ...ctx, busy: true, showDimensions: false });
    expect(items.map((i) => i.label)).toEqual(["Finish", "Hide constraints", "Show dimensions"]);
  });

  it("a circle's diameter offers the radius", () => {
    const c = addCircle(emptySketch(), at(0, 0), 3);
    const d = addDimension(c.sketch, [c.circleId]);
    expect(sketchMenuItems(d.sketch, [d.dimensionId], ctx).map((i) => i.label)).toContain("Show as a radius");
  });

  it("Select other lists what's under the pointer, points first", () => {
    const { s, a } = twoLines();
    const line = s.curves.find((c) => c.id === a)!;
    const end = line.type === "line" ? line.p1 : "";
    const hits = sketchHitsAt(s, 0.1, 0.1, 1);
    expect(hits[0]).toBe(end);
    expect(hits).toContain(a);
    expect(sketchItemLabel(s, a)).toBe("Line");
    expect(sketchItemLabel(s, end)).toBe("Point");
  });
});

describe("diameter / radius and centreline dimensions", () => {
  it("scales typed values readably", () => {
    expect(scaledValue("10", 0.5)).toBe("5");
    expect(scaledValue("1 in", 2)).toBe("2 in");
    expect(scaledValue("w + 2", 2)).toBe("(w + 2) * 2");
  });

  it("switches a diameter to a radius and back, the circle unchanged", () => {
    const c = addCircle(emptySketch(), at(0, 0), 3);
    const d = addDimension(c.sketch, [c.circleId]);
    const r = switchRoundDimension(d.sketch, d.dimensionId);
    expect(r.error).toBeUndefined();
    const k = r.sketch.constraints.find((x) => x.id === d.dimensionId)!;
    expect(k.type).toBe("radius");
    expect(Number(k.value)).toBeCloseTo(3, 6);
    expect(solveSketch(r.sketch).failing).toEqual([]);
    const back = switchRoundDimension(r.sketch, d.dimensionId).sketch.constraints.find((x) => x.id === d.dimensionId)!;
    expect(back.type).toBe("diameter");
    expect(Number(back.value)).toBeCloseTo(6, 6);
  });

  it("a point to a construction line can be measured as a diameter across it (a revolve profile's size)", () => {
    const axis = addLine(emptySketch(), at(0, -10), at(0, 10), { construction: true });
    const p = addPoint(axis.sketch, at(4, 3));
    const d = addDimension(p.sketch, [p.pointId, axis.lineId]);
    const dim = d.sketch.constraints.find((x) => x.id === d.dimensionId)!;
    expect(dim.type).toBe("pointLineDistance");
    expect(canBeCentreline(d.sketch, dim)).toBe(true);
    const on = setCentrelineDimension(d.sketch, d.dimensionId, true);
    expect(on.error).toBeUndefined();
    const k = on.sketch.constraints.find((x) => x.id === d.dimensionId)!;
    expect(k.doubled).toBe(true);
    expect(Number(k.value)).toBeCloseTo(8, 6);
    expect(measure(on.sketch, k)).toBeCloseTo(8, 6);
    // The label stays where it was.
    expect(dimensionLayout(on.sketch, k)!.label[0]).toBeCloseTo(dimensionLayout(d.sketch, dim)!.label[0], 6);
    // Solved, the point stays 4 from the axis; typing 20 puts it 10 out.
    const solved = solveSketch({ ...on.sketch, constraints: on.sketch.constraints.map((x) => (x.id === k.id ? { ...x, value: "20" } : x)) });
    const typed = solved.sketch.constraints.find((x) => x.id === k.id)!;
    expect(solved.failing).toEqual([]);
    expect(measure(solved.sketch, typed)).toBeCloseTo(20, 4);
    expect(measure(solved.sketch, { ...typed, doubled: undefined })).toBeCloseTo(10, 4);
    // Kept when the file is read back.
    expect(parseSketchData(JSON.parse(JSON.stringify(on.sketch)))!.constraints.find((x) => x.id === k.id)!.doubled).toBe(true);
    const off = setCentrelineDimension(on.sketch, d.dimensionId, false).sketch.constraints.find((x) => x.id === d.dimensionId)!;
    expect(off.doubled).toBeUndefined();
    expect(Number(off.value)).toBeCloseTo(4, 6);
  });

  it("not to a solid line", () => {
    const l = addLine(emptySketch(), at(0, -10), at(0, 10));
    const p = addPoint(l.sketch, at(4, 3));
    const d = addDimension(p.sketch, [p.pointId, l.lineId]);
    expect(setCentrelineDimension(d.sketch, d.dimensionId, true).error).toBeTruthy();
  });
});

describe("sketch view settings and keys", () => {
  it("reads and writes the settings, falling back to the usual ones", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readSketchView(storage)).toEqual(SKETCH_VIEW_DEFAULTS);
    writeSketchView(storage, { constraints: false, dimensions: true, expressions: true });
    expect(JSON.parse(store.get(SKETCH_VIEW_KEY)!)).toEqual({ constraints: false, dimensions: true, expressions: true });
    expect(readSketchView(storage)).toEqual({ constraints: false, dimensions: true, expressions: true });
    store.set(SKETCH_VIEW_KEY, "not json");
    expect(readSketchView(storage)).toEqual(SKETCH_VIEW_DEFAULTS);
    expect(readSketchView(null)).toEqual(SKETCH_VIEW_DEFAULTS);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSketchView(throwing)).toEqual(SKETCH_VIEW_DEFAULTS);
    expect(() => writeSketchView(throwing, SKETCH_VIEW_DEFAULTS)).not.toThrow();
  });

  it("shows expressions only for typed sums and variables", () => {
    expect(expressionText({ id: "a", type: "length", refs: [], value: "10" })).toBeNull();
    expect(expressionText({ id: "a", type: "length", refs: [], value: "1 in" })).toBeNull();
    expect(expressionText({ id: "a", type: "length", refs: [], value: "10 + 5" })).toBe("10 + 5");
  });

  it("lights up what a relation ties", () => {
    const { s, a, b } = twoLines();
    const withPar = { ...s, constraints: [...s.constraints, { id: "par", type: "parallel" as const, refs: [a, b] }] };
    expect(tiedIds(withPar, "par").sort()).toEqual([a, b].sort());
    expect(tiedIds(withPar, "gone")).toEqual([]);
  });

  it("keys are unique, never clash with the sketch's plain letters, and leave Shift+A free", () => {
    const taken = new Set("LRCAPDSGTOMUQHVNF".split(""));
    const seen = new Set<string>();
    for (const k of SKETCH_KEYS) {
      const label = keyLabel(k);
      expect(seen.has(label)).toBe(false);
      seen.add(label);
      if (!k.shift) expect(taken.has(label)).toBe(false);
    }
    expect(sketchKeyFor("KeyA", true)).toBeNull();
    expect(sketchKeyFor("KeyI", false)?.action).toEqual({ relation: "coincident" });
    expect(relationKey("horizontal")).toBe("H");
    expect(relationKey("symmetric")).toBe("Shift+Q");
    expect(relationKey("tangent")).toBe("");
  });
});

describe("long press in a sketch", () => {
  it("opens the menu only when asked for (Select tool), never on a triad, and Part Studios are unchanged", async () => {
    const { longPressWanted } = await import("../src/viewport/gestures");
    expect(longPressWanted({ dragEnabled: false, selectOther: true, sketching: true, onTriad: false })).toBe(false);
    expect(longPressWanted({ dragEnabled: false, selectOther: true, sketching: true, onTriad: false, sketchMenu: true })).toBe(true);
    expect(longPressWanted({ dragEnabled: false, selectOther: true, sketching: true, onTriad: true, sketchMenu: true })).toBe(false);
    expect(longPressWanted({ dragEnabled: false, selectOther: true, sketching: false, onTriad: false })).toBe(true);
    expect(longPressWanted({ dragEnabled: false, selectOther: false, sketching: false, onTriad: false })).toBe(false);
  });
});
