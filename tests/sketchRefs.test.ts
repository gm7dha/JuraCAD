/**
 * Using other sketches and parts' geometry in any sketch, seen square-on to it
 * (projected): what's offered, bringing points and curves in, following them,
 * refusing sketches further down the list, and saved files.
 */
import { describe, expect, it } from "vitest";

import type { EdgeRef, Vec3 } from "../src/geometry/topoRef";
import { followLinks, laterMessage, linkEdge, linkPoint, linkProblem, lostLinkIds, lostLinksMessage, pruneReferences, refSketch, type RefEdge, type SketchLinkInfo } from "../src/sketch/links";
import { addCircle, addDimension, addLine, addPoint, curveById, pointPos, type Placed } from "../src/sketch/ops";
import { circleCentre3, edgePoint3, seeEdge, seeSketchCurve, sketchPointAt, sketchRefs, type SourceSketch } from "../src/sketch/projected";
import { planeFrame, planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { attachPoint, bringIn, pickAt, snapAt } from "../src/sketch/snaps";
import { parseSketchData } from "../src/sketch/validate";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";

type P2 = [number, number];
const r6 = (p: P2 | null | undefined): P2 | null => (p ? [Math.round(p[0] * 1e6) / 1e6 + 0, Math.round(p[1] * 1e6) / 1e6 + 0] : null);
const TOP: SketchPlane = { kind: "default", name: "Top" };
const FRONT = planeFrame({ kind: "default", name: "Front" });
const tol = { pointTol: 1, curveTol: 0.5 };

/**
 * A sketch on Top: a line (0,0)→(10,5), a circle r2 at (5,5), a lone point at
 * (3,4) and a line straight up the y axis (seen end-on from Front).
 */
function topSketch(): { src: SourceSketch; line: string; circle: string; up: string; point: string } {
  const l = addLine(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 5 });
  const c = addCircle(l.sketch, { x: 5, y: 5 }, 2);
  const p = addPoint(c.sketch, { x: 3, y: 4 });
  const u = addLine(p.sketch, { x: 20, y: 0 }, { x: 20, y: 10 });
  return { src: { id: "skA", name: "Sketch 1", plane: TOP, data: u.sketch }, line: l.lineId, circle: c.circleId, up: u.lineId, point: p.pointId };
}

describe("other sketches seen in a sketch", () => {
  it("a sketch on Top seen from Front: lines stay lines, a circle at a slant gives its centre, a line seen end-on a point", () => {
    const { src, line, circle, up, point } = topSketch();
    const refs = sketchRefs(src, FRONT);
    const byItem = (item: string) => refs.find((r) => r.source?.item === item);
    const l = byItem(line)!;
    expect(l.kind).toBe("line");
    expect([r6(l.a), r6(l.b)]).toEqual([[0, 0], [10, 0]]);
    expect(l.source?.ends).toEqual({ a: (curveById(src.data, line) as SketchLine).p1, b: (curveById(src.data, line) as SketchLine).p2 });
    // The circle is on a plane square to Front, so only its centre (5, 0) is offered.
    expect(byItem(circle)).toBeUndefined();
    const centre = refs.find((r) => r.kind === "point" && r.source?.item === (curveById(src.data, circle) as { center: string }).center)!;
    expect(r6(centre.a)).toEqual([5, 0]);
    // The lone point (3, 4) → (3, 0); the line up the y axis → a single point (20, 0).
    expect(r6(byItem(point)!.a)).toEqual([3, 0]);
    const upEnd = refs.find((r) => r.kind === "point" && r.source?.item === (curveById(src.data, up) as SketchLine).p1)!;
    expect(r6(upEnd.a)).toEqual([20, 0]);
    expect(refs.every((r) => r.source?.sketch === "skA" && r.source.name === "Sketch 1" && !r.source.later)).toBe(true);
  });

  it("on a parallel plane a circle stays a circle (and an arc keeps its way round, even seen from the back)", () => {
    const { src, circle } = topSketch();
    // A plane 7 above Top, facing up (same way) and one facing down.
    const up = planeFrame(planeOnFace([0, 0, 1], [0, 0, 7], "Face"));
    const c = seeSketchCurve(src, circle, up)!;
    expect(c.kind).toBe("circle");
    expect(c.radius).toBeCloseTo(2, 12);
    const centreUp = c.centre!;
    // Whatever the face plane's own origin, the centre is where (5, 5, 7) is in it.
    const frame = up;
    const world: Vec3 = [frame.origin[0] + centreUp[0] * frame.u[0] + centreUp[1] * frame.v[0], frame.origin[1] + centreUp[0] * frame.u[1] + centreUp[1] * frame.v[1], 7];
    expect(world.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 5, 7]);
    // An arc from (7, 5) round to (3, 5) through (5, 7) — seen from below it runs the other way round.
    const arcSrc: SourceSketch = { id: "skB", plane: TOP, data: emptySketch() };
    const withArc = (() => {
      const s: SketchData = {
        points: [
          { id: "c", x: 5, y: 5 },
          { id: "s", x: 7, y: 5 },
          { id: "e", x: 3, y: 5 },
        ],
        curves: [{ id: "arc", type: "arc", center: "c", start: "s", end: "e", construction: false }],
        constraints: [],
      };
      return { ...arcSrc, data: s };
    })();
    const below = planeFrame(planeOnFace([0, 0, -1], [0, 0, -3], "Under"));
    const a = seeSketchCurve(withArc, "arc", below)!;
    expect(a.kind).toBe("arc");
    expect(a.source?.ends).toEqual({ a: "s", b: "e", c: "c" });
    // Anticlockwise as seen from below: from the end to the start.
    expect(r6(a.start)).toEqual(r6(a.b));
    expect(r6(a.end)).toEqual(r6(a.a));
    // Its middle is (5, 7) wherever that is on the plane below.
    const m = a.mid;
    const back: Vec3 = [0, 1, 2].map((k) => below.origin[k] + m[0] * below.u[k] + m[1] * below.v[k]) as Vec3;
    expect([back[0], back[1]].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 7]);
  });

  it("points follow their sketch: a point, and the middle of a line", () => {
    const { src, point, line } = topSketch();
    expect(r6(sketchPointAt(src, { sketch: "skA", item: point }, FRONT))).toEqual([3, 0]);
    expect(r6(sketchPointAt(src, { sketch: "skA", item: line, end: "mid" }, FRONT))).toEqual([5, 0]);
    expect(sketchPointAt(src, { sketch: "skA", item: "gone" }, FRONT)).toBeNull();
  });
});

describe("part edges seen square-on", () => {
  const pick = (ref: EdgeRef) => ({ partId: "box", ref });
  it("a slanting straight edge stays straight; one pointing at the sketch is a single point", () => {
    const slant = seeEdge(planeFrame(TOP), pick({ kind: "edge", curve: "LINE", a: [0, 0, 0], b: [10, 0, 10], mid: [5, 0, 5] }))!;
    expect(slant.kind).toBe("line");
    expect(slant.project).toBe(true);
    expect([r6(slant.a), r6(slant.b)]).toEqual([[0, 0], [10, 0]]);
    const upright = seeEdge(planeFrame(TOP), pick({ kind: "edge", curve: "LINE", a: [4, 6, 2], b: [4, 6, 12], mid: [4, 6, 7] }))!;
    expect(upright.kind).toBe("point");
    expect(r6(upright.a)).toEqual([4, 6]);
  });

  it("a circle flat to the sketch (above it) stays a circle; one at a slant can be snapped to at its centre", () => {
    const flatRef: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [13, 10, 20], b: [13, 10, 20], mid: [7, 10, 20] };
    const samples: Vec3[] = Array.from({ length: 9 }, (_, i) => [10 + 3 * Math.cos((i / 8) * 2 * Math.PI), 10 + 3 * Math.sin((i / 8) * 2 * Math.PI), 20]);
    const flat = seeEdge(planeFrame(TOP), pick(flatRef), samples)!;
    expect(flat.kind).toBe("circle");
    expect(r6(flat.centre)).toEqual([10, 10]);
    expect(flat.radius).toBeCloseTo(3, 9);
    // A circle round the x axis (in the YZ plane), centre (0, 10, 5), r 3: seen from Top it's squashed flat.
    const slantRef: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [0, 13, 5], b: [0, 13, 5], mid: [0, 7, 5] };
    const ring: Vec3[] = Array.from({ length: 9 }, (_, i) => [0, 10 + 3 * Math.cos((i / 8) * 2 * Math.PI), 5 + 3 * Math.sin((i / 8) * 2 * Math.PI)]);
    const slant = seeEdge(planeFrame(TOP), pick(slantRef), ring)!;
    expect(slant.kind).toBe("curve");
    expect(r6(slant.centre)).toEqual([0, 10]);
    // Its centre is offered as a point to snap to.
    const virt = refSketch([slant]);
    expect(virt.points.some((p) => p.id === "ref:0:c" && Math.abs(p.x) < 1e-9 && Math.abs(p.y - 10) < 1e-9)).toBe(true);
  });

  it("finds a round edge's centre in 3D (whole circles and arcs)", () => {
    expect(circleCentre3({ kind: "edge", curve: "CIRCLE", a: [13, 10, 20], b: [13, 10, 20], mid: [7, 10, 20] })).toEqual([10, 10, 20]);
    const c = circleCentre3({ kind: "edge", curve: "CIRCLE", a: [5, 0, 0], b: [0, 5, 0], mid: [5 * Math.SQRT1_2, 5 * Math.SQRT1_2, 0] })!;
    expect(c.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 0, 0]);
    expect(edgePoint3({ kind: "edge", curve: "LINE", a: [0, 0, 0], b: [10, 0, 10], mid: [5, 0, 5] }, "b")).toEqual([10, 0, 10]);
    expect(edgePoint3({ kind: "edge", curve: "LINE", a: [0, 0, 0], b: [10, 0, 10], mid: [5, 0, 5] }, "centre")).toBeNull();
  });
});

describe("bringing in and following", () => {
  const corner: RefEdge = {
    pick: { partId: "box", ref: { kind: "edge", curve: "LINE", a: [40, 20, 5], b: [40, 20, 15], mid: [40, 20, 10] } },
    project: true,
    kind: "point",
    a: [40, 20],
    b: [40, 20],
    mid: [40, 20],
  };

  it("snapping to a part's corner off the sketch brings in just that point, fixed and following it", () => {
    const at = snapAt(emptySketch(), 39.6, 20.3, { ...tol, refs: [corner] });
    expect(at.placed.snap).toMatchObject({ kind: "ref", at: "a" });
    expect([at.placed.x, at.placed.y]).toEqual([40, 20]);
    const l = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at.placed);
    const line = curveById(l.sketch, l.lineId) as SketchLine;
    const end = l.sketch.points.find((p) => p.id === line.p2)!;
    expect(end.link).toEqual({ partId: "box", ref: corner.pick!.ref, end: "a" });
    expect(l.sketch.constraints.some((k) => k.type === "fix" && k.refs[0] === end.id)).toBe(true);
    // No whole edge came in: just the point.
    expect(l.sketch.curves).toHaveLength(1);
    // The engine finds it at (60, 20) now: the line's end goes there.
    const moved = followLinks(l.sketch, {}, { [end.id]: [60, 20] });
    expect(pointPos(moved, end.id)).toEqual([60, 20]);
    expect(pointPos(moved, line.p1)).toEqual([0, 0]);
    // Snapping again reuses the same point.
    const again = linkPoint(l.sketch, corner, "a");
    expect(again.pointId).toBe(end.id);
  });

  it("a point can be dragged onto another sketch's point, and dimensioned to one by clicking it", () => {
    const { src, point } = topSketch();
    const refs = sketchRefs(src, FRONT);
    const l = addLine(emptySketch(), { x: 0, y: 8 }, { x: 6, y: 8 });
    const line = curveById(l.sketch, l.lineId) as SketchLine;
    const lone = refs.findIndex((r) => r.source?.item === point);
    const drop = snapAt(l.sketch, 3.2, 0.3, { ...tol, refs });
    expect(drop.placed.snap).toMatchObject({ kind: "ref", at: "a" });
    const joined = attachPoint(l.sketch, line.p1, drop.placed.snap!);
    expect(joined.error).toBeUndefined();
    const linked = joined.sketch.points.find((p) => p.link);
    expect(linked?.link).toEqual({ sketch: "skA", item: point });
    // Clicking it with the dimension tool brings it in too (as a point).
    const hit = pickAt(l.sketch, 3.1, 0.1, 1, 0.5, refs);
    expect(hit?.id).toBe(`ref:${lone}:a`);
    const r = bringIn(l.sketch, hit!.id, refs);
    expect(r.error).toBeUndefined();
    expect(r.sketch.points.find((p) => p.id === r.id)?.link).toEqual({ sketch: "skA", item: point });
    const dim = addDimension(r.sketch, [line.p2, r.id]);
    expect(dim.error).toBeUndefined();
  });

  it("clicking another sketch's line brings the line in, following it (drawing near it doesn't tie shapes to it)", () => {
    const { src, line } = topSketch();
    const refs = sketchRefs(src, FRONT);
    // Drawing near the line (away from its points) leaves the point free…
    expect(snapAt(emptySketch(), 7, 0.2, { ...tol, refs }).placed.snap).toBeNull();
    // …clicking it (to dimension or constrain to it) brings it in.
    const hit = pickAt(emptySketch(), 7, 0.2, 1, 0.5, refs);
    expect(hit?.kind).toBe("curve");
    const inLine = bringIn(emptySketch(), hit!.id, refs);
    expect(inLine.error).toBeUndefined();
    const p = addPoint(inLine.sketch, { x: 7, y: 0, snap: { kind: "curve", id: inLine.id } });
    const brought = p.sketch.curves.find((c) => c.type === "line" && c.link);
    expect(brought && "link" in brought ? brought.link : null).toEqual({ sketch: "skA", item: line });
    expect(brought?.construction).toBe(true);
    // The other sketch's line is now along y = 3 in this sketch (say it moved): the copy and the point on it follow.
    const now: RefEdge = { ...refs.find((r) => r.source?.item === line)!, a: [0, 3], b: [10, 3], mid: [5, 3] };
    const moved = followLinks(p.sketch, { [brought!.id]: now });
    expect(pointPos(moved, p.pointId)[1]).toBeCloseTo(3, 6);
  });

  it("refuses things from a sketch further down the list, saying why", () => {
    const { src } = topSketch();
    const refs = sketchRefs({ ...src, later: true }, FRONT);
    expect(refs.every((r) => r.source?.later)).toBe(true);
    const msg = laterMessage(refs[0]);
    expect(msg).toBe('"Sketch 1" comes after this sketch in the feature list, so this sketch can\'t use it (they\'d depend on each other). Drag this sketch below it in the feature list first.');
    const hit = pickAt(emptySketch(), 3.1, 0.1, 1, 0.5, refs);
    expect(bringIn(emptySketch(), hit!.id, refs).error).toBe(msg);
    const line = refs.find((r) => r.kind === "line")!;
    expect(linkEdge(emptySketch(), line, true).error).toBe(msg);
    expect(linkPoint(emptySketch(), line, "a").error).toBe(msg);
  });

  it("says plainly when what a sketch takes from another sketch has gone, and lets you select those copies", () => {
    const { src, point, line } = topSketch();
    const refs = sketchRefs(src, FRONT);
    const a = linkPoint(emptySketch(), refs.find((r) => r.source?.item === point)!, "a");
    const b = linkEdge(a.sketch, refs.find((r) => r.source?.item === line)!, false);
    const info: SketchLinkInfo = { edges: [], links: { [b.curveId]: null }, pointLinks: { [a.pointId]: null } };
    expect(lostLinksMessage(b.sketch, info)).toBe(
      "2 things this sketch takes from other sketches can't be found any more (that sketch, or the shape in it, was deleted or turned off, or moved below this one in the feature list), so their copies stay where they were. Delete them, or move that sketch back above this one.",
    );
    expect(linkProblem(info, b.sketch)).toBe(
      "2 things this sketch takes from other sketches can't be found any more (that sketch, or the shape in it, was deleted or turned off, or moved below this one in the feature list), so their copies stay where they were. Edit the sketch and delete them (shown in the sketch panel), or move that sketch back above this one.",
    );
    expect(lostLinkIds(b.sketch, info).sort()).toEqual([b.curveId, a.pointId].sort());
  });

  it("drops points brought in that nothing uses when the sketch closes, keeping used ones", () => {
    const { src, point } = topSketch();
    const refs = sketchRefs(src, FRONT);
    const lone = refs.find((r) => r.source?.item === point)!;
    const a = linkPoint(emptySketch(), lone, "a");
    expect(pruneReferences(a.sketch).points).toHaveLength(0);
    expect(pruneReferences(a.sketch).constraints).toHaveLength(0);
    const used = addLine(a.sketch, { x: 0, y: 0 }, { x: 3, y: 0, snap: { kind: "point", id: a.pointId } } as Placed);
    expect(pruneReferences(used.sketch)).toBe(used.sketch);
    const dimmed = addDimension(a.sketch, ["origin", a.pointId]);
    expect(pruneReferences(dimmed.sketch).points.map((p) => p.id)).toEqual([a.pointId]);
  });
});

describe("picking", () => {
  it("the sketch's own lines come before points from elsewhere; the face's own corners still come first", () => {
    const l = addLine(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 });
    const elsewhere: RefEdge = { kind: "point", a: [5, 0.2], b: [5, 0.2], mid: [5, 0.2], source: { sketch: "skA", item: "p", ends: { a: "p" } } };
    expect(pickAt(l.sketch, 5, 0.1, 1, 0.5, [elsewhere])).toEqual({ kind: "curve", id: l.lineId });
    // Where the sketch has nothing, the point from elsewhere is picked.
    expect(pickAt(emptySketch(), 5, 0.1, 1, 0.5, [elsewhere])?.id).toBe("ref:0:a");
    const faceCorner: RefEdge = { pick: { partId: "box", ref: { kind: "edge", curve: "LINE", a: [5, 0.2, 0], b: [5, 9, 0], mid: [5, 4.6, 0] } }, kind: "line", a: [5, 0.2], b: [5, 9], mid: [5, 4.6] };
    expect(pickAt(l.sketch, 5, 0.1, 1, 0.5, [faceCorner])?.id).toBe("ref:0:a");
    // The same corner seen from elsewhere too (listed after the face's edges): the face's own is used, bringing in its edge.
    const sameSpot: RefEdge = { pick: { partId: "box", ref: { kind: "edge", curve: "LINE", a: [5, 0.2, 0], b: [5, 0.2, -10], mid: [5, 0.2, -5] } }, project: true, kind: "point", a: [5, 0.2], b: [5, 0.2], mid: [5, 0.2] };
    const refs = [faceCorner, sameSpot];
    expect(pickAt(emptySketch(), 5, 0.25, 1, 0.5, refs)?.id).toBe("ref:0:a");
    const at = snapAt(emptySketch(), 5, 0.25, { ...tol, refs }).placed;
    expect(at.snap).toMatchObject({ kind: "ref", at: "a", edge: faceCorner });
    const p = addPoint(emptySketch(), at);
    expect(p.sketch.curves.some((c) => "link" in c && c.link && "partId" in c.link && !c.link.project)).toBe(true);
  });
});

describe("saved files", () => {
  it("keep links to other sketches and parts' points, and old sketches read the same as before", () => {
    const { src, point, line } = topSketch();
    const refs = sketchRefs(src, FRONT);
    const corner = seeEdge(FRONT, { partId: "box", ref: { kind: "edge", curve: "LINE", a: [5, 0, 0], b: [5, 10, 0], mid: [5, 5, 0] } })!;
    let s = linkPoint(emptySketch(), refs.find((r) => r.source?.item === point)!, "a").sketch;
    s = linkEdge(s, refs.find((r) => r.source?.item === line)!, true).sketch;
    s = linkPoint(s, corner, "a").sketch;
    s = linkEdge(s, seeEdge(planeFrame(TOP), { partId: "box", ref: { kind: "edge", curve: "LINE", a: [0, 0, 3], b: [9, 0, 9], mid: [4.5, 0, 6] } })!, true).sketch;
    const back = parseSketchData(JSON.parse(JSON.stringify(s)));
    expect(back).toEqual(s);
    expect(back!.curves.some((c) => "link" in c && c.link && "project" in c.link && c.link.project)).toBe(true);
    // A sketch from before (no links at all) comes back exactly as it was.
    const old = addCircle(addLine(emptySketch(), { x: 0, y: 0 }, { x: 4, y: 0 }).sketch, { x: 1, y: 1 }, 2).sketch;
    expect(parseSketchData(JSON.parse(JSON.stringify(old)))).toEqual(old);
    // Nonsense links are dropped, not kept.
    const junk = parseSketchData({ points: [{ id: "p", x: 1, y: 2, link: { sketch: 5 } }], curves: [], constraints: [] });
    expect(junk!.points[0]).toEqual({ id: "p", x: 1, y: 2 });
  });
});
