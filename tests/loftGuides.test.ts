/** Loft's several guides, connections and sketch-on-face ends: the pure parts (warps, clicks, saving, dependents). */
import { describe, expect, it } from "vitest";
import { crossedOver, fitWarp, rayHit, type P2 } from "../src/geometry/warp2d";
import { endChoices, loftClick, loftGuides, loftSketches, loftUses, loftWithoutGone, pickingIndex, tidyEnds, toggleConnectionPoint, withGuide, withoutConnection } from "../src/model/loft";
import { parseLoftDef } from "../src/model/document";
import type { Feature, LoftDef } from "../src/model/types";

const close = (a: P2, b: P2) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

describe("bending an outline to guides", () => {
  it("moves for one, stretches along the line between two, and passes exactly through three or more", () => {
    close(fitWarp([[1, 2]], [[3, 5]]).map([0, 0]), [2, 3]);
    // Two points on the x axis pulled apart: x stretched, y untouched.
    const two = fitWarp(
      [
        [10, 0],
        [-10, 0],
      ],
      [
        [15, 0],
        [-13, 0],
      ],
    );
    expect(two.affine).toBe(true);
    close(two.map([10, 0]), [15, 0]);
    close(two.map([-10, 0]), [-13, 0]);
    close(two.map([0, 10]), [1, 10]);
    close(two.map([10, 10]), [15, 10]);
    const from: P2[] = [
      [10, 0],
      [-10, 0],
      [0, 10],
      [0, -10],
    ];
    const to: P2[] = [
      [15, 0],
      [-13, 0],
      [0, 14],
      [0, -10],
    ];
    const many = fitWarp(from, to);
    from.forEach((p, i) => close(many.map(p), to[i]));
    // No pull: no change anywhere.
    const none = fitWarp(from, from);
    close(none.map([3, -7]), [3, -7]);
  });

  it("finds where a ray leaves an outline and tells guides that change places", () => {
    const square: P2[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    close(rayHit(square, [0, 0], [30, 0])!, [10, 0]);
    close(rayHit(square, [0, 0], [5, 5])!, [10, 10]);
    expect(crossedOver([[10, 0], [-10, 0]], [[12, 0], [-12, 0]], [0, 0])).toBe(false);
    expect(crossedOver([[10, 0], [-10, 0]], [[-12, 0], [12, 0]], [0, 0])).toBe(true);
    expect(crossedOver([[10, 0], [0, 10], [-10, 0]], [[12, 0], [0, 12], [-12, 0]], [0, 0])).toBe(false);
    expect(crossedOver([[10, 0], [0, 10], [-10, 0]], [[12, 0], [-12, 0], [0, 12]], [0, 0])).toBe(true);
  });
});

describe("guides, connections and ends in the loft's settings", () => {
  const sketchLoft = (loft: LoftDef): Pick<Feature, "sections" | "loft"> => ({ sections: ["a", "b"], loft });

  it("lists, sets and takes out guides", () => {
    const def: LoftDef = { guide: { sketch: "g1" }, moreGuides: [{ sketch: "g2" }] };
    expect(loftGuides(def)).toEqual([{ sketch: "g1" }, { sketch: "g2" }]);
    expect(withGuide(def, 2, { curve: "c" })).toEqual({ guide: { sketch: "g1" }, moreGuides: [{ sketch: "g2" }, { curve: "c" }] });
    expect(withGuide(def, 0, undefined)).toEqual({ guide: { sketch: "g2" }, moreGuides: undefined });
    expect(loftSketches(sketchLoft(def))).toEqual(["a", "b", "g1", "g2"]);
    expect(loftUses(sketchLoft(def)).features).toEqual(["g1", "g2"]);
  });

  it("adds and takes out connection points, and clicks pick corners for one", () => {
    const a = { p: [10, 10, 0] as [number, number, number], sketchPoint: { sketch: "a", point: "p1" } };
    const b = { p: [10, 10, 30] as [number, number, number], sketchPoint: { sketch: "b", point: "p3" } };
    let def: LoftDef = { ...toggleConnectionPoint({}, 0, a) };
    def = { ...def, ...toggleConnectionPoint(def, 0, b) };
    expect(def.connections).toEqual([{ points: [a, b] }]);
    expect(toggleConnectionPoint(def, 0, a)).toEqual({ connections: [{ points: [b] }] });
    expect(withoutConnection(def, 0)).toEqual({ connections: undefined });
    expect(pickingIndex("connection:3", "connection")).toBe(3);
    expect(pickingIndex("guide", "connection")).toBeNull();
    const ref = { kind: "edge" as const, a: [0, 0, 0] as [number, number, number], b: [10, 0, 0] as [number, number, number], mid: [5, 0, 0] as [number, number, number], length: 10, curve: "LINE" as const };
    const f: Pick<Feature, "sections" | "loft"> = { sections: ["a", "b"], loft: { picking: "connection:0" } };
    const out = loftClick(f, { kind: "part", pick: { partId: "box", ref: ref as never }, at: [9.5, 0, 0] });
    expect(typeof out).toBe("object");
    expect((out as Pick<Feature, "loft">).loft?.connections?.[0].points[0]).toMatchObject({ p: [10, 0, 0], end: "b" });
    // A deleted sketch's point is let go; a connection left with one point goes.
    const gone = loftWithoutGone({ sections: ["a", "b"], loft: def }, (id) => id === "b", () => false);
    expect(gone.loft?.connections).toBeUndefined();
  });

  it("offers carrying on from the faces to a sketch on a face only", () => {
    expect(endChoices({ sketch: "a" }, true)).toContain("matchTangent");
    expect(endChoices({ sketch: "a" })).not.toContain("matchTangent");
    const def: LoftDef = { start: { kind: "matchTangent" } };
    expect(tidyEnds(def, [{ sketch: "a" }, { sketch: "b" }], (id) => id === "a")).toEqual({});
    expect(tidyEnds(def, [{ sketch: "a" }, { sketch: "b" }], () => false)).toEqual({ start: undefined });
  });

  it("saves and reads them, and leaves older lofts as they were", () => {
    const def: LoftDef = {
      guide: { sketch: "g1" },
      moreGuides: [{ sketch: "g2" }, { curve: "c1" }],
      connections: [{ points: [{ p: [1, 2, 3] }, { p: [4, 5, 6], sketchPoint: { sketch: "b", point: "p2" } }] }],
    };
    expect(parseLoftDef(JSON.parse(JSON.stringify(def)))).toEqual(def);
    const old: LoftDef = { guide: { sketch: "g1" }, matchCorners: true };
    expect(JSON.stringify(parseLoftDef(JSON.parse(JSON.stringify(old))))).toBe(JSON.stringify(old));
    // Odd entries are dropped, not kept half-read.
    expect(parseLoftDef({ moreGuides: [{ nope: 1 }], connections: [{ points: [] }, "x"] })).toBeNull();
  });
});
