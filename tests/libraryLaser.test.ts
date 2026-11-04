/**
 * The laser library designs, pure: text inputs (saved, read back, edited),
 * mirrored sketch text, stencil bridges, the stamp's engraved background, and
 * each design's maths.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { MAIN_STUDIO } from "../src/model/studios";
import { completeValues, currentValues, defaultValues, designGroups, editInsert, findDesign, inputProblem, insertDesign, laserDefaultsFor, MAX_TEXT_LINES, valueProblems } from "../src/library/insert";
import { parseLibraryInserts } from "../src/library/parse";
import { depths, planBridges, stencilAt, unheldIslands, type Bridge } from "../src/library/bridges";
import { blockContours, capShare, contoursBox, inkArea, lineCentres, linesOf, missingLetters, sizeForCaps } from "../src/library/textKit";
import { stencilPlan } from "../src/library/designs/stencil";
import { stampLayout } from "../src/library/designs/stamp";
import { gearOutline, gearSizes, hingeCuts } from "../src/library/designs/workshop";
import { MARK_GAP, rulerMarks } from "../src/library/designs/engraved";
import { SKETCH_DEFAULTS, sketchPiece, sketchSettingsFor } from "../src/laser/sources";
import { segmentPoints, type LaserPath } from "../src/laser/laser";
import { addRectangle } from "../src/sketch/ops";
import { changeText, textContours } from "../src/sketch/sketchText";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";
import type { DesignValues } from "../src/library/types";

type P2 = [number, number];
const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const area = (poly: P2[]) => Math.abs(poly.reduce((a, [x1, y1], i) => a + x1 * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * y1, 0)) / 2;
const square = (x0: number, y0: number, x1: number, y1: number, ccw = true): P2[] => (ccw ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]);

/** Does segment a–b cross the inside of the box? (Sampled finely: for tests only.) */
function touchesBox(a: P2, b: P2, box: Bridge["box"]): boolean {
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    if (x > box[0] + 1e-6 && x < box[2] - 1e-6 && y > box[1] + 1e-6 && y < box[3] - 1e-6) return true;
  }
  return false;
}

/** Which outlines come into a bridge. */
const outlinesIn = (contours: P2[][], box: Bridge["box"]) => contours.map((c, i) => (c.some((p, k) => touchesBox(p, c[(k + 1) % c.length], box)) ? i : -1)).filter((i) => i >= 0);

describe("text inputs", () => {
  const stencil = design("stencil");
  const words = stencil.inputs.find((i) => i.key === "words")!;

  it("check words in plain English", () => {
    expect(words.kind).toBe("text");
    expect(inputProblem(words, "HELLO")).toBeNull();
    expect(inputProblem(words, "  ")).toMatch(/type some words/);
    expect(inputProblem(words, 5)).toMatch(/type some words/);
    expect(inputProblem(words, "X".repeat(41))).toMatch(/at most 40 letters/);
    expect(inputProblem(words, Array(MAX_TEXT_LINES + 1).fill("A").join("\n"))).toMatch(/at most 6 lines/);
    const one = { ...words, multiline: false };
    expect(inputProblem(one, "A\nB")).toMatch(/one line only/);
    const optional = design("coaster").inputs.find((i) => i.key === "words")!;
    expect(inputProblem(optional, "")).toBeNull();
    expect(completeValues(stencil, { words: 1234 }).words).toBe("1234");
    expect(completeValues(stencil, { words: "A\r\nB" }).words).toBe("A\nB");
    expect(valueProblems(stencil, valuesOf("stencil", { words: "HI ☃" }))[0]).toMatch(/hasn't got these letters: ☃\./);
  });

  it("are saved with the insert, read back from the file, and changed with Edit design sizes", () => {
    const r = insertDesign(emptyDocument(), stencil, valuesOf("stencil", { words: "HI\nTHERE" }), { into: MAIN_STUDIO });
    expect(r.insert.values.words).toBe("HI\nTHERE");
    const letters = () => (d: typeof r.doc) => d.features.find((f) => f.name === "Letters sketch")!.sketch!.data.texts!.map((t) => t.value);
    expect(letters()(r.doc)).toEqual(["HI", "THERE"]);
    const back = readDocumentFile(serializeDocument(r.doc));
    if (!back.ok) throw new Error(back.error);
    expect(back.doc.libraryInserts![0].values.words).toBe("HI\nTHERE");
    expect(currentValues(back.doc, back.doc.libraryInserts![0]).words).toBe("HI\nTHERE");
    const edited = editInsert(back.doc, r.insert.id, { ...currentValues(back.doc, r.insert), words: "BOB", font: "regular" }).doc;
    expect(letters()(edited)).toEqual(["BOB"]);
    expect(edited.features.find((f) => f.name === "Letters sketch")!.sketch!.data.texts![0].font).toBe("regular");
    expect(edited.libraryInserts![0].values.words).toBe("BOB");
    // B has two middles and O one: three bridges now, in their own sketch.
    expect(edited.features.some((f) => f.name === "Bridges")).toBe(true);
    // Texts get ids from their place, so the same design made again keeps them.
    expect(edited.features.find((f) => f.name === "Letters sketch")!.sketch!.data.texts![0].id).toMatch(/_t0$/);
  });

  it("long words are kept when a file is read (up to 1000 letters), anything odd is dropped", () => {
    const parsed = parseLibraryInserts([{ id: "x", design: "stencil", prefix: "stencil", values: { words: "W".repeat(900), big: "Z".repeat(1001), n: 3 }, features: [] }]);
    expect(parsed[0].values.words).toHaveLength(900);
    expect(parsed[0].values.big).toBeUndefined();
    expect(parsed[0].values.n).toBe(3);
  });

  it("lines and letter sizes", () => {
    expect(linesOf(" A \n\n B")).toEqual(["A", "B"]);
    expect(missingLetters("bold", "Hello, 123!")).toBe("");
    // Capitals come out the height asked for.
    const H = blockContours({ font: "bold", capHeight: 20, lines: ["H"] });
    const b = contoursBox(H)!;
    expect(b[3] - b[1]).toBeCloseTo(20, 3);
    expect(sizeForCaps("bold", 20)).toBeCloseTo(20 / capShare("bold"), 6);
    expect(lineCentres({ font: "bold", capHeight: 10, lines: ["A", "B", "C"] }).map((p) => p[1])).toEqual([16, 0, -16]);
  });
});

describe("mirrored text", () => {
  const base = () => {
    const s: SketchData = { ...emptySketch(), texts: [{ id: "t", anchor: "origin", value: "F", size: 20, angle: 0, font: "bold", construction: false }] };
    return s;
  };

  it("is the same letters flipped left to right about the text's point", () => {
    const s = base();
    const m = changeText(s, "t", { mirror: true }).sketch;
    expect(m.texts![0].mirror).toBe(true);
    const a = textContours(s, s.texts![0]);
    const b = textContours(m, m.texts![0]);
    expect(b).toHaveLength(a.length);
    for (const [i, c] of a.entries()) {
      const flipped = c.map(([x, y]) => [-x, y] as P2);
      // The same points (walked the other way round).
      for (const p of flipped) expect(b[i].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9)).toBe(true);
    }
    // F's stem is on the left as written, on the right mirrored.
    const xs = a.flat().map((p) => p[0]);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.max(...b.flat().map((p) => p[0]))).toBeCloseTo(-Math.min(...xs), 9);
    expect(changeText(m, "t", { mirror: false }).sketch.texts![0].mirror).toBeUndefined();
  });

  it("is saved in the file and read back", () => {
    const m = changeText(base(), "t", { mirror: true }).sketch;
    const back = parseSketchData(JSON.parse(JSON.stringify(m)));
    expect(back?.texts?.[0].mirror).toBe(true);
    const plain = parseSketchData(JSON.parse(JSON.stringify(base())));
    expect(plain?.texts?.[0].mirror).toBeUndefined();
  });

  it("the rubber stamp's words are mirrored", () => {
    const r = insertDesign(emptyDocument(), design("rubber-stamp"), valuesOf("rubber-stamp"), { into: MAIN_STUDIO });
    const s = r.doc.features.find((f) => f.name === "Stamp sketch")!.sketch!.data;
    expect(s.texts!.every((t) => t.mirror === true)).toBe(true);
    expect(s.texts!.map((t) => t.value)).toEqual(["MADE BY", "HAND"]);
    // And the laser panel knows to engrave its background.
    expect(laserDefaultsFor(r.doc, r.doc.features.find((f) => f.name === "Stamp sketch")!.id)).toEqual({ background: true });
    expect(laserDefaultsFor(r.doc, r.doc.features.find((f) => f.name === "Plate sketch")!.id)).toBeNull();
    expect(laserDefaultsFor(emptyDocument(), "nothing")).toBeNull();
  });
});

describe("stencil bridges", () => {
  it("find islands: outlines inside an odd number of others", () => {
    const ring = [square(0, 0, 20, 20), square(5, 5, 15, 15, false)];
    expect(depths(ring)).toEqual([0, 1]);
    expect(stencilAt(ring, depths(ring), [2, 2])).toBeNull();
    expect(stencilAt(ring, depths(ring), [10, 10])).toBe(1);
    expect(stencilAt(ring, depths(ring), [30, 30])).toBe("sheet");
  });

  it("hold a square O's middle with an upright strip of the bridge's width, crossing its stroke into the sheet", () => {
    const ring = [square(0, 0, 20, 20), square(5, 5, 15, 15, false)];
    const plan = planBridges(ring, { width: 2 });
    expect(plan.islands).toEqual([1]);
    expect(plan.unheld).toEqual([]);
    expect(plan.bridges).toHaveLength(1);
    const [b] = plan.bridges;
    expect(b.dir === "up" || b.dir === "down").toBe(true);
    expect(b.to).toBe("sheet");
    expect(b.box[2] - b.box[0]).toBeCloseTo(2, 9);
    // From inside the middle, through the stroke, out past the letter.
    if (b.dir === "up") {
      expect(b.box[1]).toBeLessThan(15);
      expect(b.box[3]).toBeGreaterThan(20);
    } else {
      expect(b.box[3]).toBeGreaterThan(5);
      expect(b.box[1]).toBeLessThan(0);
    }
    const two = planBridges(ring, { width: 2, perIsland: 2 });
    expect(two.bridges.map((x) => x.dir).sort()).toEqual(["down", "up"]);
  });

  it("never cross into other letters, however close", () => {
    const ring = [square(0, 0, 20, 20), square(5, 5, 15, 15, false)];
    const contours = [...ring, square(-5, 20.4, 25, 30), square(-5, -10, 25, -0.4), square(20.4, 0, 30, 20)];
    const plan = planBridges(contours, { width: 2, perIsland: 2 });
    expect(plan.unheld).toEqual([]);
    expect(plan.bridges).toHaveLength(2);
    for (const b of plan.bridges) expect(outlinesIn(contours, b.box).every((i) => i === 0 || i === 1)).toBe(true);
  });

  it("go sideways when the middle is too narrow for an upright bridge", () => {
    const tall = [square(0, 0, 10, 30), square(4, 4, 5.5, 26, false)];
    const plan = planBridges(tall, { width: 2 });
    expect(plan.unheld).toEqual([]);
    expect(["left", "right"]).toContain(plan.bridges[0].dir);
    expect(plan.bridges[0].box[3] - plan.bridges[0].box[1]).toBeCloseTo(2, 9);
  });

  it("join a middle to another middle that is held (as through the bar of a B), and say when one can't be held", () => {
    const islands = [1, 2];
    expect(unheldIslands(islands, [{ box: [0, 0, 1, 1], island: 1, to: 2, dir: "up" }, { box: [0, 0, 1, 1], island: 2, to: "sheet", dir: "up" }])).toEqual([]);
    expect(unheldIslands(islands, [{ box: [0, 0, 1, 1], island: 1, to: 2, dir: "up" }])).toEqual([1, 2]);
    // A middle too narrow for the bridge.
    const thin = [square(0, 0, 20, 20), square(9.5, 5, 10.5, 15, false)];
    expect(planBridges(thin, { width: 0.5 }).unheld).toEqual([]);
    const tooWide = planBridges([square(0, 0, 3, 3), square(1, 1, 2, 2, false)], { width: 5 });
    expect(tooWide.unheld).toEqual([1]);
  });

  for (const font of ["bold", "regular"] as const)
    it(`hold every middle of real letters (${font}), each bridge crossing only its own letter`, () => {
      const v = valuesOf("stencil", { words: "BOARD 4689\nPQ ab de go", font, height: 20, steady: true });
      const { contours, plan } = stencilPlan(v);
      const d = depths(contours);
      expect(plan.islands.length).toBeGreaterThan(14);
      expect(plan.unheld).toEqual([]);
      for (const b of plan.bridges) {
        expect(Math.min(Math.abs(b.box[2] - b.box[0] - 2), Math.abs(b.box[3] - b.box[1] - 2))).toBeLessThan(1e-5);
        const hit = outlinesIn(contours, b.box);
        // Its own middle, and the one letter outline round it (or the next middle, inside the same letter).
        expect(hit).toContain(b.island);
        expect(hit.length).toBeLessThanOrEqual(2);
        const other = hit.find((i) => i !== b.island)!;
        // The letter round the middle (the smallest outline round it).
        const letterOf = (k: number) => contours.map((_c, i) => i).filter((i) => i !== k && d[i] % 2 === 0 && inside(contours[k][0], contours[i])).sort((a, c) => area(contours[a]) - area(contours[c]))[0];
        if (d[other] % 2 === 1) {
          // Through to another middle (the bar of a B): one in the same letter, and the bridge says so.
          expect(b.to).toBe(other);
          expect(letterOf(other)).toBe(letterOf(b.island));
        } else {
          expect(other).toBe(letterOf(b.island));
          expect(b.to).toBe("sheet");
        }
      }
    });

  it("the stencil says when bridges are too wide, and when middles can't be held", () => {
    expect(valueProblems(design("stencil"), valuesOf("stencil", { height: 6, bridge: 3 }))[0]).toMatch(/bridges are too wide/);
    expect(valueProblems(design("stencil"), valuesOf("stencil", { margin: 2.5 }))[0]).toMatch(/margin/);
  });
});

describe("engrave the background (rubber stamps)", () => {
  const polygonOf = (p: LaserPath): P2[] => p.segments.flatMap((s, i) => segmentPoints(s, 0.01).slice(i ? 1 : 0));
  const evenOdd = (loops: P2[][]) => loops.reduce((n, l, i) => n + (loops.filter((m, j) => j !== i && inside(l[0], m)).length % 2 ? -1 : 1) * area(l), 0);

  it("engraves inside the outline except the border and the shapes inside it, and cuts the outline", () => {
    let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 60, y: 30 }).sketch; // outline
    s = addRectangle(s, { x: 2, y: 2 }, { x: 58, y: 28 }).sketch; // border, outside
    s = addRectangle(s, { x: 4, y: 4 }, { x: 56, y: 26 }).sketch; // border, inside
    s = addRectangle(s, { x: 10, y: 10 }, { x: 20, y: 20 }).sketch; // a "letter"
    s = addRectangle(s, { x: 13, y: 13 }, { x: 17, y: 17 }).sketch; // its hole
    const piece = sketchPiece("Stamp", s, { background: true });
    const engraved = piece.paths.filter((p) => p.layer === "engrave").map(polygonOf);
    expect(engraved).toHaveLength(5);
    const ring = 56 * 26 - 52 * 22;
    expect(evenOdd(engraved)).toBeCloseTo(60 * 30 - ring - (100 - 16), 6);
    const cut = piece.paths.filter((p) => p.layer === "outer");
    expect(cut).toHaveLength(1);
    expect(area(polygonOf(cut[0]))).toBeCloseTo(1800, 6);
    expect(piece.paths.filter((p) => p.layer === "inner")).toHaveLength(0);
    // Without it, the same sketch is all cuts, as before.
    expect(sketchPiece("Stamp", s).paths.filter((p) => p.layer === "engrave")).toHaveLength(0);
  });

  it("the laser panel takes a design sketch's settings, and goes back to the defaults after it", () => {
    const start = { ...SKETCH_DEFAULTS, fromDesign: false };
    // A ruler's sketch scores its lines…
    const ruler = sketchSettingsFor(start, { open: "score", text: "engrave" });
    expect(ruler).toEqual({ text: "engrave", shapes: "cut", open: "score", background: false, fromDesign: true });
    // …a sketch of the user's afterwards cuts them again (a living hinge drawn by hand stays blue).
    const plain = sketchSettingsFor(ruler, null);
    expect(plain).toEqual({ ...SKETCH_DEFAULTS, fromDesign: false });
    // The user's own choices are kept from one ordinary sketch to the next.
    const chosen = { ...plain, open: "score" as const };
    expect(sketchSettingsFor(chosen, null)).toBe(chosen);
    // A stamp's sketch after a ruler's: only what the stamp sets, the rest plain.
    expect(sketchSettingsFor(ruler, { background: true })).toEqual({ ...SKETCH_DEFAULTS, background: true, fromDesign: true });
    const r = insertDesign(emptyDocument(), design("living-hinge"), valuesOf("living-hinge"), { into: MAIN_STUDIO });
    expect(laserDefaultsFor(r.doc, r.doc.features.find((f) => f.type === "sketch")!.id)).toEqual({ open: "cut" });
  });

  it("the stamp's words must fit inside its border", () => {
    expect(valueProblems(design("rubber-stamp"), valuesOf("rubber-stamp", { width: 20 }))[0]).toMatch(/don't fit/);
    expect(valueProblems(design("rubber-stamp"), valuesOf("rubber-stamp", { relief: 3 }))[0]).toMatch(/engrave depth/);
    const L = stampLayout(valuesOf("rubber-stamp"));
    expect(L.border!.outer).toEqual([46, 21]);
    expect(L.border!.inner[0]).toBeCloseTo(43.6, 9);
    expect(stampLayout(valuesOf("rubber-stamp", { border: false })).border).toBeNull();
    expect(valueProblems(design("printed-stamp"), valuesOf("printed-stamp"))).toEqual([]);
  });
});

describe("laser designs' maths", () => {
  it("gear: circles from the module and teeth, the outline between root and outside", () => {
    const s = gearSizes(20, 2, 20);
    expect(s.pitch).toBe(20);
    expect(s.outside).toBe(22);
    expect(s.root).toBe(17.5);
    expect(s.base).toBeCloseTo(20 * Math.cos(Math.PI / 9), 9);
    const pts = gearOutline(20, 2, 20);
    const r = pts.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...r)).toBeCloseTo(22, 5);
    expect(Math.min(...r)).toBeCloseTo(17.5, 5);
    // 20 teeth: the outline repeats every 18°.
    const turned = pts.map(([x, y]): P2 => [x * Math.cos(Math.PI / 10) - y * Math.sin(Math.PI / 10), x * Math.sin(Math.PI / 10) + y * Math.cos(Math.PI / 10)]);
    const n = pts.length / 20;
    for (let i = 0; i < pts.length; i++) expect(Math.hypot(turned[i][0] - pts[(i + n) % pts.length][0], turned[i][1] - pts[(i + n) % pts.length][1])).toBeLessThan(1e-5);
    // About half the pitch circle is tooth.
    const a = area(pts);
    expect(a).toBeGreaterThan(Math.PI * 17.5 ** 2);
    expect(a).toBeLessThan(Math.PI * 22 ** 2);
    expect(valueProblems(design("gear"), valuesOf("gear", { bore: 60 }))[0]).toMatch(/middle hole is too big/);
    // Small gears are warned about (undercut), and big teeth get enough points to follow the involute closely.
    expect(design("gear").summary!(valuesOf("gear", { teeth: 10 }))).toMatch(/fewer than 13 teeth/);
    expect(design("gear").summary!(valuesOf("gear", { teeth: 20, pressure: "14.5" }))).toMatch(/fewer than 23 teeth/);
    expect(design("gear").summary!(valuesOf("gear", { teeth: 24 }))).not.toMatch(/undercut/);
    const [z, m] = [24, 10];
    const big = gearSizes(z, m, 20);
    const outline = gearOutline(z, m, 20);
    const inv = (x: number) => Math.tan(x) - x;
    let worst = 0;
    for (let k = 0; k <= 200; k++) {
      const r = big.base + ((big.outside - big.base) * k) / 200;
      const half = Math.PI / (2 * z) + inv(Math.PI / 9) - inv(Math.acos(Math.min(1, big.base / r)));
      const p: P2 = [r * Math.cos(-half), r * Math.sin(-half)];
      let best = Infinity;
      for (let i = 0; i < 60; i++) {
        const [a, b] = [outline[i], outline[i + 1]];
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
      }
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("living hinge: rows of cuts across the zone, every other row offset, clear of the edges", () => {
    const v = valuesOf("living-hinge");
    const cuts = hingeCuts(v);
    const xs = [...new Set(cuts.map((c) => c[0][0]))].sort((a, b) => a - b);
    expect(xs).toHaveLength(26);
    expect(xs[1] - xs[0]).toBeCloseTo(1.6, 9);
    expect(xs[xs.length - 1] - xs[0]).toBeCloseTo(40, 9);
    for (const [a, b] of cuts) {
      expect(a[1]).toBeGreaterThanOrEqual(-40 + 3 - 1e-9);
      expect(b[1]).toBeLessThanOrEqual(40 - 3 + 1e-9);
      expect(b[1] - a[1]).toBeLessThanOrEqual(20 + 1e-9);
    }
    const firstOf = (x: number) => Math.min(...cuts.filter((c) => c[0][0] === x).map((c) => c[1][1]));
    expect(Math.abs(firstOf(xs[0]) - firstOf(xs[1]))).toBeGreaterThan(1);
    expect(firstOf(xs[0])).toBeCloseTo(firstOf(xs[2]), 9);
    expect(valueProblems(design("living-hinge"), valuesOf("living-hinge", { cut: 80 }))[0]).toMatch(/longer than the panel/);
  });

  it("ruler: a mark every millimetre, longer at 5 and 10, clear of the edge", () => {
    const m = rulerMarks(30, 30);
    expect(m).toHaveLength(31);
    expect(m[0][1]).toBe(10);
    expect(m[5][1]).toBeCloseTo(7, 9);
    expect(m[1][1]).toBeCloseTo(4, 9);
    expect(MARK_GAP).toBeGreaterThan(0);
  });

  it("text fits: tags and coasters say when the words are too long", () => {
    expect(valueProblems(design("name-tag"), valuesOf("name-tag", { words: "A VERY LONG NAME" }))[0]).toMatch(/don't fit on the tag/);
    expect(valueProblems(design("coaster"), valuesOf("coaster", { words: "TOO MANY WORDS", height: 20 }))[0]).toMatch(/don't fit on the coaster/);
    expect(valueProblems(design("coaster"), valuesOf("coaster", { words: "" }))).toEqual([]);
    expect(inkArea(blockContours({ font: "bold", capHeight: 10, lines: ["O"] }))).toBeGreaterThan(0);
  });

  it("the laser tab is grouped under headings", () => {
    expect(designGroups("laser").map((g) => [g.group, g.designs.map((d) => d.id)])).toEqual([
      ["Boxes and stands", ["finger-box", "flat-stand"]],
      ["Signs and stamps", ["stencil", "rubber-stamp", "name-tag"]],
      ["Home", ["coaster", "picture-frame"]],
      ["Workshop", ["living-hinge", "gear", "ruler"]],
    ]);
    expect(designGroups("print")[0].group).toBeNull();
  });
});
