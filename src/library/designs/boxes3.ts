/**
 * Two more finger-jointed laser boxes: one whose lid slides in grooves, and an open tray with slotted dividers that
 * cross-halve into rows × columns of compartments. Both use the finger box's maths (src/library/fingers.ts) for their
 * walls and bottom; sizes are variables, so they can be changed later in Variables.
 *
 * The sliding lid. A laser can't cut a groove part-way into a sheet, so the grooves are made from an extra layer:
 * inside each long wall (front and back) sits a "rail" panel of the same sheet with a long slot cut right through it,
 * open at the right-hand end. Laid against the wall, the slot is a groove as deep as the sheet is thick. The lid's long
 * edges run in the two grooves; the right-hand end wall is lower — its top is level with the grooves' floor — so the lid
 * slides in over it, and the end of each slot (a bridge of rail at the left) stops it. The lid is held from above by
 * the strip of rail over the slot and from below by the rail under it: it can only slide.
 *
 * Layout (outside sizes, kerf 0): W along x (the way the lid slides), D along y, H up. Sheet t thick, lid clearance c.
 *  - grooves: from z = g0 = H − 3t − 2c to g1 = g0 + t + 2c (the lid, t thick, c clear above and below); a strip 2t
 *    tall above them; the rails' slots stop 2t short of the left end wall;
 *  - the right end wall is g0 tall; the front and back walls' fingers on that end stop there too (`upTo`);
 *  - the lid: from 2t + c in from the left wall's outside to the box's right-hand face, c clear of the long walls.
 */
import { fraction, lit, minus, over, plus, times, type Ex } from "../ex";
import { boxProblems, fingerCount, fingerCounts, FINGER_MARGIN, grow, nominalOutline, panelOutlines, tidyOutline, type BoxSizes, type PanelSpec, type Pt, type SideSpec } from "../fingers";
import { copyFeature, extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import type { SketchPlane } from "../../sketch/planes";
import { mm, num, varsOf } from "./common";

const TOP: SketchPlane = { kind: "default", name: "Top" };
const FRONT: SketchPlane = { kind: "default", name: "Front" };
const RIGHT: SketchPlane = { kind: "default", name: "Right" };

const thicknessInput = { key: "thickness", label: "Material thickness", kind: "length" as const, default: 3, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." };
const kerfInput = { key: "kerf", label: "Kerf allowance", kind: "length" as const, default: 0, min: 0, max: 1, variable: true, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger so the joints fit snugly." };
const fingerInput = { key: "finger", label: "Finger width", kind: "length" as const, default: 10, min: 2, max: 500, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." };

/** A sketch of two joined outlines' worth of points, curves and dimensions. */
function joined(a: SketchData, b: SketchData): SketchData {
  return { ...a, points: [...a.points, ...b.points], curves: [...a.curves, ...b.curves], constraints: [...a.constraints, ...b.constraints] };
}

// ---------------------------------------------------------------------------
// Sliding-lid box

const SLIDE_VARS = ["width", "depth", "height", "thickness", "clearance", "kerf"];

export interface SlidingBox {
  b: BoxSizes;
  c: Ex;
  /** Grooves' floor and roof (z), the low end wall's height (= g0), the closed end's bridge (x from the left wall's inside). */
  g0: Ex;
  g1: Ex;
  bridge: Ex;
  /** Lid: x from lidX0 to W, y from t + c to D − t − c, z from g0 + c. */
  lidX0: Ex;
  /** Finger counts: along W, along D (inner), up the full walls, up the low end. */
  counts: { width: number; depth: number; height: number; low: number };
}

export function slidingBox(values: DesignValues, vars: Record<string, Ex> = varsOf(values, SLIDE_VARS)): SlidingBox {
  const { width: W, depth: D, height: H, thickness: t, clearance: c, kerf } = vars;
  const b: BoxSizes = { W, D, H, t, kerf, lid: false, finger: num(values, "finger") };
  const g0 = minus(H, plus(times(t, 3), times(c, 2)));
  const g1 = plus(g0, t, times(c, 2));
  const n = fingerCounts(b);
  const low = fingerCount(g0.v, b.finger, t.v + Math.max(0, kerf.v) + FINGER_MARGIN);
  const bridge = times(t, 2);
  return { b, c, g0, g1, bridge, lidX0: plus(t, bridge, c), counts: { ...n, low } };
}

/** The flat outlines (before the kerf) of the box's pieces: bottom, front (back the same), left end, right (low) end, rail, lid. */
export function slidingOutlines(s: SlidingBox) {
  const { W, D, H, t } = s.b;
  const n = s.counts;
  const alongW = (ownsEnds: boolean): SideSpec => ({ kind: "full", length: W, count: n.width, ownsEnds });
  const alongD = (ownsEnds: boolean): SideSpec => ({ kind: "inner", length: D, t, count: n.depth, ownsEnds });
  const plain: SideSpec = { kind: "plain" };
  const specs: Record<"bottom" | "front" | "left" | "right", PanelSpec> = {
    bottom: { U: W, V: D, south: alongW(false), north: alongW(false), west: alongD(true), east: alongD(true) },
    front: { U: W, V: H, south: alongW(true), north: plain, west: { kind: "full", length: H, count: n.height, ownsEnds: true }, east: { kind: "full", length: H, count: n.low, ownsEnds: true, upTo: s.g0 } },
    left: { U: D, V: H, south: alongD(false), north: plain, west: { kind: "full", length: H, count: n.height, ownsEnds: false }, east: { kind: "full", length: H, count: n.height, ownsEnds: false } },
    right: { U: D, V: s.g0, south: alongD(false), north: plain, west: { kind: "full", length: s.g0, count: n.low, ownsEnds: false }, east: { kind: "full", length: s.g0, count: n.low, ownsEnds: false } },
  };
  const x0 = t;
  const x1 = minus(W, t);
  const slotFrom = plus(t, s.bridge);
  // The rail, seen from the front (x along, z up), where it sits in the box: a C open to the right.
  const rail: Pt[] = [
    [x0, t],
    [x1, t],
    [x1, s.g0],
    [slotFrom, s.g0],
    [slotFrom, s.g1],
    [x1, s.g1],
    [x1, H],
    [x0, H],
  ];
  const lidY0 = plus(t, s.c);
  const lidY1 = minus(D, plus(t, s.c));
  const lid: Pt[] = [
    [s.lidX0, lidY0],
    [W, lidY0],
    [W, lidY1],
    [s.lidX0, lidY1],
  ];
  return {
    bottom: nominalOutline(specs.bottom, t),
    front: nominalOutline(specs.front, t),
    left: nominalOutline(specs.left, t),
    right: nominalOutline(specs.right, t),
    rail: tidyOutline(rail),
    lid,
  };
}

/** The finger hole in the lid (centre x, y and diameter), or null when it's off or the lid is too narrow. */
export function lidHole(values: DesignValues, s: SlidingBox): { x: Ex; y: Ex; d: number } | null {
  if (values.hole === false) return null;
  const d = 16;
  // Clear of the low end wall under the lid's end (whatever the sheet's thickness), so a finger reaches in.
  return { x: minus(s.b.W, plus(s.b.t, lit(d / 2 + 4))), y: over(s.b.D, 2), d };
}

function slidingProblems(v: DesignValues): string[] {
  const s = slidingBox(v);
  const out = boxProblems(s.b);
  if (out.length) return out;
  const [t, c] = [s.b.t.v, s.c.v];
  if (c < 0) out.push("The lid clearance can't be less than 0.");
  if (c > t) out.push(`A lid clearance of ${mm(c)} is a lot: 0.2–0.4 mm lets the lid slide without rattling.`);
  if (s.g0.v < 4 * t + 2) out.push(`The box is too low for its sliding lid: make it at least ${mm(7 * t + 2 * c + 2)} tall.`);
  const lidWidth = s.b.D.v - 2 * t - 2 * c;
  if (lidWidth < 10) out.push("The box is too narrow for a sliding lid: make it deeper.");
  if (s.b.W.v - s.lidX0.v < 4 * t + 10) out.push("The box is too short for a sliding lid: make it wider.");
  const hole = lidHole(v, s);
  if (!out.length && hole && (lidWidth < hole.d + 6 || hole.x.v - hole.d / 2 < s.lidX0.v + 4)) out.push("The lid is too small for a finger hole: turn the finger hole off, or make the box bigger.");
  return out;
}

/** The pieces as flat panel features: sketch → New extrude, each moved where it goes. */
function panel(ctx: MakeContext, role: string, label: string, plane: SketchPlane, outline: Pt[], t: Ex, kerfHalf: Ex, flip = false, extra?: SketchData): Feature[] {
  let s = outlineSketch(grow(outline, kerfHalf), ctx.scope);
  if (extra) s = joined(s, extra);
  return [sketchFeature(ctx.id(`${role}-sketch`), `${label} sketch`, plane, s), extrudeFeature(ctx.id(role), label, ctx.id(`${role}-sketch`), { depth: t, operation: "new", flip })];
}

export const slidingLidBox: LibraryDesign = {
  id: "sliding-lid-box",
  name: "Sliding-lid box",
  group: "Boxes and stands",
  description:
    "A finger-joint box whose lid slides in and out along grooves. A laser can't cut a groove part-way into a sheet, so each groove is made from a rail: an extra panel with a long slot cut right through it, glued inside each long wall. The right-hand end wall is lower, so the lid slides in over it. Shown put together; 8 flat pieces.",
  category: "laser",
  prefix: "slidebox",
  icon: '<path d="M6 20 24 12l18 8v16l-18 8-18-8z"/><path d="M6 20l18 8 18-8M24 28v16"/><path d="M10 17 28 9l12 5" opacity=".6"/><path d="M33 8l6 3-2 1" />',
  inputs: [
    { key: "width", label: "Length", kind: "length", default: 160, min: 30, max: 580, variable: true, help: "Outside, the way the lid slides." },
    { key: "depth", label: "Width", kind: "length", default: 100, min: 30, max: 580, variable: true, help: "Outside, across the lid." },
    { key: "height", label: "Height", kind: "length", default: 60, min: 20, max: 580, variable: true, help: "Outside, lid included." },
    thicknessInput,
    fingerInput,
    { key: "clearance", label: "Lid clearance", kind: "length", default: 0.2, min: 0, max: 2, variable: true, help: "Room round the lid in its grooves, each side: 0.2–0.4 mm slides nicely." },
    { key: "hole", label: "Finger hole in the lid", kind: "toggle", default: true },
    kerfInput,
  ],
  problems: slidingProblems,
  summary: (v) => {
    const s = slidingBox(v);
    return `8 pieces: bottom, 4 walls, 2 rails and the lid (${mm(s.b.W.v - s.lidX0.v)} × ${mm(s.b.D.v - 2 * s.b.t.v - 2 * s.c.v)}).`;
  },
  make: (ctx) => {
    const s = slidingBox(ctx.values, ctx.vars);
    const o = slidingOutlines(s);
    const { W, D, t } = s.b;
    const k2 = over(s.b.kerf, 2);
    const hole = lidHole(ctx.values, s);
    const holeSketch = hole ? shapesSketch([{ type: "circle", center: [hole.x.t, hole.y.t], diameter: hole.d }], ctx.scope) : undefined;
    const features: Feature[] = [
      ...panel(ctx, "bottom", "Bottom", TOP, o.bottom, t, k2),
      // The Front plane faces −Y: flip so the walls go into the box.
      ...panel(ctx, "front", "Front", FRONT, o.front, t, k2, true),
      copyFeature(ctx.id("back"), "Back", ctx.id("front"), { dy: minus(D, t) }),
      ...panel(ctx, "left", "Left end", RIGHT, o.left, t, k2),
      ...panel(ctx, "right", "Right end (low)", RIGHT, o.right, t, k2),
      moveFeature(ctx.id("right-move"), "Right end in place", ctx.id("right"), { dx: minus(W, t) }),
      ...panel(ctx, "rail", "Front rail", FRONT, o.rail, t, k2, true),
      moveFeature(ctx.id("rail-move"), "Front rail in place", ctx.id("rail"), { dy: t }),
      copyFeature(ctx.id("back-rail"), "Back rail", ctx.id("rail"), { dy: minus(D, times(t, 3)) }),
      ...panel(ctx, "lid", "Lid", TOP, o.lid, t, k2, false, holeSketch),
      moveFeature(ctx.id("lid-move"), "Lid in its grooves", ctx.id("lid"), { dz: plus(s.g0, s.c) }),
    ];
    const names: [string, string][] = [["bottom", "bottom"], ["front", "front"], ["back", "back"], ["left", "left end"], ["right", "right end"], ["rail", "front rail"], ["back-rail", "back rail"], ["lid", "lid"]];
    return { features, partNames: Object.fromEntries(names.map(([r, n]) => [ctx.id(r), `${ctx.name} ${n}`])) };
  },
  preview: (v) => {
    if (slidingProblems(v).length) return [];
    const s = slidingBox(v);
    const o = slidingOutlines(s);
    const flat = (p: Pt[]) => p.map(([x, y]) => [x.v, y.v] as [number, number]);
    const gap = Math.max(s.b.W.v, s.b.D.v) * 0.08;
    const out: PreviewShape[] = [];
    let y = 0;
    const row = (pieces: [Pt[], string, number?][]) => {
      let x = 0;
      let h = 0;
      for (const [p, label] of pieces) {
        const pts = flat(p);
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
        const [w, hh] = [Math.max(...xs) - minX, Math.max(...ys) - minY];
        out.push({ kind: "poly", closed: true, points: pts.map(([a, b2]) => [a - minX + x, b2 - minY + y - hh]) });
        out.push({ kind: "text", at: [x + w / 2, y - hh / 2], text: label });
        x += w + gap;
        h = Math.max(h, hh);
      }
      y -= h + gap;
    };
    row([[o.bottom, "bottom"], [o.lid, "lid"]]);
    row([[o.front, "front"], [o.front, "back"]]);
    row([[o.rail, "rail"], [o.rail, "rail"]]);
    row([[o.left, "left end"], [o.right, "right end"]]);
    return out;
  },
};

/** For tests: the volume of the pieces, put together, at kerf 0 (mm³). */
export function slidingVolume(v: DesignValues): { box: number; rails: number; lid: number } {
  const s = slidingBox(v);
  const [W, D, H, t] = [s.b.W.v, s.b.D.v, s.b.H.v, s.b.t.v];
  const box = W * D * H - (W - 2 * t) * (D - 2 * t) * (H - t) - t * (D - 2 * t) * (H - s.g0.v);
  const rails = 2 * t * ((W - 2 * t) * (H - t) - (W - 2 * t - s.bridge.v) * (s.g1.v - s.g0.v));
  const hole = lidHole(v, s);
  const lid = t * ((W - s.lidX0.v) * (D - 2 * t - 2 * s.c.v) - (hole ? (Math.PI * hole.d * hole.d) / 4 : 0));
  return { box, rails, lid };
}

// ---------------------------------------------------------------------------
// Tray with dividers

const TRAY_VARS = ["width", "depth", "height", "thickness", "kerf"];
/** Dividers are this much shorter than the inside of the tray (half at each end), so they drop in. */
export const DIVIDER_ROOM = 0.5;

export interface DividerTray {
  b: BoxSizes;
  rows: number;
  columns: number;
  /** Middles of the dividers that run along x (one per row boundary: y) and along y (x). */
  rowAt: Ex[];
  columnAt: Ex[];
  /** The dividers' halving slots meet at this height. */
  mid: Ex;
}

export function dividerTray(values: DesignValues, vars: Record<string, Ex> = varsOf(values, TRAY_VARS)): DividerTray {
  const { width: W, depth: D, height: H, thickness: t, kerf } = vars;
  const rows = num(values, "rows");
  const columns = num(values, "columns");
  // Compartments of equal size: n of them and n − 1 dividers across the inside, size − 2t.
  const centres = (size: Ex, n: number) => Array.from({ length: n - 1 }, (_, i) => plus(fraction(minus(size, times(t, n + 1)), i + 1, n), times(t, i + 1.5)));
  return { b: { W, D, H, t, kerf, lid: false, finger: num(values, "finger") }, rows, columns, rowAt: centres(D, rows), columnAt: centres(W, columns), mid: over(plus(H, t), 2) };
}

/**
 * The two kinds of divider, before the kerf, drawn where they sit (seen from the front for the ones along x, from the
 * side for the ones along y): those along x have slots down from the top where the others cross, those along y slots up
 * from the bottom, each to half the dividers' height — so they slide together and come out flush.
 */
export function dividerOutlines(d: DividerTray): { alongX: Pt[]; alongY: Pt[] } {
  const { W, D, H, t } = d.b;
  const half = over(t, 2);
  const room = lit(DIVIDER_ROOM / 2);
  const [x0, x1] = [plus(t, room), minus(W, plus(t, room))];
  const [y0, y1] = [plus(t, room), minus(D, plus(t, room))];
  const alongX: Pt[] = [[x0, t], [x1, t], [x1, H]];
  for (const c of [...d.columnAt].reverse()) alongX.push([plus(c, half), H], [plus(c, half), d.mid], [minus(c, half), d.mid], [minus(c, half), H]);
  alongX.push([x0, H]);
  const alongY: Pt[] = [[y0, t]];
  for (const r of d.rowAt) alongY.push([minus(r, half), t], [minus(r, half), d.mid], [plus(r, half), d.mid], [plus(r, half), t]);
  alongY.push([y1, t], [y1, H], [y0, H]);
  return { alongX: tidyOutline(alongX), alongY: tidyOutline(alongY) };
}

const LABEL = { bottom: "Bottom", front: "Front", left: "Left side" } as const;
const PLANES = { bottom: TOP, front: FRONT, left: RIGHT } as const;

function trayProblems(v: DesignValues): string[] {
  const d = dividerTray(v);
  const out = boxProblems(d.b);
  if (out.length) return out;
  const t = d.b.t.v;
  for (const [n, size, what] of [[d.columns, d.b.W.v, "columns"], [d.rows, d.b.D.v, "rows"]] as const) {
    const cell = (size - (n + 1) * t) / n;
    if (cell < 10) out.push(`The compartments would be only ${mm(cell)} across: use fewer ${what} or a bigger tray.`);
  }
  if (d.b.H.v - t < 6) out.push("The tray is too low for dividers: make it taller.");
  return out;
}

export const dividerTrayDesign: LibraryDesign = {
  id: "divider-tray",
  name: "Tray with dividers",
  group: "Boxes and stands",
  description:
    "An open finger-joint tray with dividers that slot into each other (halving joints) to make rows × columns of compartments — for screws, beads, cutlery or tea bags. The dividers just drop in, so they can be taken out. Shown put together; every piece is a flat panel.",
  category: "laser",
  prefix: "dtray",
  icon: '<path d="M6 16h36v22H6z"/><path d="M18 16v22M30 16v22M6 27h36" opacity=".7"/><path d="M6 16l6-6h36l-6 6M42 38l6-6V10" opacity=".5"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 200, min: 30, max: 580, variable: true, help: "Outside." },
    { key: "depth", label: "Depth", kind: "length", default: 150, min: 30, max: 580, variable: true, help: "Outside." },
    { key: "height", label: "Height", kind: "length", default: 50, min: 15, max: 300, variable: true, help: "Outside; the dividers come up level with the walls." },
    { key: "columns", label: "Columns", kind: "count", default: 3, min: 1, max: 12, help: "Compartments left to right." },
    { key: "rows", label: "Rows", kind: "count", default: 2, min: 1, max: 12, help: "Compartments front to back." },
    thicknessInput,
    fingerInput,
    kerfInput,
  ],
  problems: trayProblems,
  summary: (v) => {
    const d = dividerTray(v);
    return `${d.rows * d.columns} compartments: 5 tray pieces and ${d.rows - 1 + d.columns - 1} divider${d.rows + d.columns - 2 === 1 ? "" : "s"}.`;
  },
  make: (ctx) => {
    const d = dividerTray(ctx.values, ctx.vars);
    const { W, D, t } = d.b;
    const k2 = over(d.b.kerf, 2);
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const name = (role: string, label: string) => (partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`);
    for (const p of panelOutlines(d.b)) {
      features.push(...panel(ctx, p.name, LABEL[p.name], PLANES[p.name], p.nominal, t, k2, p.name === "front"));
      name(p.name, LABEL[p.name]);
      const [copy, label, move] = p.name === "bottom" ? [null, "", {}] : p.name === "front" ? ["back", "Back", { dy: minus(D, t) }] : ["right", "Right side", { dx: minus(W, t) }];
      if (!copy) continue;
      features.push(copyFeature(ctx.id(copy), label, ctx.id(p.name), move));
      name(copy, label);
    }
    const o = dividerOutlines(d);
    const half = over(t, 2);
    const run = (kind: "x" | "y", at: Ex[]) => {
      if (!at.length) return;
      const role = kind === "x" ? "divider-x" : "divider-y";
      const label = kind === "x" ? "Divider across" : "Divider front to back";
      features.push(...panel(ctx, role, `${label} 1`, kind === "x" ? FRONT : RIGHT, kind === "x" ? o.alongX : o.alongY, t, k2, kind === "x"));
      features.push(moveFeature(ctx.id(`${role}-move`), `${label} 1 in place`, ctx.id(role), kind === "x" ? { dy: minus(at[0], half) } : { dx: minus(at[0], half) }));
      name(role, `${label} 1`);
      at.slice(1).forEach((c, i) => {
        const r = `${role}-${i + 2}`;
        const by = minus(c, at[0]);
        features.push(copyFeature(ctx.id(r), `${label} ${i + 2}`, ctx.id(role), kind === "x" ? { dy: by } : { dx: by }));
        name(r, `${label} ${i + 2}`);
      });
    };
    run("x", d.rowAt);
    run("y", d.columnAt);
    return { features, partNames };
  },
  preview: (v) => {
    if (trayProblems(v).length) return [];
    const d = dividerTray(v);
    const flat = (p: Pt[], dx: number, dy: number) => {
      const xs = p.map((q) => q[0].v);
      const ys = p.map((q) => q[1].v);
      return p.map(([x, y]) => [x.v - Math.min(...xs) + dx, y.v - Math.min(...ys) + dy] as [number, number]);
    };
    const gap = Math.max(d.b.W.v, d.b.D.v) * 0.06;
    // The tray seen from above, with its dividers, and the two kinds of divider beside it.
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: [[0, 0], [d.b.W.v, 0], [d.b.W.v, d.b.D.v], [0, d.b.D.v]] }];
    for (const c of d.columnAt) out.push({ kind: "poly", closed: true, points: [[c.v - d.b.t.v / 2, d.b.t.v], [c.v + d.b.t.v / 2, d.b.t.v], [c.v + d.b.t.v / 2, d.b.D.v - d.b.t.v], [c.v - d.b.t.v / 2, d.b.D.v - d.b.t.v]], faint: true });
    for (const r of d.rowAt) out.push({ kind: "poly", closed: true, points: [[d.b.t.v, r.v - d.b.t.v / 2], [d.b.W.v - d.b.t.v, r.v - d.b.t.v / 2], [d.b.W.v - d.b.t.v, r.v + d.b.t.v / 2], [d.b.t.v, r.v + d.b.t.v / 2]], faint: true });
    const o = dividerOutlines(d);
    let y = -gap - d.b.H.v;
    if (d.rowAt.length) {
      out.push({ kind: "poly", closed: true, points: flat(o.alongX, 0, y) }, { kind: "text", at: [d.b.W.v / 2, y - gap / 2], text: "divider across" });
      y -= d.b.H.v + gap;
    }
    if (d.columnAt.length) out.push({ kind: "poly", closed: true, points: flat(o.alongY, 0, y) }, { kind: "text", at: [d.b.D.v / 2, y - gap / 2], text: "divider front to back" });
    return out;
  },
};

/** For tests: the volume of the dividers (kerf 0, mm³). */
export function dividerVolume(v: DesignValues): number {
  const d = dividerTray(v);
  const [W, D, H, t] = [d.b.W.v, d.b.D.v, d.b.H.v, d.b.t.v];
  const hd = H - t;
  const [lx, ly] = [W - 2 * t - DIVIDER_ROOM, D - 2 * t - DIVIDER_ROOM];
  return d.rowAt.length * t * (lx * hd - d.columnAt.length * t * (hd / 2)) + d.columnAt.length * t * (ly * hd - d.rowAt.length * t * (hd / 2));
}

// ---------------------------------------------------------------------------
// Bookend

const BOOKEND_VARS = ["width", "height", "depth", "thickness", "kerf"];

/**
 * A bookend of three slotted pieces, no glue: an upright, a base the books stand on (their weight holds it down) and a
 * triangular brace behind the upright. The upright's two tabs go down through slots in the base; the brace's tabs go
 * into a slot in the base and a slot in the upright. Slots are drawn kerf/2 smaller all round and the pieces kerf/2
 * bigger, so after cutting they're all their true size and fit snugly.
 *
 * Seen from the side (x towards the books, z up, y across, centred): the base on the Top plane runs from just behind
 * the brace to x = L; the upright stands at x = a…a + t (a = t + 5); the brace is a right-angled triangle G = H/2 on
 * its straight sides, against the upright's back (x = a − G…a), its tabs reaching into the upright and the base.
 */
export interface Bookend {
  /** Sizes. */
  W: Ex;
  H: Ex;
  L: Ex;
  t: Ex;
  kerf: Ex;
  /** The upright's front face (x), the brace's size (G: its two straight sides). */
  ux: Ex;
  G: Ex;
}

export function bookend(values: DesignValues, vars: Record<string, Ex> = varsOf(values, BOOKEND_VARS)): Bookend {
  const { width: W, height: H, depth, thickness: t, kerf } = vars;
  const ux = plus(t, lit(5));
  const G = over(H, 2);
  // The base runs from 5 mm behind the brace (x = ux − G − 5) to L, `depth` long in all.
  return { W, H, L: minus(plus(depth, ux), plus(G, lit(5))), t, kerf, ux, G };
}

/**
 * The pieces' outlines before the kerf, each anticlockwise, where they sit: the upright (y, z) at x = ux…ux + t, the
 * brace (x, z) behind it at x = ux − G…ux, the base (x, y) from x = ux − G − 5 to L with three slots.
 */
const ZERO_ = lit(0);

export function bookendOutlines(b: Bookend) {
  const { W, H, L, t, ux, G } = b;
  const hw = over(W, 2);
  const ny = (e: Ex) => minus(lit(0), e);
  const back = minus(ux, plus(G, lit(5)));
  const fr = (k: number) => times(W, k);
  // Upright, seen from the side (y across, z up): two tabs down through the base.
  const upright: Pt[] = [
    [ny(hw), t],
    [ny(fr(0.4)), t],
    [ny(fr(0.4)), ZERO_],
    [ny(fr(0.2)), ZERO_],
    [ny(fr(0.2)), t],
    [fr(0.2), t],
    [fr(0.2), ZERO_],
    [fr(0.4), ZERO_],
    [fr(0.4), t],
    [hw, t],
    [hw, H],
    [ny(hw), H],
  ];
  const half = over(t, 2);
  const z1 = plus(t, times(G, 0.25));
  const z2 = plus(t, times(G, 0.75));
  // The brace's slot in the upright (y, z).
  const uprightSlot: Pt[] = [[ny(half), z1], [half, z1], [half, z2], [ny(half), z2]];
  // The brace, seen from the front (x, z): a right-angled triangle against the upright's back, a tab into the
  // upright and one down into the base.
  const bx = (k: number) => minus(ux, times(G, k));
  const brace: Pt[] = [
    [minus(ux, G), t],
    [bx(0.6), t],
    [bx(0.6), ZERO_],
    [bx(0.2), ZERO_],
    [bx(0.2), t],
    [ux, t],
    [ux, z1],
    [plus(ux, t), z1],
    [plus(ux, t), z2],
    [ux, z2],
    [ux, plus(t, G)],
  ];
  const base: Pt[] = [[back, ny(hw)], [L, ny(hw)], [L, hw], [back, hw]];
  const baseSlots: Pt[][] = [
    [[ux, ny(fr(0.4))], [plus(ux, t), ny(fr(0.4))], [plus(ux, t), ny(fr(0.2))], [ux, ny(fr(0.2))]],
    [[ux, fr(0.2)], [plus(ux, t), fr(0.2)], [plus(ux, t), fr(0.4)], [ux, fr(0.4)]],
    [[bx(0.6), ny(half)], [bx(0.2), ny(half)], [bx(0.2), half], [bx(0.6), half]],
  ];
  return { upright, uprightSlot, brace, base, baseSlots };
}


/** A hole's outline moved `half` in all round (the kerf then cuts it back out to its true size). */
const shrink = (pts: Pt[], half: Ex) => grow([...pts].reverse(), half).reverse();

function bookendProblems(v: DesignValues): string[] {
  const b = bookend(v);
  const [W, H, L, t, k] = [b.W.v, b.H.v, b.L.v, b.t.v, b.kerf.v];
  const out: string[] = [];
  if (k >= t / 2) out.push(`A kerf allowance of ${mm(k)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`);
  if (0.2 * W < 2 * t + 2) out.push(`The bookend is too narrow for its slots: make it at least ${mm(Math.ceil(10 * t + 10))} wide.`);
  if (0.5 * 0.5 * H < t + 4) out.push("The bookend is too low: make it taller.");
  if (L < b.ux.v + t + 30) out.push(`The base is too short for the books to stand on: make it at least ${mm(b.G.v + 5 + t + 30)} deep.`);
  return out;
}

export const bookendDesign: LibraryDesign = {
  id: "bookend",
  name: "Bookend",
  group: "Boxes and stands",
  description:
    "A flat-pack bookend of three slotted pieces, no glue: an upright, a base the books stand on (their weight holds it) and a brace behind. The upright's tabs go through slots in the base, and the brace slots into both. Shown put together; make two for a shelf.",
  category: "laser",
  prefix: "bookend",
  icon: '<path d="M10 40h30M18 40V10h4v30" /><path d="M18 22l-8 18" opacity=".6"/><path d="M26 14h5v26h-5zM32 18h5v22h-5z" opacity=".5"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 120, min: 40, max: 400, variable: true, help: "Across the shelf." },
    { key: "height", label: "Height", kind: "length", default: 150, min: 40, max: 290, variable: true },
    { key: "depth", label: "Base depth", kind: "length", default: 160, min: 60, max: 400, variable: true, help: "The base's whole length, front to back: half the height goes behind the upright, under the brace; the rest is under the books." },
    thicknessInput,
    kerfInput,
  ],
  problems: bookendProblems,
  summary: () => "3 pieces: an upright, a base and a brace.",
  make: (ctx) => {
    const b = bookend(ctx.values, ctx.vars);
    const o = bookendOutlines(b);
    const k2 = over(b.kerf, 2);
    const holes = (list: Pt[][]) => list.map((h) => outlineSketch(shrink(h, k2), ctx.scope)).reduce(joined);
    const [base, upright, brace] = ["base", "upright", "brace"].map(ctx.id);
    const half = over(b.t, 2);
    return {
      features: [
        ...panel(ctx, "base", "Base", TOP, o.base, b.t, k2, false, holes(o.baseSlots)),
        ...panel(ctx, "upright", "Upright", RIGHT, o.upright, b.t, k2, false, holes([o.uprightSlot])),
        moveFeature(ctx.id("upright-move"), "Upright in place", upright, { dx: b.ux }),
        ...panel(ctx, "brace", "Brace", FRONT, o.brace, b.t, k2, true),
        moveFeature(ctx.id("brace-move"), "Brace in place", brace, { dy: minus(lit(0), half) }),
      ],
      partNames: { [base]: `${ctx.name} base`, [upright]: `${ctx.name} upright`, [brace]: `${ctx.name} brace` },
    };
  },
  preview: (v) => {
    if (bookendProblems(v).length) return [];
    const o = bookendOutlines(bookend(v));
    const flat = (p: Pt[], dx = 0, dy = 0) => p.map(([x, y]) => [x.v + dx, y.v + dy] as [number, number]);
    const H = num(v, "height");
    const gap = 15;
    const bx = bookend(v).L.v + gap + num(v, "width") / 2;
    return [
      { kind: "poly", closed: true, points: flat(o.base) },
      ...o.baseSlots.map((s): PreviewShape => ({ kind: "poly", closed: true, points: flat(s) })),
      { kind: "text", at: [bookend(v).L.v - num(v, "depth") / 2, -num(v, "width") / 2 - 8], text: "base" },
      { kind: "poly", closed: true, points: flat(o.upright, bx, -num(v, "width") / 2) },
      { kind: "poly", closed: true, points: flat(o.uprightSlot, bx, -num(v, "width") / 2) },
      { kind: "text", at: [bx, -num(v, "width") / 2 - 8], text: "upright" },
      { kind: "poly", closed: true, points: flat(o.brace, bx + num(v, "width") / 2 + gap + H / 2, -num(v, "width") / 2) },
      { kind: "text", at: [bx + num(v, "width") / 2 + gap + H / 4, -num(v, "width") / 2 - 8], text: "brace" },
    ];
  },
};

/** For tests: the pieces' volumes at kerf 0 (mm³). */
export function bookendVolume(v: DesignValues): { base: number; upright: number; brace: number } {
  const b = bookend(v);
  const [W, H, L, t, G, ux] = [b.W.v, b.H.v, b.L.v, b.t.v, b.G.v, b.ux.v];
  const back = ux - G - 5;
  return {
    base: t * ((L - back) * W - 2 * t * 0.2 * W - 0.4 * G * t),
    upright: t * (W * (H - t) + 2 * 0.2 * W * t - t * 0.5 * G),
    brace: t * ((G * G) / 2 + 0.4 * G * t + 0.5 * G * t),
  };
}
