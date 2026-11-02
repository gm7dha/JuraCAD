import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { visibleParamKeys } from "../src/model/features";
import { convertToSheet, offsetEdges, type SolidEdge, type SolidFace } from "../src/sheetmetal/convert";
import { flatPattern, foldSheet, type V3 } from "../src/sheetmetal/sheet";

/** A flat face with straight edges round the given corners (in order), facing out along `normal`. */
const face = (corners: V3[], normal: V3, holes: SolidEdge[][] = []): SolidFace => ({
  flat: true,
  normal,
  // Given in a muddled order, the way OpenCascade may list them.
  outer: corners.map((p, i): SolidEdge => ({ curve: "LINE", pts: i % 2 ? [corners[(i + 1) % corners.length], p] : [p, corners[(i + 1) % corners.length]] })).reverse(),
  holes,
});

/** The outside faces of an open-topped box W × D × H (bottom at z = 0), as a shell leaves them. */
function openBox(W: number, D: number, H: number) {
  return {
    bottom: face([[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]], [0, 0, -1]),
    front: face([[0, 0, 0], [W, 0, 0], [W, 0, H], [0, 0, H]], [0, -1, 0]),
    right: face([[W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H]], [1, 0, 0]),
    back: face([[W, D, 0], [0, D, 0], [0, D, H], [W, D, H]], [0, 1, 0]),
    left: face([[0, D, 0], [0, 0, 0], [0, 0, H], [0, D, H]], [-1, 0, 0]),
  };
}
const corners = (W: number, D: number, H: number): [V3, V3][] => [
  [[W, 0, 0], [W, 0, H]],
  [[W, D, 0], [W, D, H]],
  [[0, D, 0], [0, D, H]],
  [[0, 0, 0], [0, 0, H]],
];

function area(pts: [number, number][]) {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  });
  return a / 2;
}
const opts = { thickness: 1, radius: 1, k: 0.45, gap: 0.2, idPrefix: "c" };

describe("sheet metal from a solid", () => {
  it("bends an L of two faces, cutting each back by the bend's setback; the flat pattern adds the allowance", () => {
    // Two outside faces of an L bracket: a floor 50 deep (y) and a wall 30 tall, 40 wide (x).
    const floor = face([[0, 0, 0], [40, 0, 0], [40, 50, 0], [0, 50, 0]], [0, 0, -1]);
    const wall = face([[0, 0, 0], [40, 0, 0], [40, 0, 30], [0, 0, 30]], [0, -1, 0]);
    const r = convertToSheet([floor, wall], [], opts);
    if (typeof r === "string") throw new Error(r);
    const f = foldSheet(r.spec);
    expect(f.errors).toEqual({});
    expect(f.walls).toHaveLength(2);
    expect(f.bends).toHaveLength(1);
    expect(f.bends[0].angle).toBeCloseTo(90, 9);
    expect(f.bends[0].down).toBe(false);
    const s = 2; // (R + T) · tan 45°
    const A = (Math.PI / 2) * (1 + 0.45);
    expect(area(flatPattern(f).outline)).toBeCloseTo(40 * (50 - s) + 40 * A + 40 * (30 - s), 6);
    // Its wall stands in the face's place: metal from y = 0 to 1, up to z = 30.
    const w = f.walls[1];
    const top = [0, 1].map((h) => w.outline.flatMap((seg) => (seg.kind === "line" ? [seg.from] : [])).map((p) => [w.frame.origin[1] + w.frame.u[1] * p[0] + w.frame.v[1] * p[1] + w.frame.n[1] * h, w.frame.origin[2] + w.frame.u[2] * p[0] + w.frame.v[2] * p[1] + w.frame.n[2] * h]));
    expect(Math.min(...top[0].map((p) => p[0]))).toBeCloseTo(0, 9);
    expect(Math.max(...top[1].map((p) => p[0]))).toBeCloseTo(1, 9);
    expect(Math.max(...top[0].map((p) => p[1]))).toBeCloseTo(30, 9);
    expect(Math.min(...top[0].map((p) => p[1]))).toBeCloseTo(s, 9);
  });

  it("bends the other way at an inside corner (the faces are the bend's inside)", () => {
    // The inside faces of an L: the floor faces up, the wall faces +y; the metal is below and behind them.
    const floor = face([[0, 0, 0], [40, 0, 0], [40, 50, 0], [0, 50, 0]], [0, 0, 1]);
    const wall = face([[0, 0, 0], [40, 0, 0], [40, 0, 30], [0, 0, 30]], [0, 1, 0]);
    const r = convertToSheet([floor, wall], [], opts);
    if (typeof r === "string") throw new Error(r);
    const f = foldSheet(r.spec);
    expect(f.bends[0].down).toBe(true);
    const s = 1; // R · tan 45°
    const A = (Math.PI / 2) * (1 + 0.45);
    expect(area(flatPattern(f).outline)).toBeCloseTo(40 * (50 - s) + 40 * A + 40 * (30 - s), 6);
  });

  it("an open box with a rip at each corner unfolds into a cross of the right area", () => {
    const [W, D, H] = [60, 40, 30];
    const b = openBox(W, D, H);
    const r = convertToSheet([b.bottom, b.front, b.right, b.back, b.left], corners(W, D, H), opts);
    if (typeof r === "string") throw new Error(r);
    const f = foldSheet(r.spec);
    expect(f.errors).toEqual({});
    expect(f.walls).toHaveLength(5);
    expect(f.bends).toHaveLength(4);
    const s = 2;
    const A = (Math.PI / 2) * (1 + 0.45);
    const g = opts.gap;
    // Front runs corner to corner; right stops short of front (T + gap), back short of right, left short of both.
    const widths = [W, D - (1 + g), W - (1 + g), D - 2 * (1 + g)];
    const want = (W - 2 * s) * (D - 2 * s) + 2 * A * (W - 2 * s) + 2 * A * (D - 2 * s) + (H - s) * widths.reduce((x, y) => x + y, 0);
    const flat = flatPattern(f);
    expect(area(flat.outline)).toBeCloseTo(want, 6);
    expect(flat.bendLines).toHaveLength(4);
  });

  it("flipped, the metal goes outside the faces (they're the inside of the sheet)", () => {
    const [W, D, H] = [60, 40, 30];
    const b = openBox(W, D, H);
    const r = convertToSheet([b.bottom, b.front, b.right, b.back, b.left], corners(W, D, H), { ...opts, flip: true });
    if (typeof r === "string") throw new Error(r);
    const f = foldSheet(r.spec);
    expect(f.errors).toEqual({});
    expect(f.bends.every((x) => x.down)).toBe(true);
    const s = 1; // R · tan 45°: the faces are the bends' inside
    const A = (Math.PI / 2) * (1 + 0.45);
    const g = opts.gap;
    // At a rip the later wall only needs to clear the other's face by the gap.
    const widths = [W, D - g, W - g, D - 2 * g];
    const want = (W - 2 * s) * (D - 2 * s) + 2 * A * (W - 2 * s) + 2 * A * (D - 2 * s) + (H - s) * widths.reduce((x, y) => x + y, 0);
    expect(area(flatPattern(f).outline)).toBeCloseTo(want, 6);
  });

  it("keeps holes in the walls", () => {
    const [W, D, H] = [60, 40, 30];
    const b = openBox(W, D, H);
    const n = 24;
    const ring: V3[] = Array.from({ length: n + 1 }, (_, i) => [30 + 5 * Math.cos((2 * Math.PI * i) / n), 0, 15 + 5 * Math.sin((2 * Math.PI * i) / n)]);
    const front = { ...b.front, holes: [[{ curve: "CIRCLE" as const, pts: ring }]] };
    const r = convertToSheet([b.bottom, front, b.right, b.back, b.left], corners(W, D, H), opts);
    if (typeof r === "string") throw new Error(r);
    const flat = flatPattern(foldSheet(r.spec));
    expect(flat.holes).toHaveLength(1);
    expect(Math.abs(area(flat.holes[0]))).toBeCloseTo(Math.PI * 25, 0);
  });

  it("refuses what it can't do, saying what to change", () => {
    const [W, D, H] = [60, 40, 30];
    const b = openBox(W, D, H);
    // No rips: the side walls close into a ring.
    expect(convertToSheet([b.bottom, b.front, b.right, b.back, b.left], [], opts)).toMatch(/ring.*rip/);
    // A curved face.
    expect(convertToSheet([b.bottom, { ...b.front, flat: false }], [], opts)).toMatch(/flat/);
    // A face that doesn't touch the others along an edge.
    expect(convertToSheet([b.bottom, face([[0, 0, 50], [10, 0, 50], [10, 10, 50]], [0, 0, 1])], [], opts)).toMatch(/doesn't meet/);
    // A rip that isn't between two walls.
    expect(convertToSheet([b.bottom, b.front], [[[0, 0, 30], [60, 0, 30]]], opts)).toMatch(/rips isn't/);
    // Faces on both sides of the metal.
    expect(convertToSheet([b.bottom, { ...b.front, normal: [0, 1, 0] }], [], opts)).toMatch(/different sides/);
    // Too big a bend for the wall.
    expect(convertToSheet([b.bottom, b.front], [], { ...opts, radius: 40 })).toMatch(/too small/);
    // Two faces meeting along a curved edge.
    const arc: V3[] = Array.from({ length: 9 }, (_, i) => [10 * Math.cos((Math.PI * i) / 8), 0, 10 * Math.sin((Math.PI * i) / 8)]);
    const half: SolidFace = { flat: true, normal: [0, -1, 0], outer: [{ curve: "CIRCLE", pts: arc }, { curve: "LINE", pts: [[-10, 0, 0], [10, 0, 0]] }], holes: [] };
    const other: SolidFace = { flat: true, normal: [0, 1, 0], outer: [{ curve: "CIRCLE", pts: arc }, { curve: "LINE", pts: [[-10, 0, 0], [10, 0, 0]] }], holes: [] };
    expect(convertToSheet([half, other], [], opts)).toMatch(/curved edge|lie flat|different sides/);
  });

  it("moves edges in, meeting their neighbours, or says the wall's too small", () => {
    const sq = [
      { kind: "line" as const, from: [0, 0] as [number, number], to: [10, 0] as [number, number] },
      { kind: "line" as const, from: [10, 0] as [number, number], to: [10, 10] as [number, number] },
      { kind: "line" as const, from: [10, 10] as [number, number], to: [0, 10] as [number, number] },
      { kind: "line" as const, from: [0, 10] as [number, number], to: [0, 0] as [number, number] },
    ];
    const out = offsetEdges(sq, [1, 0, 2, 0], "It");
    if (typeof out === "string") throw new Error(out);
    expect(out[0]).toEqual({ kind: "line", from: [0, 1], to: [10, 1] });
    expect(out[2]).toEqual({ kind: "line", from: [10, 8], to: [0, 8] });
    expect(offsetEdges(sq, [6, 0, 6, 0], "It")).toMatch(/too small/);
  });

  it("is saved with the design: made from a part, its faces and rips kept; old sheets unchanged", () => {
    const sm = { ...createFeature(emptyDocument(), "sheetMetal"), sheetConvert: true, picks: [{ partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as V3, normal: [0, 0, -1] as V3, rel: [0.5, 0.5, 0] as V3 } }] };
    const doc = parseDocument(JSON.parse(JSON.stringify(addFeature(emptyDocument(), sm))))!;
    expect(doc.features[0].sheetConvert).toBe(true);
    expect(doc.features[0].picks).toHaveLength(1);
    const old = parseDocument(JSON.parse(JSON.stringify(addFeature(emptyDocument(), createFeature(emptyDocument(), "sheetMetal")))))!;
    expect(old.features[0].sheetConvert).toBeUndefined();
    expect(old.features[0].picks).toBeUndefined();
    // From a part: a gap at rips, no depth; from a sketch, the other way round.
    expect([...visibleParamKeys(doc.features[0])]).toContain("ripGap");
    expect([...visibleParamKeys(doc.features[0])]).not.toContain("depth");
    expect([...visibleParamKeys(old.features[0])]).not.toContain("ripGap");
  });
});
