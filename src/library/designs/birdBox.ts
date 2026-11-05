/**
 * A nest box for small garden birds: an open-topped finger-joint box (fingers.ts, boxPanels.ts) with a round entrance
 * hole in the front, drainage holes in the floor, two screw holes in the back to fix it up, and a lift-off roof — a
 * plate overhanging the front (to keep rain off the hole) with a smaller plate under it that drops just inside the
 * walls, so it can't slide off. Lift it off to clean the box out in autumn.
 *
 * Sizes follow the RSPB's and BTO's advice for small-hole boxes, where a laser can (see thickness below):
 *  - entrance 25 mm for blue, coal and marsh tits; 28 mm for great tits (and tree sparrows); 32 mm for house sparrows
 *    and nuthatches (RSPB Wildlife Explorers, "Make a nest box";
 *    https://www.stokegifford.org.uk/docs/nature/Making-a-Nest-Box.pdf; BTO "Nest boxes: essential guide",
 *    https://ociweb.bto.org/sites/default/files/bto-nest-boxes-essential-guide.pdf);
 *  - the bottom of the hole at least 125 mm above the floor, so cats and woodpeckers can't reach the chicks (RSPB; the BTO
 *    says at least 12 cm) — `MIN_HOLE_HEIGHT`;
 *  - the inside at least 100 mm square (RSPB) — `MIN_FLOOR`; the BTO says "a minimum of 15 cm across", so the default is 150;
 *  - drainage holes in the floor; don't nail the lid down, so the box can be cleaned (both);
 *  - the inside of the front rough, so fledglings can climb out (RSPB): score lines across the Front sketch (`climbLines`),
 *    scored on the side that goes inward;
 *  - walls: both advise 15 mm timber (the BTO: "at least 15 mm thick to provide adequate insulation"; thin wood "may
 *    overheat"). A laser can't cut that, so this is a compromise: at least `MIN_SHEET` 6 mm, and the description says to
 *    put it out of full sun, facing north to east.
 *
 * The finger box's coordinates: x across the front (0…W), y from the front to the back (0…D), z up (0…H).
 */
import { lit } from "../ex";
import { boxProblems, fingerCounts, type BoxSizes } from "../fingers";
import { boxFeatures, panelsFit, plateSketch, type PlateHole } from "../boxPanels";
import { fitsBed, offsetPolygon, r6, type P2 } from "../outlines";
import { extrudeFeature, moveFeature, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import { LID_ROOM } from "./deckBox";
import { mm, num } from "./common";

/** Entrance hole for each bird (mm across): RSPB Wildlife Explorers / BTO. */
export const BIRD_HOLES: Record<string, { hole: number; label: string }> = {
  "blue-tit": { hole: 25, label: "Blue tit (also coal and marsh tits) — 25 mm hole" },
  "great-tit": { hole: 28, label: "Great tit (also tree sparrow) — 28 mm hole" },
  "house-sparrow": { hole: 32, label: "House sparrow (also nuthatch) — 32 mm hole" },
};
/** The bottom of the hole at least this far above the floor (RSPB: 125 mm). */
export const MIN_HOLE_HEIGHT = 125;
/** The floor at least this big inside, each way (RSPB: 100 mm square). */
export const MIN_FLOOR = 100;
/** Room above the top of the hole, inside, before the roof (mm). */
export const ABOVE_HOLE = 30;
/** Drainage holes in the floor: this big across, this far in from the inside of the walls. */
export const DRAIN = { d: 6, inset: 15 };
/** Screw holes in the back (mm across): for No. 8 / 4 mm screws. */
export const SCREW_HOLE = 4.5;
/** The thinnest sheet allowed (mm): the RSPB and BTO advise 15 mm timber; thinner boxes get too hot or cold. */
export const MIN_SHEET = 6;
/** Climbing lines inside the front: this far apart, starting this far above the floor and stopping this far below the hole (mm). */
export const CLIMB = { pitch: 8, from: 10, below: 10, side: 5 };
/** How far the roof reaches past the sides (each), mm. */
export const ROOF_SIDE = 10;

export interface BirdBox {
  b: BoxSizes;
  /** Entrance hole: across, and its centre in the front panel's own coordinates (x across, z up). */
  hole: number;
  holeAt: P2;
  /** The bottom of the hole above the floor (the floor's top, z = t). */
  holeHeight: number;
  drains: P2[];
  screws: P2[];
  /** Score lines across the inside of the front (the front panel's own x, z): each from x0 to x1 at z. */
  climb: { x0: number; x1: number; z: number }[];
  /** Roof plate (x0, y0, x1, y1) on top of the walls, and the plate under it, true size. */
  roof: [number, number, number, number];
  under: [number, number, number, number];
}

export function birdBox(v: DesignValues): BirdBox {
  const [fw, fd, hh, over, t, kerf] = ["floorWidth", "floorDepth", "holeHeight", "overhang", "thickness", "kerf"].map((k) => num(v, k));
  const hole = (BIRD_HOLES[String(v.bird)] ?? BIRD_HOLES["blue-tit"]).hole;
  const W = r6(fw + 2 * t);
  const D = r6(fd + 2 * t);
  const H = r6(t + hh + hole + ABOVE_HOLE);
  const b: BoxSizes = { W: lit(W), D: lit(D), H: lit(H), t: lit(t), kerf: lit(kerf), lid: false, finger: num(v, "finger") };
  const i = t + DRAIN.inset;
  const drains: P2[] = [
    [i, i],
    [W - i, i],
    [W - i, D - i],
    [i, D - i],
  ].map(([x, y]) => [r6(x), r6(y)]);
  const screws: P2[] = [
    [r6(W / 2), r6(t + 0.25 * (H - t))],
    [r6(W / 2), r6(t + 0.75 * (H - t))],
  ];
  const room = t + LID_ROOM;
  // Clear of the side fingers (which reach t in from each edge) by CLIMB.side; from the floor's top + CLIMB.from up to
  // CLIMB.below under the hole.
  const climb: { x0: number; x1: number; z: number }[] = [];
  for (let z = t + CLIMB.from; z <= t + hh - CLIMB.below + 1e-9; z += CLIMB.pitch) climb.push({ x0: r6(t + CLIMB.side), x1: r6(W - t - CLIMB.side), z: r6(z) });
  return {
    climb,
    b,
    hole,
    holeAt: [r6(W / 2), r6(t + hh + hole / 2)],
    holeHeight: hh,
    drains,
    screws,
    roof: [-ROOF_SIDE, r6(-over), r6(W + ROOF_SIDE), D],
    under: [r6(room), r6(room), r6(W - room), r6(D - room)],
  };
}

/** The holes in each panel (true size, the panel's own coordinates). */
export function birdHoles(bb: BirdBox): { front: PlateHole[]; back: PlateHole[]; bottom: PlateHole[] } {
  return {
    front: [{ kind: "circle", c: bb.holeAt, d: bb.hole }],
    back: bb.screws.map((c): PlateHole => ({ kind: "circle", c, d: SCREW_HOLE })),
    bottom: bb.drains.map((c): PlateHole => ({ kind: "circle", c, d: DRAIN.d })),
  };
}

export function birdProblems(v: DesignValues): string[] {
  const bb = birdBox(v);
  const out = boxProblems(bb.b);
  if (out.length) return out;
  const [rx0, ry0, rx1, ry1] = bb.roof;
  if (!panelsFit(bb.b, fitsBed) || !fitsBed(rx1 - rx0, ry1 - ry0)) out.push("The box is too big for the laser's 600 × 300 mm bed.");
  return out;
}

const rect = ([x0, y0, x1, y1]: [number, number, number, number]): P2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

export const birdBoxDesign: LibraryDesign = {
  id: "bird-box",
  name: "Bird box",
  group: "Garden",
  description:
    "A nest box for blue tits, great tits or house sparrows, following the RSPB's and BTO's advice where a laser can: the right entrance hole for the bird, its bottom at least 125 mm above the floor, a floor 150 mm across inside, drainage holes, and score lines inside the front so the young can climb out — put the scored side inward (save the Front sketch for laser to get them). The RSPB and BTO advise 15 mm timber walls; laser plywood is thinner, which is a compromise — use at least 6 mm exterior plywood and hang the box out of full sun, facing north to east. The walls are finger-jointed; glue the under-plate to the roof, and the roof then lifts off for cleaning in autumn without sliding. Keep it on with a small hook and eye — don't nail it down.",
  category: "laser",
  // The Front sketch's open lines are the climbing grooves: score them.
  laser: { "front-sketch": { open: "score" } },
  prefix: "birdbox",
  icon: '<path d="M10 16h28v28H10z"/><path d="M6 16h36" stroke-width="3"/><circle cx="24" cy="26" r="4"/><path d="M14 40h20" opacity=".4"/>',
  inputs: [
    {
      key: "bird",
      label: "For which bird",
      kind: "choice",
      default: "blue-tit",
      choices: Object.entries(BIRD_HOLES).map(([value, b]) => ({ value, label: b.label })),
      help: "The entrance hole's size decides who moves in: bigger birds can't get through a small hole.",
    },
    { key: "floorWidth", label: "Floor width inside", kind: "length", default: 150, min: MIN_FLOOR, max: 250, help: "The RSPB says at least 100 mm; the BTO at least 150 mm." },
    { key: "floorDepth", label: "Floor depth inside", kind: "length", default: 150, min: MIN_FLOOR, max: 250 },
    { key: "holeHeight", label: "Hole height", kind: "length", default: 130, min: MIN_HOLE_HEIGHT, max: 230, help: "From the floor to the bottom of the hole: the RSPB says at least 125 mm, so cats can't reach in." },
    { key: "overhang", label: "Roof overhang", kind: "length", default: 30, min: 0, max: 80, help: "How far the roof reaches out over the front, to keep rain off the hole." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 6, min: MIN_SHEET, max: 10, help: "The RSPB and BTO advise 15 mm timber; thin sheet gets hot in the sun. Use the thickest exterior plywood your laser cuts (at least 6 mm), and hang the box facing north to east." },
    { key: "finger", label: "Finger width", kind: "length", default: 15, min: 4, max: 100, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: birdProblems,
  summary: (v) => {
    const bb = birdBox(v);
    const n = fingerCounts(bb.b);
    return `7 pieces; a ${mm(bb.hole)} hole, its bottom ${mm(bb.holeHeight)} above the floor; ${mm(bb.b.W.v)} × ${mm(bb.b.D.v)} × ${mm(bb.b.H.v)} outside; ${n.height} fingers up each corner.`;
  },
  make: (ctx) => {
    const bb = birdBox(ctx.values);
    const t = bb.b.t.v;
    const k2 = Math.max(0, bb.b.kerf.v) / 2;
    const made = boxFeatures(ctx, {
      b: bb.b,
      stance: "upright",
      panels: { bottom: "Floor", front: "Front", back: "Back", left: "Left side", right: "Right side" },
      holes: birdHoles(bb),
      lines: { front: bb.climb.map((l): [P2, P2] => [[l.x0, l.z], [l.x1, l.z]]) },
    });
    const features: Feature[] = [...made.features];
    const partNames = { ...made.partNames };
    const plate = (role: string, label: string, r: [number, number, number, number], dz: number) => {
      features.push(
        sketchFeature(ctx.id(`${role}-sketch`), `${label} sketch`, { kind: "default", name: "Top" }, plateSketch(offsetPolygon(rect(r), k2), [], ctx.scope)),
        extrudeFeature(ctx.id(role), label, ctx.id(`${role}-sketch`), { depth: lit(t), operation: "new" }),
        moveFeature(ctx.id(`${role}-move`), `${label} in place`, ctx.id(role), { dz: lit(r6(dz)) }),
      );
      partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`;
    };
    plate("roof", "Roof", bb.roof, bb.b.H.v);
    plate("roof-under", "Roof under-plate", bb.under, bb.b.H.v - t);
    return { features, partNames };
  },
  preview: (v) => {
    if (birdProblems(v).length) return [];
    const bb = birdBox(v);
    const [W, D, H, t] = [bb.b.W.v, bb.b.D.v, bb.b.H.v, bb.b.t.v];
    const out: PreviewShape[] = [];
    // The front, as it'll look: the walls, the floor's top, the hole and the roof over it.
    out.push({ kind: "poly", closed: true, points: rect([0, 0, W, H]) });
    out.push({ kind: "poly", points: [[0, t], [W, t]], faint: true });
    out.push({ kind: "circle", c: bb.holeAt, r: bb.hole / 2 });
    for (const l of bb.climb) out.push({ kind: "poly", points: [[l.x0, l.z], [l.x1, l.z]], faint: true });
    out.push({ kind: "poly", closed: true, points: rect([bb.roof[0], H, bb.roof[2], H + t]) });
    out.push({ kind: "poly", points: [[W + 6, t], [W + 6, t + bb.holeHeight]], faint: true });
    out.push({ kind: "text", at: [W / 2, -8], text: "front" });
    // The floor from above, with its drainage holes.
    const x0 = W + 30;
    out.push({ kind: "poly", closed: true, points: rect([x0, 0, x0 + W, D]) });
    for (const [x, y] of bb.drains) out.push({ kind: "circle", c: [x0 + x, y], r: DRAIN.d / 2 });
    out.push({ kind: "text", at: [x0 + W / 2, -8], text: "floor" });
    return out;
  },
};
