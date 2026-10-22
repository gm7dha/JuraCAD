import { describe, expect, it } from "vitest";

import { addArc, addDimension, addLine, dragArcRim, pointPos } from "../src/sketch/ops";
import { emptySketch, type SketchArc, type SketchData } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
const arcOf = (s: SketchData) => s.curves.find((c): c is SketchArc => c.type === "arc")!;
const r2 = Math.SQRT1_2 * 10;

describe("dragging an arc's rim", () => {
  it("changes its radius and keeps its centre and its angle", () => {
    const a = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2));
    const arc = arcOf(a.sketch);
    const c0 = pointPos(a.sketch, arc.center);
    expect(c0[0]).toBeCloseTo(0, 9);
    expect(c0[1]).toBeCloseTo(0, 9);
    const s = dragArcRim(a.sketch, a.arcId, 15);
    const c = pointPos(s, arc.center);
    expect(c[0]).toBeCloseTo(0, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    const st = pointPos(s, arc.start);
    const en = pointPos(s, arc.end);
    expect(st[0]).toBeCloseTo(15, 6);
    expect(st[1]).toBeCloseTo(0, 6);
    expect(en[0]).toBeCloseTo(0, 6);
    expect(en[1]).toBeCloseTo(15, 6);
  });

  it("pulls a line joined to its end along, and leaves the line's far end where it was", () => {
    let s = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2)).sketch;
    const arc = arcOf(s);
    s = addLine(s, { x: 10, y: 0, snap: { kind: "point", id: arc.start } }, at(30, 0)).sketch;
    const line = s.curves.find((c) => c.type === "line")!;
    const far = line.type === "line" ? (line.p1 === arc.start ? line.p2 : line.p1) : "";
    // The line starts on the arc's end (joined, not just touching).
    expect(line.type === "line" && [line.p1, line.p2].includes(arc.start)).toBe(true);
    const out = dragArcRim(s, arc.id, 12);
    expect(pointPos(out, arc.start)[0]).toBeCloseTo(12, 6);
    expect(pointPos(out, far)[0]).toBeCloseTo(30, 6);
    expect(pointPos(out, far)[1]).toBeCloseTo(0, 6);
  });

  it("can't change a radius held by a dimension", () => {
    const a = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2));
    const d = addDimension(a.sketch, [a.arcId]);
    expect(d.error).toBeUndefined();
    const out = dragArcRim(d.sketch, a.arcId, 20);
    const arc = arcOf(out);
    const st = pointPos(out, arc.start);
    const c = pointPos(out, arc.center);
    expect(Math.hypot(st[0] - c[0], st[1] - c[1])).toBeCloseTo(10, 6);
  });
});
