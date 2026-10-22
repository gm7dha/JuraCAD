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
import { layoutSheet, type Projections } from "../src/drawing/sheet";
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
  }, 60_000);

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
  }, 60_000);

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
  }, 120_000);
});
