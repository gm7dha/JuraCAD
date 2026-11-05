/**
 * A holder for a set of coasters (the library's own Coasters design: the same shapes and sizes): the coasters stand on
 * edge in a row between two end plates, on a base, with a low wall each side. The end plates hold the base and walls by
 * tabs through slots (sidePanels.ts) and have a notch in the top to pinch a coaster out.
 *
 * Seen end-on (the end plates' plane: x across, z up): the base lies at z = m…m + t from x = m; the walls stand on its
 * ends; the coasters stand between the walls with `room` either side. Along y the end plates are the stack of coasters
 * (count × their thickness) plus room at each end apart.
 */
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { assemblyFeatures, assemblyProblems, evenTabs, sectionOf, sideSlots, type CrossPiece, type SideAssembly } from "../sidePanels";
import { r6, type P2 } from "../outlines";
import { mm, num } from "./common";

/**
 * The walls are this share of a coaster's height — half for six-sided ones, which stand on a flat and are widest (at their
 * side corners) halfway up, so the walls reach those corners; the end plates this share above the base.
 */
export const WALL_SHARE = 0.4;
export const HEX_WALL_SHARE = 0.5;
export const wallShare = (shape: string) => (shape === "hexagon" ? HEX_WALL_SHARE : WALL_SHARE);
export const END_SHARE = 0.6;
/** The finger notch in the end plates: this share of the coaster's width, down to this share of its height. */
export const NOTCH = { width: 0.5, down: 0.35 };

/** How wide and tall a coaster is standing on edge (on a flat side for a six-sided one): round and square ones are the size each way. */
export function coasterStanding(shape: string, size: number): { w: number; h: number } {
  return shape === "hexagon" ? { w: r6((2 * size) / Math.sqrt(3)), h: size } : { w: size, h: size };
}

export interface CoasterHolder {
  a: SideAssembly;
  /** A coaster standing: how wide and tall; where the coasters' row starts (x) and the base's top (z). */
  coaster: { w: number; h: number };
  x0: number;
  floor: number;
  /** The coasters' row along y: from −half to half. */
  half: number;
  stack: number;
}

export function coasterHolder(v: DesignValues): CoasterHolder {
  const [size, count, ct, room, t, kerf] = ["size", "count", "coasterThickness", "room", "thickness", "kerf"].map((k) => num(v, k));
  const c = coasterStanding(String(v.shape), size);
  const m = Math.max(5, t);
  const inside = c.w + 2 * room;
  const baseLen = r6(inside + 2 * t);
  const floor = r6(m + t);
  const wallH = r6(c.h * wallShare(String(v.shape)));
  const pieces: CrossPiece[] = [
    { role: "base", label: "Base", centre: [r6(m + baseLen / 2), r6(m + t / 2)], angle: 0, length: baseLen, tabs: evenTabs(baseLen) },
    { role: "wall-left", label: "Left wall", centre: [r6(m + t / 2), r6(floor + wallH / 2)], angle: 90, length: wallH, tabs: evenTabs(wallH, 1) },
    { role: "wall-right", label: "Right wall", centre: [r6(m + baseLen - t / 2), r6(floor + wallH / 2)], angle: 90, length: wallH, tabs: evenTabs(wallH, 1) },
  ];
  const X = r6(baseLen + 2 * m);
  const top = r6(floor + c.h * END_SHARE);
  const nw = (c.w * NOTCH.width) / 2;
  const nz = r6(floor + c.h * NOTCH.down);
  const cx = X / 2;
  const ch = Math.min(nw / 2, (top - nz) / 2);
  // The end plate: a rectangle with a notch down from the middle of its top edge; the notch's two top corners are cut off at 45°.
  const side: P2[] = [
    [0, 0],
    [X, 0],
    [X, top],
    [cx + nw + ch, top],
    [cx + nw, top - ch],
    [cx + nw, nz],
    [cx - nw, nz],
    [cx - nw, top - ch],
    [cx - nw - ch, top],
    [0, top],
  ].map(([x, z]): P2 => [r6(x), r6(z)]);
  const stack = r6(count * ct);
  return { a: { side, pieces, width: r6(stack + 2 * room), t, kerf }, coaster: c, x0: r6(m + t + room), floor, half: r6(stack / 2), stack };
}

export function coasterHolderProblems(v: DesignValues): string[] {
  const [t, kerf] = ["thickness", "kerf"].map((k) => num(v, k));
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  const h = coasterHolder(v);
  const share = wallShare(String(v.shape));
  if (h.coaster.h * share < 3 * t + 3) return [`The coasters are too small for walls with tabs: at least ${mm(Math.ceil((3 * t + 3) / share))} across.`];
  return assemblyProblems(h.a, { "wall-left": "left wall", "wall-right": "right wall" });
}

export const coasterHolderDesign: LibraryDesign = {
  id: "coaster-holder",
  name: "Coaster holder",
  group: "Home",
  description:
    "A holder for a set of coasters standing on edge — set the same shape, size and number as your coasters (the library's Coasters design is 95 mm round, 4 of them, by default). Two end plates hold the base and low side walls with tabs through slots, and a notch in each end lets you pinch a coaster out.",
  category: "laser",
  prefix: "coasterholder",
  icon: '<path d="M6 40h36M8 40V22h4M40 40V22h-4"/><path d="M14 40V18a10 10 0 0 1 20 0v22" opacity=".5"/><path d="M18 40V16M24 40V14M30 40V16" opacity=".7"/>',
  inputs: [
    {
      key: "shape",
      label: "Coaster shape",
      kind: "choice",
      default: "round",
      choices: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
        { value: "hexagon", label: "Six-sided" },
      ],
    },
    { key: "size", label: "Coaster size", kind: "length", default: 95, min: 30, max: 250, help: "Across (flat to flat for six-sided), as in the Coasters design." },
    { key: "count", label: "How many coasters", kind: "count", default: 4, min: 1, max: 24 },
    { key: "coasterThickness", label: "Coaster thickness", kind: "length", default: 3, min: 1, max: 20, help: "Each one: cork-backed coasters are thicker." },
    { key: "room", label: "Room round them", kind: "length", default: 1.5, min: 0.5, max: 10, help: "Each side and at each end, so they drop in easily." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger and slots this much smaller, so the tabs fit snugly." },
  ],
  problems: coasterHolderProblems,
  summary: (v) => {
    const h = coasterHolder(v);
    return `5 pieces for ${num(v, "count")} coasters ${mm(num(v, "size"))} across; ${mm(h.a.side[1][0])} × ${mm(h.a.width + 2 * h.a.t)} on the table.`;
  },
  make: (ctx) => assemblyFeatures(ctx, coasterHolder(ctx.values).a),
  preview: (v) => {
    if (coasterHolderProblems(v).length) return [];
    const h = coasterHolder(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: h.a.side }];
    for (const p of h.a.pieces) out.push({ kind: "poly", closed: true, points: sectionOf(p, h.a.t), faint: true });
    for (const q of sideSlots(h.a)) out.push({ kind: "poly", closed: true, points: q });
    const { w, h: ch } = h.coaster;
    if (v.shape === "round") out.push({ kind: "circle", c: [h.x0 + w / 2, h.floor + ch / 2], r: w / 2, faint: true });
    else out.push({ kind: "poly", closed: true, faint: true, points: [[h.x0, h.floor], [h.x0 + w, h.floor], [h.x0 + w, h.floor + ch], [h.x0, h.floor + ch]] });
    out.push({ kind: "text", at: [h.a.side[1][0] / 2, -10], text: "end" });
    return out;
  },
};
