/**
 * The assembly clash check against the real OpenCascade engine: overlapping
 * solids, parts that only touch (within a tolerance), surfaces through solids
 * and surfaces crossing each other.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { billOfMaterials, meshVolume } from "../src/assembly/assembly";
import { massGrams } from "../src/model/materials";
import { judgeContacts, DEFAULT_CLASH_OPTIONS, type Contact } from "../src/assembly/assemblyCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { InstanceInput } from "../src/kernel/protocol";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType } from "../src/model/types";
import { addLine } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const box: Feature = { id: "box", name: "Box", type: "box" as FeatureType, operation: "new", suppressed: false, params: { ...defaultParams("box"), width: "10", depth: "10", height: "10" } };
const top: SketchPlane = { kind: "default", name: "Top" };
const sk: Feature = { id: "sk", name: "Sketch", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: top, data: addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch } };
/** A flat wall surface 20 long (x) and 5 high (z), at y = 0. */
const wall: Feature = { id: "wall", name: "Wall", type: "extrude", operation: "new", suppressed: false, params: { depth: "5" }, sketchRef: "sk", extrude: { end: "blind", flip: false }, surface: true };

const ID: [number, number, number, number] = [0, 0, 0, 1];
const TURN_Z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const put = (name: string, partId: string, x: number, y = 0, z = 0, rotation = ID): InstanceInput => ({ id: name, partId, name, position: [x, y, z], rotation });

function setup() {
  engine = new GeometryEngine();
  const r = engine.rebuild([box, sk, wall]);
  expect(r.featureErrors).toEqual({});
  expect(r.parts.map((p) => [p.id, !!p.surface])).toEqual([
    ["box", false],
    ["wall", true],
  ]);
}

const judged = (instances: InstanceInput[], tolerance = 0.01, ignoreTouching = false): Contact[] =>
  judgeContacts(engine.clashes(instances, tolerance), { ...DEFAULT_CLASH_OPTIONS, tolerance, ignoreTouching });

describe("assembly clash check", () => {
  it("tells overlapping solids from ones that only touch, within the tolerance", () => {
    setup();
    // Overlapping by half: a clash of 500 mm³.
    const half = judged([put("A", "box", 0), put("B", "box", 5)]);
    expect(half).toHaveLength(1);
    expect(half[0].kind).toBe("overlap");
    if (half[0].kind === "overlap") expect(half[0].volume).toBeCloseTo(500, 3);
    // Face to face: touching, listed only when touching parts are wanted.
    expect(judged([put("A", "box", 0), put("B", "box", 10)])).toEqual([{ kind: "touch", a: "A", b: "B" }]);
    expect(judged([put("A", "box", 0), put("B", "box", 10)], 0.01, true)).toEqual([]);
    // A 0.005 mm sliver of overlap: touching with a 0.01 mm tolerance, a clash with 0.001 mm.
    expect(judged([put("A", "box", 0), put("B", "box", 9.995)]).map((c) => c.kind)).toEqual(["touch"]);
    const strict = judged([put("A", "box", 0), put("B", "box", 9.995)], 0.001);
    expect(strict.map((c) => c.kind)).toEqual(["overlap"]);
    if (strict[0].kind === "overlap") expect(strict[0].volume).toBeCloseTo(0.5, 3);
    // A 0.005 mm gap counts as touching within 0.01 mm; with no tolerance they're apart.
    expect(judged([put("A", "box", 0), put("B", "box", 10.005)]).map((c) => c.kind)).toEqual(["touch"]);
    expect(judged([put("A", "box", 0), put("B", "box", 10.005)], 0)).toEqual([]);
    // Well apart: nothing.
    expect(engine.clashes([put("A", "box", 0), put("B", "box", 30)], 0.01)).toEqual([]);
  });

  it("finds a surface going through a solid (not as a solid), and one that only lies on it", () => {
    setup();
    // The wall through the middle of the box: 10 × 5 of it inside.
    const through = judged([put("Box", "box", 0), put("Skin", "wall", 0, 5)]);
    expect(through).toHaveLength(1);
    expect(through[0]).toMatchObject({ kind: "through", a: "Skin", b: "Box" });
    if (through[0].kind === "through") expect(through[0].area).toBeCloseTo(50, 3);
    // Listed the same whichever comes first.
    expect(judged([put("Skin", "wall", 0, 5), put("Box", "box", 0)])[0]).toMatchObject({ kind: "through", a: "Skin", b: "Box" });
    // Lying on the box's side face: touching, not a clash.
    expect(judged([put("Box", "box", 0), put("Skin", "wall", 0, 0)]).map((c) => c.kind)).toEqual(["touch"]);
    // Just 0.005 mm inside: touching within 0.01 mm.
    expect(judged([put("Box", "box", 0), put("Skin", "wall", 0, 0.005)]).map((c) => c.kind)).toEqual(["touch"]);
  });

  it("finds surfaces crossing each other, but not ones meeting edge to edge", () => {
    setup();
    // A second wall turned square to the first, crossing it at x = 10, y = 5, all 5 mm up.
    const cross = judged([put("W1", "wall", 0, 5), put("W2", "wall", 10, -5, 0, TURN_Z)]);
    expect(cross).toHaveLength(1);
    expect(cross[0].kind).toBe("cross");
    if (cross[0].kind === "cross") expect(cross[0].length).toBeCloseTo(5, 3);
    // Meeting at a corner (the end of one along the end of the other): touching only.
    expect(judged([put("W1", "wall", 0, 0), put("W2", "wall", 20, 0, 0, TURN_Z)]).map((c) => c.kind)).toEqual(["touch"]);
  });

  it("gives each solid part its exact volume (for weights), not the display mesh's", () => {
    engine = new GeometryEngine();
    const ball: Feature = { id: "ball", name: "Ball", type: "sphere" as FeatureType, operation: "new", suppressed: false, params: { ...defaultParams("sphere"), diameter: "20" } };
    const r = engine.rebuild([ball, sk, wall]);
    const exact = (4 / 3) * Math.PI * 1000;
    expect(r.parts[0].volume!).toBeCloseTo(exact, 3);
    // The mesh is made of flat triangles inside the ball, so it comes out smaller.
    expect(meshVolume(r.parts[0].vertices, r.parts[0].triangles)).toBeLessThan(exact - 1);
    // A surface has no volume.
    expect(r.parts[1].volume).toBe(undefined);
    // The parts list weighs it from the exact volume (PLA, 1.24 g/cm³).
    const rows = billOfMaterials({ id: "a", name: "A", instances: [{ id: "i", partId: "ball", name: "Ball <1>", placement: { position: [0, 0, 0], rotation: ID }, fixed: true }] }, { ball: "Ball" }, {}, () => ({ volume: r.parts[0].volume! }));
    expect(rows[0].massEach!).toBeCloseTo(massGrams(exact, undefined), 6);
  });

  it("counts a small corner overlap as a clash, a press-fit sleeve as touching, and skips gaps when asked", () => {
    setup();
    // Overlapping by 0.02 mm each way at a corner: a 0.02 mm cube — thicker than 0.01, so a clash.
    expect(judged([put("A", "box", 0), put("B", "box", 9.98, 9.98, 9.98)], 0.01, true).map((c) => c.kind)).toEqual(["overlap"]);
    // Without gaps (touching parts not wanted), a pair that only touches isn't even measured.
    expect(engine.clashes([put("A", "box", 0), put("B", "box", 10)], 0.01, false)).toEqual([]);
    expect(engine.clashes([put("A", "box", 0), put("B", "box", 10)], 0.01, true)).toHaveLength(1);
    engine.dispose();
    // A 10 mm hole through a block and a 10.01 mm pin in it: 0.005 mm interference all round — a press fit.
    engine = new GeometryEngine();
    const block: Feature = { ...box, id: "block", params: { ...box.params, width: "20", depth: "20", height: "10" } };
    const hole: Feature = { id: "hole", name: "Hole", type: "cylinder" as FeatureType, operation: "remove", suppressed: false, params: { ...defaultParams("cylinder"), diameter: "10", height: "30", x: "10", y: "10", z: "-10" } };
    const pin: Feature = { id: "pin", name: "Pin", type: "cylinder" as FeatureType, operation: "new", suppressed: false, params: { ...defaultParams("cylinder"), diameter: "10.01", height: "10", x: "10", y: "10", z: "0" } };
    const r = engine.rebuild([block, hole, pin]);
    expect(r.parts.map((p) => p.id)).toEqual(["block", "pin"]);
    const fit = judged([put("Block", "block", 0), put("Pin", "pin", 0)], 0.01);
    expect(fit.map((c) => c.kind)).toEqual(["touch"]);
    // With a tighter tolerance it's a clash.
    expect(judged([put("Block", "block", 0), put("Pin", "pin", 0)], 0.001).map((c) => c.kind)).toEqual(["overlap"]);
  });
});
