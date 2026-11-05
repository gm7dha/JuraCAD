/**
 * A box with a lid joined by a print-in-place hinge along the back. Box and lid print side by side, both open side up,
 * with the hinge between them; swing the lid over and it lands on the box, rim to rim. It uses the print-in-place
 * hinge's knuckles (`hingeSizes`: knuckles taking turns along the pin, a clearance at every end), here standing up at
 * the backs of the box and lid.
 *
 * Seen from the end (y across, z up), the hinge's pin runs along x at y = 0, height a = (box + lid height) / 2: turned
 * 180° about that line the lid's rim (z = lid height) goes to z = box height, exactly onto the box's rim. The box's
 * back wall is at y = −g and the lid's at +g (g = knuckle radius + clearance + a little room). Each side's knuckles sit
 * on a block that stays *below* the pin (as the flat hinge's leaves do), so when the lid turns over its blocks end up
 * above the pin and never meet the box's; each block's underside slopes at 45° and runs tangent into its knuckle, so
 * nothing overhangs more than 45°. The box's knuckles are solid and the pin is part of the box; the lid's knuckles
 * turn on it, the clearance all round.
 */
import { lit, plus, times, ZERO, type Ex } from "../ex";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, polygonArea, roundedRect, sixPlaces } from "./common";
import { hingeSizes } from "./hinge";

const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
/** Room between a knuckle (and its clearance) and the other side's back wall (mm). */
export const HINGE_ROOM = 0.6;
const R2 = sixPlaces(Math.SQRT2);
const RH = sixPlaces(Math.SQRT1_2);

type P2 = [number, number];

/** Every number the hinged box is made from. */
export function hingedPlan(v: DesignValues) {
  const [W, D, Hb, Hl, w, kd, pin, c] = ["width", "depth", "height", "lid", "wall", "knuckle", "pin", "clearance"].map((k) => num(v, k));
  const n = Math.round(num(v, "knuckles"));
  const R = kd / 2;
  const g = sixPlaces(R + c + HINGE_ROOM);
  const a = sixPlaces((Hb + Hl) / 2);
  const low = sixPlaces(a - R2 * R - g - w / 2);
  // Seen from the end (Right plane: across = y, up = z).
  const boxBlock: P2[] = [
    [-g - w / 2, low],
    [RH * R, sixPlaces(a - RH * R)],
    [0, a],
    [-g - w / 2, a],
  ];
  const lidBlock: P2[] =
    a - Hl > 1e-9
      ? [[g + w / 2, low], [-RH * R, sixPlaces(a - RH * R)], [0, a], [g, a], [g, Hl], [g + w / 2, Hl]]
      : [[g + w / 2, low], [-RH * R, sixPlaces(a - RH * R)], [0, a], [g + w / 2, a]];
  return { W, D, Hb, Hl, w, R, pin, c, n, g, a, low, boxBlock, lidBlock };
}

const pt = ([x, y]: P2): [Ex, Ex] => [lit(sixPlaces(x)), lit(sixPlaces(y))];

function makeHingedBox(ctx: MakeContext) {
  const p = hingedPlan(ctx.values);
  const { width: W, depth: D } = ctx.vars;
  const s = hingeSizes({ length: W, clearance: lit(p.c), thickness: lit(p.R) }, p.n);
  const box = ctx.id("box");
  const lidId = ctx.id("lid");
  const rect = (x0: Ex, y0: Ex, w: Ex, h: Ex) => ({ type: "rectangle", corner: [x0.t, y0.t], width: w.t, height: h.t });
  const inner = (y0: Ex) => rect(lit(p.w), plus(y0, lit(p.w)), plus(W, lit(-2 * p.w)), plus(D, lit(-2 * p.w)));
  const boxY = times(plus(D, lit(p.g)), -1);
  const lidY = lit(p.g);
  const circle = (d: number) => [{ type: "circle", center: ["0", String(p.a)], diameter: String(d) }];
  const slots = (odd: boolean) =>
    Array.from({ length: p.n }, (_, i) => i)
      .filter((i) => i % 2 === (odd ? 1 : 0))
      .map((i) => ({ type: "rectangle", center: [s.slotMiddle(i).t, "0"], width: s.slotLength.t, height: String(2 * (p.R + p.c)) }));
  const cut = lit(sixPlaces(p.a + p.R + 1));
  const sk = (role: string, name: string, plane: typeof TOP | typeof RIGHT, data: Parameters<typeof sketchFeature>[3]) => sketchFeature(ctx.id(role), name, plane, data);
  const features: Feature[] = [
    sk("box-sketch", "Box sketch", TOP, shapesSketch([rect(ZERO, boxY, W, D)], ctx.scope)),
    extrudeFeature(box, "Box floor", ctx.id("box-sketch"), { depth: lit(p.w), operation: "new" }),
    sk("walls-sketch", "Box walls sketch", TOP, shapesSketch([rect(ZERO, boxY, W, D), inner(boxY)], ctx.scope)),
    extrudeFeature(ctx.id("walls"), "Box walls", ctx.id("walls-sketch"), { depth: lit(p.Hb), operation: "add" }),
    sk("box-block-sketch", "Box hinge block sketch", RIGHT, outlineSketch(p.boxBlock.map(pt), ctx.scope)),
    extrudeFeature(ctx.id("box-block"), "Box hinge block", ctx.id("box-block-sketch"), { depth: W, operation: "add" }),
    sk("box-knuckle-sketch", "Box knuckles sketch", RIGHT, shapesSketch(circle(2 * p.R), ctx.scope)),
    extrudeFeature(ctx.id("box-knuckle"), "Box knuckles", ctx.id("box-knuckle-sketch"), { depth: W, operation: "add" }),
    // Room for the lid's knuckles (and the clearance at each end and all round).
    sk("box-gaps-sketch", "Box hinge gaps sketch", TOP, shapesSketch(slots(true), ctx.scope)),
    extrudeFeature(ctx.id("box-gaps"), "Box hinge gaps", ctx.id("box-gaps-sketch"), { depth: cut, operation: "remove" }),
    sk("pin-sketch", "Hinge pin sketch", RIGHT, shapesSketch(circle(p.pin), ctx.scope)),
    extrudeFeature(ctx.id("pin"), "Hinge pin", ctx.id("pin-sketch"), { depth: W, operation: "add" }),
    sk("lid-sketch", "Lid sketch", TOP, shapesSketch([rect(ZERO, lidY, W, D)], ctx.scope)),
    extrudeFeature(lidId, "Lid top", ctx.id("lid-sketch"), { depth: lit(p.w), operation: "new" }),
    sk("lid-walls-sketch", "Lid walls sketch", TOP, shapesSketch([rect(ZERO, lidY, W, D), inner(lidY)], ctx.scope)),
    extrudeFeature(ctx.id("lid-walls"), "Lid walls", ctx.id("lid-walls-sketch"), { depth: lit(p.Hl), operation: "add" }),
    sk("lid-block-sketch", "Lid hinge block sketch", RIGHT, outlineSketch(p.lidBlock.map(pt), ctx.scope)),
    extrudeFeature(ctx.id("lid-block"), "Lid hinge block", ctx.id("lid-block-sketch"), { depth: W, operation: "add" }),
    sk("lid-knuckle-sketch", "Lid knuckles sketch", RIGHT, shapesSketch(circle(2 * p.R), ctx.scope)),
    extrudeFeature(ctx.id("lid-knuckle"), "Lid knuckles", ctx.id("lid-knuckle-sketch"), { depth: W, operation: "add" }),
    sk("lid-gaps-sketch", "Lid hinge gaps sketch", TOP, shapesSketch(slots(false), ctx.scope)),
    extrudeFeature(ctx.id("lid-gaps"), "Lid hinge gaps", ctx.id("lid-gaps-sketch"), { depth: cut, operation: "remove" }),
    sk("bore-sketch", "Lid pin hole sketch", RIGHT, shapesSketch(circle(sixPlaces(p.pin + 2 * p.c)), ctx.scope)),
    extrudeFeature(ctx.id("bore"), "Lid pin hole", ctx.id("bore-sketch"), { operation: "remove", end: "throughAll" }),
  ];
  return { features, partNames: { [box]: `${ctx.name}: box`, [lidId]: `${ctx.name}: lid` } };
}

export const hingedBox: LibraryDesign = {
  id: "hinged-box",
  name: "Hinged box",
  description:
    "A box whose lid is joined on by a print-in-place hinge along the back: it prints as one go, box and lid side by side and open, and the lid swings over to close straight off the printer. The hinge's knuckles take turns along a pin with a small gap round everything that moves. Print with supports off, then work the lid gently a few times to free it.",
  category: "print",
  group: "Storage",
  prefix: "hbox",
  icon: '<rect x="4" y="22" width="18" height="16" rx="1.5"/><rect x="26" y="28" width="18" height="10" rx="1.5" opacity=".55"/><circle cx="24" cy="30" r="2.5"/><path d="M21 30h6"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 100, min: 30, max: 400, variable: true, help: "Along the hinge." },
    { key: "depth", label: "Depth", kind: "length", default: 60, min: 20, max: 400, variable: true, help: "Front to back, the box and the lid alike." },
    { key: "height", label: "Box height", kind: "length", default: 35, min: 10, max: 200 },
    { key: "lid", label: "Lid height", kind: "length", default: 16, min: 5, max: 200, help: "No taller than the box." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1.2, max: 10 },
    { key: "knuckle", label: "Knuckle diameter", kind: "length", default: 8, min: 4, max: 30 },
    { key: "pin", label: "Pin diameter", kind: "length", default: 3.5, min: 1.5, max: 20 },
    { key: "knuckles", label: "Knuckles", kind: "count", default: 5, min: 3, max: 15, help: "An odd number (3, 5, 7…): the box has one at each end." },
    { key: "clearance", label: "Hinge clearance", kind: "length", default: 0.4, min: 0.2, max: 1, help: "The gap round the moving parts. 0.3–0.5 mm works on most printers." },
  ],
  problems: (v) => {
    const p = hingedPlan(v);
    const out: string[] = [];
    if (p.n % 2 === 0) out.push("The number of knuckles must be odd (3, 5, 7…).");
    const k = (p.W - (p.n - 1) * p.c) / p.n;
    if (k < 2 * p.c + 2) out.push(`The knuckles would be only ${mm(k)} long: use fewer, or make the box wider.`);
    if (p.Hl > p.Hb) out.push("The lid can't be taller than the box: swap them over.");
    if (p.Hl < p.w + 3) out.push(`The lid must be at least ${mm(p.w + 3)} high.`);
    if (p.R - p.pin / 2 - p.c < 0.8) out.push(`The knuckles' walls round the pin would be too thin: make the pin smaller than ${mm(2 * (p.R - p.c - 0.8))}, or the knuckles bigger.`);
    if (p.low < 0) out.push(`The box is too shallow for knuckles ${mm(2 * p.R)} across: make the box and lid together at least ${mm(2 * (R2 * p.R + p.g + p.w / 2))} high, or the knuckles smaller.`);
    else if (p.low > p.Hl - 1) out.push(`The lid is too shallow for a box this deep: make it at least ${mm(p.Hb - 2 * (R2 * p.R + p.g + p.w / 2 - 1))} high, or the knuckles bigger.`);
    if (p.D < 2 * p.w + 5 || p.W < 2 * p.w + 5) out.push("The box is too small for its walls.");
    return out;
  },
  summary: (v) => {
    const p = hingedPlan(v);
    return `2 parts joined by the hinge: the box has ${(p.n + 1) / 2} knuckles and the pin, the lid ${(p.n - 1) / 2}. Closed, it's ${mm(p.W)} × ${mm(p.D)} × ${mm(p.Hb + p.Hl)}.`;
  },
  make: makeHingedBox,
  preview: (v) => {
    const p = hingedPlan(v);
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: roundedRect(p.W, p.D, 0, p.W / 2, -p.g - p.D / 2) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(p.W - 2 * p.w, p.D - 2 * p.w, 0, p.W / 2, -p.g - p.D / 2) },
      { kind: "poly", closed: true, points: roundedRect(p.W, p.D, 0, p.W / 2, p.g + p.D / 2) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(p.W - 2 * p.w, p.D - 2 * p.w, 0, p.W / 2, p.g + p.D / 2) },
    ];
    const s = hingeSizes({ length: lit(p.W), clearance: lit(p.c), thickness: lit(p.R) }, p.n);
    for (let i = 0; i < p.n; i++) out.push({ kind: "poly", closed: true, faint: i % 2 === 1, points: roundedRect(s.k.v, 2 * p.R, 0, s.start(i).v + s.k.v / 2, 0) });
    out.push({ kind: "text", at: [p.W / 2, -p.g - p.D - 8], text: "box" }, { kind: "text", at: [p.W / 2, p.g + p.D + 8], text: "lid (swings over)" });
    return out;
  },
};

/** The part of a polygon on one side of a line y = at (`keep` "below" = y ≤ at), by Sutherland–Hodgman. */
export function clipAcross(poly: P2[], at: number, keep: "below" | "above"): P2[] {
  const inside = (p: P2) => (keep === "below" ? p[0] <= at : p[0] >= at);
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (at - a[0]) / (b[0] - a[0]);
      out.push([at, a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/** For tests: the box's and the lid's volumes (mm³). The polygons are seen from the end: [y, z]. */
export function hingedVolumes(v: DesignValues): { box: number; lid: number } {
  const p = hingedPlan(v);
  const k = (p.W - (p.n - 1) * p.c) / p.n;
  const nl = (p.n - 1) / 2;
  const nb = (p.n + 1) / 2;
  const area = (poly: P2[]) => (poly.length >= 3 ? polygonArea(poly) : 0);
  // A knuckle's circle shares a 135° sector with its block (the quarter beside the block and the 45° beyond, to the tangent).
  const circleOut = Math.PI * p.R * p.R * (1 - 3 / 8);
  const shell = (h: number) => p.W * p.D * h - (p.W - 2 * p.w) * (p.D - 2 * p.w) * (h - p.w);
  const strip = p.R + p.c;
  const boxUnion = area(p.boxBlock) + circleOut;
  const boxStrip = area(clipAcross(p.boxBlock, -strip, "above")) + circleOut;
  const boxGaps = nl * (k + 2 * p.c);
  const box = shell(p.Hb) + (boxUnion - area(clipAcross(p.boxBlock, -p.g, "below"))) * p.W - boxStrip * boxGaps + Math.PI * (p.pin / 2) ** 2 * boxGaps;
  const lidUnion = area(p.lidBlock) + circleOut;
  const lidStrip = area(clipAcross(p.lidBlock, strip, "below")) + circleOut;
  const lidGaps = nb * (k + 2 * p.c) - 2 * p.c;
  const lid = shell(p.Hl) + (lidUnion - area(clipAcross(p.lidBlock, p.g, "above"))) * p.W - lidStrip * lidGaps - Math.PI * (p.pin / 2 + p.c) ** 2 * k * nl;
  return { box, lid };
}
