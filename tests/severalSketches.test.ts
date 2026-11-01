/**
 * Revolve and Sweep using areas of several sketches (real OpenCascade engine),
 * as Extrude already could: profiles from several sketches spun round one
 * axis, and several profiles swept along one path. Volumes are OpenCascade's
 * exact ones (not the mesh's), so the checks are tight.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { pickOf, sketchAreas, type AreaPick } from "../src/sketch/areas";
import { addCircle, addLine, addRectangle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine | undefined;
afterEach(() => engine?.dispose());
const build = (features: Feature[]) => {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
};
const volumes = () => engine!.check("normal").parts.map((p) => p.exactVolume!);
const total = () => volumes().reduce((a, b) => a + b, 0);
/** Within a millionth (OpenCascade's own volumes of exact shapes). */
const exactly = (actual: number, exact: number) => expect(Math.abs(actual / exact - 1)).toBeLessThan(1e-6);

const FRONT: SketchPlane = { kind: "default", name: "Front" };
const RIGHT: SketchPlane = { kind: "default", name: "Right" };
const TOP: SketchPlane = { kind: "default", name: "Top" };
const sketch = (id: string, data: SketchData, plane: SketchPlane): Feature => ({ id, name: `Sketch ${id}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const pickAt = (data: SketchData, x: number, y: number): AreaPick => {
  const map = sketchAreas(data);
  return pickOf(map.areas[map.areaAt([x, y])]);
};
const rect = (x0: number, y0: number, x1: number, y1: number) => addRectangle(emptySketch(), { x: x0, y: y0 }, { x: x1, y: y1 }).sketch;

/** A ring section 10…20 mm out, 10 high, on Front; and one 30…40 out, 5 high, on Right. Both spin round world Z. */
const inner = rect(10, 0, 20, 10);
const outer = rect(30, 0, 40, 5);
const INNER = Math.PI * (20 ** 2 - 10 ** 2) * 10;
const OUTER = Math.PI * (40 ** 2 - 30 ** 2) * 5;

const revolve = (id: string, extra: Partial<Feature> = {}, angle = 360): Feature => ({
  id,
  name: id,
  type: "revolve",
  operation: "new",
  suppressed: false,
  params: { ...defaultParams("revolve"), angle: String(angle) },
  sketchRef: "s1",
  areas: [pickAt(inner, 15, 5)],
  revolve: { axis: "vertical", flip: false },
  ...extra,
});

describe("one revolve using areas of two sketches", () => {
  it("spins a section on Front and one on Right round the same axis: two rings, two parts", () => {
    const r = build([sketch("s1", inner, FRONT), sketch("s2", outer, RIGHT), revolve("r1", { apart: true, moreAreas: [{ sketch: "s2", areas: [pickAt(outer, 35, 2)] }] })]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(2);
    const v = volumes().sort((a, b) => a - b);
    exactly(v[0], INNER);
    exactly(v[1], OUTER);
  });

  it("without the newer part rules the two rings are one part", () => {
    build([sketch("s1", inner, FRONT), sketch("s2", outer, RIGHT), revolve("r1", { moreAreas: [{ sketch: "s2", areas: [pickAt(outer, 35, 2)] }] })]);
    expect(volumes()).toHaveLength(1);
    exactly(total(), INNER + OUTER);
  });

  it("a quarter turn, and a symmetric quarter turn, of both", () => {
    build([sketch("s1", inner, FRONT), sketch("s2", outer, RIGHT), revolve("r1", { moreAreas: [{ sketch: "s2", areas: [pickAt(outer, 35, 2)] }] }, 90)]);
    exactly(total(), (INNER + OUTER) / 4);
    build([sketch("s1", inner, FRONT), sketch("s2", outer, RIGHT), revolve("r1", { revolve: { axis: "vertical", flip: false, symmetric: true }, moreAreas: [{ sketch: "s2", areas: [pickAt(outer, 35, 2)] }] }, 90)]);
    exactly(total(), (INNER + OUTER) / 4);
  });

  it("spins round a line drawn in the first sketch, and refuses a sketch whose plane misses the axis", () => {
    // The axis: an upright construction line at x = 50 in the Front sketch; the second section is on Front too, past it.
    const { sketch: first, lineId } = addLine(rect(30, 0, 40, 10), { x: 50, y: -5 }, { x: 50, y: 20 }, { construction: true });
    const line = { id: lineId };
    const second = rect(75, 0, 80, 4);
    const spun = revolve("r1", { areas: [pickAt(first, 35, 5)], revolve: { axis: line.id, flip: false }, moreAreas: [{ sketch: "s2", areas: [pickAt(second, 77, 2)] }] });
    const r = build([sketch("s1", first, FRONT), sketch("s2", second, FRONT), spun]);
    expect(r.featureErrors).toEqual({});
    // Radii from x = 50: 10…20 (10 high) and 25…30 (4 high), one part.
    exactly(total(), Math.PI * (20 ** 2 - 10 ** 2) * 10 + Math.PI * (30 ** 2 - 25 ** 2) * 4);
    // On Top, the upright axis only passes through the plane: refused, saying what to do.
    const flat = rect(50, 50, 60, 60);
    const offAxis = build([sketch("s1", inner, FRONT), sketch("s2", flat, TOP), revolve("r1", { moreAreas: [{ sketch: "s2", areas: [pickAt(flat, 55, 55)] }] })]);
    expect(offAxis.featureErrors.r1).toBe(
      "Sketch s2: the axis doesn't lie in its plane, so its shapes can't be spun round it. Use sketches drawn on a plane through the axis, or click its areas to leave them out.",
    );
    // A second section crossing the axis: the usual message, naming the sketch.
    const across = rect(-5, 0, 5, 5);
    const crossing = build([sketch("s1", inner, FRONT), sketch("s2", across, RIGHT), revolve("r1", { moreAreas: [{ sketch: "s2", areas: [pickAt(across, 0, 2)] }] })]);
    expect(crossing.featureErrors.r1).toMatch(/^Sketch s2: .*crosses the line it spins around/);
  });

  it("an extra sketch suppressed or deleted is left out with a warning", () => {
    const parts = (s2: Partial<Feature> | null) => [
      sketch("s1", inner, FRONT),
      ...(s2 ? [{ ...sketch("s2", outer, RIGHT), ...s2 }] : []),
      revolve("r1", { moreAreas: [{ sketch: "s2", areas: [pickAt(outer, 35, 2)] }] }),
    ];
    const r = build(parts({ suppressed: true }));
    expect(r.featureErrors).toEqual({});
    expect(r.featureWarnings!.r1).toBe('Sketch s2 is suppressed, so its areas are left out of this revolve. Edit it and click "use only Sketch s1" (or un-suppress Sketch s2).');
    exactly(total(), INNER);
    const gone = build(parts(null));
    expect(gone.featureWarnings!.r1).toMatch(/^One of its other sketches has been deleted, so its areas are left out of this revolve/);
    exactly(total(), INNER);
  });

  it("an older revolve (no extra sketches) builds exactly as before", () => {
    build([sketch("s1", inner, FRONT), revolve("r1")]);
    exactly(total(), INNER);
  });
});

describe("one sweep using profiles from two sketches", () => {
  // Path on Top: 50 mm along +Y from the origin. Profiles on Front (XZ, at y = 0): circles r 2 at x = −10 and r 3 at x = 10.
  const path = addLine(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 50 }).sketch;
  const left = addCircle(emptySketch(), { x: -10, y: 0 }, 2).sketch;
  const right = addCircle(emptySketch(), { x: 10, y: 0 }, 3).sketch;
  const sweep = (extra: Partial<Feature> = {}): Feature => ({
    id: "w1",
    name: "w1",
    type: "sweep",
    operation: "new",
    suppressed: false,
    params: { ...defaultParams("sweep") },
    sketchRef: "s1",
    pathRef: "p",
    areas: [pickAt(left, -10, 0)],
    ...extra,
  });

  it("sweeps both circles along the one path: two rods, two parts", () => {
    const r = build([sketch("p", path, TOP), sketch("s1", left, FRONT), sketch("s2", right, FRONT), sweep({ apart: true, moreAreas: [{ sketch: "s2", areas: [pickAt(right, 10, 0)] }] })]);
    expect(r.featureErrors).toEqual({});
    const v = volumes().sort((a, b) => a - b);
    expect(v).toHaveLength(2);
    exactly(v[0], Math.PI * 4 * 50);
    exactly(v[1], Math.PI * 9 * 50);
  });

  it("refuses the path as one of the profiles, and builds old sweeps unchanged", () => {
    const r = build([sketch("p", path, TOP), sketch("s1", left, FRONT), sweep({ moreAreas: [{ sketch: "p", areas: [[0, 25]] }] })]);
    expect(r.featureErrors.w1).toBe("Sketch p: it's the path, so it can't be swept along itself. Click its areas to leave them out.");
    build([sketch("p", path, TOP), sketch("s1", left, FRONT), sweep()]);
    exactly(total(), Math.PI * 4 * 50);
  });
});
