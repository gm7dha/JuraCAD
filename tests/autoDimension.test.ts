import { describe, expect, it } from "vitest";

import { autoDimensions, outlinePoints } from "../src/drawing/autoDimension";
import { measureDim, resolveDim } from "../src/drawing/dimensions";
import type { ViewProjection } from "../src/kernel/protocol";

/** A view with these outline corners (as edges round the outline) and circles. */
function view(kind: string, corners: [number, number][], circles: ViewProjection["circles"] = []): ViewProjection {
  const points: number[] = [];
  corners.forEach(([x, y], i) => {
    const [nx, ny] = corners[(i + 1) % corners.length];
    points.push(x, y, nx, ny);
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    kind,
    visible: [],
    hidden: [],
    circles,
    points,
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

let n = 0;
const id = () => `d${n++}`;
const sizes = (dims: ReturnType<typeof autoDimensions>, projections: Record<string, ViewProjection>) =>
  dims.map((d) => `${d.view} ${d.type} ${Math.round(measureDim(d, resolveDim(d, projections[d.view])) * 1000) / 1000}`).sort();

describe("auto dimension", () => {
  // An L-shaped bracket: 40 wide, 30 deep, 20 high with a 10 high step at x = 15; a Ø6 hole at (30, 15) seen from the top.
  const front = view("front", [
    [0, 0],
    [40, 0],
    [40, 10],
    [15, 10],
    [15, 20],
    [0, 20],
  ]);
  const top = view(
    "top",
    [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ],
    [{ cx: 30, cy: 15, r: 3, hidden: false, full: true }],
  );
  const right = view("right", [
    [0, 0],
    [30, 0],
    [30, 20],
    [0, 20],
  ]);
  const projections = { front, top, right };

  it("dimensions each direction once, the step, the hole's size and where it is", () => {
    const dims = autoDimensions(projections, ["front", "top", "right", "iso"], [], 1, id);
    expect(sizes(dims, projections)).toEqual([
      "front horizontal 15", // the step
      "front horizontal 40", // overall width
      "front vertical 10",
      "front vertical 20", // overall height
      "top diameter 6",
      "top horizontal 30", // the hole's centre from the left, where it shows as a circle
      "top vertical 15", // and from the front edge
      "top vertical 30", // overall depth
    ]);
    // The right view repeats nothing.
    expect(dims.some((d) => d.view === "right")).toBe(false);
  });

  it("stacks the rows outwards, shortest nearest the view", () => {
    const dims = autoDimensions(projections, ["front", "top"], [], 2, id).filter((d) => d.view === "front" && d.type === "horizontal");
    const offsets = dims.map((d) => d.offset);
    // Above the front view (the top view sits below it): the step's row first, then the overall width.
    expect(offsets).toEqual([(20 - 20) * 2 + 10, (20 - 10) * 2 + 17]);
  });

  it("doesn't repeat what's already there", () => {
    const first = autoDimensions(projections, ["front", "top"], [], 1, id);
    const again = autoDimensions(projections, ["front", "top"], first, 1, id);
    expect(again).toEqual([]);
  });

  it("puts hole positions in the top view when there's no front view", () => {
    const dims = autoDimensions(projections, ["top", "right"], [], 1, id);
    expect(sizes(dims, projections)).toEqual(["right vertical 20", "top diameter 6", "top horizontal 30", "top horizontal 40", "top vertical 15", "top vertical 30"]);
  });

  it("gives rounded corners a radius, and leaves their ends out of the outline", () => {
    // A 20 × 10 plate with its top-right corner rounded R3.
    const plate = view(
      "front",
      [
        [0, 0],
        [20, 0],
        [20, 7],
        [17, 10],
        [0, 10],
      ],
      [{ cx: 17, cy: 7, r: 3, hidden: false, full: false }],
    );
    expect(outlinePoints(plate).length).toBe(3);
    const dims = autoDimensions({ front: plate }, ["front"], [], 1, id);
    expect(sizes(dims, { front: plate })).toEqual(["front horizontal 20", "front radius 3", "front vertical 10"]);
  });
});
