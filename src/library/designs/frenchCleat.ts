/**
 * A French cleat system: a strip screwed to the wall with its top cut at 45° (sloping down towards the wall), and a
 * holder whose own 45° cleat hooks over it — with a hook, a little shelf or a row of holes for screwdrivers on its
 * front. Hung up, the holder's cleat sits in the V between the strip's slope and the wall, so pulling it away from the
 * wall only wedges it on tighter; lift it and it comes off.
 *
 * Seen from the end, as hung (x out from the wall, y up), the strip is (0, 0) → (h − t, 0) → (h, t) → (0, t): its back
 * on the wall, the slope rising from the wall to its front. The holder's cleat lies the clearance c off that slope
 * (square to it), c off the wall, and its plate c in front of the strip.
 *
 * Printing: the strip lies on its back (the slope is a 45° overhang, which prints), its screw holes upright and
 * countersunk in its front. The holder prints standing on its side: its end shape is drawn on the bed and made
 * `width` tall, so its cleat, hook or shelf need no supports at all.
 */
import { lit, minus, plus, times, ZERO, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { topFacePlane } from "../printKit";
import type { Feature } from "../../model/types";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, polygonArea, sixPlaces, varsOf } from "./common";

const VARS = ["length", "height", "thickness", "width", "plate", "plateThickness", "reach", "shelf", "clearance"];
const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
const ROOT2 = sixPlaces(Math.SQRT2);

/** The holder's cleat: how far it reaches above the top of its slope. */
export const CLEAT_LIP = 8;
/** The space between the strip and the holder as they're laid out (mm). */
export const CLEAT_GAP = 10;
/** Wood screws for the strip (4 mm / No. 8): the hole and its countersink. */
export const CLEAT_SCREW = { d: 4.5, head: 9 };
/** The hook's arm and tip; the shelf's thickness and front lip; the screwdriver rack's block and the brace above it. */
export const HOOK = { arm: 6, tip: 10 };
export const SHELF = { thick: 4, lip: 6 };
export const RACK = { thick: 12, brace: 8 };

const holderOf = (v: DesignValues) => (v.holder === "shelf" || v.holder === "holes" ? v.holder : "hook");
const partsOf = (v: DesignValues) => (v.parts === "holder" || v.parts === "cleat" ? v.parts : "both");
const countOf = (v: DesignValues, k: string) => Math.max(1, Math.round(num(v, k)));

/**
 * The holder's end shape as it's laid out on the bed (x out from the wall, y up as hung, less `CLEAT_GAP` and the
 * cleat's top — so its top is at y = −CLEAT_GAP): its cleat with the 45° underside, the plate, and the hook, shelf or
 * rack on the front.
 */
export function holderOutline(vars: Record<string, Ex>, kind: "hook" | "shelf" | "holes"): Pt[] {
  const { thickness: t, plate: P, plateThickness: T, reach, shelf: S, clearance: c } = vars;
  const top = lit(-CLEAT_GAP);
  const at = (dy: Ex) => minus(top, dy);
  const back = c;
  const front = plus(t, c);
  const F = plus(t, c, T);
  const y0 = at(P);
  const pts: Pt[] = [
    [back, at(plus(t, lit(CLEAT_LIP)))],
    [front, at(lit(CLEAT_LIP))],
    [front, y0],
    [F, y0],
  ];
  if (kind === "hook") {
    const tipX = plus(F, reach);
    const inX = minus(tipX, lit(HOOK.arm));
    pts.push([tipX, y0], [tipX, plus(y0, lit(HOOK.arm + HOOK.tip))], [inX, plus(y0, lit(HOOK.arm + HOOK.tip))], [inX, plus(y0, lit(HOOK.arm))], [F, plus(y0, lit(HOOK.arm))]);
  } else if (kind === "shelf") {
    const out = plus(F, S);
    const top2 = plus(y0, S, lit(SHELF.thick));
    pts.push([out, plus(y0, S)], [out, plus(top2, lit(SHELF.lip))], [minus(out, lit(SHELF.thick)), plus(top2, lit(SHELF.lip))], [minus(out, lit(SHELF.thick)), top2], [F, top2]);
  } else {
    const out = plus(F, S);
    const top2 = plus(y0, lit(RACK.thick));
    pts.push([out, y0], [out, top2], [plus(F, lit(RACK.brace)), top2], [F, plus(top2, lit(RACK.brace))]);
  }
  pts.push([F, top], [back, top]);
  return pts;
}

/** Where the rack's holes are: their middles out from the wall, and along the holder's width (mm). */
export function rackHoles(v: DesignValues): { x: number; along: number[]; d: number } {
  const [t, c, T, S, W] = ["thickness", "clearance", "plateThickness", "shelf", "width"].map((k) => num(v, k));
  const n = countOf(v, "holeCount");
  return { x: t + c + T + RACK.brace + (S - RACK.brace) / 2, along: Array.from({ length: n }, (_, i) => (W * (i + 0.5)) / n), d: num(v, "hole") };
}

/** The strip's end shape (on the Right plane: across = up the wall, up = out from the wall). */
export function stripOutline(vars: Record<string, Ex>): Pt[] {
  const { height: h, thickness: t } = vars;
  return [
    [ZERO, ZERO],
    [minus(h, t), ZERO],
    [h, t],
    [ZERO, t],
  ];
}

/** How high the holder's cleat top is above the strip's bottom when it hangs (so how far the laid-out holder is moved up to hang). */
export const hangLift = (v: DesignValues) => num(v, "height") + num(v, "clearance") * (1 + ROOT2) + CLEAT_LIP + CLEAT_GAP;

function makeCleat(ctx: MakeContext) {
  const v = ctx.values;
  const { length: L, height: h, thickness: t, width: W, plate: P } = ctx.vars;
  const parts = partsOf(v);
  const features: Feature[] = [];
  const partNames: Record<string, string> = {};
  if (parts !== "holder") {
    const strip = ctx.id("strip");
    const n = countOf(v, "screws");
    const holes = Array.from({ length: n }, (_, i) => ({ type: "circle", center: [times(L, (i + 0.5) / n).t, times(minus(h, t), 0.5).t], diameter: String(CLEAT_SCREW.d) }));
    features.push(
      sketchFeature(ctx.id("strip-sketch"), "Wall strip sketch", RIGHT, outlineSketch(stripOutline(ctx.vars), ctx.scope)),
      extrudeFeature(strip, "Wall strip", ctx.id("strip-sketch"), { depth: L, operation: "new" }),
      sketchFeature(ctx.id("screws-sketch"), "Screw holes sketch", topFacePlane("Strip front", strip, t, [L.v / 2, h.v / 2], [0.5, 0.5, 1]), shapesSketch(holes, ctx.scope)),
      countersunkHoleFeature(ctx.id("screws"), "Screw holes", ctx.id("screws-sketch"), lit(CLEAT_SCREW.d), lit(CLEAT_SCREW.head)),
    );
    partNames[strip] = `${ctx.name}: wall strip`;
  }
  if (parts !== "cleat") {
    const holder = ctx.id("holder");
    const kind = holderOf(v);
    const names = { hook: "hook", shelf: "shelf", holes: "screwdriver rack" };
    features.push(
      sketchFeature(ctx.id("holder-sketch"), "Holder sketch", TOP, outlineSketch(holderOutline(ctx.vars, kind), ctx.scope)),
      extrudeFeature(holder, "Holder", ctx.id("holder-sketch"), { depth: W, operation: "new" }),
    );
    if (kind === "holes") {
      const r = rackHoles(v);
      const n = r.along.length;
      const shapes = r.along.map((_, i) => ({ type: "circle", center: [plus(ctx.vars.thickness, ctx.vars.clearance, ctx.vars.plateThickness, lit(RACK.brace), times(minus(ctx.vars.shelf, lit(RACK.brace)), 0.5)).t, times(W, (i + 0.5) / n).t], diameter: String(r.d) }));
      // Upright holes through the rack (along y as it's laid out): cut both ways from the Front plane, far enough to pass through.
      features.push(
        sketchFeature(ctx.id("rack-sketch"), "Rack holes sketch", FRONT, shapesSketch(shapes, ctx.scope)),
        extrudeFeature(ctx.id("rack"), "Rack holes", ctx.id("rack-sketch"), { depth: times(plus(P, lit(CLEAT_GAP + 20)), 2), operation: "remove", end: "symmetric" }),
      );
    }
    partNames[holder] = `${ctx.name}: ${names[kind]}`;
  }
  return { features, partNames };
}

export const frenchCleat: LibraryDesign = {
  id: "french-cleat",
  name: "French cleat and tool holder",
  description:
    "A French cleat system for a workshop wall: a strip you screw to the wall, cut at 45° along its top, and a holder with the matching 45° cleat that hooks over it — with a hook, a small shelf or a row of holes for screwdrivers. Hang holders anywhere along the strip and move them around whenever you like. The strip prints lying on its back; the holder prints standing on its side, so neither needs supports.",
  category: "print",
  group: "Workshop",
  prefix: "cleat",
  icon: '<path d="M6 30h14l8-8H6z"/><path d="M30 8v34h6V28l-4-4h-2" opacity=".55"/><path d="M22 20l8-8v16" opacity=".55"/><path d="M36 36h6v-6" opacity=".9"/>',
  inputs: [
    {
      key: "parts",
      label: "Make",
      kind: "choice",
      default: "both",
      choices: [
        { value: "both", label: "A wall strip and a holder" },
        { value: "holder", label: "Just a holder" },
        { value: "cleat", label: "Just a wall strip" },
      ],
    },
    {
      key: "holder",
      label: "Holder",
      kind: "choice",
      default: "hook",
      choices: [
        { value: "hook", label: "Hook" },
        { value: "shelf", label: "Shelf" },
        { value: "holes", label: "Row of holes (screwdrivers)" },
      ],
    },
    { key: "length", label: "Strip length", kind: "length", default: 200, min: 40, max: 1000, variable: true },
    { key: "height", label: "Strip height", kind: "length", default: 40, min: 20, max: 200, variable: true, help: "How far it reaches up the wall." },
    { key: "thickness", label: "Strip thickness", kind: "length", default: 12, min: 6, max: 50, variable: true, help: "How far it stands off the wall — and the depth of the 45° slope." },
    { key: "screws", label: "Screw holes", kind: "count", default: 3, min: 1, max: 20, help: "Countersunk, for 4 mm (No. 8) wood screws." },
    { key: "width", label: "Holder width", kind: "length", default: 40, min: 10, max: 300, variable: true, help: "Along the strip." },
    { key: "plate", label: "Holder height", kind: "length", default: 70, min: 25, max: 300, variable: true, help: "Its back plate, from the top of its cleat down." },
    { key: "plateThickness", label: "Holder plate thickness", kind: "length", default: 5, min: 2, max: 30, variable: true },
    { key: "reach", label: "Hook reach", kind: "length", default: 40, min: 15, max: 200, variable: true, help: "How far the hook comes out from the plate." },
    { key: "shelf", label: "Shelf or rack depth", kind: "length", default: 50, min: 15, max: 200, variable: true, help: "How far the shelf (or the row of holes) comes out." },
    { key: "hole", label: "Hole size", kind: "length", default: 8, min: 3, max: 40, help: "For the row of holes: a little wider than your screwdrivers' shafts." },
    { key: "holeCount", label: "Holes", kind: "count", default: 3, min: 1, max: 30 },
    { key: "clearance", label: "Fit clearance", kind: "length", default: 0.3, min: 0.1, max: 2, variable: true, help: "The gap between the two cleats' 45° faces (and everywhere else they meet)." },
  ],
  problems: (v) => {
    const [, h, t, W, P, , , S] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    const parts = partsOf(v);
    if (parts !== "holder") {
      if (h < t + 2 * (CLEAT_SCREW.head / 2 + 1)) out.push(`The strip must be at least ${mm(t + CLEAT_SCREW.head + 2)} high, so its screw holes sit below the slope.`);
      if (t < (CLEAT_SCREW.head - CLEAT_SCREW.d) / 2 + 2) out.push(`The strip must be at least ${mm((CLEAT_SCREW.head - CLEAT_SCREW.d) / 2 + 2)} thick for countersunk screws.`);
      if (num(v, "length") / countOf(v, "screws") < 20) out.push(`That's too many screws for the strip's length: at most ${Math.floor(num(v, "length") / 20)}.`);
    }
    if (parts !== "cleat") {
      if (P < CLEAT_LIP + 12) out.push(`The holder must be at least ${mm(CLEAT_LIP + 12)} high, so its plate reaches below its cleat.`);
      const kind = holderOf(v);
      if (kind === "shelf" && S + SHELF.thick > P) out.push(`A shelf ${mm(S)} deep needs a holder at least ${mm(S + SHELF.thick)} high (it's braced at 45° underneath).`);
      if (kind === "holes") {
        const r = rackHoles(v);
        if (S - RACK.brace < r.d + 3) out.push(`Holes ${mm(r.d)} across need a rack at least ${mm(r.d + 3 + RACK.brace)} deep.`);
        if (W / r.along.length < r.d + 3) out.push(`${r.along.length} holes ${mm(r.d)} across don't fit in a holder ${mm(W)} wide: have at most ${Math.max(1, Math.floor(W / (r.d + 3)))}.`);
        if (P < RACK.thick + RACK.brace + CLEAT_LIP + 4) out.push(`The holder must be at least ${mm(RACK.thick + RACK.brace + CLEAT_LIP + 4)} high for the rack.`);
      }
    }
    return out;
  },
  summary: (v) => {
    const parts = partsOf(v);
    const kind = { hook: "a hook", shelf: "a shelf", holes: `a row of ${countOf(v, "holeCount")} holes` }[holderOf(v)];
    const strip = `a ${mm(num(v, "length"))} wall strip with ${countOf(v, "screws")} screw holes`;
    const holder = `a holder ${mm(num(v, "width"))} wide with ${kind}`;
    return `${parts === "both" ? `2 parts: ${strip} and ${holder}` : parts === "cleat" ? `1 part: ${strip}` : `1 part: ${holder}`}. The 45° faces meet with a ${mm(num(v, "clearance"))} gap.`;
  },
  make: makeCleat,
  preview: (v) => {
    // Seen from the end, hung up: the strip on the wall (x = 0) and the holder over it.
    const vars = varsOf(v, VARS);
    const lift = hangLift(v);
    const out: PreviewShape[] = [];
    if (partsOf(v) !== "holder") out.push({ kind: "poly", closed: true, points: stripOutline(vars).map(([a, b]) => [b.v, a.v]) });
    if (partsOf(v) !== "cleat") out.push({ kind: "poly", closed: true, points: holderOutline(vars, holderOf(v)).map(([x, y]) => [x.v, y.v + lift]) });
    out.push({ kind: "poly", faint: true, points: [[0, -num(v, "plate")], [0, num(v, "height") + 20]] });
    out.push({ kind: "text", at: [num(v, "thickness") / 2 + 20, -num(v, "plate") / 2], text: "seen from the end, hung up" });
    return out;
  },
};

/** For tests: the strip's and holder's volumes (mm³). */
export function cleatVolumes(v: DesignValues): { strip: number; holder: number } {
  const vars = varsOf(v, VARS);
  const [L, h, t, W] = VARS.map((k) => num(v, k));
  const parts = partsOf(v);
  const strip = parts === "holder" ? 0 : (h * t - (t * t) / 2) * L - countOf(v, "screws") * countersunkHoleVolume(CLEAT_SCREW.d, CLEAT_SCREW.head, t);
  let holder = 0;
  if (parts !== "cleat") {
    holder = polygonArea(holderOutline(vars, holderOf(v)).map(([x, y]) => [x.v, y.v])) * W;
    if (holderOf(v) === "holes") {
      const r = rackHoles(v);
      holder -= r.along.length * Math.PI * (r.d / 2) ** 2 * RACK.thick;
    }
  }
  return { strip, holder };
}
