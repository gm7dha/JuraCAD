/**
 * Move face's Onshape types (Offset / Translate / Rotate) against the real OpenCascade engine: exact volumes,
 * round faces offset (a hole made bigger, a boss grown), refusals, and an older Move face building as before.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, MoveFaceDef } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volume = () => engine.check("normal").parts[0].exactVolume!;

type Built = ReturnType<typeof build>;
type FaceInfo = { kind: string; surface?: string; normal?: number[]; center?: number[]; curve?: string; a?: number[]; b?: number[] };
const faces = (r: Built, test: (f: FaceInfo) => boolean) => {
  const p = r.parts[0];
  return p.faceRefs.filter((f) => f.kind === "face" && test(f as FaceInfo)).map((ref) => ({ partId: p.id, ref }));
};
const edges = (r: Built, test: (e: FaceInfo) => boolean) => {
  const p = r.parts[0];
  return p.edgeRefs.filter((e) => test(e as FaceInfo)).map((ref) => ({ partId: p.id, ref }));
};
const move = (def: MoveFaceDef, params: Record<string, number>, picks: Feature["picks"]): Feature => ({ ...feature("moveFace", params), moveFace: def, picks });

describe("Move face: Offset", () => {
  it("moves a box's top face out 2 and in 2 (as the old Move face did)", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const top = faces(build([box]), (f) => f.surface === "PLANE" && f.normal![2] > 0.99);
    const out = move({ mode: "offset" }, { distance: 2 }, top);
    expect(build([box, out]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(2400, 6);
    expect(build([box, { ...out, params: { distance: "-2" } }]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(1600, 6);
  });

  it("makes a Ø10 hole through a 20 mm plate 0.4 bigger across with −0.2", () => {
    const plate = feature("box", { width: 30, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 20, x: 15, y: 15 }, "remove");
    const wall = faces(build([plate, hole]), (f) => f.surface === "CYLINDRE");
    expect(wall).toHaveLength(1);
    const off = move({ mode: "offset" }, { distance: -0.2 }, wall);
    const r = build([plate, hole, off]);
    expect(r.featureErrors).toEqual({});
    expect(r.featureWarnings?.[off.id]).toBeUndefined();
    expect(volume()).toBeCloseTo(18000 - Math.PI * 5.2 * 5.2 * 20, 5);
    // And smaller (+0.2): Ø9.6.
    expect(build([plate, hole, { ...off, params: { distance: "0.2" } }]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(18000 - Math.PI * 4.8 * 4.8 * 20, 5);
  });

  it("says so when two moved faces meet (the corner between them isn't filled)", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const picks = faces(build([box]), (f) => f.surface === "PLANE" && (f.normal![2] > 0.99 || f.normal![0] > 0.99));
    expect(picks).toHaveLength(2);
    const both = move({ mode: "offset" }, { distance: 2 }, picks);
    const r = build([box, both]);
    expect(r.featureErrors).toEqual({});
    expect(r.featureWarnings?.[both.id]).toMatch(/corner/);
    expect(volume()).toBeCloseTo(2000 + 400 + 200, 6);
  });

  it("refuses to close a hole up", () => {
    const plate = feature("box", { width: 30, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 20, x: 15, y: 15 }, "remove");
    const wall = faces(build([plate, hole]), (f) => f.surface === "CYLINDRE");
    const off = move({ mode: "offset" }, { distance: 5 }, wall);
    expect(build([plate, hole, off]).featureErrors[off.id]).toMatch(/close the hole up/);
  });

  it("grows a round boss by 1 (its wall out of the part)", () => {
    const base = feature("box", { width: 40, depth: 40, height: 5, x: -20, y: -20 });
    const boss = feature("cylinder", { diameter: 10, height: 10, x: 0, y: 0, z: 5 }, "add");
    const wall = faces(build([base, boss]), (f) => f.surface === "CYLINDRE");
    expect(wall).toHaveLength(1);
    const off = move({ mode: "offset" }, { distance: 1 }, wall);
    const r = build([base, boss, off]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(8000 + Math.PI * 36 * 10, 5);
    // A boss shrunk to nothing is refused.
    expect(build([base, boss, { ...off, params: { distance: "-5" } }]).featureErrors[off.id]).toMatch(/shrink the round face to nothing/);
  });

  it("grows a whole ball and a round cavity (a closed sphere face)", () => {
    const ball = feature("sphere", { diameter: 20 });
    const skin = faces(build([ball]), (f) => f.surface === "SPHERE");
    expect(skin).toHaveLength(1);
    const grow = move({ mode: "offset" }, { distance: 1 }, skin);
    expect(build([ball, grow]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo((4 / 3) * Math.PI * 11 ** 3, 5);
    const box = feature("box", { width: 40, depth: 40, height: 40, x: -20, y: -20, z: -20 });
    const cavity = feature("sphere", { diameter: 20 }, "remove");
    const inside = faces(build([box, cavity]), (f) => f.surface === "SPHERE");
    expect(inside).toHaveLength(1);
    expect(build([box, cavity, move({ mode: "offset" }, { distance: -1 }, inside)]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(64000 - (4 / 3) * Math.PI * 11 ** 3, 4);
  });

  it("flat faces moved in past other faces cut as the original Move face did", () => {
    // A pocket's floor pushed down past the part's bottom opens a window, as before (only round faces are refused).
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const pocket = feature("box", { width: 10, depth: 10, height: 5, x: 5, y: 5, z: 5 }, "remove");
    const floor = faces(build([box, pocket]), (f) => f.surface === "PLANE" && f.normal![2] > 0.99 && Math.abs(f.center![2] - 5) < 1e-6);
    expect(floor).toHaveLength(1);
    const deeper = move({ mode: "offset" }, { distance: -3 }, floor);
    expect(build([box, pocket, deeper]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(4000 - 500 - 300, 6);
    const r = build([box, pocket, { ...deeper, params: { distance: "-8" } }]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(4000 - 500 - 500, 6);
    const classic: Feature = { ...feature("moveFace", { distance: -8 }), picks: floor };
    expect(build([box, pocket, classic]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(3000, 6);
    // A plate with a pocket cut up from below: its top pushed down into the pocket opens it, as before.
    const plate = feature("box", { width: 20, depth: 20, height: 10 });
    const under = feature("box", { width: 6, depth: 6, height: 9, x: 7, y: 7 }, "remove");
    const top = faces(build([plate, under]), (f) => f.surface === "PLANE" && f.normal![2] > 0.99);
    const down = move({ mode: "offset" }, { distance: -2 }, top);
    expect(build([plate, under, down]).featureErrors).toEqual({});
    const v = volume();
    expect(build([plate, under, { ...feature("moveFace", { distance: -2 }), picks: top }]).featureErrors).toEqual({});
    expect(v).toBeCloseTo(volume(), 6);
  });
});

describe("Move face: Translate", () => {
  it("moves a slanted face up along Z (its upright sides stretch)", () => {
    // A wedge: a 20 × 10 block whose top slopes from 10 high at x = 0 to 5 high at x = 20 (a box with a slanted cut).
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r0 = build([box]);
    const top = faces(r0, (f) => f.surface === "PLANE" && f.normal![2] > 0.99);
    const tilt = move({ mode: "rotate", axis: "y" }, { angle: 10 }, top);
    // First: translate the plain top up 3 along Z = the box 3 taller.
    const up = move({ mode: "translate", axis: "z" }, { distance: 3 }, top);
    expect(build([box, up]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(2600, 6);
    // Flipped: down 3.
    expect(build([box, { ...up, moveFace: { mode: "translate", axis: "z", flip: true } }]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(1400, 6);
    // Sliding along itself (X) changes nothing: refused in plain words.
    expect(build([box, { ...up, moveFace: { mode: "translate", axis: "x" } }]).featureErrors[up.id]).toMatch(/slide along themselves/);
    // The top tilted, then that slanted face moved up 3 along Z: the part grows by exactly 20 × 10 × 3.
    const r1 = build([box, tilt]);
    expect(r1.featureErrors).toEqual({});
    const v1 = volume();
    const slanted = faces(r1, (f) => f.surface === "PLANE" && f.normal![2] > 0.9 && f.normal![2] < 0.999);
    expect(slanted).toHaveLength(1);
    const lift = move({ mode: "translate", axis: "z" }, { distance: 3 }, slanted);
    const r2 = build([box, tilt, lift]);
    expect(r2.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(v1 + 600, 5);
  });

  it("moves a side face along a picked edge", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r = build([box]);
    const right = faces(r, (f) => f.surface === "PLANE" && f.normal![0] > 0.99);
    // A bottom edge running along +X (from x = 0 to x = 20, at y = 0, z = 0).
    const edge = edges(r, (e) => e.curve === "LINE" && Math.abs(e.a![1]) < 1e-6 && Math.abs(e.b![1]) < 1e-6 && Math.abs(e.a![2]) < 1e-6 && Math.abs(e.b![2]) < 1e-6)[0];
    expect(edge).toBeTruthy();
    const mv = move({ mode: "translate", along: edge }, { distance: 4 }, right);
    expect(build([box, mv]).featureErrors).toEqual({});
    // Out or in by 4 depending on which way the edge points: 2400 or 1600.
    expect([2400, 1600].some((v) => Math.abs(volume() - v) < 1e-6)).toBe(true);
    const first = volume();
    build([box, { ...mv, moveFace: { mode: "translate", along: edge, flip: true } }]);
    expect(volume()).toBeCloseTo(Math.abs(first - 2400) < 1 ? 1600 : 2400, 6);
  });
});

describe("Move face: Rotate", () => {
  it("turns a box's top 5° about its edge", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r = build([box]);
    const top = faces(r, (f) => f.surface === "PLANE" && f.normal![2] > 0.99);
    // The top edge along X at y = 0 (z = 10).
    const edge = edges(r, (e) => e.curve === "LINE" && Math.abs(e.a![1]) < 1e-6 && Math.abs(e.b![1]) < 1e-6 && Math.abs(e.a![2] - 10) < 1e-6 && Math.abs(e.b![2] - 10) < 1e-6)[0];
    expect(edge).toBeTruthy();
    const turn = move({ mode: "rotate", along: edge }, { angle: 5 }, top);
    expect(build([box, turn]).featureErrors).toEqual({});
    const wedge = 0.5 * 10 * 10 * Math.tan((5 * Math.PI) / 180) * 20;
    const v = volume();
    expect(Math.min(Math.abs(v - (2000 + wedge)), Math.abs(v - (2000 - wedge)))).toBeLessThan(1e-6);
    // The other way round: the other wedge.
    build([box, { ...turn, moveFace: { mode: "rotate", along: edge, flip: true } }]);
    expect(volume()).toBeCloseTo(v > 2000 ? 2000 - wedge : 2000 + wedge, 6);
    // About X through the origin (the bottom front edge's line): the top turns about a line 10 below it.
    build([box, move({ mode: "rotate", axis: "x" }, { angle: 5 }, top)]);
    expect(Math.abs(volume() - 2000)).toBeGreaterThan(1);
  });

  it("refuses an axis straight out of the face, and curved faces", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const top = faces(build([box]), (f) => f.surface === "PLANE" && f.normal![2] > 0.99);
    const spin = move({ mode: "rotate", axis: "z" }, { angle: 5 }, top);
    expect(build([box, spin]).featureErrors[spin.id]).toMatch(/straight out of the face/);
    const plate = feature("box", { width: 30, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 20, x: 15, y: 15 }, "remove");
    const wall = faces(build([plate, hole]), (f) => f.surface === "CYLINDRE");
    // A through hole turned about X would no longer meet its faces squarely: refused in plain words.
    const bad = move({ mode: "rotate", axis: "x" }, { angle: 5 }, wall);
    expect(build([plate, hole, bad]).featureErrors[bad.id]).toMatch(/squarely/);
  });
});

describe("an older Move face (no type)", () => {
  it("builds exactly as before and still refuses curved faces", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const top = faces(build([box]), (f) => f.surface === "PLANE" && f.normal![2] > 0.99);
    const old: Feature = { ...feature("moveFace", { distance: 3 }), picks: top };
    expect(old.moveFace).toBeUndefined();
    expect(build([box, old]).featureErrors).toEqual({});
    expect(Math.round(volume() * 100) / 100).toBe(2600);
    const plate = feature("box", { width: 30, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 20, x: 15, y: 15 }, "remove");
    const wall = faces(build([plate, hole]), (f) => f.surface === "CYLINDRE");
    const oldRound: Feature = { ...feature("moveFace", { distance: -0.2 }), picks: wall };
    expect(build([plate, hole, oldRound]).featureErrors[oldRound.id]).toMatch(/flat faces/);
  });
});

describe("Move face: round faces moved as a whole hole or boss", () => {
  // A 40 × 30 × 10 block centred on the origin (x −20…20, y −15…15, z 0…10) with a Ø10 hole through it at (−8, 0).
  const block = () => feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15 });
  const drill = (x: number, y: number, d = 10, h = 10, z = 0) => feature("cylinder", { diameter: d, height: h, x, y, z }, "remove");
  const hollowAt = (fs: Feature[], x: number, y: number) => {
    // Drilling Ø10 again there takes nothing away if the hole is already there, and the whole Ø10 × 10 if not.
    const v0 = volume();
    build([...fs, drill(x, y)]);
    const taken = v0 - volume();
    return taken;
  };
  const full = 40 * 30 * 10;
  const ring = Math.PI * 25 * 10;

  it("moves a Ø10 through hole 12 mm along X: same volume, open at the new place, filled at the old", () => {
    const b = block();
    const h = drill(-8, 0);
    const wall = faces(build([b, h]), (f) => f.surface === "CYLINDRE");
    expect(wall).toHaveLength(1);
    const mv = move({ mode: "translate", axis: "x" }, { distance: 12 }, wall);
    const fs = [b, h, mv];
    const r = build(fs);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - ring, 5);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    expect(hollowAt(fs, 4, 0)).toBeCloseTo(0, 4);
    build(fs);
    expect(hollowAt(fs, -8, 0)).toBeCloseTo(ring, 4);
    // Flipped: 12 the other way (x −20) would break out of the side: refused.
    expect(build([b, h, { ...mv, moveFace: { mode: "translate", axis: "x", flip: true } }]).featureErrors[mv.id]).toMatch(/out of the part/);
  });

  it("refuses to move a hole off the edge", () => {
    const b = block();
    const h = drill(-8, 0);
    const wall = faces(build([b, h]), (f) => f.surface === "CYLINDRE");
    const mv = move({ mode: "translate", axis: "x" }, { distance: 25 }, wall);
    expect(build([b, h, mv]).featureErrors[mv.id]).toMatch(/out of the part/);
  });

  it("moves a blind hole (wall + floor) sideways and deeper, and the wall alone", () => {
    const b = block();
    const h = drill(-8, 0, 10, 6, 4); // from z 4 up to the top: 6 deep
    const r0 = build([b, h]);
    const both = faces(r0, (f) => f.surface === "CYLINDRE" || (f.surface === "PLANE" && f.normal![2] > 0.99 && Math.abs(f.center![2] - 4) < 1e-6));
    expect(both).toHaveLength(2);
    const blind = Math.PI * 25 * 6;
    const side = move({ mode: "translate", axis: "y" }, { distance: 5 }, both);
    expect(build([b, h, side]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - blind, 5);
    // Deeper: 2 mm down along Z (flipped) — the hole stays open at the top and gets 2 deeper.
    const down = move({ mode: "translate", axis: "z", flip: true }, { distance: 2 }, both);
    expect(build([b, h, down]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - Math.PI * 25 * 8, 5);
    // Shallower: 2 up.
    expect(build([b, h, { ...down, moveFace: { mode: "translate", axis: "z" } }]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - Math.PI * 25 * 4, 5);
    // The wall alone (its floor not picked) moves the same way.
    const wall = both.filter((p) => p.ref.kind === "face" && (p.ref as FaceInfo).surface === "CYLINDRE");
    expect(build([b, h, { ...side, picks: wall }]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - blind, 5);
    // Down through the bottom: refused.
    expect(build([b, h, { ...down, params: { distance: "5" } }]).featureErrors[down.id]).toMatch(/out of the part/);
  });

  it("moves a round boss sideways, and refuses it hanging off its face or running into another", () => {
    const base = feature("box", { width: 40, depth: 30, height: 5, x: -20, y: -15 });
    const boss = feature("cylinder", { diameter: 10, height: 10, x: -8, y: 0, z: 5 }, "add");
    const r0 = build([base, boss]);
    const v0 = volume();
    expect(v0).toBeCloseTo(6000 + Math.PI * 25 * 10, 5);
    const picks = faces(r0, (f) => f.surface === "CYLINDRE" || (f.surface === "PLANE" && f.normal![2] > 0.99 && Math.abs(f.center![2] - 15) < 1e-6));
    expect(picks).toHaveLength(2);
    const mv = move({ mode: "translate", axis: "x" }, { distance: 12 }, picks);
    expect(build([base, boss, mv]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(v0, 5);
    // Moved up 3: it stands on its face still, 3 taller.
    expect(build([base, boss, { ...mv, moveFace: { mode: "translate", axis: "z" }, params: { distance: "3" } }]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(v0 + Math.PI * 25 * 3, 5);
    // Off the edge (x −8 + 18 = 10 + 5 radius = 15 < 20 is fine; 25 → 17…27 hangs off).
    expect(build([base, boss, { ...mv, params: { distance: "25" } }]).featureErrors[mv.id]).toMatch(/hang off/);
    // Into a second boss at x 8: refused.
    const other = feature("cylinder", { diameter: 6, height: 6, x: 8, y: 0, z: 5 }, "add");
    const r1 = build([base, boss, other]);
    const first = faces(r1, (f) => (f.surface === "CYLINDRE" && f.center![0] < 0) || (f.surface === "PLANE" && f.normal![2] > 0.99 && Math.abs(f.center![2] - 15) < 1e-6));
    expect(first).toHaveLength(2);
    expect(build([base, boss, other, { ...mv, picks: first }]).featureErrors[mv.id]).toMatch(/into the rest/);
  });

  it("moves a countersunk hole's faces together", () => {
    const b = feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15, z: -10 });
    let data = emptySketch();
    data = addPoint(data, { x: -8, y: 0 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const hole: Feature = {
      ...feature("hole", { diameter: 4.5, cskDiameter: 9.4, cskAngle: 90 }, "remove"),
      hole: { sketchRef: sk.id, kind: "countersink", standard: "Custom", fit: "clearance", end: "throughAll", flip: false },
    };
    const r0 = build([b, sk, hole]);
    expect(r0.featureErrors).toEqual({});
    const v0 = volume();
    const picks = faces(r0, (f) => f.surface === "CYLINDRE" || f.surface === "CONE");
    expect(picks.length).toBeGreaterThanOrEqual(2);
    const mv = move({ mode: "translate", axis: "x" }, { distance: 10 }, picks);
    const r = build([b, sk, hole, mv]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(v0, 4);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // Only the cone picked (not the hole's wall): it doesn't close up into one piece.
    const cone = picks.filter((p) => (p.ref as FaceInfo).surface === "CONE");
    const half = { ...mv, picks: cone };
    expect(build([b, sk, hole, half]).featureErrors[mv.id]).toBeTruthy();
  });

  it("turns a hole 90° about Z round the origin", () => {
    const b = block();
    const h = drill(8, 0);
    const wall = faces(build([b, h]), (f) => f.surface === "CYLINDRE");
    const turn = move({ mode: "rotate", axis: "z" }, { angle: 90 }, wall);
    const fs = [b, h, turn];
    expect(build(fs).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - ring, 5);
    expect(hollowAt(fs, 0, 8)).toBeCloseTo(0, 4);
    build(fs);
    expect(hollowAt(fs, 8, 0)).toBeCloseTo(ring, 4);
  });

  it("says when a move changes nothing or takes the hole right out, and moves several holes at once", () => {
    const b = block();
    const h = drill(-8, 0);
    const wall = faces(build([b, h]), (f) => f.surface === "CYLINDRE");
    // A through hole slid along its own axis: nothing changes, and it says so.
    const along = move({ mode: "translate", axis: "z" }, { distance: 5 }, wall);
    expect(build([b, h, along]).featureErrors[along.id]).toMatch(/nothing would change/);
    // A blind Ø6 × 4 hole (its wall picked) moved up 4 or 5: gone out of the top, refused.
    const blind = drill(-10, 0, 6, 4, 6);
    const bw = faces(build([b, blind]), (f) => f.surface === "CYLINDRE");
    for (const d of [4, 5]) {
      const up = move({ mode: "translate", axis: "z" }, { distance: d }, bw);
      expect(build([b, blind, up]).featureErrors[up.id]).toMatch(/right out of the part/);
    }
    // Two holes picked together both move.
    const one = drill(-10, -5, 6);
    const two = drill(-10, 5, 6);
    const both = faces(build([b, one, two]), (f) => f.surface === "CYLINDRE");
    expect(both).toHaveLength(2);
    const fs = [b, one, two, move({ mode: "translate", axis: "x" }, { distance: 15 }, both)];
    expect(build(fs).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(full - 2 * Math.PI * 9 * 10, 5);
    const v = volume();
    build([...fs, feature("cylinder", { diameter: 5.9, height: 9.98, x: 5, y: 5, z: 0.01 }, "remove")]);
    expect(volume()).toBeCloseTo(v, 5);
    build([...fs, feature("cylinder", { diameter: 5.9, height: 9.98, x: -10, y: -5, z: 0.01 }, "remove")]);
    expect(v - volume()).toBeCloseTo(Math.PI * 2.95 * 2.95 * 9.98, 4);
  });

  it("a boss with a rounded foot slides, but won't be raised or sunk (the rounding would be lost), and asks for its foot", () => {
    const base = feature("box", { width: 40, depth: 30, height: 5, x: -20, y: -15 });
    const boss = feature("cylinder", { diameter: 10, height: 10, x: -8, y: 0, z: 5 }, "add");
    const r0 = build([base, boss]);
    const foot = r0.parts[0].edgeRefs.filter((e) => (e as FaceInfo).curve === "CIRCLE" && Math.abs(((e as FaceInfo).a ?? [0, 0, 0])[2] - 5) < 1e-6);
    expect(foot).toHaveLength(1);
    const fil: Feature = { ...feature("fillet", { radius: 2 }), picks: foot.map((ref) => ({ partId: r0.parts[0].id, ref })) };
    const fs = [base, boss, fil];
    const r1 = build(fs);
    const v0 = volume();
    const top = (f: FaceInfo) => f.surface === "PLANE" && f.normal![2] > 0.99 && Math.abs(f.center![2] - 15) < 1e-6;
    const all = faces(r1, (f) => f.surface !== "PLANE" || top(f));
    expect(all).toHaveLength(3);
    const side = move({ mode: "translate", axis: "x" }, { distance: 12 }, all);
    expect(build([...fs, side]).featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(v0, 5);
    for (const flip of [false, true]) {
      const lift = move({ mode: "translate", axis: "z", flip }, { distance: 3 }, all);
      expect(build([...fs, lift]).featureErrors[lift.id]).toMatch(/aren't straight at its foot/);
    }
    const noFoot = faces(r1, (f) => f.surface === "CYLINDRE" || top(f));
    expect(build([...fs, { ...side, picks: noFoot }]).featureErrors[side.id]).toMatch(/foot isn't picked/);
  });
});
