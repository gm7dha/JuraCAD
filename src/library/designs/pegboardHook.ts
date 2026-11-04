/**
 * A hook for standard pegboard (¼-inch board: holes 1 inch apart). Seen from the side it's a back plate and an arm
 * out the front, with two round pegs out of the back: the top one bends up behind the board (an L), the bottom one stops
 * it turning. The plate and arm are drawn on Top and made `width` thick, centred on the pegs (so the round pegs fit
 * inside the part's width), then the whole hook is lifted onto the bed: it prints on its side, with the layers running
 * along the arm (strong), and the pegs print as round rods lying down.
 */
import { lit, neg, over, plus, times, ZERO, type Ex } from "../ex";
import { extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { sweepFeature } from "../printKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign } from "../types";
import { mm, num, polygonArea, varsOf } from "./common";

const VARS = ["spacing", "board", "peg", "hole", "length", "tip", "thickness", "width"];
/** The gap left behind the board, between it and the top peg's upturned end (mm). */
export const BEHIND = 0.5;
/** The least room round a peg in its hole (mm across), so it goes in. */
export const PEG_ROOM = 0.3;
const tipped = (v: DesignValues) => v.shape !== "straight";

/** The plate and arm seen from the side: x out from the board's front (x = 0), y up from the arm's underside. */
export function pegHookOutline(vars: Record<string, Ex>, tip: boolean): Pt[] {
  const { spacing: G, length: A, tip: h, thickness: T } = vars;
  const end = plus(T, A);
  const arm: Pt[] = tip ? [[end, ZERO], [end, plus(T, h)], [A, plus(T, h)], [A, T]] : [[end, ZERO], [end, T]];
  return [[ZERO, ZERO], ...arm, [T, T], [T, plus(G, T)], [ZERO, plus(G, T)]];
}

/** Where the pegs are: their middles' heights (y), the top peg's path (out the back, then up behind the board), how long the bottom one is. */
export function pegPlaces(vars: Record<string, Ex>) {
  const { spacing: G, board: B, peg: p, thickness: T } = vars;
  const low = over(T, 2);
  const high = plus(G, low);
  /** The top peg's upright behind the board: its middle this far behind the board's front. */
  const back = neg(plus(B, lit(BEHIND), over(p, 2)));
  return { low, high, back, up: plus(high, times(p, 1.5)), lowLength: B };
}

export const pegboardHook: LibraryDesign = {
  id: "pegboard-hook",
  name: "Pegboard hook",
  description:
    "A hook for standard pegboard (holes 1 inch, 25.4 mm, apart). Two round pegs go into the holes: the top one bends up behind the board and the bottom one stops it turning; tilt it to put it in. Straight, or with an upturned end so tools don't slide off. It prints on its side, so the layers run along the arm and it's strong.",
  category: "print",
  group: "Workshop",
  prefix: "peg",
  icon: '<path d="M14 10h6v26h22v-8h4v12H14z"/><path d="M14 13h-6v-5M14 33h-5" stroke-width="3"/>',
  inputs: [
    {
      key: "shape",
      label: "Shape",
      kind: "choice",
      default: "tip",
      choices: [
        { value: "tip", label: "With an upturned end" },
        { value: "straight", label: "Straight" },
      ],
    },
    { key: "length", label: "Hook length", kind: "length", default: 50, min: 5, max: 250, variable: true, help: "How far the arm sticks out from the board." },
    { key: "tip", label: "Upturned end", kind: "length", default: 10, min: 1, max: 100, variable: true, help: "How high the end turns up (with an upturned end)." },
    { key: "thickness", label: "Arm thickness", kind: "length", default: 7, min: 3, max: 30, variable: true, help: "The arm and the plate against the board, top to bottom." },
    { key: "width", label: "Arm width", kind: "length", default: 8, min: 3, max: 40, variable: true, help: "The arm and plate, side to side (as it hangs)." },
    { key: "hole", label: "Board's holes", kind: "length", default: 6, min: 2, max: 15, variable: true, help: "About 6 mm on most boards; 6.35 mm (¼ inch) on some." },
    { key: "peg", label: "Peg diameter", kind: "length", default: 5.6, min: 2, max: 14, variable: true, help: "Round pegs, a little smaller than the holes: 5.6 mm fits both 6 mm and 6.35 mm holes." },
    { key: "spacing", label: "Hole spacing", kind: "length", default: 25.4, min: 10, max: 100, variable: true, help: "25.4 mm (1 inch) on standard pegboard; 25 mm on some metric boards." },
    { key: "board", label: "Board thickness", kind: "length", default: 6, min: 2, max: 25, variable: true, help: "¼-inch board is about 6 mm; thin board about 3.5 mm." },
  ],
  problems: (v) => {
    const [G, , p, hole, A, , T, W] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (p > hole - PEG_ROOM) out.push(`The pegs must be at least ${mm(PEG_ROOM)} smaller than the holes, so they go in: make them at most ${mm(hole - PEG_ROOM)}.`);
    if (T < p || W < p) out.push(`The arm must be at least as thick and as wide as the pegs (${mm(p)}).`);
    if (G < p + 3) out.push(`The holes must be more than ${mm(p + 3)} apart for pegs this size.`);
    if (tipped(v) && A <= T + 1) out.push(`With an upturned end the hook must stick out more than ${mm(T + 1)}.`);
    return out;
  },
  summary: (v) =>
    `Round ${mm(num(v, "peg"))} pegs for ${mm(num(v, "hole"))} holes ${mm(num(v, "spacing"))} apart, in a board up to ${mm(num(v, "board"))} thick. The arm is ${mm(num(v, "width"))} wide.`,
  make: (ctx) => {
    const { peg, width } = ctx.vars;
    const at = pegPlaces(ctx.vars);
    const top = { kind: "default", name: "Top" } as const;
    const right = { kind: "default", name: "Right" } as const;
    const id = ctx.id("hook");
    // Right-plane sketches: across is world Y (up the plate), up is world Z (its middle, z = 0, before the lift).
    const pegCircle = (y: Ex) => shapesSketch([{ type: "circle", center: [y.t, "0"], diameter: peg.t }], ctx.scope);
    return {
      features: [
        sketchFeature(ctx.id("sketch"), "Hook side sketch", top, outlineSketch(pegHookOutline(ctx.vars, tipped(ctx.values)), ctx.scope)),
        extrudeFeature(id, "Hook", ctx.id("sketch"), { depth: width, operation: "new", end: "symmetric" }),
        sketchFeature(ctx.id("low-peg-sketch"), "Bottom peg sketch", right, pegCircle(at.low)),
        extrudeFeature(ctx.id("low-peg"), "Bottom peg", ctx.id("low-peg-sketch"), { depth: at.lowLength, operation: "add", flip: true }),
        sketchFeature(ctx.id("top-peg-sketch"), "Top peg sketch", right, pegCircle(at.high)),
        sketchFeature(
          ctx.id("top-peg-path"),
          "Top peg path",
          top,
          shapesSketch(
            [
              { type: "outline", closed: false, points: [["0", at.high.t], [at.back.t, at.high.t], [at.back.t, at.up.t]] },
            ],
            ctx.scope,
          ),
        ),
        sweepFeature(ctx.id("top-peg"), "Top peg", ctx.id("top-peg-sketch"), ctx.id("top-peg-path")),
        // Made round its middle, then lifted so it lies on the bed.
        moveFeature(ctx.id("onto-bed"), "Onto the bed", id, { dz: over(width, 2) }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const vars = varsOf(v, VARS);
    const pts = pegHookOutline(vars, tipped(v)).map(([x, y]): [number, number] => [x.v, y.v]);
    const at = pegPlaces(vars);
    const [B, p] = [num(v, "board"), num(v, "peg")];
    const r = p / 2;
    const G = num(v, "spacing");
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "poly", closed: true, points: [[0, at.low.v - r], [-B, at.low.v - r], [-B, at.low.v + r], [0, at.low.v + r]] },
      { kind: "poly", closed: true, points: [[0, at.high.v - r], [at.back.v - r, at.high.v - r], [at.back.v - r, at.up.v], [at.back.v + r, at.up.v], [at.back.v + r, at.high.v + r], [0, at.high.v + r]] },
      { kind: "poly", closed: true, faint: true, points: [[-B, -G * 0.4], [0, -G * 0.4], [0, G * 1.8], [-B, G * 1.8]] },
      { kind: "text", at: [-B / 2, -G * 0.6], text: "board" },
    ];
  },
};

/** For tests: the plate and arm's volume, and the bottom peg's (mm³); the swept top peg is checked by its size. */
export function pegHookVolumes(v: DesignValues): { body: number; lowPeg: number } {
  const pts = pegHookOutline(varsOf(v, VARS), tipped(v)).map(([x, y]): [number, number] => [x.v, y.v]);
  return { body: polygonArea(pts) * num(v, "width"), lowPeg: Math.PI * (num(v, "peg") / 2) ** 2 * num(v, "board") };
}
