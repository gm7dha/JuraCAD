/**
 * The maths of a finger-jointed box (pure, no geometry engine): how many
 * fingers go along each edge, which panel owns each finger, and the outline
 * of every panel, as sizes that follow the design's variables.
 *
 * The box is W wide (x), D deep (y) and H high (z) on the outside, made of
 * sheet `t` thick. Panels: bottom (and lid) lying flat, front and back
 * standing in x–z, left and right standing in y–z.
 *
 * Where two panels meet, the strip they share (t × t, along the edge) is cut
 * into an odd number of equal fingers, given alternately to one panel and the
 * other — so both ends of every edge go to the same panel and the corners
 * work. The 8 corner cubes all belong to the front and back, so:
 *  - front/back ↔ left/right (upright edges, length H) and front/back ↔
 *    bottom/lid (length W) run the full length, front/back owning the ends;
 *  - bottom/lid ↔ left/right run between the front and back panels (length
 *    D − 2t), bottom/lid owning the ends.
 * With no lid the top edges of the walls are straight.
 *
 * Kerf: a laser burns away a thin line (the kerf), so every cut edge is drawn
 * kerf/2 further out. The panels come out at their true size and the fingers
 * fit snugly. (In the 3D view the panels then overlap by that much.)
 */
import { fraction, lit, minus, neg, over, plus, times, ZERO, type Ex } from "./ex";

/** Fingers narrower than this (beyond the thickness and kerf) aren't made: the edge gets fewer, wider ones. */
export const FINGER_MARGIN = 1;

/** The odd number nearest `x` (at least 1). */
export function nearestOdd(x: number): number {
  if (!(x >= 1)) return 1;
  return Math.max(1, 2 * Math.round((x - 1) / 2) + 1);
}

/**
 * Fingers along an edge `length` long, aiming for `finger` wide: an odd
 * number (so the same panel has both ends), each at least `smallest` wide.
 */
export function fingerCount(length: number, finger: number, smallest: number): number {
  let n = nearestOdd(length / finger);
  while (n > 1 && length / n < smallest) n -= 2;
  // A short edge still interlocks (three fingers) whenever three fit.
  if (n < 3 && length / 3 >= smallest) n = 3;
  return n;
}

export interface BoxSizes {
  /** Outside sizes and the sheet's thickness (mm, with the expressions behind them). */
  W: Ex;
  D: Ex;
  H: Ex;
  t: Ex;
  /** Kerf allowance (the laser's cut width). */
  kerf: Ex;
  lid: boolean;
  /** Finger width to aim for (mm). */
  finger: number;
}

export interface FingerCounts {
  /** Along the width (front/back ↔ bottom/lid). */
  width: number;
  /** Along the depth, between the front and back (bottom/lid ↔ sides). */
  depth: number;
  /** Up the height (front/back ↔ sides). */
  height: number;
}

export function fingerCounts(b: Pick<BoxSizes, "W" | "D" | "H" | "t" | "kerf" | "finger">): FingerCounts {
  const t = b.t.v;
  const k = Math.max(0, b.kerf.v);
  return {
    width: fingerCount(b.W.v, b.finger, t + k + FINGER_MARGIN),
    depth: fingerCount(b.D.v - 2 * t, b.finger, k + FINGER_MARGIN),
    height: fingerCount(b.H.v, b.finger, t + k + FINGER_MARGIN),
  };
}

/**
 * One side of a panel: where the panel's edge steps in and out along it.
 * `breaks` are the places along the side (increasing) where it steps;
 * `inset[i]` says whether piece i (between breaks) is cut back by the
 * thickness (true: a slot, the other panel's finger goes there) or reaches
 * the outside (false: this panel's finger).
 */
export interface Side {
  breaks: Ex[];
  inset: boolean[];
}

export type SideSpec =
  | { kind: "plain" }
  /** Fingers along the whole length; `ownsEnds`: this panel has the end fingers (and the even-numbered ones). */
  | { kind: "full"; length: Ex; count: number; ownsEnds: boolean }
  /** Fingers between the corner panels, t in from each end. */
  | { kind: "inner"; length: Ex; t: Ex; count: number; ownsEnds: boolean };

export function sideOf(spec: SideSpec): Side {
  if (spec.kind === "plain") return { breaks: [], inset: [false] };
  const n = spec.count;
  const inset = Array.from({ length: n }, (_, i) => (i % 2 === 0) !== spec.ownsEnds);
  const breaks: Ex[] = [];
  for (let i = 1; i < n; i++) {
    breaks.push(spec.kind === "full" ? fraction(spec.length, i, n) : plus(spec.t, fraction(minus(spec.length, times(spec.t, 2)), i, n)));
  }
  return { breaks, inset };
}

export type Pt = [Ex, Ex];

export interface PanelSpec {
  /** Size of the panel's rectangle (its own across and up). */
  U: Ex;
  V: Ex;
  south: SideSpec;
  east: SideSpec;
  north: SideSpec;
  west: SideSpec;
}

const first = (s: Side) => s.inset[0];
const last = (s: Side) => s.inset[s.inset.length - 1];

/**
 * The panel's outline before the kerf, anticlockwise from its bottom-left:
 * a rectangle U × V whose sides step in by t where the other panel's fingers go.
 */
export function nominalOutline(p: PanelSpec, t: Ex): Pt[] {
  const [S, E, N, W] = [sideOf(p.south), sideOf(p.east), sideOf(p.north), sideOf(p.west)];
  const ins = (on: boolean) => (on ? t : ZERO);
  const far = (size: Ex, on: boolean) => (on ? minus(size, t) : size);
  const pts: Pt[] = [];
  pts.push([ins(first(W)), ins(first(S))]);
  S.breaks.forEach((b, i) => pts.push([b, ins(S.inset[i])], [b, ins(S.inset[i + 1])]));
  pts.push([far(p.U, first(E)), ins(last(S))]);
  E.breaks.forEach((b, i) => pts.push([far(p.U, E.inset[i]), b], [far(p.U, E.inset[i + 1]), b]));
  pts.push([far(p.U, last(E)), far(p.V, last(N))]);
  for (let i = N.breaks.length - 1; i >= 0; i--) pts.push([N.breaks[i], far(p.V, N.inset[i + 1])], [N.breaks[i], far(p.V, N.inset[i])]);
  pts.push([ins(last(W)), far(p.V, first(N))]);
  for (let i = W.breaks.length - 1; i >= 0; i--) pts.push([ins(W.inset[i + 1]), W.breaks[i]], [ins(W.inset[i]), W.breaks[i]]);
  return tidyOutline(pts);
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Drop repeated points and points in the middle of a straight run. */
export function tidyOutline(pts: Pt[]): Pt[] {
  let out = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return !(same(p[0].v, q[0].v) && same(p[1].v, q[1].v));
  });
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      if ((same(a[0].v, b[0].v) && same(b[0].v, c[0].v)) || (same(a[1].v, b[1].v) && same(b[1].v, c[1].v))) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Every edge of an outline (axis-aligned, anticlockwise) moved `half` further
 * out — what a laser's kerf allowance does.
 */
export function grow(pts: Pt[], half: Ex): Pt[] {
  const n = pts.length;
  const dir = (a: Pt, b: Pt): [number, number] => [Math.sign(b[0].v - a[0].v), Math.sign(b[1].v - a[1].v)];
  return pts.map((p, i) => {
    const din = dir(pts[(i + n - 1) % n], p);
    const dout = dir(p, pts[(i + 1) % n]);
    // Outward normal of an edge going (dx, dy) round an anticlockwise outline is (dy, −dx).
    const ox = din[1] + dout[1];
    const oy = -din[0] - dout[0];
    const by = (k: number): Ex => (k === 0 ? ZERO : k > 0 ? times(half, k) : neg(times(half, -k)));
    return [plus(p[0], by(ox)), plus(p[1], by(oy))];
  });
}

/** Signed area of an outline (positive = anticlockwise), mm². */
export function areaOf(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0].v * q[1].v - q[0].v * p[1].v;
  }
  return a / 2;
}

export type PanelName = "bottom" | "front" | "left";

/** The three panel shapes (the lid, back and right are copies of the bottom, front and left). */
export function panelSpecs(b: BoxSizes, n: FingerCounts): Record<PanelName, PanelSpec> {
  const { W, D, H, t, lid } = b;
  const alongW = (ownsEnds: boolean): SideSpec => ({ kind: "full", length: W, count: n.width, ownsEnds });
  const alongH = (ownsEnds: boolean): SideSpec => ({ kind: "full", length: H, count: n.height, ownsEnds });
  const alongD = (ownsEnds: boolean): SideSpec => ({ kind: "inner", length: D, t, count: n.depth, ownsEnds });
  return {
    bottom: { U: W, V: D, south: alongW(false), north: alongW(false), west: alongD(true), east: alongD(true) },
    front: { U: W, V: H, south: alongW(true), north: lid ? alongW(true) : { kind: "plain" }, west: alongH(true), east: alongH(true) },
    left: { U: D, V: H, south: alongD(false), north: lid ? alongD(false) : { kind: "plain" }, west: alongH(false), east: alongH(false) },
  };
}

export interface PanelOutline {
  name: PanelName;
  /** As drawn (kerf allowance included), in the panel's own across/up. */
  outline: Pt[];
  /** Without the kerf (the panel's true shape). */
  nominal: Pt[];
}

export function panelOutlines(b: BoxSizes, n: FingerCounts = fingerCounts(b)): PanelOutline[] {
  const specs = panelSpecs(b, n);
  const half = over(b.kerf, 2);
  return (Object.keys(specs) as PanelName[]).map((name) => {
    const nominal = nominalOutline(specs[name], b.t);
    return { name, nominal, outline: grow(nominal, half) };
  });
}

/** The volume of the box's walls, floor (and lid): what the panels should add up to exactly. */
export function shellVolume(b: Pick<BoxSizes, "W" | "D" | "H" | "t" | "lid">): number {
  const [W, D, H, t] = [b.W.v, b.D.v, b.H.v, b.t.v];
  return W * D * H - (W - 2 * t) * (D - 2 * t) * (H - (b.lid ? 2 : 1) * t);
}

/** The sizes a box's panels need, or why they can't be made. */
export function boxProblems(b: BoxSizes): string[] {
  const out: string[] = [];
  const [W, D, H, t, k] = [b.W.v, b.D.v, b.H.v, b.t.v, b.kerf.v];
  if (!(t > 0)) out.push("The material thickness must be more than 0.");
  if (k < 0) out.push("The kerf allowance can't be less than 0.");
  if (t > 0 && Math.min(W, D, H) < 4 * t + 2) out.push(`The box is too small for material ${lit(t).t} mm thick: make each outside size at least ${lit(4 * t + 2).t} mm.`);
  if (!(b.finger > 0)) out.push("The finger width must be more than 0.");
  if (t > 0 && k >= t / 2) out.push(`A kerf allowance of ${lit(k).t} mm is a lot for ${lit(t).t} mm material — lasers usually burn away 0.1–0.3 mm.`);
  return out;
}
