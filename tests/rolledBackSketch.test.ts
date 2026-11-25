/**
 * Pure: while an early sketch is edited, a Use click on the finished shape of a part later features changed is checked
 * against that part's edges as they were at the sketch (the face's edges and the snap list), as the engine re-finds links.
 */
import { describe, expect, it } from "vitest";

import { mainPart } from "../src/drawing/defaultPart";
import type { EdgeRef } from "../src/geometry/topoRef";
import type { RefEdge } from "../src/sketch/links";
import { cornerThen, edgeThen, meshSize } from "../src/sketch/rolledBack";

const line = (a: [number, number, number], b: [number, number, number]): EdgeRef => ({
  kind: "edge",
  curve: "LINE",
  a,
  b,
  mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
  length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
} as EdgeRef);
const seen = (partId: string, ref: EdgeRef, extra: Partial<RefEdge> = {}): RefEdge => ({ kind: "line", a: [0, 0], b: [1, 0], pick: { partId, ref }, ...extra }) as RefEdge;

// A 40 × 30 × 20 box as it was at the sketch: its top edges (the face's) and its upright edges (the snap list).
const top = [line([0, 0, 20], [40, 0, 20]), line([40, 0, 20], [40, 30, 20]), line([40, 30, 20], [0, 30, 20]), line([0, 30, 20], [0, 0, 20])];
const upright = line([40, 30, 0], [40, 30, 20]);
const faceEdges = top.map((r) => seen("box", r));
// (A Pierce place carries the same edge again: it mustn't make the match look doubtful.)
const candidates = [seen("box", upright), seen("box", upright, { kind: "point", pierce: true } as Partial<RefEdge>), seen("other", line([100, 0, 0], [140, 0, 0]))];
const size = Math.hypot(40, 30, 20);

describe("Use on a part changed later, while an early sketch is edited", () => {
  it("takes edges that were there (even if a later fillet shortened them)", () => {
    expect(edgeThen("box", top[0], size, faceEdges, candidates)).toBe(true);
    expect(edgeThen("box", upright, size, faceEdges, candidates)).toBe(true);
    // The front top edge, cut back 3 mm at each end by fillets on the upright edges.
    expect(edgeThen("box", line([3, 0, 20], [37, 0, 20]), size, faceEdges, candidates)).toBe(true);
  });

  it("refuses a fillet's edge that only the finished part has", () => {
    // Where a 3 mm fillet along the upright edge at (40, 30) meets the top: a quarter circle there.
    const filletRim: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [37, 30, 20], b: [40, 27, 20], mid: [39.12, 29.12, 20], length: (Math.PI * 3) / 2 } as EdgeRef;
    expect(edgeThen("box", filletRim, size, faceEdges, candidates)).toBe(false);
    // An edge of a hole drilled later, in the middle of the top.
    const holeRim: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [23, 15, 20], b: [23, 15, 20], mid: [17, 15, 20], length: Math.PI * 6 } as EdgeRef;
    expect(edgeThen("box", holeRim, size, faceEdges, candidates)).toBe(false);
  });

  it("can't tell (so lets it be) before the snap list has come, or when it was cut short", () => {
    expect(edgeThen("box", line([18, 12, 20], [22, 12, 20]), size, faceEdges, null)).toBeNull();
    const long = Array.from({ length: 20000 }, () => candidates[0]);
    expect(edgeThen("box", line([18, 12, 20], [22, 12, 20]), size, faceEdges, long)).toBeNull();
  });

  it("checks corners by the edges' ends then", () => {
    expect(cornerThen("box", [40, 30, 20], size, faceEdges, candidates)).toBe(true);
    expect(cornerThen("box", [20, 15, 20], size, faceEdges, candidates)).toBe(false);
  });

  it("measures a part as the engine does (its box's diagonal)", () => {
    expect(meshSize(new Float32Array([0, 0, 0, 40, 30, 20, 10, 10, 10]))).toBeCloseTo(size, 9);
    expect(meshSize([])).toBe(0);
  });
});

describe("a new drawing's part, pattern copies a hair different", () => {
  it("keeps the original when a copy's volume differs only in the last digits", () => {
    expect(mainPart([{ id: "a", volume: 24000 }, { id: "a~2", volume: 24000 * (1 + 3e-12) }, { id: "a~3", volume: 24000 * (1 + 2e-10) }])).toBe("a");
  });
});
