/**
 * An earring and jewellery stand: two plates that slot together into a cross (one slotted down from the top, the other
 * up from the bottom, each slot half the height and as wide as the sheet — a halving joint), each with a grid of small
 * holes on both sides of the slot to hang earrings from. It stands on its four arms.
 *
 * Each plate's own coordinates: x across (−w/2…w/2), z up (0…h); the top corners are cut off at 45°. The first plate is
 * drawn on the Front plane and stands at y = −t/2…t/2; the second on the Right plane at x = −t/2…t/2.
 *
 * Kerf: outlines are drawn kerf/2 bigger all round, which makes each slot kerf narrower — it comes out exactly the sheet's
 * thickness, so the plates fit snugly; holes are drawn kerf smaller across, so they come out their true size.
 */
import { lit } from "../ex";
import { plateSketch, type PlateHole } from "../boxPanels";
import { fitsBed, insideGap, offsetPolygon, r6, type P2 } from "../outlines";
import { holePoints } from "../patterns";
import { extrudeFeature, moveFeature, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import { mm, num } from "./common";

/** Sheet to leave between holes, and between a hole and an edge or the slot (mm). */
export const HOLE_WEB = 2;
/** The hole grid keeps this far from the plate's sides and top (mm). */
export const GRID_EDGE = 8;
/** The lowest row of holes is this share of the height up (below it the plates are its feet). */
export const GRID_FROM = 0.4;

export interface EarringStand {
  w: number;
  h: number;
  t: number;
  kerf: number;
  /** Corner cut off the top (each way). */
  chamfer: number;
  /** The plates' true outlines: the first slotted from the top, the second from the bottom. */
  plates: [P2[], P2[]];
  /** Hole centres (the same on both plates). */
  holes: P2[];
  hole: number;
}

export function earringStand(v: DesignValues): EarringStand {
  const [w, h, rows, cols, hole, t, kerf] = ["width", "height", "rows", "columns", "hole", "thickness", "kerf"].map((k) => num(v, k));
  const c = r6(Math.min(w, h) * 0.15);
  const [x0, x1] = [-w / 2, w / 2];
  const s = t / 2;
  const top = (slotFromTop: boolean): P2[] =>
    slotFromTop
      ? [
          [x0, 0],
          [x1, 0],
          [x1, h - c],
          [x1 - c, h],
          [s, h],
          [s, h / 2],
          [-s, h / 2],
          [-s, h],
          [x0 + c, h],
          [x0, h - c],
        ]
      : [
          [x0, 0],
          [-s, 0],
          [-s, h / 2],
          [s, h / 2],
          [s, 0],
          [x1, 0],
          [x1, h - c],
          [x1 - c, h],
          [x0 + c, h],
          [x0, h - c],
        ];
  const r = (p: P2[]) => p.map(([x, y]): P2 => [r6(x), r6(y)]);
  // The grid: `cols` columns each side of the slot, `rows` rows from GRID_FROM of the height to near the top.
  const xa = s + GRID_EDGE;
  const xb = w / 2 - GRID_EDGE;
  const za = h * GRID_FROM;
  const zb = h - GRID_EDGE;
  const holes: P2[] = [];
  for (let j = 0; j < rows; j++) {
    const z = rows === 1 ? (za + zb) / 2 : za + ((zb - za) * j) / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const x = cols === 1 ? (xa + xb) / 2 : xa + ((xb - xa) * i) / (cols - 1);
      holes.push([r6(x), r6(z)], [r6(-x), r6(z)]);
    }
  }
  // Holes the cut-off top corners would come too near are left out.
  const plates: [P2[], P2[]] = [r(top(true)), r(top(false))];
  const clear = (p: P2) => plates.every((pl) => insideGap(holePoints({ kind: "circle", c: p, d: hole }, 48), pl) >= GRID_EDGE / 2);
  return { w, h, t, kerf, chamfer: c, plates, holes: holes.filter(clear), hole };
}

/** The narrowest sheet between two holes, and between a hole and the plate's edge (either plate). */
export function standGaps(e: EarringStand): { between: number; edge: number } {
  let between = Infinity;
  for (let i = 0; i < e.holes.length; i++)
    for (let j = i + 1; j < e.holes.length; j++) between = Math.min(between, Math.hypot(e.holes[i][0] - e.holes[j][0], e.holes[i][1] - e.holes[j][1]) - e.hole);
  let edge = Infinity;
  for (const plate of e.plates) for (const c of e.holes) edge = Math.min(edge, insideGap(holePoints({ kind: "circle", c, d: e.hole }, 48), plate));
  return { between, edge };
}

export function earringProblems(v: DesignValues): string[] {
  const e = earringStand(v);
  if (e.kerf >= e.t / 2) return [`A kerf allowance of ${mm(e.kerf)} is a lot for ${mm(e.t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (e.w / 2 - e.t / 2 - 2 * GRID_EDGE < e.hole) return ["The plates are too narrow for the holes: make them wider."];
  if (e.hole - e.kerf < 0.8) return ["The holes are too small to cut: make them at least 1 mm."];
  const g = standGaps(e);
  if (g.between < HOLE_WEB) return [`The holes come closer than ${mm(HOLE_WEB)} to each other: fewer rows or columns, or smaller holes.`];
  if (!e.holes.length) return ["There's no room for any holes: make the plates bigger."];
  if (g.edge < HOLE_WEB) return ["Some holes are too near the edge: fewer rows or columns."];
  if (!fitsBed(e.w, e.h)) return ["The plates are too big for the laser's 600 × 300 mm bed."];
  return [];
}

export const earringStandDesign: LibraryDesign = {
  id: "earring-stand",
  name: "Earring stand",
  group: "Home",
  description:
    "A jewellery stand of two plates that slot together into a cross, each with a grid of small holes to hang earrings from. It stands on its four arms; drape necklaces over the top. The slots are cut exactly the sheet's thickness, so it holds together without glue.",
  category: "laser",
  prefix: "earrings",
  icon: '<path d="M6 44h36M24 44V6M12 44V18l6-6h12l6 6v26" /><circle cx="16" cy="22" r="1.5"/><circle cx="16" cy="30" r="1.5"/><circle cx="32" cy="22" r="1.5"/><circle cx="32" cy="30" r="1.5"/><circle cx="16" cy="38" r="1.5"/><circle cx="32" cy="38" r="1.5"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 150, min: 60, max: 290, help: "Each plate, side to side (so the cross is this wide each way)." },
    { key: "height", label: "Height", kind: "length", default: 180, min: 60, max: 290 },
    { key: "rows", label: "Rows of holes", kind: "count", default: 5, min: 1, max: 30 },
    { key: "columns", label: "Holes each side", kind: "count", default: 3, min: 1, max: 20, help: "Columns of holes on each side of the slot." },
    { key: "hole", label: "Hole size", kind: "length", default: 2, min: 1, max: 10, help: "Earring hooks need about 1.5–2 mm." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood or acrylic is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). The slots are drawn this much narrower so they grip." },
  ],
  problems: earringProblems,
  summary: (v) => {
    const e = earringStand(v);
    return `2 plates, ${mm(e.w)} × ${mm(e.h)}; ${2 * e.holes.length} holes in all.`;
  },
  make: (ctx) => {
    const e = earringStand(ctx.values);
    const k = Math.max(0, e.kerf);
    const holes = e.holes.map((c): PlateHole => ({ kind: "circle", c, d: r6(e.hole - k) }));
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const plates = [
      { role: "plate-front", label: "Front plate", plane: "Front" as const, flip: true, move: { dy: lit(r6(-e.t / 2)) } },
      { role: "plate-side", label: "Side plate", plane: "Right" as const, flip: false, move: { dx: lit(r6(-e.t / 2)) } },
    ];
    plates.forEach((p, i) => {
      const sk = ctx.id(`${p.role}-sketch`);
      features.push(
        sketchFeature(sk, `${p.label} sketch`, { kind: "default", name: p.plane }, plateSketch(offsetPolygon(e.plates[i], k / 2), holes, ctx.scope)),
        extrudeFeature(ctx.id(p.role), p.label, sk, { depth: lit(e.t), operation: "new", flip: p.flip }),
        moveFeature(ctx.id(`${p.role}-move`), `${p.label} in place`, ctx.id(p.role), p.move),
      );
      partNames[ctx.id(p.role)] = `${ctx.name} ${p.label.toLowerCase()}`;
    });
    return { features, partNames };
  },
  preview: (v) => {
    if (earringProblems(v).length) return [];
    const e = earringStand(v);
    const out: PreviewShape[] = [];
    e.plates.forEach((p, i) => {
      const dx = i * (e.w + 15);
      out.push({ kind: "poly", closed: true, points: p.map(([x, y]) => [x + dx, y] as P2) });
      for (const [x, y] of e.holes) out.push({ kind: "circle", c: [x + dx, y], r: Math.max(0.8, e.hole / 2) });
    });
    return out;
  },
};
