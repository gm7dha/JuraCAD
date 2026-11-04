/**
 * Flat-pack things made of two side panels and pieces running between them (a dice tower's walls and ramps, a spice
 * rack's shelves, a card holder's base and back), held by tabs through slots in the sides. Pure maths, plus the
 * features that build them.
 *
 * Seen side-on (the sides' plane: x along, z up), each piece between the sides is a thin rectangle — its cross-section
 * — `t` thick, `length` long, centred on `centre` and turned `angle` degrees from +x towards +z. Across (y) it is the
 * inside width `width` wide, with tabs on both ends reaching through the sides (t further, flush with their outsides)
 * over the stretches of its length given by `tabs`. Each side has a slot exactly where each tab goes through it.
 *
 * Kerf: a laser burns away a thin line, so every piece is drawn kerf/2 bigger all round and every slot kerf/2 smaller;
 * after cutting they're all their true size and the tabs fit snugly.
 *
 * In 3D: the sides are drawn on the Front plane where they stand and moved out to y = ±width/2; each piece is drawn flat
 * on the Top plane (its length along x, centred), extruded t, turned about Y to its angle and moved into place. Every
 * piece is its own New extrude, so a user's parts in the same Part Studio are never touched.
 */
import { lit } from "./ex";
import { copyFeature, extrudeFeature, moveFeature, outlineSketch, sketchFeature } from "./sketchKit";
import { joinSketches } from "./laserKit";
import { boxOf, fitsBed, offsetPolygon, insideGap, insidePolygon, outlineGap, r6, round6, tidyPolygon, type P2 } from "./outlines";
import type { MakeContext } from "./types";
import type { Feature } from "../model/types";
import type { SketchData } from "../sketch/types";

export interface CrossPiece {
  role: string;
  label: string;
  /** Middle of its cross-section (x, z). */
  centre: P2;
  /** Degrees from +x towards +z (0 = level, 90 = upright). */
  angle: number;
  length: number;
  /** Stretches of its length (from one end, 0…length) that have tabs. */
  tabs: [number, number][];
}

export interface SideAssembly {
  /** The side panel's outline (x, z). */
  side: P2[];
  pieces: CrossPiece[];
  /** Inside width, between the sides (y). */
  width: number;
  t: number;
  kerf: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Along the piece's length, and square to it (its top side). */
export const along = (p: CrossPiece): P2 => [Math.cos(rad(p.angle)), Math.sin(rad(p.angle))];
export const across = (p: CrossPiece): P2 => [-Math.sin(rad(p.angle)), Math.cos(rad(p.angle))];

/** A stretch [a, b] of the piece's length (from its end), `half` either side of its middle line, as 4 corners (x, z). */
function strip(p: CrossPiece, a: number, b: number, half: number): P2[] {
  const [d, n] = [along(p), across(p)];
  const at = (u: number, v: number): P2 => [p.centre[0] + (u - p.length / 2) * d[0] + v * n[0], p.centre[1] + (u - p.length / 2) * d[1] + v * n[1]];
  return round6([at(a, -half), at(b, -half), at(b, half), at(a, half)]);
}

/** The piece's whole cross-section (x, z), anticlockwise. */
export const sectionOf = (p: CrossPiece, t: number) => strip(p, 0, p.length, t / 2);

/** The slots in a side: one per tab, kerf/2 smaller all round. */
export function sideSlots(a: SideAssembly): P2[][] {
  const k = Math.max(0, a.kerf) / 2;
  return a.pieces.flatMap((p) => p.tabs.map(([u0, u1]) => strip(p, u0 + k, u1 - k, a.t / 2 - k)));
}

/** The side's outline as drawn (kerf/2 bigger all round). */
export function sideOutline(a: SideAssembly): P2[] {
  return round6(offsetPolygon(a.side, Math.max(0, a.kerf) / 2));
}

/**
 * A piece laid flat (its own x along its length, y across, centred on the origin), as drawn: the body length × width
 * with the tabs out t at both ends, kerf/2 bigger all round. Anticlockwise.
 */
export function pieceFlat(p: CrossPiece, a: SideAssembly): P2[] {
  const k = Math.max(0, a.kerf) / 2;
  const [L, B, t] = [p.length, a.width, a.t];
  const tabs = [...p.tabs].sort((x, y) => x[0] - y[0]);
  const pts: P2[] = [];
  const u = (v: number) => v - L / 2;
  // Bottom side (y = −B/2), left to right, the tabs reaching down to −B/2 − t.
  pts.push([u(0) - k, -B / 2 - k]);
  for (const [a0, a1] of tabs) pts.push([u(a0) - k, -B / 2 - k], [u(a0) - k, -B / 2 - t - k], [u(a1) + k, -B / 2 - t - k], [u(a1) + k, -B / 2 - k]);
  pts.push([u(L) + k, -B / 2 - k], [u(L) + k, B / 2 + k]);
  for (const [a0, a1] of [...tabs].reverse()) pts.push([u(a1) + k, B / 2 + k], [u(a1) + k, B / 2 + t + k], [u(a0) - k, B / 2 + t + k], [u(a0) - k, B / 2 + k]);
  pts.push([u(0) - k, B / 2 + k]);
  return round6(pts);
}

/** Tabs spread along a length: `n` of them (default about one per 50 mm, 1–4), each as long as the gaps between. */
export function evenTabs(length: number, n = Math.max(1, Math.min(4, Math.floor(length / 50)))): [number, number][] {
  const part = length / (2 * n + 1);
  return Array.from({ length: n }, (_, i): [number, number] => [r6((2 * i + 1) * part), r6((2 * i + 2) * part)]);
}

/** Solid sheet to leave between a slot and the side's edge, or between two slots (mm). */
export const WEB = 2;

/** Do two cross-sections overlap (more than touching)? Convex outlines: no line separates them. */
export function sectionsOverlap(a: P2[], b: P2[], eps = 1e-6): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const [p, q] = [poly[i], poly[(i + 1) % poly.length]];
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      const l = Math.hypot(nx, ny);
      const proj = (s: P2[]) => s.map(([x, y]) => (x * nx + y * ny) / l);
      const [pa, pb] = [proj(a), proj(b)];
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false;
    }
  return true;
}

/** Plain-English problems: slots too near each other or the edge, pieces in each other's way, pieces too big to cut. */
export function assemblyProblems(a: SideAssembly, names: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const nameOf = (p: CrossPiece) => names[p.role] ?? p.label.toLowerCase();
  const slots = a.pieces.flatMap((p) => p.tabs.map((tab) => ({ p, slot: strip(p, tab[0], tab[1], a.t / 2) })));
  for (const { p, slot } of slots) {
    if (!slot.every((q) => insidePolygon(q, a.side)) || insideGap(slot, a.side) < WEB) {
      out.push(`The ${nameOf(p)} reaches too near the edge of the sides.`);
      break;
    }
  }
  for (let i = 0; i < slots.length && !out.length; i++)
    for (let j = i + 1; j < slots.length; j++)
      if (outlineGap(slots[i].slot, slots[j].slot, WEB) < WEB) {
        out.push(`The ${nameOf(slots[i].p)} and the ${nameOf(slots[j].p)} are too close together.`);
        break;
      }
  for (let i = 0; i < a.pieces.length && !out.length; i++)
    for (let j = i + 1; j < a.pieces.length; j++)
      if (sectionsOverlap(sectionOf(a.pieces[i], a.t), sectionOf(a.pieces[j], a.t))) {
        out.push(`The ${nameOf(a.pieces[i])} and the ${nameOf(a.pieces[j])} would be in each other's way.`);
        break;
      }
  const sb = boxOf(a.side);
  if (!fitsBed(sb[2] - sb[0], sb[3] - sb[1])) out.push("The sides are too big for the laser's 600 × 300 mm bed.");
  for (const p of a.pieces)
    if (!fitsBed(p.length, a.width + 2 * a.t)) {
      out.push(`The ${nameOf(p)} is too big for the laser's 600 × 300 mm bed.`);
      break;
    }
  return out;
}

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;

const sketchOf = (outline: P2[], holes: P2[][], scope: Record<string, number>): SketchData =>
  joinSketches(...[outline, ...holes].map((h) => outlineSketch(tidyPolygon(h).map(([x, y]) => [lit(x), lit(y)]), scope)));

/**
 * The features: both sides (the right one made, then copied across) and each piece, laid flat, turned and moved into
 * place. Part names `<insert> <name>` by role (sides "side-right", "side-left").
 */
export function assemblyFeatures(ctx: MakeContext, a: SideAssembly, thickness = lit(a.t)): { features: Feature[]; partNames: Record<string, string> } {
  const features: Feature[] = [];
  const partNames: Record<string, string> = {};
  const side = ctx.id("side-right");
  features.push(
    sketchFeature(ctx.id("side-sketch"), "Side sketch", FRONT, sketchOf(sideOutline(a), sideSlots(a), ctx.scope)),
    // The Front plane faces −Y: flipped, the side goes towards +Y, then out to the inside width's edge.
    extrudeFeature(side, "Right side", ctx.id("side-sketch"), { depth: thickness, operation: "new", flip: true }),
    moveFeature(ctx.id("side-right-move"), "Right side in place", side, { dy: lit(r6(a.width / 2)) }),
    copyFeature(ctx.id("side-left"), "Left side", side, { dy: lit(-r6(a.width + a.t)) }),
  );
  partNames[side] = `${ctx.name} right side`;
  partNames[ctx.id("side-left")] = `${ctx.name} left side`;
  for (const p of a.pieces) {
    const id = ctx.id(p.role);
    features.push(sketchFeature(ctx.id(`${p.role}-sketch`), `${p.label} sketch`, TOP, sketchOf(pieceFlat(p, a), [], ctx.scope)));
    features.push(extrudeFeature(id, p.label, ctx.id(`${p.role}-sketch`), { depth: thickness, operation: "new" }));
    // Turned about its own middle (0, 0, t/2) — about Y, which takes +x down towards −z — then moved.
    const turn = r6(-p.angle);
    const move = { ...(Math.abs(turn) > 1e-9 ? { ry: lit(turn) } : {}), dx: lit(r6(p.centre[0])), dz: lit(r6(p.centre[1] - a.t / 2)) };
    features.push(moveFeature(ctx.id(`${p.role}-move`), `${p.label} in place`, id, move));
    partNames[id] = `${ctx.name} ${p.label.toLowerCase()}`;
  }
  return { features, partNames };
}

/** For tests and summaries: each piece's flat area as cut at kerf 0 (mm²), sides first. */
export function assemblyAreas(a: SideAssembly): { side: number; pieces: Record<string, number> } {
  const flatArea = (poly: P2[]) => Math.abs(poly.reduce((s, [x1, y1], i) => s + x1 * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * y1, 0)) / 2;
  const at0 = { ...a, kerf: 0 };
  const slots = sideSlots(at0).reduce((s, q) => s + flatArea(q), 0);
  return { side: flatArea(a.side) - slots, pieces: Object.fromEntries(a.pieces.map((p) => [p.role, flatArea(pieceFlat(p, at0))])) };
}
