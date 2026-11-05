/**
 * The Design library's newer 3D-printing designs (bolt set, standoff, piano hinge, jar, bit holder, pegboard hook,
 * drawer pull, cable grommet, corner protector): the fastener sizes, the printed-thread maths, each design's sizes,
 * every sketch fully defined by the variables, and browsing the library by group and by search. Pure — the geometry
 * is checked in engineLibraryThreads and engineLibraryPrint2.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { FASTENER_SIZES } from "../src/model/fasteners";
import { MAIN_STUDIO, studioFeatures } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { defaultValues, designGroups, designsIn, editInsert, currentValues, findDesign, GROUP_ORDER, groupDesigns, insertDesign, LIBRARY, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { lit } from "../src/library/ex";
import { freedomOf } from "../src/library/sketchKit";
import { gridPatternFeature, grooveDepth, nutHoleDiameter, PRINTED_DEPTH, rodDiameter, threadGap, threadOverlap } from "../src/library/printKit";
import { acrossCorners, coarsePitch, ISO_COARSE_PITCH, PRINT_SIZES, printFastener } from "../src/library/designs/boltSizes";
import { boltSetLayout, boltSetSizes, maxFit, SET_GAP } from "../src/library/designs/boltSet";
import { MAX_KNUCKLES, pianoHoleSpots, pianoKnuckles } from "../src/library/designs/pianoHinge";
import { jarProfile, jarSizes, revolvedVolume } from "../src/library/designs/jar";
import { BEHIND, pegHookOutline, pegPlaces } from "../src/library/designs/pegboardHook";
import { pullOutline } from "../src/library/designs/drawerPull";
import { grommetSizes } from "../src/library/designs/grommet";
import { standoffHole } from "../src/library/designs/standoff";
import { varsOf } from "../src/library/designs/common";
import type { DesignValues, LibraryDesign } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const NEW = ["bolt-set", "standoff", "piano-hinge", "jar", "bit-holder", "pegboard-hook", "drawer-pull", "grommet", "corner-guard"];

describe("fastener sizes", () => {
  it("takes the standard sizes from the table, and works out a custom size in the same proportions", () => {
    expect(PRINT_SIZES).toEqual(["M3", "M4", "M5", "M6", "M8", "M10", "M12"]);
    for (const s of FASTENER_SIZES) {
      const f = printFastener(s.name);
      expect([f.d, f.pitch, f.flats, f.head, f.nut, f.washerHole, f.washerOd]).toEqual([s.d, s.pitch, s.flats, s.head, s.nut, s.washerHole, s.washerOd]);
      expect(f.washerThickness).toBe(Math.max(0.8, s.washerThickness));
      expect(f.socket).toEqual({ dk: s.socketCap.dk, k: s.socketCap.k, s: s.socketCap.s, t: s.socketCap.t });
    }
    // ISO coarse pitch: M8 1.25, M12 1.75 — and the table agrees with the sizes' own pitches.
    for (const s of FASTENER_SIZES) expect(coarsePitch(s.d)).toBe(s.pitch);
    expect(ISO_COARSE_PITCH.find(([d]) => d === 16)![1]).toBe(2);
    const custom = printFastener("custom", 16, 2);
    expect(custom).toMatchObject({ name: "16 mm", d: 16, pitch: 2, flats: 25, head: 10.4, nut: 13.6, washerOd: 32 });
    // The proportions match the standard closely where the two overlap (M10: 16 flats, 6.5 head, 8.5 nut).
    expect(printFastener("custom", 10, 1.5)).toMatchObject({ flats: 16, head: 6.5, nut: 8.5 });
    expect(acrossCorners(13)).toBeCloseTo(15.011, 3);
  });
});

describe("printed threads", () => {
  it("a bolt and nut cut at the same size have exactly the printed fit between their sloping sides", () => {
    for (const P of [0.5, 1, 1.25, 1.75, 3]) {
      for (const c of [0, 0.1, 0.2, 0.35]) {
        const rod = rodDiameter(lit(10), P, lit(c)).v;
        const hole = nutHoleDiameter(lit(10), P, lit(c)).v;
        expect(threadGap(rod, hole, P)).toBeCloseTo(c, 5);
        // The teeth overlap by 0.634 × pitch less twice the fit.
        expect(threadOverlap(rod, hole)).toBeCloseTo((2 * PRINTED_DEPTH - Math.sqrt(3) / 2) * P - 2 * c, 5);
      }
    }
    // A printed M8 bolt is a little under 8 mm (0.116 × pitch, plus the fit each side), and its nut's hole a bit over the root.
    expect(rodDiameter(lit(8), 1.25, lit(0.2)).v).toBeCloseTo(8 - 0.1449 - 0.4, 3);
    expect(grooveDepth(1.25)).toBe(0.9375);
  });

  it("expressions follow the fit variable", () => {
    const fit = { t: "bolts_fit", v: 0.2 };
    expect(rodDiameter(lit(8), 1.25, fit).t).toBe("7.854968 - (2 * bolts_fit)");
    expect(nutHoleDiameter(lit(8), 1.25, fit).t).toBe("6.270032 + 2 * bolts_fit");
  });
});

describe("bolt, nut and washer set", () => {
  it("lays bolts, nuts and washers out in columns with room between, copies one behind another", () => {
    const L = boltSetLayout(valuesOf("bolt-set", { bolts: 2, nuts: 3, washers: 1 }));
    expect(L.kinds).toEqual(["bolt", "nut", "washer"]);
    expect(L.x.nut - L.x.bolt).toBeCloseTo(L.widths.bolt / 2 + SET_GAP + L.widths.nut / 2, 4);
    expect(L.x.washer - L.x.nut).toBeCloseTo(L.widths.nut / 2 + SET_GAP + L.widths.washer / 2, 4);
    expect(L.row).toBeCloseTo(16 + SET_GAP, 4);
    // Without nuts, the washers move up next to the bolts.
    const noNuts = boltSetLayout(valuesOf("bolt-set", { nuts: 0 }));
    expect(noNuts.kinds).toEqual(["bolt", "washer"]);
    expect(noNuts.x.washer).toBeCloseTo(L.widths.bolt / 2 + SET_GAP + 8, 4);
  });

  it("makes copies, a socket head, and only the parts asked for", () => {
    const r = insertDesign(emptyDocument(), design("bolt-set"), valuesOf("bolt-set", { bolts: 3, nuts: 2, washers: 0, head: "socket" }), { into: MAIN_STUDIO });
    const names = r.doc.features.map((f) => f.name);
    expect(names).toContain("Bolt socket");
    expect(names).toContain("Bolt 3");
    expect(names).toContain("Nut 2");
    expect(names.some((n) => n.startsWith("Washer"))).toBe(false);
    expect(r.doc.features.filter((f) => f.type === "thread")).toHaveLength(2);
    expect(Object.values(r.doc.partNames!)).toEqual(["Bolt, nut and washer set bolt", "Bolt, nut and washer set bolt 2", "Bolt, nut and washer set bolt 3", "Bolt, nut and washer set nut", "Bolt, nut and washer set nut 2"]);
    expect(r.doc.variables!.map((v) => v.name)).toEqual(["bolts_length", "bolts_fit"]);
    // Every thread is the whole round face, with the printed groove depth.
    for (const t of r.doc.features.filter((f) => f.type === "thread")) expect(t.params).toMatchObject({ pitch: "1.25", length: "0", depth: "0.9375" });
    // Without the thread: no Thread features, and a plain hole 2 × fit bigger than the pin.
    const plain = insertDesign(emptyDocument(), design("bolt-set"), valuesOf("bolt-set", { thread: false }), { into: MAIN_STUDIO });
    expect(plain.doc.features.filter((f) => f.type === "thread")).toHaveLength(0);
    const s = boltSetSizes(valuesOf("bolt-set", { thread: false }));
    expect(s.hole - s.rod).toBeCloseTo(0.4, 6);
  });

  it("explains what doesn't work", () => {
    const d = design("bolt-set");
    expect(valueProblems(d, valuesOf("bolt-set", { bolts: 0, nuts: 0, washers: 0 }))[0]).toMatch(/at least one/);
    expect(valueProblems(d, valuesOf("bolt-set", { size: "custom", diameter: 6, pitch: 3 }))[0]).toMatch(/too coarse/);
    expect(valueProblems(d, valuesOf("bolt-set", { size: "M5" }))[0]).toMatch(/hardly catch: make the fit at most 0\.17 mm/);
    expect(valueProblems(d, valuesOf("bolt-set", { size: "M5", thread: false }))).toEqual([]);
    expect(valueProblems(d, valuesOf("bolt-set", { length: 5 }))[0]).toMatch(/at least 5\.69 mm long/);
    expect(maxFit(1.25)).toBe(0.27);
    expect(design("bolt-set").summary!(valuesOf("bolt-set"))).toMatch(/0\.2 mm to spare, the threads overlapping by 0\.39 mm/);
  });

  it("Edit design sizes swaps the head and size, keeping the features' ids", () => {
    const r = insertDesign(emptyDocument(), design("bolt-set"), valuesOf("bolt-set"), { into: MAIN_STUDIO });
    const before = new Map(r.doc.features.map((f) => [f.name, f.id]));
    const edited = editInsert(r.doc, r.insert.id, { ...currentValues(r.doc, r.insert), size: "M10", head: "socket" }).doc;
    for (const f of edited.features) if (before.has(f.name)) expect(f.id).toBe(before.get(f.name));
    expect(edited.features.map((f) => f.name)).toContain("Bolt socket");
    expect(edited.features.find((f) => f.type === "thread")!.params.pitch).toBe("1.5");
  });
});

describe("the other new designs' sizes", () => {
  it("standoff: a modelled thread's hole, a hole for the screw to cut its thread, or a clear one", () => {
    expect(standoffHole(valuesOf("standoff", { size: "M8", hole: "thread" })).v).toBeCloseTo(6.270032 + 0.4, 6);
    expect(standoffHole(valuesOf("standoff", { size: "M4" })).v).toBeCloseTo(3.48, 6);
    expect(standoffHole(valuesOf("standoff", { size: "M4", hole: "clear" })).v).toBeCloseTo(4.6, 6);
    expect(valueProblems(design("standoff"), valuesOf("standoff", { size: "M3", hole: "thread" }))[0]).toMatch(/hardly catch/);
  });

  it("piano hinge: an odd number of knuckles near the length asked for, and holes evenly along each leaf", () => {
    expect(pianoKnuckles(150, 10)).toBe(15);
    expect(pianoKnuckles(100, 10)).toBe(11);
    expect(pianoKnuckles(20, 15)).toBe(3);
    expect(pianoKnuckles(1000, 3)).toBe(MAX_KNUCKLES);
    for (const L of [37, 150, 333]) expect(pianoKnuckles(L, 7) % 2).toBe(1);
    const spots = pianoHoleSpots(varsOf(valuesOf("piano-hinge"), ["length", "leaf", "thickness", "pin", "clearance"]), 4, -1);
    expect(spots.map(([x]) => x.v)).toEqual([18.75, 56.25, 93.75, 131.25]);
    // In the middle of the leaf's free part (beyond the knuckle and its gap).
    expect(spots[0][1].v).toBeCloseTo(-(20 + 3 + 0.4) / 2, 6);
    expect(valueProblems(design("piano-hinge"), valuesOf("piano-hinge", { leaf: 10 }))[0]).toMatch(/too narrow for screw holes/);
    expect(valueProblems(design("piano-hinge"), valuesOf("piano-hinge", { leaf: 10, holes: 0 }))).toEqual([]);
    expect(valueProblems(design("piano-hinge"), valuesOf("piano-hinge", { holes: 30 }))[0]).toMatch(/don't fit/);
  });

  it("jar: the wall behind the thread, and the lid flush with the jar", () => {
    const v = valuesOf("jar");
    const s = jarSizes(varsOf(v, ["inside", "height", "wall", "neck", "fit"]), 3);
    // The thread's root is the wall (less the fit) out from the inside.
    expect(s.rRoot.v - s.rIn.v).toBeCloseTo(2 - 0.3, 6);
    // The lid's outside is the wall beyond its thread's root, and the same as the jar's.
    expect(s.rLid.v - s.rGroove.v).toBeCloseTo(2, 6);
    expect(threadGap(s.rod.v, s.hole.v, 3)).toBeCloseTo(0.3, 6);
    const pts = jarProfile(varsOf(v, ["inside", "height", "wall", "neck", "fit"]), 3);
    expect(Math.max(...pts.map(([x]) => x.v))).toBeCloseTo(s.rLid.v, 6);
    expect(Math.max(...pts.map(([, y]) => y.v))).toBe(70);
    // Pappus: a plain disc 10 across, 2 high.
    expect(revolvedVolume([[0, 0], [5, 0], [5, 2], [0, 2]])).toBeCloseTo(Math.PI * 25 * 2, 6);
    expect(valueProblems(design("jar"), valuesOf("jar", { neck: 6 }))[0]).toMatch(/at least 10 mm tall/);
    expect(valueProblems(design("jar"), valuesOf("jar", { height: 25 }))[0]).toMatch(/taller/);
  });

  it("pegboard hook: round pegs one hole apart, resting on the bed, and peg + lip small enough to go straight in", () => {
    const vars = varsOf(valuesOf("pegboard-hook"), ["spacing", "board", "peg", "lip", "hole", "length", "tip", "thickness", "width"]);
    const at = pegPlaces(vars);
    expect(at.high.v - at.low.v).toBe(25.4);
    expect(at.z.v).toBe(2.25);
    expect(at.high.v - at.lipAt.v).toBeCloseTo(1.2, 9);
    // The lip starts just behind the board and is as long as the peg is thick.
    expect(at.behind.v).toBe(6 + BEHIND);
    expect(at.topLength.v).toBe(6 + BEHIND + 4.5);
    expect(pegHookOutline(vars, false)).toHaveLength(pegHookOutline(vars, true).length - 2);
    const d = design("pegboard-hook");
    expect(valueProblems(d, valuesOf("pegboard-hook", { peg: 5 }))[0]).toMatch(/peg and its lip together.*at most 5\.7 mm together \(now 6\.2 mm\)/);
    expect(valueProblems(d, valuesOf("pegboard-hook", { hole: 6.35, peg: 4.8 }))).toEqual([]);
    expect(valueProblems(d, valuesOf("pegboard-hook", { width: 4 }))[0]).toMatch(/as thick and as wide as the pegs/);
    expect(valueProblems(d, valuesOf("pegboard-hook", { spacing: 10, peg: 8, hole: 10, thickness: 8, lip: 1 }))[0]).toMatch(/apart/);
  });

  it("drawer pull: the feet centred on the screw holes", () => {
    const pts = pullOutline(varsOf(valuesOf("drawer-pull"), ["span", "height", "grip", "width", "foot", "round"])).map(([x, y]) => [x.v, y.v]);
    expect(pts[0]).toEqual([-54, 0]);
    expect(pts[1]).toEqual([-42, 0]);
    expect(valueProblems(design("drawer-pull"), valuesOf("drawer-pull", { height: 12 }))[0]).toMatch(/room for your fingers/);
  });

  it("grommet: the sleeve fits the hole and the cap's plug fits the sleeve, each with the fit", () => {
    const s = grommetSizes(varsOf(valuesOf("grommet"), ["hole", "depth", "wall", "lip", "fit", "slot"]));
    expect(60 - s.sleeveOut.v).toBeCloseTo(0.6, 6);
    expect(s.sleeveIn.v - s.plugOut.v).toBeCloseTo(0.6, 6);
    expect(s.lipD.v).toBe(70);
  });

  it("bit holder and grid patterns", () => {
    const g = gridPatternFeature("p", "Holes", ["h"], 6, lit(12), 2, lit(12));
    expect(g.params).toMatchObject({ count: "6", count2: "2", spacing: "12" });
    expect(g.pattern).toMatchObject({ axis: "x", axis2: "y" });
    const oneCol = gridPatternFeature("p", "Holes", ["h"], 1, lit(12), 4, lit(10));
    expect(oneCol.params).toMatchObject({ count: "4", count2: "1", spacing: "10" });
    expect(oneCol.pattern!.axis).toBe("y");
    expect(valueProblems(design("bit-holder"), valuesOf("bit-holder", { columns: 1, rows: 1 }))[0]).toMatch(/at least two holes/);
    expect(valueProblems(design("bit-holder"), valuesOf("bit-holder", { spacing: 7 }))[0]).toMatch(/apart/);
  });
});

describe("every new design", () => {
  const variants: [string, DesignValues][] = [
    ...NEW.map((id): [string, DesignValues] => [id, {}]),
    ["bolt-set", { head: "socket", size: "M12", bolts: 2 }],
    ["bolt-set", { size: "custom", diameter: 16, pitch: 2 }],
    ["bolt-set", { thread: false, bolts: 0 }],
    ["standoff", { hole: "thread", size: "M8" }],
    ["piano-hinge", { holes: 0, length: 60 }],
    ["jar", { pitch: "4", neck: 16 }],
    ["bit-holder", { shape: "round", columns: 1, rows: 5 }],
    ["pegboard-hook", { shape: "straight" }],
    ["drawer-pull", { round: 0 }],
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
        // Only New extrudes and revolves make parts of their own; everything else works on the design's latest part.
        if (f.apart) expect(f.operation).toBe("new");
      }
    });
  }
});

describe("browsing the library", () => {
  it("puts the 3D printing designs under headings, in a set order (ungrouped designs would come first)", () => {
    const groups = designGroups("print");
    // Every one has a heading, in the set order (the printed stamp with the household things).
    expect(groups.map((g) => g.group)).toEqual(GROUP_ORDER.print.filter((g) => designsIn("print").some((d) => d.group === g)));
    expect(groups.find((g) => g.group === "Household")!.designs.map((d) => d.id)).toContain("printed-stamp");
    expect(groups.find((g) => g.group === "Fixings")!.designs.map((d) => d.id)).toEqual(["spacer", "bolt-set", "standoff", "thumb-knob", "pipe-clip"]);
    expect(groups.find((g) => g.group === "Hinges")!.designs.map((d) => d.id)).toEqual(["hinge", "piano-hinge"]);
    expect(groups.find((g) => g.group === "Workshop")!.designs.map((d) => d.id)).toEqual(["bit-holder", "pegboard-hook", "spool-holder", "hose-adapter", "french-cleat", "cable-chain", "bearing-spool-holder"]);
    expect(groups.flatMap((g) => g.designs)).toHaveLength(designsIn("print").length);
    // Laser cutting keeps its headings in the order they're first used.
    const laser = designGroups("laser").map((g) => g.group);
    const firstUse = [...new Set(designsIn("laser").filter((d) => d.group).map((d) => d.group!))];
    expect(laser.filter((g) => g !== null)).toEqual(firstUse);
    // Others follow the set ones; with no order, first use.
    const mixed: LibraryDesign[] = [{ ...design("knob"), group: "Toys" }, design("hinge"), { ...design("tray"), group: undefined }];
    expect(groupDesigns(mixed, GROUP_ORDER.print).map((g) => g.group)).toEqual([null, "Hinges", "Toys"]);
    expect(groupDesigns(mixed).map((g) => g.group)).toEqual([null, "Toys", "Hinges"]);
    expect(groupDesigns([])).toEqual([]);
  });

  it("finds designs by any word of their name, group or description, names first", () => {
    expect(searchDesigns("bolt")[0].id).toBe("bolt-set");
    // Every hinge (the print-in-place and piano hinges, the hinged box, and the laser's living hinge and living-hinge box), whatever the case typed.
    const hinges = searchDesigns("HINGE").map((d) => d.id);
    for (const id of ["hinge", "piano-hinge", "hinged-box", "living-hinge", "hinge-box"]) expect(hinges.slice(0, 5)).toContain(id);
    for (const id of ["bolt-set", "standoff", "spacer"]) expect(searchDesigns("fix").map((d) => d.id)).toContain(id);
    expect(searchDesigns("laser box").map((d) => d.id)).toContain("finger-box");
    expect(searchDesigns("stencil")[0].id).toBe("stencil");
    expect(searchDesigns("jar lid").map((d) => d.id)).toEqual(["jar"]);
    expect(searchDesigns("  ")).toEqual([]);
    expect(searchDesigns("teapot")).toEqual([]);
    // Size choices count: M8 finds the designs that come in M8.
    expect(searchDesigns("M8").map((d) => d.id)).toEqual(["bolt-set", "standoff", "thumb-knob"]);
    expect(searchDesigns("socket head")[0].id).toBe("bolt-set");
    expect(new Set(searchDesigns("a").map((d) => d.id)).size).toBe(searchDesigns("a").length);
    expect(LIBRARY.length).toBeGreaterThan(19);
  });
});
