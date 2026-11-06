/**
 * The sixth batch of 3D-printing designs — moulds for casting — and the shared decorated outsides (mouldSurface.ts):
 * outlines closed and never crossing themselves, pattern depths, the draft kept towards the opening, the release rules
 * (one-piece moulds refuse what would lock the cast in, split moulds check nothing catches, masters take anything),
 * printing without supports, exact volumes in ml, plain-English problems, fully defined sketches, and finding them in
 * the library ("mold" too). Pure — the geometry is checked in engineLibraryMoulds.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO, studioFeatures } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { defaultValues, designGroups, editInsert, findDesign, GROUP_ORDER, insertDesign, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { freedomOf } from "../src/library/sketchKit";
import { crossesItself } from "../src/library/outlines";
import { areaOf } from "../src/library/designs/printShapes";
import {
  apothemAt,
  castSections,
  changesUp,
  lockedAt,
  outsideOf,
  outsideProblems,
  OUTSIDE_SHAPES,
  patternAt,
  sectionArea,
  splitCatch,
  stackVolume,
  steepestOverhang,
  SURFACE_PATTERNS,
  type CastSize,
  type OutsideShape,
  type SurfacePattern,
} from "../src/library/designs/mouldSurface";
import { FLANGE, halfChain, halfSections, HALF_GAP, pillarPlan, pillarVolumes, PEG, wickBarPlan, wickBarVolume } from "../src/library/designs/candleMould";
import { meltOutline, meltPlan, meltTrayVolume } from "../src/library/designs/meltTray";
import { cupVolumes, floatWeight, holderPlan, insideAt, potPlan, dishPlan, POCKET_DRAFT, POCKETS, PRINTED, RING_POST, SAND, WET_CONCRETE } from "../src/library/designs/castMoulds";
import { CONCRETE_DENSITY, ml, WAX_DENSITY } from "../src/library/designs/mouldKit";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const problems = (id: string, extra: DesignValues = {}) => valueProblems(design(id), valuesOf(id, extra));
const NEW = ["pillar-candle-mould", "wick-bar", "wax-melt-tray", "concrete-pot-mould", "concrete-holder-mould", "trinket-dish-mould"];
const SIZE: CastSize = { W: 60, H: 90, draft: 2 };
const outside = (shape: OutsideShape, pattern: SurfacePattern = "none", extra: DesignValues = {}) => outsideOf({ ...valuesOf("pillar-candle-mould"), shape, pattern, ...extra });
const SHAPES = OUTSIDE_SHAPES.map((s) => s.value);
const PATTERNS = SURFACE_PATTERNS.map((p) => p.value);
const frustum = (r0: number, r1: number, h: number) => (Math.PI * h * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

describe("outside shapes and patterns", () => {
  it("every shape and pattern gives closed outlines that never cross themselves, the same corners on every level", () => {
    for (const shape of SHAPES)
      for (const pattern of PATTERNS) {
        const size = shape === "dome" ? { ...SIZE, H: 25 } : SIZE;
        const s = castSections(outside(shape, pattern), size).sections;
        expect(s.length).toBeGreaterThanOrEqual(2);
        expect(s[0].z).toBe(0);
        expect(s[s.length - 1].z).toBe(size.H);
        for (const sec of s) {
          if (!sec.pts) continue;
          expect(sec.pts.length).toBe(s[0].pts!.length);
          expect(crossesItself(sec.pts)).toBe(false);
          // Anticlockwise (positive signed area).
          let signed = 0;
          for (let i = 0; i < sec.pts.length; i++) {
            const [a, b] = [sec.pts[i], sec.pts[(i + 1) % sec.pts.length]];
            signed += a[0] * b[1] - b[0] * a[1];
          }
          expect(signed).toBeGreaterThan(0);
        }
      }
  });

  it("patterns stand out by their depth, and the ones that don't change up the height don't", () => {
    for (const pattern of PATTERNS) {
      const o = outside("round", pattern);
      let [lo, hi] = [Infinity, -Infinity];
      for (let i = 0; i < 400; i++)
        for (let j = 0; j <= 40; j++) {
          const p = patternAt(o, SIZE, (2 * Math.PI * i) / 400, (SIZE.H * j) / 40);
          [lo, hi] = [Math.min(lo, p), Math.max(hi, p)];
        }
      expect(lo).toBeGreaterThanOrEqual(-1e-9);
      expect(hi).toBeLessThanOrEqual(1 + 1e-9);
      if (pattern !== "none") expect(hi).toBeGreaterThan(0.9);
      if (!changesUp(pattern)) for (const z of [0, 33, 90]) expect(patternAt(o, SIZE, 0.3, z)).toBeCloseTo(patternAt(o, SIZE, 0.3, 45), 12);
    }
    // On the cast: a round 60 mm candle with ribs reaches 30 + depth at its open end, and never less than 30.
    const s = castSections(outside("round", "ribs"), SIZE).sections;
    const top = s[s.length - 1].pts!.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...top)).toBeCloseTo(30 + 1.2, 5);
    expect(Math.min(...top)).toBeCloseTo(30, 6);
  });

  it("the draft: every section is no bigger than the one above it towards the opening, by the draft", () => {
    for (const shape of SHAPES.filter((s) => s !== "barrel" && s !== "twisted"))
      for (const pattern of ["none", "ribs", "waves"] as SurfacePattern[]) {
        const size = shape === "dome" ? { ...SIZE, H: 25 } : SIZE;
        const s = castSections(outside(shape, pattern), size).sections;
        expect(lockedAt(s, size.draft)).toBeNull();
        for (let i = 1; i < s.length; i++) expect(sectionArea(s[i])).toBeGreaterThan(sectionArea(s[i - 1]));
      }
    // The plain round one tapers by exactly the draft: 30 mm at the opening, 30 − 90·tan 2° at the closed end.
    expect(apothemAt(outside("round"), SIZE, 0)).toBeCloseTo(30 - 90 * tan(2), 9);
    // Rings and barrels get narrower going up somewhere, so they'd lock a one-piece mould.
    expect(lockedAt(castSections(outside("round", "rings"), SIZE).sections, 2)).not.toBeNull();
    expect(lockedAt(castSections(outside("barrel"), SIZE).sections, 2)).not.toBeNull();
    expect(lockedAt(castSections(outside("twisted"), SIZE).sections, 2)).not.toBeNull();
  });

  it("a split mould: patterns fade near the split, so nothing catches as the halves pull apart; a twisted one would", () => {
    for (const pattern of PATTERNS) expect(splitCatch(castSections(outside("round", pattern), SIZE, { split: true }).sections)).toBe(0);
    for (const shape of ["square", "hexagon", "octagon", "faceted", "tapered", "stepped", "barrel"] as OutsideShape[]) expect(splitCatch(castSections(outside(shape), SIZE, { split: true }).sections)).toBe(0);
    // Without the fade, ribs right at the split would catch.
    expect(splitCatch(castSections(outside("round", "ribs", { patternCount: 24 }), SIZE).sections)).toBeGreaterThan(1);
    // A twisted shape turns its faces across the split — even a small twist, even with no pattern — so it's refused.
    for (const [twist, sides] of [[45, 8], [5, 8], [45, 5], [90, 12]]) expect(splitCatch(castSections(outside("twisted", "none", { twist, sides }), SIZE, { split: true }).sections)).toBeGreaterThan(1);
    expect(splitCatch(castSections(outside("twisted", "ribs"), SIZE, { split: true }).sections)).toBeGreaterThan(1);
    // An edge crossing the split counts in both halves: one piece of it always faces back.
    const crossing = [{ z: 0, pts: [[10, -1], [10, 1], [-10, 1], [-10, -1]] as [number, number][] }];
    expect(splitCatch(crossing)).toBe(0);
    const slanted = [{ z: 0, pts: [[10, -1], [11, 1], [-10, 1], [-10, -1]] as [number, number][] }];
    expect(splitCatch(slanted)).toBeGreaterThan(20);
  });

  it("with the strict split check, every combination the pillar mould allows has nothing facing back at the split", () => {
    const d = design("pillar-candle-mould");
    let allowed = 0;
    for (const shape of SHAPES)
      for (const pattern of PATTERNS)
        for (const extra of [{}, { width: 40, height: 60 }, { width: 100, height: 150, patternCount: 5 }, { draft: 4, patternDepth: 2 }, { height: 25 }, { sides: 5 }, { sides: 12 }] as DesignValues[]) {
          const v = valuesOf("pillar-candle-mould", { shape, pattern, ...extra });
          if (valueProblems(d, v).length) continue;
          allowed++;
          expect(shape).not.toBe("twisted");
          expect(splitCatch(pillarPlan(v).cast)).toBe(0);
        }
    expect(allowed).toBe(553);
  });

  it("everything prints without supports: nothing leans over more than 45°", () => {
    for (const shape of SHAPES)
      for (const pattern of PATTERNS) {
        const size = shape === "dome" ? { ...SIZE, H: 25 } : SIZE;
        expect(steepestOverhang(castSections(outside(shape, pattern), size, { split: true }).sections)).toBeLessThanOrEqual(45);
      }
    // A deep pattern on a small cast would: refused with a plain message.
    expect(outsideProblems(outside("round", "rings", { patternDepth: 3, patternCount: 20 }), { W: 40, H: 60, draft: 2 }, "master", "wax").join(" ")).toMatch(/lean over|too much detail/);
  });

  it("the release rules, in plain English", () => {
    const rigid = (shape: OutsideShape, pattern: SurfacePattern) => outsideProblems(outside(shape, pattern), { W: 110, H: 100, draft: 3 }, "rigid", "concrete");
    expect(rigid("round", "rings")[0]).toBe(
      "Horizontal rings would lock the concrete in a one-piece mould: choose vertical ribs, waves or no pattern — or use the pillar candle's two-part mould, or make a master for silicone.",
    );
    for (const p of ["spiral", "lattice", "honeycomb", "chevron", "basket", "dots", "lowpoly"] as SurfacePattern[]) expect(rigid("round", p)[0]).toMatch(/would lock the concrete in a one-piece mould/);
    expect(rigid("barrel", "none")[0]).toMatch(/A bulging shape would lock the concrete/);
    expect(rigid("twisted", "none")[0]).toMatch(/A twisted shape would lock the concrete/);
    for (const shape of ["round", "square", "hexagon", "octagon", "faceted", "fluted", "tapered", "stepped"] as OutsideShape[])
      for (const p of ["none", "ribs", "waves"] as SurfacePattern[]) expect(rigid(shape, p)).toEqual([]);
    // Masters take anything that prints.
    for (const p of PATTERNS) expect(outsideProblems(outside("barrel", p), SIZE, "master", "wax")).toEqual([]);
    expect(problems("concrete-pot-mould", { pattern: "dots" })[0]).toMatch(/Bubbles would lock the concrete/);
    expect(problems("pillar-candle-mould", { pattern: "dots" })).toEqual([]);
    expect(problems("pillar-candle-mould", { shape: "twisted" })).toEqual(['A twisted shape would catch where the two halves pull apart: turn on "Make a master instead" and make a silicone mould from it.']);
    expect(problems("pillar-candle-mould", { shape: "twisted", pattern: "ribs" })[0]).toMatch(/^A twisted shape would catch/);
    expect(problems("pillar-candle-mould", { shape: "twisted", master: true })).toEqual([]);
    expect(problems("pillar-candle-mould", { shape: "fluted", pattern: "ribs", patternCount: 24 })[0]).toMatch(/^The vertical ribs would catch where the two halves pull apart/);
    expect(problems("pillar-candle-mould", { shape: "dome" })[0]).toMatch(/A rounded shape this wide can be at most 28\.02 mm tall/);
  });
});

describe("pillar candle mould", () => {
  it("the candle: a frustum 60 mm across its base, tapering by the draft, its volume in ml and wax weight", () => {
    const v = valuesOf("pillar-candle-mould");
    const r1 = 30;
    const r0 = 30 - 90 * tan(2);
    expect(pillarVolumes(v).cast).toBeCloseTo(frustum(r0, r1, 90), 1);
    const mlOf = Math.round(frustum(r0, r1, 90) / 100) / 10;
    expect(design("pillar-candle-mould").summary!(v)).toBe(
      `2 halves, each 96 mm wide and 92 mm tall, printed side by side. The candle: ${mlOf} ml of wax — about ${Math.round((frustum(r0, r1, 90) / 1000) * WAX_DENSITY)} g (soy wax is about 0.9 g/ml). For the wick centring bar, type a mouth width of 60 mm.`,
    );
  });

  it("the halves: a wall round the candle, a flange with pegs on one side and holes with the fit on the other, the wick hole on the axis", () => {
    const p = pillarPlan(valuesOf("pillar-candle-mould"));
    expect(p.end).toBe(2);
    expect(p.top).toBe(92);
    // The wall is 2 mm outside the candle everywhere (round: the radius + 2).
    expect(p.outer[p.outer.length - 1].r).toBeCloseTo(32, 6);
    expect(p.X).toBeCloseTo(32 + FLANGE, 6);
    expect(p.hole).toBeCloseTo(PEG + 0.2 * Math.SQRT2, 9);
    expect(p.pegZ).toEqual([2 + 30, 2 + 60]);
    expect(HALF_GAP).toBeGreaterThan(3);
    // Both halves of a symmetric candle weigh the same.
    const vol = pillarVolumes(valuesOf("pillar-candle-mould", { shape: "square" }));
    expect(vol.a).toBeCloseTo(vol.b!, 6);
  });

  it("polygon halves are made from cross-sections that each make one outline, the same corners on every level", () => {
    const p = pillarPlan(valuesOf("pillar-candle-mould", { shape: "hexagon", pattern: "ribs" }));
    expect(p.byHalves).toBe(true);
    for (const side of [1, -1] as const) {
      const s = halfSections(p, side);
      expect(s[0].z).toBe(0);
      for (const sec of s) {
        expect(sec.pts!.length).toBe(s[0].pts!.length);
        expect(crossesItself(sec.pts!)).toBe(false);
        for (const [, y] of sec.pts!) expect(side * y).toBeGreaterThanOrEqual(0);
      }
    }
    // The candle's half outline runs from the split back to the split.
    const chain = halfChain(p.cavity[1].pts!, 1);
    expect(chain[0][1]).toBe(0);
    expect(chain[chain.length - 1][1]).toBe(0);
  });

  it("a master is the candle alone, standing on its base; the summary prices the silicone", () => {
    const v = valuesOf("pillar-candle-mould", { master: true, pattern: "lattice" });
    expect(valueProblems(design("pillar-candle-mould"), v)).toEqual([]);
    expect(design("pillar-candle-mould").summary!(v)).toMatch(/^1 part: the candle, standing on its base\. It holds [\d.]+ ml of wax.* takes about [\d.]+ ml of silicone/);
  });

  it("refuses a wick hole too big for the candle", () => {
    expect(problems("pillar-candle-mould", { width: 25, wick: 6.5 })).toEqual(["Wick hole: at most 6 mm."]);
    expect(problems("pillar-candle-mould", { width: 25, wick: 6 })[0]).toBe("The wick hole is too big for a candle this narrow: make it at most 5 mm.");
  });
});

describe("wick bar and wax melt tray", () => {
  it("the wick bar: lugs just inside the mouth, a hole for the wick and a slot to it; exact volume", () => {
    const p = wickBarPlan(valuesOf("wick-bar"));
    // The default fits the pillar candle mould's default 60 mm candle.
    expect(p.span).toBe(valuesOf("pillar-candle-mould").width);
    expect(p.length).toBe(80);
    expect(p.lugOut).toBe(29.5);
    expect(p.hole).toBeCloseTo(2.4, 9);
    // 80 × 12 × 3 bar, two 3 × 12 × 4 lugs, less a 2.4 mm hole and a 1.5 mm slot (their overlap counted once).
    const R = 1.2;
    const h = 0.75;
    const overlap = h * Math.sqrt(R * R - h * h) + R * R * Math.asin(h / R);
    expect(wickBarVolume(valuesOf("wick-bar"))).toBeCloseTo(80 * 12 * 3 + 2 * 3 * 12 * 4 - (Math.PI * R * R + 1.5 * 6 - overlap) * 3, 9);
    expect(problems("wick-bar", { span: 20, wick: 6 })[0]).toMatch(/too narrow/);
  });

  it("the tray: cavities shrunk by the draft towards their floors, exact volumes", () => {
    const p = meltPlan(valuesOf("wax-melt-tray"));
    // Round, 35 across: the floor is 35 × k across, k = 1 − 15 tan 3° / 17.5.
    expect(p.k).toBeCloseTo(1 - (15 * tan(3)) / 17.5, 12);
    expect(p.cavity).toBeCloseTo(frustum(17.5 * p.k, 17.5, 15), 6);
    expect([p.W, p.L]).toEqual([3 * 35 + 4 * 2.4, 2 * 35 + 3 * 2.4]);
    expect(meltTrayVolume(valuesOf("wax-melt-tray"))).toBeCloseTo(p.W * p.L * 16.6 - 6 * p.cavity, 6);
    const sq = meltPlan(valuesOf("wax-melt-tray", { shape: "square" }));
    expect(sq.cavity).toBeCloseTo((15 / 3) * (35 * 35 + (35 * sq.k) ** 2 + 35 * 35 * sq.k), 6);
    expect(design("wax-melt-tray").summary!(valuesOf("wax-melt-tray"))).toMatch(/6 cavities of [\d.]+ ml each — [\d.]+ ml in all, about \d+ g of wax/);
  });

  it("hearts and stars: simple anticlockwise outlines the right size, every side tilted by at least the draft", () => {
    for (const shape of ["heart", "star", "square"] as const) {
      const o = meltOutline(shape, 40)!;
      expect(crossesItself(o)).toBe(false);
      const xs = o.map(([x]) => x);
      const wide = Math.max(...xs) - Math.min(...xs);
      // The heart's lobes are drawn as 20 straight pieces each, so its widest is a shade under the size.
      if (shape === "heart") expect(Math.abs(wide - 40)).toBeLessThan(0.05);
      else expect(wide).toBeCloseTo(shape === "star" ? 40 * Math.cos(Math.PI / 10) : 40, 6);
      const p = meltPlan(valuesOf("wax-melt-tray", { shape, size: 40 }));
      expect(p.d).toBeGreaterThan(5);
      expect(areaOf(o)).toBeCloseTo(p.area, 9);
    }
    expect(problems("wax-melt-tray", { shape: "star", size: 15, depth: 40, draft: 10 })[0]).toMatch(/^Too deep for a star this size with this draft: make it at most/);
    expect(problems("wax-melt-tray", { columns: 8, rows: 8, size: 40 })[0]).toMatch(/too big for most beds/);
  });
});

describe("shell and core moulds", () => {
  it("the pot: the core leaves exactly the wall square to the drafted sides, and the concrete's volume and weight", () => {
    const v = valuesOf("concrete-pot-mould");
    const p = potPlan(v);
    // Round: the cast is a frustum 110 across at the top; the core's outside 10 / cos 3° inside it.
    const k = tan(3);
    const at = (z: number) => 55 - (100 - z) * k;
    expect(insideAt(p.o, p.b, 10, 50)).toBeCloseTo(at(50) - 10 * Math.sqrt(1 + k * k), 9);
    const pin = frustum(6 - 12 * k, 6, 12);
    const core = frustum(at(12) - 10 * Math.sqrt(1 + k * k), at(100) - 10 * Math.sqrt(1 + k * k), 88);
    const vol = cupVolumes(p);
    // (Sections are kept to 6 decimal places, so to within a hundredth of a mm³.)
    expect(vol.cast).toBeCloseTo(frustum(at(0), at(100), 100) - core - pin, 1);
    expect(design("concrete-pot-mould").summary!(v)).toBe(
      `2 parts: the shell and the core, side by side. The pot: ${ml(vol.cast)} ml of concrete or Jesmonite — about ${Math.round((vol.cast / 1000) * CONCRETE_DENSITY)} g (about 2.1 g/ml). Wet concrete is heavier than the core even full of sand, so it floats: put at least ${floatWeight(p).weight} g on its flange (a bag of sand, a tin), or tape or clamp it to the shell.`,
    );
    // The core's flange rests on the shell's rim, its lip round the outside with the fit.
    expect(p.flange.z).toBe(p.rim);
    expect(p.lipInside.r! - p.outerRim).toBeCloseTo(0.3, 9);
    expect(p.holes.length).toBe(4);
    // A square pot lies square to the bed, its core beside it.
    const sq = potPlan(valuesOf("concrete-pot-mould", { shape: "square" }));
    expect(Math.abs(sq.cast[1].pts![0][0])).toBeCloseTo(55, 6);
    expect(sq.holes.length).toBe(4);
  });

  it("the holder: a pocket for a tealight (39 mm + room, 18 deep) or a 22 mm taper; a cube is as tall as it's wide", () => {
    expect(POCKETS.tealight.bottom).toBeGreaterThan(39);
    expect(POCKETS.tealight.depth).toBe(18);
    const p = holderPlan(valuesOf("concrete-holder-mould"));
    expect(p.plug[0].r).toBe(39.6 / 2);
    expect(p.plug[1].r).toBeCloseTo(19.8 + 18 * tan(POCKET_DRAFT), 6);
    expect(p.plug[1].z - p.plug[0].z).toBe(18);
    const cube = holderPlan(valuesOf("concrete-holder-mould", { shape: "cube" }));
    expect(cube.b.H).toBe(cube.b.W);
    const taper = holderPlan(valuesOf("concrete-holder-mould", { pocket: "taper" }));
    const vol = cupVolumes(taper);
    expect(vol.cast).toBeCloseTo(stackVolume(taper.cast) - frustum(10.9, 10.9 + 25 * tan(1), 25), 2);
    expect(problems("concrete-holder-mould", { width: 50 })[0]).toMatch(/Too narrow round the pocket/);
    expect(problems("concrete-holder-mould", { height: 25 })[0]).toMatch(/Make it at least 26 mm tall/);
  });

  it("the dish: sloping sides, a raised centre if asked, refused when too shallow", () => {
    const p = dishPlan(valuesOf("trinket-dish-mould", { centre: true }));
    expect(p.recess.length).toBe(3);
    expect(p.b.lean).toBe(25);
    const vol = cupVolumes(p);
    const plain = cupVolumes(dishPlan(valuesOf("trinket-dish-mould")));
    expect(vol.cast).toBeGreaterThan(plain.cast);
    expect(problems("trinket-dish-mould", { height: 10, floor: 8 })[0]).toMatch(/Make the dish at least 13 mm tall/);
  });
});

describe("the holder's pocket", () => {
  it("keeps its own 1° draft whatever the mould's, so a 39 mm tealight and a 22 mm taper go all the way in", () => {
    for (const draft of [1, 3, 5, 10]) {
      const t = holderPlan(valuesOf("concrete-holder-mould", { draft }));
      // A tealight is 38–39 mm across and about 15 mm tall: 39.5 mm or more all the way down to 18 mm.
      expect(2 * t.plug[0].r!).toBeGreaterThanOrEqual(39.5);
      expect(t.plug[1].z - t.plug[0].z).toBe(18);
      const k = holderPlan(valuesOf("concrete-holder-mould", { draft, pocket: "taper" }));
      // A 7/8" (22.2 mm) taper candle: about 23 mm at the top, 21.5–22 at the bottom 25 mm down.
      expect(2 * k.plug[1].r!).toBeGreaterThan(22.5);
      expect(2 * k.plug[1].r!).toBeLessThan(23.2);
      expect(2 * k.plug[0].r!).toBeGreaterThanOrEqual(21.5);
      expect(2 * k.plug[0].r!).toBeLessThanOrEqual(22);
      expect(k.plug[1].z - k.plug[0].z).toBe(25);
    }
  });
});

describe("holding the inner piece down", () => {
  it("works out the weight: what it pushes aside × wet concrete, less sand in it and its plastic, a quarter extra, to the next 50 g", () => {
    const p = potPlan(valuesOf("concrete-pot-mould"));
    const f = floatWeight(p);
    const pin = frustum(p.pin!.r0, p.pin!.r1, p.pin!.z1 - p.pin!.z0);
    expect(f.displaced).toBeCloseTo(stackVolume(p.core) + pin, 6);
    expect(f.sand).toBeCloseTo(stackVolume(p.hollow, p.hollow[0].z, p.top), 6);
    const net = (f.displaced * WET_CONCRETE - f.sand * SAND - f.plastic * PRINTED) / 1000;
    expect(net).toBeGreaterThan(256);
    expect(f.weight).toBe(Math.ceil((net * 1.25) / 50) * 50);
    // A 200 mm pot needs kilos.
    expect(floatWeight(potPlan(valuesOf("concrete-pot-mould", { width: 200, height: 180, wall: 3 }))).weight).toBeGreaterThan(2400);
    // The holder's insert and the dish's core float too.
    const h = holderPlan(valuesOf("concrete-holder-mould"));
    expect(floatWeight(h).displaced).toBeCloseTo(frustum(h.plug[0].r!, h.plug[1].r!, 18), 6);
    expect(floatWeight(h).weight).toBeGreaterThan(0);
    expect(floatWeight(dishPlan(valuesOf("trinket-dish-mould"))).weight).toBeGreaterThan(0);
    for (const id of ["concrete-holder-mould", "trinket-dish-mould"]) expect(design(id).summary!(valuesOf(id))).toMatch(/floats: put at least \d+ g on its flange.*or tape or clamp it to the shell/);
    for (const id of ["concrete-pot-mould", "concrete-holder-mould", "trinket-dish-mould"]) expect(design(id).description).toMatch(/put a weight on .*or tape or clamp it to the shell/);
  });

  it("big moulds: a bed check for every shell-and-core mould, and a note about the wall", () => {
    expect(problems("concrete-holder-mould", { width: 140 })[0]).toMatch(/^The shell and insert side by side are [\d.]+ mm across, too wide for most beds \(250 mm\)/);
    expect(problems("trinket-dish-mould", { width: 150 })[0]).toMatch(/too wide for most beds/);
    expect(problems("concrete-pot-mould", { width: 130 })[0]).toMatch(/too wide for most beds/);
    expect(problems("concrete-holder-mould", { shape: "cube", width: 140 })[0]).toMatch(/too wide for most beds/);
    expect(design("concrete-pot-mould").summary!(valuesOf("concrete-pot-mould", { width: 160 }))).toMatch(/a mould wall of 3 mm or more/);
    expect(design("concrete-pot-mould").summary!(valuesOf("concrete-pot-mould", { width: 160, wall: 3 }))).not.toMatch(/a mould wall of 3 mm/);
  });

  it("the dish's raised centre stays a ring post", () => {
    const big = dishPlan(valuesOf("trinket-dish-mould", { width: 250, centre: true }));
    expect(big.recess[1].r).toBe(RING_POST);
  });
});

describe("every mould", () => {
  const variants: [string, DesignValues][] = [
    ...NEW.map((id): [string, DesignValues] => [id, {}]),
    ["pillar-candle-mould", { shape: "hexagon", pattern: "ribs" }],
    ["pillar-candle-mould", { shape: "faceted", sides: 8, pattern: "dots" }],
    ["pillar-candle-mould", { pattern: "honeycomb" }],
    ["pillar-candle-mould", { master: true, shape: "twisted", pattern: "spiral" }],
    ["wax-melt-tray", { shape: "heart" }],
    ["wax-melt-tray", { shape: "star", columns: 1, rows: 1 }],
    ["concrete-pot-mould", { shape: "fluted", drain: false }],
    ["concrete-pot-mould", { shape: "stepped", pattern: "waves" }],
    ["concrete-holder-mould", { shape: "dome", height: 30 }],
    ["concrete-holder-mould", { shape: "cube" }],
    ["trinket-dish-mould", { shape: "hexagon", centre: true }],
  ];
  for (const [id, extra] of variants) {
    it(`${design(id).name}${Object.keys(extra).length ? ` (${JSON.stringify(extra)})` : ""}: works with its defaults, every sketch fully defined, advice at the end`, () => {
      const d = design(id);
      const values = valuesOf(id, extra);
      expect(valueProblems(d, values)).toEqual([]);
      expect(d.category).toBe("print");
      expect(d.group).toBe("Moulds and casting");
      expect(d.description).toMatch(/PETG|PLA/);
      expect(d.preview(values).some((s) => s.kind === "poly")).toBe(true);
      expect(d.summary!(values)!.length).toBeGreaterThan(10);
      const r = insertDesign(emptyDocument(), d, values, { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      setCurrentScope(scope);
      for (const f of studioFeatures(r.doc, MAIN_STUDIO)) {
        if (f.sketch) expect(freedomOf(f.sketch.data)).toBe(0);
        for (const v of Object.values(f.params)) expect(evaluate(v, scope).ok).toBe(true);
        if (f.apart) expect(f.operation).toBe("new");
      }
    });
  }

  it("Edit design sizes turns a mould into a master and back", () => {
    const r = insertDesign(emptyDocument(), design("pillar-candle-mould"), valuesOf("pillar-candle-mould"), { into: MAIN_STUDIO });
    const e = editInsert(r.doc, r.insert.id, valuesOf("pillar-candle-mould", { master: true }));
    const ids = studioFeatures(e.doc, MAIN_STUDIO).map((f) => f.id);
    expect(ids.some((id) => id.endsWith("_master"))).toBe(true);
    expect(ids.some((id) => id.endsWith("_half-a"))).toBe(false);
  });

  it("wax and concrete advice where it belongs", () => {
    expect(design("pillar-candle-mould").description).toMatch(/soy wax is usually poured at about 55–70 °C.*PLA starts to soften at about 55–60 °C/);
    expect(design("pillar-candle-mould").description).toMatch(/silicone mould/);
    for (const id of ["concrete-pot-mould", "concrete-holder-mould", "trinket-dish-mould"]) expect(design(id).description).toMatch(/release agent \(vaseline, cooking spray or a proper release spray\).*layer line/);
  });
});

describe("finding them in the library", () => {
  it("under their own heading, after Household", () => {
    const order = GROUP_ORDER.print;
    expect(order.indexOf("Moulds and casting")).toBe(order.indexOf("Household") + 1);
    const of = designGroups("print").find((g) => g.group === "Moulds and casting")!.designs.map((d) => d.id);
    expect(of).toEqual(NEW);
  });

  it("by search, British or American spelling", () => {
    expect(searchDesigns("candle").map((d) => d.id).slice(0, 2)).toEqual(["pillar-candle-mould", "concrete-holder-mould"]);
    const concrete = searchDesigns("concrete").map((d) => d.id);
    for (const id of ["concrete-pot-mould", "concrete-holder-mould", "trinket-dish-mould"]) expect(concrete).toContain(id);
    expect(searchDesigns("centering")[0].id).toBe("wick-bar");
    expect(searchDesigns("center bar")[0].id).toBe("wick-bar");
    for (const word of ["mould", "mold", "molds"]) {
      const found = searchDesigns(word).map((d) => d.id);
      for (const id of ["pillar-candle-mould", "wax-melt-tray", "concrete-pot-mould", "concrete-holder-mould", "trinket-dish-mould"]) expect(found).toContain(id);
    }
    expect(searchDesigns("tealight").map((d) => d.id)).toContain("concrete-holder-mould");
    expect(searchDesigns("wick")[0].id).toBe("wick-bar");
    expect(searchDesigns("soap")[0].id).toBe("wax-melt-tray");
    expect(searchDesigns("ring dish")[0].id).toBe("trinket-dish-mould");
    expect(searchDesigns("jesmonite").map((d) => d.id)).toContain("concrete-pot-mould");
  });
});
