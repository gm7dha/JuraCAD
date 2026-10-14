import { describe, expect, it } from "vitest";

import { autoDimensions, outlinePoints } from "../src/drawing/autoDimension";
import { measureDim, resolveDim } from "../src/drawing/dimensions";
import type { ViewProjection } from "../src/kernel/protocol";

/** A view with these outline corners (as edges round the outline) and circles. */
function view(kind: string, corners: [number, number][], circles: ViewProjection["circles"] = []): ViewProjection {
  const points: number[] = [];
  const visible: number[][] = [];
  corners.forEach(([x, y], i) => {
    const [nx, ny] = corners[(i + 1) % corners.length];
    points.push(x, y, nx, ny);
    visible.push([x, y, nx, ny]);
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    kind,
    visible,
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

  it("leaves out hidden edges", () => {
    const withHole = { ...front, points: [...front.points, 27, 0, 27, 10, 33, 0, 33, 10], hidden: [[27, 0, 27, 10], [33, 0, 33, 10]] };
    const dims = autoDimensions({ front: withHole }, ["front"], [], 1, id);
    expect(dims.filter((d) => d.type === "horizontal").length).toBe(2);
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

  it("chains evenly spaced holes, with the overall size outside", () => {
    // A 50 × 10 strip with four Ø4 holes 10 apart, starting 10 from the left.
    const strip = view(
      "top",
      [
        [0, 0],
        [50, 0],
        [50, 10],
        [0, 10],
      ],
      [10, 20, 30, 40].map((cx) => ({ cx, cy: 5, r: 2, hidden: false, full: true })),
    );
    const dims = autoDimensions({ top: strip }, ["top"], [], 1, id).filter((d) => d.type === "horizontal");
    expect(sizes(dims, { top: strip })).toEqual(["top horizontal 10", "top horizontal 10", "top horizontal 10", "top horizontal 10", "top horizontal 50"]);
    // The chain shares one row; the overall size sits further out.
    const overall = dims.find((d) => Math.abs(measureDim(d, resolveDim(d, strip)) - 50) < 1e-6)!;
    const chain = dims.filter((d) => d !== overall);
    // (Below the top view, each line sits `offset` below the lower of its two points.)
    const lineY = (d: (typeof dims)[number]) => Math.min(d.a.at[1], d.b!.at[1]) + d.offset;
    expect(new Set(chain.map(lineY)).size).toBe(1);
    expect(lineY(overall)).toBeLessThan(lineY(chain[0]));
  });

  it("uses ordinate dimensions when there are many uneven positions", () => {
    const plate = view(
      "top",
      [
        [0, 0],
        [60, 0],
        [60, 10],
        [0, 10],
      ],
      [7, 15, 26, 41].map((cx) => ({ cx, cy: 5, r: 1, hidden: false, full: true })),
    );
    const dims = autoDimensions({ top: plate }, ["top"], [], 1, id).filter((d) => d.type === "ordinate");
    expect(sizes(dims, { top: plate })).toEqual(["top ordinate 0", "top ordinate 15", "top ordinate 26", "top ordinate 41", "top ordinate 60", "top ordinate 7"]);
    // Running it again adds nothing.
    const all = autoDimensions({ top: plate }, ["top"], [], 1, id);
    expect(autoDimensions({ top: plate }, ["top"], all, 1, id)).toEqual([]);
  });
});
