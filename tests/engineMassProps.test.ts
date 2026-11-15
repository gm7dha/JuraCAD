/**
 * Mass properties, closest points and which feature made each face — the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { massSummary } from "../src/model/massProps";
import type { Feature } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("mass properties", () => {
  it("a 10 × 20 × 30 box: volume 6000, area 2200, centre (5, 10, 15)", () => {
    const box = feature("box", { width: 10, depth: 20, height: 30 });
    const r = build([box]);
    const [m] = engine.massProperties([r.parts[0].id]);
    expect(m.volume).toBeCloseTo(6000, 6);
    expect(m.area).toBeCloseTo(2200, 6);
    expect(m.centre[0]).toBeCloseTo(5, 6);
    expect(m.centre[1]).toBeCloseTo(10, 6);
    expect(m.centre[2]).toBeCloseTo(15, 6);
    expect(m.box[1][0] - m.box[0][0]).toBeCloseTo(10, 4);
    expect(m.box[1][1] - m.box[0][1]).toBeCloseTo(20, 4);
    expect(m.box[1][2] - m.box[0][2]).toBeCloseTo(30, 4);
    // PLA: 6 cm³ × 1.24 g/cm³.
    expect(massSummary([m], () => 1.24).mass).toBeCloseTo(7.44, 6);
  });

  it("a cylinder (exact, not from the mesh) and two parts together", () => {
    const cyl = feature("cylinder", { diameter: 20, height: 30, x: 100, y: 0, z: 0 });
    const box = feature("box", { width: 10, depth: 20, height: 30 });
    const r = build([box, cyl]);
    const all = engine.massProperties([]);
    expect(all).toHaveLength(2);
    const c = all.find((p) => p.partId === r.parts.find((x) => x.featureIds.includes(cyl.id))!.id)!;
    expect(c.volume).toBeCloseTo(Math.PI * 100 * 30, 4);
    expect(c.area).toBeCloseTo(2 * Math.PI * 10 * 30 + 2 * Math.PI * 100, 4);
    expect(c.centre[0]).toBeCloseTo(100, 5);
    expect(c.centre[2]).toBeCloseTo(15, 5);
    // Together, weighted by mass: steel cylinder, PLA box.
    const s = massSummary(all, (id) => (id === c.partId ? 7.85 : 1.24));
    const mc = (c.volume / 1000) * 7.85;
    const mb = 6 * 1.24;
    expect(s.mass).toBeCloseTo(mc + mb, 6);
    expect(s.centre![0]).toBeCloseTo((mc * 100 + mb * 5) / (mc + mb), 5);
    expect(s.density).toBe(null);
  });
});

describe("closest points", () => {
  it("says where the shortest distance between two faces runs", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 25, y: 0, z: 0 });
    const r = build([a, b]);
    const side = (id: string, nx: number) => ({ partId: id, ref: r.parts.find((p) => p.id === id)!.faceRefs.find((f) => f.kind === "face" && f.normal[0] === nx)! });
    const m = engine.measure([side(r.parts[0].id, 1), side(r.parts[1].id, -1)]);
    expect(m.distance).toBeCloseTo(15, 6);
    expect(m.closest![0][0]).toBeCloseTo(10, 6);
    expect(m.closest![1][0]).toBeCloseTo(25, 6);
  });
});

describe("which feature made each face", () => {
  it("a box with a hole: the hole's wall is the cut's, the trimmed top and bottom still the box's", () => {
    const box = feature("box", { width: 40, depth: 40, height: 10 });
    const hole = feature("cylinder", { diameter: 10, height: 10, x: 20, y: 20, z: 0 }, "remove");
    const r = build([box, hole]);
    const part = r.parts[0];
    expect(part.faceMakers).toBeDefined();
    const makers = part.faceMakers!;
    expect(makers).toHaveLength(part.faceRefs.length);
    part.faceRefs.forEach((f, i) => {
      if (f.surface === "CYLINDRE") expect(makers[i]).toBe(hole.id);
      else expect(makers[i]).toBe(box.id);
    });
    expect(makers).toContain(hole.id);
  });

  it("a boss added on top: its faces are the boss's, the box's are the box's", () => {
    const box = feature("box", { width: 40, depth: 40, height: 10 });
    const boss = feature("box", { width: 10, depth: 10, height: 5, x: 15, y: 15, z: 10 }, "add");
    const r = build([box, boss]);
    const part = r.parts[0];
    const makers = part.faceMakers!;
    part.faceRefs.forEach((f, i) => {
      if (f.kind !== "face") return;
      const top = f.normal[2] > 0.5 && f.center[2] > 12;
      const bossSide = Math.abs(f.normal[2]) < 0.5 && f.center[2] > 10;
      expect(makers[i]).toBe(top || bossSide ? boss.id : box.id);
    });
  });

  const moveOf = (partId: string, params: Record<string, number>): Feature => ({
    ...feature("transform", params, "add"),
    transform: { partId, axis: "z", about: "centre", copy: false },
  });

  for (const [what, params] of [["moved 20 along X", { dx: 20 }], ["turned 30° about Z", { rz: 30 }], ["turned and moved", { rx: 15, rz: 30, dy: 5 }]] as const) {
    it(`a box ${what}: every face is still the box's (a Move only moves them)`, () => {
      const box = feature("box", { width: 10, depth: 20, height: 30 });
      const first = build([box]);
      const move = moveOf(first.parts[0].id, params);
      const r = build([box, move]);
      expect(r.featureErrors).toEqual({});
      expect(r.parts[0].faceMakers).toEqual(Array(6).fill(box.id));
    });
  }

  it("a fillet after a move: its round face is the fillet's, the rest the box's", () => {
    const box = feature("box", { width: 10, depth: 20, height: 30 });
    const first = build([box]);
    const move = moveOf(first.parts[0].id, { dx: 20 });
    const moved = build([box, move]);
    const part = moved.parts[0];
    const e = part.edgeRefs.findIndex((x) => x.kind === "edge" && x.curve === "LINE");
    const fillet: Feature = { ...feature("fillet", { radius: 2 }), picks: [{ partId: part.id, ref: part.edgeRefs[e] }] };
    const r = build([box, move, fillet]);
    expect(r.featureErrors).toEqual({});
    const makers = r.parts[0].faceMakers!;
    r.parts[0].faceRefs.forEach((f, i) => expect(makers[i]).toBe(f.surface === "CYLINDRE" ? fillet.id : box.id));
  });
});

