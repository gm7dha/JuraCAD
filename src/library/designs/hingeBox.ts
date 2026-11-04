/**
 * A box with round corners whose four walls are one long strip of plywood that bends round the corners on living
 * hinges (rows of short staggered cuts, as in the living-hinge panel). The strip's bottom edge is finger-jointed into
 * the bottom panel along the four flat sides; the round corners are plain. The lid lifts off: a top plate with a smaller
 * plate glued under it that drops just inside the walls.
 *
 * The box is W × D outside, H tall with its lid, corners rounded R on the outside, sheet t thick; centred on the origin.
 *  - Bottom (z = 0…t): the inside's outline — W − 2t × D − 2t, corners R − t — with fingers reaching out to the outside
 *    along each straight side (between the corners: W − 2R and D − 2R long). Each side has an odd number of fingers;
 *    the strip has the end ones (next to the corners) and every other one, the bottom the rest.
 *  - The wall in 3D: the ring between the outside and the inside outlines, H − t tall, with the bottom's fingers cut out
 *    of its foot (a plain Remove with the bottom's own sketch, so it only cuts the wall just made).
 *  - The strip, laid flat (the "Wall strip" sketch, beside the box): as long as the four sides plus the four corners
 *    measured round the middle of the sheet (π/2 × (R − t/2) each), starting and ending in the middle of the back. Its
 *    foot has a notch wherever the bottom has a finger; each corner is a living hinge.
 *  - Lid: a plate W × D (corners R) on top, and under it a plate LID_ROOM clear of the walls all round.
 * Kerf: everything cut out is drawn kerf/2 bigger (notches and fingers alike), so the joints fit snugly. The sizes
 * aren't variables (the strip's flat pattern is worked out from them): change them with "Edit design sizes".
 */
import { lit } from "../ex";
import { fingerCount, FINGER_MARGIN, grow, type Pt } from "../fingers";
import { addLines, joinSketches } from "../laserKit";
import { fitsBed, offsetPolygon, r6, round6, tidyPolygon, type P2 } from "../outlines";
import { extrudeFeature, moveFeature, outlineSketch, roundCorners, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import { filletCorner } from "../../sketch/tools";
import { setCurrentScope } from "../../model/expr";
import { mm, num, roundedRect } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
/** Room round the lid's under-plate inside the walls (mm, each side). */
export const LID_ROOM = 0.25;
/** How far the wall strip is drawn in front of the box (mm). */
export const STRIP_GAP = 15;

export interface HingeBox {
  W: number;
  D: number;
  H: number;
  R: number;
  t: number;
  kerf: number;
  /** The wall's height (the lid sits on it). */
  wall: number;
  /** Fingers along the straight parts of the long (x) and short (y) sides. */
  nx: number;
  ny: number;
  /** Each corner's length round the middle of the sheet; the strip's whole length. */
  corner: number;
  length: number;
}

export function hingeBox(v: DesignValues): HingeBox {
  const [W, D, H, R, t, kerf, finger] = ["width", "depth", "height", "radius", "thickness", "kerf", "finger"].map((k) => num(v, k));
  const smallest = t + Math.max(0, kerf) + FINGER_MARGIN;
  const nx = fingerCount(W - 2 * R, finger, smallest);
  const ny = fingerCount(D - 2 * R, finger, smallest);
  const corner = (Math.PI / 2) * (R - t / 2);
  return { W, D, H, R, t, kerf, wall: H - t, nx, ny, corner, length: 2 * (W - 2 * R) + 2 * (D - 2 * R) + 4 * corner };
}

/** Breaks along a straight side `L` long (from its start) and whether each piece is the bottom's finger. */
const pieces = (L: number, n: number) => Array.from({ length: n }, (_, i) => ({ from: (i * L) / n, to: ((i + 1) * L) / n, bottom: i % 2 === 1 }));

/**
 * The bottom's outline before the kerf, anticlockwise from the bottom-left inside corner: sharp corners where the
 * round ones will be (they're rounded in the sketch), fingers along the straight parts.
 */
export function bottomOutline(b: HingeBox): P2[] {
  const { W, D, R, t } = b;
  const [hx, hy] = [W / 2, D / 2];
  const pts: P2[] = [[-hx + t, -hy + t]];
  const [Lx, Ly] = [W - 2 * R, D - 2 * R];
  // South (y = −D/2), left to right.
  for (const p of pieces(Lx, b.nx)) {
    const y = p.bottom ? -hy : -hy + t;
    pts.push([-Lx / 2 + p.from, y], [-Lx / 2 + p.to, y]);
  }
  pts.push([hx - t, -hy + t]);
  for (const p of pieces(Ly, b.ny)) {
    const x = p.bottom ? hx : hx - t;
    pts.push([x, -Ly / 2 + p.from], [x, -Ly / 2 + p.to]);
  }
  pts.push([hx - t, hy - t]);
  for (const p of pieces(Lx, b.nx)) {
    const y = p.bottom ? hy : hy - t;
    pts.push([Lx / 2 - p.from, y], [Lx / 2 - p.to, y]);
  }
  pts.push([-hx + t, hy - t]);
  for (const p of pieces(Ly, b.ny)) {
    const x = p.bottom ? -hx : -hx + t;
    pts.push([x, Ly / 2 - p.from], [x, Ly / 2 - p.to]);
  }
  return round6(tidyPolygon(pts));
}

/** The flat strip (along, up; before the kerf), anticlockwise: its foot notched where the bottom's fingers go. */
export function stripOutline(b: HingeBox): { outline: P2[]; notches: [number, number][]; zones: [number, number][] } {
  const { W, D, R, t, corner: a, wall } = b;
  const [Lx, Ly] = [W - 2 * R, D - 2 * R];
  const notches: [number, number][] = [];
  const zones: [number, number][] = [];
  const add = (s0: number, s1: number) => s1 - s0 > 1e-9 && notches.push([r6(s0), r6(s1)]);
  // The back's first half (from its middle), then each corner and side round to the back's second half.
  for (const p of pieces(Lx, b.nx)) if (p.bottom) add(Math.max(0, Lx / 2 - p.to), Math.max(0, Lx / 2 - p.from));
  let s = Lx / 2;
  const side = (L: number, n: number) => {
    zones.push([r6(s), r6(s + a)]);
    s += a;
    for (const p of pieces(L, n)) if (p.bottom) add(s + p.from, s + p.to);
    s += L;
  };
  side(Ly, b.ny);
  side(Lx, b.nx);
  side(Ly, b.ny);
  zones.push([r6(s), r6(s + a)]);
  s += a;
  for (const p of pieces(Lx, b.nx)) if (p.bottom) add(s + Math.max(0, p.from - Lx / 2), s + Math.max(0, p.to - Lx / 2));
  const total = b.length;
  notches.sort((x, y) => x[0] - y[0]);
  const foot: P2[] = [];
  let at = 0;
  for (const [n0, n1] of notches) {
    if (n0 > at + 1e-9) foot.push([at, 0], [n0, 0]);
    foot.push([n0, t], [n1, t]);
    at = n1;
  }
  if (at < total - 1e-9) foot.push([at, 0], [total, 0]);
  const pts = round6(tidyPolygon([...foot, [total, wall], [0, wall]]));
  return { outline: pts, notches, zones };
}

/** The living hinge's cuts in each corner zone: columns `spacing` apart, staggered, clear of the edges by `gap`. */
export function hingeColumns(b: HingeBox, v: DesignValues): [P2, P2][] {
  const [cut, gap, spacing] = ["cut", "gap", "spacing"].map((k) => num(v, k));
  const { zones } = stripOutline(b);
  const [bottom, top] = [gap, b.wall - gap];
  const step = cut + gap;
  const out: [P2, P2][] = [];
  for (const [z0, z1] of zones) {
    const n = Math.floor((z1 - z0) / spacing + 1e-9);
    for (let j = 0; j < n; j++) {
      const x = r6((z0 + z1) / 2 + (j - (n - 1) / 2) * spacing);
      const shift = j % 2 ? step / 2 : 0;
      for (let y = bottom - shift; y < top; y += step) {
        const [y0, y1] = [Math.max(bottom, y), Math.min(top, y + cut)];
        if (y1 - y0 >= Math.min(2, cut / 3)) out.push([[x, r6(y0)], [x, r6(y1)]]);
      }
    }
  }
  return out;
}

export const MAX_CUTS = 3000;

export function hingeBoxProblems(v: DesignValues): string[] {
  const b = hingeBox(v);
  const [cut, gap, spacing] = ["cut", "gap", "spacing"].map((k) => num(v, k));
  const { W, D, R, t, kerf } = b;
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (R < Math.max(2 * t, t + LID_ROOM + 3)) return [`Round the corners at least ${mm(Math.max(2 * t, t + LID_ROOM + 3))}, so the strip can bend.`];
  const least = 2 * R + 3 * (t + Math.max(0, kerf) + FINGER_MARGIN);
  if (Math.min(W, D) < least) return [`The sides are too short between the round corners for the fingers: make the box at least ${mm(Math.ceil(least))} each way, or round the corners less.`];
  if (b.nx < 3 || b.ny < 3) return ["The straight parts are too short for fingers: make the finger width smaller."];
  if (b.wall < 4 * t + 2 * gap) return ["The box is too low: make it taller."];
  if (cut > b.wall - 2 * gap) return [`The hinge cuts are longer than the wall allows: at most ${mm(b.wall - 2 * gap)}.`];
  if (b.corner < 3 * spacing) return ["The rows of hinge cuts are too far apart for these corners: bring them closer, or round the corners more."];
  if (!fitsBed(b.length + kerf, b.wall + kerf)) return [`The wall strip would be ${mm(b.length)} long: too long for the laser's 600 mm bed. Make the box smaller.`];
  if (!fitsBed(W, D)) return ["The bottom is too big for the laser's 600 × 300 mm bed."];
  if (hingeColumns(b, v).length > MAX_CUTS) return [`That's over ${MAX_CUTS} hinge cuts: space the rows further apart.`];
  return [];
}

const asEx = (p: P2[]): Pt[] => p.map(([x, y]) => [lit(x), lit(y)]);

/** A rectangle centred on the origin with its corners rounded (sketch fillets): fully defined. */
function roundedRectSketch(w: number, h: number, r: number, scope: Record<string, number>): SketchData {
  const s = outlineSketch(asEx(round6([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])), scope);
  return roundCorners(s, lit(r6(r)), scope);
}

/** The bottom's sketch: its outline kerf/2 bigger, the four inside corners rounded. */
function bottomSketch(b: HingeBox, scope: Record<string, number>): SketchData {
  const k = Math.max(0, b.kerf) / 2;
  let s = outlineSketch(grow(asEx(bottomOutline(b)), lit(k)), scope);
  setCurrentScope(scope);
  const cx = b.W / 2 - b.t + k;
  const cy = b.D / 2 - b.t + k;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = s.points.find((q) => Math.abs(q.x - sx * cx) < 1e-6 && Math.abs(q.y - sy * cy) < 1e-6);
    if (!p) throw new Error("Couldn't find the bottom's corner.");
    const r = filletCorner(s, p.id, String(r6(b.R - b.t + k)));
    if (r.error) throw new Error(`Couldn't round the bottom's corners: ${r.error}`);
    s = r.sketch;
  }
  return s;
}

export const hingeBoxDesign: LibraryDesign = {
  id: "hinge-box",
  name: "Living-hinge box",
  group: "Boxes and stands",
  description:
    "A box with round corners: its four walls are one long strip that bends round the corners on living hinges, finger-jointed into the bottom along the flat sides. The lid lifts off. Export for laser: the bottom and lid parts, and \"Sketch: Wall strip\" for the bending wall. 3 mm plywood or MDF bends best.",
  category: "laser",
  prefix: "hingebox",
  // The hinge's cuts are cut right through (blue), whatever another sketch was last exported with.
  laser: { "strip-sketch": { open: "cut" } },
  icon: '<rect x="6" y="14" width="36" height="26" rx="8"/><path d="M6 14h36" opacity=".5"/><path d="M9 22v4M11 25v4M9 30v4M37 22v4M39 25v4M37 30v4" /><rect x="5" y="9" width="38" height="5" rx="2.5" opacity=".7"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 120, min: 40, max: 280, help: "Outside." },
    { key: "depth", label: "Depth", kind: "length", default: 80, min: 40, max: 280, help: "Outside." },
    { key: "height", label: "Height", kind: "length", default: 60, min: 25, max: 280, help: "Outside, lid included." },
    { key: "radius", label: "Corner rounding", kind: "length", default: 20, min: 4, max: 100, help: "Outside. Bigger corners bend more gently." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 6, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 10, min: 3, max: 100, help: "Roughly — each straight side gets an odd number of equal fingers that fit exactly." },
    { key: "cut", label: "Hinge cut length", kind: "length", default: 15, min: 3, max: 200 },
    { key: "gap", label: "Gap between cuts", kind: "length", default: 3, min: 1, max: 20, help: "The uncut bits in each row; smaller bends more easily but is weaker." },
    { key: "spacing", label: "Row spacing", kind: "length", default: 1.5, min: 0.5, max: 10, help: "Between rows of cuts: about half the sheet's thickness is a good start." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: hingeBoxProblems,
  summary: (v) => {
    const b = hingeBox(v);
    return `4 pieces: the bottom, a wall strip ${mm(b.length)} long with ${hingeColumns(b, v).length} hinge cuts, and the lid's two plates.`;
  },
  make: (ctx) => {
    const b = hingeBox(ctx.values);
    const { W, D, R, t } = b;
    const k = Math.max(0, b.kerf) / 2;
    const T = lit(t);
    const ids = { bottom: ctx.id("bottom"), wall: ctx.id("wall"), lid: ctx.id("lid"), under: ctx.id("lid-under") };
    const ring = joinSketches(roundedRectSketch(W, D, R, ctx.scope), roundedRectSketch(W - 2 * t, D - 2 * t, R - t, ctx.scope));
    const strip = stripOutline(b);
    // The strip laid flat in front of the box: its top edge STRIP_GAP in front, centred.
    const place = ([s, y]: P2): P2 => [r6(s - b.length / 2), r6(y - b.wall - D / 2 - STRIP_GAP)];
    const stripSketch = addLines(
      outlineSketch(asEx(round6(offsetPolygon(strip.outline, k)).map(place)), ctx.scope),
      hingeColumns(b, ctx.values).map(([p, q]) => ({ points: [place(p), place(q)] })),
    );
    const under = W - 2 * t - 2 * LID_ROOM;
    const features: Feature[] = [
      sketchFeature(ctx.id("bottom-sketch"), "Bottom sketch", TOP, bottomSketch(b, ctx.scope)),
      extrudeFeature(ids.bottom, "Bottom", ctx.id("bottom-sketch"), { depth: T, operation: "new" }),
      sketchFeature(ctx.id("wall-sketch"), "Wall sketch", TOP, ring),
      extrudeFeature(ids.wall, "Wall (bent strip)", ctx.id("wall-sketch"), { depth: lit(r6(b.wall)), operation: "new" }),
      // The bottom's fingers cut out of the wall's foot — a plain Remove: only the wall just made.
      extrudeFeature(ctx.id("wall-fingers"), "Wall's finger slots", ctx.id("bottom-sketch"), { depth: T, operation: "remove" }),
      sketchFeature(ctx.id("lid-sketch"), "Lid sketch", TOP, roundedRectSketch(W + 2 * k, D + 2 * k, R + k, ctx.scope)),
      extrudeFeature(ids.lid, "Lid", ctx.id("lid-sketch"), { depth: T, operation: "new" }),
      moveFeature(ctx.id("lid-move"), "Lid on the box", ids.lid, { dz: lit(r6(b.wall)) }),
      sketchFeature(ctx.id("lid-under-sketch"), "Lid under-plate sketch", TOP, roundedRectSketch(under + 2 * k, D - 2 * t - 2 * LID_ROOM + 2 * k, R - t - LID_ROOM + k, ctx.scope)),
      extrudeFeature(ids.under, "Lid under-plate", ctx.id("lid-under-sketch"), { depth: T, operation: "new" }),
      moveFeature(ctx.id("lid-under-move"), "Lid under-plate in place", ids.under, { dz: lit(r6(b.wall - t)) }),
      sketchFeature(ctx.id("strip-sketch"), "Wall strip", TOP, stripSketch),
    ];
    return {
      features,
      partNames: { [ids.bottom]: `${ctx.name} bottom`, [ids.wall]: `${ctx.name} wall`, [ids.lid]: `${ctx.name} lid`, [ids.under]: `${ctx.name} lid under-plate` },
    };
  },
  preview: (v) => {
    if (hingeBoxProblems(v).length) return [];
    const b = hingeBox(v);
    const strip = stripOutline(b);
    const y0 = -b.D / 2 - 15 - b.wall;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: bottomOutline(b) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(b.W, b.D, b.R) },
      { kind: "text", at: [0, 0], text: "bottom" },
      { kind: "poly", closed: true, points: strip.outline.map(([s, y]) => [s - b.length / 2, y + y0] as P2) },
      ...hingeColumns(b, v).map(([p, q]): PreviewShape => ({ kind: "poly", points: [[p[0] - b.length / 2, p[1] + y0], [q[0] - b.length / 2, q[1] + y0]] })),
      { kind: "text", at: [0, y0 - 8], text: "wall strip" },
      { kind: "poly", closed: true, points: roundedRect(b.W, b.D, b.R, b.W + 15) },
      { kind: "text", at: [b.W + 15, 0], text: "lid" },
    ];
    return out;
  },
};

/** For tests: the area of a rounded rectangle and the pieces' true volumes (kerf 0, mm³). */
export function hingeBoxVolumes(v: DesignValues): { bottomAndWall: number; lid: number; foot: number } {
  const b = hingeBox(v);
  const rr = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r;
  const outside = rr(b.W, b.D, b.R);
  const inside = rr(b.W - 2 * b.t, b.D - 2 * b.t, b.R - b.t);
  const under = rr(b.W - 2 * b.t - 2 * LID_ROOM, b.D - 2 * b.t - 2 * LID_ROOM, b.R - b.t - LID_ROOM);
  // The bottom and the wall's foot fill the whole outline from z = 0 to t; above it, the ring.
  return { bottomAndWall: outside * b.t + (outside - inside) * (b.wall - b.t), lid: b.t * (outside + under), foot: outside * b.t };
}

