/**
 * A hook for standard pegboard (¼-inch board: holes 1 inch apart). Seen from the side it's a back plate with two pegs —
 * the top one hooks up behind the board, the bottom one stops it turning — and an arm out the front. It's drawn on Top
 * and made as thick as a peg upwards, so it prints on its side with the layers running along the arm (strong).
 */
import { lit, neg, plus, ZERO, type Ex } from "../ex";
import { extrudeFeature, outlineSketch, sketchFeature } from "../sketchKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign } from "../types";
import { mm, num, polygonArea, varsOf } from "./common";

const VARS = ["spacing", "board", "peg", "length", "tip", "thickness"];
/** The gap left behind the board, between it and the top peg's upturned end (mm). */
export const BEHIND = 0.5;
const tipped = (v: DesignValues) => v.shape !== "straight";

/** The hook seen from the side: x out from the board's front (x = 0), y up from the bottom peg's underside. */
export function pegHookOutline(vars: Record<string, Ex>, tip: boolean): Pt[] {
  const { spacing: G, board: B, peg: p, length: A, tip: h, thickness: T } = vars;
  const back = neg(plus(B, lit(BEHIND)));
  const backOut = neg(plus(B, lit(BEHIND), p));
  const top = plus(G, p);
  const end = plus(T, A);
  const arm: Pt[] = tip ? [[end, ZERO], [end, plus(T, h)], [A, plus(T, h)], [A, T]] : [[end, ZERO], [end, T]];
  return [
    [neg(B), ZERO],
    ...arm,
    [T, T],
    [T, top],
    [back, top],
    [back, plus(top, p)],
    [backOut, plus(top, p)],
    [backOut, G],
    [ZERO, G],
    [ZERO, p],
    [neg(B), p],
  ];
}

export const pegboardHook: LibraryDesign = {
  id: "pegboard-hook",
  name: "Pegboard hook",
  description:
    "A hook for standard pegboard (¼-inch board with holes 1 inch, 25.4 mm, apart). The top peg hooks up behind the board and the bottom one stops it turning; tilt it to put it in. Straight, or with an upturned end so tools don't slide off. It prints on its side, so the layers run along the arm and it's strong.",
  category: "print",
  group: "Workshop",
  prefix: "peg",
  icon: '<path d="M10 8h4v6h-4zM14 10h8v26h20v-8h4v12H14zM10 30h4v4h-4z"/>',
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
    { key: "thickness", label: "Arm thickness", kind: "length", default: 6, min: 3, max: 30, variable: true, help: "The arm and the plate against the board." },
    { key: "peg", label: "Peg size", kind: "length", default: 5.5, min: 2, max: 12, variable: true, help: "Square pegs this size (also the hook's width). 5.5 mm fits 6–6.35 mm holes." },
    { key: "spacing", label: "Hole spacing", kind: "length", default: 25.4, min: 10, max: 100, variable: true, help: "25.4 mm (1 inch) on standard pegboard; 25 mm on some metric boards." },
    { key: "board", label: "Board thickness", kind: "length", default: 6, min: 2, max: 25, variable: true, help: "¼-inch board is about 6 mm; thin board about 3.5 mm." },
  ],
  problems: (v) => {
    const [G, , p, A, h, T] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (G < p + 3) out.push(`The holes must be more than ${mm(p + 3)} apart for pegs this size.`);
    if (tipped(v) && A <= T + 1) out.push(`With an upturned end the hook must stick out more than ${mm(T + 1)}.`);
    if (T > G) out.push("The arm can't be thicker than the holes are apart.");
    if (!(h > 0)) out.push("Give the upturned end a height.");
    return out;
  },
  summary: (v) => `Fits pegboard with holes ${mm(num(v, "spacing"))} apart in a board up to ${mm(num(v, "board"))} thick. ${mm(num(v, "peg"))} wide.`,
  make: (ctx) => {
    const sk = ctx.id("sketch");
    const id = ctx.id("hook");
    return {
      features: [
        sketchFeature(sk, "Hook side sketch", { kind: "default", name: "Top" }, outlineSketch(pegHookOutline(ctx.vars, tipped(ctx.values)), ctx.scope)),
        extrudeFeature(id, "Hook", sk, { depth: ctx.vars.peg, operation: "new" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const pts = pegHookOutline(varsOf(v, VARS), tipped(v)).map(([x, y]): [number, number] => [x.v, y.v]);
    const [G, B] = [num(v, "spacing"), num(v, "board")];
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "poly", closed: true, faint: true, points: [[-B, -G * 0.5], [0, -G * 0.5], [0, G * 1.8], [-B, G * 1.8]] },
      { kind: "text", at: [-B / 2, -G * 0.75], text: "board" },
    ];
  },
};

/** For tests: the hook's volume (mm³). */
export function pegHookVolume(v: DesignValues): number {
  const pts = pegHookOutline(varsOf(v, VARS), tipped(v)).map(([x, y]): [number, number] => [x.v, y.v]);
  return polygonArea(pts) * num(v, "peg");
}
