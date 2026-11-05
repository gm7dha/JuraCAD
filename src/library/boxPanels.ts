/**
 * A finger-jointed box (fingers.ts) as separate panels, each its own sketch with its own holes, and the box standing
 * any of three ways round: as usual (open at the top), upside down (open at the bottom — a tissue box cover), or on
 * its back (open at the front — a chest of drawers' carcass). Pure numbers, plus the features that build it.
 *
 * The finger box's own coordinates: x across (0…W), y front to back (0…D), z up (0…H). Panels: bottom/lid (W × D),
 * front/back (W × H), left/right (D × H); each panel's outline is in its own across/up (U, V) — bottom (x, y),
 * front (x, z), left (y, z). Holes are given in those same panel coordinates, at their true size, and are drawn
 * kerf/2 smaller all round so they come out true; outlines are kerf/2 bigger (fingers.ts `grow`).
 *
 * Every panel is its own New extrude (no copies), so a user's parts in the Part Studio are never touched.
 */
import { lit } from "./ex";
import { panelOutlines, type BoxSizes } from "./fingers";
import { joinSketches } from "./laserKit";
import { anticlockwise, offsetPolygon, r6, round6, tidyPolygon, type P2 } from "./outlines";
import type { Hole } from "./patterns";
import { extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "./sketchKit";
import type { MakeContext } from "./types";
import type { Feature } from "../model/types";
import type { SketchData } from "../sketch/types";

export type BoxPanel = "bottom" | "lid" | "front" | "back" | "left" | "right";
export const BOX_PANELS: readonly BoxPanel[] = ["bottom", "lid", "front", "back", "left", "right"];

/** Which way the box stands: "upright" (as made), "upsideDown" (z → H − z), "onBack" (its top facing the front: x stays, y → z, z → H − y). */
export type BoxStance = "upright" | "upsideDown" | "onBack";

export interface PanelShape {
  /** As drawn (kerf allowance in), panel coordinates. */
  outline: P2[];
  /** True shape. */
  nominal: P2[];
}

/** The three panel shapes (lid = bottom, back = front, right = left) as plain numbers. */
export function panelShapes(b: BoxSizes): Record<"bottom" | "front" | "left", PanelShape> {
  const out = {} as Record<"bottom" | "front" | "left", PanelShape>;
  for (const p of panelOutlines(b)) out[p.name] = { outline: p.outline.map(([x, y]) => [r6(x.v), r6(y.v)]), nominal: p.nominal.map(([x, y]) => [r6(x.v), r6(y.v)]) };
  return out;
}

export const shapeOf = (s: Record<"bottom" | "front" | "left", PanelShape>, p: BoxPanel): PanelShape => s[p === "lid" ? "bottom" : p === "back" ? "front" : p === "right" ? "left" : p];

type PlaneName = "Top" | "Front" | "Right";
export interface PanelPlace {
  plane: PlaneName;
  /** Panel coordinates → the sketch's. */
  map: (p: P2) => P2;
  flip: boolean;
  move: { dx?: number; dy?: number; dz?: number };
}

/** Where a panel goes for the box standing `stance`: its sketch plane, how its outline maps onto it, and the move after. */
export function panelPlace(panel: BoxPanel, stance: BoxStance, b: { W: number; D: number; H: number; t: number }): PanelPlace {
  const { W, D, H, t } = b;
  const id = (p: P2): P2 => p;
  const down = ([u, v]: P2): P2 => [u, r6(H - v)];
  if (stance === "onBack") {
    // Finger-box (x, y, z) → (x, H − z, y): the bottom becomes the back, the front/back the floor/top, the open top the front.
    switch (panel) {
      case "bottom":
        return { plane: "Front", map: id, flip: true, move: { dy: r6(H - t) } };
      case "lid":
        return { plane: "Front", map: id, flip: true, move: {} };
      case "front":
        return { plane: "Top", map: down, flip: false, move: {} };
      case "back":
        return { plane: "Top", map: down, flip: false, move: { dz: r6(D - t) } };
      case "left":
        return { plane: "Right", map: ([u, v]) => [r6(H - v), u], flip: false, move: {} };
      case "right":
        return { plane: "Right", map: ([u, v]) => [r6(H - v), u], flip: false, move: { dx: r6(W - t) } };
    }
  }
  const m = stance === "upsideDown" ? down : id;
  switch (panel) {
    case "bottom":
      return { plane: "Top", map: id, flip: false, move: stance === "upsideDown" ? { dz: r6(H - t) } : {} };
    case "lid":
      return { plane: "Top", map: id, flip: false, move: stance === "upsideDown" ? {} : { dz: r6(H - t) } };
    case "front":
      return { plane: "Front", map: m, flip: true, move: {} };
    case "back":
      return { plane: "Front", map: m, flip: true, move: { dy: r6(D - t) } };
    case "left":
      return { plane: "Right", map: m, flip: false, move: {} };
    case "right":
      return { plane: "Right", map: m, flip: false, move: { dx: r6(W - t) } };
  }
}

/** A hole in a plate: a circle, a polygon, or a slot (two round ends, `w` wide, centres a and b — a drawer pull, a tissue slot). */
export type PlateHole = Hole | { kind: "slot"; a: P2; b: P2; w: number };

/** A hole as drawn: kerf/2 smaller all round, so it comes out its true size. */
export function drawnHole(h: PlateHole, kerf: number): PlateHole {
  if (h.kind === "circle") return { ...h, d: r6(h.d - kerf) };
  if (h.kind === "slot") return { ...h, w: r6(h.w - kerf) };
  return { kind: "poly", points: round6(offsetPolygon(h.points, -kerf / 2)) };
}

/** A hole moved by a map (a circle's centre; a polygon's corners). */
export function mapHole(h: PlateHole, map: (p: P2) => P2): PlateHole {
  if (h.kind === "slot") return { ...h, a: map(h.a), b: map(h.b) };
  return h.kind === "circle" ? { ...h, c: map(h.c) } : { kind: "poly", points: anticlockwise(h.points.map(map)) };
}

/** One sketch: a closed outline and holes (circles and polygons), every size dimensioned (fully defined). */
export function plateSketch(outline: P2[], holes: PlateHole[], scope: Record<string, number>): SketchData {
  return joinSketches(polySketch(outline, scope), ...holes.map((h) => holeSketch(h, scope)));
}

const polySketch = (p: P2[], scope: Record<string, number>) => outlineSketch(tidyPolygon(anticlockwise(round6(p))).map(([x, y]) => [lit(x), lit(y)]), scope);

/** One hole as a sketch of its own (fully defined): a circle, a slot, or an outline. */
export function holeSketch(h: PlateHole, scope: Record<string, number>): SketchData {
  const at = (p: P2) => [r6(p[0]), r6(p[1])];
  if (h.kind === "circle") return shapesSketch([{ type: "circle", center: at(h.c), diameter: r6(h.d) }], scope);
  if (h.kind === "slot") return shapesSketch([{ type: "slot", from: at(h.a), to: at(h.b), width: r6(h.w) }], scope);
  return polySketch(h.points, scope);
}

const PLANE = (name: PlaneName) => ({ kind: "default", name }) as const;

export interface BoxBuild {
  b: BoxSizes;
  stance: BoxStance;
  /** The panels to make, and their names. */
  panels: Partial<Record<BoxPanel, string>>;
  /** Holes per panel (true size, panel coordinates). */
  holes?: Partial<Record<BoxPanel, PlateHole[]>>;
  /** Open lines per panel (panel coordinates): scored, not cut — a bird box's climbing grooves. Each end dimensioned. */
  lines?: Partial<Record<BoxPanel, [P2, P2][]>>;
  /** Holes per panel given in its sketch's own coordinates instead (true size). */
  sketchHoles?: Partial<Record<BoxPanel, PlateHole[]>>;
  /** Moved this much after (the whole box). */
  shift?: { dx?: number; dy?: number; dz?: number };
  /** Role prefix for ids ("" = the panel's own name; "drawer-2-" → "drawer-2-front"). */
  prefix?: string;
}

/** The features for a box's panels: one sketch, a New extrude and (when it moves) a Move each. */
export function boxFeatures(ctx: MakeContext, box: BoxBuild): { features: Feature[]; partNames: Record<string, string> } {
  const { b, stance } = box;
  const [W, D, H, t, kerf] = [b.W.v, b.D.v, b.H.v, b.t.v, Math.max(0, b.kerf.v)];
  const shapes = panelShapes(b);
  const features: Feature[] = [];
  const partNames: Record<string, string> = {};
  const pre = box.prefix ?? "";
  for (const panel of BOX_PANELS) {
    const label = box.panels[panel];
    if (!label) continue;
    const at = panelPlace(panel, stance, { W, D, H, t });
    const role = `${pre}${panel}`;
    const holes = [...(box.holes?.[panel] ?? []).map((h) => mapHole(drawnHole(h, kerf), at.map)), ...(box.sketchHoles?.[panel] ?? []).map((h) => drawnHole(h, kerf))];
    const sk = ctx.id(`${role}-sketch`);
    const lines = (box.lines?.[panel] ?? []).map(([a, b]) => shapesSketch([{ type: "line", from: at.map(a).map(r6), to: at.map(b).map(r6) }], ctx.scope));
    features.push(sketchFeature(sk, `${label} sketch`, PLANE(at.plane), joinSketches(plateSketch(shapeOf(shapes, panel).outline.map(at.map), holes, ctx.scope), ...lines)));
    features.push(extrudeFeature(ctx.id(role), label, sk, { depth: lit(t), operation: "new", flip: at.flip }));
    const move = { dx: (at.move.dx ?? 0) + (box.shift?.dx ?? 0), dy: (at.move.dy ?? 0) + (box.shift?.dy ?? 0), dz: (at.move.dz ?? 0) + (box.shift?.dz ?? 0) };
    const used = Object.fromEntries(Object.entries(move).filter(([, v]) => Math.abs(v) > 1e-9).map(([k, v]) => [k, lit(r6(v))]));
    if (Object.keys(used).length) features.push(moveFeature(ctx.id(`${role}-move`), `${label} in place`, ctx.id(role), used));
    partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`;
  }
  return { features, partNames };
}

/** Area of a hole (mm²). */
export const holeArea = (h: PlateHole) =>
  h.kind === "circle" ? (Math.PI * h.d * h.d) / 4 : h.kind === "slot" ? h.w * Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]) + (Math.PI * h.w * h.w) / 4 : Math.abs(polySigned(h.points));
function polySigned(p: P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return a / 2;
}

/** For tests: each panel's area as cut at kerf 0 (outline less its holes), mm². */
export function panelAreas(b: BoxSizes, holes: Partial<Record<BoxPanel, PlateHole[]>> = {}): Record<BoxPanel, number> {
  const s = panelShapes({ ...b, kerf: lit(0) });
  return Object.fromEntries(BOX_PANELS.map((p) => [p, Math.abs(polySigned(shapeOf(s, p).nominal)) - (holes[p] ?? []).reduce((n, h) => n + holeArea(h), 0)])) as Record<BoxPanel, number>;
}

/** The panels' outlines as cut, each a single piece of sheet: do they fit the laser's bed? */
export function panelsFit(b: BoxSizes, fits: (w: number, h: number) => boolean): boolean {
  const s = panelShapes(b);
  return (["bottom", "front", "left"] as const).every((p) => {
    const xs = s[p].outline.map((q) => q[0]);
    const ys = s[p].outline.map((q) => q[1]);
    return fits(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  });
}
