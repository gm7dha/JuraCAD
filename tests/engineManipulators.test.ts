/**
 * The in-view handles agree with what the engine builds (real OpenCascade): a Draft's arc leans the way the face
 * really leans, a Hole's arrow points the way it drills, a lopsided chamfer's arrows run along the faces the engine
 * measures them on (outside and inside corners), an offset surface's / grown surface's arrow points where the copy /
 * the growth really goes, and Move face's arrow ends on the moved face.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { manipPoint, manipulatorsFor, type Manipulator } from "../src/model/manipulators";
import type { Feature } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { extrudeFeature, feature, lineSketch, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

type V = [number, number, number];
let engine: GeometryEngine;
beforeAll(loadOpenCascade);

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volume = () => engine.check("normal").parts.reduce((s, p) => s + (p.exactVolume ?? 0), 0);
const facesOf = (r: ReturnType<typeof build>, i = 0) => r.parts[i].faceRefs.filter((f): f is FaceRef => f.kind === "face");
const pick = (r: ReturnType<typeof build>, ref: FaceRef | EdgeRef, i = 0): TopoPick => ({ partId: r.parts[i].id, ref });
const ctxOf = (r: ReturnType<typeof build>) => ({ sketch: null, parts: r.parts });
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** How far `p` is from the nearest face's plane among flat faces facing `n` (within 1°). */
function offPlane(faces: FaceRef[], p: V, n?: V): number {
  let best = Infinity;
  for (const f of faces) {
    if (f.surface !== "PLANE") continue;
    if (n && dot(f.normal, n) < Math.cos(Math.PI / 180)) continue;
    best = Math.min(best, Math.abs(dot(sub(p, f.center), f.normal)));
  }
  return best;
}
const byId = (ms: Manipulator[], id: string) => ms.find((m) => m.id === id)!;

describe("a Draft's arc leans the way the engine leans the face", () => {
  for (const [label, angle, flip] of [
    ["5°, pulled up", 5, false],
    ["-4°, pulled up", -4, false],
    ["6°, pulled down", 6, true],
  ] as const) {
    it(label, () => {
      const box = feature("box", { width: 20, depth: 20, height: 10 });
      const r1 = build([box]);
      const side = facesOf(r1).find((f) => f.normal[0] > 0.99)!;
      const draft: Feature = { ...feature("draft", { angle }), picks: [pick(r1, side)], neutral: { kind: "default", name: "Top" }, flipSide: flip };
      const [m] = manipulatorsFor(draft, ctxOf(r1));
      expect(m.kind).toBe("arc");
      expect(m.value).toBe(angle);
      const r = build([box, draft]);
      expect(r.featureErrors).toEqual({});
      // The handle (the face's middle, leaned by the angle) lies on the drafted face.
      const handle = manipPoint(m) as V;
      const leaned = facesOf(r).filter((f) => f.surface === "PLANE" && f.normal[0] > 0.5 && Math.abs(f.normal[2]) > 1e-4);
      expect(leaned.length).toBe(1);
      expect(Math.abs(dot(sub(handle, leaned[0].center), leaned[0].normal))).toBeLessThan(1e-3);
    });
  }
});

describe("a Hole's arrow points the way it drills", () => {
  it("into the part (and out of it with Flip)", () => {
    // A block under the Top plane; holes drilled from a point on Top at (10, 10).
    const box = feature("box", { width: 20, depth: 20, height: 10, z: -10 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, addPoint(emptySketch(), { x: 10, y: 10 }).sketch);
    const hole = (flip: boolean): Feature => ({ ...feature("hole", { diameter: 4, depth: 6 }, "remove"), hole: { sketchRef: sk.id, kind: "simple", standard: "Custom", fit: "clearance", end: "blind", flip }, apart: true });
    const sketchCtx = { sketch: { plane: sk.sketch!.plane, data: sk.sketch!.data }, parts: [] };
    for (const flip of [false, true]) {
      const [m] = manipulatorsFor(hole(flip), sketchCtx);
      expect(manipPoint(m)).toEqual([10, 10, flip ? 6 : -6]);
      const r = build([box, sk, hole(flip)]);
      expect(r.featureErrors).toEqual({});
      // Drilled into the block only when the arrow points into it (out of it, only the drill's short lead-in back into the face).
      if (flip) expect(volume()).toBeGreaterThan(3998);
      else expect(volume()).toBeLessThan(4000 - Math.PI * 4 * 6 + 1e-3);
    }
  });
});

describe("a lopsided chamfer's handles run along the faces the engine measures on", () => {
  /** The cut's face: the flat face not facing along X, Y or Z. */
  const cutFace = (r: ReturnType<typeof build>) => facesOf(r).filter((f) => f.surface === "PLANE" && Math.max(...f.normal.map(Math.abs)) < 0.999);

  function check(parts: Feature[], edgeAt: (e: EdgeRef) => boolean, flip: boolean) {
    const r1 = build(parts);
    const edge = r1.parts[0].edgeRefs.find((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && edgeAt(e))!;
    expect(edge).toBeTruthy();
    // Two distances.
    const two: Feature = { ...feature("chamfer", { distance: 1, distance2: 3 }), picks: [pick(r1, edge)], chamferType: "twoDistances", flipSide: flip };
    const ms = manipulatorsFor(two, ctxOf(r1));
    expect(ms.map((m) => m.id)).toEqual(["distance", "distance2"]);
    const r = build([...parts, two]);
    expect(r.featureErrors).toEqual({});
    const cut = cutFace(r);
    expect(cut.length).toBe(1);
    for (const m of ms) expect(Math.abs(dot(sub(manipPoint(m), cut[0].center), cut[0].normal))).toBeLessThan(1e-3);
    // The arrows run along the faces (each lies on a face of the part before the chamfer).
    for (const m of ms) expect(offPlane(facesOf(r1), manipPoint(m) as V)).toBeLessThan(1e-6);
    // A distance and an angle: the arc's handle lies on the cut too.
    const da: Feature = { ...feature("chamfer", { distance: 2, angle: 30 }), picks: [pick(r1, edge)], chamferType: "distanceAngle", flipSide: flip };
    const ma = manipulatorsFor(da, ctxOf(r1));
    expect(ma.map((m) => m.id)).toEqual(["distance", "angle"]);
    const r2 = build([...parts, da]);
    expect(r2.featureErrors).toEqual({});
    const cut2 = cutFace(r2);
    expect(cut2.length).toBe(1);
    for (const m of ma) expect(Math.abs(dot(sub(manipPoint(m), cut2[0].center), cut2[0].normal))).toBeLessThan(1e-3);
  }

  it("on a box's outside edge, either way round", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    // The top edge at x = 20.
    for (const flip of [false, true]) check([box], (e) => Math.abs(e.a[0] - 20) < 1e-6 && Math.abs(e.b[0] - 20) < 1e-6 && Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6, flip);
  });

  it("on an inside corner (a wall standing on a base)", () => {
    const base = feature("box", { width: 30, depth: 10, height: 5 });
    const wall = feature("box", { width: 5, depth: 10, height: 15, z: 5 }, "add");
    // Where the wall's side (x = 5) meets the base's top (z = 5).
    for (const flip of [false, true]) check([base, wall], (e) => Math.abs(e.a[0] - 5) < 1e-6 && Math.abs(e.b[0] - 5) < 1e-6 && Math.abs(e.a[2] - 5) < 1e-6 && Math.abs(e.b[2] - 5) < 1e-6, flip);
  });
});

describe("surfaces and faces moved: the arrow ends where the engine puts them", () => {
  // A flat wall 20 wide, 5 tall, from a line along X extruded up (its face square to Y).
  const sk = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 0, 20, 0));
  const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };

  it("Offset surface: the copy lies at the arrow's end, either way", () => {
    const r1 = build([sk, wall]);
    const face = facesOf(r1)[0];
    for (const d of [2, -3]) {
      const off: Feature = { ...feature("offsetSurface", { distance: d }), picks: [pick(r1, face)] };
      const [m] = manipulatorsFor(off, ctxOf(r1));
      expect(m.signed).toBe(true);
      const r = build([sk, wall, off]);
      expect(r.featureErrors).toEqual({});
      expect(offPlane(facesOf(r, 1), manipPoint(m) as V)).toBeLessThan(1e-3);
      expect(Math.abs(manipPoint(m)[1])).toBeCloseTo(Math.abs(d), 6);
    }
  });

  it("Extend surface: grows the way the arrow points, as far", () => {
    const r1 = build([sk, wall]);
    const top = r1.parts[0].edgeRefs.find((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - 5) < 1e-6 && Math.abs(e.b[2] - 5) < 1e-6)!;
    const ext: Feature = { ...feature("extendSurface", { distance: 3 }), picks: [pick(r1, top)] };
    const [m] = manipulatorsFor(ext, ctxOf(r1));
    expect(manipPoint(m)).toEqual([10, 0, 8]);
    const r = build([sk, wall, ext]);
    expect(r.featureErrors).toEqual({});
    const zs = Array.from(r.parts[0].vertices).filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(8, 4);
    // Asked again once the surface has grown, the arrow stays (it was worked out from the surface as picked).
    const [again] = manipulatorsFor(ext, ctxOf(r));
    expect(manipPoint(again)).toEqual([10, 0, 8]);
  });

  it("Move face: the moved face is at the arrow's end, out or in", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r1 = build([box]);
    const top = facesOf(r1).find((f) => f.normal[2] > 0.99)!;
    for (const d of [3, -2]) {
      const mv: Feature = { ...feature("moveFace", { distance: d }), picks: [pick(r1, top)] };
      const [m] = manipulatorsFor(mv, ctxOf(r1));
      expect(m.locked).toBeUndefined();
      const r = build([box, mv]);
      expect(r.featureErrors).toEqual({});
      expect(offPlane(facesOf(r), manipPoint(m) as V, [0, 0, 1])).toBeLessThan(1e-6);
      expect(manipPoint(m)[2]).toBeCloseTo(10 + d, 6);
    }
  });

  it("Shell: the arrow follows its face when an earlier feature moved it", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const top = facesOf(r1).find((f) => f.normal[2] > 0.99)!;
    const shell: Feature = { ...feature("shell", { thickness: 2 }), picks: [pick(r1, top)] };
    // The box made taller since the top was picked: the arrow sits on the top as it is now.
    const tall = { ...box, params: { ...box.params, height: "16" } };
    const r = build([tall]);
    const [m] = manipulatorsFor(shell, ctxOf(r));
    expect(m.origin[2]).toBeCloseTo(16, 6);
    expect(manipPoint(m)[2]).toBeCloseTo(14, 6);
  });
});
