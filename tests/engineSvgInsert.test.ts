/**
 * Insert SVG with the real OpenCascade engine: a square with a round hole (a laser-style compound path) and a
 * shape with curves and an elliptical arc, extruded to the right volumes.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { insertSvg, parseSvg } from "../src/sketch/svg";
import { emptySketch, type SketchData } from "../src/sketch/types";
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
  // Exactly, from the solid (the mesh only approximates curved faces).
  return engine.massProperties([])[0].volume;
}
const sketchOf = (svg: string) => {
  const r = insertSvg(emptySketch(), parseSvg(svg), 1);
  expect(r.error).toBeUndefined();
  return r.sketch;
};

describe("an inserted SVG extrudes", () => {
  it("a 40 mm square with a 20 mm round hole (Inkscape-style, in a moved group)", () => {
    const s = sketchOf(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><g transform="translate(-5 -5)"><path style="fill:#000;stroke:none" d="m 5,5 h 40 v 40 h -40 z M 25,15 a 10,10 0 1 1 0,20 10,10 0 1 1 0,-20 z"/></g></svg>',
    );
    expect(relativeError(volumeOf(s), (1600 - Math.PI * 100) * 5)).toBeLessThan(1e-6);
  });

  it("a rounded rectangle squashed into ellipse corners, and a cubic-curve lens", () => {
    const rounded = sketchOf('<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="40mm" viewBox="0 0 60 40"><rect x="0" y="0" width="40" height="20" rx="5" transform="scale(1.5 2)"/></svg>');
    // Every length × 1.5 across and × 2 up: area × 3.
    expect(relativeError(volumeOf(rounded), (800 - (4 - Math.PI) * 25) * 3 * 5)).toBeLessThan(1e-6);
    // A lens of two cubic arches, each (0,0) (10,10) (30,10) (40,0) from its chord: 210 mm² each (exact, by Green's theorem).
    const lens = sketchOf('<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><path d="M0 20 C10 10 30 10 40 20 C30 30 10 30 0 20 Z"/></svg>');
    expect(lens.curves).toHaveLength(1);
    expect(relativeError(volumeOf(lens), 2 * 210 * 5)).toBeLessThan(1e-6);
  });
});
