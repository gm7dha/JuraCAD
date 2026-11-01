import { describe, expect, it } from "vitest";
import type { Segment } from "../src/sketch/regions";
import { hasSharpCorner, loopFrom, profilePlace, segmentAt, segmentDirection, segmentLength, smoothRuns, cornerRoom, splitSegment, twistStretches, wholeTurns, wholeTurnsMessage } from "../src/kernel/sweepPath";

const line = (a: [number, number], b: [number, number]): Segment => ({ kind: "line", from: a, to: b });
const square: Segment[] = [line([0, 0], [40, 0]), line([40, 0], [40, 40]), line([40, 40], [0, 40]), line([0, 40], [0, 0])];
const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

describe("sweep path pieces", () => {
  it("walks and cuts each kind of segment without changing its shape", () => {
    const arc: Segment = { kind: "arc", from: [10, 0], mid: [0, 10], to: [-10, 0] };
    close(segmentAt(arc, 0.5), [0, 10]);
    const [a1, a2] = splitSegment(arc, 0.25);
    close(segmentAt(a1, 1), segmentAt(arc, 0.25));
    close(segmentAt(a2, 0.5), segmentAt(arc, 0.625));
    // Clockwise arcs too.
    const cw: Segment = { kind: "arc", from: [-10, 0], mid: [0, 10], to: [10, 0] };
    close(segmentAt(cw, 0.5), [0, 10]);
    expect(segmentDirection(cw, 0)[0]).toBeCloseTo(0, 5);
    expect(segmentDirection(cw, 0)[1]).toBeCloseTo(1, 9);
    const bez: Segment = { kind: "bezier", from: [0, 0], c1: [10, 20], c2: [30, 20], to: [40, 0] };
    const [b1, b2] = splitSegment(bez, 0.3);
    close(segmentAt(b1, 0.5), segmentAt(bez, 0.15));
    close(segmentAt(b2, 0.5), segmentAt(bez, 0.65));
    const circle: Segment = { kind: "circle", center: [0, 0], radius: 5 };
    const [c1, c2] = splitSegment(circle, 0.25);
    close(segmentAt(c1, 1), [0, 5]);
    close(segmentAt(c2, 1), [5, 0]);
    close(segmentAt(c2, 0.5), [-5 / Math.SQRT2, -5 / Math.SQRT2]);
    const ellipse: Segment = { kind: "ellipse", center: [0, 0], rx: 6, ry: 3, angle: 0 };
    const [e1, e2] = splitSegment(ellipse, 0.5);
    close(segmentAt(e1, 0.5), [0, 3]);
    close(segmentAt(e2, 0.5), [0, -3]);
    // Part of an ellipse walked backwards keeps going backwards once cut.
    const back: Segment = { kind: "ellipseArc", center: [0, 0], rx: 6, ry: 3, angle: 0, t0: 0, t1: Math.PI, from: [-6, 0], to: [6, 0] };
    const [k1, k2] = splitSegment(back, 0.5);
    close(segmentAt(k1, 0), [-6, 0]);
    close(segmentAt(k1, 1), [0, 3]);
    close(segmentAt(k2, 1), [6, 0]);
  });

  it("splits a path at its sharp corners", () => {
    const L = [line([0, 0], [40, 0]), line([40, 0], [40, 40])];
    expect(smoothRuns(L, false)).toEqual({ runs: [[L[0]], [L[1]]], cornerAfter: [true, false] });
    expect(hasSharpCorner(L, false)).toBe(true);
    // A line running smoothly into an arc is one run.
    const smooth: Segment[] = [line([0, 0], [30, 0]), { kind: "arc", from: [30, 0], mid: [30 + 30 * Math.SQRT1_2, 30 - 30 * Math.SQRT1_2], to: [60, 30] }];
    expect(smoothRuns(smooth, false).runs).toHaveLength(1);
    expect(hasSharpCorner(smooth, false)).toBe(false);
    // A closed square: four runs, a corner after each (the last where it comes back round).
    const sq = smoothRuns(square, true);
    expect(sq.runs).toHaveLength(4);
    expect(sq.cornerAfter).toEqual([true, true, true, true]);
    // A smooth closed loop is cut in two, with no corners.
    const ring = smoothRuns([{ kind: "circle", center: [0, 0], radius: 20 }], true);
    expect(ring.runs).toHaveLength(2);
    expect(ring.cornerAfter).toEqual([false, false]);
    expect(hasSharpCorner([{ kind: "circle", center: [0, 0], radius: 20 }], true)).toBe(false);
  });

  it("starts a closed loop where the profile's plane crosses it", () => {
    // A profile on the plane x = 0 near (0, 20): the square's left side, half way up.
    const place = profilePlace(square, (p) => p[0] - 0, (p) => Math.hypot(p[0], p[1] - 20));
    // The left side runs from (0, 40) to (0, 0), so half way is t = 0.5 of segment 3.
    expect(place.index).toBe(3);
    expect(place.t).toBeCloseTo(0.5, 6);
    const from = loopFrom(square, place);
    expect(from).toHaveLength(5);
    close((from[0] as { from: [number, number] }).from, [0, 20]);
    close((from[4] as { to: [number, number] }).to, [0, 20]);
    // Now smooth where it starts and ends: four corners inside, none at the start.
    const runs = smoothRuns(from, true);
    expect(runs.runs).toHaveLength(5);
    expect(runs.cornerAfter).toEqual([true, true, true, true, false]);
    // Starting on a corner needs no cut.
    expect(loopFrom(square, { index: 1, t: 0 })).toEqual([square[1], square[2], square[3], square[0]]);
    // The plane x = 20 crosses at (20, 0) and (20, 40): the one nearer the profile wins.
    const top = profilePlace(square, (p) => p[0] - 20, (p) => Math.hypot(p[0] - 20, p[1] - 39));
    expect(top.index).toBe(2);
    expect(top.t).toBeCloseTo(0.5, 6);
  });

  it("asks for whole turns on a closed loop", () => {
    expect(wholeTurns(360)).toBe(true);
    expect(wholeTurns(-720)).toBe(true);
    expect(wholeTurns(0)).toBe(true);
    expect(wholeTurns(90)).toBe(false);
    expect(wholeTurns(359.9)).toBe(false);
    expect(wholeTurnsMessage(90)).toMatch(/whole number of turns.*90° isn't — try 360°/);
    expect(wholeTurnsMessage(500)).toMatch(/try 360°/);
    expect(wholeTurnsMessage(-200)).toMatch(/try -360°/);
    expect(wholeTurnsMessage(-100)).toMatch(/try -360°/);
  });

  it("sets room aside round each corner for the profile to go round untwisted", () => {
    const len = (ss: Segment[]) => ss.reduce((a, x) => a + segmentLength(x), 0);
    // An L, 40 then 40, with 5 mm either side of the corner.
    const L = [line([0, 0], [40, 0]), line([40, 0], [40, 40])];
    const { runs, cornerAfter } = smoothRuns(L, false);
    const reach = (5 - 0.01) / 1.1; // 5 mm of room round a right angle
    const plan = twistStretches(runs, cornerAfter, false, reach);
    expect(plan.map((p) => p.twisted)).toEqual([true, false, true]);
    expect(plan.map((p) => Number(len(p.segments).toFixed(6)))).toEqual([35, 10, 35]);
    close((plan[1].segments[0] as { from: [number, number] }).from, [35, 0]);
    close((plan[1].segments[1] as { to: [number, number] }).to, [40, 5]);
    // A closed square started half way along a side: four corners, four untwisted pieces between five twisted ones.
    const sq = smoothRuns(loopFrom(square, { index: 0, t: 0.5 }), true);
    const loop = twistStretches(sq.runs, sq.cornerAfter, true, reach);
    expect(loop.map((p) => p.twisted)).toEqual([true, false, true, false, true, false, true, false, true]);
    expect(loop.map((p) => Number(len(p.segments).toFixed(6)))).toEqual([15, 10, 30, 10, 30, 10, 30, 10, 15]);
    // An arc cut by length.
    const arcRun: Segment[] = [line([0, 0], [10, 0]), { kind: "arc", from: [10, 0], mid: [10 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2], to: [20, 10] }];
    const bend = smoothRuns([...arcRun, line([20, 10], [30, 10])], false);
    const cut = twistStretches(bend.runs, bend.cornerAfter, false, reach);
    expect(len(cut[0].segments)).toBeCloseTo(10 + (Math.PI / 2) * 10 - 5, 2);
    // Too short between corners: said plainly.
    const zig = smoothRuns([line([0, 0], [40, 0]), line([40, 0], [40, 6]), line([40, 6], [80, 6])], false);
    expect(() => twistStretches(zig.runs, zig.cornerAfter, false, reach)).toThrow(/too short to twist along with this profile.*longer than about 10\.1 mm/);
    // Sharper than a right angle, the sides overlap further out: more room (reach / tan(22.5°) for a 135° turn).
    expect(cornerRoom(reach, [1, 0], [-Math.SQRT1_2, Math.SQRT1_2])).toBeCloseTo(reach * 1.1 / Math.tan(Math.PI / 8) + 0.01, 9);
    expect(cornerRoom(reach, [1, 0], [Math.SQRT1_2, Math.SQRT1_2])).toBeCloseTo(5, 9);
    // Doubling straight back can't be done at all.
    expect(cornerRoom(reach, [1, 0], [-1, 0])).toBe(Infinity);
    const back = smoothRuns([line([0, 0], [40, 0]), line([40, 0], [10, 0])], false);
    expect(() => twistStretches(back.runs, back.cornerAfter, false, reach)).toThrow(/turns straight back on itself/);
    // A loop started right on a corner: no way to tell which way the profile faces.
    const onCorner = smoothRuns(square, true);
    expect(() => twistStretches(onCorner.runs, onCorner.cornerAfter, true, reach)).toThrow(/right on a corner/);
  });
});
