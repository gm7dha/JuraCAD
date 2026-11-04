/**
 * A print-in-place hinge: two leaves whose knuckles take turns along a pin, with a clearance gap between everything
 * that moves, so the hinge prints as one piece (lying open, flat on the bed) and turns straight off the printer.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, varsOf } from "./common";

const VARS = ["length", "leaf", "thickness", "pin", "clearance"];
const countOf = (v: DesignValues) => Math.round(num(v, "knuckles"));

/**
 * Its sizes. The pin runs along X from 0 to `length`, at height `thickness` above the bed; the knuckles are
 * 2 × thickness across (so they stand on the bed like the leaves); leaf 1 lies towards −Y, leaf 2 towards +Y.
 * Knuckle i (0, 1, … n−1) runs from i × (k + clearance) to that + k, where k = (length − (n−1) × clearance) / n;
 * the even ones are leaf 1's (it has both ends), the odd ones leaf 2's.
 */
export function hingeSizes(vars: Record<string, Ex>, n: number) {
  const { length, clearance: c, thickness: t } = vars;
  const k = over(minus(length, times(c, n - 1)), n);
  const step = plus(k, c);
  /** Where knuckle i starts along the pin. */
  const start = (i: number) => times(step, i);
  /** The middle of the cut-away round knuckle i (for the other leaf): the knuckle plus a clearance at each end. */
  const slotMiddle = (i: number) => plus(start(i), over(k, 2));
  return { k, step, start, slotMiddle, slotLength: plus(k, times(c, 2)), slotAcross: times(plus(t, c), 2), knuckle: times(t, 2) };
}

export const hinge: LibraryDesign = {
  id: "hinge",
  name: "Print-in-place hinge",
  description:
    "A hinge that prints as one piece and moves straight off the printer: two leaves with knuckles that take turns along a pin, and a small gap between everything that moves. It prints lying open and flat. The pin is a part of its own so you can see it, but it's exactly the size of the first leaf's knuckle holes, so it prints joined to that leaf and turns in the other's. The knuckles and pin lie on their sides, so their undersides overhang a little — normal for these hinges: print it with supports turned off, so none end up in the gaps. Bend it gently a few times after printing to free it.",
  category: "print",
  prefix: "hinge",
  icon: '<path d="M6 14h16v20H6zM26 14h16v20H26z"/><path d="M22 14h4v6h-4zM22 28h4v6h-4z" opacity=".55"/><path d="M24 12v24"/>',
  inputs: [
    { key: "length", label: "Length", kind: "length", default: 50, min: 10, max: 500, variable: true, help: "Along the pin." },
    { key: "leaf", label: "Leaf width", kind: "length", default: 20, min: 5, max: 300, variable: true, help: "Each leaf, out from the pin's middle." },
    { key: "thickness", label: "Leaf thickness", kind: "length", default: 3.5, min: 1.5, max: 30, variable: true, help: "The knuckles are twice this across." },
    { key: "pin", label: "Pin diameter", kind: "length", default: 3, min: 1, max: 40, variable: true },
    { key: "knuckles", label: "Knuckles", kind: "count", default: 5, min: 3, max: 15, help: "An odd number (3, 5, 7…), so the first leaf has a knuckle at each end." },
    { key: "clearance", label: "Clearance", kind: "length", default: 0.4, min: 0.1, max: 2, variable: true, help: "The gap between the moving parts. 0.3–0.5 mm works on most printers; more if it prints stuck." },
  ],
  problems: (v) => {
    const [L, w, t, pin, c] = VARS.map((k) => num(v, k));
    const n = countOf(v);
    const out: string[] = [];
    if (n % 2 === 0) out.push("The number of knuckles must be odd (3, 5, 7…).");
    const k = (L - (n - 1) * c) / n;
    if (k < 2 * c + 1) out.push(`The knuckles would be only ${mm(k)} long: make the hinge longer than ${mm(n * (2 * c + 1) + (n - 1) * c)}, or use fewer knuckles.`);
    const wall = (2 * t - (pin + 2 * c)) / 2;
    if (wall < 0.8) out.push(`The knuckles' walls round the pin would be only ${mm(wall)} thick: make the pin smaller than ${mm(2 * t - 2 * c - 1.6)}, or the leaves thicker.`);
    if (w < t + c + 2) out.push(`The leaves must be wider than ${mm(t + c + 2)} (the knuckle and its gap, plus 2 mm).`);
    return out;
  },
  summary: (v) => {
    const n = countOf(v);
    const k = hingeSizes(varsOf(v, VARS), n).k.v;
    return `3 parts: leaf 1 has ${(n + 1) / 2} knuckles and leaf 2 has ${(n - 1) / 2}, each ${mm(k)} long.`;
  },
  make: (ctx) => {
    const { length, leaf, thickness: t, pin, clearance: c } = ctx.vars;
    const n = countOf(ctx.values);
    const s = hingeSizes(ctx.vars, n);
    const top = { kind: "default", name: "Top" } as const;
    const right = { kind: "default", name: "Right" } as const;
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const halfL = over(length, 2);
    // Right-plane sketches: across is world Y, up is world Z; extruded along +X.
    const circle = (d: Ex) => [{ type: "circle", center: ["0", t.t], diameter: d.t }];
    for (const which of [1, 2] as const) {
      const side = which === 1 ? -1 : 1;
      const p = (role: string) => ctx.id(`leaf${which}-${role}`);
      const id = ctx.id(`leaf${which}`);
      partNames[id] = `${ctx.name} leaf ${which}`;
      // The other leaf's knuckles: each cut away from this leaf, with a clearance at each end and all round.
      const others = Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === (which === 1 ? 1 : 0));
      const slots = others.map((i) => ({ type: "rectangle", center: [s.slotMiddle(i).t, "0"], width: s.slotLength.t, height: s.slotAcross.t }));
      features.push(
        sketchFeature(p("plate-sketch"), `Leaf ${which} sketch`, top, shapesSketch([{ type: "rectangle", center: [halfL.t, times(over(leaf, 2), side).t], width: length.t, height: leaf.t }], ctx.scope)),
        extrudeFeature(id, `Leaf ${which}`, p("plate-sketch"), { depth: t, operation: "new" }),
        sketchFeature(p("knuckle-sketch"), `Leaf ${which} knuckles sketch`, right, shapesSketch(circle(s.knuckle), ctx.scope)),
        extrudeFeature(p("knuckle"), `Leaf ${which} knuckles`, p("knuckle-sketch"), { depth: length, operation: "add" }),
        sketchFeature(p("gaps-sketch"), `Leaf ${which} gaps sketch`, top, shapesSketch(slots, ctx.scope)),
        extrudeFeature(p("gaps"), `Leaf ${which} gaps`, p("gaps-sketch"), { depth: plus(s.knuckle, lit(1)), operation: "remove" }),
        sketchFeature(p("bore-sketch"), `Leaf ${which} pin hole sketch`, right, shapesSketch(circle(which === 1 ? pin : plus(pin, times(c, 2))), ctx.scope)),
        extrudeFeature(p("bore"), `Leaf ${which} pin hole`, p("bore-sketch"), { operation: "remove", end: "throughAll" }),
      );
    }
    const pinId = ctx.id("pin");
    partNames[pinId] = `${ctx.name} pin`;
    features.push(sketchFeature(ctx.id("pin-sketch"), "Pin sketch", right, shapesSketch(circle(pin), ctx.scope)), extrudeFeature(pinId, "Pin", ctx.id("pin-sketch"), { depth: length, operation: "new" }));
    return { features, partNames };
  },
  preview: (v) => {
    const n = Math.max(1, Math.min(15, countOf(v)));
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
    out.push({ kind: "text", at: [L / 2, -w - w * 0.25], text: "seen from above, lying open" });
    return out;
  },
};

/** For tests: each part's volume (mm³). */
export function hingeVolumes(v: DesignValues): { leaf1: number; leaf2: number; pin: number } {
  const [L, w, t, pin, c] = VARS.map((k) => num(v, k));
  const n = countOf(v);
  const k = hingeSizes(varsOf(v, VARS), n).k.v;
  // Across a knuckle: the leaf (w × t), plus the round knuckle less the quarter of it inside the leaf, less the hole.
  const knuckle = (bore: number) => w * t + Math.PI * t * t * 0.75 - Math.PI * (bore / 2) ** 2;
  const plate = (w - t - c) * t;
  const leaf = (count: number, bore: number) => count * k * knuckle(bore) + (L - count * k) * plate;
  return { leaf1: leaf((n + 1) / 2, pin), leaf2: leaf((n - 1) / 2, pin + 2 * c), pin: Math.PI * (pin / 2) ** 2 * L };
}
