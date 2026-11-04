/**
 * More of the Design library's 3D-printing designs built with the real geometry engine: the piano hinge (its parts
 * don't overlap, leaf 2 turns freely round the pin, its screw holes follow the leaves' thickness), the pegboard hook,
 * drawer pull, bit holder, cable grommet, corner protector and standoff — sound solids of the expected volume, flat
 * on the bed, and a user's part left alone. (The threaded designs are in engineLibraryThreads.)
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { pianoVolumes } from "../src/library/designs/pianoHinge";
import { pegHookVolume, pegPlaces } from "../src/library/designs/pegboardHook";
import { pullVolume } from "../src/library/designs/drawerPull";
import { bitHolderVolume } from "../src/library/designs/bitHolder";
import { grommetSizes, sleeveVolume } from "../src/library/designs/grommet";
import { cornerVolume } from "../src/library/designs/cornerGuard";
import { standoffVolume } from "../src/library/designs/standoff";
import { varsOf } from "../src/library/designs/common";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

const valuesOf = (id: string, values: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...values });
const insert = (id: string, values: DesignValues = {}) => insertDesign(emptyDocument(), findDesign(id)!, valuesOf(id, values), { into: MAIN_STUDIO }).doc;
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
type Quat = [number, number, number, number];
const ID: Quat = [0, 0, 0, 1];
const onTheBed = (parts: PartMesh[]) => parts.forEach((p) => expect(box(p).min[2]).toBeCloseTo(0, 4));

/** The volume shared by the parts, each placed (moved after turning) as given. */
function shared(...placed: { part: PartMesh; position?: [number, number, number]; rotation?: Quat }[]): number {
  const found = engine.clashes(
    placed.map((p, i) => ({ id: `i${i}`, partId: p.part.id, name: p.part.name, position: p.position ?? [0, 0, 0], rotation: p.rotation ?? ID })),
    0.001,
    false,
  );
  return found.reduce((n, c) => n + (c.volume ?? 0), 0);
}

describe("piano hinge", () => {
  it("makes two leaves with countersunk holes and a pin, of the expected volume, lying open on the bed", () => {
    const v = valuesOf("piano-hinge");
    const r = build(insert("piano-hinge"));
    expect(r.parts).toHaveLength(3);
    const want = pianoVolumes(v);
    const [leaf1, leaf2, pin] = ["_leaf1", "_leaf2", "_pin"].map((e) => partEnding(r.parts, e));
    expect(r.volumes[leaf1.id]).toBeCloseTo(want.leaf1, 0);
    expect(r.volumes[leaf2.id]).toBeCloseTo(want.leaf2, 0);
    expect(r.volumes[pin.id]).toBeCloseTo(want.pin, 1);
    onTheBed([leaf1, leaf2]);
    expect(box(leaf1).max[0]).toBeCloseTo(150, 3);
    expect(box(leaf1).min[1]).toBeCloseTo(-20, 3);
    expect(box(leaf2).max[1]).toBeCloseTo(20, 3);
  });

  it("its parts don't overlap, and leaf 2 turns all the way round the pin without touching leaf 1", () => {
    const t = 3;
    const r = build(insert("piano-hinge"));
    const [leaf1, leaf2, pin] = ["_leaf1", "_leaf2", "_pin"].map((e) => partEnding(r.parts, e));
    expect(shared({ part: leaf1 }, { part: leaf2 })).toBeLessThan(0.001);
    expect(shared({ part: leaf2 }, { part: pin })).toBeLessThan(0.001);
    // Turned about the pin's axis (along X, at the leaves' thickness above the bed), from open to folded flat.
    for (const deg of [30, 90, 135, 180]) {
      const a = (deg * Math.PI) / 180;
      const turned = { part: leaf2, rotation: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)] as Quat, position: [0, t * Math.sin(a), t - t * Math.cos(a)] as [number, number, number] };
      expect(shared({ part: leaf1 }, turned)).toBeLessThan(0.001);
      expect(shared({ part: pin }, turned)).toBeLessThan(0.001);
    }
    // Twice the clearance along the pin runs the knuckles into each other (so the check would see a clash).
    expect(shared({ part: leaf1 }, { part: leaf2, position: [0.8, 0, 0] })).toBeGreaterThan(0.1);
  });

  it("follows its variables: thicker leaves keep their screw holes sunk in the top faces", () => {
    const doc = setVar(insert("piano-hinge"), "piano_thickness", "4");
    const r = build(doc);
    const want = pianoVolumes(valuesOf("piano-hinge", { thickness: 4 }));
    expect(r.volumes[partEnding(r.parts, "_leaf1").id]).toBeCloseTo(want.leaf1, 0);
    expect(r.volumes[partEnding(r.parts, "_leaf2").id]).toBeCloseTo(want.leaf2, 0);
    expect(box(partEnding(r.parts, "_leaf1")).max[2]).toBeCloseTo(8, 1);
  });
});

describe("the other 3D printing designs", () => {
  const cases: [string, DesignValues, (v: DesignValues) => number][] = [
    ["drawer-pull", {}, pullVolume],
    ["drawer-pull", { span: 128, round: 0 }, pullVolume],
    ["bit-holder", {}, bitHolderVolume],
    ["bit-holder", { shape: "round", columns: 1, rows: 4 }, bitHolderVolume],
    ["corner-guard", {}, cornerVolume],
    ["standoff", {}, standoffVolume],
    ["standoff", { hole: "clear", size: "M6", length: 12 }, standoffVolume],
  ];
  for (const [id, extra, volume] of cases) {
    it(`${id}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}: one sound part of the expected volume, on the bed`, () => {
      const r = build(insert(id, extra));
      expect(r.parts).toHaveLength(1);
      expect(r.volume).toBeCloseTo(volume(valuesOf(id, extra)), 1);
      onTheBed(r.parts);
    });
  }

  describe("pegboard hook", () => {
    const pegVars = (v: DesignValues) => varsOf(v, ["spacing", "board", "peg", "lip", "hole", "length", "tip", "thickness", "width"]);
    /**
     * The hook and a board `board` thick with real round holes `hole` across, 25.4 mm apart: the board is made in the same
     * Part Studio as an upright plate with upright holes, and turned so its holes run along the pegs (−X), its front
     * against the hook's plate (x = 0) and the holes' middles level with the pegs'. The hook hangs on it — dropped, its
     * pegs on the bottoms of the holes. `overlap(dx, dy)` is the volume shared with the hook moved by (dx, dy).
     */
    function hung(values: DesignValues, hole: number) {
      const v = valuesOf("pegboard-hook", values);
      const at = pegPlaces(pegVars(v));
      const B = v.board as number;
      const p = v.peg as number;
      const plate = feature("box", { width: 80, depth: 90, height: B, x: -40, y: -30, z: 0 });
      const drop = (hole - p) / 2;
      const holes = [at.low.v, at.high.v].map((y) => feature("cylinder", { diameter: hole, height: B + 2, x: 0, y: y + drop, z: -1 }, "remove"));
      const doc = insertDesign({ ...emptyDocument(), features: [plate, ...holes] }, findDesign("pegboard-hook")!, v, { into: MAIN_STUDIO }).doc;
      const r = build(doc);
      const hook = partEnding(r.parts, "_hook");
      const board = r.parts.find((x) => x.id === plate.id)!;
      // Turned −90° about Y: the board's z (0 … B) runs along −X (0 … −B), its x becomes Z; raised to the pegs' middles.
      const s45 = Math.SQRT1_2;
      const overlap = (dx: number, dy: number) =>
        shared({ part: hook, position: [dx, dy, 0] }, { part: board, rotation: [0, -s45, 0, s45], position: [0, 0, at.z.v] });
      return { v, at, overlap, hook };
    }

    it("makes one sound part: the plate and arm, round pegs resting on the bed, and the lip", () => {
      const v = valuesOf("pegboard-hook");
      const r = build(insert("pegboard-hook"));
      expect(r.parts).toHaveLength(1);
      expect(r.volume).toBeCloseTo(pegHookVolume(v), 1);
      onTheBed(r.parts);
      const hook = r.parts[0];
      expect(box(hook).max[2]).toBeCloseTo(8, 4);
      // The pegs (everything behind the board's front, x < 0) lie on the bed: their undersides at z = 0, tops a peg up.
      let [lo, hi] = [Infinity, -Infinity];
      for (let i = 0; i < hook.vertices.length; i += 3) if (hook.vertices[i] < -0.01) (lo = Math.min(lo, hook.vertices[i + 2])), (hi = Math.max(hi, hook.vertices[i + 2]));
      expect(lo).toBeCloseTo(0, 2);
      expect(hi).toBeCloseTo(4.5, 2);
      const at = pegPlaces(pegVars(v));
      expect(box(hook).min[0]).toBeCloseTo(-at.topLength.v, 4);
    });

    for (const [hole, values] of [[6, {}], [6.35, {}], [6, { shape: "straight", board: 3.5 }]] as [number, DesignValues][]) {
      it(`hung on a board with ${hole} mm holes${values.board ? ` (${values.board} mm thick)` : ""}: it comes off by lifting, then pulling, touching nothing — and can't be pulled off without lifting`, () => {
        const { v, at, overlap } = hung(values, hole);
        const p = v.peg as number;
        const lip = v.lip as number;
        expect(overlap(0, 0)).toBeLessThan(0.001);
        // Lifted until peg and lip are in the middle of the hole, a step at a time …
        const lift = (hole - p + lip) / 2;
        for (const k of [1, 2, 3, 4]) expect(overlap(0, (lift * k) / 4)).toBeLessThan(0.001);
        // … then pulled straight out until it's clear of the board.
        for (let dx = 1; dx < at.topLength.v + 1; dx += 1) expect(overlap(dx, lift)).toBeLessThan(0.001);
        expect(overlap(at.topLength.v + 1, lift)).toBeLessThan(0.001);
        // Pulled without lifting, the lip runs into the back of the board.
        expect(overlap(1, 0)).toBeGreaterThan(0.01);
      });
    }
  });

  it("drawer pull: the screw holes go into the feet from the side against the door", () => {
    const r = build(insert("drawer-pull"));
    const b = box(r.parts[0]);
    expect(b.max[0] - b.min[0]).toBeCloseTo(96 + 12, 3);
    expect(b.min[1]).toBeCloseTo(0, 4);
    expect(b.max[1]).toBeCloseTo(32, 4);
  });

  it("cable grommet: the sleeve and its cap beside it, the cap's plug fitting inside the sleeve", () => {
    const v = valuesOf("grommet");
    const r = build(insert("grommet"));
    expect(r.parts).toHaveLength(2);
    const [sleeve, cap] = ["_sleeve", "_cap"].map((e) => partEnding(r.parts, e));
    expect(r.volumes[sleeve.id]).toBeCloseTo(sleeveVolume(v), 1);
    onTheBed(r.parts);
    const s = grommetSizes(varsOf(v, ["hole", "depth", "wall", "lip", "fit", "slot"]));
    // In use the sleeve hangs from its lip, and the cap drops in from the lip's side: as printed, that's the cap pushed
    // straight up under the sleeve, its top against the lip and its plug inside. It touches nothing else, with the fit
    // to spare round the plug …
    const capIn = (dx: number) => shared({ part: sleeve }, { part: cap, position: [-s.capAt.v + dx, 0, -2] });
    expect(capIn(0)).toBeLessThan(0.001);
    expect(capIn(0.25)).toBeLessThan(0.001);
    // … and pushed further sideways than that, the plug runs into the sleeve.
    expect(capIn(0.5)).toBeGreaterThan(0.01);
    expect(r.volumes[cap.id]).toBeGreaterThan(0);
  });
});

describe("put into a Part Studio that already has a part", () => {
  for (const id of ["piano-hinge", "pegboard-hook", "drawer-pull", "bit-holder", "grommet", "corner-guard", "standoff"]) {
    it(`${id}: leaves the user's part alone, even where they overlap`, () => {
      const alone = build(insert(id));
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "300", depth: "300", height: "10", x: "-150", y: "-150", z: "-2" } }] };
      const d = findDesign(id)!;
      doc = insertDesign(doc, d, defaultValues(d), { into: MAIN_STUDIO }).doc;
      const r = build(doc);
      expect(r.volumes.mine).toBeCloseTo(300 * 300 * 10, 3);
      expect(r.parts).toHaveLength(alone.parts.length + 1);
      expect(r.volume - r.volumes.mine).toBeCloseTo(alone.volume, 2);
    });
  }
});
