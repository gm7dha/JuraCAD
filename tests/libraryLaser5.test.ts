/**
 * The fifth batch of laser designs, pure: the bird box's RSPB sizes, the earring stand's halving slots and hole grid,
 * the drawers' clearances, the pen pot's dividers, the sunburst's rays and rings, the book stand's balance, the coaster
 * holder matching the Coasters design, the tissue cover — finger boxes stood on their back or upside down — and every
 * sketch fully defined.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, designGroups, editInsert, findDesign, insertDesign, laserDefaultsFor, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { freedomOf } from "../src/library/sketchKit";
import { lit } from "../src/library/ex";
import { boxOf, insidePolygon, signedArea, type P2 } from "../src/library/outlines";
import { panelPlace, panelShapes, shapeOf } from "../src/library/boxPanels";
import { sectionOf } from "../src/library/sidePanels";
import { BIRD_HOLES, birdBox, CLIMB, DRAIN, MIN_FLOOR, MIN_HOLE_HEIGHT, MIN_SHEET } from "../src/library/designs/birdBox";
import { earringStand, HOLE_WEB, standGaps } from "../src/library/designs/earringStand";
import { drawerBox, shelfOutline, sideSlots } from "../src/library/designs/drawerBox";
import { DIVIDER_ROOM, penDividers, penHoles } from "../src/library/designs/penHolder";
import { HANG, keyholeOutline, MIRROR_ROOM, MIN_TIP, pocketSlot, sunburst } from "../src/library/designs/sunburstMirror";
import { bookStand } from "../src/library/designs/bookStand";
import { coasterHolder, coasterStanding, HEX_WALL_SHARE, WALL_SHARE } from "../src/library/designs/coasterHolder";
import { tissueCover } from "../src/library/designs/tissueBox";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const area = (p: P2[]) => Math.abs(signedArea(p));

const IDS = ["bird-box", "earring-stand", "drawer-box", "pen-holder", "sunburst-mirror", "book-stand", "coaster-holder", "tissue-box"];

describe("finger boxes standing any way round", () => {
  const b = { W: lit(100), D: lit(60), H: lit(40), t: lit(3), kerf: lit(0), lid: false, finger: 8 };
  const s = panelShapes(b);
  const span = (pts: P2[]) => {
    const [x0, y0, x1, y1] = boxOf(pts);
    return [x1 - x0, y1 - y0];
  };
  it("upright: each panel on its plane as usual", () => {
    expect(span(shapeOf(s, "front").nominal.map(panelPlace("front", "upright", { W: 100, D: 60, H: 40, t: 3 }).map))).toEqual([100, 40]);
    expect(panelPlace("back", "upright", { W: 100, D: 60, H: 40, t: 3 }).move).toEqual({ dy: 57 });
  });
  it("upside down: the bottom is on top, the walls turned over (their open edge at z = 0)", () => {
    const at = panelPlace("front", "upsideDown", { W: 100, D: 60, H: 40, t: 3 });
    const pts = shapeOf(s, "front").nominal.map(at.map);
    // The open (plain) edge of the walls was at the top; now it's along z = 0, straight.
    const low = pts.filter((p) => Math.abs(p[1]) < 1e-9);
    expect(low.length).toBe(2);
    expect(panelPlace("bottom", "upsideDown", { W: 100, D: 60, H: 40, t: 3 }).move).toEqual({ dz: 37 });
  });
  it("on its back: the bottom is the back, the open top faces the front (y = 0), the sides run front to back", () => {
    const dims = { W: 100, D: 60, H: 40, t: 3 };
    expect(panelPlace("bottom", "onBack", dims)).toMatchObject({ plane: "Front", flip: true, move: { dy: 37 } });
    const side = shapeOf(s, "left").nominal.map(panelPlace("left", "onBack", dims).map);
    // On the Right plane (y, z): as deep as the finger box was high, as tall as it was deep.
    expect(span(side)).toEqual([40, 60]);
    const floor = shapeOf(s, "front").nominal.map(panelPlace("front", "onBack", dims).map);
    expect(span(floor)).toEqual([100, 40]);
    // The open edge (straight) is now at the front, y = 0.
    expect(floor.filter((p) => Math.abs(p[1]) < 1e-9).length).toBe(2);
  });
});

describe("bird box", () => {
  it("has the RSPB's hole sizes, and the hole's bottom the chosen height above the floor", () => {
    expect(Object.fromEntries(Object.entries(BIRD_HOLES).map(([k, b]) => [k, b.hole]))).toEqual({ "blue-tit": 25, "great-tit": 28, "house-sparrow": 32 });
    for (const bird of Object.keys(BIRD_HOLES)) {
      const bb = birdBox(valuesOf("bird-box", { bird }));
      const t = bb.b.t.v;
      expect(bb.holeAt[1] - bb.hole / 2 - t).toBeCloseTo(130, 9);
      // Room above the hole inside, and the hole across the middle of the front.
      expect(bb.b.H.v - bb.holeAt[1] - bb.hole / 2).toBeGreaterThan(20);
      expect(bb.holeAt[0]).toBeCloseTo(bb.b.W.v / 2, 9);
    }
    expect(MIN_HOLE_HEIGHT).toBe(125);
    expect(MIN_FLOOR).toBe(100);
  });

  it("refuses a hole too low or a floor too small, as the RSPB advises", () => {
    expect(valueProblems(design("bird-box"), valuesOf("bird-box", { holeHeight: 110 }))[0]).toMatch(/at least 125 mm/);
    expect(valueProblems(design("bird-box"), valuesOf("bird-box", { floorWidth: 90 }))[0]).toMatch(/at least 100 mm/);
    // The RSPB and BTO advise 15 mm timber; thinner than 6 mm sheet is refused.
    expect(valueProblems(design("bird-box"), valuesOf("bird-box", { thickness: 4 }))[0]).toMatch(/at least 6 mm/);
    expect(MIN_SHEET).toBe(6);
    expect(design("bird-box").description).toMatch(/15 mm/);
    expect(design("bird-box").description).toMatch(/north to east/);
    expect(valueProblems(design("bird-box"), valuesOf("bird-box", { bird: "house-sparrow", holeHeight: 125 }))).toEqual([]);
  });

  it("score lines across the inside of the front, so the young can climb out: clear of the fingers, up to below the hole", () => {
    const bb = birdBox(valuesOf("bird-box"));
    const [t, W] = [bb.b.t.v, bb.b.W.v];
    expect(bb.climb.length).toBeGreaterThan(10);
    for (const l of bb.climb) {
      expect(l.x0).toBeCloseTo(t + CLIMB.side, 9);
      expect(l.x1).toBeCloseTo(W - t - CLIMB.side, 9);
      expect(l.z).toBeGreaterThanOrEqual(t + CLIMB.from - 1e-9);
      expect(l.z).toBeLessThanOrEqual(bb.holeAt[1] - bb.hole / 2 - CLIMB.below + 1e-9);
    }
    for (let i = 1; i < bb.climb.length; i++) expect(bb.climb[i].z - bb.climb[i - 1].z).toBeCloseTo(CLIMB.pitch, 9);
    // In the Front sketch, scored when it's saved for laser.
    const r = insertDesign(emptyDocument(), design("bird-box"), valuesOf("bird-box"), { into: MAIN_STUDIO });
    const front = r.doc.features.find((f) => f.name === "Front sketch")!;
    expect(laserDefaultsFor(r.doc, front.id)).toEqual({ open: "score" });
    expect(front.sketch!.data.curves.filter((c) => c.type === "line").length).toBeGreaterThan(bb.climb.length);
  });

  it("drainage holes sit in the floor, clear of the walls; the roof overhangs the front and its under-plate drops inside", () => {
    const bb = birdBox(valuesOf("bird-box"));
    const t = bb.b.t.v;
    for (const [x, y] of bb.drains) for (const v of [x, y]) expect(v - DRAIN.d / 2).toBeGreaterThan(t + 5);
    expect(bb.roof[1]).toBe(-30);
    expect(bb.under[0]).toBeGreaterThan(t);
    expect(bb.under[2]).toBeLessThan(bb.b.W.v - t);
  });
});

describe("earring stand", () => {
  it("two halving slots the sheet's thickness wide, half the height each, so the plates cross flush", () => {
    const e = earringStand(valuesOf("earring-stand"));
    const [a, b] = e.plates;
    // Each plate is the rectangle less its corners and slot.
    const slot = (e.t * e.h) / 2;
    const corners = e.chamfer * e.chamfer;
    expect(area(a)).toBeCloseTo(e.w * e.h - slot - corners, 6);
    expect(area(b)).toBeCloseTo(e.w * e.h - slot - corners, 6);
    expect(insidePolygon([0, e.h * 0.75], a)).toBe(false);
    expect(insidePolygon([0, e.h * 0.25], a)).toBe(true);
    expect(insidePolygon([0, e.h * 0.25], b)).toBe(false);
    expect(insidePolygon([0, e.h * 0.75], b)).toBe(true);
  });

  it("the holes keep clear of each other and the edges, on both sides of the slot", () => {
    const e = earringStand(valuesOf("earring-stand"));
    expect(e.holes.length).toBeGreaterThan(20);
    const g = standGaps(e);
    expect(g.between).toBeGreaterThanOrEqual(HOLE_WEB);
    expect(g.edge).toBeGreaterThanOrEqual(HOLE_WEB);
    expect(e.holes.filter((p) => p[0] < 0).length).toBe(e.holes.filter((p) => p[0] > 0).length);
    expect(valueProblems(design("earring-stand"), valuesOf("earring-stand", { rows: 30, columns: 20 }))[0]).toMatch(/closer than/);
  });
});

describe("box with drawers", () => {
  it("drawers fit the case with the clearance either side, above and behind; shelves between them", () => {
    const d = drawerBox(valuesOf("drawer-box"));
    const { W, D, H, t, c, n } = d;
    expect(d.drawer.W.v + 2 * c + 2 * t).toBeCloseTo(W, 9);
    expect(d.drawer.D.v + c + t).toBeCloseTo(D, 9);
    expect(n * (d.drawer.H.v + c) + (n - 1) * t + 2 * t).toBeCloseTo(H, 6);
    expect(d.shelves).toHaveLength(n - 1);
    // Each drawer stands on the floor or a shelf, and has c below the next shelf (or the top).
    const tops = [...d.shelves, H - t];
    d.drawerAt.forEach((at, i) => {
      const under = i === 0 ? t : d.shelves[i - 1] + t;
      expect(at.dz).toBeCloseTo(under, 6);
      expect(tops[i] - (at.dz + d.drawer.H.v)).toBeCloseTo(c, 6);
    });
  });

  it("each shelf's tabs match its slots in the sides; the pull slot sits in the drawer front", () => {
    const d = drawerBox(valuesOf("drawer-box"));
    const shelf = shelfOutline(d);
    expect(area(shelf)).toBeCloseTo((d.W - 2 * d.t) * (d.D - d.t) + 2 * d.t * (d.tab[1] - d.tab[0]), 6);
    for (const s of sideSlots(d)) if (s.kind === "poly") expect(area(s.points)).toBeCloseTo(d.t * (d.tab[1] - d.tab[0]), 6);
    expect(d.pull.a[1] + d.pull.w / 2).toBeLessThan(d.drawer.H.v);
    expect(d.pull.a[0] - d.pull.w / 2).toBeGreaterThan(d.t);
  });

  it("says when the drawers would be too shallow", () => {
    expect(valueProblems(design("drawer-box"), valuesOf("drawer-box", { drawers: 6, height: 150 }))[0]).toMatch(/drawers would be only/);
    expect(valueProblems(design("drawer-box"), valuesOf("drawer-box", { drawers: 2 }))).toEqual([]);
  });
});

describe("honeycomb desk pot", () => {
  it("dividers cross at the middle, room to spare inside, slots half their height each", () => {
    const v = valuesOf("pen-holder");
    const d = penDividers(v);
    expect(d.length).toBeCloseTo(90 - 6 - DIVIDER_ROOM, 9);
    expect(area(d.plates[0])).toBeCloseTo(d.length * d.height - (3 * d.height) / 2, 6);
    expect(penHoles(v).length).toBeGreaterThan(10);
    expect(penHoles(v).every((h) => h.kind === "poly" && h.points.length === 6)).toBe(true);
  });
});

describe("sunburst mirror", () => {
  it("rays round a window smaller than the mirror; rings with a hole just bigger, enough of them for its thickness", () => {
    const s = sunburst(valuesOf("sunburst-mirror"));
    expect(s.sun).toHaveLength(32);
    expect(s.window).toBe(140);
    expect(s.ringHole).toBe(150 + 2 * MIRROR_ROOM);
    expect(s.disc).toBeGreaterThan(s.ringHole);
    expect(s.disc / 2).toBeLessThan(s.body);
    expect(s.tip).toBeGreaterThan(MIN_TIP);
    expect(sunburst(valuesOf("sunburst-mirror", { mirrorThickness: 4 })).rings).toBe(2);
    expect(sunburst(valuesOf("sunburst-mirror", { mirrorThickness: 3 })).rings).toBe(1);
    // The keyhole and its pocket are hidden behind the sun, between the mirror's hole and the rings' edge, with sheet round them.
    const pocket = pocketSlot(s.hang);
    if (pocket.kind !== "slot") throw new Error("slot");
    expect(pocket.a[1] - pocket.w / 2).toBeGreaterThanOrEqual(s.ringHole / 2 + HANG.web - 1e-9);
    expect(pocket.b[1] + pocket.w / 2).toBeLessThanOrEqual(s.disc / 2 - HANG.web + 1e-9);
    // The keyhole: the head's round opening below, the narrow slot above, all inside the pocket.
    const key = keyholeOutline(s.hang);
    const [x0, y0, x1, y1] = boxOf(key);
    expect(x1 - x0).toBeCloseTo(HANG.head, 6);
    expect(y1 - (s.hang[1] - HANG.head / 2)).toBeCloseTo(HANG.head / 2 + HANG.travel + HANG.shank / 2, 6);
    expect(y0).toBeGreaterThan(pocket.a[1] - pocket.w / 2);
    expect(y1).toBeLessThan(pocket.b[1] + pocket.w / 2);
    expect(key.filter((p) => p[1] > s.hang[1] + HANG.head / 2).every((p) => Math.abs(p[0] - s.hang[0]) <= HANG.shank / 2 + 1e-6)).toBe(true);
  });

  it("refuses odd rays when alternating, and rays too sharp to cut", () => {
    expect(valueProblems(design("sunburst-mirror"), valuesOf("sunburst-mirror", { rays: 15 }))[0]).toMatch(/even number/);
    expect(valueProblems(design("sunburst-mirror"), valuesOf("sunburst-mirror", { rays: 60, size: 290 }))[0]).toMatch(/too sharp/);
    expect(valueProblems(design("sunburst-mirror"), valuesOf("sunburst-mirror", { rays: 15, alternate: false }))).toEqual([]);
  });
});

describe("book stand", () => {
  it("leans at the chosen angle, the ledge room behind the lip, and the base reaches under the rest's top so it won't tip", () => {
    for (const lean of [10, 20, 35]) {
      const s = bookStand(valuesOf("book-stand", { lean }));
      const [base, lip, rest] = s.a.pieces;
      expect(rest.angle).toBe(90 - lean);
      expect(s.restFoot[0] - (lip.centre[0] + s.a.t / 2)).toBeCloseTo(20, 6);
      const restBack = Math.max(...sectionOf(rest, s.a.t).map((p) => p[0]));
      expect(base.centre[0] + base.length / 2).toBeGreaterThan(restBack);
    }
  });
});

describe("coaster holder", () => {
  it("fits the Coasters design's own sizes by default, with room each side", () => {
    const coaster = defaultValues(design("coaster"));
    const v = valuesOf("coaster-holder");
    expect([v.shape, v.size, v.count]).toEqual([coaster.shape, coaster.size, coaster.count]);
    const h = coasterHolder(v);
    expect(h.a.width).toBeCloseTo(4 * 3 + 2 * 1.5, 9);
    const [base, left, right] = h.a.pieces;
    expect(right.centre[0] - left.centre[0] - h.a.t).toBeCloseTo(95 + 3, 6);
    expect(base.length).toBeCloseTo(95 + 3 + 6, 6);
    expect(coasterStanding("hexagon", 95).w).toBeCloseTo((2 * 95) / Math.sqrt(3), 5);
    // Six-sided coasters are widest halfway up: their walls reach that far.
    expect(coasterHolder(valuesOf("coaster-holder", { shape: "hexagon" })).a.pieces[1].length).toBeCloseTo(95 * HEX_WALL_SHARE, 6);
    expect(HEX_WALL_SHARE).toBe(0.5);
    expect(left.length).toBeCloseTo(95 * WALL_SHARE, 6);
  });
});

describe("tissue box cover", () => {
  it("is the tissue box plus room and the sheet, open underneath, the slot the long way", () => {
    const c = tissueCover(valuesOf("tissue-box", { boxWidth: 240, boxDepth: 120, boxHeight: 85 }));
    expect([c.b.W.v, c.b.D.v, c.b.H.v]).toEqual([250, 130, 90]);
    expect(c.slot.a[1]).toBe(c.slot.b[1]);
    expect(c.slot.b[0] - c.slot.a[0]).toBeCloseTo(80 - 30, 9);
    expect(valueProblems(design("tissue-box"), valuesOf("tissue-box", { slotLength: 200 }))[0]).toMatch(/too big for the top/);
  });
});

describe("the fifth batch in the library", () => {
  it("every design's sketches are fully defined and their boxes evaluate", () => {
    const cases: [string, DesignValues][] = [
      ...IDS.map((id): [string, DesignValues] => [id, {}]),
      ["bird-box", { bird: "house-sparrow", kerf: 0.15 }],
      ["drawer-box", { drawers: 1, height: 80 }],
      ["pen-holder", { dividers: false, pattern: "circles" }],
      ["sunburst-mirror", { alternate: false, mirrorThickness: 5 }],
      ["coaster-holder", { shape: "hexagon" }],
      ["tissue-box", { boxWidth: 240, boxDepth: 120, boxHeight: 85 }],
    ];
    for (const [id, extra] of cases) {
      const r = insertDesign(emptyDocument(), design(id), valuesOf(id, extra), { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      setCurrentScope(scope);
      for (const f of r.doc.features) {
        if (f.sketch) expect(freedomOf(f.sketch.data), `${id}: ${f.name}`).toBe(0);
        for (const p of Object.values(f.params)) expect(evaluate(p, scope).ok).toBe(true);
      }
    }
  });

  it("Edit design sizes remakes a bird box for another bird", () => {
    const r = insertDesign(emptyDocument(), design("bird-box"), valuesOf("bird-box"), { into: MAIN_STUDIO });
    const e = editInsert(r.doc, r.insert.id, valuesOf("bird-box", { bird: "great-tit" })).doc;
    const front = e.features.find((f) => f.name === "Front sketch")!;
    const hole = front.sketch!.data.curves.find((c) => c.type === "circle");
    expect(hole && hole.type === "circle" ? hole.radius * 2 : 0).toBeCloseTo(28, 6);
  });

  it("are under the laser tab's headings, found by search, each with a preview and summary", () => {
    const groups = Object.fromEntries(designGroups("laser").map((g) => [g.group, g.designs.map((d) => d.id)]));
    expect(groups.Garden).toEqual(["bird-box"]);
    expect(groups.Desk).toEqual(["pen-holder", "book-stand"]);
    for (const id of ["earring-stand", "sunburst-mirror", "coaster-holder"]) expect(groups.Home).toContain(id);
    for (const id of ["drawer-box", "tissue-box"]) expect(groups["Boxes and stands"]).toContain(id);
    expect(searchDesigns("bird")[0].id).toBe("bird-box");
    expect(searchDesigns("sparrow")[0].id).toBe("bird-box");
    expect(searchDesigns("drawers")[0].id).toBe("drawer-box");
    expect(searchDesigns("earring")[0].id).toBe("earring-stand");
    expect(searchDesigns("sunburst")[0].id).toBe("sunburst-mirror");
    expect(searchDesigns("tissue")[0].id).toBe("tissue-box");
    expect(searchDesigns("honeycomb")[0].id).toBe("pen-holder");
    // The printed pen organiser is still what "pen" finds first.
    expect(searchDesigns("pen")[0].id).toBe("desk-organiser");
    expect(searchDesigns("coaster holder")[0].id).toBe("coaster-holder");
    for (const id of IDS) {
      const d = design(id);
      expect(d.category).toBe("laser");
      expect(d.preview(defaultValues(d)).length).toBeGreaterThan(2);
      expect(d.summary!(defaultValues(d))).toBeTruthy();
    }
  });
});
