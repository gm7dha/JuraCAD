/**
 * Frames along part edges and curve features, and mitres where three meet, with the real OpenCascade engine: a frame
 * round a box's top edges (volume, lengths, ids, standing up), a sketch line meeting a part edge, a flat bar rail
 * along a helix (volume = area × length, facing the axis all the way), and a cube corner of three mitred members
 * (exact volume, no overlaps).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { measureVolume, type Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import type { CurveDef, Feature } from "../src/model/types";
import type { FrameDef } from "../src/model/frameTypes";
import type { EdgeRef, TopoPick } from "../src/geometry/topoRef";
import { helixLength } from "../src/model/curves";
import { builtEdgeKey, cornerKey, edgeKeyFor, planFrame, togglePathEdge } from "../src/model/frame";
import { builtInProfile, placedProfile, type ProfileShape } from "../src/model/frameProfiles";
import { edgesOf, facesOf } from "../src/kernel/topology";
import type { FrameEdge } from "../src/model/frameTypes";
import { loadOpenCascade, feature, sketchFeature, meshOf, relativeError } from "./support/engineHelpers";
import { polySketch } from "./support/frameSketch";

type Vec3 = [number, number, number];
beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const frame = (def: Partial<FrameDef>, params: Record<string, string | number> = {}): Feature => ({
  ...feature("frame", params),
  frame: { paths: [], profile: { kind: "timber", size: "44x44" }, ...def },
});
const curve = (def: CurveDef, params: Record<string, number> = {}): Feature => ({ ...feature("curve", params), curve: def });
const near = (a: Vec3, b: Vec3, tol = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;
const edgeOf = (box: Feature, refs: { edgeRefs: EdgeRef[] }, a: Vec3, b: Vec3): FrameEdge => {
  const ref = refs.edgeRefs.find((e) => (near(e.a, a) && near(e.b, b)) || (near(e.a, b) && near(e.b, a)));
  if (!ref) throw new Error(`no edge ${a} – ${b}`);
  const pick: TopoPick = { partId: box.id, ref };
  return { ...pick, key: edgeKeyFor(pick) };
};
const frameParts = () => (engine as unknown as { parts: { id: string; shape: Shape3D; frame?: unknown }[] }).parts.filter((p) => p.frame);
function overlap(a: Shape3D, b: Shape3D): number {
  const i = a.clone().intersect(b.clone()) as Shape3D;
  try {
    return measureVolume(i);
  } catch {
    return 0;
  } finally {
    i.delete();
  }
}
function worstOverlap(): number {
  const s = frameParts().map((p) => p.shape);
  let w = 0;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) w = Math.max(w, overlap(s[i], s[j]));
  return w;
}
const volumes = () => frameParts().map((p) => measureVolume(p.shape));

describe("frames along part edges and curves (real OCCT)", () => {
  it("follows a box's top edges: 4 mitred members, area × length, standing up from the top, ids by the edges", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 200, depth: 100, height: 50 });
    const part = engine.rebuild([box]).parts[0];
    const edges = [edgeOf(box, part, [0, 0, 50], [200, 0, 50]), edgeOf(box, part, [200, 0, 50], [200, 100, 50]), edgeOf(box, part, [200, 100, 50], [0, 100, 50]), edgeOf(box, part, [0, 100, 50], [0, 0, 50])];
    const f = frame({ edges });
    const r = engine.rebuild([box, f]);
    expect(r.featureErrors).toEqual({});
    const members = r.parts.filter((p) => p.frame);
    expect(members).toHaveLength(4);
    expect(members.map((p) => p.id).sort()).toEqual(edges.map((e) => `${f.id}~${box.id}_${e.key}`).sort());
    const total = volumes().reduce((a, b) => a + b, 0);
    expect(relativeError(total, 44 * 44 * 600)).toBeLessThan(1e-6);
    expect(members.map((p) => p.frame!.length).sort((a, b) => a - b)).toEqual([144, 144, 244, 244]);
    expect(members.every((p) => p.frame!.ends[0] === 45 && p.frame!.ends[1] === 45)).toBe(true);
    expect(worstOverlap()).toBeLessThan(1e-3);
    // Up is +Z: the frame reaches 22 above the top.
    const b = meshOf({ parts: members }).bounds!;
    expect(b.max[2]).toBeCloseTo(72, 3);
    // The dialog gets the pieces for its corners.
    expect(r.framePaths?.[f.id]).toHaveLength(4);
    // Taking the second edge out leaves the others' members (and their colours, mates, drawings) named as they were.
    const three = { ...f, frame: { ...f.frame!, edges: [edges[0], edges[2], edges[3]] } };
    const r3 = engine.rebuild([box, three]);
    expect(r3.featureErrors).toEqual({});
    const left = r3.parts.filter((p) => p.frame).map((p) => p.id);
    expect(left.sort()).toEqual([edges[0], edges[2], edges[3]].map((e) => `${f.id}~${box.id}_${e.key}`).sort());
  });

  it("an edge clicked after its part changed (the box made wider) is recognised and left out, not added again", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 200, depth: 100, height: 50 });
    const part = engine.rebuild([box]).parts[0];
    const edges = [edgeOf(box, part, [0, 0, 50], [200, 0, 50]), edgeOf(box, part, [200, 0, 50], [200, 100, 50]), edgeOf(box, part, [200, 100, 50], [0, 100, 50]), edgeOf(box, part, [0, 100, 50], [0, 0, 50])];
    const f = frame({ edges });
    const wider = { ...box, params: { ...box.params, width: "260" } };
    const r = engine.rebuild([wider, f]);
    expect(r.featureErrors).toEqual({});
    const now = r.parts.find((p) => p.id === box.id)!;
    // The right-hand edge, where it is now (x = 260): as the 3D view would pick it.
    const click = edgeOf(box, now, [260, 0, 50], [260, 100, 50]);
    const key = builtEdgeKey(f.frame!.edges, r.framePaths![f.id], click);
    expect(key).toBe(edges[1].key);
    const same = (a: TopoPick, b: TopoPick) => a.partId === b.partId && JSON.stringify(a.ref) === JSON.stringify(b.ref);
    const next = togglePathEdge(f.frame!, click, same, key);
    expect(next.edges!.map((e) => e.key)).toEqual([edges[0], edges[2], edges[3]].map((e) => e.key));
    const r2 = engine.rebuild([wider, { ...f, frame: next }]);
    expect(r2.parts.filter((p) => p.frame)).toHaveLength(3);
  });

  it("mixes a sketch line with a part edge: mitred where they meet, no overlap", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 200, depth: 100, height: 50 });
    const part = engine.rebuild([box]).parts[0];
    // The box's upright edge at the origin, and a line on Top going out along −x from the same corner.
    const up = edgeOf(box, part, [0, 0, 0], [0, 0, 50]);
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [-150, 0]], false));
    const f = frame({ paths: [{ sketch: sk.id }], edges: [up] });
    const r = engine.rebuild([box, sk, f]);
    expect(r.featureErrors).toEqual({});
    const members = r.parts.filter((p) => p.frame);
    expect(members).toHaveLength(2);
    expect(members.map((p) => [...p.frame!.ends].sort())).toEqual([[0, 45], [0, 45]]);
    expect(relativeError(volumes().reduce((a, b) => a + b, 0), 44 * 44 * 200)).toBeLessThan(1e-6);
    expect(worstOverlap()).toBeLessThan(1e-3);
  });

  it("a flat bar rail along a helix: area × length, facing the axis all the way round", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { diameter: 200, height: 300, turns: 2 });
    const f = frame({ curves: [h.id], profile: { kind: "flat", size: "20x3" } });
    const r = engine.rebuild([h, f]);
    expect(r.featureErrors).toEqual({});
    const members = r.parts.filter((p) => p.frame);
    expect(members).toHaveLength(1);
    expect(members[0].frame!.curved).toBe(true);
    const L = helixLength(100, 2, 150);
    expect(relativeError(members[0].frame!.length, L)).toBeLessThan(1e-4);
    expect(relativeError(volumes()[0], 20 * 3 * L)).toBeLessThan(5e-3);
    // The 20 mm side points at the axis (110 out at most), not along it (that would be 101.5).
    const b = meshOf({ parts: members }).bounds!;
    expect(b.max[0]).toBeGreaterThan(109);
    expect(b.max[0]).toBeLessThan(110.5);
    expect(engine.check("normal").parts.every((p) => p.geometryValid)).toBe(true);
  });

  it("a tube round a cylinder's top edge (a whole circle), and a bar along a fit spline (area × length)", () => {
    engine = new GeometryEngine();
    const cyl = feature("cylinder", { diameter: 100, height: 20, x: 0, y: 0, z: 0 });
    const part = engine.rebuild([cyl]).parts[0];
    const rim = part.edgeRefs.find((e) => e.curve === "CIRCLE" && Math.abs(e.mid[2] - 20) < 1e-6)!;
    const ring = frame({ edges: [{ partId: cyl.id, ref: rim, key: "e1" }], profile: { kind: "tube", size: "20x2" } });
    const r = engine.rebuild([cyl, ring]);
    expect(r.featureErrors).toEqual({});
    const A = Math.PI * (10 * 10 - 8 * 8);
    expect(relativeError(volumes()[0], A * Math.PI * 100)).toBeLessThan(1e-4);
    // A smooth 3D spline: the bar follows it, turning as little as it can.
    const fs = curve({ kind: "fitSpline", points: [{ p: [0, 0, 0] }, { p: [100, 40, 30] }, { p: [200, 0, 60] }, { p: [300, -30, 60] }] });
    const bar = frame({ curves: [fs.id], profile: { kind: "flat", size: "20x3" } });
    const rs = engine.rebuild([fs, bar]);
    expect(rs.featureErrors).toEqual({});
    const m = rs.parts.find((p) => p.frame)!;
    expect(m.frame!.curved).toBe(true);
    expect(relativeError(volumes()[0], 60 * m.frame!.length)).toBeLessThan(5e-3);
    // The bar arrives at the far end turned exactly as planned (its 20 mm side along the planned across).
    const shape = placedProfile(builtInProfile("flat", "20x3") as ProfileShape, undefined, false, 0);
    const plan = planFrame(rs.framePaths![bar.id], {}, shape, 0);
    if (typeof plan === "string") throw new Error(plan);
    const pm = plan.members[0];
    const endAt = pm.member.segs[pm.member.segs.length - 1].b;
    const endX = pm.frames[pm.frames.length - 1].x;
    const solid = frameParts()[0].shape;
    let best: { d: number; dir: Vec3 } | null = null;
    for (const face of facesOf(solid)) {
      const es = edgesOf(face);
      const ends = es.map((e) => [e.startPoint, e.endPoint].map((v) => {
        const r: Vec3 = [v.x, v.y, v.z];
        v.delete();
        return r;
      }));
      const pts = ends.flat();
      const c: Vec3 = [0, 1, 2].map((k) => pts.reduce((t, p) => t + p[k], 0) / pts.length) as Vec3;
      const d = Math.hypot(c[0] - endAt[0], c[1] - endAt[1], c[2] - endAt[2]);
      const longest = ends.map(([a, b]) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as Vec3).sort((p, q) => Math.hypot(...q) - Math.hypot(...p))[0];
      if (face.geomType === "PLANE" && (!best || d < best.d)) best = { d, dir: longest };
      es.forEach((e) => e.delete());
      face.delete();
    }
    expect(best!.d).toBeLessThan(1);
    const l = Math.hypot(...best!.dir);
    const cos = Math.abs(best!.dir[0] * endX[0] + best!.dir[1] * endX[1] + best!.dir[2] * endX[2]) / l;
    expect((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toBeLessThan(0.1);
  });

  it("a bar round a closed fit spline: builds, sound, area × length", () => {
    engine = new GeometryEngine();
    const loop = curve({ kind: "fitSpline", points: [{ p: [0, 0, 0] }, { p: [60, 10, 15] }, { p: [70, 70, 0] }, { p: [-10, 60, -10] }], closed: true });
    const bar = frame({ curves: [loop.id], profile: { kind: "flat", size: "20x3" } });
    const r = engine.rebuild([loop, bar]);
    expect(r.featureErrors).toEqual({});
    const m = r.parts.find((p) => p.frame)!;
    expect(m.frame!.curved).toBe(true);
    expect(relativeError(volumes()[0], 60 * m.frame!.length)).toBeLessThan(5e-3);
    expect(engine.check("normal").parts.every((p) => p.geometryValid)).toBe(true);
    // A flat closed curve too (it was the guide's first and last point being the same that broke it).
    const flat = curve({ kind: "fitSpline", points: [{ p: [0, 0, 0] }, { p: [40, 0, 0] }, { p: [40, 30, 0] }, { p: [0, 30, 0] }], closed: true });
    const fb = frame({ curves: [flat.id], profile: { kind: "flat", size: "20x3" } });
    const rf = engine.rebuild([flat, fb]);
    expect(rf.featureErrors).toEqual({});
    const mf = rf.parts.find((p) => p.frame)!;
    expect(relativeError(volumes()[0], 60 * mf.frame!.length)).toBeLessThan(5e-3);
    expect(engine.check("normal").parts.every((p) => p.geometryValid)).toBe(true);
  });

  it("refuses a curve that comes after the frame, and says when an edge's part has gone", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { diameter: 200, height: 300, turns: 2 });
    const f = frame({ curves: [h.id] });
    expect(engine.rebuild([f, h]).featureErrors[f.id]).toMatch(/comes after/);
    const lost = frame({ edges: [{ partId: "gone", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [1, 0, 0], mid: [0.5, 0, 0] }, key: "e1" }] });
    expect(engine.rebuild([lost]).featureErrors[lost.id]).toMatch(/no longer exists/);
  });
});

describe("mitres where three meet (real OCCT)", () => {
  it("a cube corner of three mitred members: exact volume, no overlaps", () => {
    engine = new GeometryEngine();
    // x and y on Top, z on Front (whose second axis is z).
    const top = sketchFeature({ kind: "default", name: "Top" }, { points: [{ id: "o", x: 0, y: 0 }, { id: "x", x: 200, y: 0 }, { id: "y", x: 0, y: 200 }], curves: [{ id: "lx", type: "line", p1: "o", p2: "x", construction: false }, { id: "ly", type: "line", p1: "o", p2: "y", construction: false }], constraints: [] });
    const front = sketchFeature({ kind: "default", name: "Front" }, { points: [{ id: "o", x: 0, y: 0 }, { id: "z", x: 0, y: 200 }], curves: [{ id: "lz", type: "line", p1: "o", p2: "z", construction: false }], constraints: [] });
    const key = cornerKey([`${top.id}/lx`, `${top.id}/ly`, `${front.id}/lz`]);
    const f = frame({ paths: [{ sketch: top.id }, { sketch: front.id }], corners: [{ key, type: "mitre" }] });
    const r = engine.rebuild([top, front, f]);
    expect(r.featureErrors).toEqual({});
    const members = r.parts.filter((p) => p.frame);
    expect(members).toHaveLength(3);
    expect(members.every((p) => p.frame!.ends.includes(45))).toBe(true);
    // Each keeps where it reaches furthest along its own axis: V = 3 s² (L − s/6) for a centred s × s square.
    const s = 44;
    expect(relativeError(volumes().reduce((a, b) => a + b, 0), 3 * s * s * (200 - s / 6))).toBeLessThan(1e-6);
    expect(worstOverlap()).toBeLessThan(1e-3);
    // All three the same length: from the far corner of the square (22 behind the corner) to the end.
    expect(members.map((p) => p.frame!.length)).toEqual([222, 222, 222]);
    // Left as the usual butt joint, one runs through and the others stop at it.
    const butt = frame({ paths: [{ sketch: top.id }, { sketch: front.id }] });
    const rb = engine.rebuild([top, front, butt]);
    expect(new Set(rb.parts.filter((p) => p.frame).map((p) => p.frame!.length)).size).toBeGreaterThan(1);
    expect(worstOverlap()).toBeLessThan(1e-3);
  });
});
