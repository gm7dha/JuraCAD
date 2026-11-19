/**
 * Drawing in sketches the Onshape way, through the sketch tools (the controller) as the view drives them:
 * H/V kept when the end lines up with a point, a spline finished by a double-click, a line dragged out,
 * parallel / perpendicular / tangent inference, Shift+A and the line → tangent arc gesture, Midpoint line.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { addArc, addLine, curvePoints, pointPos } from "../src/sketch/ops";
import type { SketchData } from "../src/sketch/types";

const s = () => useStore.getState();
const d = (): SketchData => s().editing!.draft.sketch!.data;
const m = (x: number, y: number, shift = false): SketchPointer => ({ x, y, mmPerPx: 0.1, shift, ctrl: false });
const click = (c: SketchController, x: number, y: number, shift = false) => {
  c.pointerMove(m(x, y, shift), false);
  c.pointerDown(m(x, y, shift));
  c.pointerUp();
};
const types = () => d().constraints.map((k) => k.type).sort();
const ends = (id: string) => curvePoints(d().curves.find((k) => k.id === id)!).map((p) => pointPos(d(), p));
const lines = () => d().curves.filter((k) => k.type === "line");

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
});

describe("drawing lines", () => {
  it("keeps a nearly level line horizontal when its end lines up with a point passed over", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 30, 15);
    c.pointerMove(m(0, 0), false); // pass over the origin
    c.pointerMove(m(0.1, 15.2), false);
    expect(c.current.inference?.text).toBe("H");
    click(c, 0.1, 15.2);
    s().discardOfferedDimensions();
    expect(types()).toEqual(["horizontal", "vertical"]);
    const [a, b] = ends(lines()[0].id);
    expect(a[1]).toBeCloseTo(15, 6);
    expect(b[0]).toBeCloseTo(0, 6);
    expect(b[1]).toBeCloseTo(15, 6);
  });

  it("drags out one line with the mouse (press, drag, let go) and stops there", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    c.pointerMove(m(0, 5), false);
    c.pointerDown(m(0, 5));
    for (let x = 1; x <= 10; x++) c.pointerMove(m(x, 5.3), true);
    c.pointerUp();
    expect(lines()).toHaveLength(1);
    expect(types()).toContain("horizontal");
    // No chain after a dragged line: the next click starts a new one.
    s().discardOfferedDimensions();
    click(c, 20, 20);
    expect(lines()).toHaveLength(1);
  });

  it("a click that wobbles a little is still one click", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    c.pointerDown(m(0, 0));
    c.pointerMove(m(0.2, 0.1), true);
    c.pointerUp();
    expect(lines()).toHaveLength(0);
    click(c, 10, 3);
    expect(lines()).toHaveLength(1);
  });

  it("infers parallel to a line the pointer passed over", () => {
    const l = addLine(d(), { x: 0, y: 0 }, { x: 10, y: 5 });
    s().updateSketch(l.sketch, { record: true });
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 0, 10);
    c.pointerMove(m(5, 2.5), false); // wake the slanted line
    c.pointerMove(m(10, 15.3), false);
    expect(c.current.inference?.text).toBe("∥");
    click(c, 10, 15.3);
    s().discardOfferedDimensions();
    const k = d().constraints.find((x) => x.type === "parallel")!;
    expect(k.refs).toContain(l.lineId);
    const [a, b] = ends(k.refs[0]);
    expect((b[1] - a[1]) / (b[0] - a[0])).toBeCloseTo(0.5, 6);
  });

  it("infers perpendicular to the line just drawn, and nothing with Shift", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 0, 0);
    click(c, 10, 5);
    s().discardOfferedDimensions();
    click(c, 7.5, 10.2);
    s().discardOfferedDimensions();
    expect(types().filter((t) => t === "perpendicular")).toHaveLength(1);
    click(c, 4, 4.5, true);
    s().discardOfferedDimensions();
    expect(types().filter((t) => t === "perpendicular" || t === "parallel")).toHaveLength(1);
  });

  it("never infers parallel to a woken line through the start (it would lie on it)", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 0, 0);
    click(c, 10, 5);
    s().discardOfferedDimensions();
    click(c, 20, 10.3);
    s().discardOfferedDimensions();
    expect(types()).not.toContain("parallel");
  });

  it("infers tangent when a line leaves an arc's end along it", () => {
    // A flat arc: at its end (20, 0) it's heading down to the right, at about 44°.
    const a = addArc(d(), { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 4 });
    s().updateSketch(a.sketch, { record: true });
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 20, 0);
    c.pointerMove(m(27.4, -6.7), false);
    expect(c.current.inference?.text).toBe("T");
    click(c, 27.4, -6.7);
    s().discardOfferedDimensions();
    expect(types()).toContain("tangent");
  });

  it("infers square to the arc (normal) when it leaves across it", () => {
    // The flat arc's centre is (10, -10.5): straight out from its end (20, 0) is about 46° up to the right.
    const a = addArc(d(), { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 4 });
    s().updateSketch(a.sketch, { record: true });
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 20, 0);
    c.pointerMove(m(26.7, 7.4), false);
    expect(c.current.inference?.text).toBe("N");
    click(c, 26.7, 7.4);
    s().discardOfferedDimensions();
    expect(types()).toContain("normal");
    const line = lines()[0];
    const [p0, p1] = ends(line.id);
    // Carried on, it passes through the arc's centre.
    const arc = d().curves.find((k) => k.type === "arc")!;
    const [cx, cy] = arc.type === "arc" ? pointPos(d(), arc.center) : [0, 0];
    const cross = ((p1[0] - p0[0]) * (cy - p0[1]) - (p1[1] - p0[1]) * (cx - p0[0])) / Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    expect(Math.abs(cross)).toBeLessThan(1e-5);
  });
});

describe("line → tangent arc", () => {
  it("Shift+A switches the chain to an arc from the last end, then back to lines", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    expect(c.toggleLineArc()).toBe(true); // nothing drawn yet: just says how
    expect(s().sketch?.message?.text).toMatch(/Draw a line first/);
    click(c, 0, 0);
    click(c, 20, 0);
    s().discardOfferedDimensions();
    expect(c.toggleLineArc()).toBe(true);
    click(c, 30, 10);
    const arcs = d().curves.filter((k) => k.type === "arc");
    expect(arcs).toHaveLength(1);
    expect(types()).toContain("tangent");
    // Back to lines, carrying on from the arc's end.
    click(c, 30, 20);
    s().discardOfferedDimensions();
    expect(lines()).toHaveLength(2);
    const [a] = ends(lines()[1].id);
    expect(a[0]).toBeCloseTo(30, 6);
    expect(a[1]).toBeCloseTo(10, 6);
  });

  it("back onto the last end and away again starts an arc", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    click(c, 0, 0);
    click(c, 20, 0);
    s().discardOfferedDimensions();
    c.pointerMove(m(25, 5), false); // away
    c.pointerMove(m(20.2, 0.1), false); // back
    c.pointerMove(m(25, 5), false); // away again: an arc
    click(c, 30, 10);
    expect(d().curves.filter((k) => k.type === "arc")).toHaveLength(1);
  });

  it("isn't offered outside the Line tool", () => {
    s().setSketchTool("circle");
    expect(new SketchController().toggleLineArc()).toBe(false);
  });
});

describe("spline and midpoint line", () => {
  it("a double-click finishes a spline instead of adding the same point twice", () => {
    s().setSketchTool("spline");
    const c = new SketchController();
    click(c, 0, 0);
    click(c, 10, 5);
    click(c, 20, 0);
    click(c, 20, 0);
    const sp = d().curves.filter((k) => k.type === "spline");
    expect(sp).toHaveLength(1);
    expect(sp[0].type === "spline" ? sp[0].points.length : 0).toBe(3);
    // The next click starts a new one.
    click(c, 40, 0);
    expect(d().curves).toHaveLength(1);
  });

  it("Midpoint line: the first click is the middle, held there", () => {
    s().setSketchTool("midpointLine");
    const c = new SketchController();
    click(c, 10, 10);
    c.pointerMove(m(20, 10.4), false);
    expect(c.current.inference?.text).toBe("H");
    click(c, 20, 10.4);
    s().discardOfferedDimensions();
    expect(types()).toEqual(["horizontal", "midpoint"]);
    const [a, b] = ends(lines()[0].id);
    expect(a[0]).toBeCloseTo(0, 6);
    expect(b[0]).toBeCloseTo(20, 6);
    expect(a[1]).toBeCloseTo(10, 6);
    expect(b[1]).toBeCloseTo(10, 6);
  });

  it("Midpoint line from the origin is symmetric about it", () => {
    s().setSketchTool("midpointLine");
    const c = new SketchController();
    click(c, 0, 0);
    click(c, 8, 6);
    s().discardOfferedDimensions();
    const [a, b] = ends(lines()[0].id);
    expect(a[0] + b[0]).toBeCloseTo(0, 6);
    expect(a[1] + b[1]).toBeCloseTo(0, 6);
  });
});
