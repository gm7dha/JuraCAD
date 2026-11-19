/**
 * Engine tests: Sweep's "Lock profile faces" (Onshape's) — the profile keeps the same angle to picked faces of a part
 * along a path of that part's edges, round sharp corners too. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import type { Feature, SweepOptions } from "../src/model/types";
import { addCircle } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, rectSketch, extrudeFeature } from "./support/engineHelpers";
import { polySketch } from "./support/frameSketch";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volOf = (id: string) => engine.check("fine", [id]).parts[0];
const sweep = (sketchRef: string, pathEdges: TopoPick[], c?: SweepOptions): Feature => ({ ...feature("sweep", {}), sketchRef, pathEdges, apart: true, ...(c ? { sweepControl: c } : {}) });

describe("Lock profile faces", () => {
  it("goes round a box's top edges, locked to its side faces (exact volume, sound)", () => {
    const box = feature("box", { width: 40, depth: 30, height: 10 });
    const part = build([box]).parts[0];
    const top = part.edgeRefs.filter((e: EdgeRef) => Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    const sides = part.faceRefs.filter((f: FaceRef) => Math.abs(f.center[2] - 5) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    expect(top.length).toBe(4);
    expect(sides.length).toBe(4);
    // A 2 × 2 square across the middle of the y = 0 edge, centred on it.
    const prof = sketchFeature({ kind: "face", origin: [20, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 20" }, rectSketch(-1, 9, 2, 2));
    const locked = sweep(prof.id, top, { lockFaces: sides });
    const r = build([box, prof, locked]);
    expect(r.featureErrors).toEqual({});
    const c = volOf(locked.id);
    expect(c.geometryValid).toBe(true);
    // The frame round the edges, outer corners rounded (radius 1): 2 × ((42·32 − 38·28) − 4(1 − π/4)).
    const expected = 2 * (42 * 32 - 38 * 28 - 4 * (1 - Math.PI / 4));
    expect(Math.abs(c.exactVolume! - expected)).toBeLessThan(1e-3);
    // The plain sweep gives the same here (the sides are flat, square to the path).
    const plain = sweep(prof.id, top);
    build([box, prof, plain]);
    expect(Math.abs(volOf(plain.id).exactVolume! - expected)).toBeLessThan(1e-3);
  });

  it("keeps a lip square to a round face round a slanted cut's edge (a plain sweep tips into the part)", () => {
    const base = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const rod = extrudeFeature(base.id, 30);
    const c30 = Math.cos(Math.PI / 6);
    const s30 = Math.sin(Math.PI / 6);
    // The top cut off at 30°, through (0, 0, 20).
    const slant = sketchFeature({ kind: "face", origin: [0, 0, 20], u: [1, 0, 0], v: [0, c30, s30], label: "slant" }, rectSketch(-20, -20, 40, 40));
    const cut = extrudeFeature(slant.id, 30, { operation: "remove" });
    const made = build([base, rod, slant, cut]);
    expect(made.featureErrors).toEqual({});
    const part = made.parts[0];
    const rim = part.edgeRefs.filter((e: EdgeRef) => e.curve !== "LINE" && e.mid[2] > 12).map((ref) => ({ partId: rod.id, ref }));
    const round = part.faceRefs.filter((f: FaceRef) => f.surface !== "PLANE").map((ref) => ({ partId: rod.id, ref }));
    expect(rim.length).toBeGreaterThan(0);
    expect(round.length).toBe(1);
    // A 2 × 2 square standing out from the round face just below the rim at (10, 0, 20), across the rim there.
    const prof = sketchFeature({ kind: "face", origin: [0, 0, 20], u: [1, 0, 0], v: [0, -s30, c30], label: "across" }, rectSketch(10, -2, 2, 2));
    const overlap = (c?: SweepOptions) => {
      const alone = { ...sweep(prof.id, rim, c), apart: true };
      const r1 = build([base, rod, slant, cut, prof, alone]);
      expect(r1.featureErrors).toEqual({});
      const v = volOf(alone.id);
      const verts = r1.parts.find((p) => p.id === alone.id)!.vertices;
      let rMin = Infinity;
      let rMax = 0;
      for (let k = 0; k < verts.length; k += 3) {
        const rr = Math.hypot(verts[k], verts[k + 1]);
        rMin = Math.min(rMin, rr);
        rMax = Math.max(rMax, rr);
      }

      expect(v.geometryValid).toBe(true);
      const joined: Feature = { ...alone, operation: "add" };
      build([base, rod, slant, cut, prof, joined]);
      const both = engine.check("fine").parts.reduce((t, p) => t + p.exactVolume!, 0);
      build([base, rod, slant, cut]);
      const cyl = engine.check("fine").parts[0].exactVolume!;
      return { sweep: v.exactVolume!, overlap: cyl + v.exactVolume! - both, rMin, rMax };
    };
    const locked = overlap({ lockFaces: round });
    // Locked to the round face, the square never leans into it.
    expect(Math.abs(locked.overlap)).toBeLessThan(0.002 * locked.sweep);
    // Its inner side stays on the round face all the way round (radius 10), the outer within the square's corner.
    expect(locked.rMin).toBeGreaterThan(9.99);
    expect(locked.rMax).toBeLessThan(Math.hypot(12, 2) + 0.01);
    // Turning with the slanted rim instead, it tips about 1 mm into the part on the far side.
    const plain = overlap();
    expect(plain.rMin).toBeLessThan(9.5);
  });

  it("refuses a sketch path, and path edges that aren't on the locked faces, in plain words", () => {
    const box = feature("box", { width: 40, depth: 30, height: 10 });
    const part = build([box]).parts[0];
    const top = part.edgeRefs.filter((e: EdgeRef) => Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    const sides = part.faceRefs.filter((f: FaceRef) => Math.abs(f.center[2] - 5) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    const prof = sketchFeature({ kind: "face", origin: [20, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 20" }, rectSketch(-1, 9, 2, 2));
    const path = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 40, 30));
    const bySketch: Feature = { ...feature("sweep", {}), sketchRef: prof.id, pathRef: path.id, apart: true, sweepControl: { lockFaces: sides } };
    expect(build([box, prof, path, bySketch]).featureErrors[bySketch.id]).toMatch(/Part edges/);
    // Only the x = 0 and x = 40 sides locked: the edges along x aren't on them.
    const some = sides.filter((f) => Math.abs(f.ref.kind === "face" ? f.ref.normal![0] : 0) > 0.5);
    const off = sweep(prof.id, top, { lockFaces: some });
    expect(build([box, prof, off]).featureErrors[off.id]).toMatch(/edges of those faces/);
  });
});

describe("Lock profile faces: placing and following (review)", () => {
  const boxTop = () => {
    const box = feature("box", { width: 40, depth: 30, height: 10 });
    const part = build([box]).parts[0];
    const top = part.edgeRefs.filter((e: EdgeRef) => Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    const sides = part.faceRefs.filter((f: FaceRef) => Math.abs(f.center[2] - 5) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    return { box, top, sides };
  };
  const zRange = (r: { parts: { id: string; vertices: Float32Array }[] }, id: string) => {
    const v = r.parts.find((p) => p.id === id)!.vertices;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 2; k < v.length; k += 3) [lo, hi] = [Math.min(lo, v[k]), Math.max(hi, v[k])];
    return [lo, hi];
  };

  it("keeps a lopsided profile the way up it's drawn, round a box's corners", () => {
    const { box, top, sides } = boxTop();
    // A 2 × 2 square standing on the y = 0 top edge, turned 0.4 rad: wholly above the top.
    const c = Math.cos(0.4);
    const s = Math.sin(0.4);
    const sq = [[0, 0], [2, 0], [2, 2], [0, 2]].map(([x, y]) => [x * c - y * s, 10 + x * s + y * c] as [number, number]);
    const prof = sketchFeature({ kind: "face", origin: [20, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 20" }, polySketch(sq));
    const locked = sweep(prof.id, top, { lockFaces: sides });
    const r = build([box, prof, locked]);
    expect(r.featureErrors).toEqual({});
    expect(volOf(locked.id).geometryValid).toBe(true);
    const [lo, hi] = zRange(r, locked.id);
    expect(lo).toBeGreaterThan(10 - 1e-3);
    expect(hi).toBeCloseTo(10 + 2 * s + 2 * c, 2);
  });

  it("goes round a filleted box's top, across flat and round faces", () => {
    const box = feature("box", { width: 40, depth: 30, height: 10 });
    const p0 = build([box]).parts[0];
    const upright = p0.edgeRefs.filter((e: EdgeRef) => Math.abs(e.a[2] - e.b[2]) > 5).map((ref) => ({ partId: box.id, ref }));
    const fillet: Feature = { ...feature("fillet", { radius: 5 }, "add"), picks: upright };
    const part = build([box, fillet]).parts[0];
    const top = part.edgeRefs.filter((e: EdgeRef) => Math.abs(e.mid[2] - 10) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    const sides = part.faceRefs.filter((f: FaceRef) => Math.abs(f.center[2] - 5) < 1e-3).map((ref) => ({ partId: box.id, ref }));
    expect(sides.length).toBe(8);
    const prof = sketchFeature({ kind: "face", origin: [20, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 20" }, rectSketch(-1, 9, 2, 2));
    const locked = sweep(prof.id, top, { lockFaces: sides });
    expect(build([box, fillet, prof, locked]).featureErrors).toEqual({});
    const v = volOf(locked.id);
    expect(v.geometryValid).toBe(true);
    // Pappus: the square's middle runs round the rounded rectangle.
    expect(Math.abs(v.exactVolume! - 4 * (2 * (40 + 30) - 8 * 5 + 2 * Math.PI * 5))).toBeLessThan(2e-3);
  });

  it("runs a groove round a cylinder's rim exactly, and starts part way along an open path", () => {
    const base = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const rod = extrudeFeature(base.id, 30);
    const part = build([base, rod]).parts[0];
    const rim = part.edgeRefs.filter((e: EdgeRef) => e.curve !== "LINE" && e.mid[2] > 29).map((ref) => ({ partId: rod.id, ref }));
    const round = part.faceRefs.filter((f: FaceRef) => f.surface !== "PLANE").map((ref) => ({ partId: rod.id, ref }));
    // Its plane crosses the rim right where the circle starts.
    const prof = sketchFeature({ kind: "face", origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], label: "xz" }, rectSketch(9, 29, 2, 2));
    const locked = sweep(prof.id, rim, { lockFaces: round });
    expect(build([base, rod, prof, locked]).featureErrors).toEqual({});
    expect(Math.abs(volOf(locked.id).exactVolume! - 4 * 2 * Math.PI * 10)).toBeLessThan(2e-3);
    // An L of two top edges of a box, the profile halfway along the first.
    const { box, top, sides } = boxTop();
    const ell = top.filter((e) => e.ref.kind === "edge" && (Math.abs(e.ref.mid[1]) < 1e-6 || Math.abs(e.ref.mid[0] - 40) < 1e-6));
    const mid = sketchFeature({ kind: "face", origin: [20, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 20" }, rectSketch(-1, 9, 2, 2));
    const along = sweep(mid.id, ell, { lockFaces: sides });
    expect(build([box, mid, along]).featureErrors).toEqual({});
    const plain = sweep(mid.id, ell);
    const lockedVolume = volOf(along.id).exactVolume!;
    build([box, mid, plain]);
    expect(Math.abs(lockedVolume - volOf(plain.id).exactVolume!)).toBeLessThan(1e-3);
  });
});
