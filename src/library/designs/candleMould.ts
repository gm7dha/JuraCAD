/**
 * Candle moulds: a two-part pillar candle mould (or the candle itself as a master for a silicone mould) and a wick
 * centring bar.
 *
 * Pillar candle mould: poured upside down. The candle's top is at the mould's closed end (z = 0 … `wall` on the bed,
 * with a wick hole through it on the axis) and its base is the open end at the top, where the wax goes in. The mould is
 * split down the middle along y = 0 into two halves (y ≥ 0 and y ≤ 0); each half is a thin wall `wall` clear of the
 * candle all round (`wallAround`), with a flange along the split (`FLANGE` wide, `FLANGE_THICK` thick) that carries two
 * square-on-a-corner pegs on one side and matching holes (`fit` bigger, square to every face) on the other — the other
 * half has them the other way round, so the pegs of each go into the holes of the other — and V notches in the flanges'
 * outer edges for rubber bands. Each half prints standing on its closed end, beside the other: the cavity widens
 * upwards (the draft), the pegs and notches have 45° faces, so nothing needs supports.
 *
 * The outside can be any shape and pattern from mouldSurface.ts: the halves pull apart sideways, so patterns fade out
 * near the split and `splitCatch` checks nothing faces back towards it. "Make a master instead" makes just the candle,
 * standing on its base, for pouring silicone round.
 */
import type { Feature } from "../../model/types";
import { lit } from "../ex";
import { fixedPlane, levelPlane } from "../printKit";
import { extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { circleBand, mm, num } from "./common";
import { loopsSketch, loftThrough, MASTER_ADVICE, ml, SILICONE_DENSITY, stackFeatures, stackSketches, WAX_ADVICE, waxLine, grams } from "./mouldKit";
import { castSections, extended, polygonRadius, integrate, outsideInputs, outsideOf, outsidePreview, outsideProblems, raised, sectionAt, stackVolume, stripArea, wallAround, widest, type CastSize, type Section } from "./mouldSurface";
import { circleShape, rectShape, type P2 } from "./printShapes";

/** The flange along the split: how far it reaches past the wall's widest point, and how thick each half's is. */
export const FLANGE = 16;
export const FLANGE_THICK = 4;
/** Pegs: square on a corner, `PEG` from the middle to each corner, `PEG_LENGTH` long; their holes `HOLE_DEPTH` deep. */
export const PEG = 3;
export const PEG_LENGTH = 3;
export const HOLE_DEPTH = 3.5;
/** The rubber-band notches: V-shaped, this deep into the flange's edge (45° sides). */
export const NOTCH = 3;
/** How far apart the two halves print. */
export const HALF_GAP = 13;

const castSize = (v: DesignValues): CastSize => ({ W: num(v, "width"), H: num(v, "height"), draft: num(v, "draft") });
const master = (v: DesignValues) => v.master === true;

/** Everything about the pillar mould, worked out from the values (mm; z up from the bed). */
export function pillarPlan(v: DesignValues) {
  const b = castSize(v);
  const o = outsideOf(v);
  const wall = num(v, "wall");
  const fit = num(v, "fit");
  const cast = castSections(o, b, { split: !master(v) }).sections;
  const end = wall;
  const cavity = raised(cast, end);
  const outer = wallAround(cavity, o, b, wall, end);
  const X = widest(outer) + FLANGE;
  const top = end + b.H;
  const pegX = X - FLANGE / 2;
  const pegZ = b.H >= 60 ? [end + b.H / 3, end + (2 * b.H) / 3] : [end + b.H / 2];
  const notchZ = [0.15, 0.5, 0.85].map((k) => end + k * b.H);
  const plan = { b, o, wall, fit, cast, end, cavity, outer, X, top, pegX, pegZ, notchZ, wick: num(v, "wick"), hole: PEG + fit * Math.SQRT2 };
  // A polygon candle (not twisted): each half is made straight from its own cross-sections (see halfSections).
  return { ...plan, byHalves: !!cast[0].pts && o.shape !== "twisted" };
}

export type PillarPlan = ReturnType<typeof pillarPlan>;

/** How many points the round outside of a half gets over its half turn. */
export const HALF_ROUND = 24;

/** How deep the candle's top dips towards the wick hole when a half is made from its cross-sections (a very shallow cone). */
export const TOP_DIP = 0.5;

/**
 * One half's cross-sections, from the bed to the open end, each a single outline with no hole: the flange's edge, the
 * outside wall over the top, the other flange edge, then back along the split and round the inside — so a ruled Loft
 * through them is the half itself, with no slow cut of a detailed candle shape. In the closed end the inside is just
 * the wick hole (sampled at the same angles round as the candle's outline), which opens out to the candle's top over
 * `TOP_DIP` mm, leaving the candle a very shallow cone on top. `side` 1 = y ≥ 0, −1 = y ≤ 0. Every level has the same
 * number of points in the same order.
 */
export function halfSections(p: PillarPlan, side: 1 | -1): Section[] {
  const n = p.outer[0].pts ? p.outer[0].pts.length : 0;
  const rOf = (s: Section) => (s.r !== undefined ? s.r : Math.hypot(...s.pts![0]) * Math.cos(Math.PI / n));
  const least = Math.min(...p.outer.map(rOf));
  const lowest = Math.asin(FLANGE_THICK / least);
  // Fixed angles over the top (between where the flange meets the wall at its narrowest and the other side).
  const fixed = n
    ? Array.from({ length: n }, (_, k) => (2 * Math.PI * k) / n).filter((a) => a > lowest + 1e-6 && a < Math.PI - lowest - 1e-6)
    : Array.from({ length: HALF_ROUND - 1 }, (_, k) => (Math.PI * (k + 1)) / HALF_ROUND).filter((a) => a > lowest + 1e-6 && a < Math.PI - lowest - 1e-6);
  const loop = (z: number, inside: P2[]): Section => {
    const o = sectionAt(p.outer, Math.max(z, p.outer[0].z))!;
    const a = rOf(o);
    const at = (ang: number): P2 => {
      const r = polygonRadius(n, a, ang, 0);
      return [r * Math.cos(ang), r * Math.sin(ang)];
    };
    // Where the flange's face (y = thickness) meets the wall.
    const meet = (right: boolean) => {
      let [lo, hi] = right ? [0, Math.PI / 2] : [Math.PI / 2, Math.PI];
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if ((at(mid)[1] < FLANGE_THICK) === right) lo = mid;
        else hi = mid;
      }
      return at((lo + hi) / 2);
    };
    const pts: P2[] = [[p.X, 0], [p.X, FLANGE_THICK], meet(true), ...fixed.map(at), meet(false), [-p.X, FLANGE_THICK], [-p.X, 0], ...inside.slice().reverse()];
    const placed = pts.map(([x, y]): P2 => [Math.round(x * 1e6) / 1e6, Math.round(side * Math.max(0, y) * 1e6) / 1e6]);
    return { z: Math.round(z * 1e6) / 1e6, pts: side > 0 ? placed : placed.reverse() };
  };
  const chains = p.cavity.map((cav) => halfChain(cav.pts!, side));
  const wick = wickLike(chains[0], p.wick);
  return [loop(0, wick), loop(p.end - TOP_DIP, wick), ...p.cavity.map((cav, i) => loop(cav.z, chains[i]))];
}

/** The wick hole's outline with a point at the same angle round as each point of `like`. */
const wickLike = (like: P2[], wick: number) =>
  like.map(([x, y]): P2 => {
    const t = Math.atan2(y, x);
    return [(wick / 2) * Math.cos(t), (wick / 2) * Math.sin(t)];
  });

/** A candle outline's part on one side of the split (mirrored to y ≥ 0 for the other half), from θ = 0 round to π. */
export function halfChain(outline: P2[], side: 1 | -1): P2[] {
  const pts = side > 0 ? outline : outline.map((_, i, all): P2 => {
    const q = all[(all.length - i) % all.length];
    return [q[0], -q[1]];
  });
  const chain: P2[] = [[pts[0][0], 0]];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i];
    if (q[1] > 1e-9) {
      chain.push(q);
      continue;
    }
    if (q[1] >= -1e-9) chain.push([q[0], 0]);
    else {
      const prev = pts[i - 1];
      const t = prev[1] / (prev[1] - q[1]);
      chain.push([prev[0] + t * (q[0] - prev[0]), 0]);
    }
    break;
  }
  return chain;
}

/** The candle's extra on top when its halves are made from cross-sections: the shallow cone from the wick hole out to its top edge. */
export function topDipVolume(p: PillarPlan): number {
  if (!p.byHalves) return 0;
  const top = p.cast[0].pts!;
  return stackVolume([{ z: 0, pts: wickLike(top, p.wick) }, { z: TOP_DIP, pts: top }]);
}

/** A square on a corner round (x, y), `r` from the middle to each corner. */
const diamond = (x: number, y: number, r: number): P2[] => [
  [x + r, y],
  [x, y + r],
  [x - r, y],
  [x, y - r],
];
/** The V notch in the flange's edge at x = ±X, height z, in sketch coordinates where (x, z·k) is the point. */
const notch = (X: number, side: 1 | -1, z: number, k: number): P2[] =>
  side > 0
    ? [
        [X + 1, k * (z - NOTCH - 1)],
        [X + 1, k * (z + NOTCH + 1)],
        [X - NOTCH, k * z],
      ]
    : [
        [-X - 1, k * (z + NOTCH + 1)],
        [-X - 1, k * (z - NOTCH - 1)],
        [-X + NOTCH, k * z],
      ];

const outlineOf = (pts: P2[], ctx: MakeContext) => outlineSketch(pts.map(([x, y]) => [lit(Math.round(x * 1e6) / 1e6), lit(Math.round(y * 1e6) / 1e6)]), ctx.scope);

function halfFeatures(ctx: MakeContext, p: ReturnType<typeof pillarPlan>, side: 1 | -1, outerRoles: string[], cavityRoles: string[]): Feature[] {
  const k = side > 0 ? "a" : "b";
  const id = ctx.id(`half-${k}`);
  const name = side > 0 ? "Half A" : "Half B";
  const { X, top, end } = p;
  // Planes on the split (y = 0): `toward` the other half (pegs) or `into` this half (holes), sketch y = ±z.
  const toward = fixedPlane("Split face", [0, 0, 0], [1, 0, 0], [0, 0, side]);
  const into = fixedPlane("Split face", [0, 0, 0], [1, 0, 0], [0, 0, -side]);
  const ky = (plane: "toward" | "into") => (plane === "toward" ? side : -side);
  const pegAt = side > 0 ? p.pegX : -p.pegX;
  const body: Feature[] = p.byHalves
    ? stackFeatures(ctx, `half-${k}`, `${name}`, halfSections(p, side), "new")
    : [
    loftThrough(ctx, `half-${k}`, `${name}`, outerRoles, "new"),
    sketchFeature(ctx.id(`flange-${k}-sketch`), `${name} flange sketch`, { kind: "default", name: "Top" }, shapesSketch([rectShape(-X, side > 0 ? 0 : -FLANGE_THICK, 2 * X, FLANGE_THICK)], ctx.scope)),
    extrudeFeature(ctx.id(`flange-${k}`), `${name} flange`, ctx.id(`flange-${k}-sketch`), { depth: lit(top), operation: "add" }),
    loftThrough(ctx, `cavity-${k}`, `${name} candle shape`, cavityRoles, "remove"),
    sketchFeature(ctx.id(`other-${k}-sketch`), `${name}: the other side`, levelPlane("1 mm below the bed", -1), shapesSketch([rectShape(-X - 2, side > 0 ? -X - 2 : 0, 2 * X + 4, X + 2)], ctx.scope)),
    extrudeFeature(ctx.id(`other-${k}`), `${name}: cut in half`, ctx.id(`other-${k}-sketch`), { depth: lit(top + 2), operation: "remove" }),
    sketchFeature(ctx.id(`wick-${k}-sketch`), `${name} wick hole sketch`, levelPlane("1 mm below the bed", -1), shapesSketch([circleShape(0, 0, p.wick)], ctx.scope)),
    extrudeFeature(ctx.id(`wick-${k}`), `${name} wick hole`, ctx.id(`wick-${k}-sketch`), { depth: lit(end + 2), operation: "remove" }),
      ];
  return [
    ...body,
    sketchFeature(ctx.id(`pegs-${k}-sketch`), `${name} pegs sketch`, toward, loopsSketch(p.pegZ.map((z) => outlineOf(diamond(pegAt, ky("toward") * z, PEG), ctx)))),
    extrudeFeature(ctx.id(`pegs-${k}`), `${name} pegs`, ctx.id(`pegs-${k}-sketch`), { depth: lit(PEG_LENGTH), operation: "add" }),
    sketchFeature(ctx.id(`holes-${k}-sketch`), `${name} peg holes sketch`, into, loopsSketch(p.pegZ.map((z) => outlineOf(diamond(-pegAt, ky("into") * z, p.hole), ctx)))),
    extrudeFeature(ctx.id(`holes-${k}`), `${name} peg holes`, ctx.id(`holes-${k}-sketch`), { depth: lit(HOLE_DEPTH), operation: "remove" }),
    sketchFeature(
      ctx.id(`notches-${k}-sketch`),
      `${name} band notches sketch`,
      fixedPlane("Behind the split face", [0, -side, 0], [1, 0, 0], [0, 0, -side]),
      loopsSketch(p.notchZ.flatMap((z) => [outlineOf(notch(X, 1, z, -side), ctx), outlineOf(notch(X, -1, z, -side), ctx)])),
    ),
    extrudeFeature(ctx.id(`notches-${k}`), `${name} band notches`, ctx.id(`notches-${k}-sketch`), { depth: lit(FLANGE_THICK + 2), operation: "remove" }),
    ...(side < 0 ? [moveFeature(ctx.id("b-beside"), "Half B beside half A", id, { dy: lit(-HALF_GAP) })] : []),
  ];
}

/** The master: the candle standing on its base (the open end), so it prints with no supports. */
export const masterStack = (cast: Section[]): Section[] => {
  const H = cast[cast.length - 1].z;
  return cast
    .slice()
    .reverse()
    .map((s) => ({ ...s, z: Math.round((H - s.z) * 1e6) / 1e6 }));
};

/** For tests and the summary: the candle's volume, and each half's (or the master's) volume (mm³). */
export function pillarVolumes(v: DesignValues): { cast: number; a?: number; b?: number; master?: number } {
  const p = pillarPlan(v);
  const cast = stackVolume(p.cast);
  if (master(v)) return { cast, master: cast };
  const breaks = [...new Set([...p.outer.map((s) => s.z), ...p.cavity.map((s) => s.z), p.end])].sort((x, y) => x - y);
  const extras = () => {
    const n = p.pegZ.length;
    return n * 2 * PEG * PEG * PEG_LENGTH - n * 2 * p.hole * p.hole * HOLE_DEPTH - 2 * p.notchZ.length * NOTCH * NOTCH * FLANGE_THICK - (Math.PI * p.wick * p.wick * p.end) / 8;
  };
  if (p.byHalves) {
    // The wick hole is in the sections already.
    const half = (side: 1 | -1) => stackVolume(halfSections(p, side)) + extras() + (Math.PI * p.wick * p.wick * p.end) / 8;
    return { cast: cast + topDipVolume(p), a: half(1), b: half(-1) };
  }
  const half = (side: 1 | -1) => {
    const [y0, y1] = side > 0 ? [0, Infinity] : [-Infinity, 0];
    const [f0, f1] = side > 0 ? [0, FLANGE_THICK] : [-FLANGE_THICK, 0];
    const slab = (z: number) => {
      const o = sectionAt(p.outer, z)!;
      return stripArea(o, y0, y1) + 2 * p.X * FLANGE_THICK - stripArea(o, f0, f1);
    };
    // The closed end, then the rest with the candle's shape taken out.
    const body =
      integrate(slab, breaks.filter((z) => z <= p.end), 16) +
      integrate((z) => slab(z) - stripArea(sectionAt(p.cavity, z)!, y0, y1), breaks.filter((z) => z >= p.end), 16);
    const n = p.pegZ.length;
    return body - (Math.PI * p.wick * p.wick * p.end) / 8 + n * 2 * PEG * PEG * PEG_LENGTH - n * 2 * p.hole * p.hole * HOLE_DEPTH - 2 * p.notchZ.length * NOTCH * NOTCH * FLANGE_THICK;
  };
  return { cast, a: half(1), b: half(-1) };
}

export const pillarCandleMould: LibraryDesign = {
  id: "pillar-candle-mould",
  name: "Pillar candle mould",
  description:
    "A two-part mould for pillar candles, in any outside shape — round, square, faceted, fluted, twisted, stepped and more — with an optional pattern that stands out on the candle (ribs, spirals, rings, honeycomb, waves, dots…). The candle is poured upside down: the closed end makes the candle's top, with a hole for the wick, and the open end at the top is the candle's base. The halves line up with pegs and hold together with rubber bands in the notches (or bulldog clips on the flanges). Each half prints standing on its closed end, no supports. Thread the wick through the hole, tape it underneath, hold it straight with the wick centring bar, and pour. " +
    `${WAX_ADVICE} Or turn on "Make a master instead" for a solid candle to pour silicone round. ${MASTER_ADVICE}`,
  category: "print",
  group: "Moulds and casting",
  prefix: "pillar",
  icon: '<path d="M14 8h9v34h-9z"/><path d="M25 8h9v34h-9z" opacity=".55"/><path d="M24 3v5" stroke="currentColor" stroke-width="1.5"/><path d="M10 12h4M10 24h4M10 36h4M34 12h4M34 24h4M34 36h4" stroke="currentColor" stroke-width="1.5"/>',
  inputs: [
    { key: "width", label: "Candle width", kind: "length", default: 60, min: 25, max: 120, help: "Across the candle's base (the widest end)." },
    { key: "height", label: "Candle height", kind: "length", default: 90, min: 30, max: 200 },
    ...outsideInputs(),
    { key: "draft", label: "Draft", kind: "length", default: 2, min: 0.5, max: 6, help: "Degrees the sides taper towards the candle's top, so it lets go of the mould." },
    { key: "wall", label: "Mould wall", kind: "length", default: 2, min: 1.2, max: 4, help: "Stiff but still a little flexible: 1.6–2.4 mm suits most." },
    { key: "wick", label: "Wick hole", kind: "length", default: 2, min: 1, max: 6 },
    { key: "fit", label: "Peg fit", kind: "length", default: 0.2, min: 0.05, max: 0.5, help: "Room round the pegs in their holes." },
    { key: "master", label: "Make a master instead", kind: "toggle", default: false, help: "Just the candle, solid, to pour a silicone mould round." },
  ],
  problems: (v) => {
    const b = castSize(v);
    const out = outsideProblems(outsideOf(v), b, master(v) ? "master" : "split", "wax");
    if (num(v, "wick") > b.W / 5) out.push(`The wick hole is too big for a candle this narrow: make it at most ${mm(b.W / 5)}.`);
    return out;
  },
  summary: (v) => {
    const p = pillarPlan(v);
    const vol = pillarVolumes(v);
    if (master(v)) {
      const w = 2 * widest(p.cast) + 20;
      const silicone = w * w * (p.b.H + 10) - vol.cast;
      return `1 part: the candle, standing on its base. It holds ${waxLine(vol.cast)}. A mould box 10 mm bigger all round takes about ${ml(silicone)} ml of silicone (${grams(silicone, SILICONE_DENSITY)}).`;
    }
    return `2 halves, each ${mm(2 * p.X)} wide and ${mm(p.top)} tall, printed side by side. The candle: ${waxLine(vol.cast)}.`;
  },
  make: (ctx) => {
    const p = pillarPlan(ctx.values);
    if (master(ctx.values)) {
      const id = ctx.id("master");
      return { features: stackFeatures(ctx, "master", "Candle master", masterStack(p.cast), "new"), partNames: { [id]: `${ctx.name}: master` } };
    }
    const outer = p.byHalves ? { features: [], roles: [] } : stackSketches(ctx, "outer", "Mould outside", p.outer);
    const cavity = p.byHalves ? { features: [], roles: [] } : stackSketches(ctx, "shape", "Candle shape", extended(p.cavity, 1));
    return {
      features: [...outer.features, ...cavity.features, ...halfFeatures(ctx, p, 1, outer.roles, cavity.roles), ...halfFeatures(ctx, p, -1, outer.roles, cavity.roles)],
      partNames: { [ctx.id("half-a")]: `${ctx.name}: half A`, [ctx.id("half-b")]: `${ctx.name}: half B` },
    };
  },
  preview: (v) => {
    const p = pillarPlan(v);
    if (master(v)) return outsidePreview(masterStack(p.cast), [0, 0], "the master, standing on its base");
    const shapes: PreviewShape[] = [
      { kind: "poly", closed: true, faint: true, points: [[-p.X, 0], [p.X, 0], [p.X, p.top], [-p.X, p.top]] },
      ...outsidePreview(p.cavity, [0, 0], "the candle inside, upside down"),
    ];
    return shapes;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Wick centring bar

/** The bar: its length, width and thickness; the locating lugs under each end; the wick's hole and the slot in to it. */
export const BAR = { width: 12, thick: 3, overhang: 10, lug: 3, lugHeight: 4, room: 0.5 };

export function wickBarPlan(v: DesignValues) {
  const span = num(v, "span");
  const wick = num(v, "wick");
  const length = span + 2 * BAR.overhang;
  /** The lugs' outer faces, just inside the mouth. */
  const lugOut = span / 2 - BAR.room;
  return { span, wick, length, lugOut, hole: wick + 0.4, slot: Math.max(1, Math.round(wick * 0.75 * 100) / 100) };
}

export function wickBarVolume(v: DesignValues): number {
  const p = wickBarPlan(v);
  const bar = p.length * BAR.width * BAR.thick;
  const lugs = 2 * BAR.lug * BAR.width * BAR.lugHeight;
  // The round hole in the middle and the slot from the bar's front edge to it; the slot's end lies inside the hole
  // (the circle's part with |x| ≤ slot/2 and y ≤ 0 is counted once).
  const R = p.hole / 2;
  const removed = Math.PI * R * R + (p.slot * BAR.width) / 2 - circleBand(R, p.slot / 2);
  return bar + lugs - removed * BAR.thick;
}

export const wickBar: LibraryDesign = {
  id: "wick-bar",
  name: "Wick centring bar",
  description:
    "A bar that sits across the top of a candle mould or jar and holds the wick straight up the middle while the wax sets. Two little lugs underneath drop just inside the mouth so it stays centred; slide the wick in through the slot to the hole in the middle. Prints flat, lugs up. PLA is fine, as it only sits over the wax; PETG for hot paraffin.",
  category: "print",
  group: "Moulds and casting",
  prefix: "wickbar",
  icon: '<path d="M4 20h40v6H4z"/><path d="M10 26h4v5h-4zM34 26h4v5h-4z" opacity=".6"/><circle cx="24" cy="23" r="1.6" fill="none" stroke="currentColor"/>',
  inputs: [
    { key: "span", label: "Mouth width", kind: "length", default: 70, min: 20, max: 200, help: "Inside the top of the mould or jar." },
    { key: "wick", label: "Wick thickness", kind: "length", default: 2, min: 1, max: 6 },
  ],
  problems: (v) => {
    const p = wickBarPlan(v);
    return p.lugOut - BAR.lug < p.hole / 2 + 4 ? ["The mouth is too narrow for the lugs and the wick hole: make it wider."] : [];
  },
  summary: (v) => {
    const p = wickBarPlan(v);
    return `1 part, ${mm(p.length)} long; the lugs fit a mouth ${mm(p.span)} wide, and the wick hole is ${mm(p.hole)}.`;
  },
  make: (ctx) => {
    const p = wickBarPlan(ctx.values);
    const id = ctx.id("bar");
    const top = { kind: "default", name: "Top" } as const;
    return {
      features: [
        sketchFeature(ctx.id("bar-sketch"), "Bar sketch", top, shapesSketch([rectShape(-p.length / 2, -BAR.width / 2, p.length, BAR.width)], ctx.scope)),
        extrudeFeature(id, "Bar", ctx.id("bar-sketch"), { depth: lit(BAR.thick), operation: "new" }),
        sketchFeature(
          ctx.id("lugs-sketch"),
          "Lugs sketch",
          levelPlane(`${mm(BAR.thick)} up`, BAR.thick),
          shapesSketch([rectShape(-p.lugOut, -BAR.width / 2, BAR.lug, BAR.width), rectShape(p.lugOut - BAR.lug, -BAR.width / 2, BAR.lug, BAR.width)], ctx.scope),
        ),
        extrudeFeature(ctx.id("lugs"), "Lugs", ctx.id("lugs-sketch"), { depth: lit(BAR.lugHeight), operation: "add" }),
        sketchFeature(ctx.id("hole-sketch"), "Wick hole sketch", levelPlane("1 mm below the bed", -1), shapesSketch([circleShape(0, 0, p.hole)], ctx.scope)),
        extrudeFeature(ctx.id("hole"), "Wick hole", ctx.id("hole-sketch"), { depth: lit(BAR.thick + 2), operation: "remove" }),
        sketchFeature(ctx.id("slot-sketch"), "Wick slot sketch", levelPlane("1 mm below the bed", -1), shapesSketch([rectShape(-p.slot / 2, -BAR.width / 2 - 1, p.slot, BAR.width / 2 + 1)], ctx.scope)),
        extrudeFeature(ctx.id("slot"), "Wick slot", ctx.id("slot-sketch"), { depth: lit(BAR.thick + 2), operation: "remove" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const p = wickBarPlan(v);
    return [
      { kind: "poly", closed: true, points: [[-p.length / 2, -BAR.width / 2], [p.length / 2, -BAR.width / 2], [p.length / 2, BAR.width / 2], [-p.length / 2, BAR.width / 2]] },
      { kind: "circle", c: [0, 0], r: p.hole / 2 },
      { kind: "poly", closed: false, points: [[-p.slot / 2, -BAR.width / 2], [-p.slot / 2, 0]] },
      { kind: "poly", closed: false, points: [[p.slot / 2, -BAR.width / 2], [p.slot / 2, 0]] },
      { kind: "poly", closed: true, faint: true, points: [[-p.lugOut, -BAR.width / 2], [-p.lugOut + BAR.lug, -BAR.width / 2], [-p.lugOut + BAR.lug, BAR.width / 2], [-p.lugOut, BAR.width / 2]] },
      { kind: "poly", closed: true, faint: true, points: [[p.lugOut - BAR.lug, -BAR.width / 2], [p.lugOut, -BAR.width / 2], [p.lugOut, BAR.width / 2], [p.lugOut - BAR.lug, BAR.width / 2]] },
    ] as PreviewShape[];
  },
};
