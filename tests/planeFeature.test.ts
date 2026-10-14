import { describe, expect, it } from "vitest";

import { createFeature, emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import type { Feature } from "../src/model/types";
import { framesOf, planeAsSketchPlane, planeFeatureFrame, refreshPlaneRefs } from "../src/sketch/planeFeature";
import { planeFrame } from "../src/sketch/planes";

const r = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

describe("plane features", () => {
  it("sits a distance from a plane", () => {
    const f = planeFeatureFrame({ mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" }, { distance: 25 });
    if (typeof f === "string") throw new Error(f);
    expect(r(f.origin)).toEqual([0, 0, 25]);
    expect(r(f.n)).toEqual([0, 0, 1]);
  });

  it("tilts about one of its directions", () => {
    // The Top plane tilted 90° about its across (X) direction stands up like the Front plane (facing −Y).
    const f = planeFeatureFrame({ mode: "angle", ref: { kind: "default", name: "Top" }, axis: "u" }, { angle: 90, distance: 0 });
    if (typeof f === "string") throw new Error(f);
    expect(r(f.n)).toEqual([0, -1, 0]);
    expect(r(f.u)).toEqual([1, 0, 0]);
  });

  it("goes halfway between two parallel faces, or says why not", () => {
    const low = { kind: "face" as const, origin: [0, 0, 2] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Face" };
    const high = { ...low, origin: [5, 5, 12] as [number, number, number] };
    const f = planeFeatureFrame({ mode: "midplane", ref: low, ref2: high, axis: "u" }, { distance: 0 });
    if (typeof f === "string") throw new Error(f);
    expect(r(f.origin)).toEqual([0, 0, 7]);
    expect(planeFeatureFrame({ mode: "midplane", ref: low, axis: "u" }, {})).toMatch(/second/);
    const side = { ...low, u: [0, 1, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number] };
    expect(planeFeatureFrame({ mode: "midplane", ref: low, ref2: side, axis: "u" }, {})).toMatch(/parallel/);
  });

  it("keeps sketches on it in place when it moves", () => {
    const doc = emptyDocument();
    const plane: Feature = { ...createFeature(doc, "plane"), params: { distance: "10", angle: "30" } };
    const frame = framesOf([plane]).get(plane.id)!;
    expect(r(frame.origin)).toEqual([0, 0, 10]);
    const sketch: Feature = { ...createFeature(doc, "sketch"), sketch: { plane: planeAsSketchPlane(plane, frame), data: { points: [], curves: [], constraints: [] } } };
    // Nothing moved: the same list comes back.
    const same = [plane, sketch];
    expect(refreshPlaneRefs(same)).toBe(same);
    // The plane moves up to 40: the sketch follows.
    const moved = refreshPlaneRefs([{ ...plane, params: { ...plane.params, distance: "40" } }, sketch]);
    expect(r(planeFrame(moved[1].sketch!.plane!).origin)).toEqual([0, 0, 40]);
    // A plane on a plane follows too.
    const second: Feature = { ...createFeature(doc, "plane"), planeDef: { mode: "offset", ref: planeAsSketchPlane(plane, frame), axis: "u" }, params: { distance: "5", angle: "0" } };
    const chain = refreshPlaneRefs([{ ...plane, params: { ...plane.params, distance: "40" } }, second]);
    expect(r(framesOf(chain).get(second.id)!.origin)).toEqual([0, 0, 45]);
  });

  it("is saved and opened again", () => {
    const doc = emptyDocument();
    const plane: Feature = { ...createFeature(doc, "plane"), planeDef: { mode: "angle", ref: { kind: "default", name: "Right" }, axis: "v" } };
    const read = readDocumentFile(serializeDocument({ ...doc, features: [plane] }));
    expect(read.ok && read.doc.features[0].planeDef).toEqual(plane.planeDef);
  });
});
