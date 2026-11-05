/**
 * A sunburst mirror frame, for a round craft mirror: a front cut as a sun — rays round a window a little smaller than the
 * mirror — then as many spacer rings as the mirror is thick (each with a hole just bigger than the mirror), then a back
 * disc. The mirror drops into the rings' hole and is held by the front's overlap. A keyhole in the back (a round opening
 * for a screw head with a narrow slot above it for the shank) has a pocket behind it through every ring, so the frame hangs
 * flat on a screw: in through the round part, then down onto the slot. The pocket is as deep as the rings (at least the
 * mirror's thickness), all hidden behind the sun.
 * and the rings (a pocket for a screw head or picture hook), hidden behind the front.
 *
 * All pieces are drawn on Top, centred on the origin, and stacked: back z = 0…t, rings t…(k + 1)t, front above them.
 * The front's outline: `rays` points round the centre at radius R (long) — every other one shorter when alternating —
 * with the corners between at radius rv = mirror/2 + band; the rings and back are circles rv − `RING_IN` across.
 */
import { lit } from "../ex";
import { drawnHole, holeSketch, plateSketch, type PlateHole } from "../boxPanels";
import { crossesItself, fitsBed, offsetPolygon, r6, type P2 } from "../outlines";
import { joinSketches } from "../laserKit";
import { extrudeFeature, moveFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { SketchData } from "../../sketch/types";
import type { DesignValues, LibraryDesign } from "../types";
import type { Feature } from "../../model/types";
import { mm, num } from "./common";

/** Room round the mirror in the rings' hole (each side, mm). */
export const MIRROR_ROOM = 0.5;
/** The rings and back are this much smaller (radius) than the sun's body, so they're hidden behind it. */
export const RING_IN = 2;
/**
 * The keyhole hanger: a round opening `head` across for the screw head, a slot `shank` wide rising `travel` above its
 * centre (to the centre of the slot's round top), and in the rings a pocket `pocket` wide over the same travel; `web` of
 * sheet round the pocket.
 */
export const HANG = { head: 8, shank: 4, travel: 7, pocket: 9, web: 3 };
/** How far the pocket reaches from the keyhole's centre, down and up (mm). */
const POCKET_DOWN = HANG.pocket / 2;
const POCKET_UP = HANG.travel + HANG.pocket / 2;

/** The keyhole's outline (true size) with the head's centre at c: the head's circle, the slot up from it, its round top. */
export function keyholeOutline(c: P2): P2[] {
  const [R, r] = [HANG.head / 2, HANG.shank / 2];
  const join = Math.acos(r / R); // where the slot's sides meet the head's circle, from +x
  const pts: P2[] = [];
  // Round the head from the slot's left side, down past the bottom, to its right side (anticlockwise).
  const a0 = Math.PI - join;
  const a1 = 2 * Math.PI + join;
  for (let i = 0; i <= 30; i++) {
    const a = a0 + ((a1 - a0) * i) / 30;
    pts.push([r6(c[0] + R * Math.cos(a)), r6(c[1] + R * Math.sin(a))]);
  }
  // Up the right side, round the top, down the left side (it closes back at the first point).
  const top = c[1] + HANG.travel;
  for (let i = 0; i <= 8; i++) {
    const a = (Math.PI * i) / 8;
    pts.push([r6(c[0] + r * Math.cos(a)), r6(top + r * Math.sin(a))]);
  }
  return pts;
}

/** The pocket behind the keyhole, in every ring: a slot over the head's whole travel. */
export const pocketSlot = (c: P2): PlateHole => ({ kind: "slot", a: c, b: [c[0], r6(c[1] + HANG.travel)], w: HANG.pocket });
/** The short rays reach this share of the way out from the body to the long rays' tips. */
export const SHORT_RAY = 0.6;
/** Rays sharper than this (degrees at the tip) char and snap. */
export const MIN_TIP = 15;

export interface Sunburst {
  mirror: number;
  t: number;
  kerf: number;
  /** The front's outline (true size) and its window. */
  sun: P2[];
  window: number;
  /** Radius of the corners between the rays. */
  body: number;
  /** The rings' and back's diameter, the rings' hole, how many rings. */
  disc: number;
  ringHole: number;
  rings: number;
  /** The keyhole's head centre (in the back; the pocket in the rings goes up from it). */
  hang: P2;
  /** The sharpest ray tip (degrees). */
  tip: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function sunburst(v: DesignValues): Sunburst {
  const [mirror, mt, overlap, n, size, band, t, kerf] = ["mirror", "mirrorThickness", "overlap", "rays", "size", "band", "thickness", "kerf"].map((k) => num(v, k));
  const alternate = v.alternate !== false;
  const R = size / 2;
  const body = mirror / 2 + band;
  const sun: P2[] = [];
  for (let k = 0; k < n; k++) {
    const a = rad(90 + (360 * k) / n);
    const r = alternate && k % 2 === 1 ? body + SHORT_RAY * (R - body) : R;
    const b = a + rad(180 / n);
    sun.push([r6(r * Math.cos(a)), r6(r * Math.sin(a))], [r6(body * Math.cos(b)), r6(body * Math.sin(b))]);
  }
  // The sharpest tip: the angle between a tip's two sides.
  let tip = 180;
  for (let i = 0; i < sun.length; i += 2) {
    const [p, q, s] = [sun[(i + sun.length - 1) % sun.length], sun[i], sun[i + 1]];
    const u = [p[0] - q[0], p[1] - q[1]];
    const w = [s[0] - q[0], s[1] - q[1]];
    tip = Math.min(tip, (Math.acos((u[0] * w[0] + u[1] * w[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]))) * 180) / Math.PI);
  }
  const disc = r6(2 * (body - RING_IN));
  const ringHole = r6(mirror + 2 * MIRROR_ROOM);
  const rings = Math.max(1, Math.ceil(mt / t - 1e-9));
  // The pocket centred in the band of ring between the mirror's hole and the ring's edge.
  const hangR = (ringHole / 2 + disc / 2) / 2 - (POCKET_UP - POCKET_DOWN) / 2;
  return { mirror, t, kerf, sun, window: r6(mirror - 2 * overlap), body, disc, ringHole, rings, hang: [0, r6(hangR)], tip };
}

export function sunburstProblems(v: DesignValues): string[] {
  const s = sunburst(v);
  const [overlap, n, size] = ["overlap", "rays", "size"].map((k) => num(v, k));
  if (s.kerf >= s.t / 2) return [`A kerf allowance of ${mm(s.kerf)} is a lot for ${mm(s.t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (v.alternate !== false && n % 2 === 1) return ["Use an even number of rays to alternate long and short ones."];
  if (s.window < 20 || overlap < 2) return ["The front must overlap the mirror by at least 2 mm, and leave a window at least 20 mm across."];
  if (size / 2 < s.body + 10) return [`The frame is too small for the rays: make it at least ${mm(Math.ceil(2 * (s.body + 10)))} across, or the band narrower.`];
  if ((s.disc - s.ringHole) / 2 < POCKET_DOWN + POCKET_UP + 2 * HANG.web) return [`Make the band wider: the rings need room for the keyhole's pocket (at least ${mm(POCKET_DOWN + POCKET_UP + 2 * HANG.web + RING_IN + MIRROR_ROOM)}).`];
  if (s.tip < MIN_TIP) return [`The rays are too sharp (${Math.round(s.tip)}° at the tip): use fewer rays, or make them shorter.`];
  if (crossesItself(s.sun)) return ["The rays cross each other: use fewer."];
  if (!fitsBed(size, size)) return ["The frame is too big for the laser's 600 × 300 mm bed: at most 290 mm across."];
  return [];
}

export const sunburstMirrorDesign: LibraryDesign = {
  id: "sunburst-mirror",
  name: "Sunburst mirror frame",
  group: "Home",
  description:
    "A sunburst frame for a round craft mirror: a sun of long and short rays round a window a little smaller than the mirror, spacer rings as thick as the mirror, and a back with a keyhole hanger, its pocket hidden behind the sun. Drop the mirror in, glue the layers together, and hang it on a screw: in through the round part of the keyhole, then down.",
  category: "laser",
  prefix: "sunburst",
  icon: '<circle cx="24" cy="24" r="9"/><path d="M24 4v8M24 36v8M4 24h8M36 24h8M10 10l6 6M32 32l6 6M38 10l-6 6M16 32l-6 6"/>',
  inputs: [
    { key: "mirror", label: "Mirror diameter", kind: "length", default: 150, min: 50, max: 240, help: "Round craft mirrors are often 100, 150 or 200 mm." },
    { key: "mirrorThickness", label: "Mirror thickness", kind: "length", default: 3, min: 1, max: 10, help: "The spacer rings add up to at least this." },
    { key: "overlap", label: "Overlap", kind: "length", default: 5, min: 2, max: 30, help: "How far the front covers the mirror's edge." },
    { key: "size", label: "Frame size", kind: "length", default: 280, min: 80, max: 290, help: "Across the long rays' tips." },
    { key: "rays", label: "Rays", kind: "count", default: 16, min: 6, max: 60 },
    { key: "alternate", label: "Long and short rays", kind: "toggle", default: true, help: "Every other ray shorter. Off: all the same." },
    { key: "band", label: "Band width", kind: "length", default: 26, min: 10, max: 80, help: "The plain ring round the mirror, before the rays start." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger and holes this much smaller." },
  ],
  problems: sunburstProblems,
  summary: (v) => {
    const s = sunburst(v);
    return `${s.rings + 2} pieces: the sun front (${mm(s.window)} window), ${s.rings} spacer ring${s.rings === 1 ? "" : "s"} and the back; ${mm(num(v, "size"))} across.`;
  },
  make: (ctx) => {
    const s = sunburst(ctx.values);
    const k = Math.max(0, s.kerf);
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const circle = (d: number, c: P2 = [0, 0]): PlateHole => ({ kind: "circle", c, d: r6(d) });
    const key = drawnHole({ kind: "poly", points: keyholeOutline(s.hang) }, k);
    const pocket = drawnHole(pocketSlot(s.hang), k);
    // The back and rings are true circles (not many-sided outlines), so they cut smoothly.
    const piece = (role: string, label: string, outline: P2[] | null, holes: PlateHole[], dz: number) => {
      const sk = ctx.id(`${role}-sketch`);
      const data = outline ? plateSketch(outline, holes, ctx.scope) : discSketch(s.disc + k, holes, ctx.scope);
      features.push(sketchFeature(sk, `${label} sketch`, { kind: "default", name: "Top" }, data), extrudeFeature(ctx.id(role), label, sk, { depth: lit(s.t), operation: "new" }));
      if (dz) features.push(moveFeature(ctx.id(`${role}-move`), `${label} in place`, ctx.id(role), { dz: lit(r6(dz)) }));
      partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`;
    };
    piece("back", "Back", null, [key], 0);
    for (let i = 0; i < s.rings; i++) piece(i ? `ring-${i + 1}` : "ring", s.rings > 1 ? `Spacer ring ${i + 1}` : "Spacer ring", null, [circle(s.ringHole - k), pocket], s.t * (i + 1));
    piece("front", "Sun front", offsetPolygon(s.sun, k / 2, 1.2), [circle(s.window - k)], s.t * (s.rings + 1));
    return { features, partNames };
  },
  preview: (v) => {
    if (sunburstProblems(v).length) return [];
    const s = sunburst(v);
    return [
      { kind: "poly", closed: true, points: s.sun },
      { kind: "circle", c: [0, 0], r: s.window / 2 },
      { kind: "circle", c: [0, 0], r: s.mirror / 2, faint: true },
      { kind: "circle", c: [0, 0], r: s.disc / 2, faint: true },
    ];
  },
};

/** A round plate (a circle `d` across, centred) with holes. */
function discSketch(d: number, holes: PlateHole[], scope: Record<string, number>): SketchData {
  return joinSketches(shapesSketch([{ type: "circle", center: [0, 0], diameter: r6(d) }], scope), ...holes.map((h) => holeSketch(h, scope)));
}
