/**
 * Sheet metal from a solid (Convert) against the real OpenCascade engine: a
 * shelled open box turned into sheet metal, with a rip at each corner.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const [W, D, H] = [60, 40, 30];
const T = 1;
const R = 1;
const gap = 0.2;
const s = R + T; // the setback of a right-angle bend, picked faces outside
const A = (Math.PI / 2) * (R + 0.45 * T);
const Q = (Math.PI / 4) * ((R + T) ** 2 - R ** 2);
const area = (pts: [number, number][]) => Math.abs(pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2);

describe("sheet metal from a solid", () => {
  const box = feature("box", { width: W, depth: D, height: H });
  const shell: Feature = { ...feature("shell", { thickness: T }, "add"), picks: [] };
  let walls: TopoPick[] = [];
  let rips: TopoPick[] = [];
  /** The box's outside faces (bottom, front, right, back, left) and its corner edges, once it's shelled. */
  function setUp() {
    if (walls.length) return;
    type Built = ReturnType<typeof build>;
    const faceAt = (r: Built, test: (f: FaceRef) => boolean): TopoPick => ({ partId: box.id, ref: r.parts[0].faceRefs.find((f): f is FaceRef => f.kind === "face" && test(f))! });
    shell.picks = [faceAt(build([box]), (f) => f.normal[2] > 0.99)];
    const r1 = build([box, shell]);
    const outside = (n: [number, number, number], at: (c: [number, number, number]) => boolean) => faceAt(r1, (f) => f.surface === "PLANE" && f.normal.every((x, i) => Math.abs(x - n[i]) < 1e-6) && at(f.center as [number, number, number]));
    walls = [
      outside([0, 0, -1], (c) => Math.abs(c[2]) < 1e-6),
      outside([0, -1, 0], (c) => Math.abs(c[1]) < 1e-6),
      outside([1, 0, 0], (c) => Math.abs(c[0] - W) < 1e-6),
      outside([0, 1, 0], (c) => Math.abs(c[1] - D) < 1e-6),
      outside([-1, 0, 0], (c) => Math.abs(c[0]) < 1e-6),
    ];
    // The outside corner edges, straight up.
    rips = r1.parts[0].edgeRefs
      .filter((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - e.b[2]) > H - 1e-6 && [0, W].some((x) => Math.abs(e.a[0] - x) < 1e-6) && [0, D].some((y) => Math.abs(e.a[1] - y) < 1e-6))
      .map((ref) => ({ partId: box.id, ref }));
  }
  const convert = (picks: TopoPick[], params: Record<string, string> = {}): Feature => ({ ...feature("sheetMetal", { thickness: T, radius: R, kFactor: 0.45, ripGap: gap, ...params }, "new"), sheetConvert: true, picks });

  it("turns a shelled open box into sheet metal: bends at the bottom, a rip at each corner; it unfolds into a cross", () => {
    setUp();
    expect(walls.every((w) => w.ref)).toBe(true);
    expect(rips).toHaveLength(4);
    const c = convert([...walls, ...rips]);
    const r = build([box, shell, c]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // Front runs corner to corner; right stops short of front (T + gap), back short of right, left short of both.
    const widths = W + (D - (T + gap)) + (W - (T + gap)) + (D - 2 * (T + gap));
    const bendLength = 2 * (W - 2 * s) + 2 * (D - 2 * s);
    expect(check.exactVolume!).toBeCloseTo((W - 2 * s) * (D - 2 * s) * T + Q * bendLength + (H - s) * T * widths, 2);
    // Still the box's outside size.
    const v = r.parts[0].vertices;
    const hi = [0, 1, 2].map((j) => Math.max(...Array.from({ length: v.length / 3 }, (_, k) => v[3 * k + j])));
    const lo = [0, 1, 2].map((j) => Math.min(...Array.from({ length: v.length / 3 }, (_, k) => v[3 * k + j])));
    [...lo, ...hi].forEach((x, i) => expect(x).toBeCloseTo([0, 0, 0, W, D, H][i], 4));
    // The flat pattern: the bottom, four bend strips and four side walls.
    const flat = r.parts[0].flat!;
    expect(flat.notShown).toEqual([]);
    const want = (W - 2 * s) * (D - 2 * s) + A * bendLength + (H - s) * widths;
    expect(area(flat.outline)).toBeCloseTo(want, 4);
    expect(flat.bendLines).toHaveLength(4);
    const laid = engine.unfold(box.id)!;
    expect(analyzeMesh(laid.vertices, laid.triangles).volume).toBeCloseTo(want * T, 1);
  });

  it("then takes a flange on a wall's top edge", () => {
    setUp();
    const r = build([box, shell, convert([...walls, ...rips])]);
    // The front wall's top edge, on its outside face (y = 0, z = H).
    const rim = r.parts[0].edgeRefs.find((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - H) < 1e-6 && Math.abs(e.b[2] - H) < 1e-6 && Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6)!;
    expect(rim).toBeDefined();
    const fl: Feature = { ...feature("flange", { length: 10, angle: 90, inset: 0 }, "add"), picks: [{ partId: box.id, ref: rim }] };
    const r2 = build([box, shell, convert([...walls, ...rips]), fl]);
    expect(r2.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    const before = area(r.parts[0].flat!.outline);
    expect(area(r2.parts[0].flat!.outline)).toBeCloseTo(before + W * (A + 10 - s), 3);
  });

  it("explains what it can't do", () => {
    setUp();
    // No rips: the side walls join up in a ring.
    let r = build([box, shell, convert(walls)]);
    expect(r.featureErrors[Object.keys(r.featureErrors)[0]]).toMatch(/ring/);
    // No faces.
    const empty = convert([]);
    r = build([box, shell, empty]);
    expect(r.featureErrors[empty.id]).toMatch(/Click the flat faces/);
    // A curved face.
    const cyl = feature("cylinder", { diameter: 20, height: 10 });
    const rc = build([cyl]);
    const side: TopoPick = { partId: cyl.id, ref: rc.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface !== "PLANE")! };
    const bottom: TopoPick = { partId: cyl.id, ref: rc.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "PLANE")! };
    const bad = convert([bottom, side]);
    r = build([cyl, bad]);
    expect(r.featureErrors[bad.id]).toMatch(/flat/);
  });
});
