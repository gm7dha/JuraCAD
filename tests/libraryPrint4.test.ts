/**
 * The fourth batch of 3D-printing designs (electronics enclosure, French cleat, hinged box, desk organiser, cable
 * chain, wall pocket, shelf pins, fit / overhang / bridge tests): each design's maths and plain-English problems,
 * every sketch fully defined, Edit design sizes, and finding them in the library. Pure — the geometry is checked in
 * engineLibraryPrint4.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO, studioFeatures } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { defaultValues, designGroups, editInsert, findDesign, GROUP_ORDER, insertDesign, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { freedomOf } from "../src/library/sketchKit";
import { varsOf } from "../src/library/designs/common";
import { BOARDS, enclosurePlan, SCREW_HOLES, snapStrain as enclosureStrain } from "../src/library/designs/enclosure";
import { CLEAT_GAP, CLEAT_LIP, hangLift, holderOutline, stripOutline } from "../src/library/designs/frenchCleat";
import { clipAcross, hingedPlan } from "../src/library/designs/hingedBox";
import { cornerLimit, cupSizes, organiserLayout } from "../src/library/designs/deskOrganiser";
import { bendRadius, chainPlan, sagAngle, snapStrain as chainStrain } from "../src/library/designs/cableChain";
import { pinDiameter } from "../src/library/designs/shelfPins";
import { bridgePlan, fitLabels, fitPlan, LABEL, LABEL_GAP, labelsInk, labelsProblem, MIN_LABEL, overhangPlan, steps } from "../src/library/designs/testPrints";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const problems = (id: string, extra: DesignValues = {}) => valueProblems(design(id), valuesOf(id, extra));
const NEW = ["enclosure", "french-cleat", "hinged-box", "desk-organiser", "cable-chain", "wall-pocket", "shelf-pins", "fit-test", "overhang-test", "bridge-test"];

describe("electronics enclosure", () => {
  it("knows the Raspberry Pi's and Uno's holes, and sizes holes for self-tapping screws or Ruthex-style inserts", () => {
    const pi = BOARDS.pi.holes;
    // 58 × 49 apart.
    expect(pi[1][0] - pi[0][0]).toBe(58);
    expect(pi[2][1] - pi[0][1]).toBe(49);
    // 3.5 mm in from the board's left and bottom edges (85 × 56).
    expect(pi[0][0] + 85 / 2).toBe(3.5);
    expect(pi[0][1] + 56 / 2).toBe(3.5);
    expect(BOARDS.pi.screw).toBe("M2.5");
    expect(BOARDS.uno.screw).toBe("M3");
    expect(SCREW_HOLES["M2.5"]).toEqual({ selfTap: 2.2, insert: 4.0, insertLength: 5.7 });
    expect(SCREW_HOLES.M3).toEqual({ selfTap: 2.6, insert: 4.0, insertLength: 5.7 });
    const p = enclosurePlan(valuesOf("enclosure"));
    expect(p.standoff).toEqual({ height: 6.5, hole: 4, diameter: 7.2 });
    expect(p.outer).toEqual([108, 78, 32]);
    expect(p.post).toBe(8);
    expect(design("enclosure").summary!(valuesOf("enclosure"))).toMatch(/M2\.5 heat-set inserts \(4 mm holes\)/);
  });

  it("a custom board's four holes in a rectangle in its middle", () => {
    const p = enclosurePlan(valuesOf("enclosure", { board: "custom", holesX: 50, holesY: 30, screw: "M2.5", holes: "selfTap" }));
    expect(p.board.holes).toEqual([[-25, -15], [25, -15], [-25, 15], [25, 15]]);
    expect(p.standoff.hole).toBe(2.2);
  });

  it("the snap lid's lip bends less than 2% as it clicks on, and its groove is the ridge plus the clearance square to 45°", () => {
    expect(enclosureStrain(0.2)).toBeLessThan(0.02);
    const p = enclosurePlan(valuesOf("enclosure", { fixing: "snap" }));
    expect(p.groove).toBeCloseTo(0.5 + (Math.SQRT2 - 1) * 0.2, 5);
    expect(p.post).toBe(0);
  });

  it("refuses what wouldn't work, in plain words", () => {
    expect(problems("enclosure", { width: 80 })[0]).toMatch(/needs at least 87 mm/);
    expect(problems("enclosure", { width: 92, depth: 66 })[0]).toMatch(/sit on the lid's screw posts/);
    expect(problems("enclosure", { board: "uno", standoff: 5 })[0]).toMatch(/M3 inserts are 5\.7 mm long/);
    expect(problems("enclosure", { board: "uno", standoff: 5, holes: "selfTap" })).toEqual([]);
    expect(problems("enclosure", { fixing: "snap", clearance: 0.4 })[0]).toMatch(/won't hold/);
    expect(problems("enclosure", { vents: 30 })[0]).toMatch(/vent slots don't fit/);
    expect(problems("enclosure", { port1Along: 50 })[0]).toMatch(/Cut-out 1 reaches past the end/);
    expect(problems("enclosure", { port1Up: 22 })[0]).toMatch(/reaches up into the lid's lip/);
    expect(problems("enclosure", { height: 12 })[0]).toMatch(/at least/);
    expect(problems("enclosure", { lid: 2 })[0]).toMatch(/countersunk/);
  });
});

describe("French cleat", () => {
  it("the holder's 45° face lies the clearance off the strip's (square to it), hung up", () => {
    const v = valuesOf("french-cleat");
    const vars = varsOf(v, ["length", "height", "thickness", "width", "plate", "plateThickness", "reach", "shelf", "clearance"]);
    const strip = stripOutline(vars).map(([u, w]) => [w.v, u.v]); // (out from the wall, up)
    const holder = holderOutline(vars, "hook").map(([x, y]) => [x.v, y.v + hangLift(v)]);
    const [s1, s2] = [strip[1], strip[2]];
    const [h1, h2] = [holder[0], holder[1]];
    // Both slopes at exactly 45°…
    expect(s2[1] - s1[1]).toBeCloseTo(s2[0] - s1[0], 9);
    expect(h2[1] - h1[1]).toBeCloseTo(h2[0] - h1[0], 9);
    // …and parallel lines c apart: (y − x) differs by √2 c.
    expect(h1[1] - h1[0] - (s1[1] - s1[0])).toBeCloseTo(Math.SQRT2 * 0.3, 5);
    // The holder's back the clearance off the wall; its plate the clearance in front of the strip.
    expect(h1[0]).toBeCloseTo(0.3, 9);
    expect(holder[2][0]).toBeCloseTo(12 + 0.3, 9);
    // Laid out, the holder's top is CLEAT_GAP below the strip's bottom.
    expect(Math.max(...holderOutline(vars, "shelf").map(([, y]) => y.v))).toBe(-CLEAT_GAP);
    expect(holder[holder.length - 1][1] - h1[1]).toBeCloseTo(12 + CLEAT_LIP, 9);
  });

  it("refuses what wouldn't work", () => {
    expect(problems("french-cleat", { height: 20 })[0]).toMatch(/at least 23 mm high/);
    expect(problems("french-cleat", { holder: "shelf", shelf: 80 })[0]).toMatch(/braced at 45°/);
    expect(problems("french-cleat", { holder: "holes", holeCount: 8 })[0]).toMatch(/don't fit/);
    expect(problems("french-cleat", { holder: "holes", hole: 30, holeCount: 1, shelf: 30 })[0]).toMatch(/rack at least/);
    expect(problems("french-cleat", { parts: "holder", height: 20 })).toEqual([]);
    expect(design("french-cleat").summary!(valuesOf("french-cleat"))).toMatch(/2 parts/);
  });
});

describe("hinged box", () => {
  it("the pin is half-way up box and lid together, so the lid lands rim to rim; both blocks stay below it", () => {
    const p = hingedPlan(valuesOf("hinged-box"));
    expect(p.a).toBe((35 + 16) / 2);
    // Turned 180° about the pin, the lid's rim (z = 16) goes to 2a − 16 = the box's rim.
    expect(2 * p.a - p.Hl).toBe(p.Hb);
    for (const [, z] of [...p.boxBlock, ...p.lidBlock]) expect(z).toBeLessThanOrEqual(p.a + 1e-9);
    expect(p.low).toBeGreaterThan(0);
    // The blocks' undersides slope at 45° and touch the knuckle where it turns 45°.
    const [a, b] = p.boxBlock;
    expect(b[1] - a[1]).toBeCloseTo(b[0] - a[0], 5);
    expect(Math.hypot(b[0], b[1] - p.a)).toBeCloseTo(p.R, 5);
    expect(p.g).toBeCloseTo(p.R + p.c + 0.6, 9);
    expect(clipAcross([[0, 0], [10, 0], [10, 10], [0, 10]], 4, "below")).toEqual([[0, 0], [4, 0], [4, 10], [0, 10]]);
  });

  it("refuses what wouldn't work", () => {
    expect(problems("hinged-box", { knuckles: 4 })[0]).toMatch(/odd/);
    expect(problems("hinged-box", { lid: 40 })[0]).toMatch(/can't be taller/);
    expect(problems("hinged-box", { height: 60, lid: 10 })[0]).toMatch(/lid is too shallow/);
    expect(problems("hinged-box", { pin: 6 })[0]).toMatch(/too thin/);
  });
});

describe("desk organiser", () => {
  it("reads the cups' sizes, lays them out side by side with a wall between, and refuses bad lists", () => {
    expect(cupSizes("60, 45,45 30mm")).toEqual([60, 45, 45, 30]);
    expect(cupSizes("")).toMatch(/Type the cups' sizes/);
    expect(cupSizes("60, pens")).toMatch(/"pens" isn't a size/);
    expect(cupSizes("5")).toMatch(/10–150 mm/);
    expect(cupSizes("20,20,20,20,20,20,20,20,20")).toMatch(/At most 8/);
    const L = organiserLayout(valuesOf("desk-organiser"));
    expect(L.size[0]).toBeCloseTo(60 + 45 + 45 + 30 + 5 * 2.4, 9);
    expect(L.size[1]).toBeCloseTo(60 + 2 * 2.4, 9);
    [32.4, 87.3, 134.7, 174.6].forEach((x, i) => expect(L.cups[i].x).toBeCloseTo(x, 9));
    const g = organiserLayout(valuesOf("desk-organiser", { layout: "grid" }));
    expect(g.cups).toHaveLength(6);
    expect(g.size).toEqual([3 * 42.4 + 2.4, 2 * 42.4 + 2.4]);
    expect(problems("desk-organiser", { sizes: "big" })[0]).toMatch(/isn't a size/);
    expect(problems("desk-organiser", { corner: 25 })[0]).toMatch(/Round the block's corners at most/);
    expect(cornerLimit(valuesOf("desk-organiser"))).toBeGreaterThan(4);
  });
});

describe("cable chain", () => {
  it("its bend stop meets the next link's middle at exactly the bend angle, and it sags only a little the other way", () => {
    for (const bend of [15, 30, 45]) {
      const p = chainPlan(valuesOf("cable-chain", { bend }));
      const th = (bend * Math.PI) / 180;
      // The back edge's top corner (−backTop, R above the joint) turned by the bend lands on x = −a, the middle's end.
      expect(-p.backTop * Math.cos(th) - p.R * Math.sin(th)).toBeCloseTo(-p.a, 5);
      expect(sagAngle(p)).toBeLessThan(0);
      expect(sagAngle(p)).toBeGreaterThan(-3);
    }
    const p = chainPlan(valuesOf("cable-chain"));
    expect(p.pitch).toBe(2 * (7 + 4) + 6);
    expect(p.total).toBeCloseTo(15 + 8 + 0.6, 9);
    expect(chainStrain(p)).toBeLessThan(0.02);
    expect(bendRadius(p)).toBeCloseTo(28 / (2 * Math.tan(Math.PI / 12)), 6);
    expect(design("cable-chain").summary!(valuesOf("cable-chain"))).toMatch(/8 links, each 28 mm from pin to pin/);
    expect(problems("cable-chain", { height: 5, bars: 1.2 }).some((m) => /bend too far to click/.test(m))).toBe(true);
  });
});

describe("test prints", () => {
  it("steps from–to in even steps, the fit test's holes the peg plus twice each gap", () => {
    expect(steps(0.1, 0.5, 0.1)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(steps(20, 70, 10)).toEqual([20, 30, 40, 50, 60, 70]);
    expect(steps(5, 4, 1)).toEqual([]);
    const f = fitPlan(valuesOf("fit-test"));
    expect(f.holes.map((h) => h.d)).toEqual([10.2, 10.4, 10.6, 10.8, 11]);
    expect(f.labels.map((l) => l.text)).toEqual(["0.1", "0.2", "0.3", "0.4", "0.5"]);
    expect(problems("fit-test", { from: 0, to: 1, step: 0.05 })[0]).toMatch(/at most 10/);
    expect(problems("fit-test", { from: 0.5, to: 0.1 })[0]).toMatch(/at least “From”/);
  });

  it("the numbers keep apart: full size when there's room, smaller when neighbours are close, refused when too small", () => {
    const f = fitPlan(valuesOf("fit-test"));
    expect(f.labels.every((l) => l.h === LABEL.height)).toBe(true);
    const row = (apart: number, text = "0.25") => [0, 1, 2].map((i) => ({ text, at: [i * apart, 0] as [number, number] }));
    const wide = labelsInk(row(100)).widest;
    expect(wide).toBeGreaterThan(5);
    // Squeezed so the widest just fits between neighbours' middles, less the gap.
    const squeezed = fitLabels(row(wide * 0.8));
    expect(squeezed[0].h).toBeLessThan(LABEL.height);
    expect(labelsInk(squeezed).widest).toBeLessThanOrEqual(wide * 0.8 - LABEL_GAP + 0.01);
    expect(labelsProblem(squeezed)).toBeNull();
    const crowded = fitLabels(row(wide * 0.4));
    expect(crowded[0].h).toBeLessThan(MIN_LABEL);
    expect(labelsProblem(crowded)).toMatch(/run into each other/);
  });

  it("overhang fins lean the stated angle; bridges span the stated gaps", () => {
    const o = overhangPlan(valuesOf("overhang-test"));
    expect(o.fins.map((f) => f.angle)).toEqual([20, 30, 40, 50, 60, 70]);
    for (const f of o.fins) expect(Math.atan(f.reach / o.height) * (180 / Math.PI)).toBeCloseTo(f.angle, 3);
    const b = bridgePlan(valuesOf("bridge-test"));
    expect(b.gaps.map((g) => g.x1 - g.x0)).toEqual([10, 20, 30, 40, 50]);
    expect(b.length).toBe(150 + 6 * 4);
    expect(design("bridge-test").summary!(valuesOf("bridge-test", { to: 100 }))).toMatch(/bed/);
  });
});

describe("shelf pins and the wall pocket", () => {
  it("pins the hole less the fit each side; the pocket has room for its screws", () => {
    expect(pinDiameter(valuesOf("shelf-pins"))).toBe(4.8);
    expect(pinDiameter(valuesOf("shelf-pins", { hole: "6.35", fit: 0.15 }))).toBe(6.05);
    expect(problems("shelf-pins", { width: 5 })[0]).toMatch(/at least 6.8 mm wide/);
    expect(problems("wall-pocket", { back: 65 })[0]).toMatch(/room for the screws/);
    expect(problems("wall-pocket", { width: 25 })[0]).toMatch(/wide inside, for two screws/);
  });
});

describe("every design of the fourth batch", () => {
  const variants: [string, DesignValues][] = [
    ...NEW.map((id): [string, DesignValues] => [id, {}]),
    ["enclosure", { fixing: "snap", port2Side: "back", vents: 0, placement: "on" }],
    ["enclosure", { board: "custom", boardWidth: 60, boardDepth: 40, holesX: 50, holesY: 30, holes: "selfTap" }],
    ["french-cleat", { holder: "shelf" }],
    ["french-cleat", { holder: "holes", parts: "holder" }],
    ["french-cleat", { parts: "cleat" }],
    ["hinged-box", { height: 25, lid: 25, knuckles: 7 }],
    ["desk-organiser", { layout: "grid", shape: "square" }],
    ["desk-organiser", { shape: "square", sizes: "40, 25" }],
    ["cable-chain", { width: 40, height: 25, bend: 20, count: 3 }],
    ["wall-pocket", { cable: false }],
    ["shelf-pins", { hole: "custom", diameter: 8, count: 2 }],
    ["fit-test", { labels: false }],
    ["overhang-test", { from: 15, to: 75, step: 15 }],
    ["bridge-test", { labels: false }],
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
      expect((r.doc.variables ?? []).every((v) => v.name.startsWith(`${d.prefix}_`))).toBe(true);
      for (const f of studioFeatures(r.doc, MAIN_STUDIO)) {
        if (f.sketch) expect(freedomOf(f.sketch.data)).toBe(0);
        for (const v of Object.values(f.params)) expect(evaluate(v, scope).ok).toBe(true);
        if (f.apart) expect(f.operation).toBe("new");
      }
    });
  }

  it("Edit design sizes remakes an enclosure in place: a snap lid instead, a second cut-out, the same box and lid", () => {
    const r = insertDesign(emptyDocument(), design("enclosure"), valuesOf("enclosure"), { into: MAIN_STUDIO });
    const e = editInsert(r.doc, r.insert.id, valuesOf("enclosure", { fixing: "snap", port2Side: "right" }));
    const after = studioFeatures(e.doc, MAIN_STUDIO).map((f) => f.id);
    for (const end of ["_box", "_lid", "_grooves", "_ridges", "_port2"]) expect(after.some((id) => id.endsWith(end))).toBe(true);
    expect(after.some((id) => id.endsWith("_posts"))).toBe(false);
    expect(e.remade).toEqual([]);
  });
});

describe("finding them in the library", () => {
  it("under their headings, Electronics and Test prints last", () => {
    expect(GROUP_ORDER.print.slice(-2)).toEqual(["Electronics", "Test prints"]);
    const groups = designGroups("print");
    const of = (g: string) => groups.find((x) => x.group === g)!.designs.map((d) => d.id);
    expect(of("Electronics")).toEqual(["enclosure"]);
    expect(of("Test prints")).toEqual(["fit-test", "overhang-test", "bridge-test"]);
    expect(of("Workshop")).toContain("french-cleat");
    expect(of("Workshop")).toContain("cable-chain");
    expect(of("Storage")).toContain("hinged-box");
    expect(of("Desk")).toContain("desk-organiser");
    expect(of("Household")).toContain("wall-pocket");
    expect(of("Household")).toContain("shelf-pins");
  });

  it("by search", () => {
    expect(searchDesigns("raspberry")[0].id).toBe("enclosure");
    expect(searchDesigns("arduino").map((d) => d.id)).toContain("enclosure");
    expect(searchDesigns("french cleat")[0].id).toBe("french-cleat");
    expect(searchDesigns("drag chain")[0].id).toBe("cable-chain");
    expect(searchDesigns("tolerance")[0].id).toBe("fit-test");
    expect(searchDesigns("overhang")[0].id).toBe("overhang-test");
    expect(searchDesigns("bridge")[0].id).toBe("bridge-test");
    expect(searchDesigns("hinged")[0].id).toBe("hinged-box");
    expect(searchDesigns("pen")[0].id).toBe("desk-organiser");
    expect(searchDesigns("remote")[0].id).toBe("wall-pocket");
    expect(searchDesigns("shelf pins")[0].id).toBe("shelf-pins");
  });
});
