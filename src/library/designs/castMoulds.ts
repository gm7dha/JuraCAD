/**
 * Concrete and Jesmonite casting moulds made of an outer shell and an inner piece: a plant pot (shell + core), a candle
 * or tealight holder (shell + a pocket-making insert) and a trinket / ring dish (shell + core).
 *
 * Assembled, the shell stands on the bed: a wall `wall` thick round the cast (`wallAround`, never leaning out more than
 * 45°) on a floor `wall` thick, so the cast's bottom is at z = wall and its top (the open end) at z = rim. The inner piece
 * hangs from a flange that rests on the shell's rim and is centred by a lip round the outside of the shell (`fit` clear of
 * it), so the concrete wall comes out even. Pour holes in the flange over the concrete let air and spare concrete out —
 * pour most of the mix into the shell, press the inner piece down until the flange sits on the rim, and top up through
 * the holes. The cast's outside comes from mouldSurface.ts; these are one-piece rigid moulds, so only shapes and
 * patterns that slide straight out are allowed (`outsideProblems` with "rigid").
 *
 * To print, the shell stands as it is (floor on the bed, open end up: the cavity only widens going up) and the inner
 * piece is turned over (flange on the bed) and put beside it: its sides then lean in going up, the pot's core is hollow
 * (to fill with sand so it doesn't float) with a 45° pointed roof inside, and the drain pin, lip and plug point up.
 */
import type { Feature } from "../../model/types";
import { lit } from "../ex";
import { levelPlane } from "../printKit";
import { extrudeFeature, moveFeature, sketchFeature } from "../sketchKit";
import type { DesignInput, DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num } from "./common";
import { circleAt, CONCRETE_ADVICE, concreteLine, loopSketch, loopsSketch, MASTER_ADVICE, stackFeatures } from "./mouldKit";
import {
  apothemAt,
  baseSides,
  castSections,
  domeBall,
  extentX,
  extended,
  faceDirections,
  fluteDepth,
  integrate,
  outsideInputs,
  outsideOf,
  outsidePreview,
  outsideProblems,
  plainSection,
  profileLevels,
  raised,
  sectionArea,
  sectionAt,
  sideOnX,
  sideSlope,
  stackVolume,
  wallAround,
  type CastSize,
  type Outside,
  type OutsideShape,
  type Section,
} from "./mouldSurface";

/** The flange's thickness and the lip's length below it. */
export const FLANGE_T = 3;
export const LIP = 6;
/** At most this many pour holes. */
export const MOST_HOLES = 8;
/** How far apart the shell and the inner piece print. */
export const PRINT_GAP = 10;

const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** The half-width (apothem) of a plain section (a circle's radius; a polygon's distance to its sides). */
export function apothemOf(s: Section, n: number): number {
  return s.r !== undefined ? s.r : Math.hypot(...s.pts![0]) * Math.cos(Math.PI / n);
}

/** The inside of a concrete wall `w` thick (across, square to the sides) round the cast, at height z of the cast: its plain half-width. */
export function insideAt(o: Outside, b: CastSize, w: number, z: number): number {
  if (o.shape === "dome") {
    const { R, centre } = domeBall(b);
    return Math.sqrt(Math.max(0, (R - w) ** 2 - (centre - z) ** 2));
  }
  const base = apothemAt(o, b, z) - (o.shape === "fluted" ? fluteDepth(b.W) : 0);
  const slope = o.shape === "tapered" ? (apothemAt(o, b, b.H) - apothemAt(o, b, 0)) / b.H : sideSlope(b);
  return base - w * Math.sqrt(1 + slope * slope);
}

export type InnerKind = { kind: "core"; wall: number; floor: number; hollow: boolean; pin: number; centre: boolean } | { kind: "plug"; top: number; depth: number };

/** Everything about a shell-and-inner-piece mould (mm; z up from the bed, assembled). */
export function cupPlan(o: Outside, size: CastSize, wall: number, fit: number, inner: InnerKind) {
  const n = baseSides(o);
  // A side facing +x, so square shapes sit square to the bed and the parts lie side by side.
  const b: CastSize = { ...size, turn: sideOnX(o) };
  const turn = b.turn!;
  const cast = castSections(o, b).sections;
  const cavity = raised(cast, wall);
  const outer = wallAround(cavity, o, b, wall, wall);
  const rim = wall + b.H;
  const outerRim = apothemOf(outer[outer.length - 1], n);
  const flange = plainSection(o, outerRim + fit + wall, rim, turn);
  const lipInside = plainSection(o, outerRim + fit, rim, turn);
  const castRim = apothemAt(o, b, b.H) - (o.shape === "fluted" ? fluteDepth(b.W) : 0);
  let core: Section[] = [];
  let hollow: Section[] = [];
  let pin: { r0: number; r1: number; z0: number; z1: number } | null = null;
  let recess: Section[] = [];
  let plug: Section[] = [];
  let innerRim: number;
  let bottom: number;
  if (inner.kind === "core") {
    const zf = inner.floor;
    const levels = [zf, ...profileLevels(o, b).filter((z) => z > zf + 1e-6 && z < b.H - 1e-6), b.H];
    core = levels.map((z) => plainSection(o, insideAt(o, b, inner.wall, z), wall + z, turn));
    innerRim = insideAt(o, b, inner.wall, b.H);
    bottom = wall + zf;
    if (inner.hollow) {
      // A pointed roof inside (45° at its corners) from `wall` above the core's bottom, then `wall` in from its sides.
      const c = n ? Math.cos(Math.PI / n) : 1;
      const tip = bottom + wall;
      let zr = tip;
      for (let i = 0; i < 30; i++) zr = tip + (insideAt(o, b, inner.wall, zr - wall) - wall - 1) / c;
      if (zr < rim - 2) {
        const up = levels.map((z) => wall + z).filter((z) => z > zr + 1e-6);
        hollow = extended(
          [plainSection(o, 1, tip, turn), plainSection(o, insideAt(o, b, inner.wall, zr - wall) - wall, zr, turn), ...up.map((z) => plainSection(o, insideAt(o, b, inner.wall, z - wall) - wall, z, turn))],
          FLANGE_T + 1,
        );
      }
    }
    if (inner.pin > 0) {
      const k = sideSlope({ ...b, lean: 0 });
      pin = { r1: inner.pin / 2, r0: inner.pin / 2 - zf * k, z0: wall, z1: bottom };
    }
    if (inner.centre) {
      const r0 = Math.max(6, 0.3 * insideAt(o, b, inner.wall, zf));
      const h = 0.7 * (b.H - zf);
      const r1 = 3;
      recess = [circleAt(r0 + (r0 - r1) / h, bottom - 1), circleAt(r0, bottom), circleAt(r1, bottom + h)].map((s) => ({ z: six(s.z), r: six(s.r!) }));
    }
  } else {
    const k = sideSlope({ ...b, lean: 0 });
    const r0 = inner.top / 2 - inner.depth * k;
    plug = extended([circleAt(r0, rim - inner.depth), circleAt(inner.top / 2, rim)].map((s) => ({ z: six(s.z), r: six(s.r!) })), FLANGE_T / 2);
    innerRim = inner.top / 2;
    bottom = rim - inner.depth;
  }
  // Pour holes over the concrete between the inner piece and the shell's wall, square to the faces.
  const gap = castRim - innerRim;
  const holeD = Math.min(10, gap - 3);
  const ring = (castRim + innerRim) / 2;
  const dirs = faceDirections(o, turn);
  const every = Math.ceil(dirs.length / MOST_HOLES);
  const holes = holeD >= 3 ? dirs.filter((_, i) => i % every === 0).map((d) => [six(ring * Math.cos(d)), six(ring * Math.sin(d))] as [number, number]) : [];
  const lowest = Math.min(rim - LIP, bottom, pin ? pin.z0 : Infinity);
  const reach = extentX([flange]);
  return { b, n, cast, cavity, outer, rim, outerRim, flange, lipInside, core, hollow, pin, recess, plug, holes, holeD, gap, lowest, top: rim + FLANGE_T, beside: extentX(outer) + reach + PRINT_GAP, reach, wall };
}

export type CupPlan = ReturnType<typeof cupPlan>;

const frustum = (r0: number, r1: number, h: number) => (Math.PI * h * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;

/** For tests and the summaries: the cast's, shell's and inner piece's volumes (mm³). */
export function cupVolumes(p: CupPlan): { cast: number; shell: number; inner: number } {
  const castOutside = stackVolume(p.cavity);
  const shell = stackVolume(p.outer) - castOutside;
  const holes = p.holes.length * Math.PI * (p.holeD / 2) ** 2 * FLANGE_T;
  const hollowAt = (z: number) => (p.hollow.length ? (sectionAt(p.hollow, z) ? sectionArea(sectionAt(p.hollow, z)!) : 0) : 0);
  const hollowBreaks = p.hollow.map((s) => s.z);
  const lip = (sectionArea(p.flange) - sectionArea(p.lipInside)) * LIP;
  const flangeArea = sectionArea(p.flange);
  if (p.plug.length) {
    const [a, b] = [p.plug[0], p.plug[1]];
    const pocket = frustum(a.r!, b.r!, b.z - a.z);
    return { cast: castOutside - pocket, shell, inner: flangeArea * FLANGE_T - holes + lip + pocket };
  }
  const core0 = p.core[0].z;
  const coreBody = integrate((z) => sectionArea(sectionAt(p.core, z)!) - hollowAt(z), [...new Set([core0, ...p.core.map((s) => s.z), ...hollowBreaks.filter((z) => z > core0 && z < p.rim), p.rim])].sort((x, y) => x - y), 2);
  const flange = integrate((z) => flangeArea - hollowAt(z), [p.rim, ...hollowBreaks.filter((z) => z > p.rim && z < p.top), p.top], 2) - holes;
  const pin = p.pin ? frustum(p.pin.r0, p.pin.r1, p.pin.z1 - p.pin.z0) : 0;
  const cone = p.recess.length ? frustum(p.recess[1].r!, p.recess[2].r!, p.recess[2].z - p.recess[1].z) : 0;
  return { cast: castOutside - stackVolume(p.core) - pin + cone, shell, inner: coreBody + flange + lip + pin - cone };
}

/** The shell's features (a New loft of its outside, the cast cut out of it) and the inner piece's, turned over beside it. */
function cupFeatures(ctx: MakeContext, p: CupPlan, innerName: string): Feature[] {
  const inner = ctx.id("inner");
  const f: Feature[] = [...stackFeatures(ctx, "shell", "Shell", p.outer, "new"), ...stackFeatures(ctx, "cavity", "Cast shape", extended(p.cavity, 1), "remove")];
  const plane = (z: number) => levelPlane(`${mm(z)} up`, z);
  if (p.plug.length) {
    f.push(
      sketchFeature(ctx.id("inner-sketch"), `${innerName} plate sketch`, plane(p.rim), loopSketch(p.flange, ctx.scope)),
      extrudeFeature(inner, innerName, ctx.id("inner-sketch"), { depth: lit(FLANGE_T), operation: "new" }),
      ...stackFeatures(ctx, "plug", "Pocket plug", p.plug, "add"),
    );
  } else {
    f.push(...stackFeatures(ctx, "inner", innerName, p.core, "new"));
    f.push(sketchFeature(ctx.id("flange-sketch"), "Flange sketch", plane(p.rim), loopSketch(p.flange, ctx.scope)), extrudeFeature(ctx.id("flange"), "Flange", ctx.id("flange-sketch"), { depth: lit(FLANGE_T), operation: "add" }));
  }
  f.push(
    sketchFeature(ctx.id("lip-sketch"), "Lip sketch", plane(p.rim - LIP), loopsSketch([loopSketch(p.flange, ctx.scope), loopSketch(p.lipInside, ctx.scope)])),
    extrudeFeature(ctx.id("lip"), "Lip", ctx.id("lip-sketch"), { depth: lit(LIP), operation: "add" }),
  );
  if (p.pin) f.push(...stackFeatures(ctx, "pin", "Drain hole pin", extended([circleAt(p.pin.r0, p.pin.z0), circleAt(p.pin.r1, p.pin.z1)].map((s) => ({ z: six(s.z), r: six(s.r!) })), 1), "add"));
  if (p.hollow.length) f.push(...stackFeatures(ctx, "hollow", "Hollow for weights", p.hollow, "remove"));
  if (p.recess.length) f.push(...stackFeatures(ctx, "recess", "Raised centre", p.recess, "remove"));
  if (p.holes.length) {
    f.push(
      sketchFeature(ctx.id("pour-sketch"), "Pour holes sketch", plane(p.rim - 1), loopsSketch(p.holes.map(([x, y]) => loopSketch(circleAt(p.holeD / 2), ctx.scope, x, y)))),
      extrudeFeature(ctx.id("pour"), "Pour holes", ctx.id("pour-sketch"), { depth: lit(FLANGE_T + 2), operation: "remove" }),
    );
  }
  f.push(moveFeature(ctx.id("inner-beside"), `${innerName} turned over beside the shell`, inner, { rx: lit(180), dx: lit(six(p.beside)), dz: lit(six(-p.lowest)) }));
  return f;
}

const sizeOf = (v: DesignValues, lean = 0): CastSize => ({ W: num(v, "width"), H: num(v, "height"), draft: num(v, "draft"), lean });

const commonInputs = (wallDefault = 2): DesignInput[] => [
  { key: "draft", label: "Draft", kind: "length", default: 3, min: 1, max: 10, help: "Degrees the sides lean in towards the bottom, so the cast slides out." },
  { key: "wall", label: "Mould wall", kind: "length", default: wallDefault, min: 1.2, max: 4, help: "Stiff but still a little flexible: 1.6–2.4 mm suits most." },
  { key: "fit", label: "Lip fit", kind: "length", default: 0.3, min: 0.1, max: 1, help: "Room between the lip and the shell, so the inner piece drops on easily." },
];

function cupPreview(p: CupPlan, label: string): PreviewShape[] {
  const side = (s: Section[]) => s.map((x): [number, number] => [x.r ?? Math.hypot(...x.pts![0]), x.z]);
  const out: PreviewShape[] = [];
  const o = side(p.outer);
  out.push({ kind: "poly", closed: true, faint: true, points: [[0, 0], ...o, [0, p.rim]] });
  out.push(...outsidePreview(p.cavity, [0, 0], label));
  const inner = p.core.length ? side(p.core) : side(p.plug.slice(0, 2));
  if (inner.length) out.push({ kind: "poly", closed: true, faint: true, points: [[-inner[0][0], inner[0][1]], ...inner, [p.reach, p.rim], [p.reach, p.top], [-p.reach, p.top], [-p.reach, p.rim], ...inner.slice().reverse().map(([x, z]): [number, number] => [-x, z])] });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Plant pot

export function potPlan(v: DesignValues) {
  const o = outsideOf(v);
  const b = sizeOf(v);
  return { o, ...cupPlan(o, b, num(v, "wall"), num(v, "fit"), { kind: "core", wall: num(v, "concrete"), floor: num(v, "floor"), hollow: true, pin: v.drain === true ? num(v, "drainSize") : 0, centre: false }) };
}

export const concretePotMould: LibraryDesign = {
  id: "concrete-pot-mould",
  name: "Concrete plant pot mould",
  description:
    "A mould for casting plant pots in concrete or Jesmonite: an outer shell and an inner core that sits on the shell's rim, so the wall comes out the same thickness all round. The pot comes out the right way up: pour most of the mix into the shell, push the core down (fill it with sand or gravel so it doesn't float) until its flange rests on the rim, top up through the pour holes and tap the sides to shake out bubbles. A pin under the core leaves a drainage hole. Both pieces print without supports: the shell open end up, the core turned over beside it. Choose the outside shape and a pattern; only ones that slide straight out of a one-piece mould are allowed. " +
    `${CONCRETE_ADVICE} ${MASTER_ADVICE.replace("print a master instead", "print the pot's shape as a master (the pillar candle mould's \"Make a master instead\" makes any of these shapes)")}`,
  category: "print",
  group: "Moulds and casting",
  prefix: "potmould",
  icon: '<path d="M8 8h32l-4 32H12z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 12h18l-3 22H18z" opacity=".6"/><path d="M23 34h2v5h-2z"/>',
  inputs: [
    { key: "width", label: "Pot width", kind: "length", default: 110, min: 50, max: 250, help: "Outside, across the top." },
    { key: "height", label: "Pot height", kind: "length", default: 100, min: 40, max: 250 },
    ...outsideInputs(),
    { key: "concrete", label: "Pot wall", kind: "length", default: 10, min: 6, max: 25, help: "How thick the concrete is." },
    { key: "floor", label: "Pot floor", kind: "length", default: 12, min: 6, max: 30 },
    { key: "drain", label: "Drainage hole", kind: "toggle", default: true },
    { key: "drainSize", label: "Drainage hole size", kind: "length", default: 12, min: 6, max: 30 },
    ...commonInputs(),
  ],
  problems: (v) => {
    const p = potPlan(v);
    const out = outsideProblems(p.o, p.b, "rigid", "concrete");
    if (out.length) return out;
    const inside = insideAt(p.o, p.b, num(v, "concrete"), num(v, "floor"));
    if (num(v, "floor") > p.b.H / 2) out.push(`The floor is too thick for a pot this short: make it at most ${mm(p.b.H / 2)}.`);
    else if (inside < 15) out.push("The pot's inside would be too small at the bottom: make the wall thinner or the pot wider.");
    else if (v.drain === true && num(v, "drainSize") / 2 > inside - 5) out.push(`The drainage hole is too big for the pot's floor: make it at most ${mm(2 * (inside - 5))}.`);
    if (!out.length && !p.holes.length) out.push("The pot wall is too thin for pour holes: make it at least 6 mm.");
    if (!out.length && p.beside + p.reach > 250) out.push("The shell and core side by side are too wide for most beds: make the pot smaller.");
    return out;
  },
  summary: (v) => {
    const p = potPlan(v);
    const vol = cupVolumes(p);
    return `2 parts: the shell and the core, side by side. The pot: ${concreteLine(vol.cast)}.`;
  },
  make: (ctx) => {
    const p = potPlan(ctx.values);
    return { features: cupFeatures(ctx, p, "Core"), partNames: { [ctx.id("shell")]: `${ctx.name}: shell`, [ctx.id("inner")]: `${ctx.name}: core` } };
  },
  preview: (v) => cupPreview(potPlan(v), "cut in half, as it's cast"),
};

// ---------------------------------------------------------------------------------------------------------------
// Candle / tealight holder

export const POCKETS = {
  tealight: { top: 41, depth: 18, label: "Tealight (39 mm)" },
  taper: { top: 22.5, depth: 25, label: "Taper candle (22 mm)" },
} as const;

export function holderPlan(v: DesignValues) {
  const raw = outsideOf(v);
  const cube = v.shape === "cube";
  const o: Outside = cube ? { ...raw, shape: "square" } : raw;
  const b = sizeOf(v);
  if (cube) b.H = b.W;
  const pocket = POCKETS[v.pocket === "taper" ? "taper" : "tealight"];
  return { o, cube, pocket, ...cupPlan(o, b, num(v, "wall"), num(v, "fit"), { kind: "plug", top: pocket.top, depth: pocket.depth }) };
}

const holderShapes = () => {
  const list = outsideInputs({ shape: "square" });
  const shape = list.find((i) => i.key === "shape")!;
  shape.choices = [...shape.choices!.slice(0, 1), { value: "cube", label: "Cube" }, ...shape.choices!.slice(1)];
  return list;
};

export const concreteHolderMould: LibraryDesign = {
  id: "concrete-holder-mould",
  name: "Concrete candle / tealight holder mould",
  description:
    "A mould for a concrete or Jesmonite candle holder: an outer shell, and an insert that rests on the shell's rim with a plug hanging down that leaves a pocket for a tealight (39 mm, with room to drop it in) or a 22 mm taper candle. Round, square, cube, hexagon, rounded (ball), faceted, fluted and more, with a pattern if you like. Pour the shell nearly full, press the insert on until it sits on the rim, top up through the holes and tap out the bubbles. Both pieces print without supports: the shell open end up, the insert turned over beside it. " +
    `${CONCRETE_ADVICE} Concrete holders can get hot: don't leave a burning candle unattended.`,
  category: "print",
  group: "Moulds and casting",
  prefix: "holdermould",
  icon: '<path d="M8 14h32v26H8z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M17 14h14l-1 9H18z"/><path d="M24 6c2 2 2 4 0 6-2-2-2-4 0-6z"/>',
  inputs: [
    { key: "width", label: "Holder width", kind: "length", default: 80, min: 40, max: 200, help: "Outside, across the top." },
    { key: "height", label: "Holder height", kind: "length", default: 50, min: 25, max: 150, help: "A cube is as tall as it is wide." },
    { key: "pocket", label: "Pocket for", kind: "choice", default: "tealight", choices: Object.entries(POCKETS).map(([value, x]) => ({ value, label: x.label })) },
    ...holderShapes(),
    ...commonInputs(),
  ],
  problems: (v) => {
    const p = holderPlan(v);
    const out = outsideProblems(p.o, p.b, "rigid", "concrete");
    if (out.length) return out;
    if (p.gap < 10) out.push(`Too narrow round the pocket: make the holder at least ${mm(2 * (p.pocket.top / 2 + 10) + (p.b.W - 2 * (p.gap + p.pocket.top / 2)))} wide.`);
    if (p.b.H - p.pocket.depth < 8) out.push(`Make it at least ${mm(p.pocket.depth + 8)} tall, to leave a solid bottom under the pocket.`);
    return out;
  },
  summary: (v) => {
    const p = holderPlan(v);
    const vol = cupVolumes(p);
    return `2 parts: the shell and the insert, side by side${p.cube ? `; a ${mm(p.b.W)} cube` : ""}. The holder: ${concreteLine(vol.cast)}.`;
  },
  make: (ctx) => {
    const p = holderPlan(ctx.values);
    return { features: cupFeatures(ctx, p, "Insert"), partNames: { [ctx.id("shell")]: `${ctx.name}: shell`, [ctx.id("inner")]: `${ctx.name}: insert` } };
  },
  preview: (v) => cupPreview(holderPlan(v), "cut in half, as it's cast"),
};

// ---------------------------------------------------------------------------------------------------------------
// Trinket / ring dish

export function dishPlan(v: DesignValues) {
  const o = outsideOf(v);
  const b = sizeOf(v, num(v, "slope"));
  return { o, ...cupPlan(o, b, num(v, "wall"), num(v, "fit"), { kind: "core", wall: num(v, "concrete"), floor: num(v, "floor"), hollow: false, pin: 0, centre: v.centre === true }) };
}

const dishShapes = () => outsideInputs({ shape: "round" as OutsideShape });

export const trinketDishMould: LibraryDesign = {
  id: "trinket-dish-mould",
  name: "Trinket / ring dish mould",
  description:
    "A mould for a small concrete or Jesmonite dish for rings, keys or jewellery: a shallow shell and a core that rests on its rim, with sides that slope out into a lip and, if you like, a raised cone in the middle to hang rings on. Round, hexagon or any of the other shapes, plain or patterned. Fill the shell about two thirds, press the core down until it sits on the rim, top up through the holes and tap out the bubbles. Both pieces print without supports. " +
    CONCRETE_ADVICE,
  category: "print",
  group: "Moulds and casting",
  prefix: "dishmould",
  icon: '<path d="M4 18h40l-7 14H11z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 30l3-10 3 10z"/>',
  inputs: [
    { key: "width", label: "Dish width", kind: "length", default: 110, min: 50, max: 250, help: "Outside, across the top." },
    { key: "height", label: "Dish height", kind: "length", default: 22, min: 10, max: 60 },
    { key: "slope", label: "Lip slope", kind: "length", default: 25, min: 3, max: 50, help: "Degrees the sides lean out from upright." },
    ...dishShapes(),
    { key: "concrete", label: "Dish wall", kind: "length", default: 6, min: 4, max: 20 },
    { key: "floor", label: "Dish floor", kind: "length", default: 6, min: 4, max: 20 },
    { key: "centre", label: "Raised centre", kind: "toggle", default: false, help: "A cone in the middle for rings." },
    ...commonInputs(),
  ],
  problems: (v) => {
    const p = dishPlan(v);
    const out = outsideProblems(p.o, p.b, "rigid", "concrete");
    if (out.length) return out;
    if (num(v, "floor") > p.b.H - 5) out.push(`Make the dish at least ${mm(num(v, "floor") + 5)} tall, or its floor thinner.`);
    else if (insideAt(p.o, p.b, num(v, "concrete"), num(v, "floor")) < 12) out.push("The dish's inside would be too small: make it wider, the sides steeper or the wall thinner.");
    if (!out.length && !p.holes.length) out.push("The dish wall is too thin for pour holes: make it at least 6 mm.");
    return out;
  },
  summary: (v) => {
    const p = dishPlan(v);
    const vol = cupVolumes(p);
    return `2 parts: the shell and the core, side by side. The dish: ${concreteLine(vol.cast)}.`;
  },
  make: (ctx) => {
    const p = dishPlan(ctx.values);
    return { features: cupFeatures(ctx, p, "Core"), partNames: { [ctx.id("shell")]: `${ctx.name}: shell`, [ctx.id("inner")]: `${ctx.name}: core` } };
  },
  preview: (v) => cupPreview(dishPlan(v), "cut in half, as it's cast"),
};
