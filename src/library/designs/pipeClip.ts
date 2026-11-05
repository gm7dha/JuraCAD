/**
 * A wall-mounted saddle clip for a pipe, hose, cable bundle or broom handle: a C-shaped ring standing on a base plate
 * that screws to the wall, its mouth narrower than the pipe so it snaps on and holds. Drawn on Top (x along the wall,
 * y out from it; the wall is at y = −base) and made `width` up from the bed, so it prints on its side: every face is
 * upright, and the ring bends within its layers (strong). The screws go through tabs either side, drilled from the
 * plate's front face (the Front plane, y = 0) back towards the wall, so the countersinks face the room.
 *
 * The snap: each lip must move out by (pipe − mouth) / 2 to let the pipe through. The ring's back is fixed to the
 * plate, so each side is a curved cantilever from the plate round to its lip; pushed sideways at the lip, its
 * bending moment at angle φ round the ring is P × (height of the lip − height at φ) — from where the ring leaves the
 * plate (its outside meets the plate's face there, `fixed`) round to the lip — so the lip moves
 * δ = P/(EI) ∫ (z_lip − z)² ds and the most stretched fibre (at the plate) strains δ × (wall / 2) × (z_lip − z_plate)
 * / ∫ (z_lip − z)² ds — kept at most 2% (`SNAP_STRAIN`).
 */
import { lit } from "../ex";
import { countersunkHoleFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { circleBand, circleSegment, countersunkHoleVolume, mm, num, roundedRect } from "./common";
import { CLEAT_SCREW } from "./frenchCleat";
import { circleShape, rectShape, SNAP_STRAIN } from "./printShapes";

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
/** 4 mm countersunk wood screws, as the other wall-mounted designs use. */
export const CLIP_SCREW = CLEAT_SCREW;

/** The bending strain of a ring's side (mean radius R, wall h) fixed at angle `from` (0 = the back), pushed out by δ at angle `to`. */
export function arcStrain(R: number, h: number, from: number, to: number, delta: number): number {
  const z = (phi: number) => -R * Math.cos(phi);
  const zt = z(to);
  const n = 2000;
  let I = 0;
  for (let i = 0; i < n; i++) {
    const phi = from + ((i + 0.5) / n) * (to - from);
    I += (zt - z(phi)) ** 2 * R * ((to - from) / n);
  }
  return (delta * (h / 2) * (zt - z(from))) / I;
}

export function pipeClipPlan(v: DesignValues) {
  const pipe = num(v, "pipe");
  const wall = num(v, "wall");
  const room = num(v, "room");
  const grip = Math.round(num(v, "grip"));
  const width = num(v, "width");
  const base = num(v, "base");
  const inner = pipe / 2 + room;
  const outer = inner + wall;
  /** The ring's middle: half its wall sinks into the plate, so the pipe sits half a wall off the plate. */
  const centre = inner + wall / 2;
  const opening = Math.round(pipe * (1 - grip / 100) * 100) / 100;
  const mean = inner + wall / 2;
  const tip = Math.PI - Math.asin(Math.min(1, opening / 2 / mean));
  // The ring is held where it joins the plate: its outside meets the plate's face (y = 0) this far round from the back.
  const fixed = Math.acos(Math.min(1, centre / outer));
  const spread = (pipe - opening) / 2;
  const strain = arcStrain(mean, wall, fixed, tip, spread);
  const holeX = outer + CLIP_SCREW.head / 2 + 1;
  const plate = 2 * (holeX + CLIP_SCREW.head / 2 + 2);
  return { pipe, wall, room, grip, width, base, inner, outer, centre, fixed, opening, spread, strain, holeX, plate, screws: v.screws !== false };
}

export const pipeClip: LibraryDesign = {
  id: "pipe-clip",
  name: "Pipe / hose clip",
  description:
    "A clip that screws to the wall and snaps round a pipe, hose, cable bundle or broom handle: its mouth is a little narrower than the pipe, so it springs open as you push the pipe in and then holds it. Two countersunk holes for 4 mm screws on tabs either side. It prints lying on its side, so it's strong where it bends, no supports.",
  category: "print",
  group: "Fixings",
  prefix: "pipeclip",
  icon: '<rect x="4" y="38" width="40" height="5" rx="1"/><path d="M15 38a12 12 0 1 1 18 0h-4a8.5 8.5 0 1 0-10 0z"/><circle cx="8" cy="40.5" r="1.3" opacity=".6"/><circle cx="40" cy="40.5" r="1.3" opacity=".6"/>',
  inputs: [
    { key: "pipe", label: "Pipe diameter", kind: "length", default: 22, min: 6, max: 60, help: "Measure across the pipe: copper water pipe is 15 or 22 mm, a garden hose about 19 mm outside." },
    { key: "grip", label: "Grip (%)", kind: "count", default: 18, min: 8, max: 35, help: "How much narrower the mouth is than the pipe. More holds tighter but is harder to push on; small pipes need less (18% suits 15 mm and up — the app tells you if it's too much)." },
    { key: "wall", label: "Ring thickness", kind: "length", default: 2.4, min: 1.6, max: 5 },
    { key: "width", label: "Clip width", kind: "length", default: 14, min: 10, max: 40, help: "Along the pipe." },
    { key: "base", label: "Base thickness", kind: "length", default: 4, min: 3.5, max: 8, help: "Thick enough for the screws' countersinks." },
    { key: "room", label: "Room round the pipe", kind: "length", default: 0.2, min: 0, max: 1, help: "Between the pipe and the ring, all round." },
    { key: "screws", label: "Screw holes", kind: "toggle", default: true },
  ],
  problems: (v) => {
    const p = pipeClipPlan(v);
    const out: string[] = [];
    if (p.strain > SNAP_STRAIN) out.push(`The ring would have to stretch ${Math.round(p.strain * 1000) / 10}% to snap over the pipe and might crack: use less grip, or a thinner ring.`);
    if (p.spread < 0.5) out.push("The mouth is too nearly as wide as the pipe to hold it: use more grip.");
    if (p.width < CLIP_SCREW.head + 2) out.push(`Make the clip at least ${mm(CLIP_SCREW.head + 2)} wide for the screw heads.`);
    return out;
  },
  summary: (v) => {
    const p = pipeClipPlan(v);
    return `1 part, ${mm(p.plate)} long: the mouth is ${mm(p.opening)} across a ${mm(p.pipe)} pipe, so each side springs ${mm(p.spread)} (stretching ${Math.round(p.strain * 1000) / 10}%, safe up to 2%).`;
  },
  make: (ctx) => {
    const p = pipeClipPlan(ctx.values);
    const id = ctx.id("clip");
    const through = lit(2 * p.width + 2);
    const features: Feature[] = [
      sketchFeature(ctx.id("base-sketch"), "Base sketch", TOP, shapesSketch([rectShape(-p.plate / 2, -p.base, p.plate, p.base)], ctx.scope)),
      extrudeFeature(id, "Base", ctx.id("base-sketch"), { depth: lit(p.width), operation: "new" }),
      sketchFeature(ctx.id("ring-sketch"), "Ring sketch", TOP, shapesSketch([circleShape(0, p.centre, 2 * p.outer)], ctx.scope)),
      extrudeFeature(ctx.id("ring"), "Ring", ctx.id("ring-sketch"), { depth: lit(p.width), operation: "add" }),
      sketchFeature(ctx.id("inside-sketch"), "Inside sketch", TOP, shapesSketch([circleShape(0, p.centre, 2 * p.inner)], ctx.scope)),
      extrudeFeature(ctx.id("inside"), "Inside", ctx.id("inside-sketch"), { depth: through, end: "symmetric", operation: "remove" }),
      sketchFeature(ctx.id("mouth-sketch"), "Mouth sketch", TOP, shapesSketch([rectShape(-p.opening / 2, p.centre, p.opening, p.outer + 1)], ctx.scope)),
      extrudeFeature(ctx.id("mouth"), "Mouth", ctx.id("mouth-sketch"), { depth: through, end: "symmetric", operation: "remove" }),
    ];
    if (p.screws) {
      const drill = countersunkHoleFeature(ctx.id("screws"), "Screw holes", ctx.id("screws-sketch"), lit(CLIP_SCREW.d), lit(CLIP_SCREW.head));
      features.push(
        sketchFeature(ctx.id("screws-sketch"), "Screw holes sketch", FRONT, shapesSketch([-1, 1].map((s) => circleShape(s * p.holeX, p.width / 2, CLIP_SCREW.d)), ctx.scope)),
        // From the plate's front face back towards the wall (the Front plane faces the wall, so flipped).
        { ...drill, hole: { ...drill.hole!, flip: true } },
      );
    }
    return { features, partNames: { [id]: `${ctx.name} ${mm(p.pipe)}` } };
  },
  preview: (v) => {
    const p = pipeClipPlan(v);
    const arc = (R: number): [number, number][] => {
      const a0 = Math.asin(Math.min(1, p.opening / 2 / R));
      return Array.from({ length: 41 }, (_, i): [number, number] => {
        const t = Math.PI / 2 + a0 + ((2 * Math.PI - 2 * a0) * i) / 40;
        return [R * Math.cos(t), p.centre + R * Math.sin(t)];
      });
    };
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: roundedRect(p.plate, p.base, 0, 0, -p.base / 2) },
      { kind: "poly", closed: true, points: [...arc(p.outer), ...arc(p.inner).reverse()] },
      { kind: "circle", c: [0, p.centre], r: p.pipe / 2, faint: true },
      { kind: "text", at: [0, -p.base - 6], text: "seen end on; the wall is at the bottom" },
    ];
    return out;
  },
};

/** For tests: the clip's volume (mm³). */
export function pipeClipVolume(v: DesignValues): number {
  const p = pipeClipPlan(v);
  const ring = Math.PI * p.outer ** 2 - circleSegment(p.outer, p.centre) - Math.PI * p.inner ** 2 - (circleBand(p.outer, p.opening / 2) - circleBand(p.inner, p.opening / 2));
  const holes = p.screws ? 2 * countersunkHoleVolume(CLIP_SCREW.d, CLIP_SCREW.head, p.base) : 0;
  return (p.plate * p.base + ring) * p.width - holes;
}
