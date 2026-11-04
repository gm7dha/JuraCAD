/**
 * A block of holes for hex screwdriver bits (or drills, pens, Allen keys): rows × columns, each hole a little bigger
 * than the bit. Made as a block with the holes cut right through (one hole, repeated with a pattern), then a floor
 * put back underneath — so every hole has a bottom and the block prints as it stands, with no supports.
 */
import { lit, plus, times, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { gridPatternFeature } from "../printKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, roundedRect } from "./common";
import { acrossCorners, hexArea } from "./boltSizes";

const countOf = (v: DesignValues, k: string) => Math.max(1, Math.round(num(v, k)));
const hexHoles = (v: DesignValues) => v.shape !== "round";

export const bitHolder: LibraryDesign = {
  id: "bit-holder",
  name: "Bit holder block",
  description:
    "A block that holds screwdriver bits upright in rows, so you can see them all and grab the one you need. Made for standard ¼-inch hex bits (6.35 mm across the flats), or round holes for drills, pens or hex keys. It prints standing as it is, no supports; the fit makes the holes a little bigger than the bits so they slide in and stay put.",
  category: "print",
  group: "Workshop",
  prefix: "bits",
  icon: '<path d="M6 16h36v20H6z"/><path d="M12 22l3-2 3 2v3l-3 2-3-2zM22 22l3-2 3 2v3l-3 2-3-2zM32 22l3-2 3 2v3l-3 2-3-2z"/>',
  inputs: [
    {
      key: "shape",
      label: "Holes",
      kind: "choice",
      default: "hex",
      choices: [
        { value: "hex", label: "Hex (for bits)" },
        { value: "round", label: "Round (drills, pens)" },
      ],
    },
    { key: "size", label: "Bit size", kind: "length", default: 6.35, min: 1, max: 40, variable: true, help: "Hex bits: across the flats (¼-inch bits are 6.35 mm). Round: the diameter." },
    { key: "fit", label: "Fit", kind: "length", default: 0.2, min: 0, max: 2, variable: true, help: "How much bigger the holes are than the bits, each side. 0.2 mm holds them snugly." },
    { key: "columns", label: "Holes along", kind: "count", default: 6, min: 1, max: 30 },
    { key: "rows", label: "Rows", kind: "count", default: 2, min: 1, max: 20 },
    { key: "spacing", label: "Spacing", kind: "length", default: 12, min: 3, max: 100, variable: true, help: "From one hole's middle to the next." },
    { key: "depth", label: "Hole depth", kind: "length", default: 12, min: 2, max: 100, variable: true, help: "How far the bits go in." },
    { key: "base", label: "Floor thickness", kind: "length", default: 2, min: 0.6, max: 20, variable: true, help: "Under the holes." },
  ],
  problems: (v) => {
    const out: string[] = [];
    const hole = num(v, "size") + 2 * num(v, "fit");
    const wide = hexHoles(v) ? acrossCorners(hole) : hole;
    if (countOf(v, "columns") * countOf(v, "rows") < 2) out.push("Have at least two holes (more holes along, or more rows).");
    if (num(v, "spacing") < wide + 1.2) out.push(`The holes must be at least ${mm(wide + 1.2)} apart, so there's a wall between them.`);
    return out;
  },
  summary: (v) => {
    const n = countOf(v, "columns") * countOf(v, "rows");
    const s = num(v, "spacing");
    return `${n} holes. The block is ${mm(countOf(v, "columns") * s)} × ${mm(countOf(v, "rows") * s)} and ${mm(num(v, "depth") + num(v, "base"))} tall.`;
  },
  make: (ctx) => {
    const { size, fit, spacing, depth, base } = ctx.vars;
    const cols = countOf(ctx.values, "columns");
    const rows = countOf(ctx.values, "rows");
    const top = { kind: "default", name: "Top" } as const;
    const id = ctx.id("block");
    const tall = plus(base, depth);
    const hole: Ex = plus(size, times(fit, 2));
    const middle = times(spacing, 0.5);
    const shape = hexHoles(ctx.values)
      ? { type: "polygon", center: [middle.t, middle.t], sides: 6, diameter: hole.t, across: "flats" }
      : { type: "circle", center: [middle.t, middle.t], diameter: hole.t };
    const block = [{ type: "rectangle", corner: ["0", "0"], width: times(spacing, cols).t, height: times(spacing, rows).t }];
    return {
      features: [
        sketchFeature(ctx.id("block-sketch"), "Block sketch", top, shapesSketch(block, ctx.scope)),
        extrudeFeature(id, "Block", ctx.id("block-sketch"), { depth: tall, operation: "new" }),
        sketchFeature(ctx.id("hole-sketch"), "Hole sketch", top, shapesSketch([shape], ctx.scope)),
        extrudeFeature(ctx.id("hole"), "Hole", ctx.id("hole-sketch"), { depth: plus(tall, lit(1)), operation: "remove" }),
        gridPatternFeature(ctx.id("holes"), "Holes", [ctx.id("hole")], cols, spacing, rows, spacing),
        // The holes went right through; a floor under them gives them a bottom.
        sketchFeature(ctx.id("floor-sketch"), "Floor sketch", top, shapesSketch(block, ctx.scope)),
        extrudeFeature(ctx.id("floor"), "Floor", ctx.id("floor-sketch"), { depth: base, operation: "add" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const cols = countOf(v, "columns");
    const rows = countOf(v, "rows");
    const s = num(v, "spacing");
    const hole = num(v, "size") + 2 * num(v, "fit");
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(cols * s, rows * s, 0, (cols * s) / 2, (rows * s) / 2) }];
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const [cx, cy] = [(i + 0.5) * s, (j + 0.5) * s];
        if (hexHoles(v)) out.push({ kind: "poly", closed: true, points: Array.from({ length: 6 }, (_, k): [number, number] => [cx + (hole / Math.sqrt(3)) * Math.cos((Math.PI / 3) * k + Math.PI / 6), cy + (hole / Math.sqrt(3)) * Math.sin((Math.PI / 3) * k + Math.PI / 6)]) });
        else out.push({ kind: "circle", c: [cx, cy], r: hole / 2 });
      }
    return out;
  },
};

/** For tests: the block's volume (mm³). */
export function bitHolderVolume(v: DesignValues): number {
  const cols = countOf(v, "columns");
  const rows = countOf(v, "rows");
  const s = num(v, "spacing");
  const hole = num(v, "size") + 2 * num(v, "fit");
  const holeArea = hexHoles(v) ? hexArea(hole) : Math.PI * (hole / 2) ** 2;
  return cols * rows * s * s * (num(v, "depth") + num(v, "base")) - cols * rows * holeArea * num(v, "depth");
}
