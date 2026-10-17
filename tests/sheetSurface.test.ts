/**
 * Sheet metal and surfaces against the real OpenCascade engine: exact sizes,
 * areas and volumes for the trickier cases (cuts across bends, flanges that
 * collide, extending curved edges, filling corners…).
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeMesh } from "../src/geometry/meshCheck";
import type { EdgeRef } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType, Operation } from "../src/model/types";
import { addArc, addCircle, addLine, addRectangle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let n = 0;
function feature(type: FeatureType, params: Record<string, string | number>, operation: Operation = "new"): Feature {
  n++;
  return {
    id: `f${n}`,
    name: `${type} ${n}`,
    type,
    operation,
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

function sketchFeature(plane: SketchPlane | null, data: SketchData): Feature {
  n++;
  return { id: `f${n}`, name: `Sketch ${n}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } };
}
function extrudeFeature(sketchRef: string, depth: number): Feature {
  n++;
  return { id: `f${n}`, name: `Extrude ${n}`, type: "extrude", operation: "new", suppressed: false, params: { depth: String(depth) }, sketchRef, extrude: { end: "blind", flip: false } };
}
const rectSketch = (x0: number, y0: number, w: number, h: number) => addRectangle(emptySketch(), { x: x0, y: y0 }, { x: x0 + w, y: y0 + h }).sketch;
const top: SketchPlane = { kind: "default", name: "Top" };
const front: SketchPlane = { kind: "default", name: "Front" };

/** A mesh's surface area. */
const area = (m: { vertices: Float32Array; triangles: Uint32Array }) => {
  let a = 0;
  const v = m.vertices;
  const t = m.triangles;
  for (let i = 0; i + 2 < t.length; i += 3) {
    const [p, q, r] = [t[i], t[i + 1], t[i + 2]].map((k) => [v[3 * k], v[3 * k + 1], v[3 * k + 2]]);
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  return a;
};
const vol = (i = 0) => engine.check("normal").parts[i].exactVolume!;

describe("sheet metal", () => {
  const sheet = (sketchRef: string, extra: Partial<Feature> = {}): Feature => ({
    id: "sm",
    name: "Sheet metal 1",
    type: "sheetMetal",
    operation: "new",
    suppressed: false,
    params: { thickness: "2", radius: "2", kFactor: "0.45", depth: "20" },
    sketchRef,
    ...extra,
  });
  /** Straight edges along the sheet's top face (z = 2). */
  const topEdges = (r: ReturnType<typeof build>) =>
    r.parts[0].edgeRefs.filter((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - 2) < 1e-6 && Math.abs(e.b[2] - 2) < 1e-6);
  const flange = (refs: EdgeRef[], params: Record<string, string> = {}, extra: Partial<Feature> = {}): Feature => ({
    id: "fl",
    name: "Flange 1",
    type: "flange",
    operation: "add",
    suppressed: false,
    params: { length: "20", angle: "90", inset: "0", ...params },
    picks: refs.map((ref) => ({ partId: "sm", ref })),
    ...extra,
  });

  it("shows a cut across a bend in the flat pattern and the part laid flat", () => {
    // An L, 50 along then 30 up, 20 deep (along −Y), 2 thick, bend radius 2.
    let L = addLine(emptySketch(), { x: 0, y: 0 }, { x: 50, y: 0 }).sketch;
    L = addLine(L, { x: 50, y: 0 }, { x: 50, y: 30 }).sketch;
    const sk = sketchFeature(front, L);
    // A 6 mm wide slot right through the bend, from the bottom wall (x from 45) to the upright (z up to 5).
    const slot = feature("box", { width: 10, depth: 6, height: 10, x: 45, y: -13, z: -5 }, "remove");
    const r = build([sk, sheet(sk.id), slot]);
    expect(r.featureErrors).toEqual({});
    const flat = r.parts[0].flat!;
    expect(flat.notShown).toEqual([]);
    // Flat: 46 (bottom) + bend allowance (π/2 × (2 + 0.45 × 2)) + 26 (upright) long; the slot runs from 45 on the
    // bottom wall, across the bend, to 1 mm up the upright, 6 wide (y 7 to 13).
    const allowance = (Math.PI / 2) * (2 + 0.45 * 2);
    const ys = flat.cuts!.flat().map((q) => q[1]);
    expect(Math.min(...ys)).toBeCloseTo(45, 4);
    expect(Math.max(...ys)).toBeCloseTo(46 + allowance + 1, 4);
    const xs = flat.cuts!.flat().map((q) => q[0]);
    expect(Math.min(...xs)).toBeCloseTo(7, 4);
    expect(Math.max(...xs)).toBeCloseTo(13, 4);
    // No line across the slot where the bend meets the walls.
    expect(flat.cuts!.some(([a, b]) => Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[1] - 46) < 1e-6)).toBe(false);
    // The outline to cut is taken from the part laid flat, slot and all: the outer rectangle and the slot.
    expect(flat.boundary).toHaveLength(8);
    // Laid flat: the plain sheet less the 6 × (1 + allowance + 1) slot, 2 thick.
    const laid = engine.unfold(r.parts[0].id)!;
    expect(analyzeMesh(laid.vertices, laid.triangles).volume).toBeCloseTo((46 + allowance + 26) * 20 * 2 - 6 * (2 + allowance) * 2, 1);
  });

  it("says when flanges would run into each other instead of merging them", () => {
    const sk = sketchFeature(top, rectSketch(0, 0, 100, 50));
    const edges = topEdges(build([sk, sheet(sk.id)]));
    expect(edges).toHaveLength(4);
    // Folded over at 150° on all four edges, they overlap at the corners.
    const folded = build([sk, sheet(sk.id), flange(edges, { angle: "150" })]);
    expect(folded.featureErrors.fl).toMatch(/run into each other/);
    expect(vol()).toBeCloseTo(100 * 50 * 2, 3);
    // At 90° they don't: four 20 mm flanges (a quarter bend, radii 2 and 4, and 16 mm straight) round the 300 mm edge.
    const box = build([sk, sheet(sk.id), flange(edges)]);
    expect(box.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(10000 + 300 * ((Math.PI / 4) * (16 - 4) + 16 * 2), 2);
    // One at 150° on its own is fine.
    expect(build([sk, sheet(sk.id), flange([edges[0]], { angle: "150" })]).featureErrors).toEqual({});
  });
});

describe("flange position", () => {
  const sheet = (sketchRef: string): Feature => ({ id: "sm", name: "Sheet metal 1", type: "sheetMetal", operation: "new", suppressed: false, params: { thickness: "2", radius: "2", kFactor: "0.45" }, sketchRef });
  const edgesAt = (r: ReturnType<typeof build>) => r.parts[0].edgeRefs.filter((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - 2) < 1e-6 && Math.abs(e.b[2] - 2) < 1e-6);
  const flange = (id: string, refs: EdgeRef[], extra: Partial<Feature> = {}): Feature => ({
    id,
    name: id,
    type: "flange",
    operation: "add",
    suppressed: false,
    params: { length: "20", angle: "90", inset: "0" },
    picks: refs.map((ref) => ({ partId: "sm", ref })),
    ...extra,
  });

  it("keeps a box's outside size when the flanges sit flush outside", () => {
    const sk = sketchFeature(top, rectSketch(0, 0, 100, 50));
    const edges = edgesAt(build([sk, sheet(sk.id)]));
    const r = build([sk, sheet(sk.id), flange("fl", edges, { flangePosition: "outside" })]);
    expect(r.featureErrors).toEqual({});
    const m = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(m.bounds!.min.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0, 0, 0]);
    expect(m.bounds!.max.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([100, 50, 20]);
    // A 92 × 42 base, and round its 268 mm edge a quarter bend (radii 2 and 4) and a 16 mm straight wall.
    expect(vol()).toBeCloseTo(92 * 42 * 2 + 268 * ((Math.PI / 4) * 12 + 16 * 2), 2);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // Inside flush: the space inside is 100 × 50.
    const inner = build([sk, sheet(sk.id), flange("fl", edges, { flangePosition: "inside" })]);
    expect(inner.featureErrors).toEqual({});
    const mi = analyzeMesh(inner.parts[0].vertices, inner.parts[0].triangles);
    expect(mi.bounds!.min[0]).toBeCloseTo(-2, 4);
    expect(mi.bounds!.max[0]).toBeCloseTo(102, 4);
    // Flush next to a flange made earlier (bent off its whole edge) can't be done: say how instead.
    const first = flange("fa", [edges.find((e) => Math.abs(e.a[0] - 100) < 1e-6 && Math.abs(e.b[0] - 100) < 1e-6)!]);
    const later = flange("fb", [edges.find((e) => Math.abs(e.a[1] - 50) < 1e-6 && Math.abs(e.b[1] - 50) < 1e-6)!], { flangePosition: "outside" });
    expect(build([sk, sheet(sk.id), first, later]).featureErrors.fb).toMatch(/Pick both edges in one Flange/);
  });
});

describe("surfaces", () => {
  it("extends a curved edge along the surface everywhere (a cone carries on as a cone)", () => {
    // A cone: a line from (10, 10) to (20, 0) on Front, spun round the vertical axis.
    const ln = sketchFeature(front, addLine(emptySketch(), { x: 10, y: 10 }, { x: 20, y: 0 }).sketch);
    const cone: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: ln.id, revolve: { axis: "vertical", flip: false }, surface: true };
    const p = build([ln, cone]).parts[0];
    const rim = p.edgeRefs.filter((e) => e.kind === "edge" && e.curve === "CIRCLE" && Math.abs(e.mid[2]) < 1e-6);
    expect(rim).toHaveLength(1);
    const ext: Feature = { ...feature("extendSurface", { distance: 5 }), picks: rim.map((ref) => ({ partId: cone.id, ref })) };
    const r = build([ln, cone, ext]);
    expect(r.featureErrors).toEqual({});
    // 5 mm further down the slope: the new rim is a circle of radius 20 + 5/√2 at z = −5/√2, all the way round.
    const v = r.parts[0].vertices;
    const low: number[] = [];
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i + 2] + 5 / Math.SQRT2) < 1e-3) low.push(Math.hypot(v[i], v[i + 1]));
    expect(low.length).toBeGreaterThan(20);
    for (const radius of low) expect(radius).toBeCloseTo(20 + 5 / Math.SQRT2, 2);
    expect(Math.min(...Array.from(v).filter((_, i) => i % 3 === 2))).toBeCloseTo(-5 / Math.SQRT2, 3);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).pieces).toBe(1);
  });

  it("fills the corner between two extended edges that meet", () => {
    // A flat wall 20 × 5; all four edges out by 3: 26 × 11, corners and all, in one piece.
    const sk = sketchFeature(top, addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch);
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const p = build([sk, wall]).parts[0];
    const all: Feature = { ...feature("extendSurface", { distance: 3 }), picks: p.edgeRefs.map((ref) => ({ partId: wall.id, ref })) };
    const r = build([sk, wall, all]);
    expect(r.featureErrors).toEqual({});
    expect(area(r.parts[0])).toBeCloseTo(26 * 11, 2);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).pieces).toBe(1);
    // Just two neighbouring edges (the top and the right): 23 × 8.
    const two = p.edgeRefs.filter((e) => e.kind === "edge" && (Math.abs(e.mid[2] - 5) < 1e-6 || Math.abs(e.mid[0] - 20) < 1e-6));
    expect(two).toHaveLength(2);
    const r2 = build([sk, wall, { ...all, picks: two.map((ref) => ({ partId: wall.id, ref })) }]);
    expect(r2.featureErrors).toEqual({});
    expect(area(r2.parts[0])).toBeCloseTo(23 * 8, 2);
  });

  it("thickens half each way (both sides), for surfaces and flat faces", () => {
    // A flat wall at y = 0, 20 × 5: 1 mm thick from y = −0.5 to 0.5.
    const sk = sketchFeature(top, addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch);
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const w = build([sk, wall]).parts[0];
    const th: Feature = { ...feature("thicken", { thickness: 1 }), picks: [{ partId: wall.id, ref: w.faceRefs[0] }], bothSides: true };
    const r = build([sk, wall, th]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(100, 3);
    const m = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(m.bounds!.min[1]).toBeCloseTo(-0.5, 4);
    expect(m.bounds!.max[1]).toBeCloseTo(0.5, 4);
    // Flip makes no difference then.
    build([sk, wall, { ...th, flipSide: true }]);
    expect(vol()).toBeCloseTo(100, 3);
    // A round skin, radius 10 and 20 tall, 2 thick both sides: a tube from radius 9 to 11.
    const c = sketchFeature(top, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const skin: Feature = { ...extrudeFeature(c.id, 20), surface: true };
    const cp = { partId: skin.id, ref: build([c, skin]).parts[0].faceRefs[0] };
    expect(build([c, skin, { ...feature("thicken", { thickness: 2 }), picks: [cp], bothSides: true }]).featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(Math.PI * (121 - 81) * 20, 1);
    // A closed ball skin, radius 10, 2 thick both sides: from radius 9 to 11.
    const arc = sketchFeature(front, addArc(emptySketch(), { x: 0, y: -10 }, { x: 0, y: 10 }, { x: 10, y: 0 }).sketch);
    const ball: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: arc.id, revolve: { axis: "vertical", flip: false }, surface: true };
    const bp = { partId: ball.id, ref: build([arc, ball]).parts[0].faceRefs[0] };
    expect(build([arc, ball, { ...feature("thicken", { thickness: 2 }), picks: [bp], bothSides: true }]).featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((4 / 3) * Math.PI * (1331 - 729), 0);
    // The top face of a block, 4 thick both sides, added on: only the 2 above it is new.
    const block = feature("box", { width: 10, depth: 10, height: 10 });
    const topFace = build([block]).parts[0].faceRefs.find((f) => Math.abs(f.center[2] - 10) < 1e-6)!;
    const onto = build([block, { ...feature("thicken", { thickness: 4 }, "add"), picks: [{ partId: block.id, ref: topFace }], bothSides: true }]);
    expect(onto.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(1200, 3);
  });
});
