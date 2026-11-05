/**
 * The fourth batch of 3D-printing designs built with the real geometry engine: sound solids of the expected volume,
 * flat on the bed, and the things that must fit — the enclosure's lid in its box with the stated clearance (and the
 * snap lid caught by its ridges), the French cleat's 45° faces meeting with the clearance and catching when pulled,
 * the hinged box's lid swinging over without touching, the cable chain's links bending through their range without
 * touching and held by their pins, the fit test's holes the stated sizes and the bridge test's gaps the stated spans
 * — and a user's part left alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { enclosurePlan, enclosureVolumes, SNAP } from "../src/library/designs/enclosure";
import { cleatVolumes, hangLift } from "../src/library/designs/frenchCleat";
import { hingedPlan, hingedVolumes } from "../src/library/designs/hingedBox";
import { organiserVolume } from "../src/library/designs/deskOrganiser";
import { chainPlan, linkVolume, sagAngle, snapStrain } from "../src/library/designs/cableChain";
import { lit } from "../src/library/ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../src/library/sketchKit";
import { pocketVolume } from "../src/library/designs/wallPocket";
import { pinVolume } from "../src/library/designs/shelfPins";
import { bridgePlan, bridgeVolume, fitPlan, fitVolumes, overhangPlan, overhangVolume } from "../src/library/designs/testPrints";
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
const insertInto = (doc: JuraCADDocument, id: string, values: DesignValues) => insertDesign(doc, findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
const insert = (id: string, values: DesignValues = {}) => insertInto(emptyDocument(), id, values);
const setVar = (doc: JuraCADDocument, name: string, value: string) => applyVariables(doc, doc.variables!.map((v) => (v.name === name ? { ...v, value } : v)));

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const volumes = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  return { parts: r.parts, volumes, volume: Object.values(volumes).reduce((n, v) => n + v, 0) };
}

function box(p: PartMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.vertices.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p.vertices[i + k])), (max[k] = Math.max(max[k], p.vertices[i + k]));
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

/** A turn of `deg` degrees about the x axis, and the move that makes it a turn about the line y = 0, z = `h`. */
function aboutX(deg: number, h: number): { rotation: Quat; position: V3 } {
  const a = (deg * Math.PI) / 180;
  return { rotation: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)], position: [0, h * Math.sin(a), h - h * Math.cos(a)] };
}

describe("every design of the fourth batch", () => {
  const cases: [string, DesignValues, (v: DesignValues) => number | Record<string, number>][] = [
    ["enclosure", {}, enclosureVolumes],
    ["enclosure", { fixing: "snap", holes: "selfTap", port2Side: "left", port2Along: 5 }, enclosureVolumes],
    ["enclosure", { board: "uno", standoff: 7, vents: 0, port1Side: "back", port2Side: "right" }, enclosureVolumes],
    ["enclosure", { board: "custom", boardWidth: 60, boardDepth: 40, holesX: 50, holesY: 30, width: 90, depth: 70, fixing: "snap" }, enclosureVolumes],
    ["french-cleat", {}, cleatVolumes],
    ["french-cleat", { holder: "shelf" }, cleatVolumes],
    ["french-cleat", { holder: "holes", parts: "holder" }, cleatVolumes],
    ["hinged-box", {}, hingedVolumes],
    ["hinged-box", { height: 20, lid: 20, knuckles: 3 }, hingedVolumes],
    ["desk-organiser", {}, organiserVolume],
    ["desk-organiser", { shape: "square", sizes: "50, 30" }, organiserVolume],
    ["desk-organiser", { layout: "grid", across: 2, rows: 2 }, organiserVolume],
    ["desk-organiser", { layout: "grid", shape: "square", across: 4, rows: 1 }, organiserVolume],
    ["wall-pocket", {}, pocketVolume],
    ["wall-pocket", { cable: false, width: 55, depth: 24 }, pocketVolume],
    ["fit-test", {}, fitVolumes],
    ["fit-test", { labels: false, peg: 6, from: 0, to: 0.3, step: 0.05 }, fitVolumes],
    ["overhang-test", {}, overhangVolume],
    ["overhang-test", { labels: false, from: 30, to: 60, step: 15 }, overhangVolume],
    ["bridge-test", {}, bridgeVolume],
    ["bridge-test", { labels: false, from: 5, to: 25, step: 5 }, bridgeVolume],
  ];
  for (const [id, extra, volume] of cases) {
    it(`${id}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}: sound parts of the expected volume, on the bed`, () => {
      const r = build(insert(id, extra));
      const want = volume(valuesOf(id, extra));
      const wanted = typeof want === "number" ? { all: want } : Object.fromEntries(Object.entries(want).filter(([, x]) => x > 0));
      expect(r.parts).toHaveLength(Object.keys(wanted).length);
      if (typeof want === "number") expect(r.volume).toBeCloseTo(want, 1);
      else for (const [end, x] of Object.entries(wanted)) expect(r.volumes[partEnding(r.parts, `_${end}`).id]).toBeCloseTo(x, 1);
      onTheBed(r.parts);
    });
  }

  it("shelf pins and cable chain links: as many as asked, each the same", () => {
    const pins = build(insert("shelf-pins", { count: 3, hole: "6.35" }));
    expect(pins.parts).toHaveLength(3);
    for (const p of pins.parts) expect(pins.volumes[p.id]).toBeCloseTo(pinVolume(valuesOf("shelf-pins", { hole: "6.35" })), 1);
    onTheBed(pins.parts);
    const chain = build(insert("cable-chain", { count: 3 }));
    expect(chain.parts).toHaveLength(3);
    for (const p of chain.parts) expect(chain.volumes[p.id]).toBeCloseTo(linkVolume(valuesOf("cable-chain")), 1);
    onTheBed(chain.parts);
  });

  it("follows its variables: a wider enclosure (its cut-out follows the front), a longer cleat strip", () => {
    const doc = setVar(insert("enclosure", { fixing: "snap" }), "encl_width", "120");
    const r = build(doc);
    expect(r.volumes[partEnding(r.parts, "_box").id]).toBeCloseTo(enclosureVolumes(valuesOf("enclosure", { fixing: "snap", width: 120 })).box, 1);
    expect(box(partEnding(r.parts, "_box")).max[0]).toBeCloseTo(62, 3);
    const deeper = build(setVar(insert("enclosure"), "encl_depth", "90"));
    expect(deeper.volumes[partEnding(deeper.parts, "_box").id]).toBeCloseTo(enclosureVolumes(valuesOf("enclosure", { depth: 90 })).box, 1);
    const cleat = build(setVar(insert("french-cleat"), "cleat_length", "300"));
    expect(cleat.volumes[partEnding(cleat.parts, "_strip").id]).toBeCloseTo(cleatVolumes(valuesOf("french-cleat", { length: 300 })).strip, 1);
  });
});

describe("the enclosure's lid", () => {
  for (const fixing of ["screws", "snap"]) {
    it(`${fixing}: sits on the box with its lip the clearance clear of the walls${fixing === "snap" ? ", caught by its ridges" : " and posts"}`, () => {
      const v = valuesOf("enclosure", { fixing, placement: "on" });
      const p = enclosurePlan(v);
      const r = build(insert("enclosure", { fixing, placement: "on" }));
      const [boxPart, lid] = ["_box", "_lid"].map((e) => partEnding(r.parts, e));
      expect(box(lid).max[2]).toBeCloseTo(p.outer[2] + p.lidThickness, 3);
      const at = (dx: number, dy: number, dz = 0) => shared({ part: boxPart }, { part: lid, position: [dx, dy, dz] });
      const c = p.clearance;
      expect(at(0, 0)).toBeLessThan(0.001);
      // Most of the clearance either way, it still touches nothing …
      for (const [dx, dy] of [[0.9 * c, 0], [-0.9 * c, 0], [0, 0.9 * c], [0, -0.9 * c]]) expect(at(dx, dy)).toBeLessThan(0.001);
      // … but past it, the lip runs into a wall (or a corner post).
      expect(at(c + 0.1, 0)).toBeGreaterThan(0.001);
      expect(at(0, -(c + 0.1))).toBeGreaterThan(0.001);
      // Lifted a little: a snap lid's ridges catch in their grooves; a screwed one just lifts off.
      if (fixing === "snap") {
        expect(at(0, 0, 0.5)).toBeGreaterThan(0.001);
        expect(at(0, 0, SNAP.lip + 1)).toBeLessThan(0.001);
      } else expect(at(0, 0, 0.5)).toBeLessThan(0.001);
    });
  }

  for (const holes of ["selfTap", "insert"]) {
    it(`the screwed lid's countersunk holes line up with the posts' ${holes === "insert" ? "insert" : "pilot"} holes`, () => {
      const extra = { placement: "on", holes };
      const p = enclosurePlan(valuesOf("enclosure", extra));
      const [W, D] = p.inner;
      // Rods down through each corner: an M3 screw (3 mm) is clear of the lid; in a post a rod a shade under the post's
      // hole is clear too (so the holes line up), and one a shade over it isn't (so it's that size).
      const rods = (d: number, name: string): Feature[] =>
        [1, -1].flatMap((sx) =>
          [1, -1].map((sy, k): Feature => ({ ...createFeature(emptyDocument(), "cylinder"), id: `${name}${sx}${k}`, params: { diameter: String(d), height: "12", x: String(sx * (W / 2 - p.post / 2)), y: String(sy * (D / 2 - p.post / 2)), z: String(p.outer[2] - 6) } })),
        );
      const doc = insert("enclosure", extra);
      const r = build({ ...doc, features: [...doc.features, ...rods(3, "screw"), ...rods(p.postHole - 0.05, "under"), ...rods(p.postHole + 0.1, "over")] });
      const [boxPart, lid] = ["_box", "_lid"].map((e) => partEnding(r.parts, e));
      const of = (name: string) => r.parts.filter((x) => x.id.startsWith(name));
      expect(of("screw")).toHaveLength(4);
      for (const s of of("screw")) expect(shared({ part: lid }, { part: s })).toBeLessThan(0.001);
      for (const s of of("under")) expect(shared({ part: boxPart }, { part: s })).toBeLessThan(0.001);
      for (const s of of("over")) expect(shared({ part: boxPart }, { part: s })).toBeGreaterThan(0.001);
    });
  }
});

describe("the French cleat", () => {
  /**
   * The holder hung on the strip, in the strip's frame as it's printed (front down: z = thickness − out from the wall):
   * turned so its laid-out x (out from the wall) runs down z and its width along x, and lifted into place.
   * `d` = [along, up, out from the wall].
   */
  const s45 = Math.SQRT1_2;
  const hung = (v: DesignValues, d: V3 = [0, 0, 0]): { rotation: Quat; position: V3 } => ({
    rotation: [0, s45, 0, s45],
    position: [(v.length as number) / 2 - (v.width as number) / 2 + d[0], hangLift(v) + d[1], (v.thickness as number) - d[2]],
  });

  it("the strip prints on its front: its 45° slope faces up, nothing faces down but the bed", () => {
    const r = build(insert("french-cleat", { parts: "cleat" }));
    const faces = r.parts[0].faceRefs.filter((f) => f.surface === "PLANE");
    expect(faces.some((f) => Math.abs(f.normal[0]) < 1e-4 && Math.abs(f.normal[1] - Math.SQRT1_2) < 1e-4 && Math.abs(f.normal[2] - Math.SQRT1_2) < 1e-4)).toBe(true);
    for (const f of faces) if (f.normal[2] < -1e-4) expect(f.center[2]).toBeCloseTo(0, 4);
  });

  for (const holder of ["hook", "shelf", "holes"]) {
    it(`a ${holder} holder hangs on the strip: its 45° face the clearance off the strip's, and it catches when pulled`, () => {
      const extra = { holder, holeCount: 3 };
      const v = valuesOf("french-cleat", extra);
      const r = build(insert("french-cleat", extra));
      const [strip, holder_] = ["_strip", "_holder"].map((e) => partEnding(r.parts, e));
      const on = (d: V3) => shared({ part: strip }, { part: holder_, ...hung(v, d) });
      const c = v.clearance as number;
      expect(on([0, 0, 0])).toBeLessThan(0.001);
      // Square to the 45° faces (towards the strip's slope = down and out from the wall): 0.9 of the gap is free …
      const k = Math.SQRT1_2;
      expect(on([0, -0.9 * c * k, 0.9 * c * k])).toBeLessThan(0.001);
      // … a little more and the faces meet.
      expect(on([0, -1.3 * c * k, 1.3 * c * k])).toBeGreaterThan(0.0001);
      // It catches: pulled straight away from the wall, or pushed down, it runs into the strip's slope.
      expect(on([0, 0, 1])).toBeGreaterThan(0.01);
      expect(on([0, -1, 0])).toBeGreaterThan(0.01);
      // Lifted clear of the strip's top, it comes away.
      expect(on([0, (v.thickness as number) + 2, 3])).toBeLessThan(0.001);
    });
  }
});

describe("the hinged box", () => {
  it("the lid swings over on its hinge without touching the box, and closes onto its rim", () => {
    const p = hingedPlan(valuesOf("hinged-box"));
    const r = build(insert("hinged-box"));
    const [boxPart, lid] = ["_box", "_lid"].map((e) => partEnding(r.parts, e));
    for (const deg of [0, 20, 45, 70, 90, 110, 135, 160, 175, 180]) expect(shared({ part: boxPart }, { part: lid, ...aboutX(deg, p.a) })).toBeLessThan(0.001);
    // Closed, the lid's rim is on the box's: lowered any further, they'd overlap.
    const closed = aboutX(180, p.a);
    expect(shared({ part: boxPart }, { part: lid, rotation: closed.rotation, position: [0, closed.position[1], closed.position[2] - 0.3] })).toBeGreaterThan(0.01);
    // The lid's knuckles keep the clearance at their ends: slid along the pin by most of it, still clear; past it, they meet.
    expect(shared({ part: boxPart }, { part: lid, position: [0.9 * p.c, 0, 0] })).toBeLessThan(0.001);
    expect(shared({ part: boxPart }, { part: lid, position: [p.c + 0.15, 0, 0] })).toBeGreaterThan(0.001);
  });
});

describe("the cable chain", () => {
  /** Link 2 joined to link 1's front pins, bent `deg` degrees (+ = its far end up). */
  function joined(v: DesignValues, deg: number, slide: V3 = [0, 0, 0]): { rotation: Quat; position: V3 } {
    const p = chainPlan(v);
    const a = (deg * Math.PI) / 180;
    // Turned about −y by deg (x towards z), then its back joint (0, R) put on link 1's front joint (pitch, R).
    return {
      rotation: [0, -Math.sin(a / 2), 0, Math.cos(a / 2)],
      position: [p.pitch + p.R * Math.sin(a) + slide[0], p.total + 4 + slide[1], p.R - p.R * Math.cos(a) + slide[2]],
    };
  }
  for (const extra of [{}, { width: 30, height: 20, bend: 40, wall: 2.4 }] as DesignValues[]) {
    it(`links ${JSON.stringify(extra)} bend through their range without touching, stop there, and are held by their pins`, () => {
      const v = valuesOf("cable-chain", { ...extra, count: 2 });
      const p = chainPlan(v);
      const r = build(insert("cable-chain", { ...extra, count: 2 }));
      const [one, two] = [partEnding(r.parts, "_link"), partEnding(r.parts, "_link2")];
      const bent = (deg: number, slide?: V3) => shared({ part: one }, { part: two, ...joined(v, deg, slide) });
      for (let deg = 0; deg <= p.bend - 1.5; deg += 5) expect(bent(deg)).toBeLessThan(0.001);
      expect(bent(p.bend - 1)).toBeLessThan(0.001);
      // Past the bend angle, the back of link 2 runs into link 1's middle: that's the stop.
      expect(bent(p.bend + 3)).toBeGreaterThan(0.001);
      // The other way it only sags a degree or two before the stop.
      expect(sagAngle(p)).toBeGreaterThan(-3);
      expect(bent(sagAngle(p) + 0.5)).toBeLessThan(0.001);
      expect(bent(sagAngle(p) - 2)).toBeGreaterThan(0.001);
      // The pins hold it: pulled apart, pushed together or lifted by more than the clearance, a pin meets its hole.
      for (const slide of [[0.6, 0, 0], [-0.6, 0, 0], [0, 0, 0.6]] as V3[]) expect(bent(10, slide)).toBeGreaterThan(0.001);
    });
  }
});

describe("cable chain links push together", () => {
  it("each pin slides up its lead-in ramp: the side walls bend apart gradually, never more than the pin's reach in all (half each)", () => {
    const v = valuesOf("cable-chain", { count: 2 });
    const p = chainPlan(v);
    const doc = insert("cable-chain", { count: 2 });
    // Keep only the +y half of link 2 (the latest part), so moving it sideways measures how far its +y outer layer must bend.
    const half = -(p.total + 4);
    const cut = sketchFeature("half-sk", "Half", { kind: "default", name: "Top" }, shapesSketch([{ type: "rectangle", corner: ["-100", "-200"], width: "300", height: String(200 + half) }], {}));
    const r = build({ ...doc, features: [...doc.features, cut, extrudeFeature("half", "Half", "half-sk", { depth: lit(100), operation: "remove" })] });
    const [one, two] = [partEnding(r.parts, "_link"), partEnding(r.parts, "_link2")];
    const free = (x: number, dy: number) => shared({ part: one }, { part: two, position: [p.pitch + x, -half + dy, 0] }) < 1e-4;
    /** How far link 2's outer layer must move out to clear link 1's pin, with link 2 `x` short of sitting on it. */
    const splay = (x: number) => {
      if (free(x, 0)) return 0;
      let [lo, hi] = [0, p.reach + 0.6];
      expect(free(x, hi)).toBe(true);
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (free(x, mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const r_ = p.pin / 2;
    const first = r_ + 1 - p.ramp.edge;
    const needs: number[] = [];
    for (let x = first; x > 0; x -= 0.5) needs.push(splay(x));
    needs.push(splay(0));
    // Where the pin first meets the back edge, the ramp is as deep as the pin reaches: it slides in with (almost) no bend.
    expect(needs[0]).toBeLessThan(0.05);
    expect(needs[1]).toBeLessThan(0.15);
    // The bend grows gradually up the ramp (no step to push against) …
    const slope = p.reach / (p.ramp.hole - p.ramp.edge);
    for (let i = 1; i < needs.length; i++) expect(needs[i] - needs[i - 1]).toBeLessThan(0.5 * slope + 0.05);
    // … to the pin's reach in all at the hole's lip (the outer layer out, the inner layer in: about half each, as snapStrain
    // assumes) — and seated, the pin is in its hole with nothing bent.
    expect(Math.max(...needs)).toBeLessThan(p.reach + 0.05);
    expect(Math.max(...needs) / 2).toBeLessThan(p.reach / 2 + 0.03);
    expect(needs[needs.length - 1]).toBe(0);
    expect(snapStrain(p)).toBeCloseTo((3 * p.t * (Math.max(...needs) / 2)) / (2 * p.a * p.a), 3);
  });
});

describe("the test prints are the sizes they say", () => {
  it("fit test: the peg turns freely in each hole within its gap, and meets the side just past it", () => {
    const v = valuesOf("fit-test", { labels: false });
    const p = fitPlan(v);
    const r = build(insert("fit-test", { labels: false }));
    const [plate, peg] = ["_plate", "_peg"].map((e) => partEnding(r.parts, e));
    // The peg's base below the plate, its rod up through a hole.
    for (const h of p.holes) {
      const into = (dx: number) => shared({ part: plate }, { part: peg, position: [h.x - p.pegAt[0] + dx, h.y - p.pegAt[1], -(p.base + 0.5)] });
      expect(into(0)).toBeLessThan(0.001);
      expect(into(0.8 * h.c)).toBeLessThan(0.001);
      expect(into(h.c + 0.05)).toBeGreaterThan(0.0001);
    }
  });

  it("overhang test: each fin's underside leans the stated angle from upright", () => {
    const v = valuesOf("overhang-test", { labels: false });
    const p = overhangPlan(v);
    const r = build(insert("overhang-test", { labels: false }));
    const faces = r.parts[0].faceRefs.filter((f) => f.surface === "PLANE");
    for (const f of p.fins) {
      const a = (f.angle * Math.PI) / 180;
      // Facing down and out: (cos a, 0, −sin a).
      expect(faces.some((x) => Math.abs(x.normal[0] - Math.cos(a)) < 1e-4 && Math.abs(x.normal[1]) < 1e-6 && Math.abs(x.normal[2] + Math.sin(a)) < 1e-4)).toBe(true);
    }
  });

  it("bridge test: each gap is the stated span and height (a block just smaller fits under the deck; just bigger doesn't)", () => {
    const v = valuesOf("bridge-test", { labels: false });
    const p = bridgePlan(v);
    const probes = (grow: number): Feature[] =>
      p.gaps.map((g, i): Feature => ({ ...createFeature(emptyDocument(), "box"), id: `probe${i}`, params: { width: String(g.span + grow), depth: "4", height: String(p.under + grow), x: String(g.x0 - grow / 2), y: "-7", z: "2" } }));
    for (const [grow, fits] of [[-0.02, true], [0.1, false]] as const) {
      const doc = insert("bridge-test", { labels: false });
      const r = build({ ...doc, features: [...doc.features, ...probes(grow)] });
      const test = partEnding(r.parts, "_base");
      for (const pr of r.parts.filter((x) => x.id.startsWith("probe"))) {
        const s = shared({ part: test }, { part: pr });
        if (fits) expect(s).toBeLessThan(0.001);
        else expect(s).toBeGreaterThan(0.0001);
      }
    }
  });
});

describe("put into a Part Studio that already has a part", () => {
  for (const id of ["enclosure", "french-cleat", "hinged-box", "desk-organiser", "cable-chain", "wall-pocket", "shelf-pins", "fit-test", "overhang-test", "bridge-test"]) {
    it(`${id}: leaves the user's part alone, even where they overlap`, () => {
      const extra: DesignValues = id === "cable-chain" ? { count: 2 } : {};
      const alone = build(insert(id, extra));
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "300", depth: "300", height: "10", x: "-150", y: "-150", z: "-2" } }] };
      doc = insertInto(doc, id, extra);
      const r = build(doc);
      expect(r.volumes.mine).toBeCloseTo(300 * 300 * 10, 3);
      expect(r.parts).toHaveLength(alone.parts.length + 1);
      expect(r.volume - r.volumes.mine).toBeCloseTo(alone.volume, 2);
    });
  }
});
