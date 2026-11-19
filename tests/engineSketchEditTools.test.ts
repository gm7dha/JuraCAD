/**
 * The newer sketch editing tools' outlines extruded with the real OpenCascade engine:
 * a chamfered rectangle, a slot along a line and along an arc, a round between two
 * lines that didn't touch, and an elliptical arc closing an outline.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { addArc, addLine, addRectangle } from "../src/sketch/ops";
import { chamferCorner } from "../src/sketch/sketchChamfer";
import { filletBetween } from "../src/sketch/filletCurves";
import { slotAlong } from "../src/sketch/slotAlong";
import { addEllipticalArc } from "../src/sketch/ellipticalArc";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";
import { loadOpenCascade, sketchFeature, extrudeFeature, relativeError } from "./support/engineHelpers";

beforeAll(loadOpenCascade);
let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function volumeOf(data: SketchData, depth = 5): number {
  engine = new GeometryEngine();
  const sk = sketchFeature({ kind: "default", name: "Top" }, data);
  const r = engine.rebuild([sk, extrudeFeature(sk.id, depth) as Feature]);
  expect(r.featureErrors).toEqual({});
  expect(r.parts).toHaveLength(1);
  const m = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
  expect(m.watertight).toBe(true);
  return m.volume;
}
const at = (x: number, y: number) => ({ x, y });

describe("the newer sketch tools' outlines extrude", () => {
  it("a chamfered rectangle", () => {
    const rect = addRectangle(emptySketch(), at(0, 0), at(40, 20));
    const corner = (rect.sketch.curves.find((c) => c.id === rect.lineIds[0]) as SketchLine).p2;
    const r = chamferCorner(rect.sketch, corner, { mode: "equal", distance: "5" });
    expect(relativeError(volumeOf(r.sketch), (800 - 12.5) * 5)).toBeLessThan(1e-4);
  });

  it("a slot along a line and along an arc", () => {
    const l = addLine(emptySketch(), at(0, 0), at(30, 10));
    const r = slotAlong(l.sketch, l.lineId, "6");
    expect(relativeError(volumeOf(r.sketch), (Math.hypot(30, 10) * 6 + Math.PI * 9) * 5)).toBeLessThan(1e-3);
    const a = addArc(emptySketch(), at(20, 0), at(0, 20), at(14.1421356, 14.1421356));
    const ra = slotAlong(a.sketch, a.arcId, "4");
    expect(relativeError(volumeOf(ra.sketch), ((Math.PI / 4) * (22 * 22 - 18 * 18) + Math.PI * 4) * 5)).toBeLessThan(1e-3);
  });

  it("a round between two lines that don't touch, closed by two more lines", () => {
    let s = addLine(emptySketch(), at(0, 0), at(30, 0)).sketch;
    s = addLine(s, at(40, 10), at(40, 40)).sketch;
    const [l1, l2] = s.curves as SketchLine[];
    const r = filletBetween(s, l1.id, [5, 0], l2.id, [40, 30], "5");
    expect(r.error).toBeUndefined();
    let t = addLine(r.sketch, { x: 40, y: 40, snap: { kind: "point", id: l2.p2 } }, at(0, 40)).sketch;
    const top = t.curves[t.curves.length - 1] as SketchLine;
    t = addLine(t, { x: 0, y: 40, snap: { kind: "point", id: top.p2 } }, { x: 0, y: 0, snap: { kind: "point", id: l1.p1 } }).sketch;
    expect(relativeError(volumeOf(t), (1600 - 25 + (Math.PI * 25) / 4) * 5)).toBeLessThan(1e-3);
  });

  it("an elliptical arc closing two lines", () => {
    let s = addLine(emptySketch(), at(0, 0), at(0, 10)).sketch;
    s = addLine(s, { x: 0, y: 0, snap: { kind: "point", id: (s.curves[0] as SketchLine).p1 } }, at(20, 0)).sketch;
    const [up, along] = s.curves as SketchLine[];
    const r = addEllipticalArc(s, at(0, 0), at(20, 0), { x: 0, y: 10, snap: { kind: "point", id: up.p2 } }, { x: 20, y: 0.001, snap: { kind: "point", id: along.p2 } });
    expect(r.error).toBeUndefined();
    // A quarter of a 20 × 10 ellipse.
    expect(relativeError(volumeOf(r.sketch), (Math.PI * 20 * 10) / 4 * 5)).toBeLessThan(5e-3);
  });
});
