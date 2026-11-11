import { describe, expect, it } from "vitest";
import { applyPoint, applyVec, compose, frameFromZ, invert, isClassicTransform, rotation, toAxisAngle, transformMotion, transformTriad, transformKeys, valuesInFrame, type Rigid, type Triad, type Vec3 } from "../src/model/transformMath";
import { axisParam, handleAt, lengthStep, planeHit, snapTo, startTriadDrag, TRIAD_LAYOUT, type Ray } from "../src/viewport/transformDrag";
import type { TransformDef } from "../src/model/types";
import { circleOf, directionOf, lineOf, spotFrame } from "../src/model/transformPicks";

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const def = (t: Partial<TransformDef> = {}): TransformDef => ({ partId: "p", axis: "z", about: "centre", copy: false, ...t });
/** Looking straight down from above (Top view): rays go −Z, through (x, y). */
const down = (x: number, y: number): Ray => ({ origin: [x, y, 100], dir: [0, 0, -1] });
/** Looking from the front (−Y towards +Y). */
const front = (x: number, z: number): Ray => ({ origin: [x, -100, z], dir: [0, 1, 0] });

describe("transform maths", () => {
  it("turns and moves like the engine always has (about the centre, X then Y then Z, then the move)", () => {
    const m = transformMotion(def(), { rz: 90, dx: 10 }, [5, 5, 0]) as Rigid;
    // (15, 5, 0) turns a quarter about the centre to (5, 15, 0), then moves 10 along X.
    close(applyPoint(m, [15, 5, 0]), [15, 15, 0]);
    // X first, then Y: (1, 0, 0) about X stays put, then about Y goes to (0, 0, −1).
    const n = transformMotion(def(), { rx: 90, ry: 90 }, [0, 0, 0]) as Rigid;
    close(applyVec(n, [0, 1, 0]), [1, 0, 0]);
    close(applyVec(n, [1, 0, 0]), [0, 0, -1]);
    expect(isClassicTransform(def())).toBe(true);
    expect(isClassicTransform(def({ mode: "xyz" }))).toBe(false);
  });

  it("moves along and turns about a triad put somewhere else", () => {
    // A triad on a face sloping at 45° about X, at (0, 10, 0): its Z points up and back.
    const triad = { origin: [0, 10, 0] as Vec3, x: [1, 0, 0] as Vec3, z: [0, -Math.SQRT1_2, Math.SQRT1_2] as Vec3 };
    const m = transformMotion(def({ triad }), { dz: 2 }, [99, 99, 99]) as Rigid;
    close(m.t, [0, -Math.SQRT2, Math.SQRT2]);
    // Turning about its Z goes through its origin, which stays put.
    const t = transformMotion(def({ triad }), { rz: 30 }, [99, 99, 99]) as Rigid;
    close(applyPoint(t, [0, 10, 0]), [0, 10, 0]);
  });

  it("does Onshape's other ways: by distance, by line, rotate and mate connectors", () => {
    const c: Vec3 = [0, 0, 0];
    close((transformMotion(def({ mode: "distance", along: { axis: "y" } }), { distance: 7 }, c) as Rigid).t, [0, 7, 0]);
    close((transformMotion(def({ mode: "distance", along: { dir: [0, 0, 2], through: [1, 1, 1] }, flip: true }), { distance: 3 }, c) as Rigid).t, [0, 0, -3]);
    close((transformMotion(def({ mode: "line", line: { a: [1, 2, 3], b: [4, 6, 3] } }), {}, c) as Rigid).t, [3, 4, 0]);
    expect(transformMotion(def({ mode: "line" }), {}, c)).toMatch(/straight edge/);
    // Rotate a quarter about a line along Z through (10, 0, 0).
    const r = transformMotion(def({ mode: "rotate", along: { dir: [0, 0, 1], through: [10, 0, 0] } }), { turn: 90 }, c) as Rigid;
    close(applyPoint(r, [20, 0, 5]), [10, 10, 5]);
    // Mate connectors: a top face's spot lands on another top face's spot, Z onto Z (Flip: upside down).
    const from = { origin: [5, 5, 10] as Vec3, x: [1, 0, 0] as Vec3, z: [0, 0, 1] as Vec3 };
    const to = { origin: [50, 0, 0] as Vec3, x: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };
    const m = transformMotion(def({ mode: "mates", from, to }), {}, c) as Rigid;
    close(applyPoint(m, from.origin), to.origin);
    close(applyVec(m, from.x), to.x);
    const f = transformMotion(def({ mode: "mates", from, to, flip: true }), {}, c) as Rigid;
    close(applyPoint(f, from.origin), to.origin);
    close(applyVec(f, [0, 0, 1]), [0, 0, -1]);
    expect(transformMotion(def({ mode: "mates", from }), {}, c)).toMatch(/move it to/);
  });

  it("goes back and forth between a move and its turn-then-shift form", () => {
    const m = compose(rotation([1, 2, 3], 130, [4, 5, 6]), rotation([0, 1, 0], 180));
    const { axis, degrees, t } = toAxisAngle(m);
    const again = compose({ r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t }, rotation(axis, degrees));
    close(applyPoint(again, [7, -3, 2]), applyPoint(m, [7, -3, 2]));
    close(applyPoint(compose(invert(m), m), [1, 2, 3]), [1, 2, 3]);
    // A half turn exactly.
    const h = toAxisAngle(rotation([0, 1, 1], 180));
    expect(h.degrees).toBeCloseTo(180, 6);
    close(applyPoint(compose({ r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: h.t }, rotation(h.axis, h.degrees)), [3, 1, 0]), applyPoint(rotation([0, 1, 1], 180), [3, 1, 0]));
  });

  it("puts the triad where the part has moved to, keeping its directions; uses only the boxes it needs", () => {
    const t = transformTriad(def(), { dx: 10, rz: 45 }, [1, 2, 3])!;
    close(t.frame.origin, [11, 2, 3]);
    close(t.frame.x, [1, 0, 0]);
    expect([t.arrows, t.rings, t.ball]).toEqual([[0, 1, 2], [0, 1, 2], true]);
    expect(transformTriad(def({ mode: "xyz" }), {}, [0, 0, 0])!.rings).toEqual([]);
    const r = transformTriad(def({ mode: "rotate", along: { dir: [0, 0, 1], through: [10, 0, 0] } }), { turn: 10 }, [0, 0, 5])!;
    close(r.frame.origin, [10, 0, 5]);
    expect(r.rings).toEqual([2]);
    expect(transformTriad(def({ mode: "mates" }), {}, [0, 0, 0])).toBeNull();
    expect(transformKeys(undefined)).toEqual(["rx", "ry", "rz", "dx", "dy", "dz"]);
    expect(transformKeys({ mode: "distance" })).toEqual(["distance"]);
    // A frame from just its Z: X lines up with world X when it can.
    const f = frameFromZ([0, 0, 0], [0, 0, 5]);
    close(f.x, [1, 0, 0]);
    close(f.y, [0, 1, 0]);
  });
});

describe("dragging the triad", () => {
  const triad: Triad = { frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, arrows: [0, 1, 2], planes: [2, 0, 1], rings: [0, 1, 2], ball: true };
  const snap = { snap: true, step: 1 };
  const free = { snap: false, step: 1 };

  it("finds the nearest point on a line to the pointer's ray", () => {
    expect(axisParam(down(12.5, 3), [0, 0, 0], [1, 0, 0])).toBeCloseTo(12.5, 9);
    // Pointing straight at the eye: no answer (a tiny move would throw the part far off).
    expect(axisParam(down(1, 1), [0, 0, 0], [0, 0, 1])).toBeNull();
    close(planeHit(down(3, 4), [0, 0, 2], [0, 0, 1])!, [3, 4, 2]);
    expect(planeHit(front(0, 0), [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("snaps to steps, bigger as you zoom out; Shift drags freely", () => {
    expect(snapTo(12.4, 1)).toBe(12);
    expect(snapTo(12.6, 5)).toBe(15);
    expect(snapTo(12.3456, 0)).toBe(12.346);
    expect(lengthStep(0.1)).toBe(1);
    expect(lengthStep(2)).toBe(10);
    expect(lengthStep(0.1, "in")).toBeCloseTo(1.27, 9);
    const drag = startTriadDrag({ kind: "arrow", axis: 0 }, triad, 50, down(30, 0), { dx: 0 }, "free")!;
    expect(drag.move(down(42.4, 7), snap)).toEqual({ dx: 12 });
    expect(drag.move(down(42.4, 7), free)).toEqual({ dx: 12.4 });
  });

  it("moves along an arrow from the value the drag started at", () => {
    const drag = startTriadDrag({ kind: "arrow", axis: 1 }, triad, 50, down(0, 10), { dy: 5, dx: 3 }, "free")!;
    expect(drag.move(down(8, 2), snap)).toEqual({ dy: -3 });
    // An arrow seen end-on can't be dragged.
    expect(startTriadDrag({ kind: "arrow", axis: 2 }, triad, 50, down(0, 0), {}, "free")).toBeNull();
  });

  it("moves in a square's plane and with the ball in the screen's plane", () => {
    const sq = startTriadDrag({ kind: "plane", axis: 2 }, triad, 50, down(20, 20), {}, "free")!;
    expect(sq.move(down(27, 14), snap)).toEqual({ dx: 7, dy: -6 });
    // From the front the ball moves along X and Z, never Y.
    const ball = startTriadDrag({ kind: "ball" }, triad, 50, front(0, 0), { dy: 2 }, "free")!;
    expect(ball.move(front(4, -9), snap)).toEqual({ dx: 4, dy: 2, dz: -9 });
  });

  it("turns with a ring, by the angle round it, past half a turn too", () => {
    const ring = startTriadDrag({ kind: "ring", axis: 2 }, triad, 50, down(39, 0), { rz: 10 }, "free")!;
    expect(ring.move(down(0, 39), snap)).toEqual({ rz: 100 });
    ring.move(down(-39, 1), snap);
    expect(ring.move(down(-30, -30), snap)).toEqual({ rz: 235 });
    expect(ring.move(down(-30, -30), { ...free, angleStep: 5 }).rz).toBeCloseTo(235, 1);
    // Seen edge-on (a ring about X from above): sliding along it turns it.
    const edge = startTriadDrag({ kind: "ring", axis: 0 }, triad, 50, down(0, 0), {}, "free")!;
    // Grabbed at the front (nearest the eye), sliding towards −Y turns it anticlockwise about X.
    expect(edge.move(down(0, -(TRIAD_LAYOUT.ring * 50 * Math.PI) / 4), free).rx).toBeCloseTo(45, 1);
  });

  it("drags only what each way of moving uses", () => {
    expect(startTriadDrag({ kind: "ring", axis: 2 }, triad, 50, down(39, 0), {}, "xyz")).toBeNull();
    const dist = startTriadDrag({ kind: "arrow", axis: 2 }, triad, 50, front(0, 10), { distance: 4 }, "distance")!;
    expect(dist.move(front(3, 25), snap)).toEqual({ distance: 19 });
    const turn = startTriadDrag({ kind: "ring", axis: 2 }, triad, 50, down(0, 39), {}, "rotate")!;
    expect(turn.move(down(-39, 0), snap)).toEqual({ turn: 90 });
  });

  it("picks the handle under the pointer on screen", () => {
    // Top view, 1 px = 1 mm, screen y down.
    const project = (p: Vec3): [number, number] => [200 + p[0], 200 - p[1]];
    expect(handleAt(triad, 100, project, 200, 200)).toEqual({ kind: "ball" });
    expect(handleAt(triad, 100, project, 290, 202)).toEqual({ kind: "arrow", axis: 0 });
    expect(handleAt(triad, 100, project, 241, 159)).toEqual({ kind: "plane", axis: 2 });
    expect(handleAt(triad, 100, project, 200 - 78 * Math.SQRT1_2, 200 + 78 * Math.SQRT1_2)).toEqual({ kind: "ring", axis: 2 });
    expect(handleAt(triad, 100, project, 400, 400)).toBeNull();
    // A finger reaches further.
    expect(handleAt(triad, 100, project, 290, 212)).toBeNull();
    expect(handleAt(triad, 100, project, 290, 212, 2.2)).toEqual({ kind: "arrow", axis: 0 });
  });
});

describe("moving the triad keeps the part where it is", () => {
  it("works out the same move in the new triad's directions", () => {
    const t = def();
    const values = { rx: 20, ry: -35, rz: 110, dx: 4, dy: -7, dz: 12 };
    const centre: Vec3 = [3, 1, 2];
    const before = transformMotion(t, values, centre) as Rigid;
    const frame = frameFromZ([10, -4, 6], [1, 1, 1], [0, 1, 0]);
    const triad = { origin: frame.origin, x: frame.x, z: frame.z };
    const again = transformMotion(def({ triad }), valuesInFrame(t, values, centre, frame), centre) as Rigid;
    for (const p of [[0, 0, 0], [5, -2, 9], [-3, 8, 1]] as Vec3[]) close(applyPoint(again, p), applyPoint(before, p), 4);
    // Straight up and down (where X and Z turns run together) too.
    const up = { ry: 90, rz: 30, dx: 1 };
    const there = transformMotion(def({ triad: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } }), valuesInFrame(t, up, centre, { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }), centre) as Rigid;
    close(applyPoint(there, [2, 3, 4]), applyPoint(transformMotion(t, up, centre) as Rigid, [2, 3, 4]), 4);
  });
});

describe("what a click gives Move / copy", () => {
  const edge = (a: Vec3, b: Vec3, curve = "LINE") => ({ kind: "edge" as const, curve, a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as Vec3 });
  const ring = (c: Vec3, r: number): Vec3[] => Array.from({ length: 33 }, (_, k) => [c[0] + r * Math.cos((k * Math.PI) / 16), c[1] + r * Math.sin((k * Math.PI) / 16), c[2]] as Vec3);

  it("puts a spot on a flat face's middle, an edge's nearest end or middle, a round edge's centre, or a plane", () => {
    const face = spotFrame({ kind: "face", ref: { kind: "face", surface: "PLANE", center: [5, 5, 10], normal: [0, 0, 1] } }) as ReturnType<typeof frameFromZ>;
    close(face.origin, [5, 5, 10]);
    close(face.z, [0, 0, 1]);
    expect(spotFrame({ kind: "face", ref: { kind: "face", surface: "CYLINDRE", center: [0, 0, 0], normal: [1, 0, 0] } })).toMatch(/curved/);
    const e = edge([0, 0, 0], [10, 0, 0]);
    close((spotFrame({ kind: "edge", ref: e, at: [9, 0, 0], points: [] }) as ReturnType<typeof frameFromZ>).origin, [10, 0, 0]);
    close((spotFrame({ kind: "edge", ref: e, at: [6, 0, 0], points: [] }) as ReturnType<typeof frameFromZ>).origin, [5, 0, 0]);
    const round = spotFrame({ kind: "edge", ref: edge([3, 0, 2], [3, 0, 2], "CIRCLE"), points: ring([1, 0, 2], 2) }) as ReturnType<typeof frameFromZ>;
    close(round.origin, [1, 0, 2]);
    expect(Math.abs(round.z[2])).toBeCloseTo(1, 6);
    // On the Front plane: the point brought onto it, Z out of it.
    const front = spotFrame({ kind: "plane", frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] } }, [4, 7, 2]) as ReturnType<typeof frameFromZ>;
    close(front.origin, [4, 0, 2]);
    close(front.z, [0, -1, 0]);
  });

  it("gives directions, axes and lines", () => {
    const d = directionOf({ kind: "edge", ref: edge([1, 1, 0], [1, 1, 5]), points: [] }) as { dir: Vec3; through: Vec3 };
    close(d.dir, [0, 0, 1]);
    const axis = directionOf({ kind: "edge", ref: edge([3, 0, 2], [3, 0, 2], "CIRCLE"), points: ring([1, 0, 2], 2) }) as { dir: Vec3; through: Vec3 };
    close(axis.through, [1, 0, 2]);
    expect(directionOf({ kind: "edge", ref: edge([0, 0, 0], [1, 1, 1], "BSPLINE"), points: [[0, 0, 0], [0.2, 0.5, 0.1], [0.6, 0.6, 0.9], [1, 1, 1]] })).toMatch(/neither straight nor round/);
    // From the end nearer the click.
    expect(lineOf({ kind: "edge", ref: edge([0, 0, 0], [10, 0, 0]), at: [8, 0, 0], points: [] })).toEqual({ a: [10, 0, 0], b: [0, 0, 0] });
    expect(lineOf({ kind: "face", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } })).toMatch(/straight edge/);
    expect(circleOf(ring([0, 0, 0], 5))!.radius).toBeCloseTo(5, 6);
  });
});
