/**
 * A hook for standard pegboard (¼-inch board: holes 1 inch apart). Seen from the side it's a back plate and an arm
 * out the front, with two round pegs out of the back. The top peg has a short lip hanging down at its end: held high,
 * peg and lip together go straight through the hole; let go, the hook drops onto the bottom of the holes and the lip
 * sits behind the board below the hole's edge, so it can't pull out. To take it off, lift it and pull.
 *
 * As printed it lies on its side: the plate and arm drawn on Top and made `width` up from the bed, the pegs round rods
 * whose undersides touch the bed (their middles at peg / 2), made from the Right plane out the back (−X).
 */
import { lit, minus, over, plus, ZERO, type Ex } from "../ex";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { pickAreas } from "../laserKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign } from "../types";
import { mm, num, polygonArea, varsOf } from "./common";

const VARS = ["spacing", "board", "peg", "lip", "hole", "length", "tip", "thickness", "width"];
/** The gap left behind the board, between it and the lip (mm). */
export const BEHIND = 0.5;
/** The least room round the peg and lip together in a hole (mm), so they go straight in. */
export const PEG_ROOM = 0.3;
const tipped = (v: DesignValues) => v.shape !== "straight";

/** The plate and arm seen from the side: x out from the board's front (x = 0), y up from the arm's underside. */
export function pegHookOutline(vars: Record<string, Ex>, tip: boolean): Pt[] {
  const { spacing: G, length: A, tip: h, thickness: T } = vars;
  const end = plus(T, A);
  const arm: Pt[] = tip ? [[end, ZERO], [end, plus(T, h)], [A, plus(T, h)], [A, T]] : [[end, ZERO], [end, T]];
  return [[ZERO, ZERO], ...arm, [T, T], [T, plus(G, T)], [ZERO, plus(G, T)]];
}

/**
 * Where the pegs are: their middles' heights (y) and how high above the bed (z, so their undersides touch it); how
 * long the bottom peg is (the board) and the top one (the board, the gap and the lip, as long as the peg is thick);
 * and the lip's circle, `lip` below the peg's (a round lip, so peg and lip together are a slot shape that fits the hole).
 */
export function pegPlaces(vars: Record<string, Ex>) {
  const { spacing: G, board: B, peg: p, lip, thickness: T } = vars;
  const low = over(T, 2);
  const high = plus(G, low);
  const behind = plus(B, lit(BEHIND));
  return { low, high, z: over(p, 2), lowLength: B, behind, topLength: plus(behind, p), lipAt: minus(high, lip) };
}

export const pegboardHook: LibraryDesign = {
  id: "pegboard-hook",
  name: "Pegboard hook",
  description:
    "A hook for standard pegboard (holes 1 inch, 25.4 mm, apart). Two round pegs go in the holes; the top one has a short lip at its end. Hold the hook up, push the pegs straight in and let it drop: the lip catches behind the board. Lift it and pull to take it off. Straight, or with an upturned end so tools don't slide off. It prints on its side (the layers run along the arm, so it's strong), with the pegs lying on the bed.",
  category: "print",
  group: "Workshop",
  prefix: "peg",
  icon: '<path d="M14 10h6v26h22v-8h4v12H14z"/><path d="M14 13H7v3M14 33H8" stroke-width="3"/>',
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
    { key: "hole", label: "Board's holes", kind: "length", default: 6, min: 3, max: 15, variable: true, help: "About 6 mm on most boards; 6.35 mm (¼ inch) on some. Made for 6 mm, it fits both." },
    { key: "peg", label: "Peg diameter", kind: "length", default: 4.5, min: 2, max: 14, variable: true, help: "Round pegs. With the lip, they must go through the hole: peg + lip at least 0.3 mm less than the hole." },
    { key: "lip", label: "Lip", kind: "length", default: 1.2, min: 0.6, max: 5, variable: true, help: "How far the top peg's lip hangs down behind the board, holding the hook on." },
    { key: "spacing", label: "Hole spacing", kind: "length", default: 25.4, min: 10, max: 100, variable: true, help: "25.4 mm (1 inch) on standard pegboard; 25 mm on some metric boards." },
    { key: "board", label: "Board thickness", kind: "length", default: 6, min: 2, max: 25, variable: true, help: "¼-inch board is about 6 mm; thin board about 3.5 mm." },
  ],
  problems: (v) => {
    const [G, , p, lip, hole, A, , T, W] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (p + lip > hole - PEG_ROOM) out.push(`The peg and its lip together must be at least ${mm(PEG_ROOM)} less than the holes, so they go straight in: make them at most ${mm(hole - PEG_ROOM)} together (now ${mm(p + lip)}).`);
    if (T < p || W < p) out.push(`The arm must be at least as thick and as wide as the pegs (${mm(p)}).`);
    if (G < p + 3) out.push(`The holes must be more than ${mm(p + 3)} apart for pegs this size.`);
    if (tipped(v) && A <= T + 1) out.push(`With an upturned end the hook must stick out more than ${mm(T + 1)}.`);
    return out;
  },
  summary: (v) => {
    const [, , p, lip, hole] = VARS.map((k) => num(v, k));
    return `Round ${mm(p)} pegs with a ${mm(lip)} lip, for ${mm(hole)} holes ${mm(num(v, "spacing"))} apart in a board up to ${mm(num(v, "board"))} thick. Lift it ${mm(lip)} to take it off.`;
  },
  make: (ctx) => {
    const { peg, width } = ctx.vars;
    const at = pegPlaces(ctx.vars);
    const top = { kind: "default", name: "Top" } as const;
    const right = { kind: "default", name: "Right" } as const;
    const id = ctx.id("hook");
    // Right-plane sketches: across is world Y (up the plate), up is world Z (the pegs' middles at peg / 2).
    const circle = (y: Ex) => ({ type: "circle", center: [y.t, at.z.t], diameter: peg.t });
    const r = peg.v / 2;
    // The lip: a second rod `lip` lower, the length of the top peg, then cut back (outside the peg) to just behind the board.
    const notLip = ctx.id("lip-trim-sketch");
    const trim = pickAreas(shapesSketch([circle(at.high), circle(at.lipAt)], ctx.scope), notLip, ([y, z]) => {
      const inLip = (y - at.lipAt.v) ** 2 + (z - at.z.v) ** 2 < r * r;
      const inPeg = (y - at.high.v) ** 2 + (z - at.z.v) ** 2 < r * r;
      return inLip && !inPeg;
    });
    return {
      features: [
        sketchFeature(ctx.id("sketch"), "Hook side sketch", top, outlineSketch(pegHookOutline(ctx.vars, tipped(ctx.values)), ctx.scope)),
        extrudeFeature(id, "Hook", ctx.id("sketch"), { depth: width, operation: "new" }),
        sketchFeature(ctx.id("low-peg-sketch"), "Bottom peg sketch", right, shapesSketch([circle(at.low)], ctx.scope)),
        extrudeFeature(ctx.id("low-peg"), "Bottom peg", ctx.id("low-peg-sketch"), { depth: at.lowLength, operation: "add", flip: true }),
        sketchFeature(ctx.id("top-peg-sketch"), "Top peg and lip sketch", right, shapesSketch([circle(at.high), circle(at.lipAt)], ctx.scope)),
        extrudeFeature(ctx.id("top-peg"), "Top peg and lip", ctx.id("top-peg-sketch"), { depth: at.topLength, operation: "add", flip: true }),
        sketchFeature(notLip, "Lip trim sketch", right, trim.sketch),
        extrudeFeature(ctx.id("lip-trim"), "Lip only behind the board", notLip, { depth: at.behind, operation: "remove", flip: true, areas: trim.picks[0] }),
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
    const [x1, x2] = [-at.behind.v, -at.topLength.v];
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "poly", closed: true, points: [[0, at.low.v - r], [-B, at.low.v - r], [-B, at.low.v + r], [0, at.low.v + r]] },
      { kind: "poly", closed: true, points: [[0, at.high.v - r], [x1, at.high.v - r], [x1, at.lipAt.v - r], [x2, at.lipAt.v - r], [x2, at.high.v + r], [0, at.high.v + r]] },
      { kind: "poly", closed: true, faint: true, points: [[-B, -G * 0.4], [0, -G * 0.4], [0, G * 1.8], [-B, G * 1.8]] },
      { kind: "text", at: [-B / 2, -G * 0.6], text: "board" },
    ];
  },
};

/** For tests: its volume (mm³) — plate and arm, the two pegs, and the lip (the part of its rod outside the top peg's, behind the board). */
export function pegHookVolume(v: DesignValues): number {
  const vars = varsOf(v, VARS);
  const pts = pegHookOutline(vars, tipped(v)).map(([x, y]): [number, number] => [x.v, y.v]);
  const at = pegPlaces(vars);
  const r = num(v, "peg") / 2;
  const d = num(v, "lip");
  const circle = Math.PI * r * r;
  // Two circles of radius r, d apart, overlap by 2r²acos(d / 2r) − (d / 2)√(4r² − d²).
  const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
  return polygonArea(pts) * num(v, "width") + circle * at.lowLength.v + circle * at.topLength.v + (circle - lens) * (at.topLength.v - at.behind.v);
}
