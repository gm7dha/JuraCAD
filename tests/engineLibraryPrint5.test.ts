/**
 * The fifth batch of 3D-printing designs built with the real geometry engine: sound solids of the expected volume,
 * flat on the bed, and the things that must fit — Honeycomb wall inserts in a tile's hole (free with their clearance,
 * caught by their clips when pulled, stopped by their lip), the magnet baseplate's pockets where the standard puts
 * them and Gridfinity bins still sitting in it, the pipe clip round its pipe and holding it, the 608 bearing on its
 * pin and in its hub with the press fit's gap, the dividers slotting together — and a user's part left alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { lit } from "../src/library/ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../src/library/sketchKit";
import { levelPlane } from "../src/library/printKit";
import { hookVolume, hswBinVolume, PLUG_MID, tilePlan, tileVolume } from "../src/library/designs/honeycomb";
import { bitHolderVolume, FLOOR_TOP, liteBinVolume, magnetBaseplateVolume, magnetSpots } from "../src/library/designs/gridfinityMore";
import { CENTRED, MAGNET } from "../src/library/designs/gridfinity";
import { pipeClipPlan, pipeClipVolume } from "../src/library/designs/pipeClip";
import { chargingStandVolume } from "../src/library/designs/chargingStand";
import { BEARING, bearingSpoolVolumes, hubAt, SPOOL_BASE } from "../src/library/designs/bearingSpool";
import { funnelVolume } from "../src/library/designs/funnel";
import { tieAnchorVolume, wedgeVolume } from "../src/library/designs/doorWedge";
import { dividerPlan, dividerVolumes } from "../src/library/designs/dividerSet";
import { varsOf } from "../src/library/designs/common";
import { loadOpenCascade } from "./support/engineHelpers";

type Quat = [number, number, number, number];
type V3 = [number, number, number];
const ID: Quat = [0, 0, 0, 1];

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

const valuesOf = (id: string, values: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...values });
const insertInto = (doc: JuraCADDocument, id: string, values: DesignValues = {}) => insertDesign(doc, findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
const insert = (id: string, values: DesignValues = {}) => insertInto(emptyDocument(), id, values);
const setVar = (doc: JuraCADDocument, name: string, value: string) => applyVariables(doc, doc.variables!.map((v) => (v.name === name ? { ...v, value } : v)));
const withFeatures = (doc: JuraCADDocument, more: Feature[]): JuraCADDocument => ({ ...doc, features: [...doc.features, ...more] });

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const volumes = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  return { parts: r.parts, volumes, volume: Object.values(volumes).reduce((n, v) => n + v, 0) };
}

function box(p: PartMesh, q: Quat = ID): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.vertices.length; i += 3) {
    const v = turn(q, [p.vertices[i], p.vertices[i + 1], p.vertices[i + 2]]);
    for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], v[k])), (max[k] = Math.max(max[k], v[k]));
  }
  return { min, max };
}
const partEnding = (parts: PartMesh[], end: string) => parts.find((p) => p.id.endsWith(end))!;
const onTheBed = (parts: PartMesh[]) => parts.forEach((p) => expect(box(p).min[2]).toBeCloseTo(0, 4));

/** The volume shared by the parts, each turned (about the world origin) and then moved as given. */
function shared(...placed: { part: PartMesh; position?: V3; rotation?: Quat }[]): number {
  const found = engine.clashes(
    placed.map((p, i) => ({ id: `i${i}`, partId: p.part.id, name: p.part.name, position: p.position ?? [0, 0, 0], rotation: p.rotation ?? ID })),
    0.001,
    false,
  );
  return found.reduce((n, c) => n + (c.volume ?? 0), 0);
}

const about = (axis: 0 | 1 | 2, deg: number): Quat => {
  const a = (deg * Math.PI) / 360;
  const q: Quat = [0, 0, 0, Math.cos(a)];
  q[axis] = Math.sin(a);
  return q;
};
/** a then b: b × a. */
function then(a: Quat, b: Quat): Quat {
  const [x1, y1, z1, w1] = b;
  const [x2, y2, z2, w2] = a;
  return [w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2];
}
function turn(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** A plain round part (a stand-in: a pipe, a probe, a bearing), as a user would draw it. */
function roundPart(id: string, x: number, y: number, z: number, d: number, h: number, bore = 0): Feature[] {
  const shapes: unknown[] = [{ type: "circle", center: [String(x), String(y)], diameter: String(d) }];
  if (bore) shapes.push({ type: "circle", center: [String(x), String(y)], diameter: String(bore) });
  return [sketchFeature(`${id}-s`, `${id} sketch`, levelPlane(`${z} up`, z), shapesSketch(shapes, {})), extrudeFeature(id, id, `${id}-s`, { depth: lit(h), operation: "new" })];
}

describe("every design of the fifth batch", () => {
  const cases: [string, DesignValues, (v: DesignValues) => number | Record<string, number>][] = [
    ["hsw-tile", {}, tileVolume],
    ["hsw-tile", { across: 3, rows: 3, screws: "2" }, tileVolume],
    ["hsw-tile", { across: 2, rows: 4, screws: "0" }, tileVolume],
    ["hsw-hook", {}, hookVolume],
    ["hsw-hook", { reach: 60, tip: 20, width: 16, arm: 8 }, hookVolume],
    ["hsw-bin", {}, hswBinVolume],
    ["hsw-bin", { width: 60, depth: 20, height: 40 }, hswBinVolume],
    ["gridfinity-magnet-baseplate", {}, magnetBaseplateVolume],
    ["gridfinity-magnet-baseplate", { across: 1, along: 2 }, magnetBaseplateVolume],
    ["gridfinity-bit-holder", {}, bitHolderVolume],
    ["gridfinity-bit-holder", { shape: "round", size: 8, fit: 0.5, spacing: 14, across: 2, depth: 15 }, bitHolderVolume],
    ["gridfinity-lite-bin", {}, liteBinVolume],
    ["gridfinity-lite-bin", { across: 1, wall: 1.2, units: 5 }, liteBinVolume],
    ["pipe-clip", {}, pipeClipVolume],
    ["pipe-clip", { pipe: 15, grip: 15, wall: 2, width: 12, screws: false }, pipeClipVolume],
    ["charging-stand", {}, chargingStandVolume],
    ["charging-stand", { angle: 50, cable: false }, chargingStandVolume],
    ["bearing-spool-holder", {}, bearingSpoolVolumes],
    ["funnel", {}, funnelVolume],
    ["funnel", { top: 60, spout: 20, length: 10, wall: 1.2 }, funnelVolume],
    ["door-wedge", {}, wedgeVolume],
    ["door-wedge", { grip: false, hang: false, length: 80, height: 20 }, wedgeVolume],
    ["tie-anchor", {}, tieAnchorVolume],
    ["tie-anchor", { screw: "M3", tie: 3.6 }, tieAnchorVolume],
    ["tie-anchor", { screw: "none" }, tieAnchorVolume],
  ];
  for (const [id, extra, volume] of cases) {
    it(`${id}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}: sound parts of the expected volume, on the bed`, () => {
      const r = build(insert(id, extra));
      const want = volume(valuesOf(id, extra));
      const wanted = typeof want === "number" ? { all: want } : want;
      expect(r.parts).toHaveLength(Object.keys(wanted).length);
      if (typeof want === "number") expect(r.volume).toBeCloseTo(want, 1);
      else for (const [end, x] of Object.entries(wanted)) expect(r.volumes[partEnding(r.parts, `_${end}`).id]).toBeCloseTo(x, 1);
      onTheBed(r.parts);
    });
  }

  it("dividers: as many as asked, each the same", () => {
    const r = build(insert("divider-set", { along: 2, across: 3 }));
    expect(r.parts).toHaveLength(5);
    const want = dividerVolumes(valuesOf("divider-set", { along: 2, across: 3 }));
    for (const p of r.parts) expect(r.volumes[p.id]).toBeCloseTo(p.id.includes("_long") ? want.long : want.cross, 1);
    onTheBed(r.parts);
  });

  it("follows its variables: a wider funnel, a wider wedge, a bigger spool hub", () => {
    const f = build(setVar(insert("funnel"), "funnel_top", "120"));
    expect(f.volume).toBeCloseTo(funnelVolume(valuesOf("funnel", { top: 120 })), 1);
    const w = build(setVar(insert("door-wedge"), "wedge_width", "55"));
    expect(w.volume).toBeCloseTo(wedgeVolume(valuesOf("door-wedge", { width: 55 })), 1);
    const s = build(setVar(insert("bearing-spool-holder"), "turntable_hub", "120"));
    expect(s.volumes[partEnding(s.parts, "_hub").id]).toBeCloseTo(bearingSpoolVolumes(valuesOf("bearing-spool-holder", { hub: 120 })).hub, 1);
  });
});

describe("Honeycomb wall inserts", () => {
  // Inserts as they print (x across, y out of the wall, z up) turned into the tile (front face on the bed, y up the
  // wall): −90° about x takes the insert's up to the tile's up and its "into the wall" to the tile's +z.
  const INTO_TILE = about(0, -90);
  for (const id of ["hsw-hook", "hsw-bin"]) {
    it(`${id}: goes into a tile's hole with room all round, is caught by its clips when pulled, and stopped by its lip`, () => {
      const doc = insertInto(insert("hsw-tile"), id);
      const r = build(doc);
      const tile = partEnding(r.parts, "_tile");
      const insertPart = r.parts.find((p) => p !== tile)!;
      // A whole hole in the middle of the tile (an even row, away from the screw cells).
      const cell = tilePlan(valuesOf("hsw-tile")).cells.find((c) => c.i === 2 && c.j === 2)!;
      const seated: V3 = [cell.x, cell.y - PLUG_MID, 0];
      const at = (move: V3) => shared({ part: tile }, { part: insertPart, rotation: INTO_TILE, position: add(seated, move) });
      expect(at([0, 0, 0])).toBeLessThan(1e-3);
      for (const m of [[0.1, 0, 0], [-0.1, 0, 0], [0, 0.1, 0], [0, -0.1, 0]] as V3[]) expect(at(m)).toBeLessThan(1e-3);
      // Pulled out 0.3 mm (towards the room, −z): the ridges meet the back of the hole's narrow part.
      expect(at([0, 0, -0.3])).toBeGreaterThan(0.01);
      // Pushed in 0.1 mm: the lip is against the tile's face.
      expect(at([0, 0, 0.1])).toBeGreaterThan(0.01);
      // Without its clip fingers bending, it can't come out: pulled the whole way, it hits all along.
      expect(at([0, 0, -3])).toBeGreaterThan(at([0, 0, -0.3]));
    });
  }
});

describe("Gridfinity magnet baseplate", () => {
  it("has its magnet pockets 13 mm from each cell's middle, 6.5 across and 2.4 deep in the floor", () => {
    const spots = magnetSpots(0, 0);
    const probes = spots.flatMap(([x, y], k) => roundPart(`probe${k}`, x, y, FLOOR_TOP - MAGNET.depth + 0.05, MAGNET.d - 0.1, MAGNET.depth - 0.1));
    const r = build(withFeatures(insert("gridfinity-magnet-baseplate", { across: 1, along: 1 }), probes));
    const plate = partEnding(r.parts, "_plate");
    const pins = r.parts.filter((p) => p.id.startsWith("probe"));
    expect(pins).toHaveLength(4);
    for (const pin of pins) {
      expect(shared({ part: plate }, { part: pin })).toBeLessThan(1e-3);
      expect(shared({ part: plate }, { part: pin, position: [0.15, 0, 0] })).toBeGreaterThan(1e-3);
      expect(shared({ part: plate }, { part: pin, position: [0, 0, -0.15] })).toBeGreaterThan(1e-3);
    }
  });

  it("standard bins (with magnets too) still sit in it, their magnets over the plate's", () => {
    const doc = insertInto(insertInto(insert("gridfinity-magnet-baseplate", { across: 2, along: 1 }), "gridfinity-bin", { across: 1, magnets: true }), "gridfinity-bin", { across: 2, along: 1 });
    const r = build(doc);
    const plate = partEnding(r.parts, "_plate");
    const [one, two] = r.parts.filter((p) => p !== plate);
    // The 1-cell bin in the left cell: clear at the standard's middle height, only touching when it rests on the floor.
    expect(shared({ part: plate }, { part: one, position: [-21, 0, FLOOR_TOP + CENTRED] })).toBeLessThan(1e-3);
    expect(shared({ part: plate }, { part: one, position: [-21, 0, FLOOR_TOP] })).toBeLessThan(0.05);
    expect(shared({ part: plate }, { part: one, position: [-21, 0, FLOOR_TOP - 0.1] })).toBeGreaterThan(0.05);
    expect(shared({ part: plate }, { part: two, position: [0, 0, FLOOR_TOP + CENTRED] })).toBeLessThan(1e-3);
    // Its magnets sit right over the plate's (the same spots round each cell's middle).
    expect(magnetSpots(-21, 0).map(([x, y]) => [x + 21, y])).toEqual(magnetSpots(0, 0));
  });
});

describe("pipe clip", () => {
  it("fits round its pipe and holds it: pulled straight out, the pipe meets the lips", () => {
    const v = valuesOf("pipe-clip");
    const p = pipeClipPlan(v);
    const r = build(withFeatures(insert("pipe-clip"), roundPart("pipe", 0, p.centre, 0, p.pipe, p.width)));
    const clip = partEnding(r.parts, "_clip");
    const pipe = r.parts.find((x) => x.id === "pipe")!;
    expect(shared({ part: clip }, { part: pipe })).toBeLessThan(1e-3);
    // Room all round: nudged 90% of it, still free.
    for (const m of [[0.18, 0, 0], [-0.18, 0, 0], [0, 0.18, 0], [0, -0.18, 0]] as V3[]) expect(shared({ part: clip }, { part: pipe, position: m })).toBeLessThan(1e-3);
    expect(shared({ part: clip }, { part: pipe, position: [0, 1, 0] })).toBeGreaterThan(1);
    // Halfway out it would need the lips spread nearly their whole spring.
    expect(shared({ part: clip }, { part: pipe, position: [0, p.pipe / 2, 0] })).toBeGreaterThan(shared({ part: clip }, { part: pipe, position: [0, 1, 0] }));
  });
});

describe("spool holder on a bearing", () => {
  it("a 608 slides over the pin and into the hub's pocket with the press fit's gap, and the hub rides on it clear of the base", () => {
    const v = valuesOf("bearing-spool-holder");
    const fit = v.fit as number;
    const z = SPOOL_BASE.thickness + SPOOL_BASE.lift;
    const hx = hubAt(varsOf(v, ["hole", "hub", "base", "fit"])).v;
    const r = build(withFeatures(insert("bearing-spool-holder"), roundPart("bearing", 0, 0, 0, BEARING.outside, BEARING.width, BEARING.bore)));
    const base = partEnding(r.parts, "_base");
    const hub = partEnding(r.parts, "_hub");
    const bearing = r.parts.find((p) => p.id === "bearing")!;
    const onPin = (dx: number) => shared({ part: base }, { part: bearing, position: [dx, 0, z] });
    const inHub = (dx: number) => shared({ part: hub }, { part: bearing, position: [hx + dx, 0, 0] });
    // On the pin: half the fit each side.
    expect(onPin(0)).toBeLessThan(1e-3);
    expect(onPin(fit / 2 - 0.01)).toBeLessThan(1e-3);
    expect(onPin(fit / 2 + 0.01)).toBeGreaterThan(1e-5);
    // Resting on the shoulder, not below it.
    expect(shared({ part: base }, { part: bearing, position: [0, 0, z - 0.05] })).toBeGreaterThan(1e-3);
    // In the hub's pocket: the same.
    expect(inHub(0)).toBeLessThan(1e-3);
    expect(inHub(fit / 2 - 0.01)).toBeLessThan(1e-3);
    expect(inHub(fit / 2 + 0.01)).toBeGreaterThan(1e-5);
    // Pushed right in, the pocket's ledge stops it.
    expect(shared({ part: hub }, { part: bearing, position: [hx, 0, 0.05] })).toBeGreaterThan(1e-3);
    // Put together: the hub on the bearing on the pin, the hub clear of the base.
    const hubOn: V3 = [-hx, 0, z];
    expect(shared({ part: base }, { part: hub, position: hubOn })).toBeLessThan(1e-3);
    expect(shared({ part: base }, { part: hub, position: [-hx, 0, z - SPOOL_BASE.lift + 0.1] })).toBeLessThan(1e-3);
    expect(box(hub).min[2]).toBeCloseTo(0, 4);
  });
});

describe("box dividers", () => {
  it("slot together crosswise with the slot fit, flush top and bottom", () => {
    const v = valuesOf("divider-set");
    const p = dividerPlan(v);
    const r = build(insert("divider-set"));
    const long = partEnding(r.parts, "_long1");
    const cross = partEnding(r.parts, "_cross1");
    // Stood up: the long one along x at the first y place, the cross one along y at the first x place.
    const qLong = about(0, 90);
    const qCross = then(about(0, 90), about(2, 90));
    const place = (part: PartMesh, q: Quat, min: V3): V3 => {
      const b = box(part, q);
      return [min[0] - b.min[0], min[1] - b.min[1], min[2] - b.min[2]];
    };
    const at = (dx: number) =>
      shared(
        { part: long, rotation: qLong, position: place(long, qLong, [-p.longLength / 2, p.ys[0] - p.t / 2, 0]) },
        { part: cross, rotation: qCross, position: add(place(cross, qCross, [p.xs[0] - p.t / 2, -p.crossLength / 2, 0]), [dx, 0, 0]) },
      );
    expect(box(long, qLong).max[2] - box(long, qLong).min[2]).toBeCloseTo(p.height, 4);
    expect(at(0)).toBeLessThan(1e-3);
    expect(at(0.1)).toBeLessThan(1e-3);
    expect(at(0.25)).toBeGreaterThan(1e-3);
  });
});

describe("a user's part", () => {
  it("is left alone when designs are put into its Part Studio on top of it", () => {
    const user = [
      sketchFeature("user-s", "My sketch", { kind: "default", name: "Top" }, shapesSketch([{ type: "rectangle", center: ["0", "0"], width: "60", height: "60" }], {})),
      extrudeFeature("user", "My block", "user-s", { depth: lit(20), operation: "new" }),
    ];
    let doc: JuraCADDocument = { ...emptyDocument(), features: user };
    for (const id of ["hsw-hook", "pipe-clip", "tie-anchor", "gridfinity-lite-bin", "funnel"]) doc = insertInto(doc, id);
    const r = build(doc);
    expect(r.volumes.user).toBeCloseTo(60 * 60 * 20, 3);
    expect(r.parts).toHaveLength(6);
  });
});
