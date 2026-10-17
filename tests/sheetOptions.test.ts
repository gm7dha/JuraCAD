import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { chainLoops, flatPattern, foldSheet, type Frame3, type SheetSpec } from "../src/sheetmetal/sheet";
import type { Segment } from "../src/sketch/regions";

const top: Frame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
const plate = (w: number, h: number): Segment[] => [
  { kind: "line", from: [0, 0], to: [w, 0] },
  { kind: "line", from: [w, 0], to: [w, h] },
  { kind: "line", from: [w, h], to: [0, h] },
  { kind: "line", from: [0, h], to: [0, 0] },
];
const spec = (flanges: SheetSpec["flanges"], T = 2, R = 2, k = 0.5): SheetSpec => ({ thickness: T, radius: R, k, base: { frame: top, outer: plate(100, 50), holes: [] }, flanges });
const size = (pts: [number, number][]) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
};

describe("flange position", () => {
  it("cuts the wall back so the flange's outside (or inside) face lines up with the edge", () => {
    // Outside flush at 90°: cut back by radius + thickness (4), so the flange's outside face is at x = 100.
    const out = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 20, angle: 90, down: false, position: "outside" }]));
    expect(out.errors).toEqual({});
    expect(out.walls[0].outline[1]).toEqual({ kind: "line", from: [96, 0], to: [96, 50] });
    expect(out.trims).toHaveLength(1);
    // The flange wall's outside face (its 0 side) is the plane x = 100.
    const w = out.walls[1];
    expect(w.frame.origin[0] + 0).toBeCloseTo(100, 9);
    expect(w.frame.n[0]).toBeCloseTo(-1, 9);
    // Inside flush: cut back by the radius (2); the inside face at x = 100.
    const inside = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 20, angle: 90, down: false, position: "inside" }]));
    expect(inside.walls[0].outline[1]).toEqual({ kind: "line", from: [98, 0], to: [98, 50] });
    expect(inside.walls[1].frame.origin[0] - 2).toBeCloseTo(100, 9);
    // At 60° the cut back is (radius + thickness) × tan 30°.
    const sixty = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 20, angle: 60, down: false, position: "outside" }]));
    const seg = sixty.walls[0].outline[1];
    expect(seg.kind === "line" && seg.from[0]).toBeCloseTo(100 - 4 * Math.tan(Math.PI / 6), 9);
  });

  it("keeps a box's outside size with flanges flush all round, in the flat pattern too", () => {
    const flanges: SheetSpec["flanges"] = [0, 1, 2, 3].map((edge) => ({ id: `f${edge}`, wall: "base", edge, length: 20, angle: 90, down: false, position: "outside" as const }));
    const f = foldSheet(spec(flanges));
    expect(f.errors).toEqual({});
    // The base is 92 × 42; each flange is as long as its cut-back edge.
    expect(size(f.walls[0].outline.map((s) => (s.kind === "line" ? s.from : [0, 0])))).toEqual([92, 42]);
    expect(f.bends.map((b) => b.length)).toEqual([92, 42, 92, 42]);
    // Flat: 92 + 2 × (bend allowance π/2 × (2 + 0.5 × 2) + 16 straight).
    const flat = flatPattern(f);
    const allowance = (Math.PI / 2) * 3;
    const [w, h] = size(flat.outline);
    expect(w).toBeCloseTo(92 + 2 * (allowance + 16), 9);
    expect(h).toBeCloseTo(42 + 2 * (allowance + 16), 9);
  });

  it("explains when it can't sit flush", () => {
    // Next to an arc.
    const rounded: Segment[] = [
      { kind: "line", from: [0, 0], to: [90, 0] },
      { kind: "arc", from: [90, 0], mid: [97.07, 2.93], to: [100, 10] },
      { kind: "line", from: [100, 10], to: [100, 50] },
      { kind: "line", from: [100, 50], to: [0, 50] },
      { kind: "line", from: [0, 50], to: [0, 0] },
    ];
    const s: SheetSpec = { ...spec([{ id: "f", wall: "base", edge: 2, length: 20, angle: 90, down: false, position: "outside" }]), base: { frame: top, outer: rounded, holes: [] } };
    expect(foldSheet(s).errors.f).toMatch(/either side of it must be straight/);
    // On a flange's side.
    const side = foldSheet(spec([
      { id: "a", wall: "base", edge: 1, length: 20, angle: 90, down: false },
      { id: "b", wall: "a", edge: 1, length: 10, angle: 90, down: false, position: "outside" },
    ]));
    expect(side.errors.b).toMatch(/side of another flange/);
    // A wall too narrow to cut back.
    const thin: SheetSpec = { ...spec([{ id: "f", wall: "base", edge: 1, length: 20, angle: 90, down: false, position: "outside" }]), base: { frame: top, outer: plate(3, 50), holes: [] } };
    expect(foldSheet(thin).errors.f).toMatch(/too small to cut back 4 mm/);
  });
});

describe("chaining line pieces into loops", () => {
  it("joins pieces end to end, either way round, and drops loose ends", () => {
    const loops = chainLoops([
      [[0, 0], [1, 0]],
      [[1, 1], [1, 0]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
      [[5, 5], [6, 6]],
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });
});

describe("saving the new options", () => {
  it("keeps them when a design is saved and opened, and old files still open", () => {
    let doc = emptyDocument();
    const fl = { ...createFeature(doc, "flange"), flangePosition: "outside" as const };
    doc = addFeature(doc, fl);
    const back = parseDocument(JSON.parse(JSON.stringify(doc)))!;
    expect(back.features[0].flangePosition).toBe("outside");
    const odd = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [{ ...fl, flangePosition: "sideways" }] })))!;
    expect(odd.features[0].flangePosition).toBeUndefined();
  });
});
