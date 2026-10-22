/**
 * Sheet metal round 2 (pure logic): bending a flat sheet along a sketched
 * line, jogs (two bends making a step), and mitred corners where flanges or
 * hems on neighbouring edges meet.
 */
import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { resolveParams, visibleParamKeys } from "../src/model/features";
import { bendAllowance, findSheetEdge, flatPattern, foldSheet, jogSpacing, splitWall, unfoldMoves, wallPoint, type FlangeSpec, type Frame3, type P2, type SheetSpec } from "../src/sheetmetal/sheet";
import type { Segment } from "../src/sketch/regions";

const top: Frame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
const plate = (w: number, h: number): Segment[] => [
  { kind: "line", from: [0, 0], to: [w, 0] },
  { kind: "line", from: [w, 0], to: [w, h] },
  { kind: "line", from: [w, h], to: [0, h] },
  { kind: "line", from: [0, h], to: [0, 0] },
];
const spec = (flanges: FlangeSpec[], T = 2, R = 2, k = 0.5, holes: Segment[][] = []): SheetSpec => ({ thickness: T, radius: R, k, base: { frame: top, outer: plate(100, 50), holes }, flanges });
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const area = (pts: P2[]) => pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;
const bounds = (pts: P2[]) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
/** A bend along the line x = 60 (going up the sheet, so the right-hand piece, x > 60, moves). */
const bendAt60 = (extra: Partial<FlangeSpec> = {}): FlangeSpec => ({ id: "b:0", wall: "base", edge: -1, length: 0, angle: 90, down: false, line: { from: [60, -10], to: [60, 70] }, ...extra });

describe("bend along a line", () => {
  it("cuts the wall in two and stands the moving piece up, the line in the middle of the bend", () => {
    const f = foldSheet(spec([bendAt60()]));
    expect(f.errors).toEqual({});
    const a = bendAllowance(90, 2, 2, 0.5);
    expect(a).toBeCloseTo((Math.PI / 2) * 3, 12);
    // The fixed piece ends half the bend before the line.
    expect(bounds(f.walls[0].outline.map((s) => (s as { from: P2 }).from))).toEqual([0, 0, 60 - a / 2, 50]);
    // The moving piece stands up: its outside face at x = 60 − a/2 + R + T, rising to 40 − a/2 above the bend's top (z = T + R).
    const up = f.walls[1];
    close(wallPoint(up.frame, [0, 0]), [60 - a / 2 + 4, 50, 4]);
    const tip = Math.max(...up.outline.map((s) => (s as { from: P2 }).from[1]));
    expect(tip).toBeCloseTo(40 - a / 2, 9);
    close(wallPoint(up.frame, [50, tip]), [60 - a / 2 + 4, 0, 4 + 40 - a / 2]);
    // The flat pattern is the plate as drawn, with the bend line on the sketched line.
    const flat = flatPattern(f);
    close(bounds(flat.outline), [0, 0, 100, 50], 9);
    expect(area(flat.outline)).toBeCloseTo(5000, 6);
    expect(flat.bends).toHaveLength(1);
    close([...flat.bends[0].line[0], ...flat.bends[0].line[1]], [60, 0, 60, 50], 9);
    expect(flat.bends[0].angle).toBe(90);
  });

  it("bends down, at any angle and radius; the walls lay back down flat where they were drawn", () => {
    const f = foldSheet(spec([bendAt60({ angle: 45, down: true, radius: 5 })], 2, 2, 0.45));
    expect(f.errors).toEqual({});
    const a = bendAllowance(45, 5, 2, 0.45);
    // Heading on (+x) and down at 45°.
    const w = f.walls[1];
    const d = [w.frame.v[0], w.frame.v[2]];
    close(d, [Math.SQRT1_2, -Math.SQRT1_2]);
    close(bounds(flatPattern(f).outline), [0, 0, 100, 50], 9);
    // Laid flat, the moving piece's far corner goes back to (100, 50).
    const move = unfoldMoves(f).walls.find((m) => m.id === w.id)!;
    const corner = w.outline.map((s) => (s as { from: P2 }).from).find((p) => Math.abs(p[1] - (40 - a / 2)) < 1e-9 && Math.abs(p[0]) < 1e-9)!;
    const flatAt = [move.to.origin[0] + move.to.u[0] * corner[0] + move.to.v[0] * corner[1], move.to.origin[1] + move.to.u[1] * corner[0] + move.to.v[1] * corner[1]];
    close(flatAt, [100, 50], 9);
  });

  it("knows where the moving piece's material goes (for cuts already made in it)", () => {
    const f = foldSheet(spec([bendAt60()]));
    const bend = f.bends[0];
    const a = bendAllowance(90, 2, 2, 0.5);
    // A point of the flat plate at (80, 10), on the moving side, ends up on the standing wall 20 − a/2 above the bend.
    const m = bend.moved!;
    const p = [m.origin[0] + m.u[0] * 80 + m.v[0] * 10, m.origin[1] + m.u[1] * 80 + m.v[1] * 10, m.origin[2] + m.u[2] * 80 + m.v[2] * 10];
    close(p, [60 - a / 2 + 4, 10, 4 + 20 - a / 2]);
    close(m.n, [-1, 0, 0]);
  });

  it("splits holes between the pieces, and refuses one the bend runs through", () => {
    const hole = (x: number): Segment[] => [{ kind: "circle", center: [x, 25], radius: 5 }];
    const f = foldSheet(spec([bendAt60()], 2, 2, 0.5, [hole(20), hole(85)]));
    expect(f.errors).toEqual({});
    expect(f.walls[0].holes).toHaveLength(1);
    expect(f.walls[1].holes).toHaveLength(1);
    // The flat pattern keeps both where they were drawn.
    const flat = flatPattern(f);
    expect(flat.holes.map((h) => Math.round(bounds(h)[0]))).toEqual([15, 80]);
    expect(foldSheet(spec([bendAt60()], 2, 2, 0.5, [hole(63)])).errors["b:0"]).toMatch(/hole in the sheet crosses the bend/);
  });

  it("explains lines it can't bend along", () => {
    const err = (line: { from: P2; to: P2 }) => foldSheet(spec([bendAt60({ line })])).errors["b:0"];
    expect(err({ from: [40, -10], to: [60, 60] })).toMatch(/square/);
    expect(err({ from: [120, 0], to: [120, 50] })).toMatch(/doesn't cross this wall/);
    // Too close to the plate's end: the bend would run into its corners.
    expect(err({ from: [99, 0], to: [99, 50] })).toMatch(/runs into a corner/);
    expect(foldSheet(spec([bendAt60({ angle: 180 })])).errors["b:0"]).toMatch(/more than 0° and less than 180°/);
    // A flange on an edge the line crosses, or on the side that would move.
    expect(foldSheet(spec([{ id: "f", wall: "base", edge: 2, length: 10, angle: 90, down: false }, bendAt60()])).errors["b:0"]).toMatch(/crosses an edge that already has a flange/);
    expect(foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 10, angle: 90, down: false }, bendAt60()])).errors["b:0"]).toMatch(/on the side that would move/);
  });

  it("bends a wall that already has a flange on the side that stays, renumbering its edges", () => {
    // A flange off the left edge (x = 0), then a bend at x = 60.
    const f = foldSheet(spec([{ id: "f", wall: "base", edge: 3, length: 10, angle: 90, down: false }, bendAt60()]));
    expect(f.errors).toEqual({});
    const fb = f.bends.find((b) => b.flangeId === "f")!;
    // Its edge is still the left one, under its new number.
    expect(f.walls[0].outline[fb.edge]).toEqual({ kind: "line", from: [0, 50], to: [0, 0] });
    const a = bendAllowance(90, 2, 2, 0.5);
    const flat = flatPattern(f);
    close(bounds(flat.outline), [-(a + 6), 0, 100, 50], 9);
    expect(area(flat.outline)).toBeCloseTo(5000 + 50 * (a + 6), 6);
  });

  it("splitWall: keeps a flange wall's bend edge first, and refuses to move it", () => {
    // Across a flange wall (edge 0 along its bend at y = 0), going −x so the far side (y > 25) moves.
    const r = splitWall(plate(100, 50), [], [100, 25], [-1, 0], 2, true);
    if (typeof r === "string") throw new Error(r);
    expect(r.fixed).toEqual([
      { kind: "line", from: [0, 0], to: [100, 0] },
      { kind: "line", from: [100, 0], to: [100, 23] },
      { kind: "line", from: [100, 23], to: [0, 23] },
      { kind: "line", from: [0, 23], to: [0, 0] },
    ]);
    expect(r.fixedEdge).toBe(2);
    expect(r.moving[0]).toEqual({ kind: "line", from: [0, 27], to: [100, 27] });
    // The other way round, edge 0 would move; and a line across edge 0 can't be bent either.
    expect(splitWall(plate(100, 50), [], [100, 25], [1, 0], 2, true)).toMatch(/has to stay still/);
    expect(splitWall(plate(100, 50), [], [40, 0], [0, 1], 2, true)).toMatch(/has to stay still/);
  });

  it("flanges can go on both pieces afterwards, and on the new edges", () => {
    const f0 = foldSheet(spec([bendAt60()]));
    // The standing piece's tip, picked on the folded part.
    const up = f0.walls[1];
    const tipEdge = up.outline.findIndex((s) => s.kind === "line" && Math.abs(s.from[1] - s.to[1]) < 1e-9 && s.from[1] > 1);
    const s = up.outline[tipEdge] as { from: P2; to: P2 };
    expect(findSheetEdge(f0, 2, wallPoint(up.frame, s.from), wallPoint(up.frame, s.to))).toEqual({ wall: "b:0", edge: tipEdge });
    const f = foldSheet(spec([bendAt60(), { id: "f", wall: "b:0", edge: tipEdge, length: 10, angle: 90, down: false }, { id: "g", wall: "base", edge: 0, length: 10, angle: 90, down: false }]));
    expect(f.errors).toEqual({});
    const a = bendAllowance(90, 2, 2, 0.5);
    // Flat: the plate, the strip and the tip flange (6 straight after its bend) off x = 100, the other flange off y = 0.
    const flat = flatPattern(f);
    close(bounds(flat.outline), [0, -(a + 6), 100 + a + 6, 50], 9);
    expect(area(flat.outline)).toBeCloseTo(5000 + 50 * (a + 6) + (60 - a / 2) * (a + 6), 6);
  });
});

describe("jog", () => {
  const jog = (height: number, angle = 90, down = false, R = 2, T = 2, k = 0.5): SheetSpec => {
    const s = jogSpacing(height, angle, R, T, k);
    if (typeof s === "string") throw new Error(s);
    return spec([bendAt60({ angle, down }), { id: "b:1", wall: "b:0", edge: -1, length: 0, angle, down: !down, line: { from: [1, s], to: [0, s] } }], T, R, k);
  };

  it("works out where the second bend goes for the step's height", () => {
    const a = bendAllowance(90, 2, 2, 0.5);
    // Two 90° bends rise T + 2R = 6 with nothing between them: a 10 mm step has 4 mm straight between.
    expect(jogSpacing(10, 90, 2, 2, 0.5)).toBeCloseTo(4 + a / 2, 12);
    expect(jogSpacing(6, 90, 2, 2, 0.5)).toMatch(/more than 6.01 mm/);
    expect(jogSpacing(10, 0, 2, 2, 0.5)).toMatch(/more than 0°/);
  });

  it("steps the sheet up (or down) by the height, staying flat and parallel; the flat pattern keeps its size", () => {
    for (const [angle, down] of [[90, false], [90, true], [60, false], [45, true]] as const) {
      const f = foldSheet(jog(10, angle, down));
      expect(f.errors).toEqual({});
      const last = f.walls[2];
      close(last.frame.n, [0, 0, 1]);
      // Its underside is 10 above (or below) the plate's.
      expect(wallPoint(last.frame, [0, 0])[2]).toBeCloseTo(down ? -10 : 10, 9);
      const flat = flatPattern(f);
      close(bounds(flat.outline), [0, 0, 100, 50], 9);
      expect(area(flat.outline)).toBeCloseTo(5000, 6);
      expect(flat.bends).toHaveLength(2);
    }
    // At 90°: the bend lines are the sketched line and 4 + a (the straight between, and half of each bend) past it.
    const a = bendAllowance(90, 2, 2, 0.5);
    const flat = flatPattern(foldSheet(jog(10)));
    expect(flat.bends[1].line[0][0]).toBeCloseTo(64 + a, 9);
    // The stepped piece's far end: the plate's 100, less the two bends' allowances, plus their footprints
    // (R + T = 4 out to the riser's outside face, then R = 2 round the second bend's inside).
    const f = foldSheet(jog(10));
    const last = f.walls[2];
    const far = Math.max(...last.outline.map((s) => (s as { from: P2 }).from[1]));
    expect(far).toBeCloseTo(36 - 1.5 * a, 9);
    expect(wallPoint(last.frame, [0, far])[0]).toBeCloseTo(100 - 2 * a + 4 + 2 - 4, 9);
  });
});

describe("mitred corners", () => {
  const hem = (id: string, edge: number, mitre?: number): FlangeSpec => ({ id, wall: "base", edge, length: 0, angle: 180, down: false, hem: true, radius: 0.05, straight: 8, ...(mitre !== undefined ? { mitre } : {}) });
  const hems = (mitre?: number) => foldSheet(spec([0, 1, 2, 3].map((e) => hem(`h${e}`, e, mitre)), 2, 2, 0.5));
  const outlineArea = (segs: Segment[]) => area(segs.map((s) => (s as { from: P2 }).from));

  it("leaves hems that meet alone unless asked (saved designs stay the same)", () => {
    const f = hems();
    expect(f.mitres).toBeUndefined();
    expect(f.walls.slice(1).map((w) => outlineArea(w.outline))).toEqual([800, 400, 800, 400]);
  });

  it("trims hems on all four edges along each corner's diagonal, the gap apart", () => {
    const f = hems(0.2);
    expect(f.errors).toEqual({});
    expect(f.mitres).toHaveLength(4);
    // Each end loses the triangle past the diagonal and half the gap: ∫₀⁸ (c + y) dy with c = 0.1·√2.
    const c = 0.1 * Math.SQRT2;
    const cut = 8 * c + 32;
    const areas = f.walls.slice(1).map((w) => outlineArea(w.outline));
    [800, 400, 800, 400].forEach((full, i) => expect(areas[i]).toBeCloseTo(full - 2 * cut, 9));
    // Edge 0 (along the bend) stays first and on the bend line, now short of the corners.
    const bottom = f.walls[1].outline[0] as { from: P2; to: P2 };
    expect(bottom.from[1]).toBeCloseTo(0, 12);
    expect(bottom.to[1]).toBeCloseTo(0, 12);
    expect(bottom.from[0]).toBeCloseTo(c, 9);
    expect(bottom.to[0]).toBeCloseTo(100 - c, 9);
    // Neighbours are gap apart along the diagonal: the bottom hem's trimmed edge and the right hem's are parallel lines 0.2 apart.
    // The flat pattern: plate + four strips + the trimmed hems.
    const a = bendAllowance(180, 0.05, 2, 0.5);
    expect(area(flatPattern(f).outline)).toBeCloseTo(5000 + 300 * a + 2400 - 8 * cut, 6);
  });

  it("mitres with no gap just meet (only one of the two needs to ask)", () => {
    const f = foldSheet(spec([hem("h0", 0, 0), hem("h1", 1)], 2, 2, 0.5));
    expect(f.mitres).toEqual([{ flanges: ["h0", "h1"], walls: ["h0", "h1"] }]);
    // One corner each: the triangle past the diagonal, ∫₀⁸ y dy = 32.
    const areas = f.walls.slice(1).map((w) => outlineArea(w.outline));
    expect(areas[0]).toBeCloseTo(800 - 32, 9);
    expect(areas[1]).toBeCloseTo(400 - 32, 9);
  });

  it("trims as soon as both are bent, so a flange on a mitred flange's tip runs the trimmed length", () => {
    const fl = (id: string, edge: number): FlangeSpec => ({ id, wall: "base", edge, length: 20, angle: 120, down: false, mitre: 0.2 });
    const f0 = foldSheet(spec([fl("a", 0), fl("b", 1)]));
    const trimmed = f0.walls[1].outline.map((s) => s.kind === "line" ? s : null);
    const tip = trimmed.findIndex((s) => s && Math.abs(s.from[1] - f0.bends[0].straight) < 1e-9 && Math.abs(s.to[1] - f0.bends[0].straight) < 1e-9);
    expect(tip).toBeGreaterThan(0);
    const tipLen = Math.abs(trimmed[tip]!.to[0] - trimmed[tip]!.from[0]);
    expect(tipLen).toBeLessThan(99);
    const f = foldSheet(spec([fl("a", 0), fl("b", 1), { id: "lip", wall: "a", edge: tip, length: 8, angle: 90, down: false }]));
    expect(f.errors).toEqual({});
    expect(f.walls[1].outline).toEqual(f0.walls[1].outline);
    expect(f.bends.find((b) => b.flangeId === "lip")!.length).toBeCloseTo(tipLen, 12);
  });

  it("leaves a flange up and one down alone", () => {
    const f = foldSheet(spec([{ id: "a", wall: "base", edge: 0, length: 20, angle: 120, down: false, mitre: 0.2 }, { id: "b", wall: "base", edge: 1, length: 20, angle: 120, down: true, mitre: 0.2 }]));
    expect(f.mitres).toBeUndefined();
  });

  it("trims flanges leaning in over the sheet, but not right-angle ones (they don't meet)", () => {
    const fl = (id: string, edge: number, angle: number): FlangeSpec => ({ id, wall: "base", edge, length: 20, angle, down: false, mitre: 0.2 });
    const square = foldSheet(spec([fl("a", 0, 90), fl("b", 1, 90)]));
    expect(square.walls.slice(1).map((w) => outlineArea(w.outline))).toEqual([100 * 16, 50 * 16]);
    const steep = foldSheet(spec([fl("a", 0, 120), fl("b", 1, 120)]));
    expect(steep.errors).toEqual({});
    const [wa, wb] = steep.walls.slice(1);
    expect(outlineArea(wa.outline)).toBeLessThan(100 * steep.bends[0].straight - 1);
    expect(outlineArea(wb.outline)).toBeLessThan(50 * steep.bends[1].straight - 1);
    // No corner of either wall (on either face) crosses the plane through the corner (100, 0) halfway between the edges, within half the gap.
    const side = (p: number[]) => (100 - p[0] - p[1]) / Math.SQRT2;
    for (const h of [0, 2]) {
      for (const s of wa.outline) expect(side(wallPoint(wa.frame, (s as { from: P2 }).from, h))).toBeGreaterThan(0.1 - 1e-9);
      for (const s of wb.outline) expect(side(wallPoint(wb.frame, (s as { from: P2 }).from, h))).toBeLessThan(-0.1 + 1e-9);
    }
  });
});

describe("saving", () => {
  it("keeps Bend, Jog and mitre settings when a design is saved and opened; old flanges and hems open as before", () => {
    let doc = emptyDocument();
    const sk = { ...createFeature(doc, "sketch"), id: "sk" };
    doc = addFeature(doc, sk);
    const b = { ...createFeature(doc, "bend"), id: "b", flipSide: true, keepOtherSide: true };
    expect(b.sketchRef).toBe("sk");
    const j = { ...createFeature(doc, "jog"), id: "j", params: { ...createFeature(doc, "jog").params, height: "12" } };
    const h = { ...createFeature(doc, "hem"), id: "h", mitreCorners: true };
    doc = [b, j, h].reduce(addFeature, doc);
    const back = parseDocument(JSON.parse(JSON.stringify(doc)))!;
    const [, b2, j2, h2] = back.features;
    expect([b2.type, b2.sketchRef, b2.flipSide, b2.keepOtherSide]).toEqual(["bend", "sk", true, true]);
    expect([j2.type, j2.sketchRef, resolveParams(j2).values.height, resolveParams(j2).values.angle]).toEqual(["jog", "sk", 12, 90]);
    expect(h2.mitreCorners).toBe(true);
    expect(resolveParams(h2).values.cornerGap).toBe(0.2);
    // A hem saved before mitres existed: no gap box shown, nothing mitred.
    const old = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [{ id: "o", name: "Hem 1", type: "hem", operation: "add", suppressed: false, params: { length: "8", gap: "0", inset: "0" }, picks: [] }] })))!;
    expect(old.features[0].mitreCorners).toBeUndefined();
    expect(visibleParamKeys(old.features[0]).has("cornerGap")).toBe(false);
    expect(visibleParamKeys(h2).has("cornerGap")).toBe(true);
  });

  it("doesn't check boxes that are hidden", () => {
    const doc = emptyDocument();
    const ex = { ...createFeature(doc, "extendSurface"), extendTo: { mode: "face" as const } };
    expect(resolveParams({ ...ex, params: { ...ex.params, distance: "oops" } }).errors).toEqual({});
    const hem = createFeature(doc, "hem");
    expect(resolveParams({ ...hem, params: { ...hem.params, cornerGap: "0" } }).errors).toEqual({});
    expect(resolveParams({ ...hem, mitreCorners: true, params: { ...hem.params, cornerGap: "0" } }).errors.cornerGap).toMatch(/more than 0/);
  });

  it("keeps Extend surface's “up to” choice; old ones extend by a distance", () => {
    const doc = emptyDocument();
    const ex = { ...createFeature(doc, "extendSurface"), id: "ex", extendTo: { mode: "part" as const } };
    const back = parseDocument(JSON.parse(JSON.stringify(addFeature(doc, ex))))!.features[0];
    expect(back.extendTo).toEqual({ mode: "part" });
    expect(visibleParamKeys(back).has("distance")).toBe(false);
    const odd = parseDocument(JSON.parse(JSON.stringify(addFeature(doc, { ...ex, extendTo: { mode: "sideways" } as never }))))!.features[0];
    expect(odd.extendTo).toBeUndefined();
    expect(visibleParamKeys(odd).has("distance")).toBe(true);
  });
});
