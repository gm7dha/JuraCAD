import { describe, expect, it } from "vitest";

import { addArc, addLine, type Placed } from "../src/sketch/ops";
import { pathStations, walkPath } from "../src/sketch/pathSample";
import { emptySketch } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const top = { kind: "default" as const, name: "Top" as const };

describe("walking along a sketched path", () => {
  it("goes along lines from an open end", () => {
    const a = addLine(emptySketch(), at(0, 0), at(30, 0));
    const b = addLine(a.sketch, { x: 30, y: 0, snap: { kind: "point", id: a.endId } }, at(30, 40));
    const w = walkPath(top, b.sketch);
    if (typeof w === "string") throw new Error(w);
    expect(w.length).toBeCloseTo(70, 9);
    expect(w.closed).toBe(false);
    const ends = [w.at(0).point, w.at(70).point].map((p) => p.map((v) => Math.round(v * 1e6) / 1e6));
    // Either way round, it starts at one free end and finishes at the other.
    expect(ends.map((p) => p.join(",")).sort()).toEqual(["0,0,0", "30,40,0"]);
    expect(w.at(50).tangent.map(Math.abs).map((v) => Math.round(v))).toEqual([0, 1, 0]);
    expect(pathStations(w, 3)).toEqual([0, 35, 70]);
  });

  it("follows arcs and spaces copies evenly round a closed path", () => {
    // A full circle made of two half arcs.
    const r1 = addArc(emptySketch(), at(10, 0), at(-10, 0), { x: 0, y: 10 });
    const s = r1.sketch;
    const ends = s.curves[0].type === "arc" ? [s.curves[0].start, s.curves[0].end] : [];
    const r2 = addArc(s, { x: -10, y: 0, snap: { kind: "point", id: ends[1] === undefined ? "" : ends[0] } }, { x: 10, y: 0, snap: { kind: "point", id: ends[1] } }, { x: 0, y: -10 });
    const w = walkPath(top, r2.sketch);
    if (typeof w === "string") throw new Error(w);
    expect(w.length).toBeCloseTo(2 * Math.PI * 10, 1);
    expect(w.closed).toBe(true);
    expect(pathStations(w, 4)).toHaveLength(4);
    expect(typeof walkPath(top, emptySketch())).toBe("string");
  });
});
