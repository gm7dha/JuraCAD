/**
 * The fourth batch of laser designs built with the real geometry engine: sound flat parts of the right volume; pieces
 * that don't overlap when put together at kerf 0 and whose joints tile (tabs fill their slots, fingers their gaps);
 * the living-hinge strip staggered and still one piece; lantern walls with no loose islands (checked on what Export for
 * laser makes of them); every name-puzzle letter fitting its hole; and a user's part never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { segmentPoints, type LaserPath } from "../src/laser/laser";
import { outlinePiece, sketchPiece, type LaserOutline } from "../src/laser/sources";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign, laserDefaultsFor } from "../src/library/insert";
import { depths } from "../src/library/bridges";
import { assemblyAreas, sideSlots } from "../src/library/sidePanels";
import { diceTower } from "../src/library/designs/diceTower";
import { spiceRack } from "../src/library/designs/spiceRack";
import { cardStand } from "../src/library/designs/cardStand";
import { deckVolume } from "../src/library/designs/deckBox";
import { hingeBox, hingeBoxVolumes, hingeColumns, stripOutline } from "../src/library/designs/hingeBox";
import { lanternHoles } from "../src/library/designs/lantern";
import { holesOf, namePuzzle } from "../src/library/designs/namePuzzle";
import { HOOK, keyRack } from "../src/library/designs/keyRack";
import { ENGRAVE_DEPTH } from "../src/library/designs/engraved";
import { addLines } from "../src/library/laserKit";
import { lit } from "../src/library/ex";
import { extrudeFeature, outlineSketch, sketchFeature } from "../src/library/sketchKit";
import { signedArea, type P2 } from "../src/library/outlines";
import type { DesignValues } from "../src/library/types";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});
afterAll(() => engine?.dispose());

const ID: [number, number, number, number] = [0, 0, 0, 1];
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...extra });

function insert(id: string, values: DesignValues = {}): JuraCADDocument {
  return insertDesign(emptyDocument(), findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
}

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const vol = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  const pieces = Object.fromEntries(check.parts.map((p) => [p.partId, p.mesh.pieces]));
  return { parts: r.parts, vol: (id: string) => vol[id], pieces, total: check.parts.reduce((n, p) => n + (p.exactVolume ?? 0), 0) };
}

const role = (parts: PartMesh[], end: string) => {
  const p = parts.find((x) => x.id.endsWith(`_${end}`));
  if (!p) throw new Error(`no part ${end} in ${parts.map((x) => x.id).join(", ")}`);
  return p;
};

/** The volume shared by any two parts, or by `moved` shifted by `shift` and the others. */
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
const partPiece = (id: string) => outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: id }])[0]));
const layers = (paths: LaserPath[]) => paths.reduce<Record<string, number>>((n, p) => ({ ...n, [p.layer + (p.closed ? "" : " lines")]: (n[p.layer + (p.closed ? "" : " lines")] ?? 0) + 1 }), {});
const polygonOf = (p: LaserPath): P2[] => p.segments.flatMap((s, i) => segmentPoints(s, 0.01).slice(i ? 1 : 0));
const area = (poly: P2[]) => Math.abs(signedArea(poly));
function sketchExport(doc: JuraCADDocument, name: string) {
  const f = doc.features.find((x) => x.name === name)!;
  return sketchPiece(f.name, f.sketch!.data, laserDefaultsFor(doc, f.id) ?? {});
}

describe("tabbed pieces between two sides", () => {
  const cases: [string, () => { side: number; pieces: Record<string, number>; t: number; slots: number }][] = [
    ["dice-tower", () => ({ ...assemblyAreas(diceTower(valuesOf("dice-tower")).a), t: 3, slots: sideSlots(diceTower(valuesOf("dice-tower")).a).length })],
    ["spice-rack", () => ({ ...assemblyAreas(spiceRack(valuesOf("spice-rack")).a), t: 3, slots: sideSlots(spiceRack(valuesOf("spice-rack")).a).length })],
    ["card-stand", () => ({ ...assemblyAreas(cardStand(valuesOf("card-stand")).a), t: 3, slots: sideSlots(cardStand(valuesOf("card-stand")).a).length })],
  ];
  for (const [id, want] of cases)
    it(`${id}: the pieces don't overlap and their tabs fill the sides' slots exactly; each lays flat for the laser`, () => {
      const r = build(insert(id));
      const w = want();
      expect(r.parts).toHaveLength(Object.keys(w.pieces).length + 2);
      // Every slot filled: the parts add up to the sides (less their slots) and the pieces (tabs and all).
      expect(r.vol(role(r.parts, "side-right").id)).toBeCloseTo(w.side * w.t, 1);
      for (const [k, a] of Object.entries(w.pieces)) expect(r.vol(role(r.parts, k).id)).toBeCloseTo(a * w.t, 1);
      expect(overlap(r.parts)).toBeLessThan(0.01);
      // Export for laser: a side is one red outline with a blue hole per slot; each piece one red outline.
      expect(layers(partPiece(role(r.parts, "side-left").id).paths)).toEqual({ outer: 1, inner: w.slots });
      for (const k of Object.keys(w.pieces)) expect(layers(partPiece(role(r.parts, k).id).paths)).toEqual({ outer: 1 });
    });

  it("dice tower: the tabs hold — a baffle or the ramp pushed any way hits the sides", () => {
    const r = build(insert("dice-tower"));
    for (const k of ["baffle-1", "baffle-2", "ramp", "back", "front"]) {
      const id = role(r.parts, k).id;
      for (const s of [[0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5], [0, 1, 0], [0, -1, 0]] as [number, number, number][]) expect(overlap(r.parts, id, s)).toBeGreaterThan(0.05);
    }
  });

  it("dice tower: with a kerf allowance the pieces are drawn bigger and the slots smaller, so the tabs grip", () => {
    const r = build(insert("dice-tower", { kerf: 0.15 }));
    expect(overlap(r.parts)).toBeGreaterThan(1);
  });

  it("dice tower: it stands on the floor, the ramp reaching the front, the baffles inside", () => {
    const r = build(insert("dice-tower"));
    const d = diceTower(valuesOf("dice-tower"));
    const b = bounds(r.parts);
    expect(b.min[2]).toBeCloseTo(0, 4);
    expect(b.max[2]).toBeCloseTo(200, 4);
    expect(b.max[0] - b.min[0]).toBeCloseTo(90, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(70 + 6, 4);
    const ramp = bounds([role(r.parts, "ramp")]);
    expect(ramp.min[2]).toBeCloseTo(0, 3);
    expect(ramp.min[0]).toBeCloseTo(d.xa, 3);
  });
});

function bounds(parts: PartMesh[]) {
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

describe("living-hinge box", () => {
  const v = valuesOf("hinge-box");

  it("the bottom's fingers fill the wall's foot exactly: no overlap, and together they're the whole outline", () => {
    const r = build(insert("hinge-box"));
    expect(r.parts).toHaveLength(4);
    const want = hingeBoxVolumes(v);
    expect(r.vol(role(r.parts, "bottom").id) + r.vol(role(r.parts, "wall").id)).toBeCloseTo(want.bottomAndWall, 0);
    expect(r.vol(role(r.parts, "lid").id) + r.vol(role(r.parts, "lid-under").id)).toBeCloseTo(want.lid, 0);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    const b = bounds(r.parts);
    expect([b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((x) => Math.round(x * 1000) / 1000)).toEqual([120, 80, 60]);
    // The lid's under-plate is clear of the wall all round, and held by it either way.
    const under = role(r.parts, "lid-under").id;
    for (const s of [[0.2, 0, 0], [0, -0.2, 0]] as [number, number, number][]) expect(overlap(r.parts, under, s)).toBeLessThan(0.01);
    for (const s of [[0.6, 0, 0], [0, -0.6, 0]] as [number, number, number][]) expect(overlap(r.parts, under, s)).toBeGreaterThan(0.05);
    // The bottom lays flat: one red outline, round corners and all.
    expect(layers(partPiece(role(r.parts, "bottom").id).paths)).toEqual({ outer: 1 });
  });

  it("Export for laser of the wall strip: its outline red, every hinge cut blue", () => {
    const doc = insert("hinge-box");
    const piece = sketchExport(doc, "Wall strip");
    const b = hingeBox(v);
    const cuts = hingeColumns(b, v);
    expect(layers(piece.paths)).toEqual({ outer: 1, "inner lines": cuts.length });
    const outer = piece.paths.find((p) => p.layer === "outer")!;
    expect(area(polygonOf(outer))).toBeCloseTo(area(stripOutline(b).outline), 3);
  });

  it("the hinge's cuts (made as thin slots) leave the strip in one piece", () => {
    const b = hingeBox(v);
    const strip = stripOutline(b);
    const cuts = hingeColumns(b, v);
    const w = 0.2;
    const slots = cuts.map(([p, q]) => ({ points: [[p[0] - w / 2, p[1]], [p[0] + w / 2, p[1]], [q[0] + w / 2, q[1]], [q[0] - w / 2, q[1]]] as P2[], closed: true }));
    const TOP = { kind: "default", name: "Top" } as const;
    const features: Feature[] = [
      sketchFeature("strip-sketch", "Strip", TOP, outlineSketch(strip.outline.map(([x, y]) => [lit(x), lit(y)]), {})),
      extrudeFeature("strip", "Strip", "strip-sketch", { depth: lit(3), operation: "new" }),
      sketchFeature("cuts-sketch", "Cuts", TOP, addLines({ points: [], curves: [], constraints: [] }, slots)),
      extrudeFeature("cuts", "Cuts", "cuts-sketch", { depth: lit(3), operation: "remove" }),
    ];
    const r = engine.rebuild(features, {});
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal");
    expect(check.parts).toHaveLength(1);
    expect(check.parts[0].mesh.pieces).toBe(1);
    const cutArea = cuts.reduce((n, [p, q]) => n + w * (q[1] - p[1]), 0);
    expect(check.parts[0].exactVolume!).toBeCloseTo(3 * (area(strip.outline) - cutArea), 1);
  });
});

describe("card deck box", () => {
  it("finger-jointed walls and bottom that don't overlap and add up; the lid sits on with room round its under-plate", () => {
    const v = valuesOf("deck-box");
    const r = build(insert("deck-box"));
    expect(r.parts).toHaveLength(7);
    const want = deckVolume(v);
    const lidIds = [role(r.parts, "lid").id, role(r.parts, "lid-under").id];
    const boxTotal = r.parts.filter((p) => !lidIds.includes(p.id)).reduce((n, p) => n + r.vol(p.id), 0);
    expect(boxTotal).toBeCloseTo(want.box, 0);
    expect(r.vol(lidIds[0]) + r.vol(lidIds[1])).toBeCloseTo(want.lid, 1);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    // The front has its thumb notch: a red outline with a round bite out of its top.
    const front = partPiece(role(r.parts, "front").id);
    expect(layers(front.paths)).toEqual({ outer: 1 });
    expect(front.paths[0].segments.some((s) => s.kind === "arc")).toBe(true);
    // The cards fit: inside is the cards plus the room round them.
    const b = bounds(r.parts.filter((p) => !lidIds.includes(p.id)));
    expect(b.max[0] - b.min[0]).toBeCloseTo(63 + 2 + 6, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(18 + 2 + 6, 4);
  });

  it("follows its variables: a bigger deck", () => {
    let doc = insert("deck-box");
    doc = applyVariables(doc, doc.variables!.map((x) => (x.name === "deck_deck" ? { ...x, value: "30" } : x)));
    const r = build(doc);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    const b = bounds(r.parts);
    expect(b.max[1] - b.min[1]).toBeCloseTo(30 + 2 + 6, 4);
  });
});

describe("tealight lantern", () => {
  for (const pattern of ["circles", "diamonds", "hexagons", "stars"])
    it(`${pattern}: walls with every shape its own hole — no islands in what Export for laser makes, each wall one piece`, () => {
      const v = valuesOf("lantern", { pattern });
      const r = build(insert("lantern", { pattern }));
      expect(r.parts).toHaveLength(5);
      expect(overlap(r.parts)).toBeLessThan(0.01);
      const n = lanternHoles(v).length;
      expect(n).toBeGreaterThan(10);
      for (const k of ["front", "back", "left", "right"]) {
        const id = role(r.parts, k).id;
        expect(r.pieces[id]).toBe(1);
        const piece = partPiece(id);
        expect(layers(piece.paths)).toEqual({ outer: 1, inner: n });
        // The stencil's island check on the cut lines: every hole sits in the wall only, never inside another hole.
        const loops = piece.paths.map(polygonOf);
        const dep = depths(loops);
        const outer = piece.paths.findIndex((p) => p.layer === "outer");
        expect(dep[outer]).toBe(0);
        expect(dep.filter((d, i) => i !== outer && d !== 1)).toHaveLength(0);
      }
    });
});

describe("name puzzle", () => {
  for (const [words, extra] of [["ALEX", {}], ["BOB", { play: 0.5 }], ["Mia", { font: "regular", backing: false }]] as [string, DesignValues][])
    it(`${words}: every letter is its own piece, sitting in its hole with room all round`, () => {
      const v = valuesOf("name-puzzle", { words, ...extra });
      const p = namePuzzle(v);
      const r = build(insert("name-puzzle", { words, ...extra }));
      // One piece per letter outline (an i is two: its stem and its dot).
      const letters = r.parts.filter((x) => /_letter-\d+(~\d+)?$/.test(x.id));
      const outlines = p.letters.reduce((n, l) => n + l.outers.length, 0);
      expect(letters).toHaveLength(outlines);
      expect(r.parts).toHaveLength(outlines + (v.backing === false ? 1 : 2));
      expect(overlap(r.parts)).toBeLessThan(0.01);
      const play = Number(v.play);
      const board = role(r.parts, "board").id;
      // The board is the plate less every hole (the letters' outlines, `play` bigger all round).
      const holeArea = p.letters.flatMap((l) => holesOf(l, play)).reduce((n, h) => n + area(h), 0);
      expect(r.vol(board)).toBeCloseTo(3 * (p.w * p.h - (4 - Math.PI) * p.r * p.r - holeArea), 0);
      for (const l of letters) {
        // Nudged less than the play it's still free; further, it hits the board.
        const others = r.parts.filter((x) => x.id === board || x.id === l.id);
        for (const s of [[0.8 * play, 0, 0], [-0.8 * play, 0, 0], [0, 0.8 * play, 0], [0, -0.8 * play, 0]] as [number, number, number][]) expect(overlap(others, l.id, s)).toBeLessThan(0.01);
        for (const s of [[play + 0.4, 0, 0], [-play - 0.4, 0, 0], [0, play + 0.4, 0], [0, -play - 0.4, 0]] as [number, number, number][]) expect(overlap(others, l.id, s)).toBeGreaterThan(0.01);
      }
      // Each letter lays flat as its own piece: one red outline, its middles blue.
      const a = p.letters.findIndex((l) => l.ch === "A" || l.ch === "B");
      if (a >= 0) expect(layers(partPiece(role(r.parts, `letter-${a + 1}`).id).paths)).toEqual({ outer: 1, inner: p.letters[a].counters.length });
    });
});

describe("key rack", () => {
  it("hooks whose tabs fill their slots in the board; the words engraved; Export for laser of the board sketch", () => {
    const v = valuesOf("key-rack");
    const doc = insert("key-rack");
    const r = build(doc);
    expect(r.parts).toHaveLength(6);
    expect(overlap(r.parts)).toBeLessThan(0.01);
    const k = keyRack(v);
    const hook = role(r.parts, "hook").id;
    // A hook: the arm, the lip and the tab, 3 mm across.
    const hookArea = HOOK.arm * k.reach + HOOK.lip * HOOK.lipThick + (HOOK.arm - 2 * HOOK.tabRoom) * 3;
    expect(r.vol(hook)).toBeCloseTo(hookArea * 3, 2);
    const hb = bounds([role(r.parts, "hook-3")]);
    expect((hb.min[0] + hb.max[0]) / 2).toBeCloseTo(k.hooks[2], 4);
    expect(hb.min[2]).toBeCloseTo(-3, 4);
    expect(hb.max[2]).toBeCloseTo(k.reach, 4);
    // Pulled out of the board a little it's free; pushed sideways it hits the slot's side.
    expect(overlap(r.parts, hook, [0, 0, 0.2])).toBeLessThan(0.01);
    expect(overlap(r.parts, hook, [0.3, 0, 0])).toBeGreaterThan(0.05);
    expect(overlap(r.parts, hook, [0, 0.3, 0])).toBeGreaterThan(0.05);
    // The board: its slots and screw holes go right through, the words are cut a little way in.
    const board = role(r.parts, "board").id;
    const plate = 240 * 100 - (4 - Math.PI) * 64 - 5 * 3 * (HOOK.arm - 2 * HOOK.tabRoom) - 2 * Math.PI * 2.25 * 2.25;
    expect(r.vol(board)).toBeLessThan(plate * 3 - 1);
    expect(r.vol(board)).toBeGreaterThan(plate * 3 - 240 * 30 * ENGRAVE_DEPTH);
    const piece = sketchExport(doc, "Board sketch");
    const counts = layers(piece.paths);
    expect(counts.outer).toBe(1);
    expect(counts.inner).toBe(5 + 2);
    expect(counts.engrave).toBeGreaterThanOrEqual(4);
  });
});

describe("a user's part is never touched", () => {
  for (const id of ["hinge-box", "deck-box", "card-stand", "spice-rack", "lantern", "key-rack", "dice-tower", "name-puzzle"])
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
