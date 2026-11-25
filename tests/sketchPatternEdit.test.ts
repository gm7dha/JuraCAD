import { describe, expect, it } from "vitest";

import { setCurrentScope } from "../src/model/expr";
import { addCircle, addDimension, addLine, addPoint, pointPos, setDimensionValue } from "../src/sketch/ops";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { patternGrid } from "../src/sketch/patternGrid";
import { editPattern, livePatterns, patternIdOf, readPattern } from "../src/sketch/patternEdit";
import { patternCurves } from "../src/sketch/tools";
import { parseSketchData } from "../src/sketch/validate";
import { keepSketchExtras, withoutEmptyExtras } from "../src/sketch/sketchText";
import { copySketchItems } from "../src/sketch/clipboard";
import { emptySketch, type SketchCircle, type SketchData } from "../src/sketch/types";

const circles = (s: SketchData) => s.curves.filter((k): k is SketchCircle => k.type === "circle");
const centres = (s: SketchData) =>
  circles(s)
    .map((k) => pointPos(s, k.center))
    .map(([x, y]) => `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`)
    .sort();

function dimensionedCircle() {
  const c = addCircle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, 2);
  return { s: addDimension(c.sketch, [c.circleId], { x: 3, y: 3 }).sketch, id: c.circleId };
}

describe("editable sketch patterns", () => {
  it("a row's count and spacing change afterwards; copies that stay keep their ids", () => {
    const { s: s0, id } = dimensionedCircle();
    const r = patternCurves(s0, [id], { kind: "linear", count: 4, spacing: 10, angle: 0 });
    expect(r.patternId).toBeTruthy();
    let s = r.sketch;
    expect(livePatterns(s)).toHaveLength(1);
    const copyIds = r.curveIds;
    // Any copy, the original or a copy's rule names the pattern.
    expect(patternIdOf(s, [copyIds[1]])).toBe(r.patternId);
    expect(patternIdOf(s, [id])).toBe(r.patternId);
    expect(readPattern(s, r.patternId)).toMatchObject({ kind: "linear", count: 4, value: "10", angle: 0 });

    // Fewer: the last copies go, the others stay as they were.
    let e = editPattern(s, r.patternId, { count: 2, value: "10" });
    expect(e.error).toBeUndefined();
    expect(circles(e.sketch).map((k) => k.id).sort()).toEqual([id, copyIds[0]].sort());
    // More, further apart: the old copies keep their ids and move.
    e = editPattern(e.sketch, r.patternId, { count: 5, value: "12", angle: 90 });
    expect(e.error).toBeUndefined();
    s = e.sketch;
    expect(circles(s)).toHaveLength(5);
    expect(circles(s).some((k) => k.id === copyIds[0])).toBe(true);
    expect(centres(s)).toEqual(["0,0", "0,12", "0,24", "0,36", "0,48"]);
    expect(analyzeSketch(s).freedom).toBe(0);
    expect(readPattern(s, r.patternId)).toMatchObject({ count: 5, value: "12", angle: 90 });
  });

  it("a dimension on a copy survives a change of spacing", () => {
    const { s: s0, id } = dimensionedCircle();
    const r = patternCurves(s0, [id], { kind: "linear", count: 3, spacing: 10, angle: 0 });
    const copy = circles(r.sketch).find((k) => k.id === r.curveIds[1])!;
    // A point dimensioned from the last copy's centre.
    const p = addPoint(r.sketch, { x: 20, y: 8 });
    let s = addDimension(p.sketch, [copy.center, p.pointId], { x: 1, y: 0 }).sketch;
    const dim = s.constraints.find((k) => k.refs.includes(p.pointId) && k.value !== undefined)!;
    s = editPattern(s, r.patternId, { count: 4, value: "15" }).sketch;
    expect(s.constraints.some((k) => k.id === dim.id)).toBe(true);
    const [x, y] = pointPos(s, copy.center);
    expect(x).toBeCloseTo(30, 5);
    expect(y).toBeCloseTo(0, 5);
  });

  it("the spacing can be a variable, and follows it", () => {
    setCurrentScope({ gap: 10 });
    const { s: s0, id } = dimensionedCircle();
    const r = patternCurves(s0, [id], { kind: "linear", count: 3, spacing: 10, angle: 0, value: "gap" });
    expect(centres(r.sketch)).toEqual(["0,0", "10,0", "20,0"]);
    setCurrentScope({ gap: 7 });
    const solved = solveSketch(r.sketch);
    expect(solved.ok).toBe(true);
    expect(centres(solved.sketch)).toEqual(["0,0", "14,0", "7,0"]);
    expect(readPattern(solved.sketch, r.patternId)?.value).toBe("gap");
    setCurrentScope({});
  });

  it("round a centre: the count shares out a whole turn again", () => {
    const { s: s0, id } = dimensionedCircle();
    // Move the circle off the centre point first.
    const centre = addPoint(s0, { x: -10, y: 0 });
    const r = patternCurves(centre.sketch, [id], { kind: "circular", count: 4, angle: 360, centre: [-10, 0], centreId: centre.pointId });
    expect(r.patternId).toBeTruthy();
    const e = editPattern(r.sketch, r.patternId, { count: 6, value: "360" });
    expect(e.error).toBeUndefined();
    expect(circles(e.sketch)).toHaveLength(6);
    const at = circles(e.sketch).map((k) => pointPos(e.sketch, k.center));
    for (const [x, y] of at) expect(Math.hypot(x + 10, y)).toBeCloseTo(10, 6);
    // Neighbours 60° apart: a copy kept its id and is now at 60°.
    const first = circles(e.sketch).find((k) => k.id === r.curveIds[0])!;
    const [x, y] = pointPos(e.sketch, first.center);
    expect((Math.atan2(y, x + 10) * 180) / Math.PI).toBeCloseTo(60, 6);
    // Spread over 90° with 3: 0, 45, 90.
    const f = editPattern(e.sketch, r.patternId, { count: 3, value: "90" });
    expect(circles(f.sketch)).toHaveLength(3);
    const [x2, y2] = pointPos(f.sketch, circles(f.sketch).find((k) => k.id === r.curveIds[0])!.center);
    expect((Math.atan2(y2, x2 + 10) * 180) / Math.PI).toBeCloseTo(45, 6);
  });

  it("a grid's second direction can be changed, added and taken away", () => {
    const { s: s0, id } = dimensionedCircle();
    const r = patternGrid(s0, [id], { kind: "linear", count: 3, spacing: 10, angle: 0 }, { count: 2, spacing: 5, angle: 90 });
    expect(circles(r.sketch)).toHaveLength(6);
    expect(readPattern(r.sketch, r.patternId)?.second).toMatchObject({ count: 2, value: "5", angle: 90 });
    let e = editPattern(r.sketch, r.patternId, { count: 4, value: "10", second: { count: 3, value: "6", angle: 90 } });
    expect(e.error).toBeUndefined();
    expect(circles(e.sketch)).toHaveLength(12);
    expect(centres(e.sketch)).toContain("30,12");
    expect(analyzeSketch(e.sketch).freedom).toBe(0);
    e = editPattern(e.sketch, r.patternId, { count: 4, value: "10", second: null });
    expect(circles(e.sketch)).toHaveLength(4);
    expect(readPattern(e.sketch, r.patternId)?.second).toBeUndefined();
    // A row given a second direction later.
    e = editPattern(e.sketch, r.patternId, { count: 2, value: "10", second: { count: 2, value: "5", angle: 90 } });
    expect(centres(e.sketch)).toEqual(["0,0", "0,5", "10,0", "10,5"]);
    expect(analyzeSketch(e.sketch).freedom).toBe(0);
  });

  it("is saved and read back, carried by edits that don't know it, and forgotten once its copies are gone", () => {
    const { s: s0, id } = dimensionedCircle();
    const r = patternCurves(s0, [id], { kind: "linear", count: 3, spacing: 10, angle: 0 });
    const back = parseSketchData(JSON.parse(JSON.stringify(r.sketch)))!;
    expect(back.patterns).toEqual(r.sketch.patterns);
    expect(back.constraints.filter((k) => k.pattern)).toHaveLength(r.sketch.constraints.filter((k) => k.pattern).length);
    const bare = { points: back.points, curves: back.curves, constraints: back.constraints };
    expect(keepSketchExtras(back, bare).patterns).toEqual(back.patterns);
    const noCopies = { ...back, curves: back.curves.filter((c) => c.id === id), constraints: back.constraints.filter((k) => !k.pattern) };
    expect(withoutEmptyExtras(noCopies).patterns).toBeUndefined();
  });

  it("copied copies are pasted as plain ones", () => {
    const { s: s0, id } = dimensionedCircle();
    const r = patternCurves(s0, [id], { kind: "linear", count: 3, spacing: 10, angle: 0 });
    const clip = copySketchItems(r.sketch, [id, ...r.curveIds]);
    expect(clip?.constraints.some((k) => k.pattern || (k.type === "patternMove" && k.value !== undefined))).toBe(false);
  });

  it("old patterns (no pattern tag) solve exactly as before", () => {
    const l = addLine(emptySketch(), { x: 0, y: 0 }, { x: 5, y: 0 });
    const s: SketchData = {
      ...l.sketch,
      constraints: [...l.sketch.constraints],
    };
    const c = addCircle(s, { x: 2, y: 2 }, 1);
    const old = {
      ...c.sketch,
      points: [...c.sketch.points, { id: "q", x: 0, y: 0 }],
      curves: [...c.sketch.curves, { id: "k2", type: "circle" as const, center: "q", radius: 1, construction: false }],
      constraints: [...c.sketch.constraints, { id: "m", type: "patternMove" as const, refs: ["q", circles(c.sketch)[0].center], extra: [7, 0] }],
    };
    const solved = solveSketch(old);
    expect(pointPos(solved.sketch, "q")).toEqual([9, 2]);
    expect(patternIdOf(solved.sketch, ["k2"])).toBeNull();
    void setDimensionValue;
  });
});
