/**
 * Sketch Text and Intersect with the real OpenCascade engine: text outlines
 * extrude into solid letters, and Intersect's curves follow the part when it
 * changes.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { FONTS } from "../src/geometry/fonts";
import type { TypefaceFont } from "../src/geometry/text";
import type { EdgeRef, FaceRef } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { linkEdge, projectEdge } from "../src/sketch/links";
import { pointPos } from "../src/sketch/ops";
import { planeFrame, type SketchPlane } from "../src/sketch/planes";
import { addText, DEFAULT_TEXT } from "../src/sketch/sketchText";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, meshOf, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine | undefined;
afterEach(() => {
  engine?.dispose();
  engine = undefined;
});

const real = { ...FONTS };
/** A font whose "O" is a 10 × 10 square with a 5 × 5 hole in the middle (at size 10). */
const squareFont: TypefaceFont = {
  resolution: 1000,
  boundingBox: { yMin: 0, yMax: 1000 },
  glyphs: { O: { ha: 1200, o: "m 0 0 l 1000 0 l 1000 1000 l 0 1000 m 250 250 l 250 750 l 750 750 l 750 250" } },
};


const top: SketchPlane = { kind: "default", name: "Top" };

function build(features: Parameters<GeometryEngine["rebuild"]>[0]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("sketch text", () => {
  it("a letter's outline with its hole extrudes to exactly the right volume", () => {
    FONTS.regular = squareFont;
    try {
      const t = addText(emptySketch(), { x: 5, y: 5 }, { ...DEFAULT_TEXT, value: "O", size: 10 });
      expect(t.error).toBeUndefined();
      const sk = sketchFeature(top, t.sketch);
      const r = build([sk, extrudeFeature(sk.id, 2)]);
      expect(r.featureErrors).toEqual({});
      const m = meshOf(r);
      // (10 × 10 − 5 × 5) × 2.
      expect(m.volume).toBeCloseTo(150, 3);
      expect(m.watertight).toBe(true);
      expect(m.bounds!.min[0]).toBeCloseTo(5, 4);
      expect(m.bounds!.max[1]).toBeCloseTo(15, 4);
    } finally {
      FONTS.regular = real.regular;
    }
  });

  it("text turned 90° about its anchor, centred on it", () => {
    FONTS.regular = squareFont;
    try {
      const t = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "O", size: 10, angle: 90, anchorAt: "centre" });
      const sk = sketchFeature(top, t.sketch);
      const r = build([sk, extrudeFeature(sk.id, 1)]);
      const m = meshOf(r);
      expect(m.volume).toBeCloseTo(75, 3);
      expect(m.bounds!.min[0]).toBeCloseTo(-5, 4);
      expect(m.bounds!.max[0]).toBeCloseTo(5, 4);
    } finally {
      FONTS.regular = real.regular;
    }
  });

  it("real letters (the app's font) make a valid solid", () => {
    // Only where the real font is installed (CI); the local stand-in font has no letters.
    if (!Object.keys(real.regular.glyphs).length) return;
    const t = addText(emptySketch(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "JuraCAD 8", size: 12 });
    const sk = sketchFeature(top, t.sketch);
    const r = build([sk, extrudeFeature(sk.id, 1.5)]);
    expect(r.featureErrors).toEqual({});
    const m = meshOf(r);
    expect(m.volume).toBeGreaterThan(20);
    expect(m.watertight).toBe(true);
  });
});

describe("Intersect", () => {
  /** A box w × 20 × h, from y = −10 to 10, so the Front plane (y = 0) cuts through its middle. */
  const box = (w: number, h: number) => feature("box", { width: w, depth: 20, height: h, x: 0, y: -10, z: 0 });
  const front: SketchPlane = { kind: "default", name: "Front" };

  function intersect(partId: string, face?: FaceRef): EdgeRef[] {
    const r = engine!.intersect(partId, front, face);
    if ("error" in r) throw new Error(r.error);
    return r.edges;
  }

  /** Bring the cut edges into a sketch as Intersect does. */
  function bringIn(edges: EdgeRef[], partId: string, face?: FaceRef): SketchData {
    let data = emptySketch();
    for (const ref of edges) {
      const seen = projectEdge(planeFrame(front), { partId, ref });
      expect(seen).not.toBeNull();
      const r = linkEdge(data, seen!, true, face ? { face } : {});
      expect(r.error).toBeUndefined();
      data = r.sketch;
    }
    return data;
  }

  const corners = (d: SketchData) => [...new Set(d.points.map((p) => `${Math.round(p.x * 1e4) / 1e4},${Math.round(p.y * 1e4) / 1e4}`))].sort();

  it("the whole part: the box's cross-section, which follows the box when it's resized", () => {
    const b = box(40, 10);
    build([b]);
    const edges = intersect(b.id);
    expect(edges).toHaveLength(4);
    const data = bringIn(edges, b.id);
    expect(data.curves.every((c) => c.construction && "link" in c && c.link?.cut)).toBe(true);
    expect(corners(data)).toEqual(["0,0", "0,10", "40,0", "40,10"]);

    // Wider and taller: the curves move to the new cross-section.
    const sk = sketchFeature(front, data);
    const r = build([{ ...box(60, 15), id: b.id }, sk]);
    expect(r.featureErrors).toEqual({});
    const info = r.sketchLinks![sk.id];
    expect(Object.values(info.links).every((e) => e !== null)).toBe(true);
    expect(corners(info.sketch!.data)).toEqual(["0,0", "0,15", "60,0", "60,15"]);
  });

  it("one face: just the line where the plane cuts the top face", () => {
    const b = box(40, 10);
    build([b]);
    const topFace: FaceRef = { kind: "face", surface: "PLANE", center: [20, 0, 10], normal: [0, 0, 1] };
    const edges = intersect(b.id, topFace);
    expect(edges).toHaveLength(1);
    const data = bringIn(edges, b.id, topFace);
    const line = data.curves[0];
    expect(line.type).toBe("line");
    expect(line.type === "line" && line.link?.cut?.face?.surface).toBe("PLANE");

    const sk = sketchFeature(front, data);
    const r = build([{ ...box(60, 15), id: b.id }, sk]);
    expect(r.featureErrors).toEqual({});
    const now = r.sketchLinks![sk.id].sketch!.data;
    if (line.type !== "line") return;
    const ends = [pointPos(now, line.p1), pointPos(now, line.p2)].map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
    expect(ends.sort((p, q) => p[0] - q[0])).toEqual([
      [0, 15],
      [60, 15],
    ]);
  });

  it("a hole through the box shows up as a circle in a sketch across it", () => {
    const b = box(40, 10);
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 20, y: 0, z: 0 }, "remove");
    build([b, hole]);
    // A plane level with the Top plane, half way up the box.
    const mid: SketchPlane = { kind: "face", origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], label: "Middle" };
    const r = engine!.intersect(b.id, mid);
    expect("edges" in r).toBe(true);
    if (!("edges" in r)) return;
    const round = r.edges.filter((e) => e.curve === "CIRCLE");
    expect(round.length).toBeGreaterThan(0);
    for (const e of round) {
      const seen = projectEdge(planeFrame(mid), { partId: b.id, ref: e })!;
      expect(seen.centre![0]).toBeCloseTo(20, 4);
      expect(seen.centre![1]).toBeCloseTo(0, 4);
      expect(seen.radius!).toBeCloseTo(3, 4);
    }
  });

  it("says so kindly when the plane misses the face", () => {
    const b = box(40, 10);
    build([b]);
    const r = engine!.intersect(b.id, { kind: "default", name: "Top" }, { kind: "face", surface: "PLANE", center: [20, 0, 10], normal: [0, 0, 1] });
    expect("error" in r && r.error).toMatch(/doesn't cut through that face/);
  });
});
