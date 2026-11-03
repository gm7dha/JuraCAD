/**
 * Library designs built with the real geometry engine: each makes sound
 * solids of the expected size, follows its variables, and the finger box's
 * panels fit together without overlapping.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { lensArea } from "../src/library/designs/knob";
import { roundedRectArea } from "../src/library/designs/common";
import { fingerBoxSizes } from "../src/library/designs/fingerBox";
import { shellVolume } from "../src/library/fingers";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

function insert(id: string, values: DesignValues = {}): JuraCADDocument {
  const d = findDesign(id)!;
  return insertDesign(emptyDocument(), d, { ...defaultValues(d), ...values }, { into: MAIN_STUDIO }).doc;
}

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const volume = check.parts.reduce((n, p) => n + (p.exactVolume ?? 0), 0);
  return { parts: r.parts, volume, volumes: check.parts.map((p) => p.exactVolume ?? 0) };
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

/** The volume shared by any two of the parts (should be 0 for panels that only touch). */
function overlap(parts: PartMesh[]): number {
  const ID: [number, number, number, number] = [0, 0, 0, 1];
  const shared = engine.clashes(
    parts.map((p) => ({ id: p.id, partId: p.id, name: p.name, position: [0, 0, 0], rotation: ID })),
    0.001,
    false,
  );
  return shared.reduce((n, c) => n + (c.volume ?? 0), 0);
}

describe("finger-joint box", () => {
  it("makes six panels that fit together exactly: no overlaps, and they add up to the box", () => {
    const doc = insert("finger-box");
    const r = build(doc);
    expect(r.parts).toHaveLength(6);
    const b = fingerBoxSizes(defaultValues(findDesign("finger-box")!));
    expect(r.volume).toBeCloseTo(shellVolume(b), 0);
    // Each panel is the sheet's thickness: one of its sizes is 3 mm.
    for (const p of r.parts) {
      const { min, max } = box([p]);
      expect(Math.min(...[0, 1, 2].map((k) => max[k] - min[k]))).toBeCloseTo(3, 3);
    }
    const all = box(r.parts);
    [120, 80, 60].forEach((size, k) => {
      expect(all.min[k]).toBeCloseTo(0, 3);
      expect(all.max[k]).toBeCloseTo(size, 3);
    });
    expect(overlap(r.parts)).toBeLessThan(0.01);
  });

  it("rebuilds wider when its width variable changes", () => {
    const doc = setVar(insert("finger-box"), "box_width", "150");
    const r = build(doc);
    expect(box(r.parts).max[0]).toBeCloseTo(150, 3);
    const b = fingerBoxSizes({ ...defaultValues(findDesign("finger-box")!), width: 150 });
    expect(r.volume).toBeCloseTo(shellVolume(b), 0);
    expect(overlap(r.parts)).toBeLessThan(0.01);
  });

  it("can be measured inside, without a lid", () => {
    const values = { measure: "inside", width: 100, depth: 70, height: 50, lid: false, finger: 12 };
    const r = build(insert("finger-box", values));
    expect(r.parts).toHaveLength(5);
    const all = box(r.parts);
    [106, 76, 53].forEach((size, k) => expect(all.max[k] - all.min[k]).toBeCloseTo(size, 3));
    expect(r.volume).toBeCloseTo(shellVolume(fingerBoxSizes({ ...defaultValues(findDesign("finger-box")!), ...values })), 0);
    expect(overlap(r.parts)).toBeLessThan(0.01);
  });

  it("draws the panels bigger by the kerf allowance", () => {
    const r = build(insert("finger-box", { kerf: 0.2 }));
    const all = box(r.parts);
    expect(all.min[0]).toBeCloseTo(-0.1, 3);
    expect(all.max[0]).toBeCloseTo(120.1, 3);
    // Thickness isn't changed: the laser cuts straight through.
    expect(all.min[2]).toBeCloseTo(-0.1, 3);
    // Neighbouring fingers now overlap a little in 3D (the laser burns that away), so the check above would see it.
    expect(overlap(r.parts)).toBeGreaterThan(1);
  });
});

describe("3D-printed designs", () => {
  it("tray: an open box with rounded corners, that follows its height", () => {
    const [w, d, h, wall, floor, r] = [100, 70, 30, 2, 2, 6];
    const outer = roundedRectArea(w, d, r);
    const inner = roundedRectArea(w - 2 * wall, d - 2 * wall, r - wall);
    const doc = insert("tray");
    const a = build(doc);
    expect(a.parts).toHaveLength(1);
    expect(a.volume).toBeCloseTo(outer * floor + (outer - inner) * (h - floor), 0);
    const b = build(setVar(doc, "tray_height", "50"));
    expect(b.volume).toBeCloseTo(outer * floor + (outer - inner) * (50 - floor), 0);
    expect(box(b.parts).max[2]).toBeCloseTo(50, 3);
  });

  it("tray with square corners", () => {
    const a = build(insert("tray", { radius: 0 }));
    expect(a.volume).toBeCloseTo(100 * 70 * 2 + (100 * 70 - 96 * 66) * 28, 0);
  });

  it("bracket: two arms, four holes and two gussets", () => {
    const [A, B, W, t, dHole, g] = [60, 60, 30, 4, 4.5, 25];
    const a = build(insert("bracket"));
    expect(a.parts).toHaveLength(1);
    const expected = (A * t + (B - t) * t) * W - 4 * Math.PI * (dHole / 2) ** 2 * t + 2 * ((g * g) / 2) * t;
    expect(a.volume).toBeCloseTo(expected, 0);
    const all = box(a.parts);
    [A, W, B].forEach((size, k) => expect(all.max[k] - all.min[k]).toBeCloseTo(size, 3));
    const plain = build(insert("bracket", { holes: "0", gussets: false }));
    expect(plain.volume).toBeCloseTo((A * t + (B - t) * t) * W, 0);
  });

  it("spacer: a ring", () => {
    const doc = insert("spacer");
    expect(build(doc).volume).toBeCloseTo((Math.PI / 4) * (12 ** 2 - 3.4 ** 2) * 5, 1);
    expect(build(setVar(doc, "spacer_thickness", "8")).volume).toBeCloseTo((Math.PI / 4) * (12 ** 2 - 3.4 ** 2) * 8, 1);
  });

  it("knob: notches round the edge and a shaft hole, and the number of notches is a variable", () => {
    const [D, H, s, depth, g] = [30, 15, 6.2, 12, 4];
    const expected = (n: number) => Math.PI * (D / 2) ** 2 * H - n * lensArea(D / 2, g / 2, D / 2) * H - Math.PI * (s / 2) ** 2 * depth;
    const doc = insert("knob");
    expect(build(doc).volume).toBeCloseTo(expected(12), 0);
    expect(build(setVar(doc, "knob_grips", "8")).volume).toBeCloseTo(expected(8), 0);
  });
});
