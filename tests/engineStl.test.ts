/**
 * Engine test: importing a very detailed STL (a finely meshed ball, over
 * 20,000 triangles). It's on its own because it's by far the heaviest test:
 * OpenCascade turns every triangle into a face, which takes about a minute
 * and 2–3 GB of memory. OpenCascade never hands memory back while its
 * process lives, so in its own file that memory is freed as soon as it
 * finishes instead of weighing down all the tests after it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { feature, importFeature, loadOpenCascade, relativeError } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("importing STEP and STL files", () => {
  it("copes with a detailed STL", () => {
    build([feature("sphere", { diameter: 40 })]);
    const out = engine.exportStl([], "fine");
    engine.dispose();
    const stl = new Uint8Array(out.stl);
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const started = performance.now();
    const r = build([importFeature({ fileName: "ball.stl", format: "stl", data: btoa(b64), units: "mm" })]);
    const first = performance.now() - started;
    const t2 = performance.now();
    engine.rebuild([importFeature({ fileName: "ball.stl", format: "stl", data: btoa(b64), units: "mm" })]);
    const again = performance.now() - t2;
    expect(r.featureErrors).toEqual({});
    expect(out.triangleCount).toBeGreaterThan(20_000);
    expect(r.parts).toHaveLength(1);
    const ball = (4 / 3) * Math.PI * 20 ** 3;
    expect(relativeError(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume, ball)).toBeLessThan(0.01);
    // Speed depends on how busy the machine is, so this only checks that
    // rebuilding reuses the part and its mesh: far quicker than importing it
    // in the first place (which takes about a minute).
    expect(again).toBeLessThan(first / 5);
  }, 300_000);
});
