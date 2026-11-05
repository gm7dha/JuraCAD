/**
 * The fifth batch of laser designs built with the real geometry engine: sound flat parts of exactly the right volume
 * whose joints tile (fingers fill their gaps, tabs their slots) with no overlaps at kerf 0; the bird box's entrance hole
 * at its stated size and height, its roof held on; Export for laser giving each piece one red outline and its holes in
 * blue; and a user's part never touched. Drawers, holders and frames: tests/engineLibraryLaser5b.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { LaserPath } from "../src/laser/laser";
import { outlinePiece, type LaserOutline } from "../src/laser/sources";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import { panelAreas, type BoxPanel, type PlateHole } from "../src/library/boxPanels";
import { assemblyAreas } from "../src/library/sidePanels";
import { signedArea, type P2 } from "../src/library/outlines";
import { birdBox, birdHoles } from "../src/library/designs/birdBox";
import { drawerBox, shelfOutline, sideSlots } from "../src/library/designs/drawerBox";
import { penBox, penDividers, penHoles } from "../src/library/designs/penHolder";
import { tissueCover, tissueSlot } from "../src/library/designs/tissueBox";
import { earringStand } from "../src/library/designs/earringStand";
import { HANG, sunburst } from "../src/library/designs/sunburstMirror";
import { bookStand } from "../src/library/designs/bookStand";
import { coasterHolder } from "../src/library/designs/coasterHolder";
import type { DesignValues } from "../src/library/types";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});
afterAll(() => engine?.dispose());

const ID: [number, number, number, number] = [0, 0, 0, 1];
const IDS = ["bird-box", "earring-stand", "drawer-box", "pen-holder", "sunburst-mirror", "book-stand", "coaster-holder", "tissue-box"];
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...extra });
const area = (p: P2[]) => Math.abs(signedArea(p));
const circle = (d: number) => (Math.PI * d * d) / 4;
const WALLS: BoxPanel[] = ["bottom", "front", "back", "left", "right"];

/** A test body (a user's part): a box from its corner, or an upright cylinder from its base centre. */
const box = (id: string, [x, y, z]: number[], [w, d, h]: number[]): Feature => ({ ...createFeature(emptyDocument(), "box"), id, params: { width: `${w}`, depth: `${d}`, height: `${h}`, x: `${x}`, y: `${y}`, z: `${z}` } });

function insert(id: string, values: DesignValues = {}, probes: Feature[] = []): JuraCADDocument {
  const doc = insertDesign(emptyDocument(), findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
  return { ...doc, features: [...doc.features, ...probes] };
}

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid, p.partId).toBe(true);
  const vol = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  return { parts: r.parts, vol: (id: string) => vol[id] };
}

const role = (parts: PartMesh[], end: string) => {
  const p = parts.find((x) => x.id.endsWith(`_${end}`));
  if (!p) throw new Error(`no part ${end} in ${parts.map((x) => x.id).join(", ")}`);
  return p;
};

/** The volume shared by the parts (or by those of `moved`, shifted by `shift`, and the rest); `only` = just the pairs with these. */
function overlap(parts: PartMesh[], moved: string[] = [], shift: [number, number, number] = [0, 0, 0], only?: string[]): number {
  const found = engine.clashes(
    parts.map((p) => ({ id: p.id, partId: p.id, name: p.id, position: moved.includes(p.id) ? shift : [0, 0, 0], rotation: ID })),
    0.001,
    false,
  );
  const keep = (c: { a: string; b: string }) => {
    if (only && moved.length) return (moved.includes(c.a) && only.includes(c.b)) || (moved.includes(c.b) && only.includes(c.a));
    if (only) return only.includes(c.a) !== only.includes(c.b);
    return !moved.length || moved.includes(c.a) !== moved.includes(c.b);
  };
  return found.filter(keep).reduce((n, c) => n + (c.volume ?? 0), 0);
}

const okOf = (o: LaserOutline) => {
  if (!o.ok) throw new Error(o.error);
  return o;
};
const partPiece = (id: string) => outlinePiece(okOf(engine.laserOutlines([{ kind: "part", partId: id }])[0]));
const layers = (paths: LaserPath[]) => paths.reduce<Record<string, number>>((n, p) => ({ ...n, [p.layer + (p.closed ? "" : " lines")]: (n[p.layer + (p.closed ? "" : " lines")] ?? 0) + 1 }), {});

/** Per part role, its area as cut (mm²): the expected volume is this × the thickness. */
function expectedAreas(id: string, v: DesignValues): Record<string, number> {
  const boxAreas = (a: Record<BoxPanel, number>, pre = "") => Object.fromEntries(WALLS.map((p) => [`${pre}${p}`, a[p]]));
  switch (id) {
    case "bird-box": {
      const bb = birdBox(v);
      const rectArea = (r: number[]) => (r[2] - r[0]) * (r[3] - r[1]);
      return { ...boxAreas(panelAreas(bb.b, birdHoles(bb))), roof: rectArea(bb.roof), "roof-under": rectArea(bb.under) };
    }
    case "drawer-box": {
      const d = drawerBox(v);
      const slots = sideSlots(d);
      const out: Record<string, number> = boxAreas(panelAreas(d.caseBox, { left: slots, right: slots }));
      d.shelves.forEach((_, i) => (out[`shelf-${i + 1}`] = area(shelfOutline(d))));
      const pull: PlateHole = { kind: "slot", ...d.pull };
      for (let i = 1; i <= d.n; i++) Object.assign(out, boxAreas(panelAreas(d.drawer, { front: [pull] }), `drawer-${i}-`));
      return out;
    }
    case "pen-holder": {
      const holes = penHoles(v) as PlateHole[];
      const dv = penDividers(v);
      return { ...boxAreas(panelAreas(penBox(v), { front: holes, back: holes, left: holes, right: holes })), "divider-x": area(dv.plates[0]), "divider-y": area(dv.plates[1]) };
    }
    case "tissue-box": {
      const c = tissueCover(v);
      return boxAreas(panelAreas(c.b, { bottom: [tissueSlot(c)] }));
    }
    case "earring-stand": {
      const e = earringStand(v);
      const holes = e.holes.length * circle(e.hole);
      return { "plate-front": area(e.plates[0]) - holes, "plate-side": area(e.plates[1]) - holes };
    }
    case "sunburst-mirror": {
      const s = sunburst(v);
      return { back: circle(s.disc) - circle(HANG.d), ring: circle(s.disc) - circle(s.ringHole) - circle(HANG.d), front: area(s.sun) - circle(s.window) };
    }
    default: {
      const a = id === "book-stand" ? bookStand(v).a : coasterHolder(v).a;
      const w = assemblyAreas(a);
      return { "side-right": w.side, "side-left": w.side, ...w.pieces };
    }
  }
}

describe("every design of the fifth batch", () => {
  for (const id of IDS)
    it(`${id}: sound pieces of the right size that don't overlap — the joints tile`, () => {
      const v = valuesOf(id);
      const r = build(insert(id));
      const want = expectedAreas(id, v);
      const t = Number(v.thickness);
      expect(r.parts).toHaveLength(Object.keys(want).length);
      for (const [k, a] of Object.entries(want)) expect(r.vol(role(r.parts, k).id), `${id} ${k}`).toBeCloseTo(a * t, 0);
      expect(overlap(r.parts)).toBeLessThan(0.01);
    });

  it("with a kerf allowance the pieces are drawn bigger, so the joints grip", () => {
    for (const id of ["bird-box", "earring-stand", "book-stand"]) {
      const r = build(insert(id, { kerf: 0.15 }));
      expect(overlap(r.parts), id).toBeGreaterThan(0.5);
    }
  });
});

describe("bird box", () => {
  for (const bird of ["blue-tit", "great-tit", "house-sparrow"])
    it(`${bird}: the entrance hole is its stated size, its bottom the stated height above the floor`, () => {
      const v = valuesOf("bird-box", { bird });
      const bb = birdBox(v);
      const t = bb.b.t.v;
      const [cx, cz] = bb.holeAt;
      const r = bb.hole / 2;
      const floorTop = t;
      expect(cz - r - floorTop).toBeCloseTo(bb.holeHeight, 9);
      expect(bb.holeHeight).toBeGreaterThanOrEqual(125);
      // Probes through the front wall (y = 0…t): a strip just inside the hole's height and width passes; a little more hits.
      const probes = [
        box("tall-in", [cx - 0.5, -1, cz - r + 0.05], [1, t + 2, 2 * r - 0.1]),
        box("tall-out", [cx - 0.5, -1, cz - r - 0.2], [1, t + 2, 2 * r + 0.4]),
        box("wide-in", [cx - r + 0.05, -1, cz - 0.5], [2 * r - 0.1, t + 2, 1]),
        box("wide-out", [cx - r - 0.2, -1, cz - 0.5], [2 * r + 0.4, t + 2, 1]),
      ];
      const b = build(insert("bird-box", { bird }, probes));
      const front = role(b.parts, "front").id;
      const parts = b.parts.filter((p) => p.id === front || probes.some((q) => q.id === p.id));
      const hit = (probe: string) => overlap(parts.filter((p) => p.id === front || p.id === probe), [], [0, 0, 0], [probe]);
      expect(hit("tall-in")).toBeLessThan(0.001);
      expect(hit("wide-in")).toBeLessThan(0.001);
      expect(hit("tall-out")).toBeGreaterThan(0.01);
      expect(hit("wide-out")).toBeGreaterThan(0.01);
    });

  it("Export for laser: the front's hole, the back's screw holes and the floor's drainage holes are blue", () => {
    const r = build(insert("bird-box"));
    expect(layers(partPiece(role(r.parts, "front").id).paths)).toEqual({ outer: 1, inner: 1 });
    expect(layers(partPiece(role(r.parts, "back").id).paths)).toEqual({ outer: 1, inner: 2 });
    expect(layers(partPiece(role(r.parts, "bottom").id).paths)).toEqual({ outer: 1, inner: 4 });
    for (const k of ["left", "right", "roof", "roof-under"]) expect(layers(partPiece(role(r.parts, k).id).paths), k).toEqual({ outer: 1 });
    // The entrance hole comes out its true size on the sheet.
    const hole = partPiece(role(r.parts, "front").id).paths.find((p) => p.layer === "inner")!;
    const seg = hole.segments[0];
    expect(seg.kind).toBe("circle");
    if (seg.kind === "circle") expect(seg.radius * 2).toBeCloseTo(25, 6);
  });

  it("the roof sits on the walls with its under-plate just inside them; lifted it comes off, slid it's held", () => {
    const r = build(insert("bird-box"));
    const roof = [role(r.parts, "roof").id, role(r.parts, "roof-under").id];
    expect(overlap(r.parts, roof, [0, 0, 0.3])).toBeLessThan(0.001);
    expect(overlap(r.parts, roof, [0.2, 0, 0])).toBeLessThan(0.001);
    expect(overlap(r.parts, roof, [0.5, 0, 0])).toBeGreaterThan(0.01);
    expect(overlap(r.parts, roof, [0, -0.5, 0])).toBeGreaterThan(0.01);
    expect(overlap(r.parts, roof, [0, 0, -0.2])).toBeGreaterThan(0.01);
  });
});

describe("a user's part is never touched", () => {
  for (const id of IDS)
    it(`${id}: a user's block right through it is left alone`, () => {
      const pieces = Object.keys(expectedAreas(id, valuesOf(id))).length;
      const mine = box("mine", [-150, -150, -10], [300, 300, 100]);
      let doc: JuraCADDocument = { ...emptyDocument(), features: [mine] };
      const d = findDesign(id)!;
      doc = insertDesign(doc, d, defaultValues(d), { into: MAIN_STUDIO }).doc;
      const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
      expect(r.featureErrors).toEqual({});
      const check = engine.check("normal");
      expect(check.parts.find((p) => p.partId === "mine")!.exactVolume!).toBeCloseTo(300 * 300 * 100, 2);
      expect(check.parts).toHaveLength(pieces + 1);
    });
});
