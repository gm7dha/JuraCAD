/**
 * Extruding (and revolving) only the sketch areas the user clicked, with the
 * real OpenCascade engine: exact volumes.
 */
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC, type Shape3D } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { extrudeSketch } from "../src/kernel/extrude";
import { revolveSketch } from "../src/kernel/revolve";
import { facesOf, solidsOf } from "../src/kernel/topology";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { pickOf, pointInside, sketchAreas, type AreaPick } from "../src/sketch/areas";
import { emptyDocument, parseDocument } from "../src/model/document";
import { addCircle, addLine, addPoint, addRectangle } from "../src/sketch/ops";
import { planeOnFace, type SketchPlane } from "../src/sketch/planes";
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
  const extrudeFeature = (areas?: AreaPick[]): Feature => ({
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

  it("a plate with 60 holes, the plate picked: saved, opened again and rebuilt with every hole", () => {
    // (600 holes take minutes to cut here; tests/areas.test.ts checks a 600-hole pick survives saving.)
    let s = rect(emptySketch(), 0, 0, 60, 100);
    const points = [...s.points];
    const curves = [...s.curves];
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 10; j++) {
        points.push({ id: `h${i}-${j}c`, x: 5 + i * 10, y: 5 + j * 10 });
        curves.push({ id: `h${i}-${j}`, type: "circle", center: `h${i}-${j}c`, radius: 3, construction: false });
      }
    s = { ...s, points, curves };
    const m = sketchAreas(s);
    const doc = { ...emptyDocument("Plate"), features: [sketchFeature(s), extrudeFeature([pickOf(m.areas[m.areaAt([10, 10])])])] };
    const back = parseDocument(JSON.parse(JSON.stringify(doc)))!;
    expect(back.features[1].areas).toHaveLength(1);
    engine = new GeometryEngine();
    const r = engine.rebuild(back.features);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    // The plate less 60 holes of radius 3, 10 deep (the mesh is a close approximation of the round holes).
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    const exact = (60 * 100 - 60 * Math.PI * 9) * 10;
    expect(Math.abs(a.volume / exact - 1)).toBeLessThan(0.002);
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

describe("one sketch with two circles, each extruded on its own (as in Onshape)", () => {
  let engine: GeometryEngine | undefined;
  afterEach(() => engine?.dispose());
  // The owner's screenshot: a small circle (r 5) extruded tall, a big one (r 15) extruded short.
  let s = addCircle(emptySketch(), at(0, 0), 5).sketch;
  s = addCircle(s, at(40, 0), 15).sketch;
  const map = sketchAreas(s);
  const small = pickOf(map.areas[map.areaAt([0, 0])]);
  const big = pickOf(map.areas[map.areaAt([40, 0])]);
  const sketch: Feature = { id: "s1", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: TOP, data: s } };
  const extrude = (id: string, operation: "new" | "add", depth: number, areas: AreaPick[] | undefined, apart = true): Feature => ({
    id,
    name: id,
    type: "extrude",
    operation,
    suppressed: false,
    params: { ...defaultParams("extrude"), depth: String(depth) },
    sketchRef: "s1",
    extrude: { end: "blind", flip: false },
    ...(areas ? { areas } : {}),
    ...(apart ? { apart: true } : {}),
  });
  /** Height (top of the mesh) and volume of a built part. */
  const sizeOf = (p: { vertices: Float32Array; triangles: Uint32Array }) => {
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 2; i < p.vertices.length; i += 3) {
      top = Math.max(top, p.vertices[i]);
      bottom = Math.min(bottom, p.vertices[i]);
    }
    return { height: top - bottom, volume: analyzeMesh(p.vertices, p.triangles).volume };
  };
  const close = (actual: number, exact: number) => expect(Math.abs(actual / exact - 1)).toBeLessThan(0.005);

  it("Extrude 1 (New, the small circle, 60 tall) and Extrude 2 (Add, the big circle, 10 tall) make two parts", () => {
    engine = new GeometryEngine();
    const r = engine.rebuild([sketch, extrude("e1", "new", 60, [small]), extrude("e2", "add", 10, [big])]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    const [p1, p2] = r.parts.map(sizeOf);
    expect(p1.height).toBeCloseTo(60, 6);
    expect(p2.height).toBeCloseTo(10, 6);
    close(p1.volume, Math.PI * 25 * 60);
    close(p2.volume, Math.PI * 225 * 10);
    // Each part is made by its own extrude.
    expect(r.parts[1].id).toBe("e2");
  });

  it("New with both circles: two parts, one per circle", () => {
    engine = new GeometryEngine();
    const r = engine.rebuild([sketch, extrude("e1", "new", 20, undefined)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => [p.id, p.name])).toEqual([
      ["e1", "Part 1"],
      ["e1~2", "Part 2"],
    ]);
    const vols = r.parts.map((p) => sizeOf(p).volume).sort((a, b) => a - b);
    close(vols[0], Math.PI * 25 * 20);
    close(vols[1], Math.PI * 225 * 20);
  });

  it("Add that touches the part still joins it (a boss on top of the cylinder)", () => {
    // A second sketch on the top of Extrude 1 (z = 60), a small circle on it extruded 5 with Add.
    const boss = addCircle(emptySketch(), at(0, 0), 3).sketch;
    const sketch2: Feature = { id: "s2", name: "Sketch 2", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: planeOnFace([0, 0, 1], [0, 0, 60], "Top face"), data: boss } };
    engine = new GeometryEngine();
    const r = engine.rebuild([sketch, extrude("e1", "new", 60, [small]), sketch2, { ...extrude("e2", "add", 5, undefined), sketchRef: "s2" }]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(sizeOf(r.parts[0]).height).toBeCloseTo(65, 6);
    close(sizeOf(r.parts[0]).volume, Math.PI * 25 * 60 + Math.PI * 9 * 5);
  });

  it("Add joins the part it touches even when that isn't the latest one", () => {
    const boss = addCircle(emptySketch(), at(0, 0), 3).sketch;
    const sketch2: Feature = { id: "s2", name: "Sketch 2", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: planeOnFace([0, 0, 1], [0, 0, 60], "Top face"), data: boss } };
    engine = new GeometryEngine();
    const r = engine.rebuild([sketch, extrude("e1", "new", 60, [small]), extrude("e2", "add", 10, [big]), sketch2, { ...extrude("e3", "add", 5, undefined), sketchRef: "s2" }]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(sizeOf(r.parts[0]).height).toBeCloseTo(65, 6);
    close(sizeOf(r.parts[0]).volume, Math.PI * 25 * 60 + Math.PI * 9 * 5);
    close(sizeOf(r.parts[1]).volume, Math.PI * 225 * 10);
  });

  const topOf = (z: number, data: SketchData, id: string): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: planeOnFace([0, 0, 1], [0, 0, z], "Top face"), data } });
  const volumes = (r: { parts: { name: string; vertices: Float32Array; triangles: Uint32Array }[] }) => Object.fromEntries(r.parts.map((p) => [p.name, sizeOf(p).volume]));
  const twoParts = () => [sketch, extrude("e1", "new", 60, [small]), extrude("e2", "add", 10, [big])];

  it("a hole drilled into the tall cylinder (Part 1) cuts it, though Part 2 is the latest part", () => {
    const points = addPoint(emptySketch(), { x: 0, y: 0 }).sketch;
    const hole: Feature = {
      id: "h1",
      name: "Hole 1",
      type: "hole",
      operation: "remove",
      suppressed: false,
      params: { ...defaultParams("hole"), diameter: "4" },
      hole: { sketchRef: "s2", kind: "simple", standard: "Custom", fit: "clearance", end: "throughAll", flip: false },
      apart: true,
    };
    engine = new GeometryEngine();
    const r = engine.rebuild([...twoParts(), topOf(60, points, "s2"), hole]);
    expect(r.featureErrors).toEqual({});
    const v = volumes(r);
    close(v["Part 1"], Math.PI * 25 * 60 - Math.PI * 4 * 60);
    close(v["Part 2"], Math.PI * 225 * 10);
  });

  it("a Remove reaching both parts cuts both; one reaching neither says so", () => {
    // A 100 × 4 slot across both cylinders, cut 5 deep from z = 10 down.
    const slot = addRectangle(emptySketch(), at(-20, -2), at(80, 2)).sketch;
    engine = new GeometryEngine();
    const cut = { ...extrude("c1", "remove" as "add", 5, undefined), sketchRef: "s2", extrude: { end: "blind" as const, flip: true } };
    const r = engine.rebuild([...twoParts(), topOf(10, slot, "s2"), cut]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(2);
    const v = volumes(r);
    // The slot crosses each cylinder through its middle: the strip |y| < 2 of the disc, 5 deep.
    const strip = (r: number) => 2 * (2 * Math.sqrt(r * r - 4) + r * r * Math.asin(2 / r));
    close(v["Part 1"], Math.PI * 25 * 60 - strip(5) * 5);
    close(v["Part 2"], Math.PI * 225 * 10 - strip(15) * 5);
    engine.dispose();
    engine = new GeometryEngine();
    const far = addRectangle(emptySketch(), at(200, 200), at(210, 210)).sketch;
    const miss = engine.rebuild([...twoParts(), topOf(10, far, "s2"), cut]);
    expect(miss.featureErrors.c1).toMatch(/doesn't reach any part/);
    expect(miss.featureErrors.c1).not.toMatch(/latest part/);
  });

  it("an Add touching both parts merges them into one (the older one's name)", () => {
    // A bar from the small cylinder to the big one, on top of the big one (z = 10 up to 15).
    const bar = addRectangle(emptySketch(), at(-3, -2), at(45, 2)).sketch;
    engine = new GeometryEngine();
    const r = engine.rebuild([...twoParts(), topOf(10, bar, "s2"), { ...extrude("e3", "add", 5, undefined), sketchRef: "s2" }]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1"]);
    // Both cylinders plus the bar less where it overlaps them.
    expect(sizeOf(r.parts[0]).volume).toBeGreaterThan(Math.PI * 25 * 60 + Math.PI * 225 * 10);
  });

  it("pattern copies of a separate part become parts of their own; a copy touching a part joins it", () => {
    const pattern = (spacing: number): Feature => ({ id: "p1", name: "Pattern", type: "linearPattern", operation: "add", suppressed: false, params: { ...defaultParams("linearPattern"), count: "2", spacing: String(spacing) }, pattern: { sources: ["e2"], axis: "x", flip: false } });
    engine = new GeometryEngine();
    const r = engine.rebuild([...twoParts(), pattern(100)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2", "Part 3"]);
    close(volumes(r)["Part 3"], Math.PI * 225 * 10);
    engine.dispose();
    // Spaced 20: the copy overlaps the big cylinder, so it joins Part 2.
    engine = new GeometryEngine();
    const near = engine.rebuild([...twoParts(), pattern(20)]);
    expect(near.featureErrors).toEqual({});
    expect(near.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
  });

  it("New with two circles, then moving the second part (id ~2) moves it", () => {
    engine = new GeometryEngine();
    const move: Feature = { id: "t1", name: "Move", type: "transform", operation: "add", suppressed: false, params: { ...defaultParams("transform"), dx: "100" }, transform: { partId: "e1~2", axis: "z", about: "centre", copy: false } };
    const r = engine.rebuild([sketch, extrude("e1", "new", 20, undefined), move]);
    expect(r.featureErrors).toEqual({});
    const moved = r.parts.find((p) => p.id === "e1~2")!;
    let minX = Infinity;
    for (let i = 0; i < moved.vertices.length; i += 3) minX = Math.min(minX, moved.vertices[i]);
    expect(Math.abs(minX - 125)).toBeLessThan(0.1);
  });

  it("old files (extrudes without the mark) still keep both circles in one part, exactly as before", () => {
    engine = new GeometryEngine();
    const r = engine.rebuild([sketch, extrude("e1", "new", 60, [small], false), extrude("e2", "add", 10, [big], false)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    close(sizeOf(r.parts[0]).volume, Math.PI * 25 * 60 + Math.PI * 225 * 10);
  });
});
