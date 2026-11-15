import { describe, expect, it } from "vitest";

import { defaultParams } from "../src/model/features";
import { edgeCorner, isPlainNumber, manipArrowDir, manipPatch, manipPoint, manipulatorsFor, turnAbout, type Manipulator } from "../src/model/manipulators";
import type { Feature } from "../src/model/types";
import { setLengthUnit } from "../src/model/units";
import { addLine, addRectangle } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";
import type { FaceRef, TopoPick } from "../src/geometry/topoRef";
import { manipHandleAt, manipStep, startManipDrag } from "../src/viewport/manipulatorDrag";
import type { Ray } from "../src/viewport/transformDrag";

type V = [number, number, number];
const close = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < tol);

function draft(type: Feature["type"], extra: Partial<Feature> = {}, params: Record<string, string> = {}): Feature {
  return { id: "d1", name: "D", type, operation: "new", suppressed: false, params: { ...defaultParams(type), ...params }, ...extra };
}

/** A 20 × 10 rectangle with its corner at (10, 0): middle (20, 5). */
function rect(): SketchData {
  return addRectangle(emptySketch(), { x: 10, y: 0 }, { x: 30, y: 10 }).sketch;
}

const top = { sketch: { plane: { kind: "default" as const, name: "Top" as const }, data: rect() }, parts: [] };
/** A ray looking straight down -Y at the screen point (x, z) (an orthographic front view). */
const front = (x: number, z: number): Ray => ({ origin: [x, 100, z], dir: [0, -1, 0] });

describe("which manipulators a dialog shows, and where", () => {
  it("an Extrude's depth arrow sits on the profile's middle, pushed out by the depth", () => {
    const [m] = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "blind", flip: false } }, { depth: "15" }), top);
    expect(m.key).toBe("depth");
    expect(close(m.origin, [20, 5, 0])).toBe(true);
    expect(close(manipPoint(m), [20, 5, 15])).toBe(true);
    expect(m.flips).toBe(true);
    // Flipped: the other way.
    const [f] = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "blind", flip: true } }, { depth: "15" }), top);
    expect(close(manipPoint(f), [20, 5, -15])).toBe(true);
  });

  it("two sides get two arrows; symmetric ones both change the whole depth, half each way", () => {
    const two = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "blind", flip: false, second: true } }, { depth: "10", depth2: "4" }), top);
    expect(two.map((m) => m.id)).toEqual(["depth", "depth2"]);
    expect(two[0].flips).toBe(false);
    expect(close(manipPoint(two[1]), [20, 5, -4])).toBe(true);
    const sym = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "symmetric", flip: false } }, { depth: "10" }), top);
    expect(sym.map((m) => [m.id, m.key])).toEqual([["depth", "depth"], ["depthBack", "depth"]]);
    expect(close(manipPoint(sym[0]), [20, 5, 5])).toBe(true);
    expect(close(manipPoint(sym[1]), [20, 5, -5])).toBe(true);
    // Through all / up to: no arrow.
    expect(manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "throughAll", flip: false } }), top)).toEqual([]);
  });

  it("a size that uses a variable is shown greyed with a tooltip, never dragged", () => {
    const [m] = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "blind", flip: false } }, { depth: "5 + 5" }), top);
    expect(m.locked).toMatch(/variable/);
    expect(m.tip).toBe(m.locked);
    expect(isPlainNumber("12.5")).toBe(true);
    expect(isPlainNumber("0.5 in")).toBe(true);
    expect(isPlainNumber("90 deg")).toBe(true);
    expect(isPlainNumber("plate_t")).toBe(false);
    expect(isPlainNumber("-3")).toBe(false);
  });

  it("a Revolve's arc turns round its axis (right-handed; flipped the other way)", () => {
    const data = addLine(rect(), { x: 0, y: -5 }, { x: 0, y: 20 }, { construction: true }).sketch;
    const axis = data.curves.find((c) => c.type === "line" && c.construction)!.id;
    // On Front (x, z): profile middle (20, 0, 5), axis along +Z through the origin.
    const ctx = { sketch: { plane: { kind: "default" as const, name: "Front" as const }, data }, parts: [] };
    const [m] = manipulatorsFor(draft("revolve", { sketchRef: "s", revolve: { axis, flip: false } }, { angle: "90" }), ctx);
    expect(m.kind).toBe("arc");
    expect(close(m.axis!.dir, [0, 0, 1])).toBe(true);
    expect(close(manipPoint(m), [0, 20, 5])).toBe(true);
    expect(close(manipArrowDir(m), [-1, 0, 0])).toBe(true);
    const [f] = manipulatorsFor(draft("revolve", { sketchRef: "s", revolve: { axis, flip: true } }, { angle: "90" }), ctx);
    expect(close(manipPoint(f), [0, -20, 5])).toBe(true);
    // Two ways: each angle at most what the other leaves of a full turn.
    const two = manipulatorsFor(draft("revolve", { sketchRef: "s", revolve: { axis, flip: false, second: true } }, { angle: "200", angle2: "90" }), ctx);
    expect(two.map((x) => [x.id, x.max])).toEqual([["angle", 270], ["angle2", 160]]);
  });

  it("a Fillet's arrow sits on its first edge, pointing in between the two faces", () => {
    const faces: FaceRef[] = [
      { kind: "face", surface: "PLANE", center: [5, 5, 10], normal: [0, 0, 1] },
      { kind: "face", surface: "PLANE", center: [10, 5, 5], normal: [1, 0, 0] },
      { kind: "face", surface: "PLANE", center: [0, 5, 5], normal: [-1, 0, 0] },
    ];
    const pick: TopoPick = { partId: "p", ref: { kind: "edge", curve: "LINE", a: [10, 0, 10], b: [10, 10, 10], mid: [10, 5, 10] } };
    const c = edgeCorner(pick, faces)!;
    expect(close(c.into, [-Math.SQRT1_2, 0, -Math.SQRT1_2])).toBe(true);
    expect(c.fillet).toBeCloseTo(Math.SQRT2 - 1);
    expect(c.chamfer).toBeCloseTo(Math.SQRT1_2);
    const [m] = manipulatorsFor(draft("fillet", { picks: [pick] }, { radius: "2" }), { sketch: null, parts: [{ id: "p", faceRefs: faces }] });
    expect(m.key).toBe("radius");
    // At the rounded face's middle: r(√2 − 1) in from the corner.
    expect(close(manipPoint(m), [10 - (Math.SQRT2 - 1) * Math.SQRT1_2 * 2, 5, 10 - (Math.SQRT2 - 1) * Math.SQRT1_2 * 2])).toBe(true);
    const [ch] = manipulatorsFor(draft("chamfer", { picks: [pick] }), { sketch: null, parts: [{ id: "p", faceRefs: faces }] });
    expect(ch.key).toBe("distance");
    // A face picked (no edge): no arrow.
    expect(manipulatorsFor(draft("fillet", { picks: [{ partId: "p", ref: faces[0] }] }), { sketch: null, parts: [] })).toEqual([]);
  });

  it("Shell and Thicken arrows start on the first picked face", () => {
    const face: FaceRef = { kind: "face", surface: "PLANE", center: [0, 0, 10], normal: [0, 0, 1] };
    const ctx = { sketch: null, parts: [] };
    const [sh] = manipulatorsFor(draft("shell", { picks: [{ partId: "p", ref: face }] }, { thickness: "2" }), ctx);
    expect(close(manipPoint(sh), [0, 0, 8])).toBe(true);
    const [th] = manipulatorsFor(draft("thicken", { picks: [{ partId: "p", ref: face }] }, { thickness: "3" }), ctx);
    expect(close(manipPoint(th), [0, 0, 13])).toBe(true);
    const [fl] = manipulatorsFor(draft("thicken", { picks: [{ partId: "p", ref: face }], flipSide: true }, { thickness: "3" }), ctx);
    expect(close(manipPoint(fl), [0, 0, 7])).toBe(true);
    expect(manipulatorsFor(draft("box"), ctx)).toEqual([]);
  });

  it("turns points about a line right-handed", () => {
    expect(close(turnAbout([1, 0, 0], [0, 0, 0], [0, 0, 1], 90), [0, 1, 0])).toBe(true);
  });
});

describe("dragging a manipulator", () => {
  const depthArrow = (): Manipulator => manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "blind", flip: false } }, { depth: "15" }), top)[0];

  it("follows the pointer along its arrow, snapped to the step (Shift: not snapped)", () => {
    const m = depthArrow();
    const d = startManipDrag(m, front(20, 15))!;
    expect(d.move(front(23, 22.4), { snap: true, step: 1 })).toEqual({ value: 22, flipped: false });
    expect(d.move(front(23, 22.4), { snap: false, step: 1 })).toEqual({ value: 22.4, flipped: false });
    expect(d.move(front(23, 22.4), { snap: true, step: 5 })).toEqual({ value: 20, flipped: false });
  });

  it("past zero an Extrude's blind end turns the other way; other sizes stop at the least step", () => {
    const m = depthArrow();
    const d = startManipDrag(m, front(20, 15))!;
    expect(d.move(front(20, -6), { snap: true, step: 1 })).toEqual({ value: 6, flipped: true });
    expect(d.move(front(20, 0.2), { snap: true, step: 1 })).toEqual({ value: 1, flipped: false });
    const patch = manipPatch(draft("extrude", { extrude: { end: "blind", flip: false } }), m, 6, true);
    expect(patch).toEqual({ params: { depth: "6" }, fields: { extrude: { end: "blind", flip: true } } });
    const sym = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "symmetric", flip: false } }, { depth: "10" }), top)[0];
    const ds = startManipDrag(sym, front(20, 5))!;
    // Half each way: the handle moved 3 mm = 6 mm more depth.
    expect(ds.move(front(20, 8), { snap: true, step: 1 })).toEqual({ value: 16, flipped: false });
    expect(ds.move(front(20, -20), { snap: true, step: 1 })).toEqual({ value: 1, flipped: false });
  });

  it("can't be grabbed pointing straight at you", () => {
    const m = depthArrow();
    expect(startManipDrag(m, { origin: [20, 5, 100], dir: [0, 0, -1] })).toBeNull();
  });

  it("turns a revolve's arc by the angle round its axis, up to its most", () => {
    const data = addLine(rect(), { x: 0, y: -5 }, { x: 0, y: 20 }, { construction: true }).sketch;
    const axis = data.curves.find((c) => c.type === "line" && c.construction)!.id;
    const ctx = { sketch: { plane: { kind: "default" as const, name: "Front" as const }, data }, parts: [] };
    const [m] = manipulatorsFor(draft("revolve", { sketchRef: "s", revolve: { axis, flip: false } }, { angle: "90" }), ctx);
    // Seen from above: rays down -Z.
    const down = (x: number, y: number): Ray => ({ origin: [x, y, 100], dir: [0, 0, -1] });
    const d = startManipDrag(m, down(0, 20))!;
    const at = (deg: number) => down(20 * Math.cos((deg * Math.PI) / 180), 20 * Math.sin((deg * Math.PI) / 180));
    expect(d.move(at(120.4), { snap: true, step: 1 })).toEqual({ value: 120, flipped: false });
    expect(d.move(at(250), { snap: true, step: 1 })).toEqual({ value: 250, flipped: false });
    expect(d.move(at(359), { snap: true, step: 1 }).value).toBe(359);
    expect(d.move(at(30), { snap: true, step: 1 }).value).toBe(360);
  });

  it("finds the arrow under the pointer on screen", () => {
    const m = depthArrow();
    // Front view, 1 px = 1 mm, z up.
    const project = (p: V): [number, number] => [p[0], -p[2]];
    expect(manipHandleAt([m], 30, project, 20, -30)).toEqual({ kind: "manip", id: "depth" });
    expect(manipHandleAt([m], 30, project, 40, -30)).toBeNull();
  });

  it("snaps to 1 mm (0.05 in) at usual zooms, finer right in, coarser out", () => {
    expect(manipStep(0.15)).toBe(1);
    expect(manipStep(0.01)).toBe(0.05);
    expect(manipStep(0.6)).toBe(5);
    expect(manipStep(0.15, "in")).toBeCloseTo(1.27);
    setLengthUnit("in");
    const m = depthArrow();
    expect(manipPatch(draft("extrude"), m, 25.4, false).params.depth).toBe("1 in");
    setLengthUnit("mm");
  });
});
