/**
 * Pure tests: contouring for the Isocline, the new curve kinds' clicks/sizes/uses, and Delete with dependents for
 * sketches that use curve features.
 */
import { describe, expect, it } from "vitest";
import { chainKeys, contourRuns, insidePieces, joinRuns, thinRun, type P2 } from "../src/geometry/isoContour";
import { curveClick } from "../src/model/curveClicks";
import { curveParamKeys, curveUses, newCurveDef, parseCurveDef } from "../src/model/curves";
import { deleteFeatures, findDependents } from "../src/model/dependents";
import { emptyDocument } from "../src/model/document";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { emptySketch } from "../src/sketch/types";

type Vec3 = [number, number, number];

describe("contours", () => {
  it("finds a circle as one closed run, exactly with a refine step", () => {
    const n = 41;
    const at = (i: number) => -2 + (4 * i) / (n - 1);
    const f = (u: number, v: number) => u * u + v * v - 1;
    const values = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[i + j * n] = f(at(i), at(j));
    const refine = (a: P2, b: P2): P2 => {
      let lo = 0, hi = 1;
      const fa = f(...a) > 0;
      for (let k = 0; k < 50; k++) {
        const m = (lo + hi) / 2;
        if (f(a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m) > 0 === fa) lo = m;
        else hi = m;
      }
      return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
    };
    const runs = contourRuns({ nu: n, nv: n, u: at, v: at, values }, refine);
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(true);
    for (const p of runs[0].points) expect(Math.abs(Math.hypot(...p) - 1)).toBeLessThan(1e-9);
  });

  it("stops at points off the face (NaN): open runs", () => {
    const n = 21;
    const at = (i: number) => i / (n - 1);
    const values = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[i + j * n] = i > 15 ? NaN : at(j) - 0.5;
    const runs = contourRuns({ nu: n, nv: n, u: at, v: at, values });
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(false);
    for (const p of runs[0].points) expect(p[1]).toBeCloseTo(0.5, 9);
  });

  it("chains segments, tells inside (even–odd), joins runs and thins them", () => {
    expect(chainKeys([["a", "b"], ["c", "b"], ["c", "a"]])).toEqual([{ keys: ["a", "b", "c"], closed: true }]);
    const square: [P2, P2][] = [[[0, 0], [2, 0]], [[2, 0], [2, 2]], [[2, 2], [0, 2]], [[0, 2], [0, 0]]];
    const hole: [P2, P2][] = [[[0.5, 0.5], [1, 0.5]], [[1, 0.5], [1, 1]], [[1, 1], [0.5, 1]], [[0.5, 1], [0.5, 0.5]]];
    expect(insidePieces([1.5, 1.5], [...square, ...hole])).toBe(true);
    expect(insidePieces([0.75, 0.75], [...square, ...hole])).toBe(false);
    expect(insidePieces([3, 1], square)).toBe(false);
    const half1: Vec3[] = [[1, 0, 0], [0, 1, 0], [-1, 0, 0]];
    const half2: Vec3[] = [[-1, 0, 0], [0, -1, 0], [1, 0, 0]];
    const joined = joinRuns([{ points: half1, closed: false }, { points: half2, closed: false }], 1e-6);
    expect(joined).toHaveLength(1);
    expect(joined[0].closed).toBe(true);
    expect(joined[0].points).toHaveLength(4);
    const line: Vec3[] = Array.from({ length: 101 }, (_, i) => [i / 100, 0, 0]);
    const thin = thinRun(line, 0, 11);
    expect(thin.length).toBeLessThanOrEqual(11);
    expect(thin[0]).toEqual([0, 0, 0]);
    expect(thin[thin.length - 1]).toEqual([1, 0, 0]);
  });
});

const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const face = (partId: string): TopoPick => ({ partId, ref: { kind: "face" } as unknown as TopoPick["ref"] });
const edge = (partId: string): TopoPick => ({ partId, ref: { kind: "edge", a: [0, 0, 0] } as unknown as TopoPick["ref"] });

describe("new curve kinds", () => {
  it("show their own size boxes and start sensibly", () => {
    expect(curveParamKeys({ kind: "offset" })).toEqual(["distance"]);
    expect(curveParamKeys({ kind: "isocline" })).toEqual(["angle"]);
    expect(curveParamKeys({ kind: "trim" })).toEqual([]);
    expect(newCurveDef("isocline").axis?.axis).toBe("z");
    expect(newCurveDef("trim").curves).toEqual([]);
  });

  it("take clicks: offset edges and one face, isocline faces and a direction, trim a curve then what to cut back to", () => {
    const off = { id: "c1", curve: newCurveDef("offset"), picks: [] as TopoPick[] };
    const a = curveClick(off, { kind: "part", pick: edge("p") });
    expect(typeof a).toBe("object");
    const b = curveClick({ ...off, picks: (a as { picks: TopoPick[] }).picks }, { kind: "part", pick: face("p") });
    expect((b as { picks: TopoPick[] }).picks).toHaveLength(2);
    const iso = { id: "c2", curve: { ...newCurveDef("isocline"), picking: "axis" as const }, picks: [] };
    const d = curveClick(iso, { kind: "plane", plane: { kind: "default", name: "Front" }, frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] } });
    expect((d as { curve: { axis: { dir: Vec3 } } }).curve.axis.dir).toEqual([0, -1, 0]);
    const trim = { id: "c3", curve: newCurveDef("trim"), picks: [] };
    const t1 = curveClick(trim, { kind: "curve", id: "h", at: [0, 0, 0], points: [] }) as { curve: Feature["curve"] };
    expect(t1.curve!.curves).toEqual(["h"]);
    const t2 = curveClick({ ...trim, curve: t1.curve }, { kind: "curve", id: "g", at: [0, 0, 0], points: [] }) as { curve: Feature["curve"] };
    expect(t2.curve!.curves).toEqual(["h", "g"]);
    const t3 = curveClick({ ...trim, curve: t2.curve }, { kind: "part", pick: face("p") }) as { curve: Feature["curve"]; picks: TopoPick[] };
    expect(t3.curve!.curves).toEqual(["h"]);
    expect(t3.picks).toHaveLength(1);
  });

  it("say what they use, and read back from a file", () => {
    expect(curveUses({ curve: { kind: "trim", curves: ["h", "g"] } }).features).toEqual(["h", "g"]);
    expect(curveUses({ curve: { kind: "isocline", axis: { p: [0, 0, 0], curve: "h2" } } }).features).toEqual(["h2"]);
    const read = { geom: (x: unknown) => (x as never) ?? null, pick: () => null, plane: (x: unknown) => (x as never) ?? null };
    expect(parseCurveDef({ kind: "trim", curves: ["h"], flip: true }, read)).toEqual({ kind: "trim", curves: ["h"], flip: true });
    expect(parseCurveDef({ kind: "offset" }, read)).toEqual({ kind: "offset" });
  });
});

describe("Delete with dependents: sketches using curve features", () => {
  const helix = feat("h", "curve", { curve: { kind: "helix" } });
  const data = { ...emptySketch(), points: [{ id: "p1", x: 0, y: 0, link: { sketch: "h", item: "e0.a" } }] };
  const sk = feat("s", "sketch", { sketch: { plane: { kind: "default", name: "Front" }, data } });
  const trim = feat("t", "curve", { curve: { kind: "trim", curves: ["h"] } });

  it("a sketch keeps going without the curve's reference (it loses it); a trim of it goes", () => {
    const d = findDependents([helix, sk, trim], ["h"]);
    expect(d.dependents).toEqual(["t"]);
    expect(d.partial.map((p) => p.id)).toEqual(["s"]);
    const doc = { ...emptyDocument(), features: [helix, sk, trim] };
    const after = deleteFeatures(doc, ["h"], true);
    const left = after.features.find((f) => f.id === "s")!;
    expect(left.sketch!.data.points[0].link).toBeUndefined();
  });
});
