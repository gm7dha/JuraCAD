/**
 * Drawing features checked against real geometry (the OpenCascade engine):
 * arc lengths and chamfer callouts on a part's real views, a long hole table
 * from a plate's real holes, and a second sheet's views.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Dimension, Drawing, Feature, FeatureType, Operation } from "../src/model/types";
import { addDrawing, putDimension } from "../src/drawing/drawing";
import { arcOf, chamferSize, dimPoint, measureDim, resolveDim } from "../src/drawing/dimensions";
import { holeRows } from "../src/drawing/holeTable";
import { addPage, changePage, pageOf } from "../src/drawing/pages";
import { addSection, sectionRequests } from "../src/drawing/sections";
import { layoutSheet, scaleView, viewClear, type Projections } from "../src/drawing/sheet";
import { emptyDocument } from "../src/model/document";

beforeAll(async () => {
  setOC(await opencascade());
});

let n = 0;
function feature(type: FeatureType, params: Record<string, string | number>, operation: Operation = "new"): Feature {
  n++;
  return {
    id: `f${n}`,
    name: `${type} ${n}`,
    type,
    operation,
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}
let engine: GeometryEngine;
afterEach(() => engine?.dispose());
const build = (features: Feature[]) => {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
};
/** The edge of the first part whose middle is nearest `at`. */
function edgeAt(r: ReturnType<typeof build>, at: [number, number, number]): TopoPick {
  const part = r.parts[0];
  const best = [...part.edgeRefs].sort((p, q) => Math.hypot(...(p as { mid: number[] }).mid.map((v, i) => v - at[i])) - Math.hypot(...(q as { mid: number[] }).mid.map((v, i) => v - at[i])))[0];
  return { partId: part.id, ref: best };
}
const info = { designName: "D", subject: "S", date: "1/1/2026" };
const newDrawing = (): Drawing => addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
const texts = (l: ReturnType<typeof layoutSheet>) => l.prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));

describe("drawing dimensions on real views", () => {
  it("measures a real fillet's arc length and labels a real chamfer", () => {
    // A 40 × 30 × 20 block: a 5 mm round along its top front edge, a 2 mm chamfer along its top back edge (both along X).
    const box = feature("box", { width: 40, depth: 30, height: 20 });
    const first = build([box]);
    const round = { ...feature("fillet", { radius: 5 }, "add"), picks: [edgeAt(first, [20, 0, 20])] };
    const bevel = { ...feature("chamfer", { distance: 2 }, "add"), picks: [edgeAt(first, [20, 30, 20])] };
    const r = build([box, round, bevel]);
    expect(r.featureErrors).toEqual({});
    const [right] = engine.project([], undefined, ["right"], false);
    // The round, seen end-on: a quarter circle of radius 5.
    const c = right.circles.find((x) => !x.full && Math.abs(x.r - 5) < 1e-6)!;
    expect(c).toBeDefined();
    const arc = arcOf(right, [c.cx, c.cy], c.r, [c.cx, c.cy])!;
    expect(arc.sweep).toBeCloseTo(Math.PI / 2, 6);
    const arcDim: Dimension = { id: "al", view: "right", type: "arcLength", a: dimPoint([c.cx, c.cy], right), r: c.r, b: dimPoint(arc.mid, right), offset: 6 };
    const ra = resolveDim(arcDim, right);
    expect(ra.found).toBe(true);
    expect(measureDim(arcDim, ra)).toBeCloseTo((5 * Math.PI) / 2, 6);
    // The chamfer, seen end-on: the one slanted edge, 2 across and 2 up.
    const slanted = right.visible.filter((l) => l.length === 4 && Math.abs(l[0] - l[2]) > 1e-6 && Math.abs(l[1] - l[3]) > 1e-6);
    expect(slanted).toHaveLength(1);
    const [x0, y0, x1, y1] = slanted[0];
    const size = chamferSize([x0, y0], [x1, y1]);
    expect(size.distance).toBeCloseTo(2, 6);
    expect(size.angle).toBeCloseTo(45, 6);
    const chamfer: Dimension = { id: "ch", view: "right", type: "chamfer", a: dimPoint([x0, y0], right), b: dimPoint([x1, y1], right), offset: 8, angle: 45 };
    const base: Drawing = { ...newDrawing(), views: [{ id: "r", kind: "right" }] };
    const d = putDimension(putDimension(base, arcDim), chamfer);
    const l = layoutSheet(d, { right }, info);
    expect(l.dims.every((x) => x.found)).toBe(true);
    expect(texts(l)).toContain("7.85");
    expect(texts(l)).toContain("2 × 45°");
  }, 120_000);

  it("keeps a real plate's views apart when the top view is at its own scale", () => {
    build([feature("box", { width: 120, depth: 80, height: 10 })]);
    let d: Drawing = { ...newDrawing(), sheet: "A2", views: [{ id: "f", kind: "front" }, { id: "t", kind: "top", scale: 2 }, { id: "r", kind: "right" }, { id: "i", kind: "iso" }] };
    d = addSection(d, { id: "s1", host: "front", a: [0.5, 0], b: [0.5, 1] });
    const list = engine.project([], undefined, ["front", "top", "right", "iso"], true, sectionRequests(d));
    const projections: Projections = Object.fromEntries(list.map((p) => [p.kind, p]));
    const l = layoutSheet(d, projections, info);
    expect(l.views).toHaveLength(5);
    const overlap = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    for (const a of l.views) for (const b of l.views) if (a !== b) expect(overlap(a.box, b.box)).toBe(false);
    const top = l.views.find((v) => v.key === "top")!;
    expect(top.box[2] - top.box[0]).toBeCloseTo(240, 3);
  }, 120_000);

  it("lists 25 real holes in a wrapped table, with the views still on the sheet", () => {
    // A 150 × 100 × 5 plate with 25 holes in a 5 × 5 grid, two sizes.
    const plate = feature("box", { width: 150, depth: 100, height: 5 });
    const holes: Feature[] = [];
    for (let i = 0; i < 25; i++) holes.push(feature("cylinder", { diameter: i % 2 ? 4 : 6, height: 5, x: 15 + (i % 5) * 30, y: 10 + Math.floor(i / 5) * 20, z: 0 }, "remove"));
    const r = build([plate, ...holes]);
    expect(r.featureErrors).toEqual({});
    const [front, top] = engine.project([], undefined, ["front", "top"], false);
    expect(holeRows(top)).toHaveLength(25);
    const projections: Projections = { front, top };
    const d: Drawing = { ...newDrawing(), views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }], holeTable: true };
    const l = layoutSheet(d, projections, info);
    expect(l.tooBig).toBe(false);
    const t = l.holeTable!.box;
    expect(t[2] - t[0]).toBeGreaterThan(180);
    for (const v of l.views) expect(v.box[1]).toBeGreaterThan(t[3]);
    expect(texts(l).filter((x) => x === "HOLE").length).toBeGreaterThan(1);
    // A second sheet shows the top view on its own at 1:1, its sheet numbered.
    let two = addPage(d, "p2");
    two = changePage(two, "p2", (p) => ({ ...p, scale: 1, sheet: "A3", views: [{ id: "t2", kind: "top" }] }));
    const l2 = layoutSheet(pageOf(two, "p2"), projections, { ...info, sheetNo: 2, sheetCount: 2 });
    const top2 = l2.views[0];
    expect(top2.box[2] - top2.box[0]).toBeCloseTo(150, 3);
    expect(texts(l2)).toContain("2 OF 2");
    // (No hole table there: it's sheet 1's.)
    expect(l2.holeTable).toBeUndefined();
  }, 240_000);
});

describe("arrows and the 3D view's scale on real views", () => {
  it("puts a real hole's diameter arrows on its edge, inside or outside, and a length's leaders past its corners", () => {
    // A 60 × 40 × 20 block with a 10 mm hole through it at (20, 20).
    build([feature("box", { width: 60, depth: 40, height: 20 }), feature("cylinder", { diameter: 10, height: 20, x: 20, y: 20, z: 0 }, "remove")]);
    const [front, top] = engine.project([], undefined, ["front", "top"], false);
    const hole = top.circles.find((c) => Math.abs(c.r - 5) < 1e-6)!;
    expect(hole).toBeDefined();
    const [x0, , x1, y1] = front.bounds!;
    const dia: Dimension = { id: "d", view: "top", type: "diameter", a: dimPoint([hole.cx, hole.cy], top), r: 5, offset: 6, angle: 0 };
    const len: Dimension = { id: "w", view: "front", type: "horizontal", a: dimPoint([x0, y1], front), b: dimPoint([x1, y1], front), offset: 8 };
    const at = (arrows?: "inside" | "outside") => {
      const d: Drawing = { ...newDrawing(), scale: 1, views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }], dimensions: [arrows ? { ...dia, arrows } : dia, arrows ? { ...len, arrows } : len] };
      return layoutSheet(d, { front, top }, info);
    };
    for (const mode of [undefined, "inside", "outside"] as const) {
      const l = at(mode);
      const t = l.views.find((v) => v.key === "top")!;
      const centre = l.dims[0].a;
      expect(l.dims[0].rad).toBeCloseTo(5, 6);
      // Both tips sit on the hole's edge, 5 mm either side of its centre (1:1); the backs 3 mm in or out.
      const heads = l.prims.slice(l.dims[0].from, l.dims[0].to).filter((p) => p.kind === "path" && p.fill);
      expect(heads).toHaveLength(2);
      const tips = heads.map((p) => (p.kind === "path" ? [p.points[0] - centre[0], p.points[1] - centre[1], (p.points[2] + p.points[4]) / 2 - centre[0]] : []));
      expect(tips[0][0]).toBeCloseTo(5, 6);
      expect(tips[1][0]).toBeCloseTo(-5, 6);
      expect(tips[0][2]).toBeCloseTo(mode === "inside" ? 2 : 8, 6);
      expect(tips[1][2]).toBeCloseTo(mode === "inside" ? -2 : -8, 6);
      expect(centre[0]).toBeGreaterThan(t.box[0]);
      // The 60 mm length: inside by itself (room enough); leaders 6 mm past each end only when set outside.
      const lp = l.prims.slice(l.dims[1].from, l.dims[1].to);
      const la = l.dims[1].a;
      const lb = l.dims[1].b!;
      expect(lb[0] - la[0]).toBeCloseTo(60, 6);
      const leaders = lp.filter((p) => p.kind === "path" && !p.fill && p.points.length === 4 && Math.abs(p.points[1] - p.points[3]) < 1e-9 && Math.abs(Math.abs(p.points[2] - p.points[0]) - 6) < 1e-9);
      expect(leaders).toHaveLength(mode === "outside" ? 2 : 0);
      expect(l.dims[1].arrows).toBe(mode ?? "inside");
    }
  }, 120_000);

  it("draws a real 3D view at its own scale clear of the other views", () => {
    build([feature("box", { width: 60, depth: 40, height: 20 })]);
    const list = engine.project([], undefined, ["front", "top", "right", "iso"], false);
    const projections: Projections = Object.fromEntries(list.map((p) => [p.kind, p]));
    const base: Drawing = { ...newDrawing(), sheet: "A3", views: [{ id: "f", kind: "front" }, { id: "t", kind: "top" }, { id: "r", kind: "right" }, { id: "i", kind: "iso" }] };
    const plain = layoutSheet(base, projections, info);
    const isoSize = (l: ReturnType<typeof layoutSheet>) => ((b) => b[2] - b[0])(l.views.find((v) => v.key === "iso")!.box);
    for (const own of [0.5, 1, 2]) {
      const d = scaleView(base, "i", own, projections, info);
      const l = layoutSheet(d, projections, info);
      expect(l.tooBig).toBe(false);
      // Its own size: the plain one's, times its scale over the sheet's then.
      expect(isoSize(l)).toBeCloseTo((isoSize(plain) * own) / plain.scale, 6);
      for (const v of l.views) expect(viewClear(l, v.key)).toBe(true);
      if (own !== l.scale) expect(texts(l)).toContain(`SCALE ${own >= 1 ? `${own}:1` : `1:${1 / own}`}`);
    }
  }, 120_000);
});
