/**
 * A memory card holder: a block of slots that hold SD or microSD cards standing up, so you can read their labels
 * and pull out the one you want. Made like the bit holder: one slot cut right through and repeated with a pattern,
 * then a floor put back under them — it prints as it stands, no supports.
 */
import { lit } from "../ex";
import { extrudeFeature, linearPatternFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, roundedRect } from "./common";

/** The cards (mm: across, thick — from the SD Association's sizes) and how deep their slots are. */
export const CARDS: Record<string, { label: string; w: number; t: number; depth: number }> = {
  sd: { label: "SD cards (24 × 32 mm)", w: 24, t: 2.1, depth: 14 },
  micro: { label: "microSD cards (11 × 15 mm)", w: 11, t: 1, depth: 8 },
};
/** Room round each card in its slot, the walls between and round the slots, and the floor (mm). */
export const SLOT_ROOM = { width: 0.8, thick: 0.6 };
export const CARD_WALL = 2;
export const CARD_FLOOR = 1.6;

const cardOf = (v: DesignValues) => CARDS[String(v.card)] ?? CARDS.sd;
const countOf = (v: DesignValues) => Math.max(1, Math.round(num(v, "count")));

/** The slot (across, thick), the step between slots and the block's size (mm). */
export function cardLayout(v: DesignValues) {
  const c = cardOf(v);
  const slot = { w: c.w + SLOT_ROOM.width, t: c.t + SLOT_ROOM.thick };
  const step = slot.t + CARD_WALL;
  const n = countOf(v);
  return { slot, step, n, depth: c.depth, size: [n * step + CARD_WALL, slot.w + 2 * CARD_WALL, c.depth + CARD_FLOOR] as [number, number, number] };
}

export const cardHolder: LibraryDesign = {
  id: "card-holder",
  name: "SD card holder",
  description:
    "A little block with a row of slots that keep SD or microSD cards standing up, labels showing — for a camera bag, a 3D printer's shelf or the desk drawer. It prints as it stands, no supports.",
  category: "print",
  group: "Desk",
  prefix: "cards",
  icon: '<rect x="4" y="22" width="40" height="16" rx="2"/><path d="M9 10h6l2 2v14H9zM20 10h6l2 2v14h-8zM31 10h6l2 2v14h-8z" opacity=".6"/>',
  inputs: [
    { key: "card", label: "Cards", kind: "choice", default: "sd", choices: Object.entries(CARDS).map(([value, c]) => ({ value, label: c.label })) },
    { key: "count", label: "How many", kind: "count", default: 8, min: 1, max: 40 },
  ],
  problems: () => [],
  summary: (v) => {
    const L = cardLayout(v);
    return `${L.n} slots, ${mm(L.slot.t)} wide; the block is ${mm(L.size[0])} × ${mm(L.size[1])} and ${mm(L.size[2])} tall.`;
  },
  make: (ctx) => {
    const L = cardLayout(ctx.values);
    const top = { kind: "default", name: "Top" } as const;
    const id = ctx.id("block");
    const block = [{ type: "rectangle", corner: ["0", "0"], width: String(L.size[0]), height: String(L.size[1]) }];
    const r6 = (n: number) => String(Math.round(n * 1e6) / 1e6);
    const features = [
      sketchFeature(ctx.id("block-sketch"), "Block sketch", top, shapesSketch(block, ctx.scope)),
      extrudeFeature(id, "Block", ctx.id("block-sketch"), { depth: lit(L.size[2]), operation: "new" }),
      sketchFeature(ctx.id("slot-sketch"), "Slot sketch", top, shapesSketch([{ type: "rectangle", corner: [String(CARD_WALL), String(CARD_WALL)], width: r6(L.slot.t), height: r6(L.slot.w) }], ctx.scope)),
      extrudeFeature(ctx.id("slot"), "Slot", ctx.id("slot-sketch"), { depth: lit(L.size[2] + 1), operation: "remove" }),
    ];
    if (L.n > 1) features.push(linearPatternFeature(ctx.id("slots"), "Slots", [ctx.id("slot")], "x", lit(L.n), lit(Math.round(L.step * 1e6) / 1e6)));
    features.push(
      sketchFeature(ctx.id("floor-sketch"), "Floor sketch", top, shapesSketch(block, ctx.scope)),
      extrudeFeature(ctx.id("floor"), "Floor", ctx.id("floor-sketch"), { depth: lit(CARD_FLOOR), operation: "add" }),
    );
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const L = cardLayout(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(L.size[0], L.size[1], 0, L.size[0] / 2, L.size[1] / 2) }];
    for (let i = 0; i < L.n; i++) out.push({ kind: "poly", closed: true, points: roundedRect(L.slot.t, L.slot.w, 0, CARD_WALL + i * L.step + L.slot.t / 2, L.size[1] / 2) });
    return out;
  },
};

/** For tests: the block's volume (mm³). */
export function cardHolderVolume(v: DesignValues): number {
  const L = cardLayout(v);
  return L.size[0] * L.size[1] * L.size[2] - L.n * L.slot.t * L.slot.w * L.depth;
}
