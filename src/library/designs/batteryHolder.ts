/**
 * A battery organiser: a block of round holes in rows and columns that hold batteries standing up — AA, AAA, C, D,
 * 18650, 21700, CR123A or any diameter you give. Made like the bit holder: a block, one hole cut right through and
 * repeated with a pattern, then a floor put back underneath, so it prints as it stands with no supports.
 */
import { lit, plus, times, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { gridPatternFeature } from "../printKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, roundedRect } from "./common";

/** Cells offered: their largest diameter and length (mm, from the IEC 60086 / maker data sheets' maximums). */
export const CELLS: Record<string, { label: string; d: number; length: number }> = {
  AA: { label: "AA", d: 14.5, length: 50.5 },
  AAA: { label: "AAA", d: 10.5, length: 44.5 },
  C: { label: "C", d: 26.2, length: 50 },
  D: { label: "D", d: 34.2, length: 61.5 },
  "18650": { label: "18650 (Li-ion)", d: 18.6, length: 65.2 },
  "21700": { label: "21700 (Li-ion)", d: 21.7, length: 70.4 },
  CR123A: { label: "CR123A", d: 17, length: 34.5 },
  custom: { label: "Another size", d: 0, length: 0 },
};

/** The batteries' diameter for these values (mm). */
export const cellDiameter = (v: DesignValues) => (v.cell === "custom" ? num(v, "diameter") : (CELLS[String(v.cell)] ?? CELLS.AA).d);
const countOf = (v: DesignValues, k: string) => Math.max(1, Math.round(num(v, k)));

/** The hole's diameter, and how far apart the holes are (expressions with the fit and wall variables). */
function holeSizes(d: number, vars: Record<string, Ex>) {
  const hole = plus(lit(d), times(vars.fit, 2));
  return { hole, pitch: plus(hole, vars.wall) };
}

export const batteryHolder: LibraryDesign = {
  id: "battery-holder",
  name: "Battery organiser",
  description:
    "A tidy block that holds batteries standing up in rows — AA, AAA, C, D, 18650 or any size — so you can see at a glance what's left, for a drawer or a shelf. It prints standing as it is, no supports. The fit makes the holes a little bigger than the batteries so they drop in and lift out easily.",
  category: "print",
  group: "Storage",
  prefix: "batt",
  icon: '<rect x="5" y="14" width="38" height="24" rx="2"/><circle cx="13" cy="22" r="3.5"/><circle cx="24" cy="22" r="3.5"/><circle cx="35" cy="22" r="3.5"/><circle cx="13" cy="31" r="3.5" opacity=".55"/><circle cx="24" cy="31" r="3.5" opacity=".55"/><circle cx="35" cy="31" r="3.5" opacity=".55"/>',
  inputs: [
    { key: "cell", label: "Batteries", kind: "choice", default: "AA", choices: Object.entries(CELLS).map(([value, c]) => ({ value, label: c.label })) },
    { key: "diameter", label: "Battery diameter", kind: "length", default: 20, min: 3, max: 60, help: "For another size: measure across the battery." },
    { key: "columns", label: "Holes across", kind: "count", default: 6, min: 1, max: 30 },
    { key: "rows", label: "Rows", kind: "count", default: 2, min: 1, max: 20 },
    { key: "depth", label: "Hole depth", kind: "length", default: 18, min: 3, max: 80, variable: true, help: "How far they go in: a third of their length holds them well." },
    { key: "fit", label: "Fit", kind: "length", default: 0.3, min: 0, max: 2, variable: true, help: "How much bigger each hole is than the battery, each side." },
    { key: "wall", label: "Wall between", kind: "length", default: 1.6, min: 0.8, max: 10, variable: true },
    { key: "floor", label: "Floor thickness", kind: "length", default: 1.6, min: 0.6, max: 10, variable: true },
  ],
  problems: (v) => {
    const out: string[] = [];
    if (countOf(v, "columns") * countOf(v, "rows") < 2) out.push("Have at least two holes (more holes across, or more rows).");
    const length = v.cell === "custom" ? Infinity : (CELLS[String(v.cell)] ?? CELLS.AA).length;
    if (num(v, "depth") > length - 8) out.push(`Holes ${mm(num(v, "depth"))} deep would swallow ${String(v.cell)} batteries (${mm(length)} long): make them at most ${mm(length - 8)} deep, so there's something to hold.`);
    return out;
  },
  summary: (v) => {
    const d = cellDiameter(v);
    const pitch = d + 2 * num(v, "fit") + num(v, "wall");
    const [c, r] = [countOf(v, "columns"), countOf(v, "rows")];
    return `${c * r} batteries ${mm(d)} across. The block is ${mm(c * pitch + num(v, "wall"))} × ${mm(r * pitch + num(v, "wall"))} and ${mm(num(v, "depth") + num(v, "floor"))} tall.`;
  },
  make: (ctx) => {
    const { depth, floor, wall } = ctx.vars;
    const cols = countOf(ctx.values, "columns");
    const rows = countOf(ctx.values, "rows");
    const { hole, pitch } = holeSizes(cellDiameter(ctx.values), ctx.vars);
    const top = { kind: "default", name: "Top" } as const;
    const id = ctx.id("block");
    const tall = plus(floor, depth);
    // Holes `pitch` apart, with a whole wall at the edges.
    const first = times(plus(pitch, wall), 0.5);
    const block = [{ type: "rectangle", corner: ["0", "0"], width: plus(times(pitch, cols), wall).t, height: plus(times(pitch, rows), wall).t }];
    return {
      features: [
        sketchFeature(ctx.id("block-sketch"), "Block sketch", top, shapesSketch(block, ctx.scope)),
        extrudeFeature(id, "Block", ctx.id("block-sketch"), { depth: tall, operation: "new" }),
        sketchFeature(ctx.id("hole-sketch"), "Hole sketch", top, shapesSketch([{ type: "circle", center: [first.t, first.t], diameter: hole.t }], ctx.scope)),
        extrudeFeature(ctx.id("hole"), "Hole", ctx.id("hole-sketch"), { depth: plus(tall, lit(1)), operation: "remove" }),
        gridPatternFeature(ctx.id("holes"), "Holes", [ctx.id("hole")], cols, pitch, rows, pitch),
        sketchFeature(ctx.id("floor-sketch"), "Floor sketch", top, shapesSketch(block, ctx.scope)),
        extrudeFeature(ctx.id("floor"), "Floor", ctx.id("floor-sketch"), { depth: floor, operation: "add" }),
      ],
      partNames: { [id]: `${ctx.name} (${ctx.values.cell === "custom" ? mm(cellDiameter(ctx.values)) : String(ctx.values.cell)})` },
    };
  },
  preview: (v) => {
    const [c, r] = [countOf(v, "columns"), countOf(v, "rows")];
    const d = cellDiameter(v);
    const hole = d + 2 * num(v, "fit");
    const wall = num(v, "wall");
    const pitch = hole + wall;
    const [W, H] = [c * pitch + wall, r * pitch + wall];
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(W, H, 0, W / 2, H / 2) }];
    for (let i = 0; i < c; i++) for (let j = 0; j < r; j++) out.push({ kind: "circle", c: [(pitch + wall) / 2 + i * pitch, (pitch + wall) / 2 + j * pitch], r: hole / 2 });
    return out;
  },
};

/** For tests: the block's volume (mm³). */
export function batteryVolume(v: DesignValues): number {
  const [c, r] = [countOf(v, "columns"), countOf(v, "rows")];
  const hole = cellDiameter(v) + 2 * num(v, "fit");
  const pitch = hole + num(v, "wall");
  const [W, H] = [c * pitch + num(v, "wall"), r * pitch + num(v, "wall")];
  return W * H * (num(v, "depth") + num(v, "floor")) - c * r * Math.PI * (hole / 2) ** 2 * num(v, "depth");
}
