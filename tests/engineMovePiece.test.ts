/**
 * Move face on a hole or boss, with the faces the real engine reports (a whole cylinder's face keeps no normal):
 * a new Translate starts sideways, and the dialog's handles sit at the opening.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { manipulatorsFor } from "../src/model/manipulators";
import { pieceOfPicks, sidewaysAxis } from "../src/model/movePiece";
import { translateDirection } from "../src/model/newFeatureDefaults";
import type { Feature } from "../src/model/types";
import type { FaceRef } from "../src/geometry/topoRef";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

function parts(features: Feature[]) {
  const e = new GeometryEngine();
  try {
    return e.rebuild(features).parts;
  } finally {
    e.dispose();
  }
}
const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3;

describe("a hole or boss for Move face", () => {
  it("finds the axis and opening from the mesh, and starts a Translate sideways", () => {
    const ps = parts([
      feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15 }),
      feature("cylinder", { diameter: 10, height: 6, x: -8, y: 0, z: 4 }, "remove"),
      feature("cylinder", { diameter: 6, height: 5, x: 8, y: 0, z: 10 }, "add"),
    ]);
    const p = ps[0];
    const round = p.faceRefs.filter((f) => f.surface !== "PLANE") as FaceRef[];
    expect(round).toHaveLength(2);
    expect(round.every((f) => Math.hypot(...f.normal) < 1e-9)).toBe(true);
    const wall = round.find((f) => f.center[0] < 0)!;
    const bossWall = round.find((f) => f.center[0] > 0)!;
    const floor = p.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.center[2] - 4) < 1e-6)!;
    const bossTop = p.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.center[2] - 15) < 1e-6)!;
    const pk = (ref: FaceRef) => ({ partId: p.id, ref });
    // Wall alone: the opening is the end its axis points to (the top); wall + floor: the end away from the floor.
    const a = pieceOfPicks([pk(wall)], ps)!;
    expect(Math.abs(a.axis[2])).toBeCloseTo(1, 6);
    expect(near(a.mouth, [-8, 0, 10])).toBe(true);
    expect(near(pieceOfPicks([pk(floor), pk(wall)], ps)!.mouth, [-8, 0, 10])).toBe(true);
    // A boss with its top picked: its foot.
    expect(near(pieceOfPicks([pk(bossWall), pk(bossTop)], ps)!.mouth, [8, 0, 10])).toBe(true);
    expect(sidewaysAxis([0, 0, 1])).toBe("x");
    expect(sidewaysAxis([1, 0, 0])).toBe("y");
    const mf = (picks: Feature["picks"]) => ({ type: "moveFace" as const, moveFace: { mode: "translate" as const }, picks });
    expect(translateDirection(mf([pk(wall)]), ps)).toEqual({ axis: "x" });
    expect(translateDirection(mf([pk(floor), pk(wall)]), ps)).toEqual({ axis: "x" });
    expect(translateDirection(mf([pk(bossWall), pk(bossTop)]), ps)).toEqual({ axis: "x" });
  });

  it("puts the arrow at the opening, and offers turning only about an axis along the hole's", () => {
    const ps = parts([feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15 }), feature("cylinder", { diameter: 10, height: 6, x: -8, y: 0, z: 4 }, "remove")]);
    const p = ps[0];
    const wall = p.faceRefs.find((f) => f.surface !== "PLANE")!;
    const floor = p.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.center[2] - 4) < 1e-6)!;
    for (const order of [[wall, floor], [floor, wall]]) {
      const draft = (mode: "translate" | "rotate", axis: "x" | "z"): Feature => ({ ...feature("moveFace", { distance: 5, angle: 10 }), moveFace: { mode, axis }, picks: order.map((ref) => ({ partId: p.id, ref })) });
      const t = manipulatorsFor(draft("translate", "x"), { sketch: null, parts: ps });
      expect(t).toHaveLength(1);
      expect(near(t[0].origin, [-8, 0, 10])).toBe(true);
      expect(t[0].dir).toEqual([1, 0, 0]);
      expect(manipulatorsFor(draft("rotate", "x"), { sketch: null, parts: ps })).toEqual([]);
      const r = manipulatorsFor(draft("rotate", "z"), { sketch: null, parts: ps });
      expect(r).toHaveLength(1);
      expect(r[0].kind).toBe("arc");
    }
  });

  it("still finds the hole when the parts shown already have it moved (the dialog's preview, or editing)", () => {
    const box = feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15 });
    const hole = feature("cylinder", { diameter: 10, height: 6, x: -8, y: 0, z: 4 }, "remove");
    const p0 = parts([box, hole])[0];
    const wall = p0.faceRefs.find((f) => f.surface !== "PLANE")!;
    const floor = p0.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.center[2] - 4) < 1e-6)!;
    const picks = [wall, floor].map((ref) => ({ partId: p0.id, ref }));
    for (const d of [0, 2, 6]) {
      const mv: Feature = { ...feature("moveFace", { distance: d }), moveFace: { mode: "translate", axis: "x" }, picks };
      const shown = parts(d ? [box, hole, mv] : [box, hole]);
      const m = manipulatorsFor(mv, { sketch: null, parts: shown });
      expect(m).toHaveLength(1);
      expect(near(m[0].origin, [-8, 0, 10])).toBe(true);
      expect(m[0].value).toBeCloseTo(d, 9);
    }
    const turn: Feature = { ...feature("moveFace", { angle: 30 }), moveFace: { mode: "rotate", axis: "z" }, picks };
    const turned = parts([box, hole, turn]);
    const r = manipulatorsFor(turn, { sketch: null, parts: turned });
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("arc");
    expect(near(r[0].origin, [-8, 0, 10])).toBe(true);
  });

  it("follows earlier changes (never a handle where the hole used to be), and a hole moved along its own axis", () => {
    const box = feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: -10, y: 0 }, "remove");
    const p0 = parts([box, hole])[0];
    const wall = p0.faceRefs.find((f) => f.surface !== "PLANE")!;
    const mv: Feature = { ...feature("moveFace", { distance: 3 }), moveFace: { mode: "translate", axis: "y" }, picks: [{ partId: p0.id, ref: wall }] };
    const first = manipulatorsFor(mv, { sketch: null, parts: parts([box, hole, mv]) });
    expect(first).toHaveLength(1);
    expect(near(first[0].origin, [-10, 0, 10])).toBe(true);
    // The hole drilled 2 further along X: the handle goes with it.
    const nudged = { ...hole, params: { ...hole.params, x: "-8" } };
    const n = manipulatorsFor(mv, { sketch: null, parts: parts([box, nudged, mv]) });
    expect(n).toHaveLength(1);
    expect(near(n[0].origin, [-8, 0, 10])).toBe(true);
    // Moved too far to be sure it's the same hole: no handle rather than one in the old place.
    const far = { ...hole, params: { ...hole.params, x: "-4" } };
    const f = manipulatorsFor(mv, { sketch: null, parts: parts([box, far, mv]) });
    expect(f.every((m) => !near(m.origin, [-10, 0, 10]))).toBe(true);
    // The box and hole made 20 tall: the opening is at the new top.
    const tall = { ...box, params: { ...box.params, height: "20" } };
    const deep = { ...hole, params: { ...hole.params, height: "20" } };
    const t = manipulatorsFor(mv, { sketch: null, parts: parts([tall, deep, mv]) });
    expect(t).toHaveLength(1);
    expect(near(t[0].origin, [-10, 0, 20])).toBe(true);
    // A blind hole made 2 deeper (along its own axis): the arrow stays at its opening.
    const blind = feature("cylinder", { diameter: 6, height: 4, x: -10, y: 0, z: 6 }, "remove");
    const b0 = parts([box, blind])[0];
    const bw = b0.faceRefs.find((q) => q.surface !== "PLANE")!;
    const down: Feature = { ...feature("moveFace", { distance: 2 }), moveFace: { mode: "translate", axis: "z", flip: true }, picks: [{ partId: b0.id, ref: bw }] };
    const d = manipulatorsFor(down, { sketch: null, parts: parts([box, blind, down]) });
    expect(d).toHaveLength(1);
    expect(near(d[0].origin, [-10, 0, 10])).toBe(true);
  });
});
