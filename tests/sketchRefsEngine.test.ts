/**
 * Sketches using other sketches and parts off their plane, with the real
 * OpenCascade engine: what the sketch being edited is offered, and references
 * following when the part or the other sketch changes.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { linkEdge, linkPoint, lostLinksMessage, type RefEdge } from "../src/sketch/links";
import { addCircle, addLine, curveById, pointPos, type Placed } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { snapAt } from "../src/sketch/snaps";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const TOP: SketchPlane = { kind: "default", name: "Top" };
const FRONT: SketchPlane = { kind: "default", name: "Front" };
const sketch = (id: string, plane: SketchPlane, data: SketchData, name = id): Feature => ({ id, name, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
/** A box w × 20 × 10 with its corner at (0, 0, 5): off the Top plane (z = 5 to 15). */
const box = (w: number): Feature => ({ ...feature("box", { width: w, depth: 20, height: 10, x: 0, y: 0, z: 5 }), id: "box", name: "Box" });

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuildStudios([{ id: "main", features }]);
}

const r6 = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);
const tol = { pointTol: 1, curveTol: 0.5 };

describe("a part off the sketch's plane", () => {
  it("offers the box's corners and edges seen from above, only to the sketch being edited", () => {
    const features = [box(40), sketch("sk", TOP, emptySketch())];
    const r = build(features);
    expect(r.featureErrors).toEqual({});
    const cands = engine.sketchCandidates("main", "sk")!;
    // Seen from above, every corner is one of the four (0,0), (40,0), (40,20), (0,20); the upright edges are single points there.
    const corners = new Set(cands.flatMap((e) => (e.kind === "point" ? [e.a] : e.kind === "line" ? [e.a, e.b] : [])).map((p) => r6(p).join(",")));
    expect([...corners].sort()).toEqual(["0,0", "0,20", "40,0", "40,20"]);
    expect(cands.filter((e) => e.kind === "point")).toHaveLength(4);
    expect(cands.filter((e) => e.kind === "line")).toHaveLength(8);
    expect(cands.every((e) => e.pick?.partId === "box" && e.project)).toBe(true);
    // Nothing is worked out until a sketch asks (opening one).
    build(features);
    expect(engine.candidateRuns).toBe(0);
    expect(engine.sketchCandidates("main", "nope")).toBeNull();
  });

  it("a line to the box's far corner, and one along its top edge, follow the box when it's made wider", () => {
    build([box(40), sketch("sk", TOP, emptySketch())]);
    const refs = engine.sketchCandidates("main", "sk")!;
    const corner = snapAt(emptySketch(), 39.7, 19.8, { ...tol, refs }).placed;
    // An end of one of the edges meeting there (or the upright edge seen end-on).
    expect(corner.snap?.kind).toBe("ref");
    expect(["a", "b"]).toContain(corner.snap?.kind === "ref" ? corner.snap.at : "");
    expect([corner.x, corner.y]).toEqual([40, 20]);
    const l = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, corner);
    const line = curveById(l.sketch, l.lineId) as SketchLine;
    // And a point onto the box's front top edge (y = 0), part way along: the edge comes in, seen from above.
    const front = refs.find((e) => e.kind === "line" && Math.abs(e.a[1]) < 1e-9 && Math.abs(e.b[1]) < 1e-9 && e.pick!.ref.kind === "edge" && e.pick!.ref.a[2] > 10)!;
    const brought = linkEdge(l.sketch, front, true);
    expect(brought.error).toBeUndefined();
    const data = brought.sketch;

    // The box is made 60 wide: the corner the line goes to is now at (60, 20), and the top edge runs to 60.
    const r = build([box(60), sketch("sk", TOP, data)]);
    expect(r.featureErrors).toEqual({});
    const info = r.sketchLinks!.sk;
    expect(info.pointLinks![line.p2]).toBeDefined();
    expect(r6(info.pointLinks![line.p2]!)).toEqual([60, 20]);
    expect(lostLinksMessage(data, info)).toBeNull();
    const now = info.sketch!.data;
    expect(r6(pointPos(now, line.p2))).toEqual([60, 20]);
    expect(r6(pointPos(now, line.p1))).toEqual([0, 0]);
    const edge = curveById(now, brought.curveId) as SketchLine;
    const xs = [pointPos(now, edge.p1)[0], pointPos(now, edge.p2)[0]].map((v) => Math.round(v * 1e6) / 1e6).sort((a, b) => a - b);
    expect(xs).toEqual([0, 60]);
  });

  it("says plainly when the part a point came from has gone", () => {
    build([box(40), sketch("sk", TOP, emptySketch())]);
    const corner = engine.sketchCandidates("main", "sk")!.find((e) => e.kind === "point" && r6(e.a).join(",") === "40,20")!;
    const p = linkPoint(emptySketch(), corner, "a");
    const r = build([sketch("sk", TOP, p.sketch)]);
    expect(r.sketchLinks!.sk.pointLinks![p.pointId]).toBeNull();
    expect(r.featureErrors.sk).toBe(
      "A part edge this sketch uses can't be found any more, so its copy stays where it was. Edit the sketch and delete it (shown in the sketch panel), or use other edges.",
    );
  });
});

describe("another sketch", () => {
  /** Sketch A on Top: a circle r4 at (cx, 10) and a line (0, 0)→(15, 5). */
  function sketchA(cx: number): { f: Feature; circle: string; centre: string; line: string } {
    const c = addCircle(emptySketch(), { x: cx, y: 10 }, 4);
    const l = addLine(c.sketch, { x: 0, y: 0 }, { x: 15, y: 5 });
    const circle = c.circleId;
    const centre = (curveById(c.sketch, circle) as { center: string }).center;
    return { f: sketch("skA", TOP, l.sketch, "Sketch A"), circle, centre, line: l.lineId };
  }

  it("a sketch on Front uses Sketch A's circle centre and line; they follow when Sketch A changes", () => {
    const a = sketchA(10);
    build([a.f, sketch("skB", FRONT, emptySketch())]);
    const refs: RefEdge[] = engine.sketchCandidates("main", "skB")!;
    // A's circle is square to Front, so its centre is offered as a point at (10, 0); A's line as the line (0,0)→(15,0).
    const centre = snapAt(emptySketch(), 10.2, 0.3, { ...tol, refs }).placed;
    expect(centre.snap).toMatchObject({ kind: "ref", at: "a" });
    const l = addLine(emptySketch(), { x: 0, y: 8 }, centre);
    const line = curveById(l.sketch, l.lineId) as SketchLine;
    const aLine = refs.find((e) => e.kind === "line" && e.source?.item === a.line)!;
    const used = linkEdge(l.sketch, aLine, false);
    expect(used.error).toBeUndefined();
    const end = l.sketch.points.find((p) => p.id === line.p2)!;
    expect(end.link).toEqual({ sketch: "skA", item: a.centre });

    // Sketch A's circle moves to x = 25 and its line is redrawn (0,0)→(30,5): Sketch B follows.
    expect([r6(aLine.a), r6(aLine.b)]).toEqual([
      [0, 0],
      [15, 0],
    ]);
    const moved = sketchA(25);
    const movedData: SketchData = {
      ...moved.f.sketch!.data,
      points: moved.f.sketch!.data.points.map((p) => (p.id === (curveById(moved.f.sketch!.data, moved.line) as SketchLine).p2 ? { ...p, x: 30 } : p)),
    };
    // Keep the ids Sketch B refers to (same ids, new places).
    const renamed = JSON.parse(JSON.stringify(movedData).split(moved.centre).join(a.centre).split(moved.line).join(a.line).split(moved.circle).join(a.circle)) as SketchData;
    const r = build([{ ...a.f, sketch: { plane: TOP, data: renamed } }, sketch("skB", FRONT, used.sketch)]);
    expect(r.featureErrors).toEqual({});
    const now = r.sketchLinks!.skB.sketch!.data;
    expect(r6(pointPos(now, line.p2))).toEqual([25, 0]);
    expect(r6(pointPos(now, line.p1))).toEqual([0, 8]);
    const copy = curveById(now, used.curveId) as SketchLine;
    expect([r6(pointPos(now, copy.p1)), r6(pointPos(now, copy.p2))]).toEqual([
      [0, 0],
      [30, 0],
    ]);
  });

  it("only sketches earlier in the list count: a later one is offered marked as such, and a link to one is reported", () => {
    const a = sketchA(10);
    // Sketch B first, then A.
    build([sketch("skB", FRONT, emptySketch()), a.f]);
    const cands = engine.sketchCandidates("main", "skB")!;
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((e) => e.source?.later && e.source.name === "Sketch A")).toBe(true);
    // A link made while A was earlier, after B is moved above A: not found, said plainly.
    build([a.f, sketch("skB", FRONT, emptySketch())]);
    const p = linkPoint(emptySketch(), engine.sketchCandidates("main", "skB")!.find((e) => e.kind === "point")!, "a");
    expect(p.error).toBeUndefined();
    const r = build([sketch("skB", FRONT, p.sketch), a.f]);
    expect(r.sketchLinks!.skB.pointLinks![p.pointId]).toBeNull();
    expect(r.featureErrors.skB).toBe(
      "1 thing this sketch takes from other sketches can't be found any more (that sketch, or the shape in it, was deleted or turned off, or moved below this one in the feature list), so its copy stays where it was. Edit the sketch and delete it (shown in the sketch panel), or move that sketch back above this one.",
    );
  });

  it("opening or closing a sketch rebuilds nothing; what it's offered is worked out once while nothing before it changes", () => {
    const a = sketchA(10);
    engine?.dispose();
    engine = new GeometryEngine();
    const features = [box(40), a.f, sketch("skB", FRONT, emptySketch())];
    // A second Part Studio deriving the box from this one.
    const derived: Feature = { ...feature("derived", {}), id: "der", name: "Derived", derived: { studioId: "main", partId: "box" } };
    const studios = (f: Feature[]) => [
      { id: "main", features: f },
      { id: "other", features: [derived] },
    ];
    const first = engine.rebuildStudios(studios(features));
    expect(first.rebuilt).toEqual(["main", "other"]);
    // Opening Sketch B: the app asks for what it can snap to — nothing is built again.
    const one = engine.sketchCandidatesSince("main", "skB")!;
    expect(one.list!.length).toBeGreaterThan(0);
    expect(engine.candidateRuns).toBe(1);
    // The same design again (as when the sketch is opened, then closed unchanged): nothing rebuilt, here or in the other studio.
    expect(engine.rebuildStudios(studios(features)).rebuilt).toEqual([]);
    // Asked again with the list it has: same number, no list sent.
    expect(engine.sketchCandidatesSince("main", "skB", one.version)).toEqual({ version: one.version });
    // Drawing in Sketch B rebuilds that studio (as always), but the list is reused, not worked out again.
    const drawn = addLine(emptySketch(), { x: 1, y: 1 } as Placed, { x: 5, y: 5 } as Placed).sketch;
    const two = engine.rebuildStudios(studios([box(40), a.f, sketch("skB", FRONT, drawn)]));
    expect(two.rebuilt).toContain("main");
    expect(engine.sketchCandidatesSince("main", "skB", one.version)).toEqual({ version: one.version });
    expect(engine.candidateRuns).toBe(1);
    // Changing the box changes it.
    engine.rebuildStudios(studios([box(50), a.f, sketch("skB", FRONT, drawn)]));
    const three = engine.sketchCandidatesSince("main", "skB", one.version)!;
    expect(three.version).not.toBe(one.version);
    expect(three.list).not.toEqual(one.list);
    expect(engine.candidateRuns).toBe(2);
  });
});
