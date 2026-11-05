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
import { levelPlane, loftFeature } from "../src/library/printKit";
import { FACE_Z, flatHex, hookVolume, HSW, hswBinPlan, hswBinVolumes, LIP_TOP, tilePlan, tileVolume } from "../src/library/designs/honeycomb";
import { bitHolderVolume, FLOOR_TOP, liteBinVolume, magnetBaseplateVolume, magnetSpots } from "../src/library/designs/gridfinityMore";
import { CENTRED, MAGNET } from "../src/library/designs/gridfinity";
import { pipeClipPlan, pipeClipVolume } from "../src/library/designs/pipeClip";
import { chargingPlan, chargingStandVolume } from "../src/library/designs/chargingStand";
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
    ["hsw-hook", { reach: 60, tip: 20, width: 12, arm: 8 }, hookVolume],
    ["hsw-bin", {}, hswBinVolumes],
    ["hsw-bin", { width: 60, depth: 20, height: 30, fit: 0.4 }, hswBinVolumes],
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
    ["charging-stand", { plugLength: 40 }, chargingStandVolume],
    ["charging-stand", { angle: 75 }, chargingStandVolume],
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
  // Inserts print standing on their plug's end (z up, the wall face at FACE_Z). Into the tile (front face on the bed,
  // the wall at +z): turned 180° about y, so the plug points into the tile, then moved to a hole with its face on the tile's.
  const INTO_TILE: Quat = [0, 1, 0, 0];
  const holeIn = () => tilePlan(valuesOf("hsw-tile")).cells.find((c) => c.i === 2 && c.j === 2)!;
  const checkSeat = (tile: PartMesh, part: PartMesh, nudge: number) => {
    const cell = holeIn();
    const seated: V3 = [cell.x, cell.y, FACE_Z];
    const at = (move: V3) => shared({ part: tile }, { part, rotation: INTO_TILE, position: add(seated, move) });
    expect(at([0, 0, 0])).toBeLessThan(1e-3);
    for (const m of [[0.1, 0, 0], [-0.1, 0, 0], [0, nudge, 0], [0, -nudge, 0]] as V3[]) expect(at(m)).toBeLessThan(1e-3);
    // Pulled out 0.3 mm (towards the room, −z): the bumps meet the hole's narrow part, so it needs a firm pull.
    expect(at([0, 0, -0.3])).toBeGreaterThan(1e-3);
    // Pushed in 0.1 mm: the lip is against the tile's face.
    expect(at([0, 0, 0.1])).toBeGreaterThan(0.01);
    // Without its snap fingers bending it can't come out: pulled further, it hits more.
    expect(at([0, 0, -3])).toBeGreaterThan(at([0, 0, -0.3]));
  };
  for (const [id, end] of [["hsw-hook", "_hook"], ["hsw-bin", "_insert"]]) {
    it(`${id}: goes into a tile's hole with room all round, is held by its snap bumps when pulled, and stopped by its lip`, () => {
      const r = build(insertInto(insert("hsw-tile"), id));
      checkSeat(partEnding(r.parts, "_tile"), partEnding(r.parts, end), 0.05);
    });
  }

  it("a stand-in with PStover's measured insert profile (all round, so stricter than his six bumps) fits our tile the same way", () => {
    // PStover's standard insert (PSTOV-HSW-CONNECTOR-STD, measured from its mesh): 19.7 body 7.5 long, 22.5 lip 3 thick,
    // bumps from 5.0 behind the face, 20.0 across at 5.11, 20.75 at 5.88, 20.56 at 6.24, back to the body by 7.1.
    const band: [number, number][] = [[7.1, 19.6], [6.24, 20.56], [5.88, 20.748], [5.11, 20.0], [5.0, 19.6]];
    const hexAt = (id: string, z: number, w: number) => sketchFeature(id, id, levelPlane(`${z} up`, z), shapesSketch([{ type: "outline", closed: true, points: flatHex(w).map(([x, y]) => [String(x), String(y)]) }], {}));
    const standIn: Feature[] = [
      hexAt("ps-body-s", 0, HSW.body),
      extrudeFeature("pstover", "PStover stand-in", "ps-body-s", { depth: lit(FACE_Z), operation: "new" }),
      hexAt("ps-lip-s", FACE_Z, HSW.lip),
      extrudeFeature("ps-lip", "lip", "ps-lip-s", { depth: lit(3), operation: "add" }),
      ...band.map(([d, w], k) => hexAt(`ps-band-${k}`, FACE_Z - d, w)),
      loftFeature("ps-band", "bumps", band.map((_, k) => `ps-band-${k}`), "add"),
    ];
    const r = build(withFeatures(insert("hsw-tile"), standIn));
    const tile = partEnding(r.parts, "_tile");
    const ps = r.parts.find((p) => p.id === "pstover")!;
    const cell = holeIn();
    const at = (move: V3) => shared({ part: tile }, { part: ps, rotation: INTO_TILE, position: add([cell.x, cell.y, FACE_Z], move) });
    expect(at([0, 0, 0])).toBeLessThan(1e-3);
    expect(at([0, 0, -0.3])).toBeGreaterThan(1e-3);
    expect(at([0, 0, 0.1])).toBeGreaterThan(0.01);
  });

  it("the bin slides down onto its insert's rail, rests on its 45° end, and the dovetail holds it to the wall", () => {
    const v = valuesOf("hsw-bin");
    const b = hswBinPlan(v);
    const r = build(insert("hsw-bin"));
    const ins = partEnding(r.parts, "_insert");
    const bin = partEnding(r.parts, "_bin");
    // The bin as it prints (y out from the wall, z up) turned onto the insert (y up, z out): x → −x, y → z, z → y.
    const q: Quat = [0, Math.SQRT1_2, Math.SQRT1_2, 0];
    // Hung: its groove's roof the fit (square to it) above the rail's 45° end.
    const seated: V3 = [b.x0, -b.hangsBelow, LIP_TOP - b.y0];
    const at = (move: V3) => shared({ part: ins }, { part: bin, rotation: q, position: add(seated, move) });
    expect(at([0, 0, 0])).toBeLessThan(1e-3);
    // It slides up and off, with room either side.
    expect(at([0, 1, 0])).toBeLessThan(1e-3);
    expect(at([0, 10, 0])).toBeLessThan(1e-3);
    expect(at([0.2, 1, 0])).toBeLessThan(1e-3);
    expect(at([-0.2, 1, 0])).toBeLessThan(1e-3);
    // It can't go further down than the rail's end, nor pull straight off the wall.
    // (The roof is the fit clear of the rail's end square to 45°, so fit × √2 straight down.)
    expect(at([0, -0.3, 0])).toBeLessThan(1e-3);
    expect(at([0, -0.6, 0])).toBeGreaterThan(1e-3);
    expect(at([0, 1, 0.5])).toBeGreaterThan(1e-3);
  });
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

describe("charging stand", () => {
  for (const extra of [{}, { plugLength: 40 }, { angle: 75 }] as DesignValues[]) {
    it(`a plug (6.5 × 12 × its length) tilted with the phone from its socket fits its slot${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}`, () => {
      const p = chargingPlan(valuesOf("charging-stand", extra));
      // The plug as a user would draw it: 12 across (x), 6.5 thick (y), its length up from its socket end at z = 0.
      const plugBox: Feature[] = [
        sketchFeature("plug-s", "plug", { kind: "default", name: "Top" }, shapesSketch([{ type: "rectangle", center: ["0", "0"], width: "12", height: "6.5" }], {})),
        extrudeFeature("plug", "plug", "plug-s", { depth: lit(p.plugLength), operation: "new" }),
      ];
      const r = build(withFeatures(insert("charging-stand", extra), plugBox));
      const stand = partEnding(r.parts, "_stand");
      const plug = r.parts.find((x) => x.id === "plug")!;
      // Turned about x so its length runs down the phone's line (world y = cos, z = −sin), its end on the socket.
      const a = -((90 + p.angle) * Math.PI) / 180;
      const q: Quat = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
      expect(turn(q, [0, 0, 1])[1]).toBeCloseTo(p.cos, 6);
      expect(turn(q, [0, 0, 1])[2]).toBeCloseTo(-p.sin, 6);
      const at: V3 = [0, p.socket[0], p.socket[1]];
      expect(shared({ part: stand }, { part: plug, rotation: q, position: at })).toBeLessThan(1e-3);
      // And it's a snug slot: moved 1 mm forward (into the front wall's side) it hits.
      expect(shared({ part: stand }, { part: plug, rotation: q, position: add(at, [0, p.n[0], p.n[1]]) })).toBeGreaterThan(1e-3);
    });
  }
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
