/**
 * Engine test: a very detailed STL (300,000 triangles, six times what a solid can have) reduced when it's imported and
 * then built as a part. On its own because OpenCascade's memory for the solid (~1.5 GB) is only freed when the
 * process ends.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { writeBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import { readImport, reduceStl, storedTriangles, USUAL_REDUCE } from "../src/model/importFile";
import { importFeature, loadOpenCascade, relativeError } from "./support/engineHelpers";
import { bandedBall } from "./support/meshShapes";

beforeAll(loadOpenCascade);

let engine: GeometryEngine | undefined;
afterEach(() => engine?.dispose());

describe("importing a very detailed STL", () => {
  it("reduces 300,000 triangles and builds a sound part of the same size", () => {
    const ball = bandedBall(275, 550);
    const n = ball.triangles.length / 3;
    expect(n).toBeGreaterThan(300_000);
    const bytes = new Uint8Array(writeBinaryStl([ball]));
    const read = readImport("figure.stl", bytes);
    expect(read.ok).toBe("reduce");
    const t0 = performance.now();
    const file = reduceStl("figure.stl", bytes, USUAL_REDUCE);
    const reducing = performance.now() - t0;
    expect(storedTriangles(file)).toBeLessThanOrEqual(USUAL_REDUCE);
    expect(file.reducedFrom).toBe(n);
    engine = new GeometryEngine();
    const t1 = performance.now();
    const r = engine.rebuild([importFeature(file)]);
    const building = performance.now() - t1;
    console.log(`reduced ${n} → ${storedTriangles(file)} in ${(reducing / 1000).toFixed(1)} s, built in ${(building / 1000).toFixed(1)} s`);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const want = analyzeMesh(ball.vertices, ball.triangles).volume;
    expect(relativeError(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume, want)).toBeLessThan(0.01);
  }, 900_000);
});
