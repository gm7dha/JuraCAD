import { describe, expect, it } from "vitest";

import { circleLeader, dimensionScale, dimPoint, dragDimension, dragDimensionLabel, drawDimension, resolveDim, withDimPatch, type DimDrawing } from "../src/drawing/dimensions";
import { addDrawing, parseDrawings, putDimension } from "../src/drawing/drawing";
import { sheetDxf, sheetSvg, textWidth } from "../src/drawing/export";
import { dimTextOutlines } from "../src/drawing/select";
import { layoutSheet, type Prim } from "../src/drawing/sheet";
import type { ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Dimension } from "../src/model/types";

type P2 = [number, number];
const same = (p: P2) => p;

/** Points (and a circle) on a view, drawn 1:1 so view mm = sheet mm. */
function proj(points: number[], circles: { cx: number; cy: number; r: number }[] = []): ViewProjection {
  return { kind: "front", visible: [], hidden: [], circles: circles.map((c) => ({ ...c, hidden: false, full: true })), points, bounds: [-50, -50, 50, 50] };
}

function draw(dim: Dimension, p: ViewProjection, value: number): DimDrawing {
  return drawDimension(dim, resolveDim(dim, p), same, value);
}
const texts = (d: DimDrawing) => d.prims.filter((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text");
const paths = (d: DimDrawing) => d.prims.filter((x): x is Extract<Prim, { kind: "path" }> => x.kind === "path");

/** Drag `dim` so its number's label point lands on `to`; returns the dimension as changed. */
function dragTo(dim: Dimension, placed: { a: P2; b: P2 | null; rad: number }, to: P2, lift = false, scale = 1): Dimension {
  const patch = dragDimensionLabel(dim, placed, to, lift, scale);
  expect(patch).toBeTruthy();
  return withDimPatch(dim, patch!);
}

describe("dragging a length dimension's number", () => {
  const p = proj([0, 0, 40, 0]);
  const dim: Dimension = { id: "d", view: "front", type: "horizontal", a: dimPoint([0, 0], p), b: dimPoint([40, 0], p), offset: 10 };
  const placed = { a: [0, 0] as P2, b: [40, 0] as P2, rad: 0 };

  it("starts where the number is drawn (the line 10 out, the number 1.2 above its middle)", () => {
    expect(draw(dim, p, 40).label).toEqual([20, 11.2]);
  });

  it("follows the pointer: across moves the line, along slides the number", () => {
    const moved = dragTo(dim, placed, [30, 21.2]);
    expect(moved.offset).toBe(20);
    expect(moved.textAlong).toBe(10);
    expect(moved.textAcross).toBeUndefined();
    const drawn = draw(moved, p, 40);
    expect(drawn.label[0]).toBeCloseTo(30, 9);
    expect(drawn.label[1]).toBeCloseTo(21.2, 9);
    // The dimension line moved out to y = 20, and the extension lines reach it (plus 2 mm overshoot).
    const ps = paths(drawn);
    expect(ps.some((x) => x.points.length === 4 && x.points[1] === 20 && x.points[3] === 20 && x.points[0] === 0 && x.points[2] === 40)).toBe(true);
    expect(ps.filter((x) => x.points.length === 4 && x.points[0] === x.points[2] && Math.abs(x.points[3] - 22) < 1e-9).map((x) => x.points[0])).toEqual([0, 40]);
  });

  it("snaps back to the middle within 2 mm of it", () => {
    expect(dragTo(dim, placed, [21.5, 11.2]).textAlong).toBeUndefined();
  });

  it("goes past an extension line, with the dimension line carried out to it", () => {
    const moved = dragTo(dim, placed, [70, 11.2]);
    expect(moved.offset).toBe(10);
    expect(moved.textAlong).toBe(50);
    const drawn = draw(moved, p, 40);
    expect(texts(drawn)[0].x).toBeCloseTo(70, 9);
    // From the extension line at x = 40 out past the far side of "40" (half its width + 1 mm).
    const half = (2 * 3.5 * 0.55) / 2 + 1;
    const reach = paths(drawn).find((x) => x.points.length === 4 && x.points[1] === 10 && x.points[3] === 10 && x.points[0] === 40);
    expect(reach).toBeDefined();
    expect(reach!.points[2]).toBeCloseTo(70 + half, 9);
  });

  it("keeps a number lifted off the line where it was lifted", () => {
    const lifted = { ...dim, textAcross: 6 };
    const moved = dragTo(lifted, placed, [30, 27.2]);
    expect(moved).toMatchObject({ offset: 20, textAlong: 10, textAcross: 6 });
    const drawn = draw(moved, p, 40);
    expect(drawn.label[0]).toBeCloseTo(30, 9);
    expect(drawn.label[1]).toBeCloseTo(27.2, 9);
  });

  it("with Shift, lifts the number off the line and leaves the line where it is", () => {
    const moved = dragTo(dim, placed, [30, 25], true);
    expect(moved).toMatchObject({ offset: 10, textAlong: 10, textAcross: 13.8 });
    const drawn = draw(moved, p, 40);
    expect(drawn.label[0]).toBeCloseTo(30, 9);
    expect(drawn.label[1]).toBeCloseTo(25, 9);
    // A thin leader from the line (y = 10) up to just under the number.
    expect(paths(drawn).some((x) => x.points.length === 4 && x.points[0] === 30 && x.points[1] === 10 && Math.abs(x.points[3] - (10 + 13.8 + 0.6)) < 1e-9)).toBe(true);
    // Back near the line: on it again.
    expect(dragTo(moved, placed, [30, 11.5], true).textAcross).toBeUndefined();
  });

  it("works for upright dimensions (the number reads upwards, left of the line)", () => {
    const pv = proj([0, 0, 0, 30]);
    const v: Dimension = { id: "v", view: "front", type: "vertical", a: dimPoint([0, 0], pv), b: dimPoint([0, 30], pv), offset: 10 };
    const start = draw(v, pv, 30).label;
    expect(start[0]).toBeCloseTo(-11.2, 9);
    expect(start[1]).toBeCloseTo(15, 9);
    const moved = dragTo(v, { a: [0, 0], b: [0, 30], rad: 0 }, [-21.2, 25]);
    expect(moved).toMatchObject({ offset: 20, textAlong: 10 });
    const drawn = draw(moved, pv, 30);
    expect(drawn.label[0]).toBeCloseTo(-21.2, 9);
    expect(drawn.label[1]).toBeCloseTo(25, 9);
    expect(texts(drawn)[0].rotate).toBe(90);
  });

  it("works for slanted dimensions", () => {
    const pa = proj([0, 0, 30, 40]);
    const s: Dimension = { id: "s", view: "front", type: "aligned", a: dimPoint([0, 0], pa), b: dimPoint([30, 40], pa), offset: 5 };
    // Along (0.6, 0.8), across and "up" (-0.8, 0.6): middle (15, 20), line 5 out, number 1.2 above it.
    const start = draw(s, pa, 50).label;
    expect(start[0]).toBeCloseTo(10.04, 9);
    expect(start[1]).toBeCloseTo(23.72, 9);
    // 12 out and 10 back along: (15, 20) + 12·(-0.8, 0.6) − 10·(0.6, 0.8) = (-0.6, 19.2); the number 1.2 above.
    const moved = dragTo(s, { a: [0, 0], b: [30, 40], rad: 0 }, [-1.56, 19.92]);
    expect(moved).toMatchObject({ offset: 12, textAlong: -10 });
    const drawn = draw(moved, pa, 50);
    expect(drawn.label[0]).toBeCloseTo(-1.56, 9);
    expect(drawn.label[1]).toBeCloseTo(19.92, 9);
  });
});

describe("dragging a diameter's or radius's number", () => {
  const p = proj([], [{ cx: 10, cy: 10, r: 5 }]);
  const dia: Dimension = { id: "c", view: "front", type: "diameter", a: dimPoint([10, 10], p), r: 5, offset: 8 };
  const placed = { a: [10, 10] as P2, b: null, rad: 5 };
  // "Ø10": 3 characters, so a shoulder 2 + 3 × 3.5 × 0.55 long.
  const shoulder = 2 + 3 * 3.5 * 0.55;

  it("puts the number exactly where it's dropped, with the leader following", () => {
    const moved = dragTo(dia, placed, [30, 25]);
    expect(moved.textAt).toEqual([20, 15]);
    // Kept roughly in step, for older copies of the app.
    expect(moved.angle).toBe(37);
    expect(moved.offset).toBe(20);
    const drawn = draw(moved, p, 10);
    expect(drawn.label).toEqual([30, 25]);
    expect(texts(drawn)[0]).toMatchObject({ x: 30, y: 25, text: "Ø10", anchor: "middle" });
    // Leader: from the far side of the circle, through the centre, to the elbow under the number's near end, then the shoulder.
    const elbow: P2 = [30 - shoulder / 2, 24];
    const len = Math.hypot(elbow[0] - 10, elbow[1] - 10);
    const u: P2 = [(elbow[0] - 10) / len, (elbow[1] - 10) / len];
    const leader = paths(drawn)[0].points;
    expect(leader).toHaveLength(6);
    expect(leader[0]).toBeCloseTo(10 - 5 * u[0], 9);
    expect(leader[1]).toBeCloseTo(10 - 5 * u[1], 9);
    expect(leader[2]).toBeCloseTo(elbow[0], 9);
    expect(leader[3]).toBeCloseTo(24, 9);
    expect(leader[4]).toBeCloseTo(30 + shoulder / 2, 9);
    expect(leader[5]).toBeCloseTo(24, 9);
    // Automatic: arrows outside, pointing in at both ends of the diameter.
    expect(drawn.arrows).toBe("outside");
    const tips = paths(drawn).filter((x) => x.fill).map((x) => [x.points[0], x.points[1]]);
    expect(tips).toHaveLength(2);
    expect(tips[0][0]).toBeCloseTo(10 + 5 * u[0], 9);
    expect(tips[0][1]).toBeCloseTo(10 + 5 * u[1], 9);
  });

  it("on the left, leads in from the number's right-hand end", () => {
    const moved = dragTo(dia, placed, [-15, 0]);
    const leader = paths(draw(moved, p, 10))[0].points;
    expect(leader[2]).toBeCloseTo(-15 + shoulder / 2, 9);
    expect(leader[4]).toBeCloseTo(-15 - shoulder / 2, 9);
  });

  it("can go inside the circle: the line stops at the edge and the arrows point out", () => {
    const big = proj([], [{ cx: 0, cy: 0, r: 20 }]);
    const d: Dimension = { id: "b", view: "front", type: "diameter", a: dimPoint([0, 0], big), r: 20, offset: 8 };
    const moved = dragTo(d, { a: [0, 0], b: null, rad: 20 }, [2, 5]);
    expect(moved.textAt).toEqual([2, 5]);
    const drawn = draw(moved, big, 40);
    expect(drawn.label).toEqual([2, 5]);
    expect(drawn.arrows).toBe("inside");
    const g = circleLeader([0, 0], 20, [2, 5], shoulder);
    expect(g.inner).toBe(true);
    const [across, under] = paths(drawn);
    // Right across the circle along the leader's direction…
    expect(across.points).toHaveLength(4);
    expect(Math.hypot(across.points[0], across.points[1])).toBeCloseTo(20, 9);
    expect(Math.hypot(across.points[2], across.points[3])).toBeCloseTo(20, 9);
    expect(across.points[2]).toBeCloseTo(g.onCircle[0], 9);
    // …and a shoulder under the number.
    expect(under.points[0]).toBeCloseTo(2 - shoulder / 2, 9);
    expect(under.points[1]).toBeCloseTo(4, 9);
    expect(under.points[2]).toBeCloseTo(2 + shoulder / 2, 9);
    // Inside: the arrow at the edge points outwards (its tip on the circle, its tail nearer the centre).
    const head = paths(drawn).find((x) => x.fill && Math.abs(x.points[0] - g.onCircle[0]) < 1e-9)!;
    expect(Math.hypot(head.points[2], head.points[3])).toBeLessThan(20);
    // Set Outside, it's drawn as asked.
    expect(draw({ ...moved, arrows: "outside" }, big, 40).arrows).toBe("outside");
  });

  it("is kept in the view's millimetres, so it stays put relative to the circle when the scale changes", () => {
    // Ø20 drawn at 2:1 (radius 20 on paper): the number dropped 30 right and 24 up on paper is 15, 12 in the view.
    const big = proj([], [{ cx: 0, cy: 0, r: 10 }]);
    const d: Dimension = { id: "b", view: "front", type: "diameter", a: dimPoint([0, 0], big), r: 10, offset: 8 };
    const twice = (q: P2): P2 => [q[0] * 2 + 100, q[1] * 2 + 50];
    expect(dimensionScale(d, 20, big)).toBe(2);
    const moved = dragTo(d, { a: [100, 50], b: null, rad: 20 }, [130, 74], false, 2);
    expect(moved.textAt).toEqual([15, 12]);
    expect(moved.offset).toBe(Math.round((Math.hypot(30, 24) - 20) * 10) / 10);
    const at2 = drawDimension(moved, resolveDim(moved, big), twice, 20);
    expect(at2.label).toEqual([130, 74]);
    expect(at2.arrows).toBe("outside");
    // At 6:1 the circle is three times bigger on paper and so is the number's distance: still outside it.
    const six = (q: P2): P2 => [q[0] * 6 + 100, q[1] * 6 + 50];
    const at6 = drawDimension(moved, resolveDim(moved, big), six, 20);
    expect(at6.label[0]).toBeCloseTo(190, 9);
    expect(at6.label[1]).toBeCloseTo(122, 9);
    expect(at6.arrows).toBe("outside");
    // The same through a whole sheet, at two view scales: the number sits 15, 12 view-mm from the centre either way.
    for (const scale of [1, 3]) {
      let dr = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
      dr = putDimension({ ...dr, views: dr.views.map((v) => ({ ...v, scale })) }, moved);
      const l = layoutSheet(dr, { front: big }, { designName: "x", subject: "y", date: "1/1/2026" });
      const pd = l.dims[0];
      expect(pd.rad).toBeCloseTo(10 * scale, 9);
      expect(pd.label[0] - pd.a[0]).toBeCloseTo(15 * scale, 9);
      expect(pd.label[1] - pd.a[1]).toBeCloseTo(12 * scale, 9);
    }
  });

  it("inside the circle with arrows set Outside, the arrow at the edge has a line behind it", () => {
    const big = proj([], [{ cx: 0, cy: 0, r: 20 }]);
    const d: Dimension = { id: "b", view: "front", type: "radius", a: dimPoint([0, 0], big), r: 20, offset: 8, arrows: "outside", textAt: [2, 5] };
    const drawn = draw(d, big, 20);
    expect(drawn.arrows).toBe("outside");
    const g = circleLeader([0, 0], 20, [2, 5], 2 + 3 * 3.5 * 0.55);
    const tail = paths(drawn).find((x) => !x.fill && x.points.length === 4 && Math.abs(x.points[0] - g.onCircle[0]) < 1e-9 && Math.abs(x.points[1] - g.onCircle[1]) < 1e-9);
    expect(tail).toBeDefined();
    // Out from the edge, 6 mm (ARROW_LEADER), under the arrow pointing in.
    expect(Math.hypot(tail!.points[2], tail!.points[3])).toBeCloseTo(26, 9);
  });

  it("a radius leads from the centre", () => {
    const r: Dimension = { ...dia, type: "radius" };
    const drawn = draw(dragTo(r, placed, [30, 25]), p, 5);
    const leader = paths(drawn)[0].points;
    expect([leader[0], leader[1]]).toEqual([10, 10]);
    expect(texts(drawn)[0].text).toBe("R5");
  });

  it("right over the centre, leads off sideways rather than failing", () => {
    const g = circleLeader([0, 0], 5, [4, 1], 8);
    expect(g.u).toEqual([1, 0]);
    expect(g.inner).toBe(true);
  });
});

describe("dragging a dimension line between the two points it measures", () => {
  // Points at different heights (0 and 10): between them, the line stays at the nearer one's level instead of leaping across.
  const h: Dimension = { id: "h", view: "front", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [40, 10], rel: [1, 1] }, offset: 5 };
  it("horizontal: sticks to the top in the upper half, the bottom in the lower half", () => {
    expect(dragDimension(h, [0, 0], [40, 10], 0, [20, 8]).offset).toBe(0);
    expect(dragDimension(h, [0, 0], [40, 10], 0, [20, 5.01]).offset).toBe(0);
    expect(dragDimension(h, [0, 0], [40, 10], 0, [20, 4.9]).offset).toBe(-0.1);
    expect(dragDimension(h, [0, 0], [40, 10], 0, [20, 2]).offset).toBe(-0.1);
    // Outside the band, as before.
    expect(dragDimension(h, [0, 0], [40, 10], 0, [20, 14]).offset).toBe(4);
    expect(dragDimension(h, [0, 0], [40, 10], 0, [20, -3]).offset).toBe(-3);
    // And drawn there: the line at y = 10, or just under y = 0.
    const p = proj([0, 0, 40, 10]);
    const dim = { ...h, a: dimPoint([0, 0], p), b: dimPoint([40, 10], p) };
    const lineY = (offset: number) => paths(draw({ ...dim, offset }, p, 40)).find((x) => x.points.length === 4 && Math.abs(x.points[1] - x.points[3]) < 1e-9 && x.points[0] === 0 && x.points[2] === 40)!.points[1];
    expect(lineY(0)).toBe(10);
    expect(lineY(-0.1)).toBeCloseTo(-0.1, 9);
  });
  it("vertical: sticks to the left in the left half, the right in the right half", () => {
    const v: Dimension = { ...h, type: "vertical", b: { at: [10, 40], rel: [1, 1] } };
    expect(dragDimension(v, [0, 0], [10, 40], 0, [3, 20]).offset).toBe(0);
    expect(dragDimension(v, [0, 0], [10, 40], 0, [7, 20]).offset).toBe(-0.1);
    expect(dragDimension(v, [0, 0], [10, 40], 0, [-4, 20]).offset).toBe(4);
    expect(dragDimension(v, [0, 0], [10, 40], 0, [13, 20]).offset).toBe(-3);
  });
});

describe("dimensions not dragged by their number stay as they were", () => {
  it("angles, chamfers, arc lengths and ordinates aren't moved this way", () => {
    for (const type of ["angle", "chamfer", "arcLength", "ordinate"] as const) {
      const d = { id: "x", view: "front", type, a: { at: [0, 0], rel: [0, 0] }, b: { at: [10, 0], rel: [1, 0] }, offset: 8 } as Dimension;
      expect(dragDimensionLabel(d, { a: [0, 0], b: [10, 0], rad: 0 }, [5, 5])).toBeNull();
    }
  });

  it("a drag's 0s are just 'not moved' (nothing extra saved)", () => {
    const d: Dimension = { id: "d", view: "front", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [40, 0], rel: [1, 0] }, offset: 10, textAlong: 5, textAcross: 3 };
    expect(withDimPatch(d, { offset: 12, textAlong: 0, textAcross: 0 })).toEqual({ id: "d", view: "front", type: "horizontal", a: d.a, b: d.b, offset: 12 });
    expect(withDimPatch(d, {})).toEqual(d);
  });
});

describe("the number's grab area", () => {
  it("covers all of the number, turned with it", () => {
    const flat: Prim = { kind: "text", x: 20, y: 11.2, text: "40", size: 3.5, anchor: "middle" };
    const up: Prim = { kind: "text", x: -11.2, y: 15, text: "30", size: 3.5, anchor: "middle", rotate: 90 };
    const line: Prim = { kind: "path", points: [0, 0, 1, 1], style: "thin" };
    const boxes = dimTextOutlines([line, flat, up, line], 0, 4);
    expect(boxes).toHaveLength(2);
    const w = textWidth("40", 3.5);
    const xs = boxes[0].filter((_, i) => i % 2 === 0);
    const ys = boxes[0].filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(20 - w / 2 - 0.8, 9);
    expect(Math.max(...xs)).toBeCloseTo(20 + w / 2 + 0.8, 9);
    expect(Math.min(...ys)).toBeCloseTo(11.2 - 0.8, 9);
    expect(Math.max(...ys)).toBeCloseTo(11.2 + 3.5 * 0.75 + 0.8, 9);
    // Upright text: tall, not wide.
    const uys = boxes[1].filter((_, i) => i % 2 === 1);
    expect(Math.max(...uys) - Math.min(...uys)).toBeCloseTo(textWidth("30", 3.5) + 1.6, 9);
    // Only within the range asked.
    expect(dimTextOutlines([line, flat, up, line], 2, 4)).toHaveLength(1);
  });
});

describe("a dragged number in saved files and exports", () => {
  const p = proj([], [{ cx: 10, cy: 10, r: 5 }]);
  const dia: Dimension = { id: "c", view: "front", type: "diameter", a: dimPoint([10, 10], p), r: 5, offset: 8 };

  it("is kept when the drawing is saved and opened again (and only on circles)", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
    d = putDimension(d, { ...dia, textAt: [20, 15] });
    d = putDimension(d, { id: "h", view: "front", type: "horizontal", a: dimPoint([0, 0], p), b: dimPoint([40, 0], p), offset: 8, textAt: [1, 2] } as Dimension);
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0].dimensions!;
    expect(back.find((x) => x.id === "c")!.textAt).toEqual([20, 15]);
    expect(back.find((x) => x.id === "h")!.textAt).toBeUndefined();
    const far = parseDrawings(JSON.parse(JSON.stringify([{ ...d, dimensions: [{ ...dia, textAt: [1e9, -1e9] }] }])))[0].dimensions!;
    expect(far[0].textAt).toEqual([10000, -10000]);
    const junk = parseDrawings(JSON.parse(JSON.stringify([{ ...d, dimensions: [{ ...dia, textAt: ["a", 2] }, { ...dia, id: "c2", textAt: [1] }] }])))[0].dimensions!;
    expect(junk.map((x) => x.textAt)).toEqual([undefined, undefined]);
  });

  it("is drawn in the SVG and DXF exactly where it is on screen", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0];
    d = putDimension(d, { ...dia, textAt: [20, 15] });
    const l = layoutSheet(d, { front: p }, { designName: "x", subject: "y", date: "1/1/2026" });
    const placed = l.dims[0];
    const t = l.prims.slice(placed.from, placed.to).find((x): x is Extract<Prim, { kind: "text" }> => x.kind === "text")!;
    // The number sits 20 right and 15 up from the circle's centre on the sheet.
    expect(t.x - placed.a[0]).toBeCloseTo(20, 9);
    expect(t.y - placed.a[1]).toBeCloseTo(15, 9);
    expect(placed.label).toEqual([t.x, t.y]);
    const svg = sheetSvg(l.prims, l.size);
    const H = l.size[1];
    const m = svg.match(new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)"[^>]*>Ø10</text>`));
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(t.x, 2);
    expect(Number(m![2])).toBeCloseTo(H - t.y, 2);
    expect(sheetDxf(l.prims)).toContain("%%c10");
  });
});
