/** Clicks in the 3D view for curve features and for a Sweep's path (pure). */
import { describe, expect, it } from "vitest";
import { curveClick, curvePoint, pathClick } from "../src/model/curveClicks";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

const edge: TopoPick = { partId: "box", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [10, 0, 0], mid: [5, 0, 0] } as never };
const curveAt = (id: string, at: [number, number, number]) => ({ kind: "curve" as const, id, at, points: [[0, 0, 0], [5, 0, 0], [10, 0, 0]] as [number, number, number][] });
const draft = (curve: Feature["curve"], extra: Partial<Feature> = {}): Pick<Feature, "id" | "curve" | "picks"> => ({ id: "c", curve, ...extra });

describe("curve clicks", () => {
  it("a curve's end near the click, else its middle", () => {
    expect(curvePoint(curveAt("h", [9.5, 0, 0]))).toEqual({ p: [10, 0, 0], curve: "h", end: "b" });
    expect(curvePoint(curveAt("h", [0.2, 0, 0])).end).toBe("a");
    expect(curvePoint(curveAt("h", [5, 0, 0])).end).toBe("mid");
  });

  it("a bridging curve takes its from point, then its to point", () => {
    const first = curveClick(draft({ kind: "bridge", picking: "from" }), curveAt("h", [10, 0, 0]));
    expect(typeof first).toBe("object");
    const def = (first as { curve: NonNullable<Feature["curve"]> }).curve;
    expect(def.from?.end).toBe("b");
    expect(def.picking).toBe("to");
    const second = curveClick(draft(def), { kind: "part", pick: edge, at: [0, 0, 0] }) as { curve: NonNullable<Feature["curve"]> };
    expect(second.curve.to?.pick?.partId).toBe("box");
    expect(second.curve.picking).toBeUndefined();
  });

  it("a fit spline's points go in and out; composite curves and edges toggle", () => {
    const one = curveClick(draft({ kind: "fitSpline", points: [] }), curveAt("h", [10, 0, 0])) as { curve: NonNullable<Feature["curve"]> };
    expect(one.curve.points).toHaveLength(1);
    const none = curveClick(draft(one.curve), curveAt("h", [10, 0, 0])) as { curve: NonNullable<Feature["curve"]> };
    expect(none.curve.points).toHaveLength(0);
    const comp = curveClick(draft({ kind: "composite", curves: [] }), curveAt("h", [5, 0, 0])) as { curve: NonNullable<Feature["curve"]> };
    expect(comp.curve.curves).toEqual(["h"]);
    const withEdge = curveClick(draft({ kind: "composite", curves: [] }), { kind: "part", pick: edge }) as { picks: TopoPick[] };
    expect(withEdge.picks).toHaveLength(1);
    expect(curveClick(draft({ kind: "composite" }), curveAt("c", [5, 0, 0]))).toMatch(/itself/);
    expect(curveClick(draft({ kind: "helix", around: "face" }), { kind: "part", pick: edge })).toMatch(/isn't round/);
  });

  it("a sweep's path: a clicked curve, or edges once part edges are chosen", () => {
    expect(pathClick({ id: "s" }, curveAt("h", [0, 0, 0]))).toEqual({ pathRef: "h", pathEdges: undefined });
    expect(pathClick({ id: "s" }, { kind: "part", pick: edge })).toBeNull();
    expect(pathClick({ id: "s", pathEdges: [] }, { kind: "part", pick: edge })?.pathEdges).toHaveLength(1);
    expect(pathClick({ id: "s", pathEdges: [edge] }, { kind: "part", pick: edge })?.pathEdges).toHaveLength(0);
  });
});
