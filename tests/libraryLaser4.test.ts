/**
 * The fourth batch of laser designs, pure: outlines moved in and out, tabs and slots between two sides, the dice
 * tower's baffles, the spice rack's and card holder's sizes, the deck box from its cards, the living hinge's strip
 * (notches where the bottom's fingers go, staggered cuts clear of the edges), lantern patterns with bridges all round
 * and no islands, name-puzzle letters that never touch and fit their holes, the key rack's hooks — and every sketch
 * fully defined where it can be.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, designGroups, editInsert, findDesign, insertDesign, laserDefaultsFor, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { freedomOf } from "../src/library/sketchKit";
import { convexHull, crossesItself, insidePolygon, offsetPolygon, outlineGap, pointSegment, signedArea, type P2 } from "../src/library/outlines";
import { assemblyProblems, evenTabs, pieceFlat, sectionOf, sectionsOverlap, sideSlots, type SideAssembly } from "../src/library/sidePanels";
import { patternGap, patternHoles, patternIslands, type PatternKind } from "../src/library/patterns";
import { DIE_ROOM, diceTower, RAMP_ANGLE } from "../src/library/designs/diceTower";
import { JAR_ROOM, spiceRack } from "../src/library/designs/spiceRack";
import { cardStand, LEAN } from "../src/library/designs/cardStand";
import { deckBox, deckLid, LID_ROOM } from "../src/library/designs/deckBox";
import { bottomOutline, hingeBox, hingeColumns, stripOutline } from "../src/library/designs/hingeBox";
import { lanternHoles, patternWindow } from "../src/library/designs/lantern";
import { drawnHoles, drawnLetter, holesOf, MIN_BRIDGE, namePuzzle } from "../src/library/designs/namePuzzle";
import { HOOK, hookOutline, keyRack } from "../src/library/designs/keyRack";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const area = (p: P2[]) => Math.abs(signedArea(p));
/** The nearest any point of `a` comes to the edge of `b`. */
const nearest = (a: P2[], b: P2[]) => Math.min(...a.map((p) => Math.min(...b.map((q, i) => pointSegment(p, q, b[(i + 1) % b.length])))));

const IDS = ["hinge-box", "deck-box", "card-stand", "spice-rack", "lantern", "key-rack", "dice-tower", "name-puzzle"];

describe("outlines", () => {
  it("moves an outline out or in all round, square to each side, whichever way round it was given", () => {
    const sq: P2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(area(offsetPolygon(sq, 1))).toBeCloseTo(144, 9);
    expect(area(offsetPolygon([...sq].reverse(), 1))).toBeCloseTo(144, 9);
    expect(area(offsetPolygon(sq, -1))).toBeCloseTo(64, 9);
    // An L: its inside corner moves in too.
    const L: P2[] = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    const grown = offsetPolygon(L, 0.5);
    expect(area(grown)).toBeCloseTo(21 * 6 + 6 * 15, 9);
    for (const p of L) expect(nearest([p], grown)).toBeGreaterThan(0.5 - 1e-9);
  });

  it("cuts a sharp corner off square — still at least the distance away — instead of a long point", () => {
    const spike: P2[] = [[0, 0], [100, 5], [0, 10]];
    const out = offsetPolygon(spike, 1);
    expect(Math.max(...out.map((p) => p[0]))).toBeLessThan(102);
    for (const p of spike) expect(nearest([p], out)).toBeGreaterThan(1 - 1e-9);
    expect(insidePolygon([100, 5], out)).toBe(true);
  });

  it("finds outlines that cross themselves, gaps between outlines and hulls", () => {
    expect(crossesItself([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true);
    expect(crossesItself([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false);
    expect(outlineGap([[0, 0], [1, 0], [1, 1], [0, 1]], [[3, 0], [4, 0], [4, 1], [3, 1]])).toBeCloseTo(2, 9);
    expect(outlineGap([[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [4, 3], [4, 4], [3, 4]])).toBe(0);
    expect(convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2]])).toHaveLength(4);
  });
});

describe("tabs through slots", () => {
  const a: SideAssembly = {
    side: [[0, 0], [100, 0], [100, 100], [0, 100]],
    pieces: [{ role: "shelf", label: "Shelf", centre: [50, 50], angle: 30, length: 60, tabs: evenTabs(60) }],
    width: 80,
    t: 3,
    kerf: 0,
  };
  it("spreads tabs along a piece, each as long as the gaps between", () => {
    expect(evenTabs(60)).toEqual([[20, 40]]);
    expect(evenTabs(200)).toEqual([[200 / 9, 400 / 9].map((x) => Math.round(x * 1e6) / 1e6), [600 / 9, 800 / 9].map((x) => Math.round(x * 1e6) / 1e6), [1000 / 9, 1200 / 9].map((x) => Math.round(x * 1e6) / 1e6), [1400 / 9, 1600 / 9].map((x) => Math.round(x * 1e6) / 1e6)]);
  });
  it("a slot is exactly the tab's part of the piece's cross-section; the flat piece has its tabs out t each side", () => {
    const [slot] = sideSlots(a);
    expect(area(slot)).toBeCloseTo(20 * 3, 4);
    const sec = sectionOf(a.pieces[0], 3);
    for (const p of slot) expect(insidePolygon(p, sec) || nearest([p], sec) < 1e-6).toBe(true);
    expect(area(pieceFlat(a.pieces[0], a))).toBeCloseTo(60 * 80 + 2 * 20 * 3, 6);
    // With a kerf allowance: the slot kerf/2 smaller all round, the piece kerf/2 bigger.
    const k = { ...a, kerf: 0.2 };
    expect(area(sideSlots(k)[0])).toBeCloseTo(19.8 * 2.8, 4);
    const flat = pieceFlat(a.pieces[0], k);
    expect(Math.max(...flat.map((p) => p[1])) - Math.min(...flat.map((p) => p[1]))).toBeCloseTo(86.2, 6);
  });
  it("says when slots come too near the edge, or pieces get in each other's way", () => {
    expect(assemblyProblems(a)).toEqual([]);
    expect(assemblyProblems({ ...a, pieces: [{ ...a.pieces[0], centre: [50, 97] }] })[0]).toMatch(/too near the edge/);
    const two = { ...a, pieces: [a.pieces[0], { ...a.pieces[0], role: "other", label: "Other", angle: -30 }] };
    expect(assemblyProblems(two)[0]).toMatch(/too close together|in each other's way/);
    expect(sectionsOverlap(sectionOf(a.pieces[0], 3), sectionOf({ ...a.pieces[0], centre: [50, 60] }, 3))).toBe(false);
  });
});

describe("dice tower", () => {
  it("baffles alternate from the front and back walls, each leaving an opening wider than the biggest die", () => {
    const v = valuesOf("dice-tower");
    const d = diceTower(v);
    expect(valueProblems(design("dice-tower"), v)).toEqual([]);
    const baffles = d.a.pieces.filter((p) => p.role.startsWith("baffle"));
    expect(baffles).toHaveLength(2);
    expect(baffles.map((b) => Math.sign(b.angle))).toEqual([1, -1]);
    expect(d.a.pieces.find((p) => p.role === "ramp")!.angle).toBeCloseTo(-RAMP_ANGLE, 6);
    for (const b of baffles) {
      const sec = sectionOf(b, 3);
      const xs = sec.map((p) => p[0]);
      // Touching one wall, the opening at the other end 1.35 dice wide.
      expect(Math.min(Math.min(...xs) - d.xa, d.xb - Math.max(...xs))).toBeCloseTo(0, 6);
      expect(Math.max(Math.min(...xs) - d.xa, d.xb - Math.max(...xs))).toBeGreaterThan(DIE_ROOM * 22 - 0.1);
    }
    // Each reaches past the middle, so a die can't fall straight through.
    expect(d.inside - DIE_ROOM * 22).toBeGreaterThan(d.inside / 2);
    // The exit is above the ramp, under the front.
    expect(d.exit).toBeGreaterThan(DIE_ROOM * 22);
  });
  it("says when the tower is too small for its dice or baffles", () => {
    expect(valueProblems(design("dice-tower"), valuesOf("dice-tower", { die: 40 }))[0]).toMatch(/isn't deep enough|wide/);
    expect(valueProblems(design("dice-tower"), valuesOf("dice-tower", { baffles: 5, height: 150 }))[0]).toMatch(/too close together|taller/);
    expect(valueProblems(design("dice-tower"), valuesOf("dice-tower", { baffles: 3, height: 260 }))).toEqual([]);
  });
});

describe("spice rack and card holder", () => {
  it("spice rack: shelves sized from the jars, rails at the front and back", () => {
    const v = valuesOf("spice-rack");
    const r = spiceRack(v);
    expect(r.a.width).toBeCloseTo(4 * 45 + 5 * JAR_ROOM, 9);
    const back = sectionOf(r.a.pieces.find((p) => p.role === "rail-back-1")!, 3);
    const front = sectionOf(r.a.pieces.find((p) => p.role === "rail-front-1")!, 3);
    const room = Math.min(...front.map((p) => p[0])) - Math.max(...back.map((p) => p[0]));
    expect(room).toBeCloseTo(45 + 2 * JAR_ROOM, 9);
    expect(r.shelves).toHaveLength(3);
    expect(r.shelves[1] - r.shelves[0]).toBeGreaterThan(100 + 3);
    expect(valueProblems(design("spice-rack"), valuesOf("spice-rack", { count: 12, diameter: 60 }))[0]).toMatch(/bed/);
  });
  it("card holder: the back leans 15°, resting on the base, the cards' room in front of it", () => {
    const s = cardStand(valuesOf("card-stand"));
    const back = s.a.pieces.find((p) => p.role === "back")!;
    expect(back.angle).toBeCloseTo(90 - LEAN, 9);
    const sec = sectionOf(back, 3);
    const base = sectionOf(s.a.pieces.find((p) => p.role === "base")!, 3);
    const baseTop = Math.max(...base.map((p) => p[1]));
    expect(Math.min(...sec.map((p) => p[1]))).toBeCloseTo(baseTop, 6);
    // Its lower front corner is the stack's room behind the lip.
    const lip = sectionOf(s.a.pieces.find((p) => p.role === "lip")!, 3);
    expect(sec[3][0] - Math.max(...lip.map((p) => p[0]))).toBeCloseTo(15, 6);
    expect(Math.max(...base.map((p) => p[0]))).toBeGreaterThan(Math.max(sec[0][0], sec[3][0]));
    expect(s.a.width).toBeCloseTo(85 + 3, 9);
    // The sides come down to the floor and are flat there.
    expect(Math.min(...s.a.side.map((p) => p[1]))).toBeCloseTo(0, 6);
  });
});

describe("card deck box", () => {
  it("is sized from the cards and the deck, following its variables", () => {
    const v = valuesOf("deck-box");
    const d = deckBox(v);
    expect([d.b.W.v, d.b.D.v, d.b.H.v]).toEqual([63 + 2 + 6, 18 + 2 + 6, 88 + 1 + 6]);
    const l = deckLid(d);
    expect(l.under[2].v - l.under[0].v).toBeCloseTo(71 - 6 - 2 * LID_ROOM, 9);
    const r = insertDesign(emptyDocument(), design("deck-box"), v, { into: MAIN_STUDIO });
    const front = r.doc.features.find((f) => f.name === "Front sketch")!;
    expect(front.sketch!.data.constraints.some((c) => typeof c.value === "string" && c.value.includes("deck_cardWidth"))).toBe(true);
    expect(valueProblems(design("deck-box"), valuesOf("deck-box", { notch: 80 }))[0]).toMatch(/notch is too wide/);
    expect(deckBox(valuesOf("deck-box", { lid: false })).b.H.v).toBe(88 + 1 + 3);
  });
});

describe("living-hinge box", () => {
  const v = valuesOf("hinge-box");
  const b = hingeBox(v);
  it("the strip is as long as the sides and corners round the middle of the sheet, notched where the bottom's fingers go", () => {
    expect(b.length).toBeCloseTo(2 * 80 + 2 * 40 + 2 * Math.PI * (20 - 1.5), 9);
    const s = stripOutline(b);
    expect(s.zones).toHaveLength(4);
    // The notches add up to the bottom's fingers: (n − 1)/2 of the n along each side.
    const fingers = 2 * ((b.nx - 1) / 2) * (80 / b.nx) + 2 * ((b.ny - 1) / 2) * (40 / b.ny);
    expect(s.notches.reduce((n, [a, c]) => n + c - a, 0)).toBeCloseTo(fingers, 6);
    // None in the corners (they bend), and the corners are the strip's only full-height stretches near the joins.
    for (const [z0, z1] of s.zones) for (const [a, c] of s.notches) expect(c <= z0 + 1e-6 || a >= z1 - 1e-6).toBe(true);
    // The strip's area: full height less the notches.
    expect(area(s.outline)).toBeCloseTo(b.length * b.wall - 3 * fingers, 3);
    // The bottom: its fingers reach the outside along the straight parts.
    const bottom = bottomOutline(b);
    expect(Math.min(...bottom.map((p) => p[0]))).toBeCloseTo(-60, 9);
    expect(Math.min(...bottom.map((p) => p[1]))).toBeCloseTo(-40, 9);
  });

  it("the hinge's cuts are staggered and stay clear of the edges, so the strip stays in one piece", () => {
    const cuts = hingeColumns(b, v);
    const s = stripOutline(b);
    const [gap, cut, spacing] = [3, 15, 1.5];
    for (const [p, q] of cuts) {
      expect(p[0]).toBe(q[0]);
      expect(Math.min(p[1], q[1])).toBeGreaterThan(gap - 1e-9);
      expect(Math.max(p[1], q[1])).toBeLessThan(b.wall - gap + 1e-9);
      expect(s.zones.some(([z0, z1]) => p[0] > z0 && p[0] < z1)).toBe(true);
    }
    // Columns `spacing` apart; in neighbouring columns the gaps are half a step (cut + gap) apart, so no uncut line
    // runs straight across.
    const xs = [...new Set(cuts.map(([p]) => p[0]))].sort((a, c) => a - c);
    const first = xs.filter((x) => x < s.zones[0][1]);
    expect(first[1] - first[0]).toBeCloseTo(spacing, 6);
    const starts = (x: number) => cuts.filter(([p]) => p[0] === x).map(([p, q]) => Math.min(p[1], q[1])).sort((a, c) => a - c);
    const [a0, a1] = [starts(first[0]), starts(first[1])];
    expect(a0[0]).toBeCloseTo(gap, 6);
    expect(a0[1] - a0[0]).toBeCloseTo(cut + gap, 6);
    // The shifted column starts at the bottom edge's gap with a short cut, then carries on half a step over.
    expect(a1[1] - (a0[1] - (cut + gap) / 2)).toBeCloseTo(0, 6);
  });

  it("says when the corners are too tight, the box too small or the strip too long for the bed", () => {
    expect(valueProblems(design("hinge-box"), valuesOf("hinge-box", { radius: 4 }))[0]).toMatch(/Round the corners/);
    expect(valueProblems(design("hinge-box"), valuesOf("hinge-box", { width: 50, radius: 20 }))[0]).toMatch(/too short/);
    expect(valueProblems(design("hinge-box"), valuesOf("hinge-box", { width: 280, depth: 200 }))[0]).toMatch(/too long for the laser/);
    expect(laserDefaultsFor(insertDesign(emptyDocument(), design("hinge-box"), v, { into: MAIN_STUDIO }).doc, "x")).toBeNull();
  });
});

describe("lantern patterns", () => {
  for (const kind of ["circles", "diamonds", "hexagons", "stars"] as PatternKind[])
    it(`${kind}: every shape its own hole, a bridge's width from the next and from the window's edge`, () => {
      const v = valuesOf("lantern", { pattern: kind });
      const holes = lanternHoles(v);
      expect(holes.length).toBeGreaterThan(10);
      expect(patternIslands(holes)).toEqual({ islands: [], nested: 0 });
      const gap = patternGap(holes);
      expect(gap).toBeGreaterThan(3 - 1e-6);
      // Honeycomb and diamonds sit side to side: exactly a bridge apart.
      if (kind === "hexagons" || kind === "diamonds") expect(gap).toBeCloseTo(3, 6);
      const w = patternWindow(v, 90);
      for (const h of holes) {
        const pts = h.kind === "circle" ? [[h.c[0] - h.d / 2, h.c[1] - h.d / 2], [h.c[0] + h.d / 2, h.c[1] + h.d / 2]] : h.points;
        for (const [x, y] of pts) expect(x >= w[0] + 3 - 1e-6 && x <= w[2] - 3 + 1e-6 && y >= w[1] + 3 - 1e-6 && y <= w[3] - 3 + 1e-6).toBe(true);
      }
    });
  it("lays the pattern out symmetrically, and says when the shapes don't fit", () => {
    const holes = patternHoles("circles", [0, 0, 100, 60], 10, 3);
    const xs = holes.map((h) => (h.kind === "circle" ? h.c[0] : 0));
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(100, 6);
    expect(valueProblems(design("lantern"), valuesOf("lantern", { shape: 70 }))[0]).toMatch(/too big/);
    expect(valueProblems(design("lantern"), valuesOf("lantern", { bridge: 1 }))[0]).toMatch(/at least/);
  });
});

describe("name puzzle", () => {
  it("lays the letters out apart, each centred on the board's middle line", () => {
    const p = namePuzzle(valuesOf("name-puzzle"));
    expect(p.letters.map((l) => l.ch)).toEqual(["A", "L", "E", "X"]);
    for (let i = 1; i < p.letters.length; i++) expect(p.letters[i].box[0] - p.letters[i - 1].box[2]).toBeCloseTo(8, 6);
    for (const l of p.letters) expect(l.box[1] + l.box[3]).toBeCloseTo(0, 6);
    expect(p.letters[0].counters).toHaveLength(1);
    expect(p.w).toBeCloseTo(p.letters[3].box[2] - p.letters[0].box[0] + 24, 3);
  });

  it("each hole is its letter with room all round; drawn for the laser, pieces bigger and holes smaller by kerf/2", () => {
    const v = valuesOf("name-puzzle", { words: "BOX", play: 0.4 });
    const p = namePuzzle(v);
    for (const l of p.letters) {
      const holes = holesOf(l, 0.4);
      l.outers.forEach((c, i) => {
        expect(c.every((q) => insidePolygon(q, holes[i]))).toBe(true);
        expect(nearest(c, holes[i])).toBeGreaterThan(0.4 - 1e-6);
      });
      const drawn = drawnLetter(l, 0.2);
      expect(area(drawn[0])).toBeGreaterThan(area(l.outers[0]));
      expect(area(drawnHoles(l, 0.4, 0.2)[0])).toBeLessThan(area(holes[0]));
      expect(nearest(l.outers[0], drawnHoles(l, 0.4, 0.2)[0])).toBeGreaterThan(0.3 - 1e-6);
      // A middle (B, O) is cut out of the piece, kerf/2 smaller.
      if (l.counters.length) expect(area(drawn[l.outers.length])).toBeLessThan(area(l.counters[0]));
    }
    // No two holes closer than the thinnest bridge allowed.
    const all = p.letters.flatMap((l) => holesOf(l, 0.4));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(outlineGap(all[i], all[j])).toBeGreaterThan(MIN_BRIDGE);
  });

  it("says when the name is too long for the bed, letters are missing, or letters would touch", () => {
    expect(valueProblems(design("name-puzzle"), valuesOf("name-puzzle", { words: "MAXIMILIANA", height: 80 }))[0]).toMatch(/too big for the laser/);
    expect(valueProblems(design("name-puzzle"), valuesOf("name-puzzle", { words: "  " }))[0]).toMatch(/type some words|Type a name/i);
    expect(valueProblems(design("name-puzzle"), valuesOf("name-puzzle", { words: "Zoë☃" }))[0]).toMatch(/hasn't got/);
  });

  it("Edit design sizes: another name makes its letters again", () => {
    const d = design("name-puzzle");
    const r = insertDesign(emptyDocument(), d, valuesOf("name-puzzle"), { into: MAIN_STUDIO });
    const e = editInsert(r.doc, r.insert.id, valuesOf("name-puzzle", { words: "AL" })).doc;
    expect(e.features.filter((f) => f.type === "extrude" && /Letter/.test(f.name))).toHaveLength(2);
    expect(e.partNames![`${r.insert.id}_letter-1`]).toBe("Name puzzle letter A");
  });
});

describe("key rack", () => {
  it("hooks spread evenly, each tab exactly its slot", () => {
    const v = valuesOf("key-rack");
    const k = keyRack(v);
    expect(k.hooks).toHaveLength(5);
    expect(k.hooks[1] - k.hooks[0]).toBeCloseTo(48, 9);
    expect(k.hooks[0] + k.hooks[4]).toBeCloseTo(0, 9);
    const hook = hookOutline(k, 3);
    expect(signedArea(hook)).toBeGreaterThan(0);
    expect(area(hook)).toBeCloseTo(HOOK.arm * k.reach + HOOK.lip * HOOK.lipThick + (HOOK.arm - 2 * HOOK.tabRoom) * 3, 6);
    expect(area(k.slots[0])).toBeCloseTo(3 * (HOOK.arm - 2 * HOOK.tabRoom), 9);
    expect(valueProblems(design("key-rack"), valuesOf("key-rack", { words: "HELLO THERE FRIEND", letters: 40 }))[0]).toMatch(/don't fit above the hooks/);
    expect(valueProblems(design("key-rack"), valuesOf("key-rack", { hooks: 20, width: 200 }))[0]).toMatch(/too many hooks/);
  });
});

describe("the fourth batch in the library", () => {
  it("every design's sketches are fully defined (but the hinge strip's loose cuts) and their boxes evaluate", () => {
    const cases: [string, DesignValues][] = [...IDS.map((id): [string, DesignValues] => [id, {}]), ["name-puzzle", { words: "Ruby", font: "regular" }], ["lantern", { pattern: "stars" }], ["deck-box", { lid: false, notch: 0 }], ["key-rack", { screws: false }]];
    for (const [id, extra] of cases) {
      const r = insertDesign(emptyDocument(), design(id), valuesOf(id, extra), { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      setCurrentScope(scope);
      for (const f of r.doc.features) {
        if (f.sketch && f.name !== "Wall strip") expect(freedomOf(f.sketch.data), `${id}: ${f.name}`).toBe(0);
        for (const p of Object.values(f.params)) expect(evaluate(p, scope).ok).toBe(true);
      }
    }
  });

  it("are under the laser tab's headings, found by search, with their laser settings", () => {
    const groups = Object.fromEntries(designGroups("laser").map((g) => [g.group, g.designs.map((d) => d.id)]));
    expect(groups["Boxes and stands"]).toContain("hinge-box");
    expect(groups["Boxes and stands"]).toContain("deck-box");
    expect(groups["Boxes and stands"]).toContain("card-stand");
    for (const id of ["spice-rack", "lantern", "key-rack"]) expect(groups.Home).toContain(id);
    for (const id of ["dice-tower", "name-puzzle"]) expect(groups["Toys and gifts"]).toContain(id);
    expect(searchDesigns("dice")[0].id).toBe("dice-tower");
    expect(searchDesigns("tarot")[0].id).toBe("deck-box");
    expect(searchDesigns("spice")[0].id).toBe("spice-rack");
    const box = insertDesign(emptyDocument(), design("hinge-box"), valuesOf("hinge-box"), { into: MAIN_STUDIO });
    expect(laserDefaultsFor(box.doc, `${box.insert.id}_strip-sketch`)).toEqual({ open: "cut" });
    for (const id of IDS) {
      const d = design(id);
      expect(d.category).toBe("laser");
      expect(d.preview(defaultValues(d)).length).toBeGreaterThan(2);
      expect(d.summary!(defaultValues(d))).toBeTruthy();
    }
  });
});
