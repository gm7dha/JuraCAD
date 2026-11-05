/**
 * A nest box for small garden birds: an open-topped finger-joint box (fingers.ts, boxPanels.ts) with a round entrance
 * hole in the front, drainage holes in the floor, two screw holes in the back to fix it up, and a lift-off roof — a
 * plate overhanging the front (to keep rain off the hole) with a smaller plate under it that drops just inside the
 * walls, so it can't slide off. Lift it off to clean the box out in autumn.
 *
 * Sizes follow the RSPB's and BTO's advice for small-hole boxes:
 *  - entrance 25 mm for blue, coal and marsh tits; 28 mm for great tits (and tree sparrows); 32 mm for house sparrows
 *    and nuthatches (RSPB Wildlife Explorers, "Make a nest box";
 *    https://www.stokegifford.org.uk/docs/nature/Making-a-Nest-Box.pdf; BTO "Nest boxes: essential guide",
 *    https://ociweb.bto.org/sites/default/files/bto-nest-boxes-essential-guide.pdf);
 *  - the bottom of the hole at least 125 mm above the floor, so cats and woodpeckers can't reach the chicks (RSPB; the BTO
 *    says at least 12 cm) — `MIN_HOLE_HEIGHT`;
 *  - the inside at least 100 mm square (RSPB; the BTO's plans give about 120–150 mm) — `MIN_FLOOR`;
 *  - drainage holes in the floor; don't nail the lid down, so the box can be cleaned (both).
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
  return {
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
  if (num(v, "holeHeight") < MIN_HOLE_HEIGHT) out.push(`The RSPB says the bottom of the hole should be at least ${MIN_HOLE_HEIGHT} mm above the floor, so cats can't reach the chicks.`);
  if (Math.min(num(v, "floorWidth"), num(v, "floorDepth")) < MIN_FLOOR) out.push(`The RSPB says the floor should be at least ${MIN_FLOOR} mm square inside.`);
  if (bb.hole > num(v, "floorWidth") - 2 * DRAIN.inset) out.push("The entrance hole is too wide for the front.");
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
    "A nest box for blue tits, great tits or house sparrows, sized as the RSPB advises: the right entrance hole for the bird, its bottom at least 125 mm above the floor, a floor at least 100 mm square inside, and drainage holes. The walls are finger-jointed; the roof lifts off for cleaning in autumn, and a plate under it stops it sliding. Keep it on with a small hook and eye — don't nail it down. Use exterior plywood and glue.",
  category: "laser",
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
    { key: "floorWidth", label: "Floor width inside", kind: "length", default: 130, min: 80, max: 250, help: "The RSPB says at least 100 mm." },
    { key: "floorDepth", label: "Floor depth inside", kind: "length", default: 130, min: 80, max: 250 },
    { key: "holeHeight", label: "Hole height", kind: "length", default: 130, min: 80, max: 230, help: "From the floor to the bottom of the hole: at least 125 mm, so cats can't reach in." },
    { key: "overhang", label: "Roof overhang", kind: "length", default: 30, min: 0, max: 80, help: "How far the roof reaches out over the front, to keep rain off the hole." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 6, min: 3, max: 10, help: "Thicker sheet keeps the chicks warmer: 6 mm exterior plywood is good." },
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
