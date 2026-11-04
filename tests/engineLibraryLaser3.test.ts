/**
 * The third batch of laser designs built with the real geometry engine: sound flat parts of the right volume, boxes
 * and trays whose panels don't overlap when put together (kerf 0) and add up exactly (the joints tile), the sliding
 * lid that slides along its grooves with clearance but can't come out any other way, and what Export for laser makes
 * of each: outer cut, inner cuts and engraving where they should be.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { layoutPieces, pathsBox, segmentPoints, type LaserPath } from "../src/laser/laser";
import { laserDxf, laserSvg } from "../src/laser/laserFiles";
import { outlinePiece, sketchPiece, type LaserOutline } from "../src/laser/sources";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign, laserDefaultsFor } from "../src/library/insert";
import { shellVolume } from "../src/library/fingers";
import { bookendVolume, dividerTray, dividerVolume, slidingBox, slidingVolume } from "../src/library/designs/boxes3";
import { clockContours, clockLayout, TEALIGHT_ROOM, winderShape } from "../src/library/designs/laserHome3";
import { ornamentPolygon, ornamentShape } from "../src/library/designs/ornament";
import { allEdges, makePuzzle } from "../src/library/puzzle";
import { puzzleSpec } from "../src/library/designs/jigsaw";
import { ENGRAVE_DEPTH } from "../src/library/designs/engraved";
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
const ID: [number, number, number, number] = [0, 0, 0, 1];
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...extra });

function insert(id: string, values: DesignValues = {}): JuraCADDocument {
  const d = findDesign(id)!;
  return insertDesign(emptyDocument(), d, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
}

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const vol = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  return { parts: r.parts, volumes: r.parts.map((p) => vol[p.id]), total: check.parts.reduce((n, p) => n + (p.exactVolume ?? 0), 0) };
}

const role = (parts: PartMesh[], end: string) => parts.find((p) => p.id.endsWith(`_${end}`))!;

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

/** The volume shared by any two parts (named by id in the clash report), or by `moved` shifted by `shift` and the others. */
function overlap(parts: PartMesh[], moved?: string, shift: [number, number, number] = [0, 0, 0]): number {
  const found = engine.clashes(
    parts.map((p) => ({ id: p.id, partId: p.id, name: p.id, position: p.id === moved ? shift : [0, 0, 0], rotation: ID })),
    0.001,
    false,
  );
  return found.filter((c) => !moved || c.a === moved || c.b === moved).reduce((n, c) => n + (c.volume ?? 0), 0);
}

const okOf = (o: LaserOutline) => {
  if (!o.ok) throw new Error(o.error);
  return o;
};
const polygonOf = (p: LaserPath): P2[] => p.segments.flatMap((s, i) => segmentPoints(s, 0.01).slice(i ? 1 : 0));
const area = (poly: P2[]) => Math.abs(poly.reduce((a, [x1, y1], i) => a + x1 * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * y1, 0)) / 2;
const layers = (paths: LaserPath[]) => paths.reduce<Record<string, number>>((n, p) => ({ ...n, [p.layer + (p.closed ? "" : " lines")]: (n[p.layer + (p.closed ? "" : " lines")] ?? 0) + 1 }), {});

/** A design's own sketch as the laser panel exports it (with the design's settings). */
function sketchExport(doc: JuraCADDocument, name: string) {
  const f = doc.features.find((x) => x.name === name)!;
  return sketchPiece(f.name, f.sketch!.data, laserDefaultsFor(doc, f.id) ?? {});
}

describe("sliding-lid box", () => {
  const v = valuesOf("sliding-lid-box");
  const doc = () => insert("sliding-lid-box");

  it("8 panels that don't overlap and add up exactly to the box, its rails and lid", () => {
    const r = build(doc());
    expect(r.parts).toHaveLength(8);
    const want = slidingVolume(v);
    expect(r.total).toBeCloseTo(want.box + want.rails + want.lid, 1);
    expect(r.volumes[r.parts.indexOf(role(r.parts, "lid"))]).toBeCloseTo(want.lid, 1);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    const all = box(r.parts);
    expect(all.max[0] - all.min[0]).toBeCloseTo(160, 3);
    expect(all.max[1] - all.min[1]).toBeCloseTo(100, 3);
    expect(all.max[2] - all.min[2]).toBeCloseTo(60, 3);
    for (const p of r.parts) {
      const b = box([p]);
      expect(Math.min(...[0, 1, 2].map((k) => b.max[k] - b.min[k]))).toBeCloseTo(3, 3);
    }
  });

  it("the lid slides along its grooves and out of the low end, with clearance all round, and is held every other way", () => {
    const r = build(doc());
    const lid = role(r.parts, "lid").id;
    const c = slidingBox(v).c.v;
    const free = c * 0.9;
    const hit = c + 0.4;
    const at = (shift: [number, number, number]) => overlap(r.parts, lid, shift);
    // Slides: half way out, nearly out, right out.
    for (const x of [20, 75, 150, 170]) expect(at([x, 0, 0])).toBeLessThan(0.01);
    // Room above, below and either side, and at the closed end.
    for (const s of [[0, 0, free], [0, 0, -free], [0, free, 0], [0, -free, 0], [-free, 0, 0], [60, 0, free], [60, free, -free]] as [number, number, number][]) expect(at(s)).toBeLessThan(0.01);
    // But no further: the rails above and below, the walls either side, the end of the slots.
    for (const s of [[0, 0, hit], [0, 0, -hit], [0, hit, 0], [0, -hit, 0], [-hit, 0, 0], [60, 0, hit], [60, 0, 3]] as [number, number, number][]) expect(at(s)).toBeGreaterThan(1);
    // Held from above all the way along the grooves, so it can't be lifted out.
    expect(at([140, 0, 3])).toBeGreaterThan(1);
  });

  it("follows its variables (taller)", () => {
    let d = doc();
    d = applyVariables(d, d.variables!.map((x) => (x.name === "slidebox_height" ? { ...x, value: "80" } : x)));
    const r = build(d);
    const want = slidingVolume({ ...v, height: 80 });
    expect(r.total).toBeCloseTo(want.box + want.rails + want.lid, 1);
    expect(overlap(r.parts)).toBeLessThan(0.01);
  });

  it("with a kerf allowance the pieces are drawn bigger, so the joints grip (and overlap a little in 3D)", () => {
    const r = build(insert("sliding-lid-box", { kerf: 0.15 }));
    expect(r.parts).toHaveLength(8);
    expect(overlap(r.parts)).toBeGreaterThan(1);
  });

  it("Export for laser: each panel has a red outline; the lid its blue finger hole", () => {
    const r = build(doc());
    for (const p of r.parts) {
      const piece = outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: p.id }])[0]));
      expect(piece.paths.filter((x) => x.layer === "outer")).toHaveLength(1);
      expect(piece.paths.filter((x) => x.layer === "inner")).toHaveLength(p.id.endsWith("_lid") ? 1 : 0);
    }
    // The rail's flat face is the C, with its slot open at one end (so it's one red outline, no blue).
    const rail = outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: role(r.parts, "rail").id }])[0]));
    const b = pathsBox(rail.paths)!;
    expect(b[2] - b[0]).toBeCloseTo(154, 3);
    expect(b[3] - b[1]).toBeCloseTo(57, 3);
    expect(area(polygonOf(rail.paths[0]))).toBeCloseTo(154 * 57 - 148 * 3.4, 1);
  });
});

describe("tray with dividers", () => {
  it("the tray and its dividers don't overlap, and add up exactly", () => {
    for (const extra of [{}, { rows: 3, columns: 4 }, { rows: 1, columns: 2 }] as DesignValues[]) {
      const v = valuesOf("divider-tray", extra);
      const r = build(insert("divider-tray", extra));
      const d = dividerTray(v);
      expect(r.parts).toHaveLength(5 + d.rowAt.length + d.columnAt.length);
      expect(r.total).toBeCloseTo(shellVolume({ ...d.b, lid: false }) + dividerVolume(v), 1);
      expect(overlap(r.parts)).toBeLessThan(0.01);
      // The dividers come up level with the walls' top.
      expect(box(r.parts).max[2]).toBeCloseTo(50, 4);
    }
  });

  it("the dividers' slots lock them: slid either way a divider hits the ones it crosses", () => {
    const r = build(insert("divider-tray"));
    const across = role(r.parts, "divider-x").id;
    expect(overlap(r.parts, across, [1, 0, 0])).toBeGreaterThan(1);
    expect(overlap(r.parts, across, [0, 0.5, 0])).toBeGreaterThan(1);
    expect(overlap(r.parts, role(r.parts, "divider-y").id, [0.5, 0, 0])).toBeGreaterThan(1);
    // …and can be lifted straight out.
    expect(overlap(r.parts, across, [0, 0, 60])).toBeLessThan(0.01);
  });
});

describe("bookend", () => {
  it("three pieces whose tabs fill their slots exactly: no overlap, the right volumes", () => {
    const r = build(insert("bookend"));
    expect(r.parts).toHaveLength(3);
    const want = bookendVolume(valuesOf("bookend"));
    for (const k of ["base", "upright", "brace"] as const) expect(r.volumes[r.parts.indexOf(role(r.parts, k))]).toBeCloseTo(want[k], 1);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    // The upright can only come out upwards: slid sideways it hits the base's slots, and the brace holds it from behind.
    const up = role(r.parts, "upright").id;
    expect(overlap(r.parts, up, [0, 1, 0])).toBeGreaterThan(0.1);
    expect(overlap(r.parts, up, [-1, 0, 0])).toBeGreaterThan(0.1);
    const piece = outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: role(r.parts, "base").id }])[0]));
    expect(layers(piece.paths)).toEqual({ outer: 1, inner: 3 });
  });
});

describe("home designs", () => {
  it("clock face: a plate with its hole, the numbers and marks engraved; Export for laser cuts, engraves (and scores)", () => {
    const doc = insert("clock-face");
    const r = build(doc);
    expect(r.parts).toHaveLength(1);
    const v = valuesOf("clock-face");
    const L = clockLayout(v);
    const ink = inkArea(clockContours(v));
    expect(r.total).toBeCloseTo((Math.PI * (L.R ** 2 - (L.hole / 2) ** 2)) * 3 - ink * ENGRAVE_DEPTH, 0);
    const piece = sketchExport(doc, "Clock sketch");
    const counts = layers(piece.paths);
    expect(counts.outer).toBe(1);
    expect(counts.inner).toBe(1);
    expect(counts.engrave).toBeGreaterThanOrEqual(12 + 15);
    const hole = piece.paths.find((p) => p.layer === "inner")!;
    const hb = pathsBox([hole])!;
    expect(hb[2] - hb[0]).toBeCloseTo(8, 4);
    const scored = sketchExport(insert("clock-face", { marks: "score" }), "Clock sketch");
    expect(layers(scored.paths)["score lines"]).toBe(12);
  });

  it("cord winders: separate H-shaped plates", () => {
    const r = build(insert("cord-winder"));
    expect(r.parts).toHaveLength(4);
    const a = winderShape(valuesOf("cord-winder")).outline;
    const want = Math.abs(a.reduce((n, [x1, y1], i) => n + x1 * a[(i + 1) % a.length][1] - a[(i + 1) % a.length][0] * y1, 0)) / 2;
    for (const vol of r.volumes) expect(vol).toBeCloseTo(want * 3, 2);
    expect(overlap(r.parts)).toBeLessThan(0.01);
  });

  it("tealight holder: a base and rings stacked, the hole for the candle with room round it", () => {
    const r = build(insert("tealight", { shape: "round", size: 70, rings: 4 }));
    expect(r.parts).toHaveLength(5);
    const hole = 38.5 + 2 * TEALIGHT_ROOM;
    expect(r.total).toBeCloseTo(Math.PI * 35 * 35 * 15 - Math.PI * (hole / 2) ** 2 * 12, 0);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    expect(box(r.parts).max[2]).toBeCloseTo(15, 4);
    const ring = outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: role(r.parts, "ring").id }])[0]));
    expect(layers(ring.paths)).toEqual({ outer: 1, inner: 1 });
  });
});

describe("jigsaw puzzle", () => {
  it("a board the puzzle's size; Export for laser: the border red, every cut between pieces blue", () => {
    const doc = insert("jigsaw");
    const r = build(doc);
    expect(r.parts).toHaveLength(1);
    expect(r.total).toBeCloseTo(200 * 150 * 3, 2);
    const piece = sketchExport(doc, "Puzzle sketch");
    const outer = piece.paths.filter((p) => p.layer === "outer");
    expect(outer).toHaveLength(1);
    const b = pathsBox(outer)!;
    expect([b[2] - b[0], b[3] - b[1]]).toEqual([200, 150]);
    const cuts = piece.paths.filter((p) => p.layer === "inner");
    expect(cuts.every((p) => !p.closed)).toBe(true);
    const edges = allEdges(makePuzzle(puzzleSpec(valuesOf("jigsaw"))));
    expect(cuts).toHaveLength(edges.length * 5);
    // Cut first (inner), then the border, and nothing engraved; the board's own face is just the rectangle.
    expect(piece.paths.some((p) => p.layer === "engrave")).toBe(false);
    const sheet = layoutPieces([piece]);
    const svg = laserSvg(sheet);
    expect(svg).toContain('width="200mm" height="150mm"');
    expect(svg).toContain("#0000FF");
    expect(svg).toContain("#FF0000");
    expect(laserDxf(sheet)).toContain("POLYLINE");
    const face = outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: r.parts[0].id }])[0]));
    expect(layers(face.paths)).toEqual({ outer: 1 });
  });

  it("follows its thickness, and another pattern number makes other cuts", () => {
    let doc = insert("jigsaw", { seed: 7 });
    doc = applyVariables(doc, doc.variables!.map((x) => (x.name === "puzzle_thickness" ? { ...x, value: "6" } : x)));
    expect(build(doc).total).toBeCloseTo(200 * 150 * 6, 2);
    const a = sketchExport(insert("jigsaw", { seed: 1 }), "Puzzle sketch");
    const b = sketchExport(doc, "Puzzle sketch");
    expect(JSON.stringify(a.paths)).not.toBe(JSON.stringify(b.paths));
  });
});

describe("ornaments", () => {
  for (const shape of ["star", "heart", "circle", "snowflake"])
    it(`${shape}: one plate, hole cut through, words engraved`, () => {
      const doc = insert("ornament", { shape });
      const r = build(doc);
      expect(r.parts).toHaveLength(1);
      const v = valuesOf("ornament", { shape });
      const s = ornamentShape(v);
      const ink = inkArea(blockContours({ font: fontOf(v), capHeight: 7, lines: linesOf(v.words), centre: s.centre }));
      const plate = area(ornamentPolygon(s)) - Math.PI * 4;
      // The polygon's arcs are short straight pieces here: a little less than the true area.
      expect(r.total / 3).toBeGreaterThan(plate - ink * (ENGRAVE_DEPTH / 3) - 1);
      expect(r.total / 3).toBeLessThan(plate * 1.01);
      const piece = sketchExport(doc, "Ornament sketch");
      const counts = layers(piece.paths);
      expect(counts.outer).toBe(1);
      expect(counts.inner).toBe(1);
      expect(counts.engrave).toBe(5);
      expect(evenOdd(piece.paths.filter((p) => p.layer === "engrave").map(polygonOf))).toBeCloseTo(ink, 0);
    });
});

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const evenOdd = (loops: P2[][]) => loops.reduce((n, l, i) => n + (loops.filter((m, j) => j !== i && inside(l[0], m)).length % 2 ? -1 : 1) * area(l), 0);

describe("a user's part is never touched", () => {
  for (const id of ["clock-face", "ornament", "cord-winder", "sliding-lid-box", "divider-tray", "bookend", "tealight", "jigsaw"])
    it(`${id}: a user's block right through it is left alone`, () => {
      const alone = build(insert(id));
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "300", depth: "300", height: "100", x: "-150", y: "-150", z: "-10" } }] };
      const d = findDesign(id)!;
      doc = insertDesign(doc, d, defaultValues(d), { into: MAIN_STUDIO }).doc;
      const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
      expect(r.featureErrors).toEqual({});
      const check = engine.check("normal");
      expect(check.parts.find((p) => p.partId === "mine")!.exactVolume!).toBeCloseTo(300 * 300 * 100, 2);
      expect(check.parts).toHaveLength(alone.parts.length + 1);
    });
});
