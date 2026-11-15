/**
 * More in-view handles against the real engine (from the review of the first version): Move face on a pocket's
 * floor and walls, Drafts on other neutral planes / below or across the neutral plane / inside walls at ±7° and ±44°,
 * lopsided chamfers on an upright edge and with the face picked too.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { manipPoint, manipulatorsFor } from "../src/model/manipulators";
import type { Feature } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

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

describe("move face on inside faces", () => {
  const base = feature("box", { width: 30, depth: 30, height: 10 });
  const pocket = feature("box", { width: 10, depth: 10, height: 5, x: 10, y: 10, z: 5 }, "remove");
  for (const [label, sel] of [
    ["floor", (f: FaceRef) => f.normal[2] > 0.99 && Math.abs(f.center[2] - 5) < 1e-6],
    ["wall x=10", (f: FaceRef) => f.normal[0] > 0.99 && Math.abs(f.center[0] - 10) < 1e-6],
    ["wall x=20", (f: FaceRef) => f.normal[0] < -0.99 && Math.abs(f.center[0] - 20) < 1e-6],
  ] as const) {
    for (const d of [2, -2]) {
      it(`${label} by ${d}`, () => {
        const r1 = build([base, pocket]);
        const v0 = volume();
        const face = facesOf(r1).find(sel)!;
        expect(face).toBeTruthy();
        const mv: Feature = { ...feature("moveFace", { distance: d }), picks: [pick(r1, face)] };
        const [m] = manipulatorsFor(mv, ctxOf(r1));
        const r = build([base, pocket, mv]);
        expect(r.featureErrors).toEqual({});
        const end = manipPoint(m);
        // A face of the result lies at the arrow's end, facing as the picked face does.
        const hit = facesOf(r).some((f) => dot(f.normal, face.normal) > 0.999 && Math.abs(dot(sub(end, f.center), f.normal)) < 1e-6);
        expect(hit).toBe(true);
        // Moving an inside face "out" (along its normal, into the pocket) adds material.
        const area = label === "floor" ? 100 : 50;
        expect(volume() - v0).toBeCloseTo(d * area, 3);
      });
    }
  }
});

describe("draft other neutral planes, faces below, inside walls", () => {
  const cases: [string, Feature[], (f: FaceRef) => boolean, Feature["neutral"], boolean][] = [
    ["Front neutral, +x face", [feature("box", { width: 20, depth: 20, height: 10 })], (f) => f.normal[0] > 0.99, { kind: "default", name: "Front" }, false],
    ["Front neutral flipped, +x face", [feature("box", { width: 20, depth: 20, height: 10 })], (f) => f.normal[0] > 0.99, { kind: "default", name: "Front" }, true],
    ["Right neutral, +y face", [feature("box", { width: 20, depth: 20, height: 10 })], (f) => f.normal[1] > 0.99, { kind: "default", name: "Right" }, false],
    ["below Top, +x face", [feature("box", { width: 20, depth: 20, height: 10, z: -20 })], (f) => f.normal[0] > 0.99, { kind: "default", name: "Top" }, false],
    ["straddling Top", [feature("box", { width: 20, depth: 20, height: 10, z: -3 })], (f) => f.normal[0] > 0.99, { kind: "default", name: "Top" }, false],
    [
      "pocket inside wall",
      [feature("box", { width: 30, depth: 30, height: 10 }), feature("box", { width: 10, depth: 10, height: 5, x: 10, y: 10, z: 5 }, "remove")],
      (f) => f.normal[0] < -0.99 && Math.abs(f.center[0] - 20) < 1e-6,
      { kind: "default", name: "Top" },
      false,
    ],
  ];
  for (const [label, parts, sel, neutral, flip] of cases) {
    for (const angle of [7, -7, 44, -44]) {
      it(`${label} at ${angle}`, () => {
        const r1 = build(parts);
        const face = facesOf(r1).find(sel)!;
        const draft: Feature = { ...feature("draft", { angle }), picks: [pick(r1, face)], neutral, flipSide: flip };
        const ms = manipulatorsFor(draft, ctxOf(r1));
        expect(ms.length).toBe(1);
        const r = build([...parts, draft]);
        expect(r.featureErrors).toEqual({});
        const handle = manipPoint(ms[0]);
        const leaned = facesOf(r).filter((f) => f.surface === "PLANE" && dot(f.normal, face.normal) > 0.5 && dot(f.normal, face.normal) < 0.9999);
        const d = Math.min(...leaned.map((f) => Math.abs(dot(sub(handle, f.center), f.normal))));
        expect(d).toBeLessThan(1e-3);
      });
    }
  }
});

describe("lopsided chamfer more corners", () => {
  const cutFace = (r: ReturnType<typeof build>) => facesOf(r).filter((f) => f.surface === "PLANE" && Math.max(...f.normal.map(Math.abs)) < 0.999);
  function run(parts: Feature[], edgeOk: (e: EdgeRef) => boolean, flip: boolean, extraPicks: (r: ReturnType<typeof build>) => TopoPick[] = () => [], kind: "twoDistances" | "distanceAngle" = "twoDistances", angle = 30) {
    const r1 = build(parts);
    const edge = r1.parts[0].edgeRefs.find((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && edgeOk(e))!;
    expect(edge).toBeTruthy();
    const ch: Feature = { ...feature("chamfer", { distance: 1, distance2: 3, angle }), picks: [...extraPicks(r1), pick(r1, edge)], chamferType: kind, flipSide: flip };
    const ms = manipulatorsFor(ch, ctxOf(r1));
    const r = build([...parts, ch]);
    expect(r.featureErrors).toEqual({});
    const cut = cutFace(r);
    const worst = Math.max(...ms.map((m) => Math.min(...cut.map((c) => Math.abs(dot(sub(manipPoint(m), c.center), c.normal))))));
    return { ms, worst };
  }
  const box = feature("box", { width: 20, depth: 10, height: 10 });
  const vertical = (e: EdgeRef) => Math.hypot(e.a[0] - 20, e.a[1] - 10) < 1e-6 && Math.hypot(e.b[0] - 20, e.b[1] - 10) < 1e-6;
  for (const flip of [false, true]) {
    it(`vertical edge (x and y faces tie on up) flip ${flip}`, () => {
      expect(run([box], vertical, flip).worst).toBeLessThan(1e-3);
    });
    it(`distance-angle 60 flip ${flip}`, () => {
      expect(run([box], vertical, flip, undefined, "distanceAngle", 60).worst).toBeLessThan(1e-3);
    });
  }
  it("a face picked along with an edge of it (engine takes the picked face first)", () => {
    const top = (r: ReturnType<typeof build>) => {
      // the +x side face (not the most upward one), so the engine's order differs from the "most upward" rule
      const f = facesOf(r).find((f) => f.normal[0] > 0.99)!;
      return [pick(r, f)];
    };
    const topEdge = (e: EdgeRef) => Math.abs(e.a[0] - 20) < 1e-6 && Math.abs(e.b[0] - 20) < 1e-6 && Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6;
    for (const flip of [false, true]) {
      const { ms, worst } = run([box], topEdge, flip, top);
      expect(ms.length).toBe(2);
      expect(worst).toBeLessThan(1e-3);
    }
  });
});
