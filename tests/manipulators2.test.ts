import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import { chamferFaces, faceNow, manipEditText, manipPoint, manipulatorsFor, typedManipValue } from "../src/model/manipulators";
import { useStore } from "../src/model/store";
import type { Feature } from "../src/model/types";
import { setLengthUnit } from "../src/model/units";
import { addCircle, addPoint } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import { startManipDrag } from "../src/viewport/manipulatorDrag";
import { manipEdit } from "../src/viewport/manipulatorGlue";
import type { SceneManager } from "../src/viewport/SceneManager";
import type { Ray } from "../src/viewport/transformDrag";

type V = [number, number, number];
const close = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < tol);

function draft(type: Feature["type"], extra: Partial<Feature> = {}, params: Record<string, string> = {}): Feature {
  return { id: "d1", name: "D", type, operation: "new", suppressed: false, params: { ...defaultParams(type), ...params }, ...extra };
}
const face = (center: V, normal: V): FaceRef => ({ kind: "face", surface: "PLANE", center, normal });
const edge = (a: V, b: V): EdgeRef => ({ kind: "edge", curve: "LINE", a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
const onPart = (ref: FaceRef | EdgeRef): TopoPick => ({ partId: "p", ref });
/** A 20 × 10 × 10 box's faces (x 0…20, y 0…10, z 0…10). */
const boxFaces: FaceRef[] = [
  face([10, 5, 10], [0, 0, 1]),
  face([10, 5, 0], [0, 0, -1]),
  face([20, 5, 5], [1, 0, 0]),
  face([0, 5, 5], [-1, 0, 0]),
  face([10, 10, 5], [0, 1, 0]),
  face([10, 0, 5], [0, -1, 0]),
];
const boxCtx = { sketch: null, parts: [{ id: "p", faceRefs: boxFaces }] };
const front = (x: number, z: number): Ray => ({ origin: [x, 100, z], dir: [0, -1, 0] });
const drag = { snap: true, step: 1 };

describe("more of Onshape's in-view handles", () => {
  it("a Hole's depth arrow runs down the drill from its first hole; nothing for through all", () => {
    const data = addCircle(addPoint(emptySketch(), { x: 5, y: 4 }).sketch, { x: 20, y: 0 }, 3).sketch;
    const ctx = { sketch: { plane: { kind: "default" as const, name: "Top" as const }, data }, parts: [] };
    const hole = (end: "blind" | "throughAll", flip = false) => draft("hole", { hole: { sketchRef: "s", kind: "simple", standard: "Custom", fit: "clearance", end, flip } }, { depth: "8" });
    const [m] = manipulatorsFor(hole("blind"), ctx);
    expect(m.key).toBe("depth");
    expect(close(m.origin, [5, 4, 0])).toBe(true);
    expect(close(manipPoint(m), [5, 4, -8])).toBe(true);
    expect(close(manipPoint(manipulatorsFor(hole("blind", true), ctx)[0]), [5, 4, 8])).toBe(true);
    expect(manipulatorsFor(hole("throughAll"), ctx)).toEqual([]);
    // Dragged 3 mm further down (seen from the front): 11.
    const d = startManipDrag(m, front(5, -8))!;
    expect(d.move(front(5, -11), drag).value).toBe(11);
  });

  it("a Draft's angle is an arc round where the face meets the neutral plane, and may go minus", () => {
    const side = face([20, 5, 5], [1, 0, 0]);
    const [m] = manipulatorsFor(draft("draft", { picks: [onPart(side)], neutral: { kind: "default", name: "Top" } }, { angle: "10" }), boxCtx);
    expect(m.kind).toBe("arc");
    expect(m.signed).toBe(true);
    // The face's middle, 5 above the neutral plane, leaned in by 10°.
    const a = (10 * Math.PI) / 180;
    expect(close(manipPoint(m), [20 - 5 * Math.sin(a), 5, 5 * Math.cos(a)])).toBe(true);
    expect(close(m.axis!.through, [20, 5, 0])).toBe(true);
    // A minus angle is a plain number here (not "a variable"), and dragging carries on past zero.
    const [neg] = manipulatorsFor(draft("draft", { picks: [onPart(side)], neutral: { kind: "default", name: "Top" } }, { angle: "-3" }), boxCtx);
    expect(neg.locked).toBeUndefined();
    expect(neg.value).toBe(-3);
    // A face square to the pull (the top) has no arc.
    expect(manipulatorsFor(draft("draft", { picks: [onPart(boxFaces[0])] }), boxCtx)).toEqual([]);
  });

  it("Move face and Offset surface: a distance arrow along the face's normal that may go minus, never landing on 0", () => {
    const [m] = manipulatorsFor(draft("moveFace", { picks: [onPart(boxFaces[0])] }, { distance: "2" }), boxCtx);
    expect(close(manipPoint(m), [10, 5, 12])).toBe(true);
    const d = startManipDrag(m, front(10, 12))!;
    expect(d.move(front(10, 7), drag).value).toBe(-3);
    // Dragged to where zero is: a step past it, not 0.
    expect(Math.abs(d.move(front(10, 10.2), drag).value)).toBe(1);
    const [o] = manipulatorsFor(draft("offsetSurface", { picks: [onPart(boxFaces[2])] }, { distance: "-1.5" }), boxCtx);
    expect(o.locked).toBeUndefined();
    expect(close(manipPoint(o), [18.5, 5, 5])).toBe(true);
  });

  it("Extend surface: an arrow from the edge along the face, away from it (none for Up to)", () => {
    const wall = face([10, 0, 2.5], [0, -1, 0]);
    const top = edge([0, 0, 5], [20, 0, 5]);
    const ctx = { sketch: null, parts: [{ id: "p", faceRefs: [wall] }] };
    const [m] = manipulatorsFor(draft("extendSurface", { picks: [onPart(top)] }, { distance: "3" }), ctx);
    expect(close(manipPoint(m), [10, 0, 8])).toBe(true);
    expect(manipulatorsFor(draft("extendSurface", { picks: [onPart(top)], extendTo: { mode: "face" } }), ctx)).toEqual([]);
  });

  it("a chamfer of two distances: an arrow along each face; flipped, they swap faces", () => {
    const e = edge([20, 0, 10], [20, 10, 10]);
    const ms = manipulatorsFor(draft("chamfer", { picks: [onPart(e)], chamferType: "twoDistances" }, { distance: "1", distance2: "3" }), boxCtx);
    expect(ms.map((m) => m.key)).toEqual(["distance", "distance2"]);
    // The first along the top (it faces up), the second down the side.
    expect(close(manipPoint(ms[0]), [19, 5, 10])).toBe(true);
    expect(close(manipPoint(ms[1]), [20, 5, 7])).toBe(true);
    const flipped = manipulatorsFor(draft("chamfer", { picks: [onPart(e)], chamferType: "twoDistances", flipSide: true }, { distance: "1", distance2: "3" }), boxCtx);
    expect(close(manipPoint(flipped[0]), [20, 5, 9])).toBe(true);
    expect(close(manipPoint(flipped[1]), [17, 5, 10])).toBe(true);
    // An inside corner: the arrows run out along the faces, away from the corner.
    const inside = [face([17.5, 5, 5], [0, 0, 1]), face([5, 5, 12.5], [1, 0, 0])];
    const sides = chamferFaces(edge([5, 0, 5], [5, 10, 5]), inside, false)!;
    expect(sides.convex).toBe(false);
    const ins = manipulatorsFor(draft("chamfer", { picks: [onPart(edge([5, 0, 5], [5, 10, 5]))], chamferType: "twoDistances" }, { distance: "1", distance2: "3" }), { sketch: null, parts: [{ id: "p", faceRefs: inside }] });
    expect(close(manipPoint(ins[0]), [6, 5, 5])).toBe(true);
    expect(close(manipPoint(ins[1]), [5, 5, 8])).toBe(true);
  });

  it("a chamfer of a distance and an angle: the distance's arrow and an arc whose handle lies on the cut", () => {
    const e = edge([20, 0, 10], [20, 10, 10]);
    const [d, a] = manipulatorsFor(draft("chamfer", { picks: [onPart(e)], chamferType: "distanceAngle" }, { distance: "2", angle: "45" }), boxCtx);
    expect(d.key).toBe("distance");
    expect(a.kind).toBe("arc");
    expect(a.max).toBe(89);
    // 45° on a square edge: the cut runs from (18, ·, 10) to (20, ·, 8); the handle 2 along it from the first face.
    const p = manipPoint(a);
    const r = Math.SQRT1_2 * 2;
    expect(close(p, [18 + r, 5, 10 - r])).toBe(true);
  });

  it("an Extrude's Up to end shows a grey arrow saying why it can't be dragged", () => {
    const ctx = { sketch: { plane: { kind: "default" as const, name: "Top" as const }, data: addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch }, parts: [] };
    const [m] = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "upToFace", flip: false } }), ctx);
    expect(m.locked).toMatch(/up to a face: change the end type/);
    expect(m.tip).toBe(m.locked);
    expect(m.noEdit).toBe(true);
  });

  it("Shell and Thicken sit on their face as built now (else as picked)", () => {
    // (Faces also say where they are within the part's box, as the engine's do: the top stays "on top".)
    const at = (f: FaceRef, rel: V): FaceRef => ({ ...f, rel });
    const picked = onPart(at(face([10, 5, 10], [0, 0, 1]), [0.5, 0.5, 1]));
    const moved = { id: "p", faceRefs: [at(face([10, 5, 16], [0, 0, 1]), [0.5, 0.5, 1]), at(face([10, 5, 0], [0, 0, -1]), [0.5, 0.5, 0]), at(face([20, 5, 8], [1, 0, 0]), [1, 0.5, 0.5])] };
    expect(faceNow(picked, moved).center).toEqual([10, 5, 16]);
    expect(faceNow(picked, undefined).center).toEqual([10, 5, 10]);
    const [m] = manipulatorsFor(draft("shell", { picks: [picked] }, { thickness: "2" }), { sketch: null, parts: [moved] });
    expect(close(manipPoint(m), [10, 5, 14])).toBe(true);
  });
});

describe("what clicks on an arrow do, and Shift drags", () => {
  it("only an Extrude's / Revolve's arrows let a still click through to the areas under them", () => {
    const ctx = { sketch: { plane: { kind: "default" as const, name: "Top" as const }, data: addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch }, parts: [] };
    const [ex] = manipulatorsFor(draft("extrude", { sketchRef: "s", extrude: { end: "blind", flip: false } }), ctx);
    expect(ex.passesClicks).toBe(true);
    const [mv] = manipulatorsFor(draft("moveFace", { picks: [onPart(boxFaces[0])] }), boxCtx);
    expect(mv.passesClicks).toBeUndefined();
    const [dr] = manipulatorsFor(draft("draft", { picks: [onPart(boxFaces[2])] }), boxCtx);
    expect(dr.passesClicks).toBeUndefined();
  });

  it("a minus-able size dragged with Shift never comes nearer 0 than a hundredth", () => {
    const [m] = manipulatorsFor(draft("moveFace", { picks: [onPart(boxFaces[0])] }, { distance: "2" }), boxCtx);
    const d = startManipDrag(m, front(10, 12))!;
    for (const z of [10.003, 9.998, 10]) expect(Math.abs(d.move(front(10, z), { snap: false, step: 1 }).value)).toBeGreaterThanOrEqual(0.01);
    expect(d.move(front(10, 9.5), { snap: false, step: 1 }).value).toBeCloseTo(-0.5, 6);
  });

  it("a lopsided chamfer with a face picked too measures the first distance along that face (Flip swaps)", () => {
    const e = edge([20, 0, 10], [20, 10, 10]);
    const side = boxFaces[2];
    const ms = manipulatorsFor(draft("chamfer", { picks: [onPart(side), onPart(e)], chamferType: "twoDistances" }, { distance: "1", distance2: "3" }), boxCtx);
    expect(close(manipPoint(ms[0]), [20, 5, 9])).toBe(true);
    expect(close(manipPoint(ms[1]), [17, 5, 10])).toBe(true);
    const flipped = manipulatorsFor(draft("chamfer", { picks: [onPart(side), onPart(e)], chamferType: "twoDistances", flipSide: true }, { distance: "1", distance2: "3" }), boxCtx);
    expect(close(manipPoint(flipped[0]), [19, 5, 10])).toBe(true);
    // Both its faces picked: no telling which the engine takes first, so no arrows.
    expect(manipulatorsFor(draft("chamfer", { picks: [onPart(side), onPart(boxFaces[0]), onPart(e)], chamferType: "twoDistances" }), boxCtx)).toEqual([]);
  });
});

describe("typing a size by the arrow", () => {
  it("starts with the box's text and takes numbers, variables and sums as the box does", () => {
    const d = draft("extrude", {}, { depth: "15" });
    const m = { key: "depth", angle: false, value: 15 };
    expect(manipEditText(d, m)).toBe("15");
    expect(typedManipValue(d, m, " 20 ")).toEqual({ params: { depth: "20" } });
    expect(typedManipValue(d, m, "10 + 2.5")).toEqual({ params: { depth: "10 + 2.5" } });
    expect("problem" in typedManipValue(d, m, "")).toBe(true);
    expect("problem" in typedManipValue(d, m, "nonsense_name")).toBe(true);
    // Inches: typed in inches and kept so.
    setLengthUnit("in");
    try {
      expect(typedManipValue(d, m, "2")).toEqual({ params: { depth: "2 in" } });
      expect(manipEditText({ ...d, params: { depth: "2 in" } }, m)).toBe("2");
    } finally {
      setLengthUnit("mm");
    }
    // Angles as typed.
    expect(typedManipValue(draft("revolve"), { key: "angle", angle: true }, "90")).toEqual({ params: { angle: "90" } });
  });
});

describe("the in-view box in the dialog's undo", () => {
  const s = () => useStore.getState();
  beforeEach(() => {
    useStore.setState({ history: historyOf(emptyDocument()), editing: null, selection: [], selectedPlane: null, selectedFeatureId: null, draftSteps: null, transformLive: null });
  });

  /** A stand-in for the 3D view: keeps the box's Enter handler. */
  function fakeView() {
    const box: { id?: string; text?: string; apply?: (t: string) => string | null } = {};
    const view = {
      editManipValue(id: string, text: string, apply: (t: string) => string | null) {
        Object.assign(box, { id, text, apply });
      },
    } as unknown as SceneManager;
    return { view, box };
  }

  it("Enter sets the box as typing in the dialog does: one undo step, merged with typing in the same box", () => {
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    s().startCreate("moveFace");
    s().setDraftField({ picks: [onPart(boxFaces[0])] });
    const before = s().editing!.draft.params.distance;
    const steps = s().draftSteps?.drafts.length ?? 0;
    const { view, box } = fakeView();
    manipEdit(view, "distance");
    expect(box.id).toBe("distance");
    expect(box.text).toBe(before);
    // A size that can't be worked out stays in the box with the reason; nothing changes.
    expect(box.apply!("what")).toMatch(/./);
    expect(s().editing!.draft.params.distance).toBe(before);
    expect(box.apply!("4 + 1")).toBeNull();
    expect(s().editing!.draft.params.distance).toBe("4 + 1");
    expect(s().draftSteps!.drafts.length).toBe(steps + 1);
    // Typing on in the dialog's box is the same step; Ctrl+Z (the dialog's undo) takes it all back.
    s().setDraftParam("distance", "6");
    expect(s().draftSteps!.drafts.length).toBe(steps + 1);
    expect(s().undoDraftStep()).toBe(true);
    expect(s().editing!.draft.params.distance).toBe(before);
  });

  it("a double-click on an Extrude's arrow puts back what its two clicks picked under it, with no undo step", async () => {
    const { remember } = await import("../src/viewport/manipulatorGlue");
    const data = addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch;
    s().startCreate("sketch");
    s().setDraftField({ sketch: { plane: { kind: "default", name: "Top" }, data } });
    expect(s().commitDraft()).toBe(true);
    const sketchId = s().history.present.features[0].id;
    s().startCreate("extrude");
    s().setDraftField({ sketchRef: sketchId, extrude: { end: "blind", flip: false } });
    const before = s().editing!.draft;
    const steps = s().draftSteps;
    // Press 1 (remembered), its click passes through and picks an area; press 2, its click lets it go again.
    remember("depth");
    s().setDraftField({ areas: [[1, 1, 3]] as unknown as Feature["areas"] });
    remember("depth");
    s().setDraftField({ areas: undefined });
    expect(s().draftSteps).not.toBe(steps);
    const { view, box } = fakeView();
    manipEdit(view, "depth");
    expect(box.id).toBe("depth");
    expect(s().editing!.draft).toBe(before);
    expect(s().draftSteps).toBe(steps);
  });

  it("no arrow (nothing picked yet): no box", () => {
    s().startCreate("moveFace");
    const { view, box } = fakeView();
    // No face picked yet: no arrow, no box.
    manipEdit(view, "distance");
    expect(box.id).toBeUndefined();
  });
});
