/**
 * The decorated outsides shared by the casting moulds (pillar candle and its master, plant pot, candle holder, trinket
 * dish): an outside shape (round, square, faceted, fluted, twisted, tapered, barrel, stepped, rounded…) and a surface
 * pattern on it (ribs, spirals, rings, lattice, honeycomb, waves, chevrons, basket weave, dots, random low-poly).
 *
 * Everything is pure and exact: the cast's outside is a stack of level cross-sections (a circle, or a closed polygon
 * whose corners all sit at the same angles round the axis on every level), joined by a ruled Loft ("Straight between
 * shapes"). Between two levels each corner runs in a straight line, so a section half-way up is the polygon of the
 * corners half-way along — its area is quadratic in the height, and Simpson's rule gives the loft's volume exactly.
 *
 * z runs from the cast's CLOSED end (z = 0: the end it can't come out of — a pot's bottom, a pillar candle's top) to
 * its OPEN end (z = H, where it's poured and comes out). Widths are measured at the open end: across the flats of a
 * polygon, or the diameter of a round one. The draft makes every section smaller towards the closed end.
 *
 * Patterns are cut into the mould's cavity, so they stand proud on the cast (they add `depth` × p, 0 ≤ p ≤ 1, to the
 * radius). Which patterns a mould may have depends on how the cast comes out — see `outsideProblems`:
 *  - a rigid one-piece mould (pot, holder and dish shells): the cast slides straight out of the open end, so every
 *    corner of every section must be no further out than it is on the level above (towards the opening), by at least
 *    the draft — only patterns that don't change up the height (vertical ribs, waves round) and shapes that only widen;
 *  - a mould split in two halves down the middle (the pillar candle): the halves pull apart sideways, so in each half
 *    nothing may face back towards the split (the pattern fades out near the split line, and that's checked);
 *  - a master for a silicone mould: anything that prints.
 * Every surface must also print without supports: nothing may lean out more than 45° from upright (`printProblem`).
 */
import type { DesignInput, DesignValues, PreviewShape } from "../types";
import { seeded } from "../puzzle";
import { areaOf, clipToBox, type P2 } from "./printShapes";
import { mm, num } from "./common";

export type OutsideShape = "round" | "square" | "hexagon" | "octagon" | "faceted" | "fluted" | "twisted" | "tapered" | "barrel" | "stepped" | "dome";
export type SurfacePattern = "none" | "ribs" | "spiral" | "rings" | "lattice" | "honeycomb" | "waves" | "chevron" | "basket" | "dots" | "lowpoly";

export const OUTSIDE_SHAPES: readonly { value: OutsideShape; label: string }[] = [
  { value: "round", label: "Round" },
  { value: "square", label: "Square" },
  { value: "hexagon", label: "Hexagon" },
  { value: "octagon", label: "Octagon" },
  { value: "faceted", label: "Faceted (low-poly)" },
  { value: "fluted", label: "Fluted (ribbed)" },
  { value: "twisted", label: "Twisted" },
  { value: "tapered", label: "Tapered / flared" },
  { value: "barrel", label: "Bulb / barrel" },
  { value: "stepped", label: "Stepped tiers" },
  { value: "dome", label: "Rounded (ball)" },
];

export const SURFACE_PATTERNS: readonly { value: SurfacePattern; label: string }[] = [
  { value: "none", label: "None (smooth)" },
  { value: "ribs", label: "Vertical ribs" },
  { value: "spiral", label: "Spiral ribs" },
  { value: "rings", label: "Horizontal rings" },
  { value: "lattice", label: "Diamond lattice" },
  { value: "honeycomb", label: "Honeycomb" },
  { value: "waves", label: "Waves" },
  { value: "chevron", label: "Chevron zigzag" },
  { value: "basket", label: "Basket weave" },
  { value: "dots", label: "Bubbles (dots)" },
  { value: "lowpoly", label: "Geometric (random facets)" },
];

/** Patterns that don't change up the height, so a cast slides straight out of a one-piece mould. */
export const STRAIGHT_PATTERNS: readonly SurfacePattern[] = ["none", "ribs", "waves"];
/** Shapes that would lock a cast into a one-piece mould. */
export const LOCKING_SHAPES: readonly OutsideShape[] = ["twisted", "barrel"];

/** How the cast leaves the mould. */
export type Release = "rigid" | "split" | "master";

export interface Outside {
  shape: OutsideShape;
  /** Faceted and twisted: how many flat sides. */
  sides: number;
  /** Fluted: how many ribs. */
  ribs: number;
  /** Twisted: degrees it turns from the closed end to the open end. */
  twist: number;
  /** Tapered: the closed end's width, % of the open end's. */
  narrow: number;
  /** Barrel: how far it bulges out in the middle, % of the half-width. */
  bulge: number;
  /** Stepped: how many tiers. */
  tiers: number;
  pattern: SurfacePattern;
  /** How far the pattern stands out (mm). */
  depth: number;
  /** How many times the pattern repeats round. */
  count: number;
  /** The random facets' pattern number. */
  seed: number;
}

const choiceOf = <T extends string>(v: DesignValues, key: string, list: readonly { value: T }[], fallback: T): T => (list.some((c) => c.value === v[key]) ? (v[key] as T) : fallback);
const whole = (v: DesignValues, key: string, lo: number) => Math.max(lo, Math.round(num(v, key)));

export function outsideOf(v: DesignValues): Outside {
  return {
    shape: choiceOf(v, "shape", OUTSIDE_SHAPES, "round"),
    sides: whole(v, "sides", 3),
    ribs: whole(v, "ribs", 3),
    twist: num(v, "twist"),
    narrow: num(v, "narrow"),
    bulge: num(v, "bulge"),
    tiers: whole(v, "tiers", 2),
    pattern: choiceOf(v, "pattern", SURFACE_PATTERNS, "none"),
    depth: num(v, "patternDepth"),
    count: whole(v, "patternCount", 2),
    seed: whole(v, "patternSeed", 1),
  };
}

/** The outside's inputs, the same on every mould (only the first shape offered changes). */
export function outsideInputs(defaults: { shape?: OutsideShape; pattern?: SurfacePattern } = {}): DesignInput[] {
  return [
    { key: "shape", label: "Outside shape", kind: "choice", default: defaults.shape ?? "round", choices: OUTSIDE_SHAPES.map((c) => ({ ...c })) },
    { key: "sides", label: "Sides", kind: "count", default: 8, min: 5, max: 24, help: "Faceted and twisted shapes: how many flat sides." },
    { key: "ribs", label: "Ribs", kind: "count", default: 12, min: 6, max: 32, help: "Fluted shapes: how many ribs round." },
    { key: "twist", label: "Twist", kind: "length", default: 45, min: 5, max: 180, help: "Twisted shapes: degrees it turns from end to end." },
    { key: "narrow", label: "Narrow end width (%)", kind: "count", default: 70, min: 30, max: 98, help: "Tapered shapes: the closed end's width as a share of the open end's." },
    { key: "bulge", label: "Bulge (%)", kind: "count", default: 12, min: 3, max: 30, help: "Barrel shapes: how much wider the middle is." },
    { key: "tiers", label: "Tiers", kind: "count", default: 3, min: 2, max: 6, help: "Stepped shapes: how many steps." },
    { key: "pattern", label: "Surface pattern", kind: "choice", default: defaults.pattern ?? "none", choices: SURFACE_PATTERNS.map((c) => ({ ...c })) },
    { key: "patternDepth", label: "Pattern depth", kind: "length", default: 1.2, min: 0.4, max: 3, help: "How far the pattern stands out on the cast." },
    { key: "patternCount", label: "Pattern repeats round", kind: "count", default: 8, min: 3, max: 40, help: "How many times it repeats round; patterns that change up the height repeat about as often up as round." },
    { key: "patternSeed", label: "Pattern number", kind: "count", default: 1, min: 1, max: 9999, help: "Geometric facets: each number gives a different random pattern." },
  ];
}

/** The cast's main sizes: width at the open end (across flats / diameter), height, draft (°); `lean` (°) = sides that slope more (a dish). */
export interface CastSize {
  W: number;
  H: number;
  draft: number;
  lean?: number;
  /** Radians the base polygon is turned (0: a corner on +x, as the split mould needs; π/n: a side facing +x). */
  turn?: number;
}

const six = (n: number) => Math.round(n * 1e6) / 1e6;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Flat sides of the base shape (0 = round). */
export function baseSides(o: Outside): number {
  switch (o.shape) {
    case "square":
      return 4;
    case "hexagon":
      return 6;
    case "octagon":
      return 8;
    case "faceted":
    case "twisted":
      return o.sides;
    default:
      return 0;
  }
}

/** The steepest the sides lean in towards the closed end (tan of the draft, or of a dish's lean). */
export const sideSlope = (b: CastSize) => Math.tan(rad(Math.max(b.draft, b.lean ?? 0)));

/** The rounded shape's ball: its radius and how far its middle is above the flat bottom (the rim sits the draft below the ball's middle). */
export function domeBall(b: CastSize): { R: number; centre: number } {
  const R = b.W / 2 / Math.cos(rad(b.draft));
  return { R, centre: b.H + R * Math.sin(rad(b.draft)) };
}

/** The tallest a rounded (ball) shape can be for this width and draft, keeping a flat bottom at least a quarter as wide. */
export const domeMostHeight = (W: number, draft: number) => {
  const R = W / 2 / Math.cos(rad(draft));
  return R * (Math.sqrt(1 - 0.25 * 0.25) - Math.sin(rad(draft)));
};

/** Stepped shapes: each step's size (mm in on each side). */
export const stepSize = (W: number) => Math.max(1.5, 0.05 * W);
/** Fluted shapes: how deep the flutes are. */
export const fluteDepth = (W: number) => Math.min(4, Math.max(1, 0.05 * W));

/** The base shape's half-width (apothem, or radius) at height z, before flutes and patterns. */
export function apothemAt(o: Outside, b: CastSize, z: number): number {
  const A = b.W / 2;
  const plain = A - (b.H - z) * sideSlope(b);
  switch (o.shape) {
    case "tapered":
      return A - (b.H - z) * Math.max(sideSlope(b), (A * (1 - o.narrow / 100)) / b.H);
    case "barrel":
      return plain + ((A * o.bulge) / 100) * Math.sin((Math.PI * z) / b.H);
    case "stepped": {
      const st = stepSize(b.W);
      let a = plain;
      for (let j = 1; j < o.tiers; j++) a -= st * Math.min(1, Math.max(0, (b.H * (j / o.tiers) + st / 2 - z) / st));
      return a;
    }
    case "dome": {
      const { R, centre } = domeBall(b);
      return Math.sqrt(Math.max(0, R * R - (centre - z) ** 2));
    }
    default:
      return plain;
  }
}

/** Heights where the base shape's sides bend (the sections it needs without any pattern). */
export function profileLevels(o: Outside, b: CastSize): number[] {
  switch (o.shape) {
    case "barrel":
      return Array.from({ length: 17 }, (_, i) => (b.H * i) / 16);
    case "stepped": {
      const st = stepSize(b.W);
      const out = [0, b.H];
      for (let j = 1; j < o.tiers; j++) out.push(b.H * (j / o.tiers) - st / 2, b.H * (j / o.tiers) + st / 2);
      return out;
    }
    case "dome": {
      const { R, centre } = domeBall(b);
      const [b0, b1] = [Math.acos(Math.min(1, centre / R)), Math.acos(Math.min(1, (centre - b.H) / R))];
      return Array.from({ length: 15 }, (_, i) => Math.min(b.H, Math.max(0, centre - R * Math.cos(b0 + ((b1 - b0) * i) / 14))));
    }
    default:
      return [0, b.H];
  }
}

/** How far a twisted shape has turned at height z (radians). */
export const turnAt = (o: Outside, b: CastSize, z: number) => (b.turn ?? 0) + (o.shape === "twisted" ? (rad(o.twist) * z) / b.H : 0);

/** A side facing +x (so a square sits square to the bed's edges). */
export const sideOnX = (o: Outside) => (baseSides(o) ? Math.PI / baseSides(o) : 0);

// ---------------------------------------------------------------------------------------------------------------
// Patterns: p(φ, v) between 0 and 1, φ = repeats × angle round (one repeat per 2π), v = repeats × height / half-width
// (so a repeat is as tall as it is wide at the open end).

const rib = (x: number) => Math.max(0, (Math.cos(x) - 0.2) / 0.8);
const frac = (x: number) => x - Math.floor(x);
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** The honeycomb's and dots' lattice: columns 2π apart round, rows `HEX_ROW` apart up, odd columns half a row up. */
const HEX_COL = 2 * Math.PI;
const HEX_R = HEX_COL / 1.5;
const HEX_ROW = Math.sqrt(3) * HEX_R;
const HEX_APOTHEM = HEX_ROW / 2;

function nearestCentre(phi: number, v: number, cols: number): { dx: number; dy: number } {
  const i0 = Math.round(phi / HEX_COL);
  let best = { dx: Infinity, dy: Infinity, d: Infinity };
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    const shift = (((i % cols) + cols) % cols) % 2 ? HEX_ROW / 2 : 0;
    const j = Math.round((v - shift) / HEX_ROW);
    for (const jj of [j - 1, j, j + 1]) {
      const dx = phi - i * HEX_COL;
      const dy = v - shift - jj * HEX_ROW;
      const d = Math.hypot(dx, dy);
      if (d < best.d) best = { dx, dy, d };
    }
  }
  return best;
}

/** Random facet heights for the geometric pattern: one per grid corner, `cols` round × `rows + 1` up. */
export function facetHeights(seed: number, cols: number, rows: number): number[][] {
  const rnd = seeded(seed * 7919 + cols * 31 + rows);
  return Array.from({ length: rows + 1 }, () => Array.from({ length: cols }, () => rnd()));
}

/** Rows of facets up the height for the geometric pattern (about square at the open end). */
export const facetRows = (o: Outside, b: CastSize) => Math.max(1, Math.round((b.H * o.count) / (Math.PI * b.W)));

/** The pattern's columns round: the honeycomb and dots need an even number so their staggered rows meet round the back. */
export const patternColumns = (o: Outside) => (o.pattern === "honeycomb" || o.pattern === "dots" ? 2 * Math.max(2, Math.round(o.count / 2)) : o.count);

/** The pattern's height (0…1) at angle θ (radians, measured with the shape's twist) and height z. */
export function patternAt(o: Outside, b: CastSize, theta: number, z: number, heights?: number[][]): number {
  const cols = patternColumns(o);
  const phi = cols * theta;
  const v = (cols * z) / (b.W / 2);
  switch (o.pattern) {
    case "none":
      return 0;
    case "ribs":
      return rib(phi);
    case "waves":
      return (1 + Math.cos(phi)) / 2;
    case "spiral":
      return rib(phi - v);
    case "rings":
      return rib(v);
    case "lattice":
      return Math.max(rib(phi - v), rib(phi + v));
    case "chevron":
      return rib(v + 2 * Math.abs(frac(phi / (2 * Math.PI)) * 2 - 1));
    case "basket": {
      const [x, y] = [phi / (2 * Math.PI), v / (2 * Math.PI)];
      const [i, j] = [Math.floor(x), Math.floor(y)];
      const [fx, fy] = [x - i, y - j];
      const edge = Math.min(1, 2.5 * Math.sin(Math.PI * fx) * Math.sin(Math.PI * fy));
      return edge * rib(((i + j) % 2 === 0 ? fx : fy) * 6 * Math.PI);
    }
    case "honeycomb": {
      const c = nearestCentre(phi, v, cols);
      const n = Math.max(Math.abs(c.dy), (Math.sqrt(3) / 2) * Math.abs(c.dx) + Math.abs(c.dy) / 2) / HEX_APOTHEM;
      return smooth((1 - n) / 0.3);
    }
    case "dots": {
      const c = nearestCentre(phi, v, cols);
      const r = 0.42 * HEX_COL;
      const d = Math.hypot(c.dx, c.dy);
      return d < r ? Math.cos((Math.PI * d) / (2 * r)) ** 2 : 0;
    }
    case "lowpoly": {
      const rows = facetRows(o, b);
      const h = heights ?? facetHeights(o.seed, cols, rows);
      const X = ((phi / (2 * Math.PI)) % cols + cols) % cols;
      const Y = Math.min(rows - 1e-9, Math.max(0, (z / b.H) * rows));
      const [i, j] = [Math.floor(X), Math.floor(Y)];
      const [fx, fy] = [X - i, Y - j];
      const at = (a: number, c: number) => h[c][a % cols];
      const [v00, v10, v01, v11] = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
      return fx >= fy ? v00 + (v10 - v00) * fx + (v11 - v10) * fy : v00 + (v11 - v01) * fx + (v01 - v00) * fy;
    }
  }
}

/** Patterns whose height changes up the cast (they need many levels, and lock a cast into a one-piece mould). */
export const changesUp = (p: SurfacePattern) => !STRAIGHT_PATTERNS.includes(p);

// ---------------------------------------------------------------------------------------------------------------
// Sections

/** One level of the cast's outside: a circle round the axis (`r`), or a closed polygon (`pts`, anticlockwise). */
export interface Section {
  z: number;
  r?: number;
  pts?: P2[];
}

export interface SampledOutside {
  sections: Section[];
  /** Corners per polygon section (0 = circles). */
  corners: number;
  /** True when the pattern or twist needs more detail than builds quickly. */
  tooFine: boolean;
}

/** The most corners round, levels up, and corners in all. */
export const MOST_CORNERS = 96;
export const MOST_LEVELS = 36;
export const MOST_POINTS = 1200;
/** Near a split, the pattern fades out within this angle of the split line, so nothing catches. */
export const SPLIT_FADE = 35;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A point of a regular polygon with `n` sides, half-width (apothem) `a`, one corner at angle `turn`, in direction θ. */
export function polygonRadius(n: number, a: number, theta: number, turn: number): number {
  if (!n) return a;
  const sector = (2 * Math.PI) / n;
  let psi = (theta - turn - sector / 2) % sector;
  if (psi < 0) psi += sector;
  // psi is measured from a side's middle (sides' middles half a sector round from the corners).
  return a / Math.cos(psi > sector / 2 ? psi - sector : psi);
}

/** The cast's outside as level sections, closed end (z = 0) to open end (z = H). `split` = the pillar's two halves. */
export function castSections(o: Outside, b: CastSize, opts: { split?: boolean } = {}): SampledOutside {
  const n = baseSides(o);
  const relief = o.pattern !== "none" || o.shape === "fluted";
  const twisted = o.shape === "twisted";
  // Corners round: just the polygon's own corners when nothing is added to them; else enough for 8 per repeat.
  const unit = n ? (n * 2) / gcd(n, 2) : 4;
  // Repeats round that need corners (horizontal rings change only up the height).
  const reps = Math.max(o.shape === "fluted" ? o.ribs : 0, o.pattern !== "none" && o.pattern !== "rings" ? patternColumns(o) : 0);
  let corners = 0;
  if (relief) {
    corners = unit * Math.ceil(Math.max(48, 8 * reps) / unit);
    if (corners > MOST_CORNERS) corners = Math.max(unit, unit * Math.floor(MOST_CORNERS / unit));
  } else if (n) corners = n;
  // Levels: where the shape bends, plus evenly spaced ones for a pattern that changes up the height or a twist.
  let even = 0;
  if (relief && changesUp(o.pattern)) {
    even = o.pattern === "lowpoly" ? 2 * facetRows(o, b) : Math.ceil((b.H * patternColumns(o) * (o.pattern === "rings" ? 5 : 4)) / (Math.PI * b.W));
  }
  const levelsFor = (m: number) => {
    const k = twisted ? Math.max(even, Math.ceil(rad(o.twist) / (0.4 * ((2 * Math.PI) / Math.max(m, 3))))) : even;
    const knots = k >= 8 && (o.shape === "barrel" || o.shape === "dome") ? [0, b.H] : profileLevels(o, b);
    const all = [...knots, ...Array.from({ length: k + 1 }, (_, i) => (k ? (b.H * i) / k : 0))].sort((x, y) => x - y);
    const zs: number[] = [];
    for (const z of all) if (!zs.length || z - zs[zs.length - 1] > 1e-4) zs.push(z);
    zs[zs.length - 1] = b.H;
    return zs;
  };
  let zs = levelsFor(corners);
  // Too many corners in all: fewer round, down to 5 per repeat.
  if (relief && zs.length * corners > MOST_POINTS) {
    const fewer = unit * Math.floor(MOST_POINTS / zs.length / unit);
    if (fewer >= Math.max(unit, 5 * reps)) {
      corners = fewer;
      zs = levelsFor(corners);
    }
  }
  const tooFine = zs.length > MOST_LEVELS || zs.length * Math.max(corners, 1) > MOST_POINTS;
  const heights = o.pattern === "lowpoly" ? facetHeights(o.seed, patternColumns(o), facetRows(o, b)) : undefined;
  const df = fluteDepth(b.W);
  const sections = zs.map((z): Section => {
    const a = apothemAt(o, b, z);
    if (!corners) return { z: six(z), r: six(a) };
    const turn = turnAt(o, b, z);
    const pts = Array.from({ length: corners }, (_, i): P2 => {
      const theta = turn + (2 * Math.PI * i) / corners;
      let extra = 0;
      if (o.shape === "fluted") extra -= (df * (1 - Math.cos(o.ribs * (theta - turn)))) / 2;
      if (o.pattern !== "none") extra += o.depth * patternAt(o, b, theta - turn, z, heights);
      if (opts.split) extra *= Math.min(1, Math.abs(Math.sin(theta)) / Math.sin(rad(SPLIT_FADE))) ** 2;
      const r = polygonRadius(n, a, theta, turn) + extra;
      return [six(r * Math.cos(theta)), six(r * Math.sin(theta))];
    });
    return { z: six(z), pts };
  });
  return { sections, corners, tooFine };
}

// ---------------------------------------------------------------------------------------------------------------
// Measuring sections

export const sectionArea = (s: Section) => (s.pts ? areaOf(s.pts) : Math.PI * s.r! * s.r!);

/** The section between two levels at height z (every corner, or the radius, in a straight line between them). */
export function sectionBetween(a: Section, b: Section, z: number): Section {
  const t = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z);
  if (a.pts && b.pts) return { z, pts: a.pts.map((p, i): P2 => [p[0] + (b.pts![i][0] - p[0]) * t, p[1] + (b.pts![i][1] - p[1]) * t]) };
  return { z, r: a.r! + (b.r! - a.r!) * t };
}

/** The section at height z (null outside the stack). */
export function sectionAt(stack: Section[], z: number): Section | null {
  if (z < stack[0].z - 1e-9 || z > stack[stack.length - 1].z + 1e-9) return null;
  for (let i = 1; i < stack.length; i++) if (z <= stack[i].z + 1e-12) return sectionBetween(stack[i - 1], stack[i], z);
  return stack[stack.length - 1];
}

/** A stack moved up by dz. */
export const raised = (stack: Section[], dz: number): Section[] => stack.map((s) => ({ ...s, z: six(s.z + dz) }));

/** The stack carried on `past` mm beyond its last level, every corner along its last slope (so a cut runs clean out of a face). */
export function extended(stack: Section[], past: number): Section[] {
  const [a, b] = [stack[stack.length - 2], stack[stack.length - 1]];
  const s = sectionBetween(a, b, b.z + past);
  return [...stack, s.pts ? { z: six(s.z), pts: s.pts.map(([x, y]): P2 => [six(x), six(y)]) } : { z: six(s.z), r: six(s.r!) }];
}

/** The volume of a ruled loft through the stack between heights z0 and z1 (mm³; Simpson on each slab — exact). */
export function stackVolume(stack: Section[], z0 = stack[0].z, z1 = stack[stack.length - 1].z): number {
  return integrate((z) => sectionArea(sectionAt(stack, z)!), [z0, ...stack.map((s) => s.z).filter((z) => z > z0 && z < z1), z1], 1);
}

/** ∫ f(z) dz over the pieces between the breaks, with `steps` Simpson panels on each (exact for quadratics with 1). */
export function integrate(f: (z: number) => number, breaks: number[], steps = 1): number {
  let total = 0;
  for (let k = 1; k < breaks.length; k++) {
    const [a, b] = [breaks[k - 1], breaks[k]];
    if (b <= a) continue;
    const h = (b - a) / steps;
    for (let i = 0; i < steps; i++) {
      const [x0, x1] = [a + i * h, a + (i + 1) * h];
      total += (h / 6) * (f(x0) + 4 * f((x0 + x1) / 2) + f(x1));
    }
  }
  return total;
}

/** Area of a circle of radius R between the lines y = y0 and y = y1. */
export function circleStrip(R: number, y0: number, y1: number): number {
  const F = (y: number) => {
    const c = Math.max(-R, Math.min(R, y));
    return c * Math.sqrt(R * R - c * c) + R * R * Math.asin(c / R);
  };
  return F(y1) - F(y0);
}

/** Area of a section between y = y0 and y = y1 (both may be ±Infinity). */
export function stripArea(s: Section, y0: number, y1: number): number {
  if (!s.pts) return circleStrip(s.r!, y0, y1);
  const big = 1e6;
  return areaOf(clipToBox(s.pts, -big, Math.max(-big, y0), big, Math.min(big, y1)));
}

/** The furthest any point of the stack is from the axis. */
export const widest = (stack: Section[]) => Math.max(...stack.map((s) => (s.pts ? Math.max(...s.pts.map(([x, y]) => Math.hypot(x, y))) : s.r!)));

/** How far out a section reaches in direction (cos d, sin d). */
const reachIn = (s: Section, d: number) => (s.pts ? Math.max(...s.pts.map(([x, y]) => x * Math.cos(d) + y * Math.sin(d))) : s.r!);

// ---------------------------------------------------------------------------------------------------------------
// Checks

/**
 * A rigid one-piece mould: every corner of each section no further out than on the level above it, by at least the
 * draft, and no turning — so the cast slides straight out. Returns the height (mm up from the closed end) of the
 * first place that would lock, or null.
 */
export function lockedAt(stack: Section[], draft: number): number | null {
  const k = Math.tan(rad(draft)) * (1 - 1e-6);
  for (let i = 1; i < stack.length; i++) {
    const [a, b] = [stack[i - 1], stack[i]];
    const rise = (b.z - a.z) * k - 1e-7;
    if (a.r !== undefined) {
      if (b.r! - a.r < rise) return a.z;
      continue;
    }
    for (let j = 0; j < a.pts!.length; j++) {
      const [p, q] = [a.pts![j], b.pts![j]];
      const [rp, rq] = [Math.hypot(...p), Math.hypot(...q)];
      // Same direction round (no twist), and further out by the draft.
      if (Math.abs(p[0] * q[1] - p[1] * q[0]) > 1e-6 * rp * rq || rq - rp < rise) return a.z;
    }
  }
  return null;
}

/**
 * A mould split along y = 0 whose halves pull apart along ±y: in each half every face must face away from the split
 * (outward normal's y ≥ 0 in the y > 0 half). Checked on every level and half-way between them. Returns the worst
 * angle (°) a face turns back towards the split, 0 if none.
 */
export function splitCatch(stack: Section[]): number {
  let worst = 0;
  const levels: Section[] = [];
  for (let i = 0; i < stack.length; i++) {
    levels.push(stack[i]);
    if (i + 1 < stack.length) levels.push(sectionBetween(stack[i], stack[i + 1], (stack[i].z + stack[i + 1].z) / 2));
  }
  for (const s of levels) {
    if (!s.pts) continue;
    const p = s.pts;
    for (let i = 0; i < p.length; i++) {
      const [a, b] = [p[i], p[(i + 1) % p.length]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const ny = -dx / len;
      // An edge crossing the split is two pieces, one in each half; each must face away from the split in its own half.
      const halves: number[] = [];
      if (a[1] > 1e-9 || b[1] > 1e-9) halves.push(1);
      if (a[1] < -1e-9 || b[1] < -1e-9) halves.push(-1);
      for (const side of halves) {
        const back = -side * ny;
        if (back > 1e-9) worst = Math.max(worst, (Math.asin(Math.min(1, back)) * 180) / Math.PI);
      }
    }
  }
  return worst;
}

/**
 * Whether every surface prints without supports when the cast's closed end is at the bottom (or, for a master, at the
 * top): nothing may move outwards across a face more than 1 mm for each mm down towards the closed end — that would
 * lean over by more than 45°. Returns the worst lean (° past upright, 0…90) and where.
 */
export function steepestOverhang(stack: Section[]): number {
  let worst = 0;
  for (let i = 1; i < stack.length; i++) {
    const [a, b] = [stack[i - 1], stack[i]];
    const dz = b.z - a.z;
    if (dz <= 0) continue;
    const lean = (out: number) => (out > 0 ? (Math.atan2(out, dz) * 180) / Math.PI : 0);
    if (a.r !== undefined) {
      worst = Math.max(worst, lean(a.r - b.r!));
      continue;
    }
    const m = a.pts!.length;
    for (let j = 0; j < m; j++) {
      // Each corner's move down (from b to a) measured square to the faces either side of it.
      const move: P2 = [a.pts![j][0] - b.pts![j][0], a.pts![j][1] - b.pts![j][1]];
      for (const k of [j - 1, j]) {
        const [p, q] = [b.pts![(k + m) % m], b.pts![(k + 1) % m]];
        const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        worst = Math.max(worst, lean((move[0] * dy - move[1] * dx) / len));
      }
    }
  }
  return worst;
}

/** The share of the cast's outside the label uses: "twisted", "barrel"… */
const shapeLabel = (s: OutsideShape) => OUTSIDE_SHAPES.find((c) => c.value === s)!.label.toLowerCase();
const patternLabel = (p: SurfacePattern) => SURFACE_PATTERNS.find((c) => c.value === p)!.label.replace(/ \(.*\)$/, "").toLowerCase();

/**
 * What's wrong with an outside for this mould (plain English). `material` names what's cast ("wax", "concrete").
 * Rigid moulds refuse patterns and shapes that would lock the cast in (with what to do instead); split moulds check
 * nothing catches across the split; every mould checks it prints without supports and isn't too detailed to build.
 */
export function outsideProblems(o: Outside, b: CastSize, release: Release, material: string): string[] {
  const out: string[] = [];
  if (o.shape === "dome" && b.H > domeMostHeight(b.W, b.draft) + 1e-9) out.push(`A rounded shape this wide can be at most ${mm(domeMostHeight(b.W, b.draft))} tall: make it wider or lower.`);
  if (o.shape === "stepped" && b.H / o.tiers < 2 * stepSize(b.W)) out.push(`${o.tiers} tiers don't fit in this height: use fewer tiers or make it taller.`);
  if (o.shape === "barrel" && release === "rigid") out.push(`A bulging shape would lock the ${material} in a one-piece mould: choose another shape, or make a master for silicone with the pillar candle mould.`);
  if (o.shape === "twisted" && release === "rigid") out.push(`A twisted shape would lock the ${material} in a one-piece mould: choose another shape, or make a master for silicone with the pillar candle mould.`);
  // Twisting turns the corners across the split, so some face always looks back at it.
  if (o.shape === "twisted" && release === "split") out.push(`A twisted shape would catch where the two halves pull apart: turn on "Make a master instead" and make a silicone mould from it.`);
  if (release === "rigid" && changesUp(o.pattern)) {
    const name = patternLabel(o.pattern);
    out.push(`${name[0].toUpperCase()}${name.slice(1)} would lock the ${material} in a one-piece mould: choose vertical ribs, waves or no pattern — or use the pillar candle's two-part mould, or make a master for silicone.`);
  }
  if (o.pattern !== "none" && o.depth > b.W / 12) out.push(`The pattern is too deep for something this narrow: make it at most ${mm(b.W / 12)} deep.`);
  if (out.length) return out;
  const s = castSections(o, b, { split: release === "split" });
  if (s.tooFine) out.push("That's too much detail to build quickly: choose fewer pattern repeats, a smaller twist, or a shorter cast.");
  else {
    if (release === "rigid") {
      const at = lockedAt(s.sections, b.draft);
      if (at !== null) out.push(`The ${material} wouldn't slide out of a one-piece mould (it would catch ${mm(at)} up from the bottom): choose another shape or pattern.`);
    }
    if (release === "split") {
      const c = splitCatch(s.sections);
      if (c > 0.05) out.push(`The ${patternLabel(o.pattern) === "none (smooth)" ? shapeLabel(o.shape) : patternLabel(o.pattern)} would catch where the two halves pull apart: make the pattern shallower or use fewer repeats — or make a master for silicone.`);
    }
    const lean = steepestOverhang(s.sections);
    if (lean > 45 + 1e-6) out.push(`Part of the outside would lean over by ${Math.round(lean)}° and need supports to print: make the pattern shallower or use fewer repeats.`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The mould round the cast

/**
 * The outside of a mould's wall round a cast stack (already raised to where it sits): a plain shape — circles, or the
 * cast's own polygon turned the same way — at least `wall` clear of every point of the cast on each level, from
 * z = 0 (the bed) up to the stack's top, leaning out no more than 45° going up (so it prints without supports).
 */
export function wallAround(cast: Section[], o: Outside, b: CastSize, wall: number, base: number): Section[] {
  const n = baseSides(o);
  const slope = n ? Math.cos(Math.PI / n) : 1;
  const zs = [0, ...cast.map((s) => s.z)];
  const needs = cast.map((s) => {
    if (!n) return (s.pts ? Math.max(...s.pts.map(([x, y]) => Math.hypot(x, y))) : s.r!) + wall;
    const turn = turnAt(o, b, s.z - base);
    let most = 0;
    for (let k = 0; k < n; k++) most = Math.max(most, reachIn(s, turn + (Math.PI / n) * (2 * k + 1)));
    return most + wall;
  });
  const a = [needs[0], ...needs];
  for (let i = a.length - 2; i >= 0; i--) a[i] = Math.max(a[i], a[i + 1] - (zs[i + 1] - zs[i]) * slope);
  // Drop levels where nothing bends (straight on between their neighbours), unless the shape turns.
  const keep = zs.map((_, i) => {
    if (i === 0 || i === zs.length - 1 || o.shape === "twisted") return true;
    const t = (zs[i] - zs[i - 1]) / (zs[i + 1] - zs[i - 1]);
    return Math.abs(a[i - 1] + (a[i + 1] - a[i - 1]) * t - a[i]) > 1e-6;
  });
  return zs.flatMap((z, i): Section[] => {
    if (!keep[i]) return [];
    if (!n) return [{ z: six(z), r: six(a[i]) }];
    const turn = turnAt(o, b, Math.max(0, z - base));
    const R = a[i] / Math.cos(Math.PI / n);
    return [{ z: six(z), pts: Array.from({ length: n }, (_, k): P2 => [six(R * Math.cos(turn + (2 * Math.PI * k) / n)), six(R * Math.sin(turn + (2 * Math.PI * k) / n))]) }];
  });
}

/** A plain section of the base shape (no flutes or pattern): its own polygon or a circle, `a` across half, at height z. */
export function plainSection(o: Outside, a: number, z: number, turn = 0): Section {
  const n = baseSides(o);
  if (!n) return { z: six(z), r: six(a) };
  const R = a / Math.cos(Math.PI / n);
  return { z: six(z), pts: Array.from({ length: n }, (_, k): P2 => [six(R * Math.cos(turn + (2 * Math.PI * k) / n)), six(R * Math.sin(turn + (2 * Math.PI * k) / n))]) };
}

/** How far a stack reaches along ±x (for laying parts side by side). */
export const extentX = (stack: Section[]) => Math.max(...stack.map((s) => (s.pts ? Math.max(...s.pts.map(([x]) => Math.abs(x))) : s.r!)));

/** Where the faces of the base shape point (radians): the middles of a polygon's sides, or four ways round. */
export function faceDirections(o: Outside, turn = 0): number[] {
  const n = baseSides(o);
  if (!n) return [0, 1, 2, 3].map((k) => (k * Math.PI) / 2 + Math.PI / 4);
  return Array.from({ length: n }, (_, k) => turn + (Math.PI / n) * (2 * k + 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Preview: the cast seen from the side (its outline at the back and front), and its open end from above beside it.

export function outsidePreview(stack: Section[], at: [number, number] = [0, 0], label?: string, flip = false): PreviewShape[] {
  const right = stack.map((s): [number, number] => [reachIn(s, 0), s.z]);
  const left = stack.map((s): [number, number] => [-reachIn(s, Math.PI), s.z]);
  const H = stack[stack.length - 1].z;
  const place = ([x, y]: [number, number]): [number, number] => [at[0] + x, at[1] + (flip ? H - y : y)];
  const side = [...right, ...left.reverse()].map(place);
  const top = stack[stack.length - 1];
  const w = widest(stack);
  const dx = at[0] + 2 * w + 8;
  const cy = at[1] + H / 2;
  const plan: PreviewShape = top.pts
    ? { kind: "poly", closed: true, faint: true, points: top.pts.map(([x, y]): [number, number] => [dx + x, cy + y]) }
    : { kind: "circle", faint: true, c: [dx, cy], r: top.r! };
  const out: PreviewShape[] = [{ kind: "poly", closed: true, points: side }, plan];
  if (label) out.push({ kind: "text", at: [at[0] + w, at[1] - 8], text: label });
  return out;
}
