/**
 * Loft guide continuity, pure: the bend that turns a station's outline to leave a guide along the face beside it
 * (only near the guide, the branch the loft doesn't sit on), and the model's choices, reading and edge picking.
 */
import { describe, expect, it } from "vitest";
import { BEND_REACH, tangentBend } from "../src/geometry/guideTangent";
import type { P2 } from "../src/geometry/warp2d";
import { guideContinuityOf, toggleEdge, withGuideContinuity } from "../src/model/loft";
import { parseLoftDef } from "../src/model/document";
import type { TopoPick } from "../src/geometry/topoRef";

/** A closed outline through the points, sampled every `step` along each side. */
function sampled(corners: P2[], per = 40): P2[] {
  const out: P2[] = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length];
    for (let k = 0; k < per; k++) out.push([a[0] + ((b[0] - a[0]) * k) / per, a[1] + ((b[1] - a[1]) * k) / per]);
  });
  return out;
}
const angleDeg = (a: P2, b: P2) => (Math.acos((a[0] * b[0] + a[1] * b[1]) / Math.hypot(...a) / Math.hypot(...b)) * 180) / Math.PI;

describe("tangentBend", () => {
  // A leaning triangle with its corner g on the edge: one side along the top face (+x), the other leaning up.
  const tri: P2[] = [
    [0, 0],
    [8, 0],
    [3, 8],
  ];
  const poly = sampled(tri);
  const g: P2 = [0, 0];
  // The faces beside the edge, carried on past it: the top face's goes −x, the side face's +y.
  const across: P2[] = [
    [-1, 0],
    [0, 1],
  ];

  it("turns only the free branch, so it leaves straight up the side face", () => {
    const bend = tangentBend(poly, g, across)!;
    expect(bend).toBeTruthy();
    expect(bend.face).toBe(1);
    const near = bend.map([0.03, 0.08]);
    expect(angleDeg(near, [0, 1])).toBeLessThan(1);
    // The branch on the top face, and everything beyond the bend's reach, stay where they were.
    expect(bend.map([2, 0])).toEqual([2, 0]);
    expect(bend.map([3, 8])).toEqual([3, 8]);
    const size = Math.max(...poly.map((p) => Math.hypot(p[0] - 11 / 3, p[1] - 8 / 3)));
    const past = BEND_REACH * size * 1.01;
    const q: P2 = [(3 / Math.hypot(3, 8)) * past, (8 / Math.hypot(3, 8)) * past];
    expect(bend.map(q)).toEqual(q);
  });

  it("does nothing when the outline already carries the face on, or every face is sat on", () => {
    const upright = sampled([
      [0, 0],
      [8, 0],
      [0, 8],
    ]);
    expect(tangentBend(upright, g, across)).toBeNull();
    expect(tangentBend(poly, g, [[-1, 0]])).toBeNull();
  });

  it("turns a smooth stretch as a whole", () => {
    const circle: P2[] = Array.from({ length: 200 }, (_, i) => [Math.cos((2 * Math.PI * i) / 200) * 5, 5 + Math.sin((2 * Math.PI * i) / 200) * 5]);
    // At the bottom the circle runs along x; asked to leave along the 30° line.
    const want: P2 = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const bend = tangentBend(circle, [0, 0], [want])!;
    expect(Math.abs(Math.abs(bend.angle) - Math.PI / 6)).toBeLessThan(0.02);
    const a = bend.map(circle[151]);
    const b = bend.map(circle[149]);
    expect(angleDeg([a[0] - b[0], a[1] - b[1]], want)).toBeLessThan(1.5);
  });
});

describe("guide continuity in the design", () => {
  const e1: TopoPick = { partId: "box", ref: { kind: "edge", curve: "LINE", a: [0, 0, 10], b: [40, 0, 10], mid: [20, 0, 10] } };
  const e2: TopoPick = { partId: "box", ref: { kind: "edge", curve: "LINE", a: [40, 0, 10], b: [40, 30, 10], mid: [40, 15, 10] } };

  it("is only offered on part edges, and kept while edges are clicked in and out", () => {
    expect(guideContinuityOf({ sketch: "s" })).toBe("none");
    expect(withGuideContinuity({ sketch: "s" }, "matchTangent")).toEqual({ sketch: "s" });
    const c = withGuideContinuity({ edges: [e1] }, "matchTangent", true);
    expect(c).toEqual({ edges: [e1], continuity: "matchTangent", otherFace: true });
    expect(toggleEdge(c, e2)).toEqual({ edges: [e1, e2], continuity: "matchTangent", otherFace: true });
    expect(withGuideContinuity(c, "none")).toEqual({ edges: [e1] });
  });

  it("reads it back, and a guide without it as before", () => {
    expect(parseLoftDef({ guide: { edges: [e1], continuity: "matchTangent" } })?.guide).toEqual({ edges: [e1], continuity: "matchTangent" });
    expect(parseLoftDef({ guide: { edges: [e1], continuity: "odd", otherFace: "yes" } })?.guide).toEqual({ edges: [e1] });
  });
});
