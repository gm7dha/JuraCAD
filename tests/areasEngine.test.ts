/**
 * Extruding (and revolving) only the sketch areas the user clicked, with the
 * real OpenCascade engine: exact volumes.
 */
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC, type Shape3D } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import { extrudeSketch } from "../src/kernel/extrude";
import { revolveSketch } from "../src/kernel/revolve";
import { facesOf, solidsOf } from "../src/kernel/topology";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { pointInside, sketchAreas } from "../src/sketch/areas";
import { addCircle, addLine, addRectangle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { addEllipse, addSpline } from "../src/sketch/tools";
import { emptySketch, type SketchData } from "../src/sketch/types";

beforeAll(async () => {
  setOC(await opencascade());
});

const TOP: SketchPlane = { kind: "default", name: "Top" };
const at = (x: number, y: number) => ({ x, y });
const rect = (s: SketchData, x0: number, y0: number, x1: number, y1: number) => addRectangle(s, at(x0, y0), at(x1, y1)).sketch;

/** Volume of a shape, which is then freed. */
const vol = (s: Shape3D) => {
  try {
    return measureVolume(s);
  } finally {
    s.delete();
  }
};
const count = (s: Shape3D, what: "faces" | "solids") => {
  const xs = what === "faces" ? facesOf(s) : solidsOf(s);
  const n = xs.length;
  xs.forEach((x) => x.delete());
  return n;
};
const extrude = (s: SketchData, areas: [number, number][] | undefined, depth = 10) => extrudeSketch(TOP, s, { depth, end: "blind", flip: false, areas });

describe("extruding picked areas", () => {
  it("a line across a rectangle: either strip, or both joined into one plain block", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(10, 0), at(10, 30)).sketch;
    expect(vol(extrude(s, [[5, 15]]))).toBeCloseTo(3000, 6);
    expect(vol(extrude(s, [[25, 15]]))).toBeCloseTo(9000, 6);
    const both = extrude(s, [[5, 15], [25, 15]]);
    // Joined before extruding: one solid with the six faces of a plain box (no seam down the middle).
    expect(count(both, "solids")).toBe(1);
    expect(count(both, "faces")).toBe(6);
    expect(vol(both)).toBeCloseTo(12000, 6);
    // Without picks, every closed shape as before: the whole rectangle (the line on its own isn't closed).
    expect(vol(extrude(s, undefined))).toBeCloseTo(12000, 6);
  });

  it("a circle over a rectangle's side: the half outside, or the rectangle with the half inside", () => {
    let s = rect(emptySketch(), 0, 0, 20, 10);
    s = addCircle(s, at(20, 5), 3).sketch;
    expect(vol(extrude(s, [[21.5, 5]]))).toBeCloseTo(((9 * Math.PI) / 2) * 10, 6);
    expect(vol(extrude(s, [[5, 5]]))).toBeCloseTo((200 - (9 * Math.PI) / 2) * 10, 6);
    expect(vol(extrude(s, [[5, 5], [19, 5]]))).toBeCloseTo(2000, 6);
    // All three: the rectangle plus the outside half.
    expect(vol(extrude(s, [[5, 5], [19, 5], [21.5, 5]]))).toBeCloseTo((200 + (9 * Math.PI) / 2) * 10, 6);
  });

  it("a circle inside a rectangle: the plate (with its hole), the disc, or both (no hole)", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addCircle(s, at(20, 15), 5).sketch;
    expect(vol(extrude(s, [[2, 2]]))).toBeCloseTo((1200 - 25 * Math.PI) * 10, 6);
    expect(vol(extrude(s, [[20, 15]]))).toBeCloseTo(25 * Math.PI * 10, 6);
    expect(vol(extrude(s, [[2, 2], [20, 15]]))).toBeCloseTo(12000, 6);
    // Nothing picked: every closed shape, as before (the circle is a hole).
    expect(vol(extrude(s, undefined))).toBeCloseTo((1200 - 25 * Math.PI) * 10, 6);
    expect(vol(extrude(s, []))).toBeCloseTo((1200 - 25 * Math.PI) * 10, 6);
  });

  it("two overlapping circles: the lens where they cross", () => {
    let s = addCircle(emptySketch(), at(0, 0), 10).sketch;
    s = addCircle(s, at(10, 0), 10).sketch;
    const lens = 2 * 100 * Math.acos(0.5) - 5 * Math.sqrt(300);
    expect(vol(extrude(s, [[5, 0]]))).toBeCloseTo(lens * 10, 6);
    expect(vol(extrude(s, [[-5, 0]]))).toBeCloseTo((100 * Math.PI - lens) * 10, 6);
  });

  it("half an ellipse, cut by a line (exact ellipse pieces)", () => {
    let s = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]).sketch;
    s = addLine(s, at(0, -15), at(0, 15)).sketch;
    expect(vol(extrude(s, [[10, 0]]))).toBeCloseTo(Math.PI * 20 * 10 * 0.5 * 10, 6);
    // Taller than wide too (OpenCascade wants the longer axis first).
    let t = addEllipse(emptySketch(), at(0, 0), at(8, 0), [0, 16]).sketch;
    t = addLine(t, at(-10, 4), at(10, 4)).sketch;
    const top = vol(extrude(t, [[0, 10]]));
    const bottom = vol(extrude(t, [[0, -5]]));
    expect(top + bottom).toBeCloseTo(Math.PI * 8 * 16 * 10, 6);
    // The cap above y = 4 of an ellipse with semi-axes 8 (x) and 16 (y): ab(θ − sinθcosθ)…, here by its formula.
    const k = 4 / 16;
    const cap = 8 * 16 * (Math.acos(k) - k * Math.sqrt(1 - k * k));
    expect(top).toBeCloseTo(cap * 10, 6);
  });

  it("a closed spline cut in two: the halves add up to the whole", () => {
    let s = addSpline(emptySketch(), [at(0, 0), at(20, -5), at(30, 10), at(10, 20)], true).sketch;
    s = addLine(s, at(15, -20), at(15, 40)).sketch;
    const whole = vol(extrude(addSpline(emptySketch(), [at(0, 0), at(20, -5), at(30, 10), at(10, 20)], true).sketch, undefined));
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    const [a, b] = m.areas.map((x) => vol(extrude(s, [pointInside(x)])));
    expect(a + b).toBeCloseTo(whole, 6);
  });

  it("spline pieces walked backwards keep their shape (an S-curve over a line: equal lobes)", () => {
    // Symmetric S through (0,0), (10,10), (20,-10), (30,0), closed off by the straight line between its ends.
    let s = addSpline(emptySketch(), [at(0, 0), at(10, 10), at(20, -10), at(30, 0)], false).sketch;
    s = addLine(s, at(0, 0), at(30, 0)).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    const [a, b] = m.areas.map((x) => vol(extrude(s, [pointInside(x)])));
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeCloseTo(921.875, 6);
  });

  it("a plate with a spline-shaped hole: picking the plate equals using every closed shape", () => {
    for (const pts of [
      [at(10, 10), at(30, 8), at(35, 25), at(15, 30)],
      [at(15, 30), at(35, 25), at(30, 8), at(10, 10)], // drawn the other way round
    ]) {
      let s = rect(emptySketch(), 0, 0, 50, 40);
      s = addSpline(s, pts, true).sketch;
      const all = vol(extrude(s, undefined));
      expect(vol(extrude(s, [[2, 2]]))).toBeCloseTo(all, 6);
      const hole = vol(extrude(addSpline(emptySketch(), pts, true).sketch, undefined));
      expect(all + hole).toBeCloseTo(20000, 6);
    }
  });

  it("a closed spline drawn clockwise, cut by a line: the halves add up to the whole", () => {
    const pts = [at(10, 20), at(30, 10), at(20, -5), at(0, 0)];
    const whole = vol(extrude(addSpline(emptySketch(), pts, true).sketch, undefined));
    let s = addSpline(emptySketch(), pts, true).sketch;
    s = addLine(s, at(15, -20), at(15, 40)).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    const [a, b] = m.areas.map((x) => vol(extrude(s, [pointInside(x)])));
    expect(a + b).toBeCloseTo(whole, 6);
  });

  it("revolves only the picked area", () => {
    // A 10 × 10 square beside the up–down axis, split across the middle; spin the lower half.
    let s = rect(emptySketch(), 10, 0, 20, 10);
    s = addLine(s, at(10, 5), at(20, 5)).sketch;
    const r = revolveSketch(TOP, s, { axis: "vertical", angle: 360, flip: false, areas: [[15, 2]] });
    expect(vol(r)).toBeCloseTo(Math.PI * (400 - 100) * 5, 6);
  });
});

describe("picked areas in a rebuild", () => {
  let engine: GeometryEngine | undefined;
  afterEach(() => engine?.dispose());
  const sketchFeature = (data: SketchData): Feature => ({ id: "s1", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: TOP, data } });
  const extrudeFeature = (areas?: [number, number][]): Feature => ({
    id: "e1",
    name: "Extrude 1",
    type: "extrude",
    operation: "new",
    suppressed: false,
    params: { ...defaultParams("extrude"), depth: "10" },
    sketchRef: "s1",
    extrude: { end: "blind", flip: false },
    ...(areas ? { areas } : {}),
  });

  it("builds the picked strip, and explains when a picked area has gone", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(10, 0), at(10, 30)).sketch;
    engine = new GeometryEngine();
    let r = engine.rebuild([sketchFeature(s), extrudeFeature([[5, 15]])]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    // The area has moved away from the point: a friendly error saying what to do.
    const moved: SketchData = { ...s, points: s.points.map((p) => ({ ...p, x: p.x + 100 })) };
    engine.dispose();
    engine = new GeometryEngine();
    r = engine.rebuild([sketchFeature(moved), extrudeFeature([[5, 15]])]);
    expect(r.featureErrors.e1).toMatch(/One of the areas picked to extrude isn't in the sketch any more/);
    expect(r.featureErrors.e1).toMatch(/click the areas again/);
  });
});
