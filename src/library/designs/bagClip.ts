/**
 * A two-part bag clip: a rod and a C-shaped channel that snaps over it. Fold the bag's top over the rod and push the
 * channel on: its opening is narrower than the rod, so it springs open to pass and then holds the rod — and the bag
 * round it — all along its length. Both are drawn on the Right plane (across = world Y, up = world Z) and made
 * `length` long along X, so they print lying down with their flat sides on the bed:
 *
 *  - the rod is a circle with its bottom cut flat where the curve reaches 45° (`FLAT_AT`), so it overhangs about 45° — a
 *    little more (up to ~52°) only right at the bottom edge, where the arc meets the flat, which prints fine;
 *  - the channel's inside is the rod's shape grown by `room` (space for the folded bag), on a floor `wall` thick, with a
 *    slot cut through the top; its outside is the same shape grown again by `wall`. The inside below the slot leans at
 *    most 45°, so the channel prints opening upwards with no supports.
 */
import { lit, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { circleSegment, mm, num } from "./common";

/** Where the rod's flat is, below its middle, as a share of its radius (cos 45°). */
export const FLAT_AT = Math.SQRT1_2;
/** Room between the rod and the channel on the bed (mm). */
export const CLIP_GAP = 8;
/** The most the channel's plastic may stretch as it springs over the rod (PLA yields at ~3%). */
export const MAX_STRAIN = 0.02;

const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** The clip's sizes (mm): the rod's radius, the channel's inside and outside radii, the middle's height, the opening. */
export function clipSizes(v: DesignValues) {
  const r = num(v, "rod") / 2;
  const room = num(v, "room");
  const wall = num(v, "wall");
  const opening = num(v, "opening");
  const inner = r + room;
  const outer = inner + wall;
  /** The channel's (and the seated rod's) middle, above the bed. */
  const middle = wall + room + FLAT_AT * r;
  /** How far the rod's widest part must push each lip aside to pass, and roughly how much that stretches the plastic. */
  const spread = 2 * r - opening;
  const meanR = inner + wall / 2;
  // A split ring opened by `spread` at its gap (Roark): the bending strain at the back is spread × wall / (3π R²).
  const strain = (spread * wall) / (3 * Math.PI * meanR * meanR);
  return { r, room, wall, opening, inner, outer, middle, spread, strain, length: num(v, "length") };
}

/** A circle of radius R round (cy, cz), cut flat `below` under its middle: an arc from −45°-ish round over the top, and the flat. */
function flatCircle(cy: number, cz: number, R: number, below: number): unknown[] {
  const a = (Math.asin(below / R) * 180) / Math.PI;
  const x = Math.sqrt(R * R - below * below);
  return [
    { type: "arc", center: [String(six(cy)), String(six(cz))], radius: String(six(R)), start_angle: String(six(-a)), end_angle: String(six(180 + a)) },
    { type: "line", from: [String(six(cy - x)), String(six(cz - below))], to: [String(six(cy + x)), String(six(cz - below))] },
  ];
}

export const bagClip: LibraryDesign = {
  id: "bag-clip",
  name: "Bag clip",
  description:
    "Keeps crisps, coffee and frozen peas fresh: fold the top of the bag over the rod, then slide the C-shaped clip on from one end (or snap it on over the rod). The clip's opening is narrower than the rod, so it snaps on and grips the bag all the way along. Both parts print lying flat, no supports. PLA or PETG; if it's too stiff to push on, make the opening a little wider.",
  category: "print",
  group: "Household",
  prefix: "clip",
  icon: '<rect x="4" y="30" width="40" height="7" rx="3.5" opacity=".6"/><path d="M4 12a7 7 0 0 1 7-7h26a7 7 0 0 1 7 7v4h-6v-3H10v3H4z"/>',
  inputs: [
    { key: "length", label: "Length", kind: "length", default: 110, min: 30, max: 250, help: "Wider than the bag is across." },
    { key: "rod", label: "Rod thickness", kind: "length", default: 10, min: 5, max: 25 },
    { key: "wall", label: "Clip wall", kind: "length", default: 1.6, min: 0.8, max: 4, help: "Thinner springs more easily; 1.6 mm is four lines with a 0.4 mm nozzle." },
    { key: "opening", label: "Opening", kind: "length", default: 7, min: 2, max: 24, help: "Across the clip's mouth: narrower than the rod, so it holds." },
    { key: "room", label: "Room for the bag", kind: "length", default: 0.25, min: 0.1, max: 1, help: "Between the rod and the clip: thin bags 0.2 mm, thick ones more." },
  ],
  problems: (v) => {
    const s = clipSizes(v);
    const out: string[] = [];
    if (s.opening >= 2 * s.r - 1) out.push(`The opening must be at least 1 mm narrower than the rod (less than ${mm(2 * s.r - 1)}), or the clip won't hold.`);
    if (s.opening < s.r) out.push(`The opening must be at least half as wide as the rod (${mm(s.r)}), or the clip can't spring over it.`);
    if (s.strain > MAX_STRAIN) out.push(`The clip would have to stretch too far to snap over the rod and might crack: make the opening wider (at least ${mm(2 * s.r - (MAX_STRAIN * 3 * Math.PI * (s.inner + s.wall / 2) ** 2) / s.wall)}) or the wall thinner.`);
    return out;
  },
  summary: (v) => {
    const s = clipSizes(v);
    return `2 parts, ${mm(s.length)} long. The clip's mouth is ${mm(s.opening)} across a ${mm(2 * s.r)} rod, so each lip overlaps it by ${mm((2 * s.r - s.opening) / 2)}.`;
  },
  make: (ctx) => {
    const s = clipSizes(ctx.values);
    const right = { kind: "default", name: "Right" } as const;
    const clip = ctx.id("clip");
    const rod = ctx.id("rod");
    const length: Ex = lit(s.length);
    const rodAt = -(s.outer + CLIP_GAP + s.r);
    const features: Feature[] = [
      sketchFeature(ctx.id("clip-sketch"), "Clip outside", right, shapesSketch(flatCircle(0, s.middle, s.outer, s.middle), ctx.scope)),
      extrudeFeature(clip, "Clip", ctx.id("clip-sketch"), { depth: length, operation: "new" }),
      sketchFeature(ctx.id("inside-sketch"), "Clip inside", right, shapesSketch(flatCircle(0, s.middle, s.inner, s.middle - s.wall), ctx.scope)),
      // The cuts go right through, past both ends of the clip.
      extrudeFeature(ctx.id("inside"), "Clip inside", ctx.id("inside-sketch"), { depth: lit(2 * s.length + 2), end: "symmetric", operation: "remove" }),
      sketchFeature(
        ctx.id("mouth-sketch"),
        "Mouth sketch",
        right,
        shapesSketch([{ type: "rectangle", corner: [String(six(-s.opening / 2)), String(six(s.middle))], width: String(six(s.opening)), height: String(six(s.outer + 1)) }], ctx.scope),
      ),
      extrudeFeature(ctx.id("mouth"), "Mouth", ctx.id("mouth-sketch"), { depth: lit(2 * s.length + 2), end: "symmetric", operation: "remove" }),
      sketchFeature(ctx.id("rod-sketch"), "Rod sketch", right, shapesSketch(flatCircle(rodAt, FLAT_AT * s.r, s.r, FLAT_AT * s.r), ctx.scope)),
      extrudeFeature(rod, "Rod", ctx.id("rod-sketch"), { depth: length, operation: "new" }),
    ];
    return { features, partNames: { [clip]: `${ctx.name}: clip`, [rod]: `${ctx.name}: rod` } };
  },
  preview: (v) => {
    const s = clipSizes(v);
    const arc = (cy: number, cz: number, R: number, below: number): [number, number][] => {
      const a = Math.asin(below / R);
      return Array.from({ length: 41 }, (_, i): [number, number] => {
        const t = -a + ((Math.PI + 2 * a) * i) / 40;
        return [cy + R * Math.cos(t), cz + R * Math.sin(t)];
      });
    };
    return [
      { kind: "poly", closed: true, points: arc(0, s.middle, s.outer, s.middle) },
      { kind: "poly", closed: true, points: arc(0, s.middle, s.inner, s.middle - s.wall), faint: true },
      { kind: "poly", closed: true, points: arc(-(s.outer + CLIP_GAP + s.r), FLAT_AT * s.r, s.r, FLAT_AT * s.r) },
      { kind: "poly", points: [[-s.opening / 2, s.middle + s.outer], [s.opening / 2, s.middle + s.outer]] },
      { kind: "text", at: [0, -5], text: "clip and rod, seen end on" },
    ] as PreviewShape[];
  },
};

/** For tests: the clip's and rod's volumes (mm³). */
export function clipVolumes(v: DesignValues): { clip: number; rod: number } {
  const s = clipSizes(v);
  // A circle cut flat `below` its middle keeps all but the segment past the flat.
  const flat = (R: number, below: number) => Math.PI * R * R - circleSegment(R, below);
  const inside = flat(s.inner, s.middle - s.wall);
  // The mouth: the strip |y| < opening/2 above the middle, between the inside's and the outside's arcs (a band of half a circle).
  const strip = (R: number) => {
    const h = s.opening / 2;
    return h * Math.sqrt(R * R - h * h) + R * R * Math.asin(h / R);
  };
  const mouth = strip(s.outer) - strip(s.inner);
  return { clip: (flat(s.outer, s.middle) - inside - mouth) * s.length, rod: flat(s.r, FLAT_AT * s.r) * s.length };
}
