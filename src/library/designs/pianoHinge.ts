/**
 * A piano hinge: a long, continuous print-in-place hinge with many short knuckles, and countersunk screw holes along
 * both leaves. It's the print-in-place hinge (hinge.ts) with the knuckle count worked out from a knuckle length, the
 * cut-outs repeated with a pattern, and the holes drilled from the leaves' top faces.
 */
import { fraction, lit, neg, over, plus, type Ex } from "../ex";
import { countersunkHoleFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { relIn, topFacePlane } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, varsOf } from "./common";
import { hingeFeatures, hingeProblems, hingeSizes, hingeVolumes } from "./hinge";

const VARS = ["length", "leaf", "thickness", "pin", "clearance"];

/** The screws offered: their hole and countersink (mm), for wood screws. */
export const PIANO_SCREWS: Record<string, { label: string; hole: number; head: number }> = {
  "3": { label: "3 mm (No. 4) screws", hole: 3.4, head: 6.5 },
  "3.5": { label: "3.5 mm (No. 6) screws", hole: 4, head: 7.5 },
  "4": { label: "4 mm (No. 8) screws", hole: 4.5, head: 8.5 },
};
const screwOf = (v: DesignValues) => PIANO_SCREWS[String(v.screw)] ?? PIANO_SCREWS["3"];
const holeCount = (v: DesignValues) => Math.max(0, Math.round(num(v, "holes")));

/** How many knuckles: the odd number (at least 3) that makes each closest to the knuckle length asked for. */
export function pianoKnuckles(length: number, knuckle: number): number {
  const n = Math.round((length / Math.max(knuckle, 1e-6) - 1) / 2) * 2 + 1;
  return Math.max(3, Math.min(MAX_KNUCKLES, n));
}
export const MAX_KNUCKLES = 199;
const knucklesOf = (v: DesignValues) => pianoKnuckles(num(v, "length"), num(v, "knuckle"));

/** Where the screw holes go on leaf 1 (leaf 2's are the same, the other side): evenly along, in the middle of the plate's free part. */
export function pianoHoleSpots(vars: Record<string, Ex>, count: number, side: 1 | -1): [Ex, Ex][] {
  const { length, leaf, thickness: t, clearance: c } = vars;
  const across = over(plus(leaf, t, c), 2);
  return Array.from({ length: count }, (_, i) => [fraction(length, 2 * i + 1, 2 * count), side === 1 ? across : neg(across)]);
}

export const pianoHinge: LibraryDesign = {
  id: "piano-hinge",
  name: "Piano hinge",
  description:
    "A long, continuous hinge that prints in one piece and moves straight off the printer — for box lids, cupboard doors and fold-down flaps. It has many short knuckles along a pin, a small gap between everything that moves, and countersunk screw holes in both leaves so the screw heads sit flush and it still folds flat. It prints lying open and flat; print it with supports off, and bend it gently a few times afterwards to free it.",
  category: "print",
  group: "Hinges",
  prefix: "piano",
  icon: '<path d="M4 12h18v24H4zM26 12h18v24H26z"/><path d="M22 12h4v4h-4zM22 20h4v4h-4zM22 28h4v4h-4z" opacity=".55"/><circle cx="10" cy="18" r="1.6"/><circle cx="10" cy="30" r="1.6"/><circle cx="38" cy="18" r="1.6"/><circle cx="38" cy="30" r="1.6"/>',
  inputs: [
    { key: "length", label: "Length", kind: "length", default: 150, min: 20, max: 1000, variable: true, help: "Along the pin. The printer's bed must be this long." },
    { key: "leaf", label: "Leaf width", kind: "length", default: 20, min: 6, max: 300, variable: true, help: "Each leaf, out from the pin's middle." },
    { key: "thickness", label: "Leaf thickness", kind: "length", default: 3, min: 1.5, max: 30, variable: true, help: "The knuckles are twice this across." },
    { key: "knuckle", label: "Knuckle length", kind: "length", default: 10, min: 3, max: 200, help: "About how long each knuckle is; the number of knuckles is worked out from it." },
    { key: "pin", label: "Pin diameter", kind: "length", default: 2.5, min: 1, max: 40, variable: true },
    { key: "clearance", label: "Clearance", kind: "length", default: 0.4, min: 0.1, max: 2, variable: true, help: "The gap between the moving parts. 0.3–0.5 mm works on most printers; more if it prints stuck." },
    { key: "holes", label: "Screw holes on each leaf", kind: "count", default: 4, min: 0, max: 40, help: "0 for none (to glue it on)." },
    { key: "screw", label: "Screws", kind: "choice", default: "3", choices: Object.entries(PIANO_SCREWS).map(([value, s]) => ({ value, label: s.label })) },
  ],
  problems: (v) => {
    const out = hingeProblems(v, knucklesOf(v));
    const [L, w, t, , c] = VARS.map((k) => num(v, k));
    const n = holeCount(v);
    if (n > 0) {
      const s = screwOf(v);
      if (w - t - c < s.head + 1.5) out.push(`The leaves are too narrow for screw holes: make them at least ${mm(t + c + s.head + 1.5)} wide, choose smaller screws, or have no holes.`);
      if ((s.head - s.hole) / 2 > t - 0.6) out.push(`The leaves are too thin to sink these screw heads: make them at least ${mm((s.head - s.hole) / 2 + 0.6)} thick, or choose smaller screws.`);
      if (L / n < s.head + 2) out.push(`${n} screw holes don't fit along ${mm(L)}: have at most ${Math.max(1, Math.floor(L / (s.head + 2)))}.`);
    }
    return out;
  },
  summary: (v) => {
    const n = knucklesOf(v);
    const k = hingeSizes(varsOf(v, VARS), n).k.v;
    const h = holeCount(v);
    return `3 parts. ${n} knuckles, each ${mm(k)} long${h ? `; ${h} countersunk screw hole${h > 1 ? "s" : ""} on each leaf` : ""}. The number of knuckles stays as it is if you change the length in Variables — use Edit design sizes for more.`;
  },
  make: (ctx) => {
    const n = knucklesOf(ctx.values);
    const holes = holeCount(ctx.values);
    const screw = screwOf(ctx.values);
    const { length: L, leaf: w, thickness: t } = ctx.vars;
    return hingeFeatures(ctx, n, {
      patterned: true,
      afterLeaf: (which, leafId): Feature[] => {
        if (holes === 0) return [];
        const side = which === 1 ? -1 : 1;
        // On the leaf's top face (the faces that meet when it's folded), so the screw heads sink in flush.
        const y = (side * (w.v + t.v)) / 2;
        const plane = topFacePlane(`Leaf ${which} top face`, leafId, t, [L.v / 2, y], relIn([L.v / 2, y, t.v], [0, which === 1 ? -w.v : -t.v, 0], [L.v, which === 1 ? t.v : w.v, 2 * t.v]));
        const spots = pianoHoleSpots(ctx.vars, holes, side);
        const sk = ctx.id(`leaf${which}-holes-sketch`);
        return [
          sketchFeature(sk, `Leaf ${which} screw holes sketch`, plane, shapesSketch(spots.map(([x, yy]) => ({ type: "circle", center: [x.t, yy.t], diameter: String(screw.hole) })), ctx.scope)),
          countersunkHoleFeature(ctx.id(`leaf${which}-holes`), `Leaf ${which} screw holes`, sk, lit(screw.hole), lit(screw.head)),
        ];
      },
    });
  },
  preview: (v) => {
    const n = Math.max(3, Math.min(MAX_KNUCKLES, knucklesOf(v)));
    const s = hingeSizes(varsOf(v, VARS), n);
    const [L, w, t] = VARS.map((k) => num(v, k));
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: [[0, -w], [L, -w], [L, -t], [0, -t]] },
      { kind: "poly", closed: true, points: [[0, t], [L, t], [L, w], [0, w]] },
    ];
    for (let i = 0; i < n; i++) {
      const x = s.start(i).v;
      out.push({ kind: "poly", closed: true, faint: i % 2 === 1, points: [[x, -t], [x + s.k.v, -t], [x + s.k.v, t], [x, t]] });
    }
    const screw = screwOf(v);
    for (const side of [-1, 1] as const) for (const [x, y] of pianoHoleSpots(varsOf(v, VARS), holeCount(v), side)) out.push({ kind: "circle", c: [x.v, y.v], r: screw.head / 2 }, { kind: "circle", c: [x.v, y.v], r: screw.hole / 2, faint: true });
    out.push({ kind: "text", at: [L / 2, -w - Math.max(w * 0.4, L * 0.04)], text: "seen from above, lying open" });
    return out;
  },
};

/** For tests: each part's volume (mm³). */
export function pianoVolumes(v: DesignValues): { leaf1: number; leaf2: number; pin: number } {
  const n = knucklesOf(v);
  const base = hingeVolumes(v, n);
  const s = screwOf(v);
  const holes = holeCount(v) * countersunkHoleVolume(s.hole, s.head, num(v, "thickness"));
  return { leaf1: base.leaf1 - holes, leaf2: base.leaf2 - holes, pin: base.pin };
}
