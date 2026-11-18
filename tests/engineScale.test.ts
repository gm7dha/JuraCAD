/**
 * Engine tests: Import's Scale / File units and Move / copy's Scale uniformly, with the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import { stepLengthUnit } from "../src/model/importScale";
import type { Feature, TransformDef } from "../src/model/types";
import { loadOpenCascade, feature, importFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volume = (r: ReturnType<typeof build>, i = 0) => analyzeMesh(r.parts[i].vertices, r.parts[i].triangles).volume;
const bounds = (r: ReturnType<typeof build>, i = 0) => {
  const b = analyzeMesh(r.parts[i].vertices, r.parts[i].triangles).bounds!;
  const tidy = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000 + 0);
  return [tidy(b.min), tidy(b.max)];
};
const move = (partId: string, t: Partial<TransformDef>, params: Record<string, number | string>): Feature => ({
  ...feature("transform", params, "add"),
  transform: { partId, axis: "z", about: "centre", copy: false, mode: "scale", ...t },
});

async function boxStep(): Promise<string> {
  build([feature("box", { width: 40, depth: 30, height: 20, x: 10 })]);
  const step = new TextDecoder().decode((await engine.exportStep([])).step);
  engine.dispose();
  return step;
}

function boxStl(): string {
  build([feature("box", { width: 20, depth: 20, height: 20 })]);
  const stl = new Uint8Array(engine.exportStl([], "normal").stl);
  engine.dispose();
  let b64 = "";
  for (const x of stl) b64 += String.fromCharCode(x);
  return btoa(b64);
}

describe("Import: Scale and File units", () => {
  it("scales a STEP file by 2 (8 × the volume), about the origin, without changing an unscaled import", async () => {
    const step = await boxStep();
    expect(stepLengthUnit(step)).toBe(1);
    const file = { fileName: "box.step", format: "step" as const, data: step, units: "mm" as const };
    const plain = importFeature(file);
    const r0 = build([plain]);
    expect(r0.featureErrors).toEqual({});
    expect(volume(r0)).toBeCloseTo(24000, 0);
    const mesh0 = r0.parts[0].vertices.slice();
    engine.dispose();

    const big = { ...plain, params: { scale: "2" } };
    const r = build([big]);
    expect(r.featureErrors).toEqual({});
    expect(volume(r)).toBeCloseTo(8 * 24000, -1);
    expect(bounds(r)).toEqual([[20, 0, 0], [100, 60, 40]]);
    // Back to 1 in the same engine (the file read is remembered): exactly as before.
    const again = engine.rebuild([plain]);
    expect(Array.from(again.parts[0].vertices)).toEqual(Array.from(mesh0));

    // File units: the box's millimetres read as centimetres.
    const cm = engine.rebuild([{ ...plain, importUnits: "cm" }]);
    expect(volume(cm)).toBeCloseTo(24000 * 1000, -3);
    // A scale of 0 is refused plainly.
    const zero = engine.rebuild([{ ...plain, params: { scale: "0" } }]);
    expect(zero.featureErrors[plain.id]).toMatch(/Scale.*more than 0/);
  });

  it("gives an inch or metre STEP file its real size, and reads its numbers as other units without converting twice", async () => {
    const step = await boxStep();
    const m = /#(\d+)\s*=\s*\(\s*LENGTH_UNIT\s*\(\s*\)\s*NAMED_UNIT\s*\(\s*\*\s*\)\s*SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)\s*\)\s*;/.exec(step)!;
    // As another program writes inches: a millimetre unit first, then an inch made from it.
    const inch = step
      .replace(m[0], `#${m[1]}=(CONVERSION_BASED_UNIT('INCH',#9001)LENGTH_UNIT()NAMED_UNIT(#9002));`)
      .replace("DATA;\n", "DATA;\n#9003=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));\n#9001=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#9003);\n#9002=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);\n");
    const metre = step.replace(m[0], `#${m[1]}=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));`);
    const f = (data: string) => importFeature({ fileName: "b.step", format: "step", data, units: "mm" });
    const inF = f(inch);
    expect(bounds(build([inF]))[1]).toEqual([1270, 762, 508]);
    expect(bounds(engine.rebuild([{ ...inF, importUnits: "in" }]))[1]).toEqual([1270, 762, 508]);
    expect(bounds(engine.rebuild([{ ...inF, importUnits: "mm" }]))[1]).toEqual([50, 30, 20]);
    engine.dispose();
    const mF = f(metre);
    expect(bounds(build([mF]))[1]).toEqual([50000, 30000, 20000]);
    expect(bounds(engine.rebuild([{ ...mF, importUnits: "mm" }]))[1]).toEqual([50, 30, 20]);
  });

  it("reads an STL's numbers as inches (25.4 × every way)", () => {
    const data = boxStl();
    const file = { fileName: "cube.stl", format: "stl" as const, data, units: "mm" as const };
    const r = build([{ ...importFeature(file), importUnits: "in" }]);
    expect(r.featureErrors).toEqual({});
    expect(bounds(r)[1]).toEqual([508, 508, 508]);
    // With Simplify too: tidied first, then scaled.
    const s = engine.rebuild([{ ...importFeature(file), importUnits: "in", simplify: "normal" }]);
    expect(s.featureErrors).toEqual({});
    expect(volume(s)).toBeCloseTo(8000 * 25.4 ** 3, -4);
  });
});

describe("Import: Simplify at a scale", () => {
  it("tidies the file as it is, then tells its sizes as scaled", () => {
    build([feature("cylinder", { diameter: 10, height: 5 })]);
    const raw = new Uint8Array(engine.exportStl([], "fine").stl);
    engine.dispose();
    let b64 = "";
    for (const x of raw) b64 += String.fromCharCode(x);
    const file = { fileName: "disc.stl", format: "stl" as const, data: btoa(b64), units: "mm" as const };
    const plain = { ...importFeature(file), simplify: "normal" as const };
    const r1 = build([plain]);
    expect(r1.featureNotes?.[plain.id]).toMatch(/Ø10\b/);
    const r2 = engine.rebuild([{ ...plain, params: { scale: "2" } }]);
    expect(r2.featureErrors).toEqual({});
    expect(r2.featureNotes?.[plain.id]).toMatch(/Ø20\b/);
    expect(bounds(r2)[1][2]).toBeCloseTo(10, 2);
  });
});

describe("Move / copy: Scale uniformly", () => {
  it("scales about the part's centre, keeping the centre", () => {
    const b = feature("box", { width: 10, depth: 20, height: 4 });
    const m = move(b.id, {}, { factor: 3 });
    const r = build([b, m]);
    expect(r.featureErrors).toEqual({});
    // Centre (5, 10, 2) stays put.
    expect(bounds(r)).toEqual([[-10, -20, -4], [20, 40, 8]]);
    expect(volume(r)).toBeCloseTo(800 * 27, 0);
  });

  it("scales about a clicked point, and makes a scaled copy", () => {
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 10 });
    const triad = { origin: [0, 0, 0] as [number, number, number], x: [1, 0, 0] as [number, number, number], z: [0, 0, 1] as [number, number, number] };
    const r = build([b, move(b.id, { triad }, { factor: 0.5 })]);
    expect(bounds(r)).toEqual([[5, 0, 0], [10, 5, 5]]);
    engine.dispose();
    const c = move(b.id, { copy: true }, { factor: 2 });
    const r2 = build([b, c]);
    expect(r2.featureErrors).toEqual({});
    expect(r2.parts).toHaveLength(2);
    expect(volume(r2, 0)).toBeCloseTo(1000, 0);
    expect(volume(r2, 1)).toBeCloseTo(8000, 0);
  });

  it("scales an imported part, refuses 0 and says when nothing changes", async () => {
    const step = await boxStep();
    const imp = importFeature({ fileName: "box.step", format: "step", data: step, units: "mm" });
    const r = build([imp, move(imp.id, {}, { factor: 2 })]);
    expect(r.featureErrors).toEqual({});
    expect(volume(r)).toBeCloseTo(8 * 24000, -1);
    const zero = move(imp.id, {}, { factor: "0" });
    expect(engine.rebuild([imp, zero]).featureErrors[zero.id]).toMatch(/more than 0/);
    const one = move(imp.id, {}, { factor: 1 });
    expect(engine.rebuild([imp, one]).featureErrors[one.id]).toMatch(/other than 1/);
  });

  it("carries a connector the part owns along (its directions stay one long), and says what a bigger part leaves out", () => {
    const b = feature("box", { width: 10, depth: 10, height: 10 });
    const conn: Feature = { ...feature("mateConnector", {}), connector: { at: { p: [10, 10, 10] }, plane: { kind: "default", name: "Top" }, owner: b.id, base: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } } };
    const r = build([b, conn, move(b.id, { about: "origin" }, { factor: 2 })]);
    expect(r.featureErrors).toEqual({});
    const c = r.parts[0].connectors![0];
    expect(c.origin.map((n) => Math.round(n * 1e6) / 1e6)).toEqual([20, 20, 0]);
    expect(Math.hypot(...c.z)).toBeCloseTo(1, 9);
    expect(Math.hypot(...c.x)).toBeCloseTo(1, 9);
    engine.dispose();

    const bolt: Feature = { ...feature("fastener", { length: 8, x: 0, y: 0, z: 0 }), fastener: { kind: "bolt", size: "M6", threaded: false } };
    const big = build([bolt, move(bolt.id, {}, { factor: 2 })]);
    expect(big.featureErrors).toEqual({});
    expect(Object.values(big.featureWarnings ?? {}).join(" ")).toMatch(/modelled threads/);
  });
});
