/** A wall hook with countersunk screw holes, for 3D printing (it prints lying on its side). */
import { minus, plus, fraction, times, ZERO, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, varsOf } from "./common";

const VARS = ["depth", "height", "width", "thickness", "tip", "hole"];
const holeCount = (v: DesignValues) => (v.holes === "1" ? 1 : 2);

/**
 * The hook seen from the side (x out from the wall, y up), drawn on Top and made as thick as its width upwards, so it
 * prints on its side. The back plate's front face is on the Right plane (x = 0), where the screw heads sit; the wall is
 * at x = −thickness.
 */
export function hookOutline(v: Record<string, Ex>): Pt[] {
  const { depth, height, thickness: t, tip } = v;
  const front = minus(depth, t);
  const tipInside = minus(depth, times(t, 2));
  return [
    [minus(ZERO, t), ZERO],
    [front, ZERO],
    [front, tip],
    [tipInside, tip],
    [tipInside, t],
    [ZERO, t],
    [ZERO, height],
    [minus(ZERO, t), height],
  ];
}

/** Heights of the screw holes up the back plate: evenly spread above the arm. */
export function hookHoleHeights(v: Record<string, Ex>, n: number): Ex[] {
  const { height, thickness: t } = v;
  const free = minus(height, t);
  return n === 1 ? [plus(t, fraction(free, 1, 2))] : [plus(t, fraction(free, 1, 3)), plus(t, fraction(free, 2, 3))];
}

/** The countersink's size for a hole: twice across (90°, as for a countersunk wood screw). */
export const countersinkFor = (hole: Ex) => times(hole, 2);

export const hook: LibraryDesign = {
  id: "hook",
  name: "Wall hook",
  description:
    "A J-shaped hook that screws to a wall, with countersunk holes so the screw heads sit flush. It prints lying on its side, so the layers run along the hook and it's strong; the screw holes print sideways, which small holes do fine without supports.",
  category: "print",
  group: "Household",
  prefix: "hook",
  icon: '<path d="M14 6h6v30h12v-8h6v14H14z"/><circle cx="17" cy="13" r="1.5"/><circle cx="17" cy="23" r="1.5"/>',
  inputs: [
    { key: "depth", label: "Hook depth", kind: "length", default: 40, min: 5, max: 500, variable: true, help: "How far it sticks out from the wall." },
    { key: "height", label: "Height", kind: "length", default: 60, min: 10, max: 500, variable: true, help: "The back plate, up the wall." },
    { key: "width", label: "Width", kind: "length", default: 20, min: 4, max: 500, variable: true },
    { key: "thickness", label: "Thickness", kind: "length", default: 5, min: 1.5, max: 50, variable: true, help: "5 mm holds a coat or a bag." },
    { key: "tip", label: "Tip height", kind: "length", default: 15, min: 1, max: 500, variable: true, help: "How high the end turns up, so things don't slide off." },
    { key: "hole", label: "Screw hole", kind: "length", default: 4.5, min: 1, max: 20, variable: true, help: "4.5 mm suits a 4 mm wood screw." },
    {
      key: "holes",
      label: "Screw holes",
      kind: "choice",
      default: "2",
      choices: [
        { value: "1", label: "One" },
        { value: "2", label: "Two" },
      ],
    },
  ],
  problems: (v) => {
    const [D, H, W, t, tip, d] = VARS.map((k) => num(v, k));
    const n = holeCount(v);
    const out: string[] = [];
    if (D <= 3 * t) out.push(`The hook must stick out more than three times its thickness (more than ${mm(3 * t)}).`);
    if (tip <= t) out.push(`The tip must be taller than the hook is thick (more than ${mm(t)}).`);
    if (tip >= H) out.push(`The tip must be lower than the back plate (less than ${mm(H)}).`);
    if (2 * d + 2 > W) out.push(`The screw holes' countersinks (${mm(2 * d)}) don't fit across: make it at least ${mm(2 * d + 2)} wide, or the holes smaller.`);
    if (d / 2 + 1 > t) out.push(`It's too thin for countersunk holes of ${mm(d)}: make it at least ${mm(d / 2 + 1)} thick.`);
    const room = (H - t) / (n === 1 ? 2 : 3);
    if (room < d + 1) out.push(`The back plate is too short for ${n === 1 ? "the hole" : "two holes"}: make it at least ${mm(t + (d + 1) * (n === 1 ? 2 : 3))} high.`);
    return out;
  },
  summary: (v) => `${holeCount(v) === 1 ? "One countersunk hole" : "Two countersunk holes"} of ${mm(num(v, "hole"))} (${mm(2 * num(v, "hole"))} across the top).`,
  make: (ctx) => {
    const { width, hole } = ctx.vars;
    const id = ctx.id("hook");
    const top = { kind: "default", name: "Top" } as const;
    const right = { kind: "default", name: "Right" } as const;
    // Right-plane sketches: across is world Y (up the hook here), up is world Z (across its width).
    const holes = hookHoleHeights(ctx.vars, holeCount(ctx.values)).map((y) => ({ type: "circle", center: [y.t, fraction(width, 1, 2).t], diameter: hole.t }));
    return {
      features: [
        sketchFeature(ctx.id("profile"), "Hook profile", top, outlineSketch(hookOutline(ctx.vars), ctx.scope)),
        extrudeFeature(id, "Hook", ctx.id("profile"), { depth: width, operation: "new" }),
        sketchFeature(ctx.id("holes-sketch"), "Screw holes sketch", right, shapesSketch(holes, ctx.scope)),
        countersunkHoleFeature(ctx.id("holes"), "Screw holes", ctx.id("holes-sketch"), hole, countersinkFor(hole)),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const vars = varsOf(v, VARS);
    const pts = hookOutline(vars).map(([x, y]) => [x.v, y.v] as [number, number]);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: pts }];
    for (const y of hookHoleHeights(vars, holeCount(v))) {
      const t = vars.thickness.v;
      out.push({ kind: "poly", faint: true, points: [[-t, y.v - vars.hole.v / 2], [0, y.v - vars.hole.v / 2]] }, { kind: "poly", faint: true, points: [[-t, y.v + vars.hole.v / 2], [0, y.v + vars.hole.v / 2]] });
    }
    out.push({ kind: "text", at: [vars.depth.v / 2, -vars.height.v * 0.1], text: `${mm(vars.depth.v)} out, ${mm(vars.width.v)} wide` });
    return out;
  },
};
