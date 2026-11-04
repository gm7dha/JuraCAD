/**
 * The third batch of laser designs, pure: the jigsaw's maths (tabs that lock, pieces that tile without overlapping,
 * the same seed giving the same puzzle), the sliding-lid box's grooves, the tray's halving slots, the bookend's slots,
 * the clock's layout, the ornament's shapes — and every sketch fully defined where it can be.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { setCurrentScope, evaluate } from "../src/model/expr";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, editInsert, findDesign, insertDesign, laserDefaultsFor, valueProblems, currentValues } from "../src/library/insert";
import { freedomOf } from "../src/library/sketchKit";
import { areaOf, grow, type Pt } from "../src/library/fingers";
import { lit } from "../src/library/ex";
import { allEdges, arcPoints, edgePolyline, FOOT, HEAD_RISE, makePuzzle, narrowestGap, NECK, pieceOutline, puzzleProblems, seeded, SHOULDER, TAB_RISE, tabEdge, type P2 } from "../src/library/puzzle";
import { puzzleSketch, puzzleSpec } from "../src/library/designs/jigsaw";
import { bookend, bookendOutlines, dividerOutlines, dividerTray, slidingBox, slidingOutlines } from "../src/library/designs/boxes3";
import { clockLayout, CLOCK_EDGE, winderShape } from "../src/library/designs/laserHome3";
import { FLAKE, ornamentPolygon, ornamentShape, ornamentSketch } from "../src/library/designs/ornament";
import { sketchAreas } from "../src/sketch/areas";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const flat = (p: Pt[]): P2[] => p.map(([x, y]) => [x.v, y.v]);
const area = (poly: P2[]) => Math.abs(poly.reduce((a, [x1, y1], i) => a + x1 * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * y1, 0)) / 2;

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

describe("jigsaw maths", () => {
  const spec = puzzleSpec(valuesOf("jigsaw"));

  it("each tab's arcs meet smoothly, and its neck is narrower than its head (so it locks)", () => {
    expect(FOOT).toBeCloseTo(Math.sqrt((1 + SHOULDER) ** 2 - (HEAD_RISE - SHOULDER) ** 2), 9);
    expect(NECK).toBeLessThan(1);
    expect(TAB_RISE).toBe(HEAD_RISE + 1);
    for (const side of [1, -1] as const) {
      const e = tabEdge([0, 0], [40, 0], side, 20, 4);
      // Ends of the pieces join up, and at each join the curves go the same way (each arc's tangent there is square to
      // its radius; neighbouring arcs at a join share the line through both centres).
      const [s1, head, s2] = e.arcs;
      for (const a of e.arcs) expect(Math.hypot(a.start[0] - a.centre[0], a.start[1] - a.centre[1])).toBeCloseTo(a.r, 5);
      for (const a of e.arcs) expect(Math.hypot(a.end[0] - a.centre[0], a.end[1] - a.centre[1])).toBeCloseTo(a.r, 5);
      const touch = (a: typeof s1, b: typeof s1, p: P2) => {
        const u = [p[0] - a.centre[0], p[1] - a.centre[1]];
        const v = [p[0] - b.centre[0], p[1] - b.centre[1]];
        expect(Math.abs(u[0] * v[1] - u[1] * v[0])).toBeLessThan(1e-4);
      };
      touch(s1, head, e.points[2]);
      touch(head, s2, e.points[3]);
      // The shoulders sit on the edge's line: square to it at their feet (the straight runs carry straight on).
      expect(s1.centre[0]).toBeCloseTo(e.points[1][0], 6);
      expect(s2.centre[0]).toBeCloseTo(e.points[4][0], 6);
      // Measured across the tab, along lines parallel to the edge: widest in the head, narrowest at the neck.
      const poly = edgePolyline(e, 200);
      const widthAt = (y: number) => {
        const xs: number[] = [];
        for (let i = 0; i + 1 < poly.length; i++) {
          const [a, b] = [poly[i], poly[i + 1]];
          if ((a[1] - y) * (b[1] - y) < 0) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
        return xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
      };
      const ys = Array.from({ length: 400 }, (_, i) => side * (0.01 + (i / 400) * (TAB_RISE * 4 - 0.02)));
      const widths = ys.map(widthAt);
      const head2 = Math.max(...widths.slice(200));
      const neck = Math.min(...widths.slice(0, 200).filter((_, i) => Math.abs(ys[i]) > SHOULDER * 4 * 0.5));
      expect(head2).toBeCloseTo(8, 1);
      expect(neck).toBeCloseTo(2 * NECK * 4, 1);
      expect(neck).toBeLessThan(head2 * 0.7);
      // It pokes out the way it says, TAB_RISE × R.
      expect(Math.max(...poly.map((p) => side * p[1]))).toBeCloseTo(TAB_RISE * 4, 2);
    }
  });

  it("the same pattern number always gives the same puzzle; another gives another", () => {
    const a = makePuzzle(spec);
    const b = makePuzzle(spec);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = makePuzzle({ ...spec, seed: spec.seed + 1 });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
    expect(seeded(7)()).toBe(seeded(7)());
    // Tabs point both ways.
    const sides = allEdges(a).map((e) => e.side);
    expect(sides).toContain(1);
    expect(sides).toContain(-1);
    // And the sketch is made the same way each time (Edit design sizes remakes it exactly).
    expect(puzzleSketch(spec).points.map((p) => [p.x, p.y])).toEqual(puzzleSketch(spec).points.map((p) => [p.x, p.y]));
  });

  for (const seed of [1, 2, 3, 42, 999]) {
    it(`pieces tile the board without overlapping (pattern ${seed})`, () => {
      const p = makePuzzle({ ...spec, seed });
      expect(narrowestGap(p)).toBeGreaterThan(2);
      const pieces = Array.from({ length: spec.rows * spec.columns }, (_, i) => pieceOutline(p, Math.floor(i / spec.columns), i % spec.columns));
      const total = pieces.reduce((n, q) => n + area(q), 0);
      expect(total).toBeCloseTo(spec.width * spec.height, 0);
      // Each piece's middle-ish (the middle of its grid cell) is in that piece only.
      pieces.forEach((_, i) => {
        const c: P2 = [((i % spec.columns) + 0.5) * p.pw, (Math.floor(i / spec.columns) + 0.5) * p.ph];
        expect(pieces.filter((r) => inside(c, r)).map((r) => pieces.indexOf(r))).toEqual([i]);
      });
      // The sketch the design makes divides the board into exactly these pieces.
      const map = sketchAreas(puzzleSketch({ ...spec, seed }));
      expect(map.areas).toHaveLength(spec.rows * spec.columns);
      expect(map.areas.reduce((n, a) => n + a.area, 0)).toBeCloseTo(spec.width * spec.height, 3);
    });
  }

  it("says plainly when tabs would crowd each other or pieces are too small", () => {
    expect(puzzleProblems(spec)).toEqual([]);
    expect(valueProblems(design("jigsaw"), valuesOf("jigsaw", { rows: 20, columns: 30 }))[0]).toMatch(/at most 400/);
    expect(valueProblems(design("jigsaw"), valuesOf("jigsaw", { width: 30, height: 30, rows: 4, columns: 4 }))[0]).toMatch(/only 7\.5 mm across/);
    expect(valueProblems(design("jigsaw"), valuesOf("jigsaw", { rows: 1, columns: 8 }))[0]).toMatch(/long and thin/);
    expect(valueProblems(design("jigsaw"), valuesOf("jigsaw", { rows: 1, columns: 1 }))[0]).toMatch(/at least 2/);
    // Every tab size the box allows, at a few patterns, leaves room between the cuts.
    for (const tab of [15, 25, 32]) for (const seed of [0, 5, 77]) expect(narrowestGap(makePuzzle({ ...spec, tab: tab / 100, seed }))).toBeGreaterThan(1.5);
  });

  it("refuses necks too thin to hold, and only suggests a pattern number that works", () => {
    expect(valueProblems(design("jigsaw"), valuesOf("jigsaw", { width: 120, height: 100, rows: 10, columns: 12, tab: 15 }))[0]).toMatch(/necks would be only/);
    // Thicker sheet than the neck: too thin too.
    expect(valueProblems(design("jigsaw"), valuesOf("jigsaw", { width: 100, height: 100, rows: 6, columns: 6, tab: 15, thickness: 6 }))[0]).toMatch(/necks would be only/);
    // Within the tab sizes the window allows, tabs never crowd each other (the gap check is a safety net); past them
    // they do, and the message names a pattern number only when that one really works.
    const crowded = (seed: number, tab: number) => puzzleProblems({ ...spec, tab, seed, minNeck: 3 });
    let named = 0;
    let none = 0;
    for (const tab of [0.4, 0.5])
      for (let seed = 0; seed < 30; seed++) {
        const p = crowded(seed, tab);
        if (!p.length) continue;
        const m = /try (\d+)/.exec(p[0]);
        if (m) {
          named++;
          expect(crowded(Number(m[1]), tab)).toEqual([]);
        } else {
          none++;
          expect(p[0]).toMatch(/make the tabs smaller/);
          expect(p[0]).not.toMatch(/pattern number/);
        }
      }
    expect(named + none).toBeGreaterThan(0);
  });

  it("the arc points run round the right way", () => {
    const e = tabEdge([0, 0], [40, 0], 1, 20, 4);
    const head = arcPoints(e.arcs[1], 8);
    expect(Math.max(...head.map((p) => p[1]))).toBeCloseTo(HEAD_RISE * 4 + 4, 1);
  });
});

describe("sliding-lid box", () => {
  const v = valuesOf("sliding-lid-box");

  it("grooves exactly the lid plus clearance, the low end level with their floor, the slot open at that end", () => {
    const s = slidingBox(v);
    expect(s.g1.v - s.g0.v).toBeCloseTo(3 + 2 * 0.2, 9);
    expect(s.b.H.v - s.g1.v).toBeCloseTo(6, 9);
    const o = slidingOutlines(s);
    const right = flat(o.right);
    expect(Math.max(...right.map((p) => p[1]))).toBeCloseTo(s.g0.v, 9);
    // The rail: a C whose slot reaches the right-hand end.
    const rail = flat(o.rail);
    expect(rail).toHaveLength(8);
    expect(Math.max(...rail.map((p) => p[0]))).toBeCloseTo(160 - 3, 9);
    expect(area(rail)).toBeCloseTo((154 * 57) - (148 * 3.4), 6);
    // The lid: from past the bridge to the box's right-hand face, clear of the walls either side.
    const lid = flat(o.lid);
    expect(Math.min(...lid.map((p) => p[0]))).toBeCloseTo(3 + 6 + 0.2, 9);
    expect(Math.max(...lid.map((p) => p[1])) - Math.min(...lid.map((p) => p[1]))).toBeCloseTo(100 - 6 - 0.4, 9);
    // The front's right-hand fingers stop at the low end's height and match its count.
    expect(s.counts.low % 2).toBe(1);
  });

  it("refuses sizes that don't leave room for the grooves", () => {
    expect(valueProblems(design("sliding-lid-box"), valuesOf("sliding-lid-box", { height: 22 }))[0]).toMatch(/too low/);
    expect(valueProblems(design("sliding-lid-box"), valuesOf("sliding-lid-box", { width: 35, hole: true }))[0]).toMatch(/finger hole/);
    expect(valueProblems(design("sliding-lid-box"), valuesOf("sliding-lid-box", { width: 35, hole: false }))).toEqual([]);
  });

  it("follows its variables (made again with a new height in Edit design sizes)", () => {
    const r = insertDesign(emptyDocument(), design("sliding-lid-box"), v, { into: MAIN_STUDIO });
    expect(r.doc.variables!.map((x) => x.name)).toEqual(["slidebox_width", "slidebox_depth", "slidebox_height", "slidebox_thickness", "slidebox_clearance", "slidebox_kerf"]);
    const e = editInsert(r.doc, r.insert.id, { ...currentValues(r.doc, r.insert), height: 80, hole: false });
    expect(e.doc.features.map((f) => f.id)).toEqual(r.doc.features.map((f) => f.id));
    const lid = e.doc.features.find((f) => f.name === "Lid sketch")!;
    expect(lid.sketch!.data.curves.filter((c) => c.type === "circle")).toHaveLength(0);
  });
});

describe("tray with dividers", () => {
  it("dividers cross-halve: slots half their height, as wide as the sheet (less the kerf), where the others cross", () => {
    const v = valuesOf("divider-tray", { kerf: 0.2 });
    const d = dividerTray(v);
    expect(d.rowAt).toHaveLength(1);
    expect(d.columnAt).toHaveLength(2);
    // Equal compartments: (200 − 4 × 3) / 3 wide.
    const cell = (200 - 4 * 3) / 3;
    expect(d.columnAt[0].v).toBeCloseTo(3 + cell + 1.5, 9);
    expect(d.columnAt[1].v - d.columnAt[0].v).toBeCloseTo(cell + 3, 9);
    const o = dividerOutlines(d);
    const x = flat(o.alongX);
    // Two slots down from the top to half way (z = (50 + 3) / 2).
    expect(x.filter((p) => Math.abs(p[1] - 26.5) < 1e-9)).toHaveLength(4);
    const slot = x.filter((p) => Math.abs(p[1] - 26.5) < 1e-9).map((p) => p[0]).sort((a, b) => a - b);
    expect(slot[1] - slot[0]).toBeCloseTo(3, 9);
    expect(area(x)).toBeCloseTo((200 - 6.5) * 47 - 2 * 3 * 23.5, 6);
    const y = flat(o.alongY);
    expect(y.filter((p) => Math.abs(p[1] - 26.5) < 1e-9)).toHaveLength(2);
    // As drawn for the laser (every edge kerf / 2 further out), each slot is the kerf narrower: 3 − 0.2 = 2.8 mm,
    // and the cut slot comes out 3 mm, a snug fit on the sheet.
    const drawn = flat(grow(o.alongX, lit(0.1)));
    const drawnSlot = drawn.filter((p) => Math.abs(p[1] - (26.5 + 0.1)) < 1e-9).map((p) => p[0]).sort((a, b) => a - b);
    expect(drawnSlot).toHaveLength(4);
    expect(drawnSlot[1] - drawnSlot[0]).toBeCloseTo(2.8, 9);
    const drawnY = flat(grow(o.alongY, lit(0.1)));
    const ySlot = drawnY.filter((p) => Math.abs(p[1] - (26.5 - 0.1)) < 1e-9).map((p) => p[0]).sort((a, b) => a - b);
    expect(ySlot[1] - ySlot[0]).toBeCloseTo(2.8, 9);
  });

  it("with one row or column there are dividers one way only, or none", () => {
    const one = dividerTray(valuesOf("divider-tray", { rows: 1, columns: 1 }));
    expect(one.rowAt).toHaveLength(0);
    expect(one.columnAt).toHaveLength(0);
    const r = insertDesign(emptyDocument(), design("divider-tray"), valuesOf("divider-tray", { rows: 1, columns: 4 }), { into: MAIN_STUDIO });
    expect(r.doc.features.filter((f) => f.name.startsWith("Divider across"))).toHaveLength(0);
    expect(Object.values(r.doc.partNames!).filter((n) => n.includes("divider front to back"))).toHaveLength(3);
    expect(valueProblems(design("divider-tray"), valuesOf("divider-tray", { columns: 12, width: 100 }))[0]).toMatch(/compartments would be only/);
  });
});

describe("bookend", () => {
  it("each tab has its slot, the same size and in the same place", () => {
    const b = bookend(valuesOf("bookend"));
    const o = bookendOutlines(b);
    const up = flat(o.upright);
    // The upright's tabs (y between ±0.2 W and ±0.4 W, below the base's top) go into the base's first two slots.
    const tabs = [[-48, -24], [24, 48]];
    const slots = o.baseSlots.map(flat);
    for (const [i, [y0, y1]] of tabs.entries()) {
      expect(up.some((p) => p[0] === y0 && p[1] === 0)).toBe(true);
      expect(up.some((p) => p[0] === y1 && p[1] === 0)).toBe(true);
      expect(Math.min(...slots[i].map((p) => p[1]))).toBeCloseTo(y0, 9);
      expect(Math.max(...slots[i].map((p) => p[1]))).toBeCloseTo(y1, 9);
      expect(Math.max(...slots[i].map((p) => p[0])) - Math.min(...slots[i].map((p) => p[0]))).toBeCloseTo(3, 9);
    }
    // The brace's two tabs: down into the base's third slot and back into the upright's slot.
    const brace = flat(o.brace);
    const third = slots[2];
    expect(brace.filter((p) => p[1] === 0).map((p) => p[0]).sort((a, c) => a - c)).toEqual([Math.min(...third.map((p) => p[0])), Math.max(...third.map((p) => p[0]))]);
    const z = flat(o.uprightSlot).map((p) => p[1]);
    expect(brace.filter((p) => p[0] === b.ux.v + 3).map((p) => p[1]).sort((a, c) => a - c)).toEqual([Math.min(...z), Math.max(...z)]);
    expect(areaOf(o.brace)).toBeGreaterThan(0);
    // The base is as long as the "Base depth" says, front to back.
    const base = flat(o.base).map((p) => p[0]);
    expect(Math.max(...base) - Math.min(...base)).toBeCloseTo(160, 9);
  });
});

describe("clock face", () => {
  it("twelve marks, the quarters longer, numbers inside them and clear of the middle", () => {
    const L = clockLayout(valuesOf("clock-face"));
    expect(L.marks).toHaveLength(12);
    expect(L.marks.filter(([, r0, r1]) => r1 - r0 === 18)).toHaveLength(4);
    expect(L.marks.every(([, , r1]) => r1 === 125 - CLOCK_EDGE)).toBe(true);
    expect(L.numbers.map((n) => n.lines[0])).toEqual(["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    // 12 at the top, 3 on the right.
    expect(L.numbers[0].centre![0]).toBeCloseTo(0, 6);
    expect(L.numbers[0].centre![1]).toBeGreaterThan(0);
    expect(L.numbers[3].centre![0]).toBeGreaterThan(0);
    expect(L.hole).toBe(8);
    expect(clockLayout(valuesOf("clock-face", { numbers: "quarters" })).numbers).toHaveLength(4);
    expect(valueProblems(design("clock-face"), valuesOf("clock-face", { height: 40 }))[0]).toMatch(/numbers/);
    expect(valueProblems(design("clock-face"), valuesOf("clock-face", { diameter: 80, mark: 30 }))[0]).toMatch(/too long/);
  });

  it("Export for laser scores the marks when asked, and engraves the numbers", () => {
    const r = insertDesign(emptyDocument(), design("clock-face"), valuesOf("clock-face", { marks: "score" }), { into: MAIN_STUDIO });
    const sketch = r.doc.features.find((f) => f.name === "Clock sketch")!;
    expect(laserDefaultsFor(r.doc, sketch.id)).toEqual({ text: "engrave", open: "score" });
    expect(sketch.sketch!.data.curves.filter((c) => c.type === "line")).toHaveLength(12);
  });
});

describe("ornaments", () => {
  it("the heart's straight sides touch its lobes exactly, and every shape holds its hole and words", () => {
    const h = ornamentShape(valuesOf("ornament", { shape: "heart" }));
    const [side, lobe] = [h.steps[0], h.steps[1]];
    const dir = [side.to[0] - h.start[0], side.to[1] - h.start[1]];
    const radius = [side.to[0] - lobe.centre![0], side.to[1] - lobe.centre![1]];
    expect(Math.abs(dir[0] * radius[0] + dir[1] * radius[1]) / Math.hypot(dir[0], dir[1]) / Math.hypot(radius[0], radius[1])).toBeLessThan(1e-6);
    for (const shape of ["star", "heart", "circle", "snowflake"]) {
      const v = valuesOf("ornament", { shape });
      expect(valueProblems(design("ornament"), v)).toEqual([]);
      const s = ornamentShape(v);
      const poly = ornamentPolygon(s);
      expect(inside(s.hole!.c, poly)).toBe(true);
      expect(area(poly)).toBeGreaterThan(500);
    }
    // The snowflake's branches stay clear of the next arm: they're parallel to it, 0.866 × branchAt − 2 × arm away.
    expect(0.866 * FLAKE.branchAt - 2 * FLAKE.arm).toBeGreaterThan(0.3);
    expect(valueProblems(design("ornament"), valuesOf("ornament", { words: "CHRISTMAS 2026" }))[0]).toMatch(/don't fit on the star/);
    expect(valueProblems(design("ornament"), valuesOf("ornament", { shape: "star", size: 25, hole: 8 }))[0]).toMatch(/hole is too big/);
  });
});

describe("ornament outlines never cross themselves", () => {
  for (const shape of ["star", "heart", "circle", "snowflake"])
    it(`${shape}: every size and hole it accepts makes one clean plate (and a hole)`, () => {
      let accepted = 0;
      for (const size of [25, 28, 30, 35, 40, 45, 50, 55, 60, 68, 75, 86, 100, 120, 150, 200, 280])
        for (let hole = 0; hole <= 20; hole += 2) {
          const v = valuesOf("ornament", { shape, size, hole, words: "" });
          if (valueProblems(design("ornament"), v).length) continue;
          accepted++;
          const s = ornamentShape(v);
          // Worked out by the sketch's own area finder, not the design's check: a crossing outline makes extra slivers.
          const map = sketchAreas(ornamentSketch(s));
          expect(map.areas.length, `${shape} ${size} ${hole}`).toBe(s.hole ? 2 : 1);
          // Together the areas fill the outline (the plate and the hole in it), nothing more.
          const whole = area(ornamentPolygon(s));
          expect(Math.abs(map.areas.reduce((n, a) => n + a.area, 0) - whole) / whole, `${shape} ${size} ${hole}`).toBeLessThan(0.01);
        }
      expect(accepted).toBeGreaterThan(100);
    });

  it("a big hole on a small snowflake: the top arm goes without its branches, or it's refused in plain words", () => {
    const s = ornamentShape(valuesOf("ornament", { shape: "snowflake", size: 55, hole: 4 }));
    expect(valueProblems(design("ornament"), valuesOf("ornament", { shape: "snowflake", size: 55, hole: 4, words: "" }))).toEqual([]);
    // The top arm (the first 13 steps of a full arm) has fewer steps than the others.
    expect(s.steps.length).toBeLessThan(6 * 13);
    expect(valueProblems(design("ornament"), valuesOf("ornament", { shape: "snowflake", size: 25, hole: 20 }))[0]).toMatch(/cross itself|too thin|hole is too big/);
  });
});

describe("cord winders", () => {
  it("an H with a slit in one end", () => {
    const w = winderShape(valuesOf("cord-winder"));
    expect(w.outline).toHaveLength(16);
    expect(area(w.outline)).toBeCloseTo(70 * 40 - 2 * 10 * (70 - 2 * 13) - 2.5 * 10, 6);
  });
});

describe("every design in this batch", () => {
  const variants: [string, DesignValues, boolean][] = [
    ["sliding-lid-box", {}, true],
    ["sliding-lid-box", { hole: false, kerf: 0.15 }, true],
    ["divider-tray", {}, true],
    ["divider-tray", { rows: 4, columns: 1, kerf: 0.1 }, true],
    ["bookend", {}, true],
    ["clock-face", {}, true],
    ["clock-face", { marks: "score", numbers: "quarters" }, true],
    ["clock-face", { marks: "none", numbers: "none" }, true],
    ["cord-winder", {}, true],
    ["tealight", {}, true],
    ["tealight", { shape: "round", rings: 1 }, true],
    ["tealight", { shape: "square" }, true],
    ["ornament", {}, true],
    ["ornament", { shape: "circle" }, true],
    // Curved outlines made of arcs end to end: their points are left free (like the jigsaw's), made again exactly by Edit design sizes.
    ["ornament", { shape: "heart" }, false],
    ["ornament", { shape: "snowflake" }, false],
    ["jigsaw", { rows: 3, columns: 3 }, false],
  ];
  for (const [id, extra, defined] of variants) {
    it(`${design(id).name} ${JSON.stringify(extra)}: works${defined ? ", every sketch fully defined" : ""}`, () => {
      const d = design(id);
      const values = valuesOf(id, extra);
      expect(valueProblems(d, values)).toEqual([]);
      expect(d.category).toBe("laser");
      expect(d.group).toBeDefined();
      expect(d.preview(values).length).toBeGreaterThan(0);
      expect(d.summary!(values)!.length).toBeGreaterThan(10);
      const r = insertDesign(emptyDocument(), d, values, { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      setCurrentScope(scope);
      expect(r.doc.variables!.every((v) => v.name.startsWith(`${d.prefix}_`))).toBe(true);
      for (const f of r.doc.features) {
        if (f.sketch && defined) expect(freedomOf(f.sketch.data)).toBe(0);
        for (const v of Object.values(f.params)) expect(evaluate(v, scope).ok).toBe(true);
        if (f.apart) expect(f.operation).toBe("new");
      }
    });
  }
});
