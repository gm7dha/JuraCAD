/**
 * The casting moulds built with the real geometry engine (their own file, for OCCT memory): sound parts of exactly
 * the volume worked out in the pure code, flat on the bed; the pillar candle's halves meeting on the split face with
 * nothing overlapping and their pegs free in their holes by the fit (but not past it); a pot's core sitting on its
 * shell leaving exactly the wall (probe boxes), the draft making each cast narrower towards its closed end, and a
 * user's part left alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { lit } from "../src/library/ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../src/library/sketchKit";
import { levelPlane } from "../src/library/printKit";
import { HALF_GAP, PEG, pillarPlan, pillarVolumes, wickBarVolume } from "../src/library/designs/candleMould";
import { meltTrayVolume } from "../src/library/designs/meltTray";
import { cupVolumes, dishPlan, holderPlan, insideAt, LIP, potPlan, type CupPlan } from "../src/library/designs/castMoulds";
import { apothemAt } from "../src/library/designs/mouldSurface";
import { loadOpenCascade } from "./support/engineHelpers";

type Quat = [number, number, number, number];
type V3 = [number, number, number];
const ID: Quat = [0, 0, 0, 1];
/** Half a turn about x. */
const OVER: Quat = [1, 0, 0, 0];

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

const valuesOf = (id: string, values: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...values });
const insertInto = (doc: JuraCADDocument, id: string, values: DesignValues = {}) => insertDesign(doc, findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
const insert = (id: string, values: DesignValues = {}) => insertInto(emptyDocument(), id, values);
const withFeatures = (doc: JuraCADDocument, more: Feature[]): JuraCADDocument => ({ ...doc, features: [...doc.features, ...more] });

function build(doc: JuraCADDocument) {
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid).toBe(true);
  const volumes = Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0]));
  return { parts: r.parts, volumes };
}

function box(p: PartMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.vertices.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p.vertices[i + k])), (max[k] = Math.max(max[k], p.vertices[i + k]));
  return { min, max };
}
const partEnding = (parts: PartMesh[], end: string) => parts.find((p) => p.id.endsWith(end))!;
/** Close relative to the size (OpenCascade's exact volumes agree with the maths to about a millionth). */
const near = (got: number, want: number) => expect(Math.abs(got - want) / want).toBeLessThan(2e-5);

/** The volume shared by the parts, each turned (about the world origin) and then moved as given. */
function shared(...placed: { part: PartMesh; position?: V3; rotation?: Quat }[]): number {
  const found = engine.clashes(
    placed.map((p, i) => ({ id: `i${i}`, partId: p.part.id, name: p.part.name, position: p.position ?? [0, 0, 0], rotation: p.rotation ?? ID })),
    0.001,
    false,
  );
  return found.reduce((n, c) => n + (c.volume ?? 0), 0);
}

/** A plain box (a probe), as a user would draw it. */
function boxPart(id: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Feature[] {
  return [
    sketchFeature(`${id}-s`, `${id} sketch`, levelPlane(`${z0} up`, z0), shapesSketch([{ type: "rectangle", corner: [String(x0), String(y0)], width: String(x1 - x0), height: String(y1 - y0) }], {})),
    extrudeFeature(id, id, `${id}-s`, { depth: lit(z1 - z0), operation: "new" }),
  ];
}
/** A thin disc (a probe). */
function discPart(id: string, z: number, d: number): Feature[] {
  return [sketchFeature(`${id}-s`, `${id} sketch`, levelPlane(`${z} up`, z), shapesSketch([{ type: "circle", center: ["0", "0"], diameter: String(d) }], {})), extrudeFeature(id, id, `${id}-s`, { depth: lit(0.4), operation: "new" })];
}

describe("every mould", () => {
  const cases: [string, DesignValues, (v: DesignValues) => Record<string, number>][] = [
    ["pillar-candle-mould", {}, (v) => ({ "half-a": pillarVolumes(v).a!, "half-b": pillarVolumes(v).b! })],
    ["pillar-candle-mould", { shape: "square" }, (v) => ({ "half-a": pillarVolumes(v).a!, "half-b": pillarVolumes(v).b! })],
    ["pillar-candle-mould", { pattern: "ribs" }, (v) => ({ "half-a": pillarVolumes(v).a!, "half-b": pillarVolumes(v).b! })],
    ["pillar-candle-mould", { master: true, shape: "barrel", pattern: "dots" }, (v) => ({ master: pillarVolumes(v).cast })],
    ["wick-bar", {}, (v) => ({ bar: wickBarVolume(v) })],
    ["wax-melt-tray", {}, (v) => ({ tray: meltTrayVolume(v) })],
    ["wax-melt-tray", { shape: "heart", columns: 2, rows: 1 }, (v) => ({ tray: meltTrayVolume(v) })],
    ["concrete-pot-mould", {}, (v) => vols(potPlan(v))],
    ["concrete-pot-mould", { shape: "hexagon", pattern: "waves" }, (v) => vols(potPlan(v))],
    ["concrete-pot-mould", { shape: "stepped", drain: false }, (v) => vols(potPlan(v))],
    ["concrete-holder-mould", {}, (v) => vols(holderPlan(v))],
    ["concrete-holder-mould", { shape: "dome", height: 30 }, (v) => vols(holderPlan(v))],
    ["trinket-dish-mould", { shape: "hexagon", centre: true }, (v) => vols(dishPlan(v))],
  ];
  function vols(p: CupPlan) {
    const v = cupVolumes(p);
    return { shell: v.shell, inner: v.inner };
  }
  for (const [id, extra, volume] of cases) {
    it(`${id}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}: sound parts of the expected volume, on the bed`, () => {
      const r = build(insert(id, extra));
      const want = volume(valuesOf(id, extra));
      expect(r.parts).toHaveLength(Object.keys(want).length);
      for (const [end, x] of Object.entries(want)) near(r.volumes[partEnding(r.parts, `_${end}`).id], x);
      for (const p of r.parts) expect(box(p).min[2]).toBeCloseTo(0, 4);
    });
  }
});

describe("pillar candle mould", () => {
  for (const extra of [{}, { shape: "square" }] as DesignValues[]) {
    it(`${JSON.stringify(extra)}: the halves meet on the split face without overlapping; the pegs are free in their holes by the fit`, () => {
      const v = valuesOf("pillar-candle-mould", extra);
      const p = pillarPlan(v);
      const r = build(insert("pillar-candle-mould", extra));
      const [a, b] = [partEnding(r.parts, "_half-a"), partEnding(r.parts, "_half-b")];
      // Half A on y ≥ 0 (its pegs reaching 3 mm past the split), half B beside it.
      expect(box(a).min[1]).toBeCloseTo(-3, 4);
      expect(box(b).max[1]).toBeCloseTo(-HALF_GAP + 3, 4);
      const back = (dx = 0, dz = 0): number => shared({ part: a }, { part: b, position: [dx, HALF_GAP, dz] });
      expect(back()).toBeLessThan(1e-3);
      // The holes are the fit bigger square to every face: free sliding 0.9 of it across (√2 × fit along x or z) …
      const free = 0.9 * p.fit * Math.SQRT2;
      for (const [dx, dz] of [[free, 0], [-free, 0], [0, free], [0, -free]]) expect(back(dx, dz)).toBeLessThan(1e-3);
      // … and hitting past it.
      const past = 1.3 * p.fit * Math.SQRT2;
      for (const [dx, dz] of [[past, 0], [-past, 0], [0, past]]) expect(back(dx, dz)).toBeGreaterThan(1e-3);
      // Pushed together they overlap (the halves really meet).
      expect(shared({ part: a }, { part: b, position: [0, HALF_GAP + 0.2, 0] })).toBeGreaterThan(1);
      expect(PEG).toBe(3);
    });
  }

  it("the candle inside is narrower towards its top (the closed end, on the bed): a disc that fits near the opening hits near the top", () => {
    const p = pillarPlan(valuesOf("pillar-candle-mould"));
    const fits = 2 * apothemAt(p.o, p.b, p.b.H - 5) - 0.2;
    const doc = withFeatures(insert("pillar-candle-mould"), [...discPart("high", p.end + p.b.H - 5, fits), ...discPart("low", p.end + 5, fits)]);
    const r = build(doc);
    const a = partEnding(r.parts, "_half-a");
    expect(shared({ part: a }, { part: partEnding(r.parts, "high") })).toBeLessThan(1e-3);
    expect(shared({ part: a }, { part: partEnding(r.parts, "low") })).toBeGreaterThan(0.1);
  });
});

describe("shell and core moulds", () => {
  /** Where the inner piece goes back onto its shell: turned back over its own middle and moved back from beside it. */
  function seated(inner: PartMesh, p: CupPlan): { rotation: Quat; position: V3 } {
    const b = box(inner);
    const printed: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const centre: V3 = [printed[0] - p.beside, printed[1], printed[2] + p.lowest];
    // p = OVER·(q − printed) + centre; OVER turns (x, y, z) to (x, −y, −z).
    return { rotation: OVER, position: [centre[0] - printed[0], centre[1] + printed[1], centre[2] + printed[2]] };
  }

  it("the pot's core sits on the shell's rim, leaving exactly the concrete wall all round and the floor below", () => {
    const v = valuesOf("concrete-pot-mould");
    const p = potPlan(v);
    const z = 60;
    const outside = apothemAt(p.o, p.b, z - p.wall);
    const inside = insideAt(p.o, p.b, 10, z - p.wall);
    const k = Math.tan((3 * Math.PI) / 180);
    expect(outside - inside).toBeCloseTo(10 * Math.sqrt(1 + k * k), 9);
    const probes = [
      ...boxPart("gap", inside + 0.05, -1, z - 0.5, outside - 0.05, 1, z + 0.5),
      ...boxPart("wide", inside - 0.1, -1, z - 0.5, outside + 0.1, 1, z + 0.5),
      // Under the core: between the shell's floor (z = wall) and the core's bottom (z = wall + floor), beside the drain pin.
      ...boxPart("under", 15, -1, p.wall + 0.05, 25, 1, p.wall + 12 - 0.05),
      ...boxPart("under-tall", 15, -1, p.wall - 0.1, 25, 1, p.wall + 12 + 0.1),
    ];
    const r = build(withFeatures(insert("concrete-pot-mould"), probes));
    const shell = partEnding(r.parts, "_shell");
    const core = { part: partEnding(r.parts, "_inner"), ...seated(partEnding(r.parts, "_inner"), p) };
    expect(shared({ part: shell }, core)).toBeLessThan(1e-3);
    // Seated: the flange on the rim (lifted 0.1 it's clear, lowered 0.1 it hits).
    expect(shared({ part: shell }, { ...core, position: [core.position[0], core.position[1], core.position[2] - 0.1] })).toBeGreaterThan(1e-3);
    for (const [name, free] of [["gap", true], ["wide", false], ["under", true], ["under-tall", false]] as const) {
      const probe = { part: partEnding(r.parts, name) };
      const hits = shared({ part: shell }, probe) + shared(core, probe);
      if (free) expect(hits).toBeLessThan(1e-3);
      else expect(shared({ part: shell }, probe)).toBeGreaterThan(1e-3), expect(shared(core, probe)).toBeGreaterThan(1e-3);
    }
    // The lip hangs round the outside of the shell's rim with the fit: moved sideways by less than it, no clash.
    expect(shared({ part: shell }, { ...core, position: [core.position[0] + 0.25, core.position[1], core.position[2]] })).toBeLessThan(1e-3);
    expect(LIP).toBeGreaterThan(3);
  });

  for (const [id, extra] of [
    ["concrete-pot-mould", { shape: "hexagon", pattern: "waves" }],
    ["concrete-holder-mould", { shape: "dome", height: 30 }],
    ["trinket-dish-mould", {}],
  ] as [string, DesignValues][]) {
    it(`${id} ${JSON.stringify(extra)}: the cast narrows towards its closed end, so it slides out of the shell`, () => {
      const v = valuesOf(id, extra);
      const p = id === "concrete-pot-mould" ? potPlan(v) : id === "concrete-holder-mould" ? holderPlan(v) : dishPlan(v);
      const zHigh = p.b.H - 2;
      const zLow = Math.min(5, p.b.H / 4);
      // A disc as big as fits at a level near the opening (the shape's plain half-width; patterns only stand out) …
      const fits = 2 * Math.min(apothemAt(p.o, p.b, zHigh), apothemAt(p.o, p.b, zHigh)) - 0.2;
      const r = build(withFeatures(insert(id, extra), [...discPart("high", p.wall + zHigh, fits), ...discPart("low", p.wall + zLow, fits)]));
      const shell = partEnding(r.parts, "_shell");
      expect(shared({ part: shell }, { part: partEnding(r.parts, "high") })).toBeLessThan(1e-3);
      // … is too big lower down.
      expect(shared({ part: shell }, { part: partEnding(r.parts, "low") })).toBeGreaterThan(0.1);
    });
  }
});

describe("a user's part", () => {
  it("is left alone when moulds are put into its Part Studio on top of it", () => {
    let doc: JuraCADDocument = { ...emptyDocument(), features: boxPart("user", -40, -40, 0, 40, 40, 30) };
    for (const id of ["pillar-candle-mould", "wax-melt-tray", "concrete-pot-mould", "wick-bar"]) doc = insertInto(doc, id);
    const r = build(doc);
    expect(r.volumes.user).toBeCloseTo(80 * 80 * 30, 3);
    expect(r.parts).toHaveLength(7);
  });
});
