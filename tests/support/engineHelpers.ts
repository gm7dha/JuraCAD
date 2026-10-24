/**
 * Shared set-up for the tests that run the real OpenCascade engine
 * (tests/engine*.test.ts). They used to be one big file; it's split into
 * several so no single test process grows huge (each test file runs in its
 * own process, and OpenCascade's memory is only given back when it ends).
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { analyzeMesh } from "../../src/geometry/meshCheck";
import { defaultParams } from "../../src/model/features";
import type { Feature, FeatureType, Operation } from "../../src/model/types";
import { addLine, addRectangle } from "../../src/sketch/ops";
import type { SketchPlane } from "../../src/sketch/planes";
import { emptySketch, type SketchData } from "../../src/sketch/types";

/** Loads the OpenCascade engine (use as `beforeAll(loadOpenCascade)`). */
export async function loadOpenCascade() {
  const OC = await opencascade();
  setOC(OC);
}

let n = 0;
/** A fresh number for a feature's id and name ("f1", "f2", …). */
export function nextId(): number {
  return ++n;
}

export function feature(type: FeatureType, params: Record<string, string | number>, operation: Operation = "new"): Feature {
  const n = nextId();
  return {
    id: `f${n}`,
    name: `${type} ${n}`,
    type,
    operation,
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}

export const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / expected;

export function sketchFeature(plane: SketchPlane | null, data: SketchData): Feature {
  const n = nextId();
  return { id: `f${n}`, name: `Sketch ${n}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } };
}

export function extrudeFeature(sketchRef: string, depth: number, opts: Partial<Pick<Feature, "operation">> & { end?: "blind" | "symmetric"; flip?: boolean } = {}): Feature {
  const n = nextId();
  return {
    id: `f${n}`,
    name: `Extrude ${n}`,
    type: "extrude",
    operation: opts.operation ?? "new",
    suppressed: false,
    params: { depth: String(depth) },
    sketchRef,
    extrude: { end: opts.end ?? "blind", flip: opts.flip ?? false },
  };
}

export const rectSketch = (x0: number, y0: number, w: number, h: number) => addRectangle(emptySketch(), { x: x0, y: y0 }, { x: x0 + w, y: y0 + h }).sketch;
export const lineSketch = (x0: number, y0: number, x1: number, y1: number) => addLine(emptySketch(), { x: x0, y: y0 }, { x: x1, y: y1 }).sketch;
export const meshOf = (r: { parts: { vertices: Float32Array; triangles: Uint32Array }[] }, i = 0) => analyzeMesh(r.parts[i].vertices, r.parts[i].triangles);

/** An Import feature that brings in the given file. */
export function importFeature(file: Feature["import"], operation: Operation = "new"): Feature {
  return { ...feature("import", {}, operation), import: file };
}
