/**
 * A tissue box cover: a finger-jointed box with no bottom (boxPanels.ts "upsideDown": an open-topped finger box turned
 * over), dropped over a box of tissues, with a slot in the top for the tissues to come through. Sized from the tissue
 * box, with `room` all round it.
 *
 * Cover coordinates: x across (0…W), y front to back (0…D), z up (0…H); the top is z = H − t…H, the bottom edges open.
 * Inside: W − 2t × D − 2t, H − t high.
 */
import { lit } from "../ex";
import { boxProblems, fingerCounts, type BoxSizes } from "../fingers";
import { boxFeatures, panelsFit, type PlateHole } from "../boxPanels";
import { fitsBed, r6 } from "../outlines";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num } from "./common";

export interface TissueCover {
  b: BoxSizes;
  /** The slot in the top (the top's own x, y): centres of its round ends, and how wide. */
  slot: { a: [number, number]; b: [number, number]; w: number };
}

export function tissueCover(v: DesignValues): TissueCover {
  const [bw, bd, bh, room, sl, sw, t, kerf] = ["boxWidth", "boxDepth", "boxHeight", "room", "slotLength", "slotWidth", "thickness", "kerf"].map((k) => num(v, k));
  const W = r6(bw + 2 * room + 2 * t);
  const D = r6(bd + 2 * room + 2 * t);
  const H = r6(bh + room + t);
  const b: BoxSizes = { W: lit(W), D: lit(D), H: lit(H), t: lit(t), kerf: lit(kerf), lid: false, finger: num(v, "finger") };
  // The long way of the slot along the longer side of the top.
  const along = W >= D;
  const half = Math.max(0, sl - sw) / 2;
  const [cx, cy] = [r6(W / 2), r6(D / 2)];
  const slot = along ? { a: [r6(cx - half), cy] as [number, number], b: [r6(cx + half), cy] as [number, number], w: sw } : { a: [cx, r6(cy - half)] as [number, number], b: [cx, r6(cy + half)] as [number, number], w: sw };
  return { b, slot };
}

/** The straight middle of the slot (for the preview). */
function slotBand(c: TissueCover): [number, number][] {
  const { a, b, w } = c.slot;
  const [ox, oy] = a[1] === b[1] ? [0, w / 2] : [w / 2, 0];
  return [
    [a[0] - ox, a[1] - oy],
    [b[0] + ox, b[1] - oy],
    [b[0] + ox, b[1] + oy],
    [a[0] - ox, a[1] + oy],
  ];
}

export const tissueSlot = (c: TissueCover): PlateHole => ({ kind: "slot", ...c.slot });

export function tissueProblems(v: DesignValues): string[] {
  const c = tissueCover(v);
  const out = boxProblems(c.b);
  if (out.length) return out;
  const [sl, sw] = ["slotLength", "slotWidth"].map((k) => num(v, k));
  const t = c.b.t.v;
  if (sw > sl) return ["The slot can't be wider than it is long."];
  const [W, D] = [c.b.W.v, c.b.D.v];
  const [long, short] = [Math.max(W, D), Math.min(W, D)];
  if (sl > long - 2 * t - 20 || sw > short - 2 * t - 20) return ["The slot is too big for the top: leave at least 10 mm all round it."];
  if (!panelsFit(c.b, fitsBed)) out.push("The cover is too big for the laser's 600 × 300 mm bed.");
  return out;
}

export const tissueBoxDesign: LibraryDesign = {
  id: "tissue-box",
  name: "Tissue box cover",
  group: "Boxes and stands",
  description:
    "A finger-jointed cover that drops over a box of tissues, with a rounded slot in the top for them to come through. Measure your tissue box: a cube box is often about 115 × 115 × 125 mm, a flat one about 240 × 120 × 85 mm. The bottom is open, so you just lift it off to change the box.",
  category: "laser",
  prefix: "tissues",
  icon: '<path d="M8 18h32v24H8z"/><path d="M16 18a8 3 0 0 0 16 0" /><path d="M20 18c0-6 4-10 4-12 0 2 4 6 4 12" opacity=".6"/>',
  inputs: [
    { key: "boxWidth", label: "Tissue box width", kind: "length", default: 115, min: 40, max: 280 },
    { key: "boxDepth", label: "Tissue box depth", kind: "length", default: 115, min: 40, max: 280 },
    { key: "boxHeight", label: "Tissue box height", kind: "length", default: 125, min: 30, max: 280 },
    { key: "room", label: "Room round it", kind: "length", default: 2, min: 0.5, max: 10, help: "Each side and above, so the cover drops on easily." },
    { key: "slotLength", label: "Slot length", kind: "length", default: 80, min: 20, max: 250 },
    { key: "slotWidth", label: "Slot width", kind: "length", default: 30, min: 10, max: 120 },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 10, min: 2, max: 100, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: tissueProblems,
  summary: (v) => {
    const c = tissueCover(v);
    const n = fingerCounts(c.b);
    return `5 pieces, ${mm(c.b.W.v)} × ${mm(c.b.D.v)} × ${mm(c.b.H.v)} outside, open underneath; ${n.height} fingers up the corners.`;
  },
  make: (ctx) => {
    const c = tissueCover(ctx.values);
    return boxFeatures(ctx, {
      b: c.b,
      stance: "upsideDown",
      panels: { bottom: "Top", front: "Front", back: "Back", left: "Left side", right: "Right side" },
      holes: { bottom: [tissueSlot(c)] },
    });
  },
  preview: (v) => {
    if (tissueProblems(v).length) return [];
    const c = tissueCover(v);
    const [W, D, H] = [c.b.W.v, c.b.D.v, c.b.H.v];
    const { a, b, w } = c.slot;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: [[0, 0], [W, 0], [W, D], [0, D]] },
      { kind: "circle", c: a, r: w / 2 },
      { kind: "circle", c: b, r: w / 2 },
      { kind: "poly", closed: true, faint: true, points: slotBand(c) },
      { kind: "text", at: [W / 2, -8], text: "top" },
      { kind: "poly", closed: true, points: [[W + 20, 0], [2 * W + 20, 0], [2 * W + 20, H], [W + 20, H]] },
      { kind: "text", at: [1.5 * W + 20, -8], text: "front" },
    ];
    return out;
  },
};
