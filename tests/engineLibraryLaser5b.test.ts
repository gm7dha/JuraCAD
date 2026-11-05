/**
 * The fifth batch of laser designs with the real geometry engine, part 2 (its own file so OpenCascade's memory stays
 * small): drawers that slide out with clearance and are held every other way; the coasters, mirror and tissue box
 * fitting their holders; tabs and slots that hold; Export for laser's layers.
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
import { sideSlots as tabSlots } from "../src/library/sidePanels";
import { drawerBox } from "../src/library/designs/drawerBox";
import { penHoles } from "../src/library/designs/penHolder";
import { earringStand } from "../src/library/designs/earringStand";
import { sunburst } from "../src/library/designs/sunburstMirror";
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
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...extra });

/** A test body (a user's part): a box from its corner, or an upright cylinder from its base centre. */
const box = (id: string, [x, y, z]: number[], [w, d, h]: number[]): Feature => ({ ...createFeature(emptyDocument(), "box"), id, params: { width: `${w}`, depth: `${d}`, height: `${h}`, x: `${x}`, y: `${y}`, z: `${z}` } });
const cylinder = (id: string, [x, y, z]: number[], d: number, h: number): Feature => ({ ...createFeature(emptyDocument(), "cylinder"), id, params: { diameter: `${d}`, height: `${h}`, x: `${x}`, y: `${y}`, z: `${z}` } });

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

describe("box with drawers", () => {
  it("each drawer slides out of the front with clearance, and is held every other way", () => {
    const v = valuesOf("drawer-box");
    const d = drawerBox(v);
    const r = build(insert("drawer-box"));
    for (let n = 1; n <= d.n; n++) {
      const drawer = r.parts.filter((p) => p.id.includes(`_drawer-${n}-`)).map((p) => p.id);
      expect(drawer).toHaveLength(5);
      const c = d.c;
      // Out of the front: free all the way.
      expect(overlap(r.parts, drawer, [0, -0.6 * d.drawer.D.v, 0])).toBeLessThan(0.001);
      // Within the clearance it moves freely; past it, it hits the sides, the shelf or top above, the floor or shelf below, the back.
      for (const s of [[0.9 * c, 0, 0], [-0.9 * c, 0, 0], [0, 0, 0.9 * c], [0, 0.9 * c, 0]] as [number, number, number][]) expect(overlap(r.parts, drawer, s), `drawer ${n} by ${s}`).toBeLessThan(0.001);
      for (const s of [[c + 0.3, 0, 0], [-c - 0.3, 0, 0], [0, 0, c + 0.3], [0, 0, -0.3], [0, c + 0.3, 0]] as [number, number, number][]) expect(overlap(r.parts, drawer, s), `drawer ${n} by ${s}`).toBeGreaterThan(0.01);
    }
  });

  it("the shelves' tabs fill the sides' slots: pushed any way a shelf hits the case", () => {
    const r = build(insert("drawer-box"));
    const shelf = [role(r.parts, "shelf-1").id];
    for (const s of [[0, 0.3, 0], [0, -0.3, 0], [0, 0, 0.3], [0, 0, -0.3], [0.3, 0, 0]] as [number, number, number][]) expect(overlap(r.parts, shelf, s)).toBeGreaterThan(0.01);
  });

  it("Export for laser: a side has a slot per shelf, a drawer front its pull slot", () => {
    const r = build(insert("drawer-box"));
    expect(layers(partPiece(role(r.parts, "left").id).paths)).toEqual({ outer: 1, inner: 2 });
    expect(layers(partPiece(role(r.parts, "drawer-2-front").id).paths)).toEqual({ outer: 1, inner: 1 });
    for (const k of ["bottom", "front", "back", "shelf-1", "drawer-1-bottom", "drawer-1-left"]) expect(layers(partPiece(role(r.parts, k).id).paths), k).toEqual({ outer: 1 });
  });

  it("a single drawer: no shelves, one drawer filling the case", () => {
    const r = build(insert("drawer-box", { drawers: 1, height: 80 }));
    expect(r.parts).toHaveLength(10);
    expect(overlap(r.parts)).toBeLessThan(0.01);
  });
});

describe("holders and frames", () => {
  it("pen pot: the walls' honeycomb holes are blue, the dividers cross inside the pot", () => {
    const v = valuesOf("pen-holder");
    const r = build(insert("pen-holder"));
    expect(layers(partPiece(role(r.parts, "front").id).paths)).toEqual({ outer: 1, inner: penHoles(v).length });
    // The dividers stand on the base, clear of the walls: a nudge within the room is free, more hits a wall.
    const div = [role(r.parts, "divider-x").id];
    expect(overlap(r.parts, div, [0.2, 0, 0], [role(r.parts, "left").id, role(r.parts, "right").id])).toBeLessThan(0.001);
    expect(overlap(r.parts, div, [0.5, 0, 0], [role(r.parts, "left").id, role(r.parts, "right").id])).toBeGreaterThan(0.01);
    expect(overlap(r.parts, div, [0, 0, -0.2])).toBeGreaterThan(0.01);
  });

  it("tissue box cover: drops over the tissue box with room all round; its top's slot is blue", () => {
    const v = valuesOf("tissue-box");
    const t = Number(v.thickness);
    const room = Number(v.room);
    const tissues = box("tissues", [t + room, t + room, 0], [Number(v.boxWidth), Number(v.boxDepth), Number(v.boxHeight)]);
    const r = build(insert("tissue-box", {}, [tissues]));
    expect(overlap(r.parts, [], [0, 0, 0], ["tissues"])).toBeLessThan(0.001);
    expect(overlap(r.parts, ["tissues"], [room + 0.3, 0, 0])).toBeGreaterThan(0.01);
    expect(overlap(r.parts, ["tissues"], [0, 0, room + 0.3])).toBeGreaterThan(0.01);
    const top = role(r.parts, "bottom");
    let lo = Infinity;
    for (let i = 2; i < top.vertices.length; i += 3) lo = Math.min(lo, top.vertices[i]);
    expect(lo).toBeCloseTo(Number(v.boxHeight) + room, 4);
    expect(layers(partPiece(top.id).paths)).toEqual({ outer: 1, inner: 1 });
  });

  it("sunburst mirror: the mirror drops into the rings with room, held in by the front; laser layers", () => {
    const v = valuesOf("sunburst-mirror");
    const s = sunburst(v);
    const mt = Number(v.mirrorThickness);
    const mirror = cylinder("mirror", [0, 0, s.t], s.mirror, mt);
    const r = build(insert("sunburst-mirror", {}, [mirror]));
    expect(overlap(r.parts, [], [0, 0, 0], ["mirror"])).toBeLessThan(0.001);
    expect(overlap(r.parts, ["mirror"], [0.4, 0, 0])).toBeLessThan(0.001);
    expect(overlap(r.parts, ["mirror"], [0.8, 0, 0])).toBeGreaterThan(0.01);
    expect(overlap(r.parts, ["mirror"], [0, 0, 0.3])).toBeGreaterThan(0.01);
    expect(layers(partPiece(role(r.parts, "front").id).paths)).toEqual({ outer: 1, inner: 1 });
    expect(layers(partPiece(role(r.parts, "ring").id).paths)).toEqual({ outer: 1, inner: 2 });
    expect(layers(partPiece(role(r.parts, "back").id).paths)).toEqual({ outer: 1, inner: 1 });
  });

  it("coaster holder: square coasters stand in it with room each side, held by the walls and ends", () => {
    const v = valuesOf("coaster-holder", { shape: "square" });
    const h = coasterHolder(v);
    const room = Number(v.room);
    const stack = box("coasters", [h.x0, -h.half, h.floor], [h.coaster.w, h.stack, h.coaster.h]);
    const r = build(insert("coaster-holder", { shape: "square" }, [stack]));
    expect(overlap(r.parts, [], [0, 0, 0], ["coasters"])).toBeLessThan(0.001);
    for (const s of [[0.9 * room, 0, 0], [-0.9 * room, 0, 0], [0, 0.9 * room, 0], [0, -0.9 * room, 0]] as [number, number, number][]) expect(overlap(r.parts, ["coasters"], s)).toBeLessThan(0.001);
    for (const s of [[room + 0.3, 0, 0], [0, room + 0.3, 0], [0, 0, -0.2]] as [number, number, number][]) expect(overlap(r.parts, ["coasters"], s)).toBeGreaterThan(0.01);
    expect(layers(partPiece(role(r.parts, "side-left").id).paths)).toEqual({ outer: 1, inner: tabSlots(h.a).length });
  });

  it("book stand and earring stand: tabs and slots hold — a piece pushed any way hits", () => {
    const r = build(insert("book-stand"));
    for (const k of ["back", "base", "lip"]) {
      const id = role(r.parts, k).id;
      for (const s of [[0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5], [0, 1, 0], [0, -1, 0]] as [number, number, number][]) expect(overlap(r.parts, [id], s), `${k} ${s}`).toBeGreaterThan(0.05);
    }
    const e = build(insert("earring-stand"));
    const side = [role(e.parts, "plate-side").id];
    for (const s of [[0.3, 0, 0], [-0.3, 0, 0], [0, 0, -0.3]] as [number, number, number][]) expect(overlap(e.parts, side, s)).toBeGreaterThan(0.01);
    const piece = partPiece(role(e.parts, "plate-front").id);
    expect(layers(piece.paths)).toEqual({ outer: 1, inner: earringStand(valuesOf("earring-stand")).holes.length });
  });
});

