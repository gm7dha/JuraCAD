/**
 * The third batch of 3D-printing designs built with the real geometry engine: Gridfinity (a bin's foot drops into a
 * baseplate's cell with the standard gap and no more, and bins stack), the name plate, battery organiser, spool
 * holder, headphone hook, plant pot (it stands in its saucer with a gap all round), bag clip (the rod sits in the clip
 * with room for the bag, and the lips hold it), thumb knob (its pocket takes the nut), hose adapter and SD card holder —
 * sound solids of the expected volume, flat on the bed, following their variables, and a user's part left alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { createFeature, emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues, LibraryDesign } from "../src/library/types";
import { lit } from "../src/library/ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../src/library/sketchKit";
import { levelPlane } from "../src/library/printKit";
import { varsOf } from "../src/library/designs/common";
import { baseplateVolume, binPlan, binVolume, CENTRED, GRID, RESTS, UNIT } from "../src/library/designs/gridfinity";
import { signVolumes } from "../src/library/designs/sign";
import { batteryVolume } from "../src/library/designs/batteryHolder";
import { spoolHolderVolume } from "../src/library/designs/spoolHolder";
import { headphoneVolume } from "../src/library/designs/headphoneHook";
import { potSizes, potVolumes, SAUCER } from "../src/library/designs/plantPot";
import { CLIP_GAP, clipSizes, clipVolumes } from "../src/library/designs/bagClip";
import { pocketDepth, thumbKnobVolume } from "../src/library/designs/thumbKnob";
import { printFastener } from "../src/library/designs/boltSizes";
import { adapterVolume } from "../src/library/designs/hoseAdapter";
import { cardHolderVolume } from "../src/library/designs/cardHolder";
import { blockContours, fontOf, inkArea, linesOf } from "../src/library/textKit";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

const valuesOf = (id: string, values: DesignValues = {}) => ({ ...defaultValues(findDesign(id)!), ...values });
const insertInto = (doc: JuraCADDocument, d: LibraryDesign, values: DesignValues) => insertDesign(doc, d, { ...defaultValues(d), ...values }, { into: MAIN_STUDIO }).doc;
const insert = (id: string, values: DesignValues = {}) => insertInto(emptyDocument(), findDesign(id)!, values);
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

/** The volume shared by the parts, each moved as given. */
function shared(...placed: { part: PartMesh; position?: [number, number, number] }[]): number {
  const found = engine.clashes(
    placed.map((p, i) => ({ id: `i${i}`, partId: p.part.id, name: p.part.name, position: p.position ?? [0, 0, 0], rotation: [0, 0, 0, 1] as [number, number, number, number] })),
    0.001,
    false,
  );
  return found.reduce((n, c) => n + (c.volume ?? 0), 0);
}

const ink = (v: DesignValues) => inkArea(blockContours({ font: fontOf(v), capHeight: v.height as number, lines: linesOf(v.words) }));

describe("Gridfinity", () => {
  it("baseplates of 1 × 1 and 3 × 2 cells: one sound part, 42 mm a cell and 5 mm high", () => {
    for (const extra of [{ across: 1, along: 1 }, { across: 3, along: 2 }]) {
      const r = build(insert("gridfinity-baseplate", extra));
      expect(r.parts).toHaveLength(1);
      expect(r.volume).toBeCloseTo(baseplateVolume(valuesOf("gridfinity-baseplate", extra)), 1);
      const b = box(r.parts[0]);
      expect(b.max[0] - b.min[0]).toBeCloseTo(GRID * extra.across, 3);
      expect(b.max[1] - b.min[1]).toBeCloseTo(GRID * extra.along, 3);
      expect(b.max[2]).toBeCloseTo(5, 4);
      onTheBed(r.parts);
    }
  });

  const bins: DesignValues[] = [{}, { across: 1, along: 1 }, { across: 2, along: 2, units: 4, dividers: 2, label: true, magnets: true }, { lip: false, across: 1, along: 3 }, { wall: 2, floor: 1, dividers: 1 }];
  for (const extra of bins) {
    it(`bin ${JSON.stringify(extra)}: one sound part of the expected volume and size`, () => {
      const v = valuesOf("gridfinity-bin", extra);
      const p = binPlan(v);
      const r = build(insert("gridfinity-bin", extra));
      expect(r.parts).toHaveLength(1);
      expect(r.volume).toBeCloseTo(binVolume(v), 1);
      const b = box(r.parts[0]);
      // 42 × cells − 0.5 across, 7 × units to the wall's top, plus the 4.4 mm lip.
      expect(b.max[0] - b.min[0]).toBeCloseTo(GRID * p.w - 0.5, 3);
      expect(b.max[1] - b.min[1]).toBeCloseTo(GRID * p.d - 0.5, 3);
      expect(b.max[2]).toBeCloseTo(UNIT * p.units + (p.lip ? 4.4 : 0), 4);
      onTheBed(r.parts);
    });
  }

  /** A baseplate and a bin in one Part Studio (the bin made in its own, then both measured together). */
  function plateAndBin(plate: DesignValues, bin: DesignValues, binDesign: LibraryDesign = findDesign("gridfinity-bin")!) {
    let doc = insert("gridfinity-baseplate", plate);
    doc = insertInto(doc, binDesign, bin);
    const r = build(doc);
    return { plate: partEnding(r.parts, "_plate"), bin: partEnding(r.parts, "_bin") };
  }

  it("a bin's feet drop into a baseplate's cells with the standard 0.25 mm to spare, and no more", () => {
    const { plate, bin } = plateAndBin({ across: 1, along: 1 }, { across: 1, along: 1 });
    const inCell = (dx: number, dz = CENTRED) => shared({ part: plate }, { part: bin, position: [dx, 0, dz] });
    // Resting in the cell (its bottom level with the plate's) its slopes just touch the pocket's: any lower and they overlap.
    expect(inCell(0, RESTS)).toBeLessThan(0.001);
    expect(inCell(0, RESTS - 0.02)).toBeGreaterThan(0.001);
    // Held half-way up the pocket's straight part, it has the gap every way: it touches nothing — nor moved 0.2 mm sideways …
    expect(inCell(0)).toBeLessThan(0.001);
    expect(inCell(0.2)).toBeLessThan(0.001);
    expect(shared({ part: plate }, { part: bin, position: [0, -0.2, CENTRED] })).toBeLessThan(0.001);
    // … but 0.3 mm (past the gap) runs it into the cell's sides, and so does pushing it 0.5 mm lower.
    expect(inCell(0.3)).toBeGreaterThan(0.001);
    expect(inCell(0, CENTRED - 0.5)).toBeGreaterThan(0.01);
  });

  it("a 2 × 1 bin sits across two cells of a 3 × 3 baseplate, and a bin made 0.3 mm bigger doesn't fit", () => {
    const { plate, bin } = plateAndBin({}, { across: 2, along: 1 });
    expect(shared({ part: plate }, { part: bin, position: [GRID / 2, GRID, CENTRED] })).toBeLessThan(0.001);
    // Half a cell off, the feet land on the walls between cells.
    expect(shared({ part: plate }, { part: bin, position: [0, GRID, CENTRED] })).toBeGreaterThan(1);
    // The gap each side made −0.15 instead of 0.25 (allowed here only for the test): it no longer drops in.
    const loose = findDesign("gridfinity-bin")!;
    const bigger: LibraryDesign = { ...loose, inputs: loose.inputs.map((i) => (i.key === "fit" ? { ...i, min: -1 } : i)) };
    const big = plateAndBin({}, { across: 2, along: 1, fit: -0.15 }, bigger);
    expect(shared({ part: big.plate }, { part: big.bin, position: [GRID / 2, GRID, CENTRED] })).toBeGreaterThan(0.01);
  });

  it("bins stack: one sits in the lip of another, held sideways and level", () => {
    let doc = insert("gridfinity-bin", { across: 2, along: 1, dividers: 1, label: true });
    doc = insertInto(doc, findDesign("gridfinity-bin")!, { across: 2, along: 1 });
    const r = build(doc);
    const [lower, upper] = r.parts;
    const top = UNIT * 3;
    const on = (dx: number, dz: number) => shared({ part: lower }, { part: upper, position: [dx, 0, dz] });
    expect(on(0, top)).toBeLessThan(0.001);
    expect(on(0.2, top)).toBeLessThan(0.001);
    expect(on(0.3, top)).toBeGreaterThan(0.001);
    expect(on(0, top - 0.5)).toBeGreaterThan(0.01);
    // Lifted off, nothing touches.
    expect(on(0, top + 5)).toBeLessThan(0.001);
  });
});

describe("the other new designs", () => {
  const cases: [string, DesignValues, (v: DesignValues) => number | Record<string, number>][] = [
    ["sign", {}, (v) => signVolumes(v, ink(v))],
    ["sign", { style: "recessed", mount: "holes", width: 160 }, (v) => signVolumes(v, ink(v))],
    ["sign", { mount: "stand", border: false, words: "Hi\nthere", height: 8, plate: 50 }, (v) => signVolumes(v, ink(v))],
    ["battery-holder", {}, batteryVolume],
    ["battery-holder", { cell: "18650", columns: 3, rows: 3, depth: 25 }, batteryVolume],
    ["battery-holder", { cell: "custom", diameter: 12, columns: 1, rows: 4 }, batteryVolume],
    ["spool-holder", {}, spoolHolderVolume],
    ["headphone-hook", {}, headphoneVolume],
    ["plant-pot", {}, potVolumes],
    ["plant-pot", { top: 80, bottom: 80, holes: 4 }, potVolumes],
    ["bag-clip", {}, clipVolumes],
    ["thumb-knob", {}, thumbKnobVolume],
    ["thumb-knob", { size: "M3", holds: "head", diameter: 16 }, thumbKnobVolume],
    ["thumb-knob", { size: "M8", diameter: 36, height: 12 }, thumbKnobVolume],
    ["hose-adapter", {}, adapterVolume],
    ["hose-adapter", { a: 50, aFits: "over", b: 50, bFits: "over" }, adapterVolume],
    ["card-holder", {}, cardHolderVolume],
    ["card-holder", { card: "micro", count: 12 }, cardHolderVolume],
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

  it("the plant pot stands on the saucer's ribs with the gap all round, and lifts straight out", () => {
    const v = valuesOf("plant-pot");
    const s = potSizes(varsOf(v, ["top", "bottom", "height", "wall", "floor", "gap", "saucer"]));
    const r = build(insert("plant-pot"));
    const [pot, saucer] = ["_pot", "_saucer"].map((e) => partEnding(r.parts, e));
    const across = s.rt.v + s.saucerOut.v + SAUCER.apart;
    const inSaucer = (dx: number, dz = s.standsAt.v) => shared({ part: saucer }, { part: pot, position: [across + dx, 0, dz] });
    expect(inSaucer(0)).toBeLessThan(0.001);
    // Room all round: most of the gap either way …
    expect(inSaucer(0.9 * s.saucerIn.v - 0.9 * s.atRim.v)).toBeLessThan(0.001);
    expect(inSaucer(-0.9 * (s.saucerIn.v - s.atRim.v))).toBeLessThan(0.001);
    // … then the rim; and it rests on the ribs (lower, and it runs into them).
    expect(inSaucer(s.saucerIn.v - s.atRim.v + 0.5)).toBeGreaterThan(0.01);
    expect(inSaucer(0, s.standsAt.v - 0.3)).toBeGreaterThan(0.01);
    expect(inSaucer(0, s.standsAt.v + 20)).toBeLessThan(0.001);
    // The holes go right through the floor: the pot is the profile less 7 holes' worth.
    expect(box(pot).max[2]).toBeCloseTo(95, 3);
  });

  it("the bag clip closes over its rod with room for the bag, touching nothing, and its lips hold the rod in", () => {
    const v = valuesOf("bag-clip");
    const s = clipSizes(v);
    const r = build(insert("bag-clip"));
    const [clip, rod] = ["_clip", "_rod"].map((e) => partEnding(r.parts, e));
    // The rod's flat on the clip's floor with the room under it: its middle then on the clip's.
    const seated = (dy: number, dz: number) => shared({ part: clip }, { part: rod, position: [0, s.outer + CLIP_GAP + s.r + dy, s.wall + s.room + dz] });
    expect(seated(0, 0)).toBeLessThan(0.001);
    expect(seated(0.2, 0)).toBeLessThan(0.001);
    expect(seated(-0.2, 0)).toBeLessThan(0.001);
    expect(seated(0, 0.2)).toBeLessThan(0.001);
    // Pulled out of the mouth, the rod's widest part runs into the lips: it's held.
    expect(seated(0, 1)).toBeGreaterThan(0.01);
    expect(seated(0, 3)).toBeGreaterThan(0.1);
    // The mouth is narrower than the rod by the lips' overlap on each side.
    expect(2 * s.r - s.opening).toBeCloseTo(3, 6);
  });

  it("the thumb knob's pocket takes its nut, flush with the top — and a nut 0.3 mm bigger doesn't fit", () => {
    for (const size of ["M3", "M5", "M8"]) {
      const v = valuesOf("thumb-knob", { size, diameter: 36, height: 12 });
      const f = printFastener(size);
      const depth = pocketDepth(v);
      const nut = (flats: number, id: string) => {
        const sk = sketchFeature(`${id}-sk`, "Nut sketch", levelPlane("nut", 12 - depth), shapesSketch([{ type: "polygon", center: ["0", "0"], sides: 6, diameter: String(flats), across: "flats" }], {}));
        return [sk, extrudeFeature(id, "Nut", sk.id, { depth: lit(depth), operation: "new" })];
      };
      let doc = insert("thumb-knob", { size, diameter: 36, height: 12 });
      doc = { ...doc, features: [...doc.features, ...nut(f.flats, "nut"), ...nut(f.flats + 2 * 0.1 + 0.3, "bignut")] };
      const r = build(doc);
      const knob = partEnding(r.parts, "_knob");
      const [small, big] = [r.parts.find((p) => p.id === "nut")!, r.parts.find((p) => p.id === "bignut")!];
      expect(shared({ part: knob }, { part: small })).toBeLessThan(0.001);
      expect(shared({ part: knob }, { part: big })).toBeGreaterThan(0.01);
      expect(box(small).max[2]).toBeCloseTo(12, 4);
    }
  });

  it("follows its variables: a taller pot, a wider spool, a thicker sign", () => {
    const pot = build(setVar(insert("plant-pot"), "pot_height", "120"));
    expect(pot.volumes[partEnding(pot.parts, "_pot").id]).toBeCloseTo(potVolumes(valuesOf("plant-pot", { height: 120 })).pot, 1);
    const spool = build(setVar(insert("spool-holder"), "spool_width", "90"));
    expect(spool.volume).toBeCloseTo(spoolHolderVolume(valuesOf("spool-holder", { width: 90 })), 1);
    const sign = build(setVar(insert("sign"), "sign_thickness", "4"));
    const v = valuesOf("sign", { thickness: 4 });
    expect(sign.volume).toBeCloseTo(signVolumes(v, ink(v)).plate, 1);
    expect(box(sign.parts[0]).max[2]).toBeCloseTo(4 + 1.2, 3);
  });
});

describe("put into a Part Studio that already has a part", () => {
  for (const id of ["gridfinity-baseplate", "gridfinity-bin", "sign", "battery-holder", "spool-holder", "headphone-hook", "plant-pot", "bag-clip", "thumb-knob", "hose-adapter", "card-holder"]) {
    it(`${id}: leaves the user's part alone, even where they overlap`, () => {
      const alone = build(insert(id));
      let doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...createFeature(emptyDocument(), "box"), id: "mine", params: { width: "300", depth: "300", height: "10", x: "-150", y: "-150", z: "-2" } }] };
      doc = insertInto(doc, findDesign(id)!, {});
      const r = build(doc);
      expect(r.volumes.mine).toBeCloseTo(300 * 300 * 10, 3);
      expect(r.parts).toHaveLength(alone.parts.length + 1);
      expect(r.volume - r.volumes.mine).toBeCloseTo(alone.volume, 2);
    });
  }
});
