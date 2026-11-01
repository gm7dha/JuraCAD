/**
 * Angle dimensions measuring the outside (reflex) angle; angle and arc-length
 * numbers dragged nearer than their arc can come (a short leader joins them);
 * and diameters' shoulders as long as the number as measured once dragged.
 */
import { describe, expect, it } from "vitest";

import { angleSpan, dimLabel, dimPoint, dragDimensionLabel, drawDimension, gapLeader, measureDim, resolveDim, TEXT_SIZE, withDimPatch, type DimDrawing, type DragPlace } from "../src/drawing/dimensions";
import { addDrawing, parseDrawings, putDimension } from "../src/drawing/drawing";
import { sheetDxf, sheetsPdf, sheetSvg, textWidth } from "../src/drawing/export";
import { layoutSheet, type Prim } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension } from "../src/model/types";

type P2 = [number, number];
const DEG = Math.PI / 180;
const same = (p: P2) => p;

function proj(points: number[], circles: { cx: number; cy: number; r: number; full?: boolean }[] = [], visible: number[][] = []): ViewProjection {
  return { kind: "front", visible, hidden: [], circles: circles.map((c) => ({ hidden: false, full: true, ...c })), points, bounds: [-50, -50, 50, 50] };
}
function draw(dim: Dimension, p: ViewProjection): DimDrawing {
  const r = resolveDim(dim, p);
  return drawDimension(dim, r, same, measureDim(dim, r));
}
const texts = (d: DimDrawing) => d.prims.filter((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text");
const paths = (d: DimDrawing) => d.prims.filter((x): x is Extract<Prim, { kind: "path" }> => x.kind === "path");
function drag(dim: Dimension, placed: DragPlace, to: P2, lift = false): Dimension {
  const patch = dragDimensionLabel(dim, placed, to, lift);
  expect(patch).toBeTruthy();
  return withDimPatch(dim, patch!);
}
const close = (a: number[], b: number[], digits = 9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

// Two edges from the origin: along +x, and up at 45°.
const p = proj([0, 0, 40, 0, 30, 30]);
const angle: Dimension = { id: "g", view: "front", type: "angle", a: dimPoint([0, 0], p), b: dimPoint([40, 0], p), c: dimPoint([0, 0], p), d: dimPoint([30, 30], p), offset: 20, rays: [1, 1] };
const placed: DragPlace = { a: [0, 0], b: [40, 0], rad: 0, cd: [[0, 0], [30, 30]] };
/** Where the label goes for the number's middle `r` out from the corner in direction `deg`. */
const spot = (r: number, deg: number): P2 => [r * Math.cos(deg * DEG), r * Math.sin(deg * DEG) - TEXT_SIZE * 0.35];

describe("the outside (reflex) angle", () => {
  it("measures 360° less the angle, with its arc the long way round and the number in its middle", () => {
    const outside: Dimension = { ...angle, reflex: true };
    const r = resolveDim(outside, p);
    expect(measureDim(outside, r)).toBeCloseTo(315, 9);
    expect(dimLabel(outside, measureDim(outside, r))).toBe("315°");
    const span = angleSpan([1, 0], [Math.SQRT1_2, Math.SQRT1_2], true);
    expect(span.a1).toBeCloseTo(45 * DEG, 12);
    expect(span.sweep).toBeCloseTo(315 * DEG, 12);
    const drawn = draw(outside, p);
    // The arc: from the 45° arm on round, through 180°, back to the +x arm.
    const arc = paths(drawn)[0].points;
    close(arc.slice(0, 2), [20 * Math.SQRT1_2, 20 * Math.SQRT1_2]);
    close(arc.slice(-2), [20, 0]);
    expect(arc.length / 2 - 1).toBe(Math.ceil((315 * DEG) / 0.08));
    // Half way round it (202.5°), 3 mm out.
    close(drawn.label, spot(23, 202.5));
    expect(texts(drawn)[0].text).toBe("315°");
    // Arrows at both arms, pointing along the arc away from its inside.
    const tips = paths(drawn).filter((x) => x.fill).map((x) => x.points.slice(0, 2));
    close(tips[0], [20 * Math.SQRT1_2, 20 * Math.SQRT1_2]);
    close(tips[1], [20, 0]);
    // Saved and read back; not on other kinds of dimension.
    const raw = JSON.parse(JSON.stringify([{ id: "d", views: [{ id: "v", kind: "front" }], dimensions: [outside, { ...outside, id: "h", type: "horizontal" }] }]));
    const read = parseDrawings(raw)[0].dimensions!;
    expect(read[0].reflex).toBe(true);
    expect(read[1].reflex).toBeUndefined();
  });

  it("Shift-dragging the number round into the opposite angle measures the outside angle; back between the arms, the inside one", () => {
    const outside = drag(angle, placed, spot(23, 202.5), true);
    expect(outside.reflex).toBe(true);
    expect(outside.rays).toEqual([1, 1]);
    expect(outside.offset).toBe(20);
    // Right in the middle of the long arc: no slide saved.
    expect(outside.textAngle).toBeUndefined();
    close(draw(outside, p).label, spot(23, 202.5));
    // A plain drag along the long arc keeps it, sliding the number round (90° is 112.5° short of its middle).
    const slid = drag(outside, placed, spot(33, 90));
    expect(slid.reflex).toBe(true);
    expect(slid.rays).toEqual([1, 1]);
    expect(slid.offset).toBe(30);
    expect(slid.textAngle).toBe(-112.5);
    close(draw(slid, p).label, spot(33, 90));
    // Back between the arms: the 45° angle again.
    const inside = drag(slid, placed, spot(23, 22.5));
    expect(inside.reflex).toBeUndefined();
    expect(inside.rays).toEqual([1, 1]);
    expect(inside.textAngle).toBeUndefined();
    expect(measureDim(inside, resolveDim(inside, p))).toBeCloseTo(45, 9);
    // Without Shift, the opposite angle is measured instead (as before): the same 45°, the other way.
    const opposite = drag(angle, placed, spot(23, 202.5));
    expect(opposite.reflex).toBeUndefined();
    expect(opposite.rays).toEqual([-1, -1]);
  });
});

describe("numbers nearer than their arc can come", () => {
  it("an angle's number goes right up to the corner; the arc stays at its smallest", () => {
    // 5 mm from the corner, half way between the arms: the arc can't come in past 4 mm (number 3 mm beyond).
    const near = drag(angle, placed, spot(5, 22.5));
    expect(near.offset).toBe(4);
    expect(near.textR).toBe(5);
    expect(near.textAngle).toBeUndefined();
    const drawn = draw(near, p);
    close(drawn.label, spot(5, 22.5));
    expect(paths(drawn)[0].points.slice(0, 2)).toEqual([4, 0]);
    // It overlaps the arc there, so no leader: just the arc and its two arrows.
    expect(paths(drawn)).toHaveLength(3);
    // Up above the arc (88°: it's narrow that way), a short leader joins it to the arc. (Over there, past the
    // 45° arm, it measures the 135° angle, as dragging there always has.)
    const above = drag(angle, placed, spot(6.8, 88));
    expect(above.rays).toEqual([-1, 1]);
    expect(above.textR).toBe(6.8);
    // (The 135° arc's middle is at 112.5°.)
    expect(above.textAngle).toBe(-24.5);
    const drawnAbove = draw(above, p);
    close(drawnAbove.label, spot(6.8, 88));
    const u: P2 = [Math.cos(88 * DEG), Math.sin(88 * DEG)];
    const extent = (Math.abs(u[0]) * textWidth("135°", TEXT_SIZE)) / 2 + (Math.abs(u[1]) * TEXT_SIZE * 0.75) / 2;
    const leader = paths(drawnAbove).find((x) => x.points.length === 4 && Math.abs(Math.hypot(x.points[0], x.points[1]) - 4) < 1e-9)!;
    close(leader.points, [4 * u[0], 4 * u[1], (6.8 - extent) * u[0], (6.8 - extent) * u[1]]);
    // Dragged out again, it's back to sitting just beyond its arc.
    const out = drag(above, placed, spot(23, 22.5));
    expect(out.textR).toBeUndefined();
    expect(out.offset).toBe(20);
    // Kept in saved files.
    expect(parseDrawings(JSON.parse(JSON.stringify([{ id: "d", views: [{ id: "v", kind: "front" }], dimensions: [above] }])))[0].dimensions![0].textR).toBe(6.8);
  });

  it("an arc length's number goes inside its arc, with a leader out to it", () => {
    const arcPts: number[] = [];
    for (let i = 0; i <= 18; i++) arcPts.push(10 * Math.cos(i * 5 * DEG), 10 * Math.sin(i * 5 * DEG));
    const pa = proj([0, 0, 10, 0, 0, 10], [{ cx: 0, cy: 0, r: 10, full: false }], [arcPts]);
    const dim: Dimension = { id: "l", view: "front", type: "arcLength", a: dimPoint([0, 0], pa), r: 10, b: dimPoint([10 * Math.SQRT1_2, 10 * Math.SQRT1_2], pa), offset: 8 };
    const r = resolveDim(dim, pa);
    const where: DragPlace = { a: [0, 0], b: r.b!, rad: 10, arc: r.arc, width: draw(dim, pa).width };
    // The number's middle 5 mm from the centre at 45° (its label is 0.375 × text + 0.4 below that).
    const to: P2 = [5 * Math.SQRT1_2, 5 * Math.SQRT1_2 - TEXT_SIZE * 0.375 - 0.4];
    const near = drag(dim, where, to);
    expect(near.offset).toBe(2);
    expect(near.textR).toBe(5);
    const drawn = draw(near, pa);
    close(drawn.label, to);
    // From the far edge of the number (as its outline lies that way) out to the arc 12 mm out.
    const w = textWidth("15.71", TEXT_SIZE);
    const extent = Math.SQRT1_2 * (w / 2) + (Math.SQRT1_2 * (TEXT_SIZE * 0.75 + 1.6)) / 2;
    const leader = gapLeader([0, 0], [Math.SQRT1_2, Math.SQRT1_2], 12, 5, extent);
    expect(leader).toHaveLength(1);
    const want = [(5 + extent) * Math.SQRT1_2, (5 + extent) * Math.SQRT1_2, 12 * Math.SQRT1_2, 12 * Math.SQRT1_2];
    close((leader[0] as { points: number[] }).points, want);
    const drawnLeader = paths(drawn).find((x) => x.points.length === 4 && Math.abs(x.points[0] - want[0]) < 1e-6)!;
    close(drawnLeader.points, want);
  });

  it("joins the number to the arc only when there's a gap between them", () => {
    expect(gapLeader([0, 0], [1, 0], 4, 2, 1)).toEqual([{ kind: "path", points: [3, 0, 4, 0], style: "thin" }]);
    expect(gapLeader([0, 0], [0, 1], 4, 7, 1)).toEqual([{ kind: "path", points: [0, 4, 0, 6], style: "thin" }]);
    expect(gapLeader([0, 0], [1, 0], 4, 3, 1)).toEqual([]);
    expect(gapLeader([0, 0], [1, 0], 4, 5.4, 1)).toEqual([]);
  });

  it("is the same on screen and in every file", () => {
    const d = putDimension(addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0], { ...drag(angle, placed, spot(5, 22.5)), reflex: true });
    const layout = layoutSheet(d, { front: p, top: p, right: p, iso: p }, { designName: "x", subject: "y", date: "1/1/2026" });
    const placedDim = layout.dims[0];
    const t = layout.prims.slice(placedDim.from, placedDim.to).find((x) => x.kind === "text") as Extract<Prim, { kind: "text" }>;
    expect(t.text).toBe("315°");
    const svg = sheetSvg(layout.prims, layout.size);
    expect(svg).toContain(">315°<");
    expect(sheetDxf(layout.prims)).toContain("315%%d");
    expect(new TextDecoder("latin1").decode(sheetsPdf([{ prims: layout.prims, size: layout.size }]))).toContain("(315\\260) Tj");
  });
});
