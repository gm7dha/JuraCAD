/**
 * Engine tests: curve features (Helix, Projected, Bridging, Composite, Fit spline, Intersection) and sweeps /
 * curve patterns along them or along picked part edges. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { EdgeRef, TopoPick } from "../src/geometry/topoRef";
import type { CurveDef, Feature } from "../src/model/types";
import { helixLength } from "../src/model/curves";
import { addCircle, addLine } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, meshOf, relativeError } from "./support/engineHelpers";

type Vec3 = [number, number, number];
beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const curve = (def: CurveDef, params: Record<string, number> = {}, extra: Partial<Feature> = {}): Feature => ({ ...feature("curve", params), curve: def, ...extra });
const pointsOf = (line: number[]): Vec3[] => {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < line.length; i += 3) out.push([line[i], line[i + 1], line[i + 2]]);
  return out;
};
const lengthOf = (lines: number[][]) =>
  lines.reduce((t, l) => {
    const p = pointsOf(l);
    let s = 0;
    for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]);
    return t + s;
  }, 0);
/** Shortest distance from a point to a polyline (segment by segment). */
const gapTo = (line: Vec3[], q: Vec3) => {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const d: Vec3 = [line[i + 1][0] - a[0], line[i + 1][1] - a[1], line[i + 1][2] - a[2]];
    const l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / l2)) : 0;
    best = Math.min(best, Math.hypot(a[0] + d[0] * t - q[0], a[1] + d[1] * t - q[1], a[2] + d[2] * t - q[2]));
  }
  return best;
};
const allPoints = (lines: number[][]) => lines.flatMap(pointsOf);
const near = (a: Vec3, b: Vec3, tol = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

describe("Helix", () => {
  it("winds round the Z axis with the right length, pitch and ends", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { diameter: 20, height: 30, turns: 5 });
    const r = engine.rebuild([h]);
    expect(r.featureErrors).toEqual({});
    const lines = r.curves![h.id];
    expect(relativeError(lengthOf(lines), helixLength(10, 5, 6))).toBeLessThan(1e-3);
    const pts = allPoints(lines);
    expect(near(pts[0], [10, 0, 0])).toBe(true);
    expect(near(pts[pts.length - 1], [10, 0, 30])).toBe(true);
    // Every point 10 from the axis; a quarter turn up is 1.5 higher (pitch 6) and anticlockwise (+y).
    for (const p of pts) expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(1e-3);
    const quarter = pts.reduce((b, p) => (Math.abs(p[2] - 1.5) < Math.abs(b[2] - 1.5) ? p : b));
    expect(quarter[1]).toBeGreaterThan(9.9);
    expect(r.parts).toHaveLength(0);
  });

  it("turns clockwise when asked, and by pitch, from a start point (radius from it)", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" }, start: { p: [0, 5, 0] }, helixBy: "heightPitch", clockwise: true }, { height: 8, pitch: 4 });
    const r = engine.rebuild([h]);
    expect(r.featureErrors).toEqual({});
    const pts = allPoints(r.curves![h.id]);
    expect(near(pts[0], [0, 5, 0])).toBe(true);
    expect(near(pts[pts.length - 1], [0, 5, 8])).toBe(true);
    // Clockwise from +y seen from above: towards +x first.
    const q = pts.reduce((b, p) => (Math.abs(p[2] - 1) < Math.abs(b[2] - 1) ? p : b));
    expect(q[0]).toBeGreaterThan(4.9);
    expect(relativeError(lengthOf(r.curves![h.id]), helixLength(5, 2, 4))).toBeLessThan(1e-3);
  });

  it("tapers (a cone): the radius grows by height × tan(taper)", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 20, height: 20, turns: 4, taper: 10 });
    const r = engine.rebuild([h]);
    expect(r.featureErrors).toEqual({});
    const pts = allPoints(r.curves![h.id]);
    const top = pts[pts.length - 1];
    expect(Math.abs(top[2] - 20)).toBeLessThan(1e-3);
    expect(Math.abs(Math.hypot(top[0], top[1]) - (10 + 20 * Math.tan((10 * Math.PI) / 180)))).toBeLessThan(1e-3);
  });

  it("winds round a cylinder face, its whole height", () => {
    engine = new GeometryEngine();
    const cyl = feature("cylinder", { diameter: 16, height: 25 });
    const face = engine.rebuild([cyl]).parts[0].faceRefs.find((f) => f.surface.startsWith("CYLIND"))!;
    const h = curve({ kind: "helix", around: "face", on: { partId: cyl.id, ref: face } }, { turns: 5 });
    const r = engine.rebuild([cyl, h]);
    expect(r.featureErrors).toEqual({});
    const pts = allPoints(r.curves![h.id]);
    const zs = pts.map((p) => p[2]);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(Math.max(...zs)).toBeCloseTo(25, 3);
    for (const p of pts) expect(Math.abs(Math.hypot(p[0], p[1]) - 8)).toBeLessThan(1e-3);
    expect(relativeError(lengthOf(r.curves![h.id]), helixLength(8, 5, 5))).toBeLessThan(1e-3);
  });

  it("a circle swept along it makes a spring of the right volume", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 20, height: 30, turns: 5 });
    // A circle in the plane through the axis where the helix starts (Front: x across, z up).
    const profile = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 10, y: 0 }, 1).sketch);
    const sweep: Feature = { ...feature("sweep", {}), sketchRef: profile.id, pathRef: h.id, apart: true };
    const r = engine.rebuild([h, profile, sweep]);
    expect(r.featureErrors).toEqual({});
    // Held in the plane through the axis all the way round: area × 2πR × turns.
    const v = engine.check("fine").parts[0].exactVolume!;
    expect(relativeError(v, Math.PI * 1 * 2 * Math.PI * 10 * 5)).toBeLessThan(0.005);
  });
});

describe("Intersection curve", () => {
  it("of a cylinder and a slanted plane is an ellipse of the right size", () => {
    engine = new GeometryEngine();
    const cyl = feature("cylinder", { diameter: 20, height: 40 });
    const face = engine.rebuild([cyl]).parts[0].faceRefs.find((f) => f.surface.startsWith("CYLIND"))!;
    const c = Math.SQRT1_2;
    const ic = curve({ kind: "intersection", plane: { kind: "face", origin: [0, 0, 20], u: [1, 0, 0], v: [0, c, c], label: "slanted" } }, {}, { picks: [{ partId: cyl.id, ref: face }] });
    const r = engine.rebuild([cyl, ic]);
    expect(r.featureErrors).toEqual({});
    const pts = allPoints(r.curves![ic.id]);
    // On the cylinder and on the plane (z − 20 = y).
    for (const p of pts) {
      expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(2e-3);
      expect(Math.abs(p[2] - 20 - p[1])).toBeLessThan(2e-3);
    }
    // Semi-axes 10 and 10√2: Ramanujan's perimeter.
    const a = 10 * Math.SQRT2;
    const b = 10;
    const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    expect(relativeError(lengthOf(r.curves![ic.id]), perimeter)).toBeLessThan(2e-3);
  });

  it("says so when nothing meets", () => {
    engine = new GeometryEngine();
    const cyl = feature("cylinder", { diameter: 20, height: 40 });
    const face = engine.rebuild([cyl]).parts[0].faceRefs.find((f) => f.surface.startsWith("CYLIND"))!;
    const ic = curve({ kind: "intersection", plane: { kind: "face", origin: [0, 0, 100], u: [1, 0, 0], v: [0, 1, 0], label: "high" } }, {}, { picks: [{ partId: cyl.id, ref: face }] });
    const r = engine.rebuild([cyl, ic]);
    expect(r.featureErrors[ic.id]).toMatch(/nothing meets/);
  });
});

describe("Projected curve", () => {
  it("a sketch's circle pressed onto a ball lies on the ball", () => {
    engine = new GeometryEngine();
    const ball = feature("sphere", { diameter: 40 });
    const face = engine.rebuild([ball]).parts[0].faceRefs[0];
    const sk = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const pc = curve({ kind: "projected", project: "faces" }, {}, { sketchRef: sk.id, picks: [{ partId: ball.id, ref: face }] });
    const r = engine.rebuild([ball, sk, pc]);
    expect(r.featureErrors).toEqual({});
    const pts = allPoints(r.curves![pc.id]);
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) {
      expect(Math.abs(Math.hypot(...p) - 20)).toBeLessThan(2e-3);
      expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(2e-3);
    }
  });

  it("two sketches' curves meet where both are pushed out", () => {
    engine = new GeometryEngine();
    const top = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    // A line on Front at z = 5, right across.
    const front = sketchFeature({ kind: "default", name: "Front" }, addLine(emptySketch(), { x: -20, y: 5 }, { x: 20, y: 5 }).sketch);
    const pc = curve({ kind: "projected", project: "sketches", sketch2: front.id }, {}, { sketchRef: top.id });
    const r = engine.rebuild([top, front, pc]);
    expect(r.featureErrors).toEqual({});
    // The circle's cylinder cut by the line's sheet (z = 5): a circle at height 5.
    for (const p of allPoints(r.curves![pc.id])) {
      expect(Math.abs(p[2] - 5)).toBeLessThan(2e-3);
      expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(2e-3);
    }
  });
});

describe("Fit spline, bridging and composite curves; sweeps along part edges", () => {
  it("a fit spline goes through every point", () => {
    engine = new GeometryEngine();
    const pts: Vec3[] = [
      [0, 0, 0],
      [10, 5, 2],
      [20, 0, 6],
      [30, -5, 3],
    ];
    const fs = curve({ kind: "fitSpline", points: pts.map((p) => ({ p })) });
    const r = engine.rebuild([fs]);
    expect(r.featureErrors).toEqual({});
    const line = allPoints(r.curves![fs.id]);
    for (const p of pts) expect(gapTo(line, p)).toBeLessThan(0.01);
    // Closed: it comes back to the first point.
    const closed = curve({ kind: "fitSpline", points: pts.map((p) => ({ p })), closed: true });
    const rc = engine.rebuild([closed]);
    const lc = allPoints(rc.curves![closed.id]);
    expect(near(lc[0], lc[lc.length - 1], 1e-6)).toBe(true);
  });

  it("refuses two points at the same place", () => {
    engine = new GeometryEngine();
    const fs = curve({ kind: "fitSpline", points: [{ p: [0, 0, 0] }, { p: [0, 0, 0] }] });
    expect(engine.rebuild([fs]).featureErrors[fs.id]).toMatch(/same place/);
  });

  const boxEdge = (box: Feature, refs: { edgeRefs: EdgeRef[] }, a: Vec3, b: Vec3): TopoPick => {
    const ref = refs.edgeRefs.find((e) => (near(e.a, a) && near(e.b, b)) || (near(e.a, b) && near(e.b, a)))!;
    return { partId: box.id, ref };
  };

  it("a bridging curve joins two box edges' ends, carrying on in their directions", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 20, depth: 20, height: 5 });
    const part = engine.rebuild([box]).parts[0];
    // From the end of the top front edge (20, 0, 5) to the start of a far point's edge.
    const e1 = boxEdge(box, part, [0, 0, 5], [20, 0, 5]);
    const e2 = boxEdge(box, part, [0, 20, 5], [20, 20, 5]);
    const end1 = near(e1.ref.kind === "edge" ? e1.ref.a : [0, 0, 0], [20, 0, 5]) ? "a" : "b";
    const end2 = near(e2.ref.kind === "edge" ? e2.ref.a : [0, 0, 0], [20, 20, 5]) ? "a" : "b";
    const br = curve({ kind: "bridge", from: { p: [20, 0, 5], pick: e1, end: end1 }, to: { p: [20, 20, 5], pick: e2, end: end2 } }, { bulge: 1 });
    const r = engine.rebuild([box, br]);
    expect(r.featureErrors).toEqual({});
    const pts = allPoints(r.curves![br.id]);
    expect(near(pts[0], [20, 0, 5])).toBe(true);
    expect(near(pts[pts.length - 1], [20, 20, 5])).toBe(true);
    // Sets off along +x (carrying on from the first edge) and comes back along −x into the second.
    expect(pts[1][0] - pts[0][0]).toBeGreaterThan(0);
    expect(Math.abs(pts[1][1] - pts[0][1])).toBeLessThan(Math.abs(pts[1][0] - pts[0][0]) * 0.3);
    const n = pts.length - 1;
    expect(pts[n][0] - pts[n - 1][0]).toBeLessThan(0);
  });

  it("a circle swept along a picked part edge, and along a composite of two edges", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 20, depth: 20, height: 5 });
    const part = engine.rebuild([box]).parts[0];
    const e = boxEdge(box, part, [0, 0, 5], [20, 0, 5]);
    const profile = sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 5 }, 1).sketch);
    const sweep: Feature = { ...feature("sweep", {}), sketchRef: profile.id, pathEdges: [e], operation: "new" };
    const r = engine.rebuild([box, profile, sweep]);
    expect(r.featureErrors).toEqual({});
    const rod = r.parts.find((p) => p.id === sweep.id)!;
    const v = meshOf({ parts: [rod] }).volume;
    expect(relativeError(v, Math.PI * 20)).toBeLessThan(0.01);

    // Two edges meeting at a corner joined into one curve.
    const e2 = boxEdge(box, part, [20, 0, 5], [20, 20, 5]);
    const comp = curve({ kind: "composite", curves: [] }, {}, { picks: [e, e2] });
    const rc = engine.rebuild([box, comp]);
    expect(rc.featureErrors).toEqual({});
    expect(relativeError(lengthOf(rc.curves![comp.id]), 40)).toBeLessThan(1e-6);
    // Two edges that don't meet: refused.
    const far = boxEdge(box, part, [0, 20, 0], [20, 20, 0]);
    const bad = curve({ kind: "composite", curves: [] }, {}, { picks: [e, far] });
    expect(engine.rebuild([box, bad]).featureErrors[bad.id]).toMatch(/separate runs/);
  });

  it("a curve pattern follows a helix", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 40, height: 10, turns: 1 });
    const ball = feature("sphere", { diameter: 2, x: 20, y: 0, z: 0 });
    const pat: Feature = { ...feature("curvePattern", { count: 3 }, "add"), pathRef: h.id, pattern: { sources: [ball.id], axis: "x", flip: false } };
    const r = engine.rebuild([h, ball, pat]);
    expect(r.featureErrors).toEqual({});
    const b = meshOf(r).bounds!;
    // The last copy is at the top of the helix (z = 10).
    expect(b.max[2]).toBeCloseTo(11, 1);
  });
});

describe("review fixes", () => {
  const box = () => feature("box", { width: 20, depth: 20, height: 5 });
  const topEdges = (b: Feature, refs: { edgeRefs: EdgeRef[] }) => {
    const find = (a: Vec3, c: Vec3) => {
      const ref = refs.edgeRefs.find((e) => (near(e.a, a) && near(e.b, c)) || (near(e.a, c) && near(e.b, a)))!;
      return { partId: b.id, ref } as TopoPick;
    };
    return [find([0, 0, 5], [20, 0, 5]), find([20, 0, 5], [20, 20, 5]), find([20, 20, 5], [0, 20, 5])];
  };

  it("a curve's end is the end clicked, whatever order its pieces were picked in", () => {
    for (const order of [[0, 1, 2], [1, 0, 2], [1, 2, 0]]) {
      engine = new GeometryEngine();
      const b = box();
      const e = topEdges(b, engine.rebuild([b]).parts[0]);
      const comp = curve({ kind: "composite", curves: [] }, {}, { picks: order.map((i) => e[i]) });
      const fit = curve({ kind: "fitSpline", points: [{ p: [0, 0, 5], curve: comp.id, end: "a" }, { p: [10, 10, 20] }] });
      const r = engine.rebuild([b, comp, fit]);
      expect(r.featureErrors).toEqual({});
      expect(near(allPoints(r.curves![fit.id])[0], [0, 0, 5])).toBe(true);
      // The drawn line runs the way the curve does: its ends are the curve's ends.
      const line = allPoints(r.curves![comp.id]);
      const ends = [line[0], line[line.length - 1]];
      expect(ends.some((p) => near(p, [0, 0, 5])) && ends.some((p) => near(p, [0, 20, 5]))).toBe(true);
      engine.dispose();
    }
  });

  it("a Curve point plane on a curve sits that share of the way along it by length", () => {
    engine = new GeometryEngine();
    const b = box();
    const e = topEdges(b, engine.rebuild([b]).parts[0]);
    const comp = curve({ kind: "composite", curves: [] }, {}, { picks: [e[0], e[1]] });
    const fit = curve({ kind: "fitSpline", points: [{ p: [0, 0, 0] }, { p: [3, 8, 0] }, { p: [30, 10, 0] }] });
    const plane = (id: string): Feature => ({ ...feature("plane", {}), planeDef: { mode: "curvePoint", ref: { kind: "default", name: "Top" }, axis: "u", points: [{ p: [0, 0, 0], curve: id }], position: 0.25 } });
    const pc = plane(comp.id);
    const pf = plane(fit.id);
    const r = engine.rebuild([b, comp, fit, pc, pf]);
    expect(r.featureErrors).toEqual({});
    const quarter = (pts: Vec3[]) => {
      const total = lengthOf([pts.flat()]);
      let d = 0;
      for (let i = 1; i < pts.length; i++) {
        const step = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
        if (d + step >= total / 4) {
          const f = (total / 4 - d) / step;
          return [0, 1, 2].map((k) => pts[i - 1][k] + (pts[i][k] - pts[i - 1][k]) * f) as Vec3;
        }
        d += step;
      }
      return pts[pts.length - 1];
    };
    expect(near(r.followed![pc.id].origin as Vec3, quarter(allPoints(r.curves![comp.id])), 0.01)).toBe(true);
    expect(near(r.followed![pf.id].origin as Vec3, quarter(allPoints(r.curves![fit.id])), 0.02)).toBe(true);
  });

  it("refuses a sweep along a helix kept facing one way (it would turn edge-on)", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 20, height: 30, turns: 5 });
    const profile = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 10, y: 0 }, 1).sketch);
    const sweep: Feature = { ...feature("sweep", {}), sketchRef: profile.id, pathRef: h.id, apart: true, sweepControl: { lockOrientation: true } };
    const r = engine.rebuild([h, profile, sweep]);
    expect(r.featureErrors[sweep.id]).toMatch(/edge-on/);
    expect(r.parts).toHaveLength(0);
  });

  it("sweeps along a composite with a corner (right volume), and says plainly a twist there needs a sketch path", () => {
    engine = new GeometryEngine();
    const b = box();
    const e = topEdges(b, engine.rebuild([b]).parts[0]);
    const comp = curve({ kind: "composite", curves: [] }, {}, { picks: [e[1], e[0]] });
    const profile = sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 5 }, 1).sketch);
    const sweep: Feature = { ...feature("sweep", {}), sketchRef: profile.id, pathRef: comp.id, operation: "new" };
    const r = engine.rebuild([b, comp, profile, sweep]);
    expect(r.featureErrors).toEqual({});
    const v = engine.check("fine", [sweep.id]).parts[0].exactVolume!;
    expect(relativeError(v, Math.PI * 40)).toBeLessThan(0.03);
    const twisted: Feature = { ...sweep, params: { ...sweep.params, twist: "90" } };
    expect(engine.rebuild([b, comp, profile, twisted]).featureErrors[sweep.id]).toMatch(/sketch/);
  });

  it("curves of Part Studios not rebuilt are carried forward", () => {
    engine = new GeometryEngine();
    const ha = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 10, height: 10, turns: 2 });
    const hb = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "x" } }, { diameter: 10, height: 10, turns: 2 });
    const first = engine.rebuildStudios([{ id: "a", features: [ha] }, { id: "b", features: [hb] }]);
    expect(Object.keys(first.curves!).sort()).toEqual([ha.id, hb.id].sort());
    const again = engine.rebuildStudios([{ id: "a", features: [ha] }, { id: "b", features: [{ ...hb, params: { ...hb.params, turns: "3" } }] }]);
    expect(again.rebuilt).toEqual(["b"]);
    expect(again.curves![ha.id]).toEqual(first.curves![ha.id]);
    expect(again.curves![hb.id]).not.toEqual(first.curves![hb.id]);
  });
});

describe("Old designs", () => {
  it("a design with no curves reports none", () => {
    engine = new GeometryEngine();
    const r = engine.rebuild([feature("box", { width: 5, depth: 5, height: 5 })]);
    expect(r.curves).toBeUndefined();
  });
});
