import { describe, expect, it } from "vitest";

import { addLine, addRectangle, type Placed } from "../src/sketch/ops";
import { addSpline, offsetCurves } from "../src/sketch/tools";
import { CROSSING_NOTE, offsetCrossesItself, offsetNotes } from "../src/sketch/offsetCheck";
import { emptySketch, type SketchData } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const offsetOf = (s: SketchData) => s.constraints.find((k) => k.type === "offset")!;

describe("Offset copies that cross themselves", () => {
  it("a rectangle offset inwards: fine up to half its height, then it turns inside out (and is still made)", () => {
    // 10 × 4: inwards by more than 2, its top and bottom copies pass each other.
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    for (const [d, crossed] of [["1", false], ["1.9", false], ["2.1", true], ["3", true]] as const) {
      const o = offsetCurves(r.sketch, r.lineIds[0], { x: 5, y: 2 }, d);
      expect(o.error).toBeUndefined();
      expect(o.curveIds).toHaveLength(4);
      expect(offsetNotes(o.sketch)).toEqual(crossed ? [CROSSING_NOTE] : []);
    }
    // Outwards never crosses.
    const out = offsetCurves(r.sketch, r.lineIds[0], { x: 5, y: -1 }, "30");
    expect(out.error).toBeUndefined();
    expect(offsetNotes(out.sketch)).toEqual([]);
  });

  it("a keyhole-shaped spline offset into its neck: the two sides' copies cross", () => {
    // The neck is 8 wide.
    const sp = addSpline(emptySketch(), [at(0, 4), at(15, 4), at(25, 12), at(35, 0), at(25, -12), at(15, -4), at(0, -4)], false);
    const narrow = offsetCurves(sp.sketch, sp.splineId, { x: 5, y: 0 }, "1");
    expect(narrow.error).toBeUndefined();
    expect(offsetNotes(narrow.sketch)).toEqual([]);
    const wide = offsetCurves(sp.sketch, sp.splineId, { x: 5, y: 0 }, "5");
    expect(wide.error).toBeUndefined();
    expect(offsetCrossesItself(wide.sketch, offsetOf(wide.sketch))).toBe(true);
    expect(offsetNotes(wide.sketch)).toEqual([CROSSING_NOTE]);
  });

  it("finds two copies crossing each other away from where they join", () => {
    // Two originals and copies, by hand: the copies cross at (5, 5), each running the same way as its original.
    const s: SketchData = {
      points: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 10 },
        { id: "c", x: 0, y: 10 },
        { id: "d", x: 10, y: 0 },
        { id: "e", x: 0, y: 20 },
        { id: "f", x: 10, y: 30 },
        { id: "g", x: 0, y: 30 },
        { id: "h", x: 10, y: 20 },
      ],
      curves: [
        { id: "c1", type: "line", p1: "a", p2: "b", construction: false },
        { id: "c2", type: "line", p1: "c", p2: "d", construction: false },
        { id: "o1", type: "line", p1: "e", p2: "f", construction: false },
        { id: "o2", type: "line", p1: "g", p2: "h", construction: false },
      ],
      constraints: [{ id: "k", type: "offset", refs: ["c1", "o1", "c2", "o2"], value: "1", extra: [1, 1] }],
    };
    expect(offsetCrossesItself(s, s.constraints[0])).toBe(true);
    // Moved apart, they don't.
    const apart: SketchData = { ...s, points: s.points.map((p) => (p.id === "c" || p.id === "d" ? { ...p, x: p.x + 20 } : p)) };
    expect(offsetCrossesItself(apart, apart.constraints[0])).toBe(false);
  });

  it("copies that only meet at their shared corners don't count", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const o = offsetCurves(r.sketch, r.lineIds[0], { x: 5, y: 2 }, "0.5");
    expect(offsetCrossesItself(o.sketch, offsetOf(o.sketch))).toBe(false);
    // An open run of lines too.
    const a = addLine(emptySketch(), at(0, 0), at(10, 0));
    const b = addLine(a.sketch, { x: 10, y: 0, snap: { kind: "point", id: (a.sketch.curves[0] as { p2: string }).p2 } }, at(10, 10));
    const ob = offsetCurves(b.sketch, b.lineId, { x: 9, y: 5 }, "2");
    expect(ob.error).toBeUndefined();
    expect(offsetNotes(ob.sketch)).toEqual([]);
  });

  it("stays quick on a long wiggly copy", () => {
    const pts = Array.from({ length: 60 }, (_, i) => at(i * 4, i % 2 ? 3 : -3));
    const sp = addSpline(emptySketch(), pts, false);
    const o = offsetCurves(sp.sketch, sp.splineId, { x: 2, y: 10 }, "0.3");
    expect(o.error).toBeUndefined();
    const t = performance.now();
    for (let i = 0; i < 5; i++) offsetNotes(o.sketch);
    expect(performance.now() - t).toBeLessThan(2500); // generous: CI machines are slow
  });
});
