/**
 * Split face and Modify fillet (Onshape's), and Fillet's "every edge of the part", with the real OpenCascade engine:
 * face counts, volumes unchanged by a split, a draft on half a split face, fillets re-sized and taken off.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import type { FaceRef, TopoPick } from "../src/geometry/topoRef";
import { addLine } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, importFeature, rectSketch } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volume = () => engine.check("normal").parts[0].exactVolume!;
const sound = () => engine.check("normal").parts[0].geometryValid;
type Built = ReturnType<typeof build>;
const faces = (r: Built, test: (f: FaceRef) => boolean, part = 0): TopoPick[] =>
  r.parts[part].faceRefs.filter((f): f is FaceRef => f.kind === "face" && test(f)).map((ref) => ({ partId: r.parts[part].id, ref }));
const faceCount = (r: Built, part = 0) => r.parts[part].faceRefs.filter((f) => f.kind === "face").length;
const frontFace = (f: FaceRef) => f.surface === "PLANE" && f.normal[1] < -0.99;

/** A level plane at height z (a face plane with no face, as the library's level planes). */
const level = (z: number) => ({ kind: "face" as const, origin: [0, 0, z] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: `z = ${z}` });

function splitFace(picks: TopoPick[], extra: Partial<Feature> & { tool?: "plane" | "sketch" | "edges"; plane?: ReturnType<typeof level> } = {}): Feature {
  const { tool, plane, ...rest } = extra;
  return {
    ...feature("split", {}),
    splitDef: { plane: plane ?? level(5), keep: "both", mode: "face", ...(tool ? { tool } : {}) },
    picks,
    ...rest,
  };
}

describe("split face", () => {
  it("divides a face along a plane: one more face, the same volume, one part", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    expect(faceCount(r1)).toBe(6);
    const split = splitFace(faces(r1, frontFace));
    const r = build([box, split]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(faceCount(r)).toBe(7);
    expect(volume()).toBeCloseTo(4000, 6);
    expect(sound()).toBe(true);
    // The two halves can be picked on their own.
    expect(faces(r, frontFace)).toHaveLength(2);
  });

  it("drafts only the upper half of a split face", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const split = splitFace(faces(r1, frontFace));
    const r2 = build([box, split]);
    const upper = faces(r2, (f) => frontFace(f) && f.center[2] > 5);
    expect(upper).toHaveLength(1);
    const draft: Feature = { ...feature("draft", { angle: 5 }), picks: upper, neutral: level(5) };
    const r = build([box, split, draft]);
    expect(r.featureErrors).toEqual({});
    // Only the top half leans in: a 5 mm tall wedge, 20 wide, 5·tan 5° deep, comes off.
    const wedge = 0.5 * 5 * 5 * Math.tan((5 * Math.PI) / 180) * 20;
    expect(volume()).toBeCloseTo(4000 - wedge, 4);
    // The lower half is still upright.
    expect(faces(r, (f) => frontFace(f) && f.center[2] < 5)).toHaveLength(1);
  });

  it("divides a face along a sketch's line, pushed along the sketch's normal", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    // A line across the top face, drawn on Top (z = 0): pushed up, it crosses the top face at z = 10.
    const sk = sketchFeature({ kind: "default", name: "Top" }, addLine(emptySketch(), { x: 8, y: -5 }, { x: 8, y: 25 }).sketch);
    const top = faces(r1, (f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    const split = splitFace(top, { tool: "sketch", sketchRef: sk.id });
    const r = build([box, sk, split]);
    expect(r.featureErrors).toEqual({});
    expect(faceCount(r)).toBe(7);
    expect(volume()).toBeCloseTo(4000, 6);
    const tops = faces(r, (f) => f.surface === "PLANE" && f.normal[2] > 0.99).map((p) => (p.ref as FaceRef).center[0]).sort((a, b) => a - b);
    expect(tops[0]).toBeCloseTo(4, 3);
    expect(tops[1]).toBeCloseTo(14, 3);
  });

  it("says plainly when the plane misses the faces", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const r = build([box, splitFace(faces(r1, frontFace), { plane: level(50) })]);
    expect(Object.values(r.featureErrors)[0]).toMatch(/doesn't cross/);
  });
});

describe("modify fillet", () => {
  const roundedEdge = (radius: number) => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const edge = r1.parts[0].edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[0] - 20) < 1e-6 && Math.abs(e.mid[1] - 20) < 1e-6)!;
    const fillet: Feature = { ...feature("fillet", { radius }), picks: [{ partId: box.id, ref: edge }] };
    const r = build([box, fillet]);
    return { box, fillet, r, round: faces(r, (f) => f.surface.startsWith("CYLIND")) };
  };

  it("changes a fillet's radius from 2 to 4", () => {
    const { box, fillet, round } = roundedEdge(2);
    expect(round).toHaveLength(1);
    const mod: Feature = { ...feature("modifyFillet", { radius: 4 }), picks: round };
    const r = build([box, fillet, mod]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(4000 - 10 * (16 - 4 * Math.PI), 4);
    expect(sound()).toBe(true);
  });

  it("takes a fillet off, putting the sharp box back", () => {
    const { box, fillet, round } = roundedEdge(2);
    const mod: Feature = { ...feature("modifyFillet", {}), picks: round, modifyFillet: { remove: true } };
    const r = build([box, fillet, mod]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(4000, 6);
    expect(faceCount(r)).toBe(6);
  });

  it("takes off a fillet round a hole's rim (inside corner too)", () => {
    const block = feature("box", { width: 30, depth: 30, height: 10 });
    const hole = feature("cylinder", { diameter: 10, height: 10, x: 15, y: 15 }, "remove");
    const r1 = build([block, hole]);
    const sharp = volume();
    const rim = r1.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "CIRCLE" && e.mid[2] > 9.99)!;
    const fillet: Feature = { ...feature("fillet", { radius: 1 }, "add"), picks: [{ partId: block.id, ref: rim }] };
    const r2 = build([block, hole, fillet]);
    const ring = faces(r2, (f) => f.surface.startsWith("TOR"));
    expect(ring.length).toBeGreaterThan(0);
    const r = build([block, hole, fillet, { ...feature("modifyFillet", {}), picks: ring, modifyFillet: { remove: true } }]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(sharp, 4);
  });

  it("follows a fillet round a rounded rectangle's edge (Propagate), or changes only the picked piece", () => {
    // A plate with rounded upright corners, then its whole top edge filleted at 1 (straight pieces and quarter rings).
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 30, 20));
    const plate = extrudeFeature(sk.id, 6);
    const r0 = build([sk, plate]);
    const upright = (e: TopoPick["ref"]) => e.kind === "edge" && Math.abs(e.a[2] - e.b[2]) > 5;
    const corners = r0.parts[0].edgeRefs.filter(upright).map((ref) => ({ partId: plate.id, ref }));
    expect(corners).toHaveLength(4);
    const round = { ...feature("fillet", { radius: 3 }), picks: corners };
    const r1 = build([sk, plate, round]);
    expect(r1.featureErrors).toEqual({});
    const sharpTop = volume();
    const topEdge = r1.parts[0].edgeRefs.filter((e) => e.kind === "edge" && Math.abs(e.mid[2] - 6) < 1e-6).map((ref) => ({ partId: plate.id, ref }));
    const fillet = { ...feature("fillet", { radius: 1 }), picks: [topEdge[0]] };
    const r3 = build([sk, plate, round, fillet]);
    expect(r3.featureErrors).toEqual({});
    expect(volume()).toBeLessThan(sharpTop);
    // One straight piece of the edge fillet (a cylinder of radius 1 lying flat, near the top).
    const piece = faces(r3, (f) => f.surface.startsWith("CYLIND") && f.center[2] > 5);
    expect(piece.length).toBeGreaterThan(0);
    const off = { ...feature("modifyFillet", {}), picks: [piece[0]], modifyFillet: { remove: true } };
    const r = build([sk, plate, round, fillet, off]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(sharpTop, 3);
    expect(r.featureNotes?.[off.id]).toMatch(/Also took off/);
    // Without Propagate only that piece goes: refused, or less put back than the whole run.
    const one = build([sk, plate, round, fillet, { ...off, modifyFillet: { remove: true, noPropagate: true } }]);
    if (!Object.keys(one.featureErrors).length) expect(volume()).toBeLessThan(sharpTop - 1e-3);
  });

  it("re-sizes a fillet on an imported STEP part", async () => {
    const { box, fillet } = roundedEdge(2);
    build([box, fillet]);
    const step = new TextDecoder().decode((await engine.exportStep([])).step);
    const imp = importFeature({ fileName: "rounded.step", format: "step", data: step, units: "mm" });
    const r1 = build([imp]);
    const round = faces(r1, (f) => f.surface.startsWith("CYLIND"));
    expect(round).toHaveLength(1);
    const r = build([imp, { ...feature("modifyFillet", { radius: 4 }), picks: round }]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(4000 - 10 * (16 - 4 * Math.PI), 3);
    const gone = build([imp, { ...feature("modifyFillet", {}), picks: round, modifyFillet: { remove: true } }]);
    expect(gone.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(4000, 4);
  });

  it("refuses a face that isn't a fillet, in plain words", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const r = build([box, { ...feature("modifyFillet", { radius: 3 }), picks: faces(r1, frontFace) }]);
    expect(Object.values(r.featureErrors)[0]).toMatch(/rounded faces made by a fillet/);
    // A whole cylinder isn't a fillet either.
    const rod = feature("cylinder", { diameter: 10, height: 10 });
    const r2 = build([rod]);
    const side = faces(r2, (f) => f.surface.startsWith("CYLIND"));
    const r3 = build([rod, { ...feature("modifyFillet", { radius: 3 }), picks: side }]);
    expect(Object.values(r3.featureErrors)[0]).toBeTruthy();
  });
});

describe("fillet every edge of a part", () => {
  it("rounds all twelve edges of a box from one pick", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const one = faces(r1, frontFace);
    const r = build([box, { ...feature("fillet", { radius: 1 }), picks: one, allEdges: true }]);
    expect(r.featureErrors).toEqual({});
    // 6 flat + 12 rounded edges + 8 corners.
    expect(faceCount(r)).toBe(26);
    expect(volume()).toBeLessThan(4000);
  });
});
