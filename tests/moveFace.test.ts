/**
 * Move face's Onshape types, the pure parts: saved settings, the direction / axis the view draws, the rotation
 * maths, the boxes shown, dependents, what the engine is sent and the in-view handles.
 */
import { describe, expect, it } from "vitest";
import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { defaultParams, resolveParams, visibleParamKeys } from "../src/model/features";
import { findDependents } from "../src/model/dependents";
import { manipPoint, manipulatorsFor } from "../src/model/manipulators";
import { moveFaceAxisNow, moveFaceAxisProblem, moveFaceMode, parseMoveFace, rotationPivot, turnPoint, withMoveFaceAxis, withMoveFaceMode } from "../src/model/moveFace";
import { featureForEngine } from "../src/kernel/buildInput";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import type { Feature } from "../src/model/types";

type V = [number, number, number];
const close = (a: readonly number[], b: readonly number[], tol = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) < tol);
const face = (center: V, normal: V, surface = "PLANE"): FaceRef => ({ kind: "face", surface, center, normal });
const edge = (a: V, b: V, curve = "LINE"): EdgeRef => ({ kind: "edge", curve, a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
const on = (ref: FaceRef | EdgeRef, partId = "p"): TopoPick => ({ partId, ref });
function mf(extra: Partial<Feature> = {}, params: Record<string, string> = {}): Feature {
  return { id: "m", name: "Move face 1", type: "moveFace", operation: "new", suppressed: false, params: { ...defaultParams("moveFace"), ...params }, ...extra };
}

describe("Move face settings", () => {
  it("new ones are Offset; older ones (no type) stay as they were, and the angle isn't saved for them", () => {
    const f = createFeature(emptyDocument(), "moveFace");
    expect(f.moveFace).toEqual({ mode: "offset" });
    expect(f.params).toEqual({ distance: "2" });
    expect(moveFaceMode(mf())).toBe("classic");
    // An old file's Move face reads back with no moveFace.
    const doc = { ...emptyDocument(), features: [mf({ picks: [] })] };
    const back = parseDocument(JSON.parse(JSON.stringify(doc)))!;
    expect(back.features[0].moveFace).toBeUndefined();
    expect(back.features[0].params).toEqual({ distance: "2" });
  });

  it("reads saved settings carefully (picking isn't kept)", () => {
    const along = on(edge([0, 0, 0], [10, 0, 0]));
    expect(parseMoveFace({ mode: "rotate", along, flip: true, picking: "along", axis: "q" })).toEqual({ mode: "rotate", along, flip: true });
    expect(parseMoveFace({ mode: "translate", axis: "y" })).toEqual({ mode: "translate", axis: "y" });
    expect(parseMoveFace({ mode: "spin" })).toBeNull();
    expect(parseMoveFace(null)).toBeNull();
    const doc = { ...emptyDocument(), features: [mf({ picks: [], moveFace: { mode: "translate", along, picking: "along" } })] };
    expect(parseDocument(JSON.parse(JSON.stringify(doc)))!.features[0].moveFace).toEqual({ mode: "translate", along });
  });

  it("switching type keeps the direction; choosing X/Y/Z drops a clicked one and the other way round", () => {
    const along = on(edge([0, 0, 0], [10, 0, 0]));
    expect(withMoveFaceMode({ mode: "translate", along, flip: true, picking: "along" }, "rotate")).toEqual({ mode: "rotate", along, flip: true });
    expect(withMoveFaceMode(undefined, "rotate")).toEqual({ mode: "rotate" });
    expect(withMoveFaceAxis({ mode: "translate", along, picking: "along" }, "x")).toEqual({ mode: "translate", axis: "x" });
    expect(withMoveFaceAxis({ mode: "translate", axis: "x" }, along)).toEqual({ mode: "translate", along });
  });

  it("shows a distance, or (Rotate) an angle", () => {
    expect([...visibleParamKeys(mf())]).toEqual(["distance"]);
    expect([...visibleParamKeys(mf({ moveFace: { mode: "translate" } }))]).toEqual(["distance"]);
    expect([...visibleParamKeys(mf({ moveFace: { mode: "rotate" } }))]).toEqual(["angle"]);
    // An older feature without an angle box still resolves one (its default) without a problem.
    expect(resolveParams(mf({ moveFace: { mode: "rotate" } })).values.angle).toBe(5);
  });

  it("tells which clicks can be the direction or axis", () => {
    expect(moveFaceAxisProblem("translate", on(edge([0, 0, 0], [1, 0, 0])))).toBeNull();
    expect(moveFaceAxisProblem("translate", on(face([0, 0, 0], [0, 0, 1])))).toBeNull();
    expect(moveFaceAxisProblem("translate", on(face([0, 0, 0], [0, 0, 1], "CYLINDRE")))).toMatch(/curved/);
    expect(moveFaceAxisProblem("translate", on(edge([0, 0, 0], [1, 0, 0], "CIRCLE")))).toMatch(/curved/);
    expect(moveFaceAxisProblem("rotate", on(edge([0, 0, 0], [1, 0, 0], "CIRCLE")))).toBeNull();
    expect(moveFaceAxisProblem("rotate", on(face([0, 0, 0], [0, 0, 1], "CYLINDRE")))).toBeNull();
    expect(moveFaceAxisProblem("rotate", on(face([0, 0, 0], [0, 0, 1])))).toMatch(/isn't round/);
  });

  it("works out the direction / axis it can draw", () => {
    expect(moveFaceAxisNow({ mode: "translate" })).toEqual({ dir: [0, 0, 1], through: [0, 0, 0] });
    expect(close(moveFaceAxisNow({ mode: "translate", axis: "x", flip: true })!.dir, [-1, 0, 0])).toBe(true);
    expect(moveFaceAxisNow({ mode: "rotate", along: on(edge([0, 2, 0], [0, 2, 5])) })).toEqual({ dir: [0, 0, 1], through: [0, 2, 0] });
    expect(moveFaceAxisNow({ mode: "translate", along: on(face([1, 1, 1], [0, 2, 0])) })!.dir).toEqual([0, 1, 0]);
    // Only the engine knows a round face's axis.
    expect(moveFaceAxisNow({ mode: "rotate", along: on(face([1, 1, 1], [0, 1, 0], "CYLINDRE")) })).toBeNull();
  });
});

describe("turning a flat face as a pivot + lean", () => {
  it("about an edge lying on the face", () => {
    // A box's top (z = 10, normal +Z) turned 5° about its edge along X at y = 0.
    const p = rotationPivot([10, 5, 10], [0, 0, 1], [0, 0, 10], [1, 0, 0], 5);
    if (typeof p === "string") throw new Error(p);
    expect(p.tilt).toBeCloseTo(5, 9);
    // The pivot line is the edge.
    expect(Math.abs(p.point[1]) < 1e-9 && Math.abs(p.point[2] - 10) < 1e-9).toBe(true);
    expect(close(p.line.map(Math.abs), [1, 0, 0])).toBe(true);
    // n·cos + lean·sin = the turned normal.
    const a = (p.tilt * Math.PI) / 180;
    expect(close([Math.cos(a) * 0 + Math.sin(a) * p.lean[0], Math.sin(a) * p.lean[1], Math.cos(a) + Math.sin(a) * p.lean[2]], p.normal)).toBe(true);
    expect(close(p.normal, turnPoint([0, 0, 1], [0, 0, 0], [1, 0, 0], 5))).toBe(true);
  });

  it("about an axis off the face: the turned plane holds the turned middle", () => {
    const c: V = [10, 5, 10];
    const p = rotationPivot(c, [0, 0, 1], [0, 0, 0], [1, 0, 0], 5);
    if (typeof p === "string") throw new Error(p);
    const c2 = turnPoint(c, [0, 0, 0], [1, 0, 0], 5);
    const d = [c2[0] - p.point[0], c2[1] - p.point[1], c2[2] - p.point[2]];
    expect(Math.abs(d[0] * p.normal[0] + d[1] * p.normal[1] + d[2] * p.normal[2])).toBeLessThan(1e-9);
    // And the pivot lies on the face's plane too.
    expect(Math.abs(p.point[2] - 10)).toBeLessThan(1e-9);
  });

  it("refuses an axis straight out of the face, and no angle", () => {
    expect(rotationPivot([0, 0, 10], [0, 0, 1], [0, 0, 0], [0, 0, 1], 5)).toMatch(/straight out of the face/);
    expect(rotationPivot([0, 0, 10], [0, 0, 1], [0, 0, 0], [1, 0, 0], 0)).toMatch(/Enter an angle/);
  });
});

describe("Move face elsewhere", () => {
  it("Delete with dependents knows a clicked direction / axis (not for Offset, which ignores it)", () => {
    const feat = (id: string, extra: Partial<Feature> = {}): Feature => ({ id, name: id, type: "box", operation: "new", suppressed: false, params: {}, ...extra });
    const along = on(edge([0, 0, 0], [1, 0, 0]), "other");
    const features = [feat("box"), feat("other"), mf({ id: "mv", picks: [on(face([0, 0, 0], [0, 0, 1]), "box")], moveFace: { mode: "rotate", along } })];
    expect(findDependents(features, ["other"]).dependents).toEqual(["mv"]);
    const offset = [features[0], features[1], { ...features[2], moveFace: { mode: "offset" as const, along } }];
    expect(findDependents(offset, ["other"]).dependents).toEqual([]);
  });

  it("the engine isn't sent what a click picks", () => {
    const f = mf({ moveFace: { mode: "translate", axis: "x", picking: "along" } });
    expect(featureForEngine(f).moveFace).toEqual({ mode: "translate", axis: "x" });
    const plain = mf({ moveFace: { mode: "offset" } });
    expect(featureForEngine(plain)).toBe(plain);
  });

  it("in-view handles: Offset along the face, Translate along the direction, Rotate round the axis", () => {
    const top = on(face([10, 5, 10], [0, 0, 1]));
    const ctx = { sketch: null, parts: [{ id: "p", faceRefs: [top.ref as FaceRef] }] };
    const [o] = manipulatorsFor(mf({ picks: [top], moveFace: { mode: "offset" } }, { distance: "2" }), ctx);
    expect(close(manipPoint(o), [10, 5, 12])).toBe(true);
    const [t] = manipulatorsFor(mf({ picks: [top], moveFace: { mode: "translate", axis: "x", flip: true } }, { distance: "3" }), ctx);
    expect(t.kind).toBe("arrow");
    expect(close(manipPoint(t), [7, 5, 10])).toBe(true);
    const [r] = manipulatorsFor(mf({ picks: [top], moveFace: { mode: "rotate", along: on(edge([0, 0, 10], [20, 0, 10])) } }, { angle: "5" }), ctx);
    expect(r.kind).toBe("arc");
    expect(r.key).toBe("angle");
    expect(close(manipPoint(r), turnPoint([10, 5, 10], [0, 0, 10], [1, 0, 0], 5), 1e-6)).toBe(true);
    // Round a hole's axis (only the engine knows where): no handle.
    expect(manipulatorsFor(mf({ picks: [top], moveFace: { mode: "rotate", along: on(face([0, 0, 0], [0, 1, 0], "CYLINDRE")) } }), ctx)).toEqual([]);
  });
});
