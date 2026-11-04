/**
 * The third batch of 3D-printing designs (Gridfinity baseplate and bin, name plate, battery organiser, spool holder,
 * headphone hook, plant pot and saucer, bag clip, thumb knob, hose adapter, SD card holder): the Gridfinity standard's
 * numbers and the fits they give, each design's maths and plain-English problems, every sketch fully defined, Edit
 * design sizes, the straight (ruled) Loft kept in the file, and finding them in the library. Pure — the geometry is
 * checked in engineLibraryPrint3.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, parseDocument } from "../src/model/document";
import { MAIN_STUDIO, studioFeatures } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { defaultValues, designGroups, editInsert, findDesign, GROUP_ORDER, insertDesign, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { freedomOf } from "../src/library/sketchKit";
import { levelPlane, loftFeature } from "../src/library/printKit";
import { varsOf } from "../src/library/designs/common";
import { BIN_GAP, binPlan, FOOT_HEIGHT, FOOT_STEPS, GRID, LIP_HEIGHT, PLATE_HEIGHT, PLATE_RADIUS, POCKET_STEPS, SEATED, stepsVolume, UNIT } from "../src/library/designs/gridfinity";
import { wordsRoom } from "../src/library/designs/sign";
import { cellDiameter, CELLS } from "../src/library/designs/batteryHolder";
import { armProfile } from "../src/library/designs/spoolHolder";
import { potSizes } from "../src/library/designs/plantPot";
import { clipSizes, FLAT_AT } from "../src/library/designs/bagClip";
import { KNOB_SIZES, knurlCount, pocketDepth } from "../src/library/designs/thumbKnob";
import { adapterSizes } from "../src/library/designs/hoseAdapter";
import { cardLayout } from "../src/library/designs/cardHolder";
import { printFastener } from "../src/library/designs/boltSizes";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const problems = (id: string, extra: DesignValues = {}) => valueProblems(design(id), valuesOf(id, extra));
const NEW = ["gridfinity-baseplate", "gridfinity-bin", "sign", "battery-holder", "spool-holder", "headphone-hook", "plant-pot", "bag-clip", "thumb-knob", "hose-adapter", "card-holder"];

/** Half the width of a stack's outline at height z (a rounded rectangle `half` across each way at inset 0). */
function halfAt(steps: { z: number; inset: number }[], half: number, z: number): number {
  for (let i = 0; i + 1 < steps.length; i++) {
    const [a, b] = [steps[i], steps[i + 1]];
    if (z >= a.z - 1e-9 && z <= b.z + 1e-9) return half - (a.inset + ((b.inset - a.inset) * (z - a.z)) / (b.z - a.z || 1));
  }
  throw new Error(`no step at ${z}`);
}

describe("Gridfinity's standard", () => {
  it("bins are 42 × n − 0.5 across with 3.75 mm corners; the foot steps 0.8 / 1.8 / 2.15 from 35.6 to 41.5 mm", () => {
    const p = binPlan(valuesOf("gridfinity-bin", { across: 3, along: 2 }));
    expect(p.outer).toEqual([125.5, 83.5]);
    expect(p.radius).toBe(3.75);
    expect(p.cell).toBe(41.5);
    expect(FOOT_STEPS.map((s) => s.z)).toEqual([0, 0.8, 2.6, 4.75]);
    expect(FOOT_STEPS.map((s) => s.inset)).toEqual([2.95, 2.15, 2.15, 0]);
    // 45° both slopes: each rises as far as it steps out.
    expect(FOOT_STEPS[1].z - FOOT_STEPS[0].z).toBeCloseTo(FOOT_STEPS[0].inset - FOOT_STEPS[1].inset, 9);
    expect(FOOT_STEPS[3].z - FOOT_STEPS[2].z).toBeCloseTo(FOOT_STEPS[2].inset - FOOT_STEPS[3].inset, 9);
    expect(41.5 - 2 * FOOT_STEPS[0].inset).toBeCloseTo(35.6, 9);
    expect(3.75 - FOOT_STEPS[0].inset).toBeCloseTo(0.8, 9);
    expect(FOOT_HEIGHT).toBe(4.75);
    expect(UNIT).toBe(7);
    expect(GRID).toBe(42);
  });

  it("the baseplate's pocket steps 0.7 / 1.8 / 2.15 above 0.35 mm, to 42 mm and 4 mm corners at the top, 5 mm high", () => {
    const at = (z: number) => halfAt(POCKET_STEPS, GRID / 2, z);
    expect(PLATE_HEIGHT).toBe(5);
    expect(PLATE_RADIUS).toBe(4);
    expect(at(0)).toBeCloseTo(18.15, 9);
    expect(at(0.35)).toBeCloseTo(18.15, 9);
    expect(at(1.05)).toBeCloseTo(18.85, 9);
    expect(at(2.85)).toBeCloseTo(18.85, 9);
    expect(at(5)).toBeCloseTo(21, 9);
    expect(PLATE_RADIUS - POCKET_STEPS[0].inset).toBeCloseTo(1.15, 9);
  });

  it("seated in a cell, the foot clears the pocket by the gap on the straight part and the same square to the slopes", () => {
    for (const gap of [0, BIN_GAP, 0.4]) {
      const foot = (z: number) => halfAt(FOOT_STEPS, GRID / 2 - gap, z - SEATED);
      const pocket = (z: number) => halfAt(POCKET_STEPS, GRID / 2, z);
      // The straight parts: exactly the gap.
      for (const z of [SEATED + 0.8, SEATED + 1.5, SEATED + 2.5]) expect(pocket(z) - foot(z)).toBeCloseTo(gap, 9);
      // The slopes: 0.1 mm more across, so (gap + 0.1)/√2 square to them — 0.247 mm at the standard gap.
      for (const z of [SEATED + 0.3, SEATED + 3.5, SEATED + 4.4]) expect(pocket(z) - foot(z)).toBeCloseTo(gap + 0.1, 9);
    }
    expect((BIN_GAP + 0.1) / Math.SQRT2).toBeCloseTo(0.247, 3);
  });

  it("the stacking lip is the baseplate's steps (0.7 / 1.8 / 1.9 to 4.4 mm), so a bin above has the same 0.25 mm", () => {
    const p = binPlan(valuesOf("gridfinity-bin", { across: 1, along: 1 }));
    const lip = (z: number) => halfAt(p.cavity, p.outer[0] / 2, z);
    const foot = (z: number) => halfAt(FOOT_STEPS, p.cell / 2, z - p.wallTop);
    expect(LIP_HEIGHT).toBe(4.4);
    expect(p.top).toBe(3 * 7 + 4.4);
    expect(lip(p.wallTop + 0.7) - foot(p.wallTop + 0.7)).toBeCloseTo(0.35, 9);
    expect(lip(p.wallTop + 1.5) - foot(p.wallTop + 1.5)).toBeCloseTo(0.25, 9);
    // At the top the lip reaches the bin's outside (a sharp edge), and under it the support slopes back at 45°.
    expect(lip(p.wallTop + 4.4)).toBeCloseTo(p.outer[0] / 2, 9);
    expect(p.cavity[2].z - p.cavity[1].z).toBeCloseTo(p.cavity[2].inset - p.cavity[1].inset, 9);
  });

  it("stepsVolume: a straight stack is its area × height; a 45° frustum by Simpson", () => {
    const area = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r;
    expect(stepsVolume(40, 30, 4, [{ z: 0, inset: 0 }, { z: 10, inset: 0 }])).toBeCloseTo(area(40, 30, 4) * 10, 9);
    expect(stepsVolume(40, 30, 4, [{ z: 0, inset: 0 }, { z: 10, inset: 0 }], 2, 5)).toBeCloseTo(area(40, 30, 4) * 3, 9);
    // Numerically, in thin slices.
    const steps = [{ z: 0, inset: 2 }, { z: 2, inset: 0 }];
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const s = 2 - (2 * (i + 0.5)) / 2000;
      sum += area(40 - 2 * s, 30 - 2 * s, 4 - s) * (2 / 2000);
    }
    expect(stepsVolume(40, 30, 4, steps)).toBeCloseTo(sum, 4);
  });

  it("refuses sizes that don't work, in plain words", () => {
    expect(problems("gridfinity-bin", { units: 2, floor: 10 })[0]).toMatch(/too short for a stacking lip/);
    expect(problems("gridfinity-bin", { across: 1, dividers: 6 })[0]).toMatch(/compartments only/);
    expect(problems("gridfinity-bin", { label: true, ledge: 20, units: 3 })[0]).toMatch(/label ledge/);
    expect(problems("gridfinity-bin", { units: 3, label: true })).toEqual([]);
    expect(design("gridfinity-baseplate").summary!(valuesOf("gridfinity-baseplate", { across: 7 }))).toMatch(/bigger than a 256 mm print bed/);
  });
});

describe("the other new designs' maths", () => {
  it("name plate: the words stay inside the border, clear of the screw holes and above the foot's slot", () => {
    expect(wordsRoom(valuesOf("sign"))).toEqual([-63.5, 63.5, -13.5, 13.5]);
    expect(wordsRoom(valuesOf("sign", { mount: "holes" }))[1]).toBe(70 - 10 - 4 - 1.5);
    expect(wordsRoom(valuesOf("sign", { mount: "stand" }))[2]).toBe(-20 + 9.5);
    expect(problems("sign", { words: "A VERY LONG SIGN INDEED" })[0]).toMatch(/don't fit/);
    expect(problems("sign", { style: "recessed", relief: 2.6 })[0]).toMatch(/shallower/);
    expect(problems("sign", { corner: 4 })[0]).toMatch(/round the corners more than/);
  });

  it("battery organiser: sizes from the table, holes a fit bigger, refusing holes deeper than the batteries", () => {
    expect(CELLS.AA.d).toBe(14.5);
    expect(CELLS["18650"].d).toBe(18.6);
    expect(cellDiameter(valuesOf("battery-holder", { cell: "AAA" }))).toBe(10.5);
    expect(cellDiameter(valuesOf("battery-holder", { cell: "custom", diameter: 12.3 }))).toBe(12.3);
    expect(design("battery-holder").summary!(valuesOf("battery-holder"))).toMatch(/12 batteries 14.5 mm across\. The block is 101.8 mm × 35 mm/);
    expect(problems("battery-holder", { cell: "AAA", depth: 40 })[0]).toMatch(/swallow/);
    expect(problems("battery-holder", { columns: 1, rows: 1 })[0]).toMatch(/at least two/);
  });

  it("spool holder: the arm 10 mm under the spool's hole, the lip 3 mm under, sloping out at 45°", () => {
    const p = armProfile(varsOf(valuesOf("spool-holder"), ["hub", "width", "plateWidth", "plateLength", "thickness"]));
    expect(p.map(([x, y]) => [x.v, y.v])).toEqual([[0, 0], [21.5, 0], [21.5, 79], [25, 82.5], [25, 86.5], [0, 86.5]]);
    expect(problems("spool-holder", { plateLength: 60 })[0]).toMatch(/too short for screws/);
    expect(problems("spool-holder", { plateWidth: 40 })[0]).toMatch(/wider than the arm/);
  });

  it("plant pot: the saucer's rim stays the gap clear of the sloping pot; no lean past 45°", () => {
    const s = potSizes(varsOf(valuesOf("plant-pot"), ["top", "bottom", "height", "wall", "floor", "gap", "saucer"]));
    // The pot is 40 at the bottom and 55 at the top over 95 mm; at the rim (16 − 4.5 above its bottom) it's 41.82.
    expect(s.atRim.v).toBeCloseTo(40 + (15 * 11.5) / 95, 9);
    expect(s.saucerIn.v - s.atRim.v).toBeCloseTo(3, 9);
    const r = evaluate(s.saucerIn.t, { pot_top: 110, pot_bottom: 80, pot_height: 95, pot_saucer: 16, pot_gap: 3 });
    expect(r.ok && r.value).toBeCloseTo(s.saucerIn.v, 9);
    expect(problems("plant-pot", { top: 250, bottom: 30, height: 100 })[0]).toMatch(/45°/);
    expect(problems("plant-pot", { top: 60, bottom: 80 })[0]).toMatch(/at least as wide/);
    expect(problems("plant-pot", { holes: 12, bottom: 40, top: 50 })[0]).toMatch(/too close together|too small/);
  });

  it("bag clip: the mouth narrower than the rod, the rod cut flat at 45°, and the clip not stretched past 2%", () => {
    const s = clipSizes(valuesOf("bag-clip"));
    expect(FLAT_AT).toBeCloseTo(Math.cos(Math.PI / 4), 12);
    expect(s.inner - s.r).toBe(0.25);
    expect(s.spread).toBe(3);
    expect(s.strain).toBeGreaterThan(0.005);
    expect(s.strain).toBeLessThan(0.02);
    expect(problems("bag-clip", { opening: 9.5 })[0]).toMatch(/won't hold/);
    expect(problems("bag-clip", { rod: 8, opening: 4, wall: 4 })[0]).toMatch(/stretch too far/);
  });

  it("thumb knob: the pocket is the table's nut across the flats plus the press fit, as deep as the nut or the head", () => {
    expect(KNOB_SIZES).toEqual(["M3", "M4", "M5", "M6", "M8"]);
    const v = valuesOf("thumb-knob", { size: "M6" });
    expect(design("thumb-knob").summary!(v)).toMatch(new RegExp(`pocket is ${printFastener("M6").flats + 0.2} mm across the flats and ${printFastener("M6").nut} mm deep`));
    expect(pocketDepth(valuesOf("thumb-knob", { size: "M6", holds: "head" }))).toBe(printFastener("M6").head);
    expect(knurlCount(28)).toBe(22);
    expect(problems("thumb-knob", { size: "M8", diameter: 15 })[0]).toMatch(/needs a knob at least/);
    expect(problems("thumb-knob", { height: 4 })[0]).toMatch(/at least/);
  });

  it("hose adapter: each end sized by its outside (into a hose) or inside + fit (over a pipe); a 45° cone between", () => {
    const s = adapterSizes(valuesOf("hose-adapter"));
    expect([s.aOut, s.aIn, s.bOut, s.bIn]).toEqual([16, 14, 22.2, 20.2]);
    expect(s.cone).toBeCloseTo(6.2, 9);
    expect(adapterSizes(valuesOf("hose-adapter", { b: 32, bFits: "into" })).cone).toBe(0);
    expect(problems("hose-adapter", { a: 5 })[0]).toMatch(/no hole through it/);
  });

  it("SD card holder: slots a little bigger than the cards, 2 mm walls", () => {
    const L = cardLayout(valuesOf("card-holder"));
    expect(L.slot.w).toBeCloseTo(24.8, 9);
    expect(L.slot.t).toBeCloseTo(2.7, 9);
    expect(L.size[0]).toBeCloseTo(8 * 4.7 + 2, 9);
  });
});

describe("every design of the third batch", () => {
  const variants: [string, DesignValues][] = [
    ...NEW.map((id): [string, DesignValues] => [id, {}]),
    ["gridfinity-bin", { across: 3, along: 2, units: 6, dividers: 3, label: true, magnets: true }],
    ["gridfinity-bin", { lip: false }],
    ["sign", { style: "recessed", mount: "holes", width: 160, border: false }],
    ["sign", { mount: "stand", corner: 0 }],
    ["battery-holder", { cell: "custom", diameter: 9 }],
    ["thumb-knob", { holds: "head", size: "M4" }],
    ["hose-adapter", { aFits: "over", bFits: "over", b: 50 }],
    ["card-holder", { card: "micro" }],
  ];
  for (const [id, extra] of variants) {
    it(`${design(id).name}${Object.keys(extra).length ? ` (${JSON.stringify(extra)})` : ""}: works with its defaults, and every sketch is fully defined`, () => {
      const d = design(id);
      const values = valuesOf(id, extra);
      expect(valueProblems(d, values)).toEqual([]);
      expect(d.category).toBe("print");
      expect(d.group).toBeDefined();
      expect(d.preview(values).length).toBeGreaterThan(0);
      expect(d.summary!(values)!.length).toBeGreaterThan(10);
      const r = insertDesign(emptyDocument(), d, values, { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      setCurrentScope(scope);
      expect(r.doc.variables!.every((v) => v.name.startsWith(`${d.prefix}_`))).toBe(true);
      for (const f of studioFeatures(r.doc, MAIN_STUDIO)) {
        if (f.sketch) expect(freedomOf(f.sketch.data)).toBe(0);
        for (const v of Object.values(f.params)) expect(evaluate(v, scope).ok).toBe(true);
        if (f.apart) expect(f.operation).toBe("new");
        if (f.type === "loft") expect(f.loftRuled).toBe(true);
      }
    });
  }

  it("Edit design sizes remakes a bin in place: more cells, magnets on, the same ids", () => {
    const r = insertDesign(emptyDocument(), design("gridfinity-bin"), valuesOf("gridfinity-bin"), { into: MAIN_STUDIO });
    const before = studioFeatures(r.doc, MAIN_STUDIO).map((f) => f.id);
    const e = editInsert(r.doc, r.insert.id, valuesOf("gridfinity-bin", { across: 3, magnets: true }));
    const after = studioFeatures(e.doc, MAIN_STUDIO);
    for (const id of before) expect(after.map((f) => f.id)).toContain(id);
    expect(after.find((f) => f.id.endsWith("_feet"))!.params.count).toBe("3");
    expect(after.some((f) => f.id.endsWith("_magnets"))).toBe(true);
    expect(e.remade).toEqual([]);
  });
});

describe("a straight (ruled) Loft", () => {
  it("is kept in the file; older lofts stay smooth", () => {
    const sk = (id: string, z: number) => ({ id, name: id, type: "sketch" as const, operation: "new" as const, suppressed: false, params: {}, sketch: { plane: levelPlane("x", z), data: { points: [], curves: [], constraints: [] } } });
    const ruled = loftFeature("l1", "Loft", ["a", "b"], "add");
    const smooth = loftFeature("l2", "Loft 2", ["a", "b"], "add", false);
    const doc = parseDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), features: [sk("a", 0), sk("b", 5), ruled, smooth] })))!;
    expect(doc.features.find((f) => f.id === "l1")!.loftRuled).toBe(true);
    expect(doc.features.find((f) => f.id === "l2")!.loftRuled).toBeUndefined();
    expect(doc.features.find((f) => f.id === "a")!.sketch!.plane).toMatchObject({ kind: "face", origin: [0, 0, 0] });
  });
});

describe("finding them in the library", () => {
  it("under their headings: Gridfinity, Desk and Garden among the set ones", () => {
    expect(GROUP_ORDER.print).toEqual(["Fixings", "Hinges", "Storage", "Gridfinity", "Household", "Desk", "Garden", "Workshop"]);
    const groups = designGroups("print");
    expect(groups.map((g) => g.group)).toEqual(GROUP_ORDER.print);
    const of = (g: string) => groups.find((x) => x.group === g)!.designs.map((d) => d.id);
    expect(of("Gridfinity")).toEqual(["gridfinity-baseplate", "gridfinity-bin"]);
    expect(of("Desk")).toEqual(["sign", "headphone-hook", "card-holder"]);
    expect(of("Garden")).toEqual(["plant-pot"]);
    expect(of("Storage")).toContain("battery-holder");
    expect(of("Household")).toContain("bag-clip");
  });

  it("by search", () => {
    expect(searchDesigns("gridfinity").slice(0, 2).map((d) => d.id).sort()).toEqual(["gridfinity-baseplate", "gridfinity-bin"]);
    expect(searchDesigns("gridfinity bin")[0].id).toBe("gridfinity-bin");
    expect(searchDesigns("magnet").map((d) => d.id)).toContain("gridfinity-bin");
    expect(searchDesigns("18650").map((d) => d.id)).toEqual(["battery-holder"]);
    expect(searchDesigns("spool")[0].id).toBe("spool-holder");
    expect(searchDesigns("headphones").map((d) => d.id)).toContain("headphone-hook");
    expect(searchDesigns("microSD").map((d) => d.id)).toEqual(["card-holder"]);
    expect(searchDesigns("vacuum")[0].id).toBe("hose-adapter");
    expect(searchDesigns("plant")[0].id).toBe("plant-pot");
    expect(searchDesigns("name plate")[0].id).toBe("sign");
  });
});
