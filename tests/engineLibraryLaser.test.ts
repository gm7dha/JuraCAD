/**
 * The laser library designs (and the printed stamp) built with the real
 * geometry engine: sound flat parts of the expected size, and what Export for
 * laser makes of them — a stencil's letter holes with every middle held on,
 * a rubber stamp's engraved background with mirrored words.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { pathsBox, segmentPoints, type LaserPath } from "../src/laser/laser";
import { outlinePiece, sketchPiece, type LaserOutline } from "../src/laser/sources";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign, laserDefaultsFor } from "../src/library/insert";
import { stencilPlan, stencilSheet } from "../src/library/designs/stencil";
import { stampLayout } from "../src/library/designs/stamp";
import { gearSizes } from "../src/library/designs/workshop";
import { blockContours, fontOf, inkArea, linesOf } from "../src/library/textKit";
import type { DesignValues } from "../src/library/types";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});
afterAll(() => engine?.dispose());

type P2 = [number, number];

function insert(id: string, values: DesignValues = {}): JuraCADDocument {
  const d = findDesign(id)!;
  return insertDesign(emptyDocument(), d, { ...defaultValues(d), ...values }, { into: MAIN_STUDIO }).doc;
}

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  return { parts: r.parts, volumes: check.parts.map((p) => p.exactVolume ?? 0), warnings: r.featureWarnings ?? {} };
}

function box(parts: PartMesh[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts)
    for (let i = 0; i < p.vertices.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p.vertices[i + k]);
        max[k] = Math.max(max[k], p.vertices[i + k]);
      }
  return { min, max };
}

const okOf = (o: LaserOutline) => {
  if (!o.ok) throw new Error(o.error);
  return o;
};

/** A path as a polygon (curves in short pieces). */
const polygonOf = (p: LaserPath): P2[] => p.segments.flatMap((s, i) => segmentPoints(s, 0.01).slice(i ? 1 : 0));

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const area = (poly: P2[]) => Math.abs(poly.reduce((a, [x1, y1], i) => a + x1 * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * y1, 0)) / 2;

/** The area filled even–odd by these loops (each loop's area, minus where it's inside an odd number of others). */
const evenOddArea = (loops: P2[][]) => loops.reduce((n, l, i) => n + (loops.filter((m, j) => j !== i && inside(l[0], m)).length % 2 ? -1 : 1) * area(l), 0);

/** The laser outline of a whole part (its biggest flat face). */
function partPiece(partId: string) {
  return outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId }])[0]));
}

describe("stencil", () => {
  it("HELLO: one sheet, letter holes cut through, the O's middle held by a bridge", () => {
    const doc = insert("stencil", { words: "HELLO" });
    const r = build(doc);
    expect(r.parts).toHaveLength(1);
    const v = { ...defaultValues(findDesign("stencil")!), words: "HELLO" };
    const corners = stencilSheet(v);
    const [w, h] = [corners[1][0] - corners[0][0], corners[2][1] - corners[0][1]];
    const ink = inkArea(blockContours({ font: fontOf(v), capHeight: 30, lines: ["HELLO"] }));
    // The sheet less the letters, plus a little back where the bridge crosses the O.
    expect(r.volumes[0]).toBeGreaterThan((w * h - ink) * 1);
    expect(r.volumes[0]).toBeLessThan((w * h - ink) * 1 + 2 * 30 * 1);
    const piece = partPiece(r.parts[0].id);
    const outer = piece.paths.filter((p) => p.layer === "outer");
    const holes = piece.paths.filter((p) => p.layer === "inner");
    expect(outer).toHaveLength(1);
    const b = pathsBox(outer)!;
    expect(b[2] - b[0]).toBeCloseTo(w, 2);
    expect(b[3] - b[1]).toBeCloseTo(h, 2);
    // H, E, L, L and the O (one hole round its middle, open where the bridge is): five holes, none inside another.
    expect(holes).toHaveLength(5);
    const polys = holes.map(polygonOf);
    for (const [i, p] of polys.entries()) for (const [j, q] of polys.entries()) if (i !== j) expect(inside(p[0], q)).toBe(false);
  });

  it("holds every middle of B, A, R, 4, 6, 8 and 0 — no loop is left floating inside a hole", () => {
    const words = "BAR 4680";
    const r = build(insert("stencil", { words, height: 25, steady: true }));
    expect(r.parts).toHaveLength(1);
    const v = { ...defaultValues(findDesign("stencil")!), words, height: 25, steady: true };
    const plan = stencilPlan(v).plan;
    expect(plan.islands).toHaveLength(9);
    expect(plan.unheld).toEqual([]);
    expect(plan.bridges).toHaveLength(18);
    const piece = partPiece(r.parts[0].id);
    const holes = piece.paths.filter((p) => p.layer === "inner").map(polygonOf);
    // With two bridges each, every ring is cut into two holes: 7 letters without middles… and none nested.
    for (const [i, p] of holes.entries()) for (const [j, q] of holes.entries()) if (i !== j) expect(inside(p[0], q)).toBe(false);
    expect(piece.paths.filter((p) => p.layer === "outer")).toHaveLength(1);
  });

  it("follows its thickness variable", () => {
    const doc = insert("stencil", { words: "OK" });
    const a = build(doc);
    const b = build(applyVariables(doc, doc.variables!.map((x) => (x.name === "stencil_thickness" ? { ...x, value: "3" } : x))));
    expect(b.volumes[0]).toBeCloseTo(a.volumes[0] * 3, 0);
    expect(box(b.parts).max[2] - box(b.parts).min[2]).toBeCloseTo(3, 4);
  });
});

describe("rubber stamp", () => {
  it("is a plate with its background cut away; Export for laser engraves exactly the background, words mirrored", () => {
    const values = { words: "FRED", border: true };
    const doc = insert("rubber-stamp", values);
    const r = build(doc);
    expect(r.parts).toHaveLength(1);
    const v = { ...defaultValues(findDesign("rubber-stamp")!), ...values };
    const L = stampLayout(v);
    const plate = L.size[0] * L.size[1];
    const ring = L.border!.outer[0] * L.border!.outer[1] - L.border!.inner[0] * L.border!.inner[1];
    const letters = blockContours({ font: fontOf(v), capHeight: 6, lines: linesOf(v.words), mirror: true });
    const ink = inkArea(letters);
    const background = plate - ring - ink;
    expect(r.volumes[0]).toBeCloseTo(plate * 2.3 - background * 1, 0);
    // The design's sketch, as the laser panel gives it (its own setting: engrave the background).
    const sketch = doc.features.find((f) => f.name === "Stamp sketch")!;
    const opts = laserDefaultsFor(doc, sketch.id);
    expect(opts).toEqual({ background: true });
    const piece = sketchPiece(sketch.name, sketch.sketch!.data, opts!);
    const engraved = piece.paths.filter((p) => p.layer === "engrave").map(polygonOf);
    expect(evenOddArea(engraved)).toBeCloseTo(background, 0);
    const cut = piece.paths.filter((p) => p.layer === "outer");
    expect(cut).toHaveLength(1);
    expect(pathsBox(cut)![2] - pathsBox(cut)![0]).toBeCloseTo(50, 6);
    expect(piece.paths.filter((p) => p.layer === "inner")).toHaveLength(0);
    // Mirrored: the F's stem is on its right (it reads backwards on the plate, and right once printed).
    const F = blockContours({ font: fontOf(v), capHeight: 6, lines: ["F"], mirror: true })[0];
    const xs = F.map((p) => p[0]);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const tall = F.filter((p) => p[0] > mid).length;
    expect(tall).toBeGreaterThan(F.length / 2 - 1);
    // The plate's top face is the stamp's face, on the Top plane; the rubber goes down from it.
    const b = box(r.parts);
    expect(b.max[2]).toBeCloseTo(0, 4);
    expect(b.min[2]).toBeCloseTo(-2.3, 4);
  });

  it("can be round, without a border", () => {
    const doc = insert("rubber-stamp", { shape: "round", width: 40, border: false, words: "OK" });
    const r = build(doc);
    expect(r.parts).toHaveLength(1);
    const v = { ...defaultValues(findDesign("rubber-stamp")!), words: "OK" };
    const ink = inkArea(blockContours({ font: fontOf(v), capHeight: 6, lines: ["OK"], mirror: true }));
    const plate = Math.PI * 400;
    expect(r.volumes[0]).toBeCloseTo(plate * 2.3 - (plate - ink) * 1, 0);
  });

  it("3D printed: a block with the words standing up on it and a handle beside it, all on the bed", () => {
    const r = build(insert("printed-stamp", { words: "HI" }));
    expect(r.parts).toHaveLength(2);
    const b = box(r.parts);
    expect(b.min[2]).toBeCloseTo(0, 4);
    expect(b.max[2]).toBeCloseTo(30, 4);
    const block = r.parts.find((p) => p.id.endsWith("_block"))!;
    expect(box([block]).max[2]).toBeCloseTo(6.5, 4);
  });
});

describe("other laser designs", () => {
  it("coasters: a set of separate plates, each with its words engraved", () => {
    const doc = insert("coaster", { count: 3, shape: "round", size: 90, words: "HI" });
    const r = build(doc);
    expect(r.parts).toHaveLength(3);
    const v = { ...defaultValues(findDesign("coaster")!), words: "HI" };
    const ink = inkArea(blockContours({ font: fontOf(v), capHeight: 12, lines: ["HI"] }));
    for (const vol of r.volumes) expect(vol).toBeCloseTo(Math.PI * 45 * 45 * 3 - ink * 0.4, 0);
    const sketch = doc.features.find((f) => f.type === "sketch")!;
    const piece = sketchPiece(sketch.name, sketch.sketch!.data, laserDefaultsFor(doc, sketch.id)!);
    expect(piece.paths.filter((p) => p.layer === "outer")).toHaveLength(3);
    expect(piece.paths.filter((p) => p.layer === "inner")).toHaveLength(0);
    expect(piece.paths.filter((p) => p.layer === "engrave").length).toBeGreaterThan(0);
  });

  it("square and six-sided coasters, and plain ones without words", () => {
    expect(build(insert("coaster", { count: 1, shape: "square", words: "" })).volumes[0]).toBeCloseTo((95 * 95 - (4 - Math.PI) * 64) * 3, 0);
    const hex = build(insert("coaster", { count: 2, shape: "hexagon", words: "" }));
    expect(hex.parts).toHaveLength(2);
    expect(hex.volumes[0]).toBeCloseTo((Math.sqrt(3) / 2) * 95 * 95 * 3, 0);
  });

  it("name tag: a plate with a hole and engraved words", () => {
    const doc = insert("name-tag", { corner: 0 });
    const r = build(doc);
    const v = { ...defaultValues(findDesign("name-tag")!) };
    const ink = inkArea(blockContours({ font: fontOf(v), capHeight: 8, lines: ["SAM"] }));
    expect(r.volumes[0]).toBeCloseTo((60 * 20 - Math.PI * 6.25) * 3 - ink * 0.4, 0);
    const sketch = doc.features.find((f) => f.type === "sketch")!;
    const piece = sketchPiece(sketch.name, sketch.sketch!.data, laserDefaultsFor(doc, sketch.id)!);
    expect(piece.paths.filter((p) => p.layer === "inner")).toHaveLength(1);
    expect(evenOddArea(piece.paths.filter((p) => p.layer === "engrave").map(polygonOf))).toBeCloseTo(ink, 0);
  });

  it("ruler: the marks are scored, the numbers engraved, the outline cut", () => {
    const doc = insert("ruler", { length: 100 });
    const r = build(doc);
    expect(r.parts).toHaveLength(1);
    const sketch = doc.features.find((f) => f.type === "sketch")!;
    const opts = laserDefaultsFor(doc, sketch.id)!;
    expect(opts.open).toBe("score");
    const piece = sketchPiece(sketch.name, sketch.sketch!.data, opts);
    expect(piece.paths.filter((p) => p.layer === "score")).toHaveLength(101);
    expect(piece.paths.filter((p) => p.layer === "outer")).toHaveLength(1);
    expect(piece.paths.filter((p) => p.layer === "inner")).toHaveLength(1);
    expect(piece.paths.filter((p) => p.layer === "engrave").length).toBeGreaterThan(10);
  });

  it("living hinge: a plain panel in 3D, its cuts in the sketch as blue lines", () => {
    const doc = insert("living-hinge");
    const r = build(doc);
    expect(r.volumes[0]).toBeCloseTo(150 * 80 * 3, 0);
    const sketch = doc.features.find((f) => f.type === "sketch")!;
    const piece = sketchPiece(sketch.name, sketch.sketch!.data);
    expect(piece.paths.filter((p) => p.layer === "outer")).toHaveLength(1);
    expect(piece.paths.filter((p) => p.layer === "inner" && !p.closed).length).toBeGreaterThan(50);
  });

  it("gear: teeth between the root and outside circles, with its middle hole", () => {
    const r = build(insert("gear"));
    const s = gearSizes(24, 2, 20);
    const b = box(r.parts);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(2 * s.outside - 0.5);
    expect(b.max[0] - b.min[0]).toBeLessThan(2 * s.outside + 1e-3);
    const hole = Math.PI * 9;
    expect(r.volumes[0]).toBeGreaterThan((Math.PI * s.root ** 2 - hole) * 3);
    expect(r.volumes[0]).toBeLessThan((Math.PI * s.outside ** 2 - hole) * 3);
    const piece = partPiece(r.parts[0].id);
    expect(piece.paths.filter((p) => p.layer === "inner")).toHaveLength(1);
  });

  it("picture frame: three layers stacked, the photo's slot open at the top", () => {
    const r = build(insert("picture-frame"));
    expect(r.parts).toHaveLength(3);
    const b = box(r.parts);
    expect(b.max[0] - b.min[0]).toBeCloseTo(142, 3);
    expect(b.max[1] - b.min[1]).toBeCloseTo(192, 3);
    expect(b.max[2] - b.min[2]).toBeCloseTo(9, 3);
    const [W, H] = [142, 192];
    const vols = Object.fromEntries(r.parts.map((p, i) => [p.id.split("_").pop()!, r.volumes[i]]));
    expect(vols.back).toBeCloseTo((W * H - Math.PI * 6.25) * 3, 0);
    expect(vols.front).toBeCloseTo((W * H - 94 * 144) * 3, 0);
    expect(vols.middle).toBeCloseTo((W * H - 103 * (76.5 + 96)) * 3, 0);
  });
});

describe("engraving reaches only the design's own plates", () => {
  const sumOf = (vols: number[]) => vols.reduce((a, b) => a + b, 0);

  for (const id of ["coaster", "name-tag", "ruler", "rubber-stamp", "stencil"])
    it(`${id}: a user's board right under it is left alone`, () => {
      const alone = build(insert(id));
      // The user's board, through the Top plane, covering the whole design.
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "600", depth: "200", height: "6", x: "-100", y: "-100", z: "-3" } }] };
      const d = findDesign(id)!;
      doc = insertDesign(doc, d, defaultValues(d), { into: MAIN_STUDIO }).doc;
      const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
      expect(r.featureErrors).toEqual({});
      const check = engine.check("normal");
      expect(check.parts.find((p) => p.partId === "mine")!.exactVolume!).toBeCloseTo(600 * 200 * 6, 3);
      expect(check.parts).toHaveLength(alone.parts.length + 1);
      expect(sumOf(check.parts.filter((p) => p.partId !== "mine").map((p) => p.exactVolume ?? 0))).toBeCloseTo(sumOf(alone.volumes), 2);
    });

  it("coasters with words don't engrave plain coasters already there", () => {
    const plain = insert("coaster", { count: 2, words: "" });
    const full = Math.PI * 47.5 * 47.5 * 3;
    const d = findDesign("coaster")!;
    const doc = insertDesign(plain, d, { ...defaultValues(d), count: 2 }, { into: MAIN_STUDIO }).doc;
    const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal");
    expect(check.parts).toHaveLength(4);
    const v = { ...defaultValues(d) };
    const ink = inkArea(blockContours({ font: fontOf(v), capHeight: 12, lines: linesOf(v.words) }));
    const vols = check.parts.map((p) => p.exactVolume ?? 0).sort((a, b) => a - b);
    // The two new ones engraved, the two plain ones untouched.
    expect(vols[0]).toBeCloseTo(full - ink * 0.4, 0);
    expect(vols[1]).toBeCloseTo(full - ink * 0.4, 0);
    expect(vols[2]).toBeCloseTo(full, 3);
    expect(vols[3]).toBeCloseTo(full, 3);
  });
});
