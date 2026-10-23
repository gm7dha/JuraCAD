import { describe, expect, it } from "vitest";

import { addCircle, addLine, addPoint, curveById, dragPoint, pointPos } from "../src/sketch/ops";
import { attachPoint, bringIn, pickAt, snapAt } from "../src/sketch/snaps";
import { pruneReferences } from "../src/sketch/links";
import { strictMatch } from "../src/geometry/topoRef";
import { followLinks, linkedPoints, lostLinksMessage, projectEdge, refSketch, linkAllEdges, linkEdge, type RefEdge } from "../src/sketch/links";
import { planeFrame, planeOnFace } from "../src/sketch/planes";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { addDimension, setDimensionValue } from "../src/sketch/ops";
import { patternCurves, readPatternSettings } from "../src/sketch/tools";
import { findRegions } from "../src/sketch/regions";
import { parsePlane, parseSketchData } from "../src/sketch/validate";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";
import type { EdgeRef, TopoPick } from "../src/geometry/topoRef";

const at = (x: number, y: number) => ({ x, y });
const ORIGIN = "origin";
const tol = { pointTol: 1, curveTol: 0.6 };

/** A line from (0,0) to (20,10). */
function oneLine() {
  const r = addLine(emptySketch(), at(0, 0), at(20, 10));
  return { s: r.sketch, line: r.lineId };
}

/** A part edge (picked on part "box") seen in a Top-plane sketch. */
function lineEdge(a: [number, number], b: [number, number], z = 0): RefEdge {
  const ref: EdgeRef = { kind: "edge", curve: "LINE", a: [a[0], a[1], z], b: [b[0], b[1], z], mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z] };
  return projectEdge(planeFrame({ kind: "default", name: "Top" }), { partId: "box", ref })!;
}

function holeEdge(c: [number, number], r: number, z = 0): RefEdge {
  const ref: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [c[0] + r, c[1], z], b: [c[0] + r, c[1], z], mid: [c[0] - r, c[1], z] };
  return projectEdge(planeFrame({ kind: "default", name: "Top" }), { partId: "box", ref })!;
}

/** The outline of a w × h box's top face (corner at the origin). */
const outline = (w: number, h: number) => [lineEdge([0, 0], [w, 0]), lineEdge([w, 0], [w, h]), lineEdge([w, h], [0, h]), lineEdge([0, h], [0, 0])];

describe("midpoint snap", () => {
  it("hovering a line marks its middle; moving onto it snaps there", () => {
    const { s, line } = oneLine();
    const over = snapAt(s, 5, 2.6, tol);
    expect(over.hover).toEqual({ kind: "curve", id: line });
    expect(over.hints).toEqual([[10, 5]]);
    expect(over.placed.snap).toEqual({ kind: "curve", id: line });
    const near = snapAt(s, 10.4, 5.3, tol);
    expect(near.placed).toEqual({ x: 10, y: 5, snap: { kind: "midpoint", id: line } });
  });

  it("starting a line at the middle adds a Midpoint constraint that holds when the line moves", () => {
    const { s, line } = oneLine();
    const from = snapAt(s, 10.2, 4.9, tol).placed;
    const r = addLine(s, from, at(10, 30));
    const mid = r.sketch.constraints.find((c) => c.type === "midpoint");
    const newLine = curveById(r.sketch, r.lineId) as SketchLine;
    expect(mid?.refs).toEqual([newLine.p1, line]);
    expect(pointPos(r.sketch, newLine.p1)).toEqual([10, 5]);
    // Drag the first line's end: the new line's start stays at its middle.
    const l = curveById(r.sketch, line) as SketchLine;
    const moved = dragPoint(r.sketch, l.p2, 40, 10);
    const [mx, my] = pointPos(moved, newLine.p1);
    const [ax, ay] = pointPos(moved, l.p1);
    const [bx, by] = pointPos(moved, l.p2);
    expect(mx).toBeCloseTo((ax + bx) / 2, 6);
    expect(my).toBeCloseTo((ay + by) / 2, 6);
    expect(bx).toBeCloseTo(40, 6);
  });

  it("ends still win over the middle, and a dragged point dropped on a middle is held there", () => {
    const { s, line } = oneLine();
    expect(snapAt(s, 19.8, 10.2, tol).placed).toMatchObject({ x: 20, y: 10, snap: { kind: "point" } });
    const p = addPoint(s, at(3, 20));
    const r = attachPoint(p.sketch, p.pointId, { kind: "midpoint", id: line });
    expect(r.error).toBeUndefined();
    expect(pointPos(r.sketch, p.pointId)[0]).toBeCloseTo(10, 6);
    expect(pointPos(r.sketch, p.pointId)[1]).toBeCloseTo(5, 6);
    expect(r.sketch.constraints.filter((c) => c.type === "midpoint")).toHaveLength(1);
  });
});

describe("centre snap", () => {
  it("hovering a circle's rim marks its centre, and the centre then snaps from further away", () => {
    const c = addCircle(emptySketch(), at(30, 40), 10);
    const k = curveById(c.sketch, c.circleId)!;
    const centre = k.type === "circle" ? k.center : "";
    const rim = snapAt(c.sketch, 40.2, 40, tol);
    expect(rim.hover).toEqual({ kind: "curve", id: c.circleId });
    expect(rim.hints).toEqual([[30, 40]]);
    // 1.5 mm from the centre: out of reach normally, in reach once the rim was hovered.
    expect(snapAt(c.sketch, 31.5, 40, tol).placed.snap).toBeNull();
    expect(snapAt(c.sketch, 31.5, 40, { ...tol, acquired: [centre] }).placed).toEqual({ x: 30, y: 40, snap: { kind: "point", id: centre } });
  });

  it("the centre's wider reach never wins over a line's middle or the line itself", () => {
    const l = addLine(emptySketch(), at(0, 5), at(20, 5));
    const c = addCircle(l.sketch, at(11.6, 5), 0.5);
    const k = curveById(c.sketch, c.circleId)!;
    const centre = k.type === "circle" ? k.center : "";
    const o = { ...tol, acquired: [centre] };
    expect(snapAt(c.sketch, 10, 5, o).placed).toEqual({ x: 10, y: 5, snap: { kind: "midpoint", id: l.lineId } });
    expect(snapAt(c.sketch, 13, 5, o).placed).toEqual({ x: 13, y: 5, snap: { kind: "curve", id: l.lineId } });
    // Off the line, still in reach of the centre: the centre.
    expect(snapAt(c.sketch, 11.6, 6.9, o).placed.snap).toEqual({ kind: "point", id: centre });
  });

  it("a line started on the centre shares the centre point (coincident)", () => {
    const c = addCircle(emptySketch(), at(30, 40), 10);
    const k = curveById(c.sketch, c.circleId)!;
    const centre = k.type === "circle" ? k.center : "";
    const from = snapAt(c.sketch, 30.2, 40.1, tol).placed;
    const r = addLine(c.sketch, from, at(60, 40));
    expect((curveById(r.sketch, r.lineId) as SketchLine).p1).toBe(centre);
  });
});

describe("circular pattern round a chosen point", () => {
  function setup() {
    const centre = addPoint(emptySketch(), at(10, 0));
    const c = addCircle(centre.sketch, at(20, 0), 2);
    return { s: c.sketch, centre: centre.pointId, circle: c.circleId };
  }

  it("puts the copies round the chosen point", () => {
    const { s, centre, circle } = setup();
    const opts = readPatternSettings(s, { patternKind: "circular", patternCount: 4, patternSpacing: "10", patternAngle: "360", patternCentre: centre });
    if (typeof opts === "string") throw new Error(opts);
    expect(opts.kind === "circular" && opts.centre).toEqual([10, 0]);
    const r = patternCurves(s, [circle], opts);
    const centres = r.curveIds.map((id) => {
      const k = curveById(r.sketch, id)!;
      return k.type === "circle" ? pointPos(r.sketch, k.center).map((v) => Math.round(v * 1e6) / 1e6) : null;
    });
    expect(centres).toEqual([
      [10, 10],
      [0, 0],
      [10, -10],
    ]);
  });

  it("stays linked: moving the centre or the original moves the copies", () => {
    const { s, centre, circle } = setup();
    const opts = readPatternSettings(s, { patternKind: "circular", patternCount: 4, patternSpacing: "10", patternAngle: "360", patternCentre: centre });
    if (typeof opts === "string") throw new Error(opts);
    const r = patternCurves(s, [circle], opts);
    expect(r.sketch.constraints.filter((c) => c.type === "patternCopy")).toHaveLength(3);
    const moved = dragPoint(r.sketch, centre, 0, 5);
    const pos = (id: string) => {
      const k = curveById(moved, id)!;
      return k.type === "circle" ? pointPos(moved, k.center) : [NaN, NaN];
    };
    // The original's centre (20, 0) is free, so it stays; the copies turn round (0, 5).
    const orig = pos(circle);
    expect(orig[0]).toBeCloseTo(20, 6);
    expect(orig[1]).toBeCloseTo(0, 6);
    const first = pos(r.curveIds[0]);
    expect(first[0]).toBeCloseTo(5, 6);
    expect(first[1]).toBeCloseTo(25, 6);
    // A copy's size follows the original's.
    const resized = solveSketch({ ...moved, curves: moved.curves.map((k) => (k.id === circle && k.type === "circle" ? { ...k, radius: 3 } : k)) }, { resize: { circleId: circle, radius: 3 } });
    const copy = curveById(resized.sketch, r.curveIds[1]);
    expect(copy?.type === "circle" ? copy.radius : 0).toBeCloseTo(3, 6);
  });

  it("stays quick with many copies: 119 copies re-size and drag quickly", () => {
    const { s, centre, circle } = setup();
    const r = patternCurves(s, [circle], { kind: "circular", count: 120, angle: 360, centre: [10, 0], centreId: centre });
    const dim = addDimension(r.sketch, [circle]);
    expect(dim.error).toBeUndefined();
    const t0 = performance.now();
    const sized = setDimensionValue(dim.sketch, dim.dimensionId, "4");
    const took = performance.now() - t0;
    expect(sized.error).toBeUndefined();
    expect(took).toBeLessThan(200);
    const last = curveById(sized.sketch, r.curveIds[118]);
    // (A circle's size is its diameter.)
    expect(last?.type === "circle" ? last.radius : 0).toBeCloseTo(2, 9);
    // Every copy is exactly where it should be: copy i turned 3i° round (10, 0).
    const k = curveById(sized.sketch, r.curveIds[29])!;
    const p = k.type === "circle" ? pointPos(sized.sketch, k.center) : [0, 0];
    expect(p[0]).toBeCloseTo(10, 9);
    expect(p[1]).toBeCloseTo(10, 9);
    const t1 = performance.now();
    dragPoint(sized.sketch, centre, 12, 1);
    expect(performance.now() - t1).toBeLessThan(200);
  });

  it("a copy held by something else stays in the solve, and a copy can be dragged (the pattern goes with it)", () => {
    const { s, centre, circle } = setup();
    const r = patternCurves(s, [circle], { kind: "circular", count: 4, angle: 360, centre: [10, 0], centreId: centre });
    // A dimension on the second copy's centre, from the origin: it can't move independently, so the whole pattern answers to it.
    const copy = curveById(r.sketch, r.curveIds[1])!;
    const cc = copy.type === "circle" ? copy.center : "";
    const dim = addDimension(r.sketch, [ORIGIN, cc]);
    expect(dim.error).toBeUndefined();
    expect(pointPos(dim.sketch, cc)[0]).toBeCloseTo(0, 6);
    const dragged = dragPoint(r.sketch, cc, -2, 0);
    const [ox, oy] = pointPos(dragged, (curveById(dragged, circle) as { center: string }).center);
    const [cx, cy] = pointPos(dragged, centre);
    const [px, py] = pointPos(dragged, cc);
    // Still the original turned 180° round the centre, and the centre stays where it was (the original moves instead).
    expect(px).toBeCloseTo(2 * cx - ox, 6);
    expect(py).toBeCloseTo(2 * cy - oy, 6);
    expect(cx).toBeCloseTo(10, 6);
    expect(cy).toBeCloseTo(0, 6);
    expect(px).toBeCloseTo(-2, 6);
    expect(ox).toBeCloseTo(22, 6);
  });

  it("the origin is still the default centre", () => {
    const { s, circle } = setup();
    const opts = readPatternSettings(s, { patternKind: "circular", patternCount: 2, patternSpacing: "10", patternAngle: "360", patternCentre: "origin" });
    if (typeof opts === "string") throw new Error(opts);
    const r = patternCurves(s, [circle], opts);
    const k = curveById(r.sketch, r.curveIds[0])!;
    const p = k.type === "circle" ? pointPos(r.sketch, k.center) : [0, 0];
    expect(p[0]).toBeCloseTo(-20, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });
});

describe("part edges in a face sketch", () => {
  it("projects edges onto the sketch: lines, whole circles and arcs", () => {
    const frame = planeFrame({ kind: "face", origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], label: "Face" });
    const line = projectEdge(frame, { partId: "p", ref: { kind: "edge", curve: "LINE", a: [0, 0, 10], b: [30, 0, 10], mid: [15, 0, 10] } });
    expect(line).toMatchObject({ kind: "line", a: [0, 0], b: [30, 0] });
    const hole = projectEdge(frame, { partId: "p", ref: { kind: "edge", curve: "CIRCLE", a: [18, 10, 10], b: [18, 10, 10], mid: [12, 10, 10] } });
    expect(hole).toMatchObject({ kind: "circle", centre: [15, 10], radius: 3 });
    const arc = projectEdge(frame, { partId: "p", ref: { kind: "edge", curve: "CIRCLE", a: [5, 0, 10], b: [0, 5, 10], mid: [5 * Math.SQRT1_2, 5 * Math.SQRT1_2, 10] } });
    expect(arc?.kind).toBe("arc");
    expect(arc?.centre?.[0]).toBeCloseTo(0, 9);
    expect(arc?.radius).toBeCloseTo(5, 9);
    expect(arc?.start).toEqual([5, 0]);
    // An edge standing up out of the face can't be shown in it.
    expect(projectEdge(frame, { partId: "p", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [0, 0, 10], mid: [0, 0, 5] } })).toBeNull();
  });

  it("snaps to a face corner, a hole's centre and an edge's middle", () => {
    const refs = [...outline(40, 20), holeEdge([10, 10], 3)];
    const s = emptySketch();
    const corner = snapAt(s, 40.3, 19.8, { ...tol, refs });
    // The corner where two edges meet.
    expect(corner.placed.snap?.kind).toBe("ref");
    expect([corner.placed.x, corner.placed.y]).toEqual([40, 20]);
    const centre = snapAt(s, 10.2, 9.9, { ...tol, refs });
    expect(centre.placed.snap).toMatchObject({ kind: "ref", at: "centre" });
    expect(snapAt(s, 13.1, 10, { ...tol, refs }).hints).toEqual([[10, 10]]);
    const mid = snapAt(s, 20.2, 0.3, { ...tol, refs });
    expect(mid.placed).toMatchObject({ x: 20, y: 0, snap: { kind: "ref", at: "mid" } });
  });

  it("a line drawn from a face corner brings the edge in as a reference that holds the line's end", () => {
    const refs = outline(40, 20);
    const from = snapAt(emptySketch(), 40.2, 20.1, { ...tol, refs }).placed;
    const r = addLine(emptySketch(), from, at(60, 30));
    expect(r.error).toBeUndefined();
    const ref = r.sketch.curves.find((c) => c.id !== r.lineId)!;
    expect(ref.construction).toBe(true);
    expect("link" in ref && ref.link?.partId).toBe("box");
    const line = curveById(r.sketch, r.lineId) as SketchLine;
    expect(pointPos(r.sketch, line.p1)).toEqual([40, 20]);
    expect(analyzeSketch(r.sketch).definedPoints.has(line.p1)).toBe(true);
    // A reference isn't a shape to extrude.
    expect(findRegions(r.sketch).regions).toHaveLength(0);
  });

  it("references follow the part when it's resized, and so does what's constrained to them", () => {
    const refs = outline(40, 20);
    // A point at the middle of the right-hand edge, and a line from the top-right corner.
    const mid = snapAt(emptySketch(), 40.1, 10.2, { ...tol, refs }).placed;
    const p = addPoint(emptySketch(), mid);
    const from = snapAt(p.sketch, 40.2, 20.1, { ...tol, refs }).placed;
    const l = addLine(p.sketch, from, at(55, 35));
    const s = l.sketch;
    // The box is made 60 wide and 30 deep: its edges are found again where they are now.
    const now = outline(60, 30);
    const links: Record<string, RefEdge | null> = {};
    for (const c of s.curves) {
      if (!("link" in c) || !c.link) continue;
      const i = refs.findIndex((e) => e.pick.ref === (c.link as TopoPick).ref || JSON.stringify(e.pick.ref) === JSON.stringify(c.link!.ref));
      links[c.id] = now[i];
    }
    const moved = followLinks(s, links);
    expect(moved).not.toBe(s);
    const [px, py] = pointPos(moved, p.pointId);
    expect(px).toBeCloseTo(60, 6);
    expect(py).toBeCloseTo(15, 6);
    const line = curveById(moved, l.lineId) as SketchLine;
    const [lx, ly] = pointPos(moved, line.p1);
    expect(lx).toBeCloseTo(60, 6);
    expect(ly).toBeCloseTo(30, 6);
    // Following again changes nothing.
    expect(followLinks(moved, links)).toBe(moved);
  });

  it("an edge that's gone leaves its copy where it was, with a friendly note", () => {
    const refs = outline(40, 20);
    const u = linkEdge(emptySketch(), refs[1], true);
    const links = { [u.curveId]: null };
    expect(followLinks(u.sketch, links)).toBe(u.sketch);
    expect(lostLinksMessage(u.sketch, { edges: [], links })).toMatch(/1 edge this sketch uses has gone from the part, so it stays where it was/);
    expect(lostLinksMessage(u.sketch, { edges: refs, links: { [u.curveId]: refs[1] } })).toBeNull();
  });

  it("dimensions to a part edge: picking it brings it in, and the dimension follows the part", () => {
    const refs = outline(40, 20);
    const c = addCircle(emptySketch(), at(30, 12), 2);
    const hit = pickAt(c.sketch, 39.8, 5, 1, 0.6, refs);
    expect(hit).toEqual({ kind: "curve", id: "ref:1" });
    const b = bringIn(c.sketch, hit!.id, refs);
    expect(b.error).toBeUndefined();
    const k = curveById(b.sketch, b.id);
    expect(k?.type).toBe("line");
    expect(linkedPoints(b.sketch).size).toBe(2);
  });

  it("Use copies an edge in as real geometry, and Use all closes the outline so it can be extruded", () => {
    const refs = [...outline(40, 20), holeEdge([10, 10], 3)];
    const one = linkEdge(emptySketch(), refs[0], false);
    expect(one.sketch.curves[0].construction).toBe(false);
    // Using a reference already in the sketch makes it real instead of adding another.
    const asRef = linkEdge(emptySketch(), refs[0], true);
    const again = linkEdge(asRef.sketch, refs[0], false);
    expect(again.sketch.curves).toHaveLength(1);
    expect(again.sketch.curves[0].construction).toBe(false);
    const all = linkAllEdges(emptySketch(), refs);
    expect(all.curveIds).toHaveLength(5);
    const regions = findRegions(all.sketch).regions;
    expect(regions).toHaveLength(1);
    expect(regions[0].outer.area).toBeCloseTo(800, 6);
    expect(analyzeSketch(all.sketch).freedom).toBe(0);
  });

  it("the stand-in geometry has the edges' ends and centres", () => {
    const v = refSketch([lineEdge([0, 0], [10, 0]), holeEdge([5, 5], 2)]);
    expect(v.points.map((p) => p.id)).toEqual(["ref:0:a", "ref:0:b", "ref:1:c"]);
    expect(v.curves.map((c) => c.id)).toEqual(["ref:0", "ref:1"]);
  });
});

describe("saved files", () => {
  it("keep a sketch's face and its linked edges, and old sketches open unchanged", () => {
    const face: TopoPick = { partId: "f1", ref: { kind: "face", surface: "PLANE", center: [5, 5, 10], normal: [0, 0, 1] } };
    const plane = planeOnFace([0, 0, 1], [5, 5, 10], "Face of Part 1", face);
    expect(parsePlane(JSON.parse(JSON.stringify(plane)))).toEqual(plane);
    const old = { kind: "face", origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], label: "Face" };
    expect(parsePlane(old)).toEqual(old);
    const u = linkEdge(emptySketch(), lineEdge([0, 0], [10, 0]), true);
    const back = parseSketchData(JSON.parse(JSON.stringify(u.sketch))) as SketchData;
    expect(back).toEqual(u.sketch);
    const centre = addPoint(emptySketch(), at(5, 0));
    const c = addCircle(centre.sketch, at(9, 0), 1);
    const pat = patternCurves(c.sketch, [c.circleId], { kind: "circular", count: 3, angle: 360, centre: [5, 0], centreId: centre.pointId });
    expect(parseSketchData(JSON.parse(JSON.stringify(pat.sketch)))).toEqual(pat.sketch);
  });
});

describe("tidying and finding again", () => {
  it("drops references nothing uses when the sketch closes, and keeps the ones in use", () => {
    const refs = outline(40, 20);
    // A line from one corner (that edge is in use), and an edge brought in then left unused.
    const from = snapAt(emptySketch(), 40.2, 0.1, { ...tol, refs }).placed;
    const l = addLine(emptySketch(), from, at(60, -10));
    const spare = linkEdge(l.sketch, refs[2], true);
    expect(spare.sketch.curves).toHaveLength(3);
    const tidy = pruneReferences(spare.sketch);
    expect(tidy.curves).toHaveLength(2);
    expect(tidy.curves.some((c) => c.id === spare.curveId)).toBe(false);
    expect(tidy.points).toHaveLength(spare.sketch.points.length - 2);
    expect(pruneReferences(tidy)).toBe(tidy);
    // Real copies (Use) always stay.
    const used = linkEdge(emptySketch(), holeEdge([5, 5], 2), false);
    expect(pruneReferences(used.sketch)).toBe(used.sketch);
  });

  it("finds an edge again only when it's clearly the same one", () => {
    const edge = (x: number): EdgeRef => ({ kind: "edge", curve: "LINE", a: [x, 0, 10], b: [x, 20, 10], mid: [x, 10, 10] });
    expect(strictMatch(edge(40), [edge(0), edge(40.5)], 46)).toBe(1);
    // 15 mm away on a 46 mm part: gone, not followed.
    expect(strictMatch(edge(40), [edge(0), edge(55)], 46)).toBeNull();
    // Two equally good candidates: can't tell, so gone.
    expect(strictMatch(edge(40), [edge(38), edge(42)], 46)).toBeNull();
  });
});
