/**
 * Paths and roads smoothed to what prints (pure): wiggles under the nozzle dropped, zigzags and hairpins whose legs lie
 * closer than two groove widths folded away, no bend tighter than a groove width, the ends where they were, real loops
 * kept, the course kept; the same answer every time; way ids kept so picked-off paths stay off. And the channels cut
 * into a triangle (grooveCut.ts): cells that never straddle an edge, depths exact at their corners.
 */
import { describe, expect, it } from "vitest";
import { FOLD, LEAST_RADIUS, NOISE, roundBends, smoothedFeatures, smoothLine } from "../src/terrain/smoothLines";
import { cutGrooves, cutTriangle, grooveDepth, GrooveIndex } from "../src/terrain/grooveCut";
import { distanceToLine, isDropped, withoutDropped } from "../src/terrain/pickMarks";
import { lineLength, type MapFeatures } from "../src/terrain/osm";
import { meshCheck } from "../src/terrain/colour";

type XY = [number, number];
const W = 0.6;

/** The tightest bend along a line (mm radius), from each point's two neighbours. */
function tightest(pts: XY[]): number {
  let r = Infinity;
  for (let i = 1; i + 1 < pts.length; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const [ux, uy, vx, vy] = [b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]];
    const turn = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
    if (turn > 1e-6) r = Math.min(r, (Math.hypot(ux, uy) + Math.hypot(vx, vy)) / 2 / turn);
  }
  return r;
}

/** Points of a line that come back within `near` of an earlier point at least `gap` further along it. */
function folds(pts: XY[], near: number, gap: number): number {
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  let n = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (along[j] - along[i] > gap && Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) < near) n++;
  return n;
}

describe("smoothing paths and roads", () => {
  it("drops wiggles under the nozzle and keeps a straight line straight", () => {
    const jitter: XY[] = Array.from({ length: 101 }, (_, i) => [i * 0.2, i % 2 ? 0.04 : -0.04]);
    const s = smoothLine(jitter, W);
    expect(s[0]).toEqual(jitter[0]);
    expect(s[s.length - 1]).toEqual(jitter[100]);
    for (const p of s) expect(Math.abs(p[1])).toBeLessThanOrEqual(NOISE);
    expect(s.length).toBeLessThan(10);
  });

  it("folds a tight zigzag into one line no wider than the groove", () => {
    const zig: XY[] = Array.from({ length: 41 }, (_, i) => [i * 0.4, i % 2 ? 0.25 : -0.25]);
    const s = smoothLine(zig, W);
    expect(tightest(s)).toBeGreaterThan(LEAST_RADIUS * W * 0.95);
    // It still runs the zigzag's way, end to end.
    expect(s[0]).toEqual(zig[0]);
    expect(s[s.length - 1]).toEqual(zig[40]);
    for (const p of s) expect(Math.abs(p[1])).toBeLessThan(0.26);
  });

  it("takes hairpins up a slope straight up: no two legs closer than two widths", () => {
    const pts: XY[] = [[0, 0]];
    for (let k = 0; k < 8; k++) {
      const x = k % 2 ? 0 : 3;
      pts.push([x, k * 0.7], [x, (k + 1) * 0.7]);
    }
    const s = smoothLine(pts, W);
    expect(folds(s, FOLD * W * 0.98, 2 * FOLD * W)).toBe(0);
    expect(tightest(s)).toBeGreaterThan(LEAST_RADIUS * W * 0.95);
    expect(s[s.length - 1]).toEqual(pts[pts.length - 1]);
    // Much shorter than the switchbacks, but still from bottom to top.
    expect(lineLength(s)).toBeLessThan(lineLength(pts) / 3);
  });

  it("keeps real loops and gentle bends as they were", () => {
    const loop: XY[] = Array.from({ length: 121 }, (_, i) => [10 * Math.cos((i / 120) * 2 * Math.PI), 10 * Math.sin((i / 120) * 2 * Math.PI)]);
    const s = smoothLine(loop, W);
    for (const p of loop) expect(distanceToLine(p, s)).toBeLessThanOrEqual(NOISE);
    const bend: XY[] = Array.from({ length: 61 }, (_, i) => [i * 0.5, 4 * Math.sin(i / 10)]);
    const b = smoothLine(bend, W);
    for (const p of bend) expect(distanceToLine(p, b)).toBeLessThanOrEqual(NOISE);
  });

  it("rounds a sharp corner to the least radius, near the corner only", () => {
    const corner: XY[] = [[0, 0], [5, 0], [5, 5]];
    const r = roundBends(
      Array.from({ length: 41 }, (_, i): XY => (i <= 20 ? [i * 0.25, 0] : [5, (i - 20) * 0.25])),
      W,
      0.15,
    );
    expect(tightest(r)).toBeGreaterThan(W * 0.95);
    expect(distanceToLine([2, 0], r)).toBeLessThan(1e-9);
    expect(distanceToLine([5, 3], r)).toBeLessThan(1e-9);
    expect(distanceToLine(corner[1], r)).toBeLessThan(0.6);
  });

  it("smooths features at a scale once (the same object again), keeping ids, names and water", () => {
    const k = 0.05;
    const zig: XY[] = Array.from({ length: 61 }, (_, i) => [300000 + i * 8, 700000 + (i % 2 ? 5 : -5)]);
    const river: XY[] = zig.map(([e, n]) => [e, n + 500]);
    const f: MapFeatures = {
      lines: [
        { kind: "path", pts: zig, thin: true, ids: ["11", "12"], name: "Pony Track" },
        { kind: "river", pts: river },
      ],
      shapes: [],
      names: [],
    };
    const s = smoothedFeatures(f, k);
    expect(smoothedFeatures(f, k)).toBe(s);
    expect(s.lines[0].ids).toEqual(["11", "12"]);
    expect(s.lines[0].name).toBe("Pony Track");
    expect(s.lines[0].thin).toBe(true);
    expect(tightest(s.lines[0].pts.map(([e, n]): XY => [e * k, n * k]))).toBeGreaterThan(W * 0.95);
    expect(s.lines[1]).toBe(f.lines[1]);
    expect(isDropped(s.lines[0], new Set(["11", "12"]))).toBe(true);
    expect(withoutDropped(s, new Set(["11"])).lines.length).toBe(1);
    // Nothing to smooth: the same object.
    const water: MapFeatures = { lines: [{ kind: "river", pts: river }], shapes: [], names: [] };
    expect(smoothedFeatures(water, k)).toBe(water);
    // The same answer every time.
    expect(JSON.stringify(smoothedFeatures({ ...f }, k))).toBe(JSON.stringify(s));
  });
});

describe("channels cut into the ground", () => {
  const line = { kind: "path" as const, pts: [[0, 1], [4, 1.3]] as XY[], hw: 0.3, flat: 0.2, depth: 0.4 };
  const index = new GrooveIndex([line]);

  it("splits a triangle into cells that never straddle the channel's edges", () => {
    const corners: XY[] = [[1, 0], [3, 0], [2, 2.5]];
    const cells = cutTriangle(corners, index.cutsNear(1, 0, 3, 2.5));
    expect(cells.length).toBeGreaterThan(4);
    let area = 0;
    for (const cell of cells) {
      let a = 0;
      for (let i = 0; i < cell.length; i++) {
        const [p, q] = [cell[i], cell[(i + 1) % cell.length]];
        a += p.x * q.y - q.x * p.y;
      }
      area += a / 2;
      // A cell's corners are all on one side of the flat bottom's edge and of the channel's edge.
      const rs = cell.map((p) => distanceToLine([p.x, p.y], line.pts));
      for (const edge of [line.flat, line.hw]) expect(rs.every((r) => r <= edge + 1e-6) || rs.every((r) => r >= edge - 1e-6)).toBe(true);
    }
    expect(area).toBeCloseTo(2.5, 9);
  });

  it("cuts a closed block's top into a channel of the right depth, still closed", () => {
    // A 4 × 2.6 block, 2 high, its top as two triangles.
    const v = [0, 0, 2, 4, 0, 2, 4, 2.6, 2, 0, 2.6, 2, 0, 0, 0, 4, 0, 0, 4, 2.6, 0, 0, 2.6, 0];
    const t = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
    const before = meshCheck(v, t);
    expect(before.open).toBe(0);
    const height = (x: number, y: number) => 2 - index.depthAt(x, y);
    const cut = cutGrooves({ vertices: v, triangles: t }, index, () => 2, height)!;
    expect(cut).not.toBeNull();
    const after = meshCheck(cut.vertices, cut.triangles);
    expect(after.open).toBe(0);
    // Volume less the channel across the block: (2 · flat + (hw − flat)) · depth per mm, over 4 mm of a slanted line.
    const len = Math.hypot(4, 0.3);
    const lost = (2 * line.flat + (line.hw - line.flat)) * line.depth * len * (4 / len);
    expect(before.volume - after.volume).toBeCloseTo(lost, 2);
    // Every corner on top is exactly as deep as the channel there.
    for (let i = 0; i < cut.vertices.length; i += 3)
      if (cut.vertices[i + 2] > 1) expect(cut.vertices[i + 2]).toBeCloseTo(height(cut.vertices[i], cut.vertices[i + 1]), 12);
    expect(grooveDepth(0.25, 0.3, 0.2, 0.4)).toBeCloseTo(0.2, 12);
    // Far from any line: nothing to do.
    expect(cutGrooves({ vertices: v.map((c, i) => (i % 3 === 0 ? c + 50 : c)), triangles: t }, index, () => 2, height)).toBeNull();
  });

  it("knows which line a point is on, roads first", () => {
    const both = new GrooveIndex([line, { kind: "road", pts: [[2, -1], [2, 3]], hw: 0.3, flat: 0.2, depth: 0.4 }]);
    expect(both.kindAt(1, 1.07)).toBe("path");
    expect(both.kindAt(2, 1.15)).toBe("road");
    expect(both.kindAt(1, 2)).toBeNull();
  });
});
