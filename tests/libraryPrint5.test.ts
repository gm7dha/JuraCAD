/**
 * The fifth batch of 3D-printing designs (Honeycomb wall tile, hook and bin; Gridfinity magnet baseplate, bit holder
 * and lite bin; pipe clip, charging stand, spool holder on a bearing, funnel, door wedge, cable tie anchor, box
 * dividers): each design's maths and plain-English problems, every sketch fully defined, Edit design sizes, and
 * finding them in the library. Pure — the geometry is checked in engineLibraryPrint5.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO, studioFeatures } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { evaluate, setCurrentScope } from "../src/model/expr";
import { DEFAULT_FITS } from "../src/model/printSettings";
import { defaultValues, designGroups, editInsert, findDesign, insertDesign, valueProblems } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { freedomOf } from "../src/library/sketchKit";
import { varsOf } from "../src/library/designs/common";
import { BUMP, BUMP_WIDTH, FINGER, flatHex, GROOVE_BACK, grooveOutline, HOLE_PROFILE, holeAt, HSW, HSW_COLUMN, HSW_PITCH, hswBinPlan, PLUG_HALF, plugStrain, RAIL, SCREW_FILL, tilePlan } from "../src/library/designs/honeycomb";
import { FOOT_STEPS, MAGNET, POCKET_STEPS } from "../src/library/designs/gridfinity";
import { FLOOR_TOP, holderPlan, liteFootSteps, magnetSpots, MAGNET_POCKET_STEPS } from "../src/library/designs/gridfinityMore";
import { arcStrain, pipeClipPlan } from "../src/library/designs/pipeClip";
import { funnelProfile } from "../src/library/designs/funnel";
import { BEARING, SPOOL_BASE, SPOOL_HUB } from "../src/library/designs/bearingSpool";
import { dividerPlaces, dividerPlan, SLOT_EXTRA } from "../src/library/designs/dividerSet";
import { BEND_ROOM, chargingPlan, FRONT_WALL, PHONE_ROOM, PLUG_CLEAR, PLUG_END, PLUG_THICKNESS } from "../src/library/designs/chargingStand";
import { tiePlan, wedgePlan } from "../src/library/designs/doorWedge";
import { cantileverStrain, clipToBox, pointyHex, areaOf } from "../src/library/designs/printShapes";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;
const valuesOf = (id: string, extra: DesignValues = {}) => ({ ...defaultValues(design(id)), ...extra });
const problems = (id: string, extra: DesignValues = {}) => valueProblems(design(id), valuesOf(id, extra));
const NEW = ["hsw-tile", "hsw-hook", "hsw-bin", "gridfinity-magnet-baseplate", "gridfinity-bit-holder", "gridfinity-lite-bin", "pipe-clip", "charging-stand", "bearing-spool-holder", "funnel", "door-wedge", "tie-anchor", "divider-set"];

describe("flat shapes", () => {
  it("hexagons on a corner, clipped to a box, with the right areas", () => {
    const h = pointyHex(20);
    expect(h[0][0]).toBeCloseTo(0, 9);
    expect(h[0][1]).toBeCloseTo(20 / Math.sqrt(3), 9);
    expect(areaOf(h)).toBeCloseTo((Math.sqrt(3) / 2) * 400, 6);
    // Cut in half down the middle.
    expect(areaOf(clipToBox(h, 0, -50, 50, 50))).toBeCloseTo((Math.sqrt(3) / 4) * 400, 6);
    expect(clipToBox(h, 30, 30, 40, 40)).toEqual([]);
    expect(cantileverStrain(1, 0.4, 5.85)).toBeCloseTo(0.6 / 34.2225, 9);
  });
});

describe("Honeycomb Storage Wall", () => {
  it("uses the HSW grid: 20 mm holes flat top and bottom, 23.6 mm apart up a column, columns 20.44 mm apart", () => {
    expect(HSW_PITCH).toBeCloseTo(HSW.hole + 2 * HSW.wall, 9);
    expect(HSW_COLUMN).toBeCloseTo(20.4382, 4);
    // Flat at the top and bottom: the corners point sideways.
    const h = flatHex(20);
    expect(h[0]).toEqual([20 / Math.sqrt(3), 0]);
    expect(Math.max(...h.map((p) => p[1]))).toBeCloseTo(10, 9);
    // Neighbours' lips clear each other; a lip covers its hole.
    expect(HSW.lip).toBeLessThan(HSW_PITCH);
    expect(HSW.lip).toBeGreaterThan(HSW.hole);
    // The screw cells' filling joins the walls but stays clear of the neighbours' holes.
    expect(SCREW_FILL).toBeGreaterThan(22);
    expect(SCREW_FILL / 2).toBeLessThan(HSW_PITCH - 22 / 2);
    const p = tilePlan(valuesOf("hsw-tile"));
    expect([p.W, p.H]).toEqual([6 * HSW_COLUMN, 6 * 23.6]);
    // 3 even columns of 6, 3 odd columns of 7 (half holes at both ends), staggered half a hole.
    expect(p.cells).toHaveLength(39);
    const [a, b] = [p.cells.find((c) => c.i === 0 && c.j === 0)!, p.cells.find((c) => c.i === 1 && c.j === 1)!];
    expect(b.x - a.x).toBeCloseTo(HSW_COLUMN, 9);
    expect(b.y - a.y).toBeCloseTo(HSW_PITCH / 2, 9);
    expect(p.screws.map((c) => [c.i, c.j])).toEqual([[0, 0], [5, 1], [0, 5], [5, 5]]);
    expect(tilePlan(valuesOf("hsw-tile", { screws: "2" })).screws).toHaveLength(2);
    expect(design("hsw-tile").summary!(valuesOf("hsw-tile"))).toMatch(/122\.63 mm × 141\.6 mm and 8 mm thick: 29 holes for inserts, 4 screw cells/);
  });

  it("the holes have the HSW profile from the front: a lead-in, 20 mm to 5.1 deep, a taper to 22 at 6", () => {
    expect(HOLE_PROFILE).toEqual([[0, 20.8], [0.5, 20], [5.1, 20], [6, 22], [8, 22]]);
    expect(holeAt(0.25)).toBeCloseTo(20.4, 9);
    expect(holeAt(3)).toBe(20);
    expect(holeAt(5.55)).toBeCloseTo(21, 9);
    expect(holeAt(7)).toBe(22);
    // Run out 0.5 mm in front, the lead-in carries on at its slope.
    expect(holeAt(-0.5)).toBeCloseTo(21.6, 9);
  });

  it("the inserts: a 19.7 mm plug, snap bumps like PStover's on the top and bottom flats, bending under 2%", () => {
    expect(HSW.hole / 2 - PLUG_HALF).toBeCloseTo(0.15, 9);
    // The bump's peak: 0.37 over the hole's flat, 5.75 behind the face, inside the taper (5.1–6.0) and clear of it.
    expect(BUMP[1][1]).toBeCloseTo(HSW.hole / 2 + 0.37, 9);
    expect(BUMP[1][0]).toBe(5.75);
    for (let d = BUMP[0][0]; d <= BUMP[2][0]; d += 0.05) {
      const r = d <= BUMP[1][0] ? BUMP[0][1] + ((BUMP[1][1] - BUMP[0][1]) * (d - BUMP[0][0])) / (BUMP[1][0] - BUMP[0][0]) : BUMP[1][1] + ((BUMP[2][1] - BUMP[1][1]) * (d - BUMP[1][0])) / (BUMP[2][0] - BUMP[1][0]);
      expect(r).toBeLessThan(holeAt(d) / 2 + 1e-9);
    }
    // Both slopes under 45° from the plug's length, so it prints standing up and pulls out again.
    expect((BUMP[1][1] - BUMP[0][1]) / (BUMP[1][0] - BUMP[0][0])).toBeLessThan(1);
    expect((BUMP[1][1] - BUMP[2][1]) / (BUMP[2][0] - BUMP[1][0])).toBeLessThan(1);
    // The fingers sit on the top and bottom flats (19.7 / √3 = 11.4 mm long), with their slots inside.
    expect(FINGER.width / 2 + FINGER.slot).toBeLessThan(HSW.body / Math.sqrt(3) / 2);
    expect(FINGER.slot).toBeGreaterThan(BUMP[1][1] - HSW.hole / 2);
    expect(FINGER.width).toBeGreaterThan(BUMP_WIDTH);
    expect(plugStrain()).toBeCloseTo((1.5 * 1 * 0.37) / 5.45 ** 2, 9);
    expect(plugStrain()).toBeLessThan(0.02);
    expect(design("hsw-hook").summary!(valuesOf("hsw-hook"))).toMatch(/each bends in 0\.37 mm, stretching 1\.9%/);
  });

  it("the bin's groove is the rail with the fit all round, square to its 45° sides", () => {
    const b = hswBinPlan(valuesOf("hsw-bin"));
    const g = grooveOutline(valuesOf("hsw-bin"));
    // At the bin's back face the groove is the rail's root + fit × √2 each side (the rail's 45° side moved out by the fit).
    expect(b.mouth).toBeCloseTo(RAIL.root / 2 + DEFAULT_FITS.sliding * Math.SQRT2, 9);
    expect(b.deep).toBeCloseTo(RAIL.height + DEFAULT_FITS.sliding, 9);
    expect(g[2][0] - g[3][0]).toBeCloseTo(2 * (b.mouth + b.deep), 9);
    expect(b.back).toBeGreaterThanOrEqual(b.deep + GROOVE_BACK - 1e-9);
  });

  it("refuses what wouldn't work", () => {
    expect(problems("hsw-hook", { tip: 8, arm: 7 })[0]).toMatch(/tip must stand at least 2 mm above the arm/);
    expect(problems("hsw-bin", { depth: 12, wall: 2 })[0]).toMatch(/deep, for room inside/);
  });
});

describe("more Gridfinity", () => {
  it("magnet pockets 6.5 × 2.4 under each corner, 13 mm from the cell's middle, in a floor under the standard pocket", () => {
    expect(MAGNET).toEqual({ d: 6.5, depth: 2.4, at: 13 });
    expect(magnetSpots(0, 0)).toEqual([[-13, -13], [-13, 13], [13, -13], [13, 13]]);
    // 8 mm in from the cell's sides.
    expect(42 / 2 - MAGNET.at).toBe(8);
    expect(FLOOR_TOP).toBeCloseTo(3.4, 9);
    // The open baseplate's pocket, from its straight part up, raised onto the floor.
    MAGNET_POCKET_STEPS.slice(1).forEach((s, i) => {
      expect(s.inset).toBe(POCKET_STEPS[i + 1].inset);
      expect(s.z).toBeCloseTo(POCKET_STEPS[i + 1].z + FLOOR_TOP, 9);
    });
    expect(design("gridfinity-magnet-baseplate").summary!(valuesOf("gridfinity-magnet-baseplate"))).toMatch(/9 cells and 36 magnets \(6 × 2 mm\), 126 mm × 126 mm and 8\.4 mm high/);
  });

  it("the lite bin's feet are hollow with the wall's thickness square to every face", () => {
    for (const w of [0.8, 1.2]) {
      const inner = liteFootSteps(w);
      expect(inner[0].z).toBe(w);
      // The 45° parts: the offset of the line inset = c − z, square to it, is w.
      const line = (a: { z: number; inset: number }, b: { z: number; inset: number }) => (b.inset - a.inset) / (b.z - a.z);
      expect(line(inner[0], inner[1])).toBeCloseTo(-1, 9);
      expect(line(inner[2], inner[3])).toBeLessThan(-0.95);
      const dist = (s: { z: number; inset: number }, a: { z: number; inset: number }) => (s.inset + s.z - (a.inset + a.z)) / Math.SQRT2;
      expect(dist(inner[0], FOOT_STEPS[0])).toBeCloseTo(w, 9);
      expect(inner[1].inset - FOOT_STEPS[1].inset).toBeCloseTo(w, 9);
    }
  });

  it("fits as many bit holes as the spacing allows, and says when they don't fit", () => {
    const p = holderPlan(valuesOf("gridfinity-bit-holder"));
    expect([p.cols, p.rows, p.size]).toEqual([3, 3, 6.75]);
    expect(holderPlan(valuesOf("gridfinity-bit-holder", { across: 2 })).cols).toBe(7);
    expect(problems("gridfinity-bit-holder", { depth: 20 })[0]).toMatch(/don't fit in a block 3 units tall: make them at most 15\.2 mm deep/);
    expect(problems("gridfinity-bit-holder", { spacing: 7 })[0]).toMatch(/run into each other/);
  });
});

describe("pipe clip", () => {
  it("works out the snap's strain like a split ring when its back is free (Roark), and keeps it under 2%", () => {
    // A ring opened by s at its gap: ε = s × h / (3π R²). Each side moves s / 2.
    const [R, h, s] = [12, 2, 3];
    expect(arcStrain(R, h, 0, Math.PI, s / 2)).toBeCloseTo((s * h) / (3 * Math.PI * R * R), 6);
    const p = pipeClipPlan(valuesOf("pipe-clip"));
    expect(p.opening).toBeCloseTo(22 * 0.82, 9);
    // Held where its outside meets the plate, 24° round from the back: about 1.3% at the defaults (18% grip).
    expect(p.fixed).toBeCloseTo(Math.acos(p.centre / p.outer), 9);
    expect((p.fixed * 180) / Math.PI).toBeCloseTo(24.2, 1);
    expect(p.strain).toBeCloseTo(0.0134, 3);
    expect(pipeClipPlan(valuesOf("pipe-clip", { grip: 22 })).strain).toBeCloseTo(0.0157, 3);
    // A root further round is stiffer: the same spread strains more.
    expect(arcStrain(12, 2, 0.4, 2.5, 1)).toBeGreaterThan(arcStrain(12, 2, 0, 2.5, 1));
    // 15 mm copper works at the default grip (1.8%); at 22% it would stretch 2.2% and is refused.
    expect(problems("pipe-clip", { pipe: 15 })).toEqual([]);
    expect(pipeClipPlan(valuesOf("pipe-clip", { pipe: 15 })).strain).toBeCloseTo(0.0184, 3);
    expect(problems("pipe-clip", { pipe: 15, grip: 22 })[0]).toMatch(/stretch 2\.2%/);
    // The pipe sits half a wall off the plate, and the ring's back sinks half a wall into it.
    expect(p.centre - p.inner).toBeCloseTo(p.wall / 2, 9);
    expect(problems("pipe-clip", { grip: 35, wall: 5 })[0]).toMatch(/would have to stretch .*% to snap over the pipe/);
    expect(problems("pipe-clip", { pipe: 6, grip: 8 })).toContain("The mouth is too nearly as wide as the pipe to hold it: use more grip.");
  });
});

describe("the rest", () => {
  it("funnel: a 45° cone with the wall's thickness square to it", () => {
    const pts = funnelProfile(varsOf(valuesOf("funnel"), ["top", "spout", "length", "wall", "rim"])).map(([x, y]) => [x.v, y.v]);
    // Outside cone from (spout/2, length) to (top/2, …): 45°.
    expect(pts[3][1] - pts[2][1]).toBeCloseTo(pts[3][0] - pts[2][0], 9);
    expect(pts[6][1] - pts[7][1]).toBeCloseTo(pts[6][0] - pts[7][0], 9);
    // The inside line is the outside one moved in by the wall, square to it.
    const c = (p: number[]) => (p[0] - p[1]) / Math.SQRT2;
    expect(c(pts[2]) - c(pts[7])).toBeCloseTo(1.6, 5);
    expect(problems("funnel", { spout: 6, wall: 2 })[0]).toMatch(/spout must be at least 7 mm/);
    expect(problems("funnel", { top: 40, spout: 35 })[0]).toMatch(/at least 45 mm across/);
  });

  it("spool holder: the 608's pocket and pin take the usual press fit", () => {
    expect(BEARING).toEqual({ outside: 22, bore: 8, width: 7 });
    expect(design("bearing-spool-holder").inputs.find((i) => i.key === "fit")!.default).toBe(DEFAULT_FITS.press);
    expect(design("bearing-spool-holder").summary!(valuesOf("bearing-spool-holder"))).toMatch(/pocket is 22\.1 mm across, the pin 7\.9 mm/);
    // The shoulder only touches the inner ring (about 12 mm across), and the ledge over the pocket only the outer ring.
    expect(SPOOL_BASE.shoulder).toBeLessThan(12);
    expect(SPOOL_BASE.shoulder).toBeGreaterThan(BEARING.bore);
    expect(SPOOL_HUB.opening).toBeLessThan(BEARING.outside);
    expect(SPOOL_HUB.opening).toBeGreaterThan(18.5);
    expect(problems("bearing-spool-holder", { hub: 55 })[0]).toMatch(/at least 63 mm across/);
  });

  it("divider set: equal compartments, and slots that meet with a little to spare", () => {
    expect(dividerPlaces(100, 1, 2)).toEqual([0]);
    const xs = dividerPlaces(160, 2, 1.6);
    // Three equal spaces.
    expect(xs[0] - 0.8 + 80).toBeCloseTo(xs[1] - xs[0] - 1.6, 9);
    const p = dividerPlan(valuesOf("divider-set"));
    expect(2 * p.depth - p.height).toBeCloseTo(2 * SLOT_EXTRA, 9);
    expect(p.slot).toBeCloseTo(1.6 + DEFAULT_FITS.sliding, 9);
    expect(problems("divider-set", { along: 0, across: 0 })[0]).toMatch(/at least one divider/);
    expect(problems("divider-set", { across: 15, length: 60 })[0]).toMatch(/less than 5 mm wide/);
  });

  it("charging stand: the phone stands on a plinth, its plug runs down a slanted slot along the phone's lean with a wall in front, and it doesn't tip", () => {
    for (const extra of [{}, { plugLength: 40 }, { angle: 75 }, { angle: 45, back: 120 }, { slot: 8 }] as DesignValues[]) {
      const p = chargingPlan(valuesOf("charging-stand", extra));
      expect(valueProblems(design("charging-stand"), valuesOf("charging-stand", extra))).toEqual([]);
      expect(p.floor).toBe(p.plugLength + BEND_ROOM);
      // The socket: the middle of the phone's bottom face (the phone 1 mm thinner than its slot, on its back corner).
      const T = p.slot - PHONE_ROOM;
      expect(p.socket[0]).toBeCloseTo((T / 2) * p.sin, 9);
      expect(p.socket[1]).toBeCloseTo(p.floor + (T / 2) * p.cos, 9);
      // The band runs along the phone's lean, the plug's thickness + room wide, past the plug's end.
      const [a, b, , d] = p.band;
      expect((b[0] - a[0]) / (b[1] - a[1])).toBeCloseTo(-p.cos / p.sin, 4);
      expect(Math.hypot(d[0] - a[0], d[1] - a[1])).toBeCloseTo(PLUG_THICKNESS + 2 * PLUG_CLEAR, 4);
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(p.plugLength + PLUG_END, 4);
      // Above the floor it stays in the open slot (behind the lip, in front of the rest); below it, inside the stand.
      for (const q of p.band) {
        if (q[1] >= p.floor) expect(q[0]).toBeLessThan(p.slotFront);
        if (q[1] >= p.floor) expect(q[0]).toBeGreaterThan(-(q[1] - p.floor) / Math.tan((p.angle * Math.PI) / 180));
        expect(q[1]).toBeGreaterThan(0);
      }
      // A wall in front of it, and the pocket meets its lower end.
      expect(p.lipFront - p.plugFront).toBeGreaterThanOrEqual(FRONT_WALL - 1e-9);
      expect(p.pocket.height).toBeCloseTo(p.bandEnd[1], 9);
      expect(p.pocket.to).toBeGreaterThan(p.bandEnd[0]);
      expect(p.pocket.from).toBeGreaterThan(p.foot);
      expect(p.channel.height).toBeLessThan(p.bar);
      // A big phone's middle is over the base.
      expect(p.phoneMiddle).toBeGreaterThan(p.rear + 5);
    }
    // At the defaults the plug's front, with room, is 18.6 mm forward: the lip's front (20.3) stays where the angle puts it.
    const p = chargingPlan(valuesOf("charging-stand"));
    expect(p.plugFront).toBeCloseTo(18.56, 2);
    expect(p.lipFront).toBeCloseTo(p.slotFront + p.bar, 9);
    // A 40 mm plug brings the front forward to keep the wall.
    const long = chargingPlan(valuesOf("charging-stand", { plugLength: 40 }));
    expect(long.lipFront).toBeCloseTo(long.plugFront + FRONT_WALL, 9);
    expect(chargingPlan(valuesOf("charging-stand", { cable: false })).floor).toBe(p.bar);
    // Leaning 45° or more from the table, its underside is at most 45° from upright.
    expect(design("charging-stand").inputs.find((i) => i.key === "angle")!.min).toBeGreaterThanOrEqual(45);
    expect(problems("charging-stand", { channelHeight: 6 })[0]).toMatch(/at most 4\.8 mm, or a thicker base/);
    expect(problems("charging-stand", { slot: 7 })[0]).toMatch(/at least 7\.5 mm wide for a charging plug/);
    expect(problems("charging-stand", { angle: 45, back: 40 })[0]).toMatch(/tip it over backwards: make the back rest at least 78 mm long/);
  });

  it("door wedge and tie anchor", () => {
    expect(wedgePlan(valuesOf("door-wedge")).grooves).toBe(26);
    expect(problems("door-wedge", { nose: 10, height: 10 })[0]).toMatch(/thin end must be lower/);
    expect(problems("door-wedge", { height: 10, nose: 2 })[0]).toMatch(/no room for the hang hole/);
    const t = tiePlan(valuesOf("tie-anchor"));
    // An M4 countersunk head (ISO 10642, 8 mm) + 0.4; the access hole lets it down.
    expect(t.screw).toEqual({ d: 4.5, head: 8.4 });
    expect(t.access).toBeCloseTo(9, 9);
    expect(tiePlan(valuesOf("tie-anchor", { screw: "M3" })).screw).toEqual({ d: 3.4, head: 6.4 });
    expect(problems("tie-anchor", { size: 15 })[0]).toMatch(/at least 17 mm across, so the tie runs under 4 mm of roof each side/);
    expect(problems("tie-anchor", { size: 15, screw: "none" })).toEqual([]);
  });
});

describe("every design of the fifth batch", () => {
  const variants: [string, DesignValues][] = [
    ...NEW.map((id): [string, DesignValues] => [id, {}]),
    ["hsw-tile", { across: 3, rows: 3, screws: "2" }],
    ["hsw-tile", { screws: "0" }],
    ["gridfinity-bit-holder", { shape: "round", size: 8, fit: 0.5, spacing: 14 }],
    ["gridfinity-lite-bin", { across: 1, wall: 1.2 }],
    ["pipe-clip", { pipe: 15, grip: 15, screws: false }],
    ["charging-stand", { cable: false, angle: 50 }],
    ["door-wedge", { grip: false, hang: false }],
    ["tie-anchor", { screw: "none" }],
    ["divider-set", { across: 0, along: 3 }],
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

  it("Edit design sizes remakes a tile in place without screw cells, and a stand without its cable slot", () => {
    const r = insertDesign(emptyDocument(), design("hsw-tile"), valuesOf("hsw-tile"), { into: MAIN_STUDIO });
    const e = editInsert(r.doc, r.insert.id, valuesOf("hsw-tile", { screws: "0", across: 4 }));
    const after = studioFeatures(e.doc, MAIN_STUDIO).map((f) => f.id);
    expect(after.some((id) => id.endsWith("_tile"))).toBe(true);
    expect(after.some((id) => id.endsWith("_fill") || id.endsWith("_screws"))).toBe(false);
    expect(e.remade).toEqual([]);
    const s = insertDesign(emptyDocument(), design("charging-stand"), valuesOf("charging-stand"), { into: MAIN_STUDIO });
    const s2 = editInsert(s.doc, s.insert.id, valuesOf("charging-stand", { cable: false }));
    expect(studioFeatures(s2.doc, MAIN_STUDIO).some((f) => f.id.endsWith("_plug"))).toBe(false);
  });
});

describe("finding them in the library", () => {
  it("under the usual headings", () => {
    const of = (g: string) => designGroups("print").find((x) => x.group === g)!.designs.map((d) => d.id);
    for (const id of ["hsw-tile", "hsw-hook", "hsw-bin", "divider-set"]) expect(of("Storage")).toContain(id);
    expect(of("Gridfinity").slice(-3)).toEqual(["gridfinity-magnet-baseplate", "gridfinity-bit-holder", "gridfinity-lite-bin"]);
    expect(of("Fixings")).toContain("pipe-clip");
    expect(of("Household")).toContain("funnel");
    expect(of("Household")).toContain("door-wedge");
    expect(of("Desk")).toContain("charging-stand");
    expect(of("Desk")).toContain("tie-anchor");
    expect(of("Workshop")).toContain("bearing-spool-holder");
  });

  it("by search", () => {
    expect(searchDesigns("honeycomb wall")[0].id).toBe("hsw-tile");
    expect(searchDesigns("honeycomb").map((d) => d.id)).toContain("hsw-tile");
    expect(searchDesigns("hsw").map((d) => d.id).slice(0, 3)).toEqual(["hsw-tile", "hsw-hook", "hsw-bin"]);
    expect(searchDesigns("magnet baseplate")[0].id).toBe("gridfinity-magnet-baseplate");
    expect(searchDesigns("gridfinity lite")[0].id).toBe("gridfinity-lite-bin");
    expect(searchDesigns("screwdriver").map((d) => d.id)).toContain("gridfinity-bit-holder");
    expect(searchDesigns("pipe")[0].id).toBe("pipe-clip");
    expect(searchDesigns("hose").map((d) => d.id)).toContain("pipe-clip");
    expect(searchDesigns("bearing")[0].id).toBe("bearing-spool-holder");
    expect(searchDesigns("funnel")[0].id).toBe("funnel");
    expect(searchDesigns("door")[0].id).toBe("door-wedge");
    expect(searchDesigns("zip tie")[0].id).toBe("tie-anchor");
    expect(searchDesigns("charging")[0].id).toBe("charging-stand");
    expect(searchDesigns("toolbox").map((d) => d.id)).toContain("divider-set");
  });
});

