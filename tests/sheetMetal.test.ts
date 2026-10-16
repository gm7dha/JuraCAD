import { describe, expect, it } from "vitest";

import { findSheetEdge, flatPattern, flatPoint, foldSheet, mapSegments, unfoldMoves, wallOnPlane, wallPoint, type Frame3, type P2, type SheetSpec, type V3 } from "../src/sheetmetal/sheet";
import { outsideOnly } from "../src/sheetmetal/flatExport";
import type { Segment } from "../src/sketch/regions";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const top: Frame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
/** A w × h rectangle, anticlockwise from the origin: edge 0 along the bottom (y = 0), 1 the right, 2 the top, 3 the left. */
const plate = (w: number, h: number): Segment[] => [
  { kind: "line", from: [0, 0], to: [w, 0] },
  { kind: "line", from: [w, 0], to: [w, h] },
  { kind: "line", from: [w, h], to: [0, h] },
  { kind: "line", from: [0, h], to: [0, 0] },
];
const spec = (flanges: SheetSpec["flanges"], T = 2, R = 2, k = 0.5): SheetSpec => ({ thickness: T, radius: R, k, base: { frame: top, outer: plate(100, 50), holes: [] }, flanges });

function area(pts: [number, number][]) {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  });
  return a / 2;
}

describe("sheet metal", () => {
  it("bends a flange straight up off an edge, standing as tall as its length", () => {
    const f = foldSheet(spec([{ id: "f1", wall: "base", edge: 1, length: 30, angle: 90, down: false }]));
    expect(f.errors).toEqual({});
    const wall = f.walls[1];
    // Off the right edge (x = 100): the flange's outside face is at x = 100 + R + T = 104, inside at 102.
    const T = 2;
    const corners: V3[] = [wallPoint(wall.frame, [0, 0]), wallPoint(wall.frame, [50, 26]), wallPoint(wall.frame, [0, 0], T)];
    close(corners[0], [104, 50, 4]);
    // Its tip is 30 mm up on the outside (from the base's underside), across the whole edge.
    close(corners[1], [104, 0, 30]);
    close(corners[2], [102, 50, 4]);
  });

  it("bends down too, at any angle", () => {
    const f = foldSheet(spec([{ id: "f1", wall: "base", edge: 0, length: 20, angle: 45, down: true }]));
    expect(f.errors).toEqual({});
    const tip = wallPoint(f.walls[1].frame, [0, 10]);
    // Heading out (−y) and down at 45°.
    expect(tip[1]).toBeLessThan(-5);
    expect(tip[2]).toBeLessThan(-5);
  });

  it("unfolds into one outline with the bend allowance added, and bend lines", () => {
    // Flanges up on the right and left edges: flat width = 100 + 2 × (allowance + straight).
    const T = 2;
    const R = 2;
    const k = 0.5;
    const f = foldSheet(spec([
      { id: "r", wall: "base", edge: 1, length: 30, angle: 90, down: false },
      { id: "l", wall: "base", edge: 3, length: 30, angle: 90, down: false },
    ], T, R, k));
    const flat = flatPattern(f);
    const allowance = (Math.PI / 2) * (R + k * T);
    const straight = 30 - (R + T);
    const xs = flat.outline.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100 + 2 * (allowance + straight), 6);
    expect(area(flat.outline)).toBeCloseTo(50 * (100 + 2 * (allowance + straight)), 4);
    expect(flat.bendLines).toHaveLength(2);
    close(flat.bendLines[0][0], [100 + allowance / 2, 0]);
  });

  it("puts flanges on flanges, and finds the wall edge a picked edge lies along", () => {
    const f = foldSheet(spec([
      { id: "a", wall: "base", edge: 1, length: 30, angle: 90, down: false },
      // On the first flange's tip, bent back inwards over the base.
      { id: "b", wall: "a", edge: 2, length: 15, angle: 90, down: false },
    ]));
    expect(f.errors).toEqual({});
    expect(f.walls).toHaveLength(3);
    const flat = flatPattern(f);
    expect(flat.bendLines).toHaveLength(2);
    expect(area(flat.outline)).toBeGreaterThan(50 * 100);
    // The base's top edge along y = 50, picked on its top face.
    expect(findSheetEdge(f, 2, [10, 50, 2], [90, 50, 2])).toEqual({ wall: "base", edge: 2 });
    // The bent edge isn't offered again; a line off the sheet isn't an edge.
    expect(findSheetEdge(f, 2, [100, 10, 0], [100, 40, 0])).toBe(null);
    expect(findSheetEdge(f, 2, [10, 70, 0], [90, 70, 0])).toBe(null);
  });

  it("shortens a flange at each end, cutting a relief notch into the sheet beside each end of the bend", () => {
    const T = 2;
    const R = 2;
    const k = 0.5;
    const f = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 30, angle: 90, down: false, inset: 10 }], T, R, k));
    expect(f.errors).toEqual({});
    // 30 wide (50 less 10 each end), starting 10 in from y = 50.
    close(wallPoint(f.walls[1].frame, [0, 0]), [104, 40, 4]);
    close(wallPoint(f.walls[1].frame, [30, 0]), [104, 10, 4]);
    expect(f.bends[0].reliefs).toHaveLength(2);
    // Flat: the plate less two 2 × 2 notches, plus the 30 wide strip and flange.
    const allowance = (Math.PI / 2) * (R + k * T);
    expect(area(flatPattern(f).outline)).toBeCloseTo(100 * 50 - 2 * T * T + 30 * (allowance + 26), 4);
    expect(foldSheet(spec([{ id: "g", wall: "base", edge: 1, length: 30, angle: 90, down: false, inset: 25 }])).errors.g).toMatch(/Shortened too much/);
  });

  it("cuts round-ended or tear reliefs when asked", () => {
    const T = 2;
    const R = 2;
    const k = 0.5;
    const allowance = (Math.PI / 2) * (R + k * T);
    const flangeArea = 30 * (allowance + 26);
    const round = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 30, angle: 90, down: false, inset: 10, reliefShape: "round" }], T, R, k));
    expect(round.errors).toEqual({});
    expect(round.bends[0].reliefs[0].some((s) => s.kind === "arc")).toBe(true);
    // Each notch: 2 wide, 1 straight then a half circle of radius 1 (the circle is drawn as short lines, so a touch less).
    expect(area(flatPattern(round).outline)).toBeCloseTo(100 * 50 - 2 * (2 + Math.PI / 2) + flangeArea, 1);
    const tear = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 30, angle: 90, down: false, inset: 10, reliefShape: "tear" }], T, R, k));
    // A thin cut: 0.2 wide, as deep as the sheet is thick.
    expect(area(flatPattern(tear).outline)).toBeCloseTo(100 * 50 - 2 * 0.2 * T + flangeArea, 4);
  });

  it("finds corner reliefs where two flanges meet, unless the corner is closed", () => {
    const right = { id: "r", wall: "base", edge: 1, length: 30, angle: 90, down: false } as const;
    const topEdge = { id: "t", wall: "base", edge: 2, length: 30, angle: 90, down: false } as const;
    expect(foldSheet(spec([right, topEdge])).cornerReliefs).toBeUndefined();
    const f = foldSheet(spec([{ ...right, cornerRelief: "round" }, topEdge]));
    expect(f.cornerReliefs).toHaveLength(1);
    const c = f.cornerReliefs![0];
    expect(c.at).toEqual([100, 50]);
    // The bend's size: radius 2 plus thickness 2.
    expect(c.r).toBe(4);
    expect(c.flanges).toEqual(["r", "t"]);
    expect(foldSheet(spec([{ ...right, cornerRelief: "square", closeCorners: true }, topEdge])).cornerReliefs).toBeUndefined();
    // Shortened at that corner: the bends don't meet, so no relief there.
    expect(foldSheet(spec([{ ...right, cornerRelief: "round", inset: 5 }, topEdge])).cornerReliefs).toBeUndefined();
  });

  it("folds a hem right back over the sheet, lying a small gap above it", () => {
    const T = 2;
    const f = foldSheet(spec([{ id: "h", wall: "base", edge: 1, length: 0, angle: 180, down: false, hem: true, radius: 0.05, straight: 8 }], T, 2, 0.5));
    expect(f.errors).toEqual({});
    const hem = f.walls[1];
    // Folded over the top: its outer (top) face 2 × 0.05 above the sheet's top face, running back 8 mm from the edge.
    close(wallPoint(hem.frame, [0, 0]), [100, 50, 2 * T + 0.1]);
    close(wallPoint(hem.frame, [0, 8]), [92, 50, 2 * T + 0.1]);
    close(wallPoint(hem.frame, [0, 0], T), [100, 50, T + 0.1]);
    // Folded under instead.
    const under = foldSheet(spec([{ id: "h", wall: "base", edge: 1, length: 0, angle: 180, down: true, hem: true, radius: 1, straight: 8 }], T, 2, 0.5));
    expect(under.errors).toEqual({});
    close(wallPoint(under.walls[1].frame, [0, 8]), [92, 50, -2]);
    // Flat: the plate, the fold's allowance and the 8 mm lip.
    const xs = flatPattern(f).outline.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100 + Math.PI * (0.05 + 0.5 * T) + 8, 6);
    // A plain flange can't go to 180°.
    expect(foldSheet(spec([{ id: "x", wall: "base", edge: 1, length: 20, angle: 180, down: false }])).errors.x).toMatch(/less than 180/);
  });

  it("closes the corner where two flanges meet: one laps the other's end, the other butts against it", () => {
    const T = 2;
    const R = 2;
    const k = 0.5;
    const two = [
      { id: "r", wall: "base", edge: 1, length: 30, angle: 90, down: false, closeCorners: true },
      { id: "t", wall: "base", edge: 2, length: 30, angle: 90, down: false },
    ];
    const f = foldSheet(spec(two, T, R, k));
    expect(f.errors).toEqual({});
    const [right, top] = [f.walls[1], f.walls[2]];
    // The right flange runs on past the corner (y = 50) to the top flange's outside face (y = 54)…
    close(wallPoint(right.frame, [-(R + T), 0]), [100 + R + T, 54, T + R]);
    // …and the top flange runs on to the right flange's inside face (x = 102).
    close(wallPoint(top.frame, [100 + R, 0]), [100 + R, 50 + R + T, T + R]);
    // Flat: both tabs add to the walls, not to the bends.
    const allowance = (Math.PI / 2) * (R + k * T);
    expect(area(flatPattern(f).outline)).toBeCloseTo(5000 + 50 * allowance + 26 * 54 + 100 * allowance + 26 * 102, 4);
    expect(flatPattern(f).bendLines).toHaveLength(2);
    // Not asked for, or not square-on (a 45° flange): left open.
    const open = foldSheet(spec(two.map((x) => ({ ...x, closeCorners: false }))));
    expect(open.walls[1].outline[0]).toEqual({ kind: "line", from: [0, 0], to: [50, 0] });
    const tilted = foldSheet(spec([two[0], { ...two[1], angle: 45 }]));
    expect(tilted.walls[1].outline[0]).toEqual({ kind: "line", from: [0, 0], to: [50, 0] });
  });

  it("explains flanges it can't make", () => {
    const f = foldSheet(spec([
      { id: "short", wall: "base", edge: 0, length: 3, angle: 90, down: false },
      { id: "flat", wall: "base", edge: 1, length: 30, angle: 0, down: false },
      { id: "twice", wall: "base", edge: 2, length: 30, angle: 90, down: false },
      { id: "again", wall: "base", edge: 2, length: 30, angle: 90, down: false },
      { id: "lost", wall: "nowhere", edge: 0, length: 30, angle: 90, down: false },
    ]));
    expect(Object.keys(f.errors).sort()).toEqual(["again", "flat", "lost", "short"]);
    expect(f.errors.short).toMatch(/longer than 4.01 mm/);
  });
});

describe("unfolding", () => {
  it("lays each wall down where it sits in the flat pattern, with a strip for each bend", () => {
    const f = foldSheet(spec([
      { id: "r", wall: "base", edge: 1, length: 30, angle: 90, down: false },
      { id: "b", wall: "base", edge: 0, length: 20, angle: 60, down: true },
    ]));
    const { walls, strips } = unfoldMoves(f);
    expect(walls[0].angle).toBeCloseTo(0, 9);
    const flat = flatPattern(f);
    for (const w of f.walls) {
      const m = walls.find((x) => x.id === w.id)!;
      // The turn takes the wall's own directions onto its flat ones.
      const turn = (p: V3): V3 => {
        const q = [p[0] - m.from.origin[0], p[1] - m.from.origin[1], p[2] - m.from.origin[2]] as V3;
        const k = m.axis;
        const c = Math.cos((m.angle * Math.PI) / 180);
        const s = Math.sin((m.angle * Math.PI) / 180);
        const kq = k[0] * q[0] + k[1] * q[1] + k[2] * q[2];
        const kxq: V3 = [k[1] * q[2] - k[2] * q[1], k[2] * q[0] - k[0] * q[2], k[0] * q[1] - k[1] * q[0]];
        return [0, 1, 2].map((i) => q[i] * c + kxq[i] * s + k[i] * kq * (1 - c) + m.to.origin[i]) as V3;
      };
      // A wall corner in 3D lands on its flat place.
      const corner = w.outline[1].kind === "line" ? w.outline[1].to : [0, 0];
      const landed = turn(wallPoint(w.frame, corner as [number, number]));
      const want = flatPoint(w.flat, corner as [number, number]);
      close(landed, [want[0], want[1], 0]);
      // Thickness ends up pointing the same way as the base's.
      close(turn(wallPoint(w.frame, [0, 0], 1)).map((v, i) => v - turn(wallPoint(w.frame, [0, 0]))[i]), [0, 0, 1]);
    }
    expect(strips).toHaveLength(2);
    expect(strips[0].width).toBeCloseTo(flat.bends[0].line ? (Math.PI / 2) * 3 : 0, 6);
    // Right-handed strip frames, lying in the base plane.
    for (const s of strips) {
      const { u, v, n } = s.frame;
      expect(u[0] * v[1] * n[2] + u[1] * v[2] * n[0] + u[2] * v[0] * n[1] - u[2] * v[1] * n[0] - u[1] * v[0] * n[2] - u[0] * v[2] * n[1]).toBeCloseTo(1, 9);
      expect(s.frame.origin[2]).toBeCloseTo(0, 9);
    }
  });
});

describe("tabs", () => {
  it("finds the wall a sketch lies on, moves its shape into the wall, and joins it on", () => {
    const f = foldSheet(spec([{ id: "r", wall: "base", edge: 1, length: 30, angle: 90, down: false }]));
    // The base's top face, sketched facing down: still the base.
    expect(wallOnPlane(f, 2, [5, 5, 2], [0, 0, -1])?.id).toBe("base");
    // The flange's outside face (x = 104).
    expect(wallOnPlane(f, 2, [104, 10, 10], [1, 0, 0])?.id).toBe("r");
    expect(wallOnPlane(f, 2, [5, 5, 7], [0, 0, 1])).toBe(null);
    const moved = mapSegments([{ kind: "line", from: [0, 0], to: [10, 0] }], (p) => [p[0] + 1, -p[1]]);
    expect(moved).toEqual([{ kind: "line", from: [1, -0], to: [11, -0] }]);
    const tab: Segment[] = [
      { kind: "line", from: [10, -20], to: [30, -20] },
      { kind: "line", from: [30, -20], to: [30, 5] },
      { kind: "line", from: [30, 5], to: [10, 5] },
      { kind: "line", from: [10, 5], to: [10, -20] },
    ];
    const withTab = foldSheet({ ...spec([]), tabs: [{ id: "t", wall: "base", outline: tab, holes: [] }] });
    expect(withTab.errors).toEqual({});
    expect(withTab.walls[0].tabs).toHaveLength(1);
    expect(foldSheet({ ...spec([]), tabs: [{ id: "t", wall: "gone", outline: tab, holes: [] }] }).errors.t).toMatch(/can't be found/);
  });

  it("keeps only the outside edges of a flat face made of pieces", () => {
    // Two squares side by side share the line x = 10.
    const sq = (x: number): [P2, P2][] => [
      [[x, 0], [x + 10, 0]],
      [[x + 10, 0], [x + 10, 10]],
      [[x + 10, 10], [x, 10]],
      [[x, 10], [x, 0]],
    ];
    const out = outsideOnly([...sq(0), ...sq(10)]);
    expect(out).toHaveLength(6);
    expect(out.some(([a, b]) => a[0] === 10 && b[0] === 10)).toBe(false);
  });
});
