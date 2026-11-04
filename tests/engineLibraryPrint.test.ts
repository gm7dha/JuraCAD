/**
 * The Design library's newer designs (3D printing: box with lid, wall hook, cable clip, phone stand, print-in-place
 * hinge; laser cutting: the flat-pack phone stand) built with the real geometry engine: sound solids of the expected
 * volume and size, flat on the bed, parts that don't overlap, and a user's part left alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { boxLidVolumes, LID_GAP } from "../src/library/designs/boxLid";
import { clipVolume } from "../src/library/designs/cableClip";
import { countersunkHoleVolume, polygonArea, varsOf } from "../src/library/designs/common";
import { flatStandAreas } from "../src/library/designs/flatStand";
import { hingeVolumes } from "../src/library/designs/hinge";
import { hookOutline } from "../src/library/designs/hook";
import { standProfileArea } from "../src/library/designs/phoneStand";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

const valuesOf = (id: string, values: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...values });

function insert(id: string, values: DesignValues = {}): JuraCADDocument {
  return insertDesign(emptyDocument(), findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
}

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const volumes = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  const volume = Object.values(volumes).reduce((n, v) => n + v, 0);
  return { parts: r.parts, volume, volumes };
}

function box(parts: PartMesh[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let i = 0; i < p.vertices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p.vertices[i + k]);
        max[k] = Math.max(max[k], p.vertices[i + k]);
      }
    }
  }
  return { min, max };
}

const setVar = (doc: JuraCADDocument, name: string, value: string) => applyVariables(doc, doc.variables!.map((v) => (v.name === name ? { ...v, value } : v)));
const ID: [number, number, number, number] = [0, 0, 0, 1];
const partEnding = (parts: PartMesh[], end: string) => parts.find((p) => p.id.endsWith(end))!;

/** The volume two parts share, with the second moved by `shift`. */
function shared(a: PartMesh, b: PartMesh, shift: [number, number, number] = [0, 0, 0]): number {
  const found = engine.clashes(
    [
      { id: "a", partId: a.id, name: a.name, position: [0, 0, 0], rotation: ID },
      { id: "b", partId: b.id, name: b.name, position: shift, rotation: ID },
    ],
    0.001,
    false,
  );
  return found.reduce((n, c) => n + (c.volume ?? 0), 0);
}

/** Flat on the bed: nothing below z = 0, and something on it. */
function onTheBed(parts: PartMesh[]) {
  for (const p of parts) expect(box([p]).min[2]).toBeCloseTo(0, 4);
}

describe("box with lid", () => {
  it("makes a box and a lid beside it, both standing on the bed", () => {
    const v = valuesOf("box-lid");
    const r = build(insert("box-lid"));
    expect(r.parts).toHaveLength(2);
    const expected = boxLidVolumes(v);
    const boxPart = partEnding(r.parts, "_box");
    const lid = partEnding(r.parts, "_lid");
    expect(r.volumes[boxPart.id]).toBeCloseTo(expected.box, 0);
    expect(r.volumes[lid.id]).toBeCloseTo(expected.lid, 0);
    onTheBed(r.parts);
    const b = box([boxPart]);
    const l = box([lid]);
    // The lid's outside is the box's outside + 2 × (clearance + wall); it's LID_GAP to the right of the box.
    expect(l.max[0] - l.min[0]).toBeCloseTo(80 + 2 * 0.2 + 2 * 2, 3);
    expect(l.max[1] - l.min[1]).toBeCloseTo(60 + 2 * 0.2 + 2 * 2, 3);
    expect(l.min[0] - b.max[0]).toBeCloseTo(LID_GAP, 3);
    expect(l.max[2]).toBeCloseTo(12, 3);
    expect(b.max[2]).toBeCloseTo(40, 3);
  });

  it("the lid's inside is the box's outside plus the clearance all round, so it fits over", () => {
    const r = build(insert("box-lid", { placement: "on" }));
    const boxPart = partEnding(r.parts, "_box");
    const lid = partEnding(r.parts, "_lid");
    const l = box([lid]);
    // Turned over onto the box: its top's underside on the rim (z 40), its sides down to 40 + 2 − 12.
    expect(l.max[2]).toBeCloseTo(42, 3);
    expect(l.min[2]).toBeCloseTo(30, 3);
    expect(shared(boxPart, lid)).toBeLessThan(0.01);
    // There's a 0.2 mm gap all round: moving the lid 0.18 mm any way sideways it still doesn't touch …
    for (const shift of [[0.18, 0, 0], [-0.18, 0, 0], [0, 0.18, 0], [0, -0.18, 0]] as [number, number, number][]) expect(shared(boxPart, lid, shift)).toBeLessThan(0.01);
    // … but 0.3 mm and it runs into the box's wall.
    expect(shared(boxPart, lid, [0.3, 0, -1])).toBeGreaterThan(1);
  });

  it("follows its variables: a looser fit makes the lid bigger", () => {
    const doc = setVar(insert("box-lid"), "lidbox_clearance", "0.5");
    const r = build(doc);
    const l = box([partEnding(r.parts, "_lid")]);
    expect(l.max[0] - l.min[0]).toBeCloseTo(80 + 2 * 0.5 + 2 * 2, 3);
    expect(r.volume).toBeCloseTo(boxLidVolumes(valuesOf("box-lid", { clearance: 0.5 })).box + boxLidVolumes(valuesOf("box-lid", { clearance: 0.5 })).lid, 0);
  });
});

describe("wall hook", () => {
  const hookVolume = (v: DesignValues, holes: number) => {
    const pts = hookOutline(varsOf(v, ["depth", "height", "width", "thickness", "tip", "hole"])).map(([x, y]) => [x.v, y.v] as [number, number]);
    const d = Number(v.hole);
    return polygonArea(pts) * Number(v.width) - holes * countersunkHoleVolume(d, 2 * d, Number(v.thickness));
  };
  it("is a J-shaped hook with two countersunk screw holes, lying on its side", () => {
    const v = valuesOf("hook");
    const r = build(insert("hook"));
    expect(r.parts).toHaveLength(1);
    expect(r.volume).toBeCloseTo(hookVolume(v, 2), 0);
    const b = box(r.parts);
    [[-5, 35], [0, 60], [0, 20]].forEach(([lo, hi], k) => {
      expect(b.min[k]).toBeCloseTo(lo, 3);
      expect(b.max[k]).toBeCloseTo(hi, 3);
    });
  });
  it("with one hole, and deeper", () => {
    const doc = setVar(insert("hook", { holes: "1" }), "hook_depth", "55");
    const r = build(doc);
    expect(r.volume).toBeCloseTo(hookVolume(valuesOf("hook", { holes: "1", depth: 55 }), 1), 0);
    expect(box(r.parts).max[0]).toBeCloseTo(50, 3);
  });
});

describe("cable clip", () => {
  it("is a C-shaped ring on a base with a countersunk screw hole", () => {
    const r = build(insert("cable-clip"));
    expect(r.parts).toHaveLength(1);
    expect(r.volume).toBeCloseTo(clipVolume(valuesOf("cable-clip")), 0);
    onTheBed(r.parts);
    expect(box(r.parts).max[2]).toBeCloseTo(10, 3);
  });
  it("for sticky tape: a flat back and no hole; and it follows the cable size", () => {
    const doc = setVar(insert("cable-clip", { fixing: "tape" }), "clip_cable", "8");
    const r = build(doc);
    expect(r.volume).toBeCloseTo(clipVolume(valuesOf("cable-clip", { fixing: "tape", cable: 8 })), 0);
    const b = box(r.parts);
    // Ring: 8 mm hole + 2 × 2 mm walls; the base just as long.
    expect(b.max[1] - b.min[1]).toBeCloseTo(12, 3);
  });
});

describe("phone / tablet stand", () => {
  it("is its side profile made as wide as the stand, lying on the bed", () => {
    const v = valuesOf("phone-stand");
    const r = build(insert("phone-stand"));
    expect(r.parts).toHaveLength(1);
    expect(r.volume).toBeCloseTo(standProfileArea(v) * 70, 0);
    onTheBed(r.parts);
    expect(box(r.parts).max[2]).toBeCloseTo(70, 3);
  });
  it("follows its slot variable, and leans at a new angle after Edit design sizes", () => {
    const r = build(setVar(insert("phone-stand"), "stand_slot", "15"));
    expect(r.volume).toBeCloseTo(standProfileArea(valuesOf("phone-stand", { slot: 15 })) * 70, 0);
    const steep = build(insert("phone-stand", { angle: 75 }));
    expect(steep.volume).toBeCloseTo(standProfileArea(valuesOf("phone-stand", { angle: 75 })) * 70, 0);
  });
});

describe("print-in-place hinge", () => {
  it("makes two leaves and a pin of the expected sizes, lying flat", () => {
    const v = valuesOf("hinge");
    const r = build(insert("hinge"));
    expect(r.parts).toHaveLength(3);
    const want = hingeVolumes(v);
    expect(r.volumes[partEnding(r.parts, "_leaf1").id]).toBeCloseTo(want.leaf1, 0);
    expect(r.volumes[partEnding(r.parts, "_leaf2").id]).toBeCloseTo(want.leaf2, 0);
    expect(r.volumes[partEnding(r.parts, "_pin").id]).toBeCloseTo(want.pin, 1);
    const all = box(r.parts);
    // (The view's mesh of the round knuckles sits a few µm inside the true circle.)
    [[0, 50], [-20, 20], [0, 7]].forEach(([lo, hi], k) => {
      expect(all.min[k]).toBeCloseTo(lo, 1);
      expect(all.max[k]).toBeCloseTo(hi, 1);
    });
    onTheBed([partEnding(r.parts, "_leaf1"), partEnding(r.parts, "_leaf2")]);
  });

  it("its parts don't overlap, and there's at least the clearance between the parts that move", () => {
    const c = 0.4;
    const r = build(insert("hinge"));
    const [leaf1, leaf2, pin] = ["_leaf1", "_leaf2", "_pin"].map((e) => partEnding(r.parts, e));
    expect(shared(leaf1, leaf2)).toBeLessThan(0.001);
    expect(shared(leaf2, pin)).toBeLessThan(0.001);
    expect(shared(leaf1, pin)).toBeLessThan(0.01);
    // Moving the second leaf (or the pin, in it) by 90% of the clearance any way still touches nothing …
    const nudges: [number, number, number][] = [[0.9 * c, 0, 0], [-0.9 * c, 0, 0], [0, -0.9 * c, 0], [0, 0, 0.9 * c], [0, 0, -0.9 * c]];
    for (const n of nudges) {
      expect(shared(leaf1, leaf2, n)).toBeLessThan(0.001);
      expect(shared(leaf2, pin, n)).toBeLessThan(0.001);
    }
    // … while twice the clearance along the pin runs the knuckles into each other.
    expect(shared(leaf1, leaf2, [2 * c, 0, 0])).toBeGreaterThan(0.1);
  });

  it("with seven knuckles and a bigger clearance (a variable)", () => {
    const doc = setVar(insert("hinge", { knuckles: 7 }), "hinge_clearance", "0.5");
    const r = build(doc);
    const want = hingeVolumes(valuesOf("hinge", { knuckles: 7, clearance: 0.5 }));
    expect(r.volume).toBeCloseTo(want.leaf1 + want.leaf2 + want.pin, 0);
  });
});

describe("flat-pack phone stand (laser)", () => {
  it("makes a side and two feet of flat sheet that slot together without overlapping", () => {
    const v = valuesOf("flat-stand");
    const r = build(insert("flat-stand"));
    expect(r.parts).toHaveLength(3);
    const a = flatStandAreas(v);
    expect(r.volumes[partEnding(r.parts, "_side").id]).toBeCloseTo(a.side * 3, 0);
    expect(r.volumes[partEnding(r.parts, "_front-foot").id]).toBeCloseTo(a.foot * 3, 0);
    expect(r.volumes[partEnding(r.parts, "_back-foot").id]).toBeCloseTo(a.foot * 3, 0);
    // Each piece is the sheet's thickness.
    for (const p of r.parts) {
      const { min, max } = box([p]);
      expect(Math.min(...[0, 1, 2].map((k) => max[k] - min[k]))).toBeCloseTo(3, 3);
    }
    const [side, front, back] = ["_side", "_front-foot", "_back-foot"].map((e) => partEnding(r.parts, e));
    expect(shared(side, front)).toBeLessThan(0.001);
    expect(shared(side, back)).toBeLessThan(0.001);
    onTheBed(r.parts);
  });
  it("follows the sheet thickness", () => {
    const r = build(setVar(insert("flat-stand"), "fstand_thickness", "4"));
    const a = flatStandAreas(valuesOf("flat-stand", { thickness: 4 }));
    expect(r.volume).toBeCloseTo((a.side + 2 * a.foot) * 4, 0);
    const [side, front] = ["_side", "_front-foot"].map((e) => partEnding(r.parts, e));
    expect(shared(side, front)).toBeLessThan(0.001);
  });
});

describe("put into a Part Studio that already has a part", () => {
  for (const id of ["box-lid", "hook", "cable-clip", "phone-stand", "hinge", "flat-stand"]) {
    it(`${id}: leaves the user's part alone, even where they overlap`, () => {
      const alone = build(insert(id));
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "200", depth: "200", height: "10", x: "-100", y: "-100", z: "-2" } }] };
      const d = findDesign(id)!;
      doc = insertDesign(doc, d, defaultValues(d), { into: MAIN_STUDIO }).doc;
      const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
      expect(r.featureErrors).toEqual({});
      const check = engine.check("normal");
      expect(check.parts.find((p) => p.partId === "mine")!.exactVolume!).toBeCloseTo(200 * 200 * 10, 3);
      expect(check.parts).toHaveLength(alone.parts.length + 1);
      const theirs = check.parts.filter((p) => p.partId !== "mine").reduce((n, p) => n + (p.exactVolume ?? 0), 0);
      expect(theirs).toBeCloseTo(alone.volume, 3);
    });
  }
});
