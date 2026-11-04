/**
 * The Design library's designs with modelled threads, built with the real geometry engine (heavy: helical grooves,
 * so they're in a file of their own): the bolt, nut and washer set — and that a printed bolt and nut of the same size
 * turn with the printed fit between their threads, but run into each other with no fit — the screw-top jar, whose
 * lid screws on, and the threaded standoff.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { ISO_COARSE, maxGrooveDepth, threadDepth } from "../src/kernel/thread";
import type { PartMesh } from "../src/kernel/protocol";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { boltSetLayout, boltSetSizes, RELIEF } from "../src/library/designs/boltSet";
import { hexArea, ISO_COARSE_PITCH } from "../src/library/designs/boltSizes";
import { jarSizes, jarVolumes } from "../src/library/designs/jar";
import { standoffVolume } from "../src/library/designs/standoff";
import { varsOf } from "../src/library/designs/common";
import { grooveDepth, PRINTED_DEPTH } from "../src/library/printKit";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

/** These build helical grooves turn by turn and clash-check threaded parts: give each test plenty of time. */
const SLOW = 400_000;
const valuesOf = (id: string, values: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...values });
const insert = (id: string, values: DesignValues = {}) => insertDesign(emptyDocument(), findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
const setVar = (doc: JuraCADDocument, name: string, value: string) => applyVariables(doc, doc.variables!.map((v) => (v.name === name ? { ...v, value } : v)));

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  return { parts: r.parts, volumes: Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0])) };
}

function box(p: PartMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.vertices.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p.vertices[i + k])), (max[k] = Math.max(max[k], p.vertices[i + k]));
  return { min, max };
}
const partEnding = (parts: PartMesh[], end: string) => parts.find((p) => p.id.endsWith(end))!;
type Quat = [number, number, number, number];
const ID: Quat = [0, 0, 0, 1];

/** The volume two parts share, the second moved by `shift` (after turning it by `turn`). */
function shared(a: PartMesh, b: PartMesh, shift: [number, number, number], turn: Quat = ID): number {
  const found = engine.clashes(
    [
      { id: "a", partId: a.id, name: a.name, position: [0, 0, 0], rotation: ID },
      { id: "b", partId: b.id, name: b.name, position: shift, rotation: turn },
    ],
    0.001,
    false,
  );
  return found.reduce((n, c) => n + (c.volume ?? 0), 0);
}

/** Overlaps at `steps` heights through one pitch, from `from` up: a nut screwed on somewhere in its turn. */
const throughOneTurn = (overlapAt: (z: number) => number, from: number, pitch: number, steps: number) => Array.from({ length: steps }, (_, k) => overlapAt(from + (k / steps) * pitch));

/** The height in one turn (from `from`) where the overlap is least: ten steps through the turn, then narrowed down round the best. */
function lowest(overlapAt: (z: number) => number, from: number, pitch: number): number {
  const step = pitch / 10;
  const coarse = throughOneTurn(overlapAt, from, pitch, 10);
  const best = from + coarse.indexOf(Math.min(...coarse)) * step;
  let [lo, hi] = [best - step, best + step];
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo);
  let b = lo + g * (hi - lo);
  let fa = overlapAt(a);
  let fb = overlapAt(b);
  for (let i = 0; i < 9; i++) {
    if (fa < fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - g * (hi - lo);
      fa = overlapAt(a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + g * (hi - lo);
      fb = overlapAt(b);
    }
  }
  return fa < fb ? a : b;
}

describe("the printed thread's sizes", () => {
  it("uses the engine's coarse pitches, and a groove that still leaves a flat on each tooth", () => {
    expect(ISO_COARSE_PITCH).toEqual(ISO_COARSE);
    for (const [, P] of ISO_COARSE) {
      expect(grooveDepth(P)).toBeLessThanOrEqual(maxGrooveDepth(P));
      expect(grooveDepth(P)).toBeGreaterThan(threadDepth(P, true));
    }
    expect(maxGrooveDepth(1)).toBeCloseTo(0.7578, 4);
    expect(PRINTED_DEPTH).toBe(0.75);
  });

  it("the Thread feature cuts a deeper groove when given one (0 = the standard depth), up to the deepest that leaves a flat", () => {
    const rod = feature("cylinder", { diameter: 10, height: 12, x: 0, y: 0, z: 0 });
    const first = engine.rebuild([rod]);
    const plain = engine.check("normal").parts[0].exactVolume!;
    const side = { partId: rod.id, ref: first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")! };
    const removed = (depth: string) => {
      const thread = { ...feature("thread", { pitch: 1.5, length: 0, depth }), picks: [side] };
      const r = engine.rebuild([rod, thread]);
      expect(r.featureErrors).toEqual({});
      const c = engine.check("normal").parts[0];
      expect(c.geometryValid).toBe(true);
      return plain - c.exactVolume!;
    };
    const standard = removed("0");
    const deep = removed(String(grooveDepth(1.5)));
    // The V's area grows with the square of its depth.
    expect(deep / standard).toBeGreaterThan(((0.75 / 0.6134) ** 2) * 0.85);
    expect(deep / standard).toBeLessThan(((0.75 / 0.6134) ** 2) * 1.15);
    // Deeper than that is held to the deepest that leaves a flat on each tooth.
    expect(removed("5")).toBeCloseTo(removed(String(maxGrooveDepth(1.5))), 3);
  }, SLOW);
});

describe("bolt, nut and washer set", () => {
  const L = 12;
  const v = valuesOf("bolt-set", { length: L });
  const f = boltSetLayout(v).f;

  it(
    "makes an M8 bolt standing on its head, a nut and a washer beside it, all on the bed, with threads cut",
    () => {
      const r = build(insert("bolt-set", { length: L }));
      expect(r.parts).toHaveLength(3);
      const [bolt, nut, washer] = ["_bolt", "_nut", "_washer"].map((e) => partEnding(r.parts, e));
      for (const p of r.parts) expect(box(p).min[2]).toBeCloseTo(0, 4);
      expect(box(bolt).max[2]).toBeCloseTo(f.head + L, 3);
      expect(box(nut).max[2]).toBeCloseTo(f.nut, 3);
      expect(box(washer).max[2]).toBeCloseTo(f.washerThickness, 4);
      const lay = boltSetLayout(v);
      expect((box(nut).min[0] + box(nut).max[0]) / 2).toBeCloseTo(lay.x.nut, 1);
      // Nothing overlaps on the bed.
      expect(box(nut).min[0]).toBeGreaterThan(box(bolt).max[0]);
      expect(box(washer).min[0]).toBeGreaterThan(box(nut).max[0]);
      expect(r.volumes[washer.id]).toBeCloseTo(Math.PI * ((f.washerOd / 2) ** 2 - (f.washerHole / 2) ** 2) * f.washerThickness, 2);
      // Bolt: head + rod, less the run-out above the head and the thread's groove (a 60° V of the printed depth, round the rod).
      const s = boltSetSizes(v);
      const D = grooveDepth(f.pitch);
      const relief = RELIEF * f.pitch;
      const core = s.rod - 2 * D;
      const plain = hexArea(f.flats) * f.head + Math.PI * (s.rod / 2) ** 2 * L - Math.PI * ((s.rod / 2) ** 2 - (core / 2) ** 2) * relief;
      const groove = D * D * Math.tan(Math.PI / 6) * 2 * Math.PI * (s.rod / 2 - D / 3) * ((L - relief) / f.pitch);
      expect(r.volumes[bolt.id]).toBeLessThan(plain - 0.8 * groove);
      expect(r.volumes[bolt.id]).toBeGreaterThan(plain - 1.2 * groove);
      // Nut: the hex less its hole, less the groove round the hole.
      const nutPlain = (hexArea(f.flats) - Math.PI * (s.hole / 2) ** 2) * f.nut;
      expect(r.volumes[nut.id]).toBeLessThan(nutPlain - 10);
      expect(r.volumes[nut.id]).toBeGreaterThan(nutPlain - 1.4 * D * D * Math.tan(Math.PI / 6) * 2 * Math.PI * (s.hole / 2 + D / 3) * (f.nut / f.pitch));
    },
    SLOW,
  );

  /** The bolt and nut at this printed fit, and the overlap with the nut screwed onto the bolt at height z (its bottom). */
  function screwedOn(fit: string) {
    const r = build(setVar(insert("bolt-set", { length: L, washers: 0 }), "bolts_fit", fit));
    const [bolt, nut] = ["_bolt", "_nut"].map((e) => partEnding(r.parts, e));
    const x = boltSetLayout(v).x.nut;
    return (z: number) => shared(bolt, nut, [-x, 0, z]);
  }
  const from = f.head + RELIEF * f.pitch + 0.2;

  it(
    "with a 0.2 mm printed fit the nut turns on the bolt: there's a place in each turn where they don't touch, with room either way",
    () => {
      const at = screwedOn("0.2");
      const overlaps = throughOneTurn(at, from, f.pitch, 10);
      const free = overlaps.flatMap((o, k) => (o < 0.001 ? [from + (k / 10) * f.pitch] : []));
      // 0.2 mm square to the sloping sides is 0.2 / cos 30° = 0.23 mm along the bolt each way: 0.46 mm free in each 1.25 mm turn.
      expect(free.length).toBeGreaterThanOrEqual(2);
      expect(free.length).toBeLessThanOrEqual(5);
      const z = free.reduce((n, x) => n + x, 0) / free.length;
      const play = (0.6 * 0.2) / Math.cos(Math.PI / 6);
      expect(at(z)).toBeLessThan(0.001);
      expect(at(z + play)).toBeLessThan(0.001);
      expect(at(z - play)).toBeLessThan(0.001);
      // … but the threads do hold: half a turn on, the nut's thread runs into the bolt's.
      expect(at(z + f.pitch / 2)).toBeGreaterThan(1);
    },
    SLOW,
  );

  it(
    "with no fit the threads only just touch (any nudge runs them together), and with less than none they always overlap",
    () => {
      const touching = screwedOn("0");
      // Where in the turn they come closest (the thread's start can fall anywhere round, so it's looked for).
      const z = lowest(touching, from, f.pitch);
      expect(touching(z)).toBeLessThan(0.05);
      expect(touching(z + 0.06)).toBeGreaterThan(0.1);
      expect(touching(z - 0.06)).toBeGreaterThan(0.1);
      const tight = screwedOn("-0.1");
      expect(Math.min(...throughOneTurn(tight, from, f.pitch, 10))).toBeGreaterThan(1);
    },
    SLOW,
  );

  it(
    "put into a Part Studio that already has a part, leaves that part alone",
    () => {
      const alone = build(insert("bolt-set", { length: L }));
      const theirs = Object.values(alone.volumes).reduce((n, x) => n + x, 0);
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "200", depth: "200", height: "10", x: "-100", y: "-100", z: "-2" } }] };
      doc = insertDesign(doc, findDesign("bolt-set")!, v, { into: MAIN_STUDIO }).doc;
      const r = build(doc);
      expect(r.volumes.mine).toBeCloseTo(200 * 200 * 10, 3);
      expect(r.parts).toHaveLength(4);
      expect(Object.entries(r.volumes).filter(([id]) => id !== "mine").reduce((n, [, x]) => n + x, 0)).toBeCloseTo(theirs, 2);
    },
    SLOW,
  );
});

describe("screw-top jar", () => {
  it(
    "makes the jar and its lid (upside down beside it) on the bed, and the lid screws on with room to turn",
    () => {
      const v = valuesOf("jar");
      const r = build(insert("jar"));
      expect(r.parts).toHaveLength(2);
      const [jarPart, lid] = ["_jar", "_lid"].map((e) => partEnding(r.parts, e));
      const s = jarSizes(varsOf(v, ["inside", "height", "wall", "neck", "fit"]), 3);
      const j = box(jarPart);
      const l = box(lid);
      expect(j.min[2]).toBeCloseTo(0, 4);
      expect(l.min[2]).toBeCloseTo(0, 4);
      expect(j.max[2]).toBeCloseTo(70, 3);
      expect(l.max[2]).toBeCloseTo(s.lidHeight.v, 3);
      // Flush: the lid is as wide as the jar (the view's mesh of a round part sits a few µm inside it).
      expect(j.max[0] - j.min[0]).toBeCloseTo(2 * s.rLid.v, 1);
      expect(l.max[0] - l.min[0]).toBeCloseTo(2 * s.rLid.v, 1);
      expect(l.min[0] - j.max[0]).toBeCloseTo(10, 1);
      // Threads cut: a little less than the plain revolved profiles.
      const plain = jarVolumes(v);
      expect(r.volumes[jarPart.id]).toBeLessThan(plain.jar - 100);
      expect(r.volumes[jarPart.id]).toBeGreaterThan(plain.jar * 0.9);
      expect(r.volumes[lid.id]).toBeLessThan(plain.lid - 100);
      expect(r.volumes[lid.id]).toBeGreaterThan(plain.lid * 0.85);
      // Turned over onto the jar (rim height z), somewhere in each turn it touches nothing …
      const dx = (l.min[0] + l.max[0]) / 2;
      const on = (z: number) => shared(jarPart, lid, [-dx, 0, z + s.lidHeight.v], [1, 0, 0, 0]);
      const overlaps = throughOneTurn(on, s.shoulder.v + 2, 3, 8);
      expect(Math.min(...overlaps)).toBeLessThan(0.001);
      expect(Math.max(...overlaps)).toBeGreaterThan(1);
      // … and pushed down past the shoulder it runs into the jar.
      expect(on(s.shoulder.v - 1)).toBeGreaterThan(1);
    },
    SLOW,
  );
});

describe("hex standoff with a modelled thread", () => {
  it(
    "cuts the thread right through, leaving a sound part",
    () => {
      const v = valuesOf("standoff", { size: "M8", hole: "thread" });
      const r = build(insert("standoff", { size: "M8", hole: "thread" }));
      expect(r.parts).toHaveLength(1);
      const vol = Object.values(r.volumes)[0];
      expect(vol).toBeLessThan(standoffVolume(v) - 50);
      expect(vol).toBeGreaterThan(standoffVolume(v) * 0.8);
      expect(box(r.parts[0]).max[2]).toBeCloseTo(20, 4);
    },
    SLOW,
  );
});
