/**
 * A drawer or cupboard pull handle: a bar on two feet, with screw holes up into the feet from the back (the screws
 * come through the drawer front). Seen from above it's drawn on Top and made as wide as the grip upwards, so it prints
 * on its side: the layers run along the bar, which makes it strong where it's pulled.
 */
import { lit, minus, neg, over, plus, type Ex } from "../ex";
import { extrudeFeature, outlineSketch, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign } from "../types";
import { mm, num, polygonArea, varsOf } from "./common";

const VARS = ["span", "height", "grip", "width", "foot", "round"];

/** The screws offered: the hole each cuts its own thread in (mm), a little under the screw. */
export const PULL_SCREWS: Record<string, { label: string; hole: number }> = {
  M3: { label: "M3 screws", hole: 2.6 },
  M4: { label: "M4 screws (the usual)", hole: 3.4 },
  M5: { label: "M5 screws", hole: 4.3 },
};
const screwOf = (v: DesignValues) => PULL_SCREWS[String(v.screw)] ?? PULL_SCREWS.M4;
/** How far short of the top of the handle the screw holes stop (mm). */
export const HOLE_TOP = 3;

/** The handle seen from above: x along it (the screw holes at ± span / 2), y out from the drawer (y = 0 against it). */
export function pullOutline(vars: Record<string, Ex>): Pt[] {
  const { span, height: H, grip, foot } = vars;
  const half = over(span, 2);
  const f = over(foot, 2);
  const under = minus(H, grip);
  const z = lit(0);
  return [
    [neg(plus(half, f)), z],
    [neg(minus(half, f)), z],
    [neg(minus(half, f)), under],
    [minus(half, f), under],
    [minus(half, f), z],
    [plus(half, f), z],
    [plus(half, f), H],
    [neg(plus(half, f)), H],
  ];
}

export const drawerPull: LibraryDesign = {
  id: "drawer-pull",
  name: "Drawer pull handle",
  description:
    "A handle for drawers and cupboard doors: a bar on two feet, held on by two screws through the door into the feet. Standard handles have their screws 64, 96 or 128 mm apart, so a new handle fits the old holes. It prints on its side, so the layers run along the bar and it's strong where you pull. The holes are a little under the screw size, so the screws cut their own thread.",
  category: "print",
  group: "Household",
  prefix: "pull",
  icon: '<path d="M6 30h8v-14h20v14h8v-20H6z"/><path d="M10 30v6M38 30v6" opacity=".55"/>',
  inputs: [
    { key: "span", label: "Screw spacing", kind: "length", default: 96, min: 16, max: 600, variable: true, help: "From one screw hole to the other: usually 64, 96 or 128 mm." },
    { key: "height", label: "Height", kind: "length", default: 32, min: 12, max: 120, variable: true, help: "How far it stands out from the door." },
    { key: "grip", label: "Bar thickness", kind: "length", default: 9, min: 4, max: 40, variable: true, help: "The part you hold, front to back." },
    { key: "width", label: "Bar width", kind: "length", default: 12, min: 6, max: 60, variable: true, help: "The part you hold, top to bottom." },
    { key: "foot", label: "Foot length", kind: "length", default: 12, min: 6, max: 60, variable: true, help: "Each foot, along the handle." },
    { key: "round", label: "Rounded corners", kind: "length", default: 2, min: 0, max: 20, variable: true, help: "0 for square corners." },
    { key: "screw", label: "Screws", kind: "choice", default: "M4", choices: Object.entries(PULL_SCREWS).map(([value, s]) => ({ value, label: s.label })) },
  ],
  problems: (v) => {
    const [S, H, g, W, F, r] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    const hole = screwOf(v).hole;
    if (S <= F + 10) out.push(`The screws must be more than ${mm(F + 10)} apart, so there's room for your fingers between the feet.`);
    if (H < g + 8) out.push(`The handle must stand out at least ${mm(g + 8)}, to leave room for your fingers behind the bar.`);
    if (F < hole + 3 || W < hole + 3) out.push(`The feet must be at least ${mm(hole + 3)} long and wide round the screw hole.`);
    if (r * 2 >= Math.min(F, g, H - g) - 0.5) out.push(`The corners can be rounded by at most ${mm(Math.max(0, (Math.min(F, g, H - g) - 0.5) / 2))}.`);
    return out;
  },
  summary: (v) => `Screws ${mm(num(v, "span"))} apart; ${mm(num(v, "span") + num(v, "foot"))} long overall. Screw holes ${mm(screwOf(v).hole)} across, ${mm(num(v, "height") - HOLE_TOP)} deep.`,
  make: (ctx) => {
    const { span, height, width, round } = ctx.vars;
    const hole = screwOf(ctx.values).hole;
    const sk = ctx.id("sketch");
    const id = ctx.id("pull");
    const holes = ctx.id("holes-sketch");
    const half = over(span, 2);
    const mid = over(width, 2);
    return {
      features: [
        sketchFeature(sk, "Handle sketch", { kind: "default", name: "Top" }, roundCorners(outlineSketch(pullOutline(ctx.vars), ctx.scope), round, ctx.scope)),
        extrudeFeature(id, "Handle", sk, { depth: width, operation: "new" }),
        // The screw holes, in the feet's faces against the door (the Front plane, y = 0), drilled out into the feet.
        sketchFeature(
          holes,
          "Screw holes sketch",
          { kind: "default", name: "Front" },
          shapesSketch(
            [neg(half), half].map((x) => ({ type: "circle", center: [x.t, mid.t], diameter: String(hole) })),
            ctx.scope,
          ),
        ),
        extrudeFeature(ctx.id("holes"), "Screw holes", holes, { depth: minus(height, lit(HOLE_TOP)), operation: "remove", flip: true }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const pts = pullOutline(varsOf(v, VARS)).map(([x, y]): [number, number] => [x.v, y.v]);
    const S = num(v, "span");
    const H = num(v, "height");
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "poly", closed: true, faint: true, points: [[-S / 2 - 0.3, 0], [-S / 2 + 0.3, 0], [-S / 2 + 0.3, H - HOLE_TOP], [-S / 2 - 0.3, H - HOLE_TOP]] },
      { kind: "poly", closed: true, faint: true, points: [[S / 2 - 0.3, 0], [S / 2 + 0.3, 0], [S / 2 + 0.3, H - HOLE_TOP], [S / 2 - 0.3, H - HOLE_TOP]] },
      { kind: "text", at: [0, -H * 0.25], text: `seen from above · screws ${mm(S)} apart` },
    ];
  },
};

/** For tests: the handle's volume (mm³): its outline (less the rounding: 6 outside corners, 2 inside), less the two holes. */
export function pullVolume(v: DesignValues): number {
  const pts = pullOutline(varsOf(v, VARS)).map(([x, y]): [number, number] => [x.v, y.v]);
  const r = num(v, "round");
  const area = polygonArea(pts) - 4 * (1 - Math.PI / 4) * r * r;
  const hole = screwOf(v).hole;
  return area * num(v, "width") - 2 * Math.PI * (hole / 2) ** 2 * (num(v, "height") - HOLE_TOP);
}
