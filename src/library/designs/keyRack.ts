/**
 * A wall organiser / key rack: a board to screw to the wall, with words engraved across the top and a row of hooks
 * along the bottom. Each hook is a flat L-shaped piece — an arm sticking out from the board with a lip at its end
 * pointing up, so keys and lanyards don't slide off — with a tab on its back that goes into a slot in the board
 * (glue it in).
 *
 * Modelled lying on its back: the board on the Top plane, its front face up (z = 0) — where the words are engraved —
 * and the hooks standing up from it. Across the board is x, up the wall is y. A hook is drawn on the Right plane (y
 * along, z up) and is the sheet's thickness across (x). Slots are drawn kerf/2 smaller and hooks kerf/2 bigger, so the
 * tabs fit snugly; the board itself (one plate, its letters engraved by a plain Remove, so only it is cut) is the
 * design's own engraved-plate sketch: Export for laser of "Board sketch" gives the red outline, blue slots and holes, and
 * the engraved words.
 */
import { lit, type Ex } from "../ex";
import { grow, type Pt } from "../fingers";
import { joinSketches, onLetters, pickAreas } from "../laserKit";
import { insidePolygon, r6, round6, type P2 } from "../outlines";
import { copyFeature, extrudeFeature, moveFeature, outlineSketch, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { addTextBlock, blockContours, contoursBox, fontInput, fontOf, linesOf, type TextBlock } from "../textKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import { ENGRAVE_DEPTH } from "./engraved";
import { mm, num, roundedRect } from "./common";
import { wordsInput, wordsProblems } from "./stencil";

const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;

/** A hook's sizes (mm): the arm's height up the wall, the lip at its end, the tab's room at each end of the arm. */
export const HOOK = { arm: 12, lip: 8, lipThick: 6, tabRoom: 2 };
/** Screw holes: diameter, and how far in from the board's top corners. */
export const SCREW = { d: 4.5, inset: 12 };

export interface KeyRack {
  w: number;
  h: number;
  corner: number;
  /** Each hook's middle (x), the arm's bottom (y), how far it reaches out (z). */
  hooks: number[];
  armY: number;
  reach: number;
  /** The tab slots (true size) and the screw holes. */
  slots: P2[][];
  screws: P2[];
  text: TextBlock | null;
  /** Where the words may go. */
  room: [number, number, number, number];
}

export function keyRack(v: DesignValues): KeyRack {
  const [w, h, n, reach, t, cap] = ["width", "height", "hooks", "reach", "thickness", "letters"].map((k) => num(v, k));
  const corner = Math.min(num(v, "corner"), w / 2 - 1, h / 2 - 1);
  const armY = r6(-h / 2 + 12);
  const hooks = Array.from({ length: n }, (_, i) => r6(-w / 2 + (w * (i + 0.5)) / n));
  const [y0, y1] = [armY + HOOK.tabRoom, armY + HOOK.arm - HOOK.tabRoom];
  const slots = hooks.map((x) => round6([[x - t / 2, y0], [x + t / 2, y0], [x + t / 2, y1], [x - t / 2, y1]]));
  const screws: P2[] = v.screws === false ? [] : [[r6(-w / 2 + SCREW.inset), r6(h / 2 - SCREW.inset)], [r6(w / 2 - SCREW.inset), r6(h / 2 - SCREW.inset)]];
  const lines = linesOf(v.words);
  const bottom = armY + HOOK.arm + HOOK.lip + 6;
  const side = v.screws === false ? 8 : SCREW.inset + SCREW.d / 2 + 4;
  const room: KeyRack["room"] = [-w / 2 + side, bottom, w / 2 - side, h / 2 - 6];
  const text = lines.length ? { font: fontOf(v), capHeight: cap, lines, centre: [0, r6((room[1] + room[3]) / 2)] as P2 } : null;
  return { w, h, corner, hooks, armY, reach, slots, screws, text, room };
}

/** A hook's outline (y along the wall, z out from the board), anticlockwise, before the kerf. */
export function hookOutline(r: KeyRack, t: number): P2[] {
  const y = r.armY;
  const { arm, lip, lipThick, tabRoom } = HOOK;
  return round6([
    [y + tabRoom, -t],
    [y + arm - tabRoom, -t],
    [y + arm - tabRoom, 0],
    [y + arm, 0],
    [y + arm, r.reach - lipThick],
    [y + arm + lip, r.reach - lipThick],
    [y + arm + lip, r.reach],
    [y, r.reach],
    [y, 0],
    [y + tabRoom, 0],
  ]);
}

/** Board kept between a screw hole or slot and the board's edge, at least (mm). */
export const EDGE_ROOM = 3;

/** How far a point is inside a w × h rectangle with corners rounded r, centred on the origin (negative = outside). */
export function insideRounded(p: P2, w: number, h: number, r: number): number {
  const [x, y] = [Math.abs(p[0]), Math.abs(p[1])];
  const [cx, cy] = [w / 2 - r, h / 2 - r];
  if (x > cx && y > cy) return r - Math.hypot(x - cx, y - cy);
  return Math.min(w / 2 - x, h / 2 - y);
}

/** The board's edge round the screw holes and slots: the least board left between any of them and the edge (mm). */
export function edgeRoom(r: KeyRack): number {
  const holes = r.screws.map((c) => insideRounded(c, r.w, r.h, r.corner) - SCREW.d / 2);
  // A slot is convex and the board too, so its corners are its nearest points to the edge.
  const slots = r.slots.flatMap((q) => q.map((p) => insideRounded(p, r.w, r.h, r.corner)));
  // And each hook stands wholly on the board (its arm and lip, seen from the front: t wide).
  const t = r.slots.length ? r.slots[0][1][0] - r.slots[0][0][0] : 0;
  const feet = r.hooks.flatMap((x) => [[x - t / 2, r.armY], [x + t / 2, r.armY], [x + t / 2, r.armY + HOOK.arm + HOOK.lip], [x - t / 2, r.armY + HOOK.arm + HOOK.lip]] as P2[]).map((p) => insideRounded(p, r.w, r.h, r.corner));
  return Math.min(Infinity, ...holes, ...slots, ...feet);
}

const asEx = (p: P2[]): Pt[] => p.map(([x, y]) => [lit(x), lit(y)]);
/** A hole's outline moved `half` in all round (the kerf then cuts it back out to its true size). */
const shrink = (pts: Pt[], half: Ex): Pt[] => grow([...pts].reverse(), half).reverse();

export function rackProblems(v: DesignValues): string[] {
  const out = wordsProblems(v);
  if (out.length) return out;
  const r = keyRack(v);
  const [t, kerf] = [num(v, "thickness"), num(v, "kerf")];
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (r.reach < HOOK.lipThick + 10) return [`Make the hooks reach out at least ${mm(HOOK.lipThick + 10)}.`];
  if (r.hooks.length > 1 && r.w / r.hooks.length < 20) return [`That's too many hooks for the board: at most ${Math.floor(r.w / 20)}.`];
  if (edgeRoom(r) < EDGE_ROOM) return [`The corners are rounded too much: the ${r.screws.length && Math.min(...r.screws.map((c) => insideRounded(c, r.w, r.h, r.corner) - SCREW.d / 2)) < EDGE_ROOM ? "screw holes" : "end hooks"} would come too near the edge. Round the corners less.`];
  if (r.room[3] - r.room[1] < 8) return ["The board isn't tall enough for words over the hooks: make it taller."];
  if (r.text) {
    const box = contoursBox(blockContours(r.text));
    if (box && (box[0] < r.room[0] || box[2] > r.room[2] || box[1] < r.room[1] || box[3] > r.room[3]))
      return [`The words don't fit above the hooks (they're ${mm(box[2] - box[0])} × ${mm(box[3] - box[1])}): make the letters smaller or the board bigger.`];
  }
  return [];
}

export const keyRackDesign: LibraryDesign = {
  id: "key-rack",
  name: "Key rack",
  group: "Home",
  description:
    "A board for the wall with words engraved across the top and a row of hooks for keys, lanyards or dog leads. Each hook has a tab that slots into the board — glue it in. Two screw holes hang it up. Shown lying on its back, hooks up.",
  category: "laser",
  prefix: "keyrack",
  laser: { "board-sketch": { text: "engrave" } },
  icon: '<rect x="4" y="10" width="40" height="28" rx="3"/><path d="M12 16h24" opacity=".6"/><path d="M12 30v6h3M22 30v6h3M32 30v6h3"/><circle cx="8" cy="14" r="1.2"/><circle cx="40" cy="14" r="1.2"/>',
  inputs: [
    wordsInput("KEYS", { maxLength: 30 }),
    fontInput("bold"),
    { key: "letters", label: "Letter height", kind: "length", default: 20, min: 4, max: 150 },
    { key: "width", label: "Board width", kind: "length", default: 240, min: 60, max: 580 },
    { key: "height", label: "Board height", kind: "length", default: 100, min: 50, max: 280 },
    { key: "hooks", label: "Hooks", kind: "count", default: 5, min: 1, max: 20 },
    { key: "reach", label: "Hook reach", kind: "length", default: 30, min: 16, max: 100, help: "How far the hooks stick out from the wall." },
    { key: "corner", label: "Corner rounding", kind: "length", default: 8, min: 0, max: 60 },
    { key: "screws", label: "Screw holes", kind: "toggle", default: true, help: "Two holes near the top corners, for 4 mm screws." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 2, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Hooks are drawn this much bigger and slots this much smaller, so the tabs fit snugly." },
  ],
  problems: rackProblems,
  summary: (v) => `A ${mm(num(v, "width"))} × ${mm(num(v, "height"))} board and ${num(v, "hooks")} hook${num(v, "hooks") === 1 ? "" : "s"}.`,
  make: (ctx) => {
    const r = keyRack(ctx.values);
    const [t, kerf] = [num(ctx.values, "thickness"), num(ctx.values, "kerf")];
    const k2 = lit(kerf / 2);
    let plate = shapesSketch([{ type: "rectangle", center: [0, 0], width: r.w, height: r.h }], ctx.scope);
    if (r.corner > 0) plate = roundCorners(plate, lit(r.corner), ctx.scope);
    const holes = r.screws.map((c) => shapesSketch([{ type: "circle", center: c, diameter: r6(SCREW.d - kerf) }], ctx.scope));
    const slots = r.slots.map((s) => outlineSketch(shrink(asEx(s), k2), ctx.scope));
    let s = joinSketches(plate, ...holes, ...slots);
    if (r.text) s = addTextBlock(s, r.text);
    const sk = ctx.id("board-sketch");
    const off = (p: P2) => r.screws.some((c) => Math.hypot(p[0] - c[0], p[1] - c[1]) < SCREW.d / 2) || r.slots.some((q) => insidePolygon(p, q));
    const { sketch, picks } = pickAreas(s, sk, (p) => !off(p), onLetters);
    const board = ctx.id("board");
    const features: Feature[] = [
      sketchFeature(sk, "Board sketch", TOP, sketch),
      // Downwards, so its front face is on the Top plane, where the words are and the hooks stand.
      extrudeFeature(board, "Board", sk, { depth: lit(t), operation: "new", flip: true, areas: picks[0] }),
    ];
    // A plain Remove: it cuts only the latest part, the board just made.
    if (picks[1].length) features.push(extrudeFeature(ctx.id("words"), "Engraved words", sk, { depth: lit(ENGRAVE_DEPTH), operation: "remove", flip: true, areas: picks[1] }));
    const hook = ctx.id("hook");
    const first = r.hooks[0];
    features.push(
      sketchFeature(ctx.id("hook-sketch"), "Hook sketch", RIGHT, outlineSketch(grow(asEx(hookOutline(r, t)), k2), ctx.scope)),
      extrudeFeature(hook, "Hook 1", ctx.id("hook-sketch"), { depth: lit(t), operation: "new" }),
      moveFeature(ctx.id("hook-move"), "Hook 1 in place", hook, { dx: lit(r6(first - t / 2)) }),
    );
    const partNames: Record<string, string> = { [board]: `${ctx.name} board`, [hook]: `${ctx.name} hook 1` };
    r.hooks.slice(1).forEach((x, i) => {
      const id = ctx.id(`hook-${i + 2}`);
      features.push(copyFeature(id, `Hook ${i + 2}`, hook, { dx: lit(r6(x - first)) }));
      partNames[id] = `${ctx.name} hook ${i + 2}`;
    });
    return { features, partNames };
  },
  preview: (v) => {
    const r = keyRack(v);
    const t = num(v, "thickness");
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(r.w, r.h, r.corner) }];
    for (const s of r.slots) out.push({ kind: "poly", closed: true, points: s });
    for (const c of r.screws) out.push({ kind: "circle", c, r: SCREW.d / 2 });
    if (r.text) for (const c of blockContours(r.text)) out.push({ kind: "poly", closed: true, points: c });
    // A hook, side on, beside the board.
    out.push({ kind: "poly", closed: true, faint: true, points: hookOutline(r, t).map(([y, z]) => [r.w / 2 + 10 + z + t, y] as P2) });
    return out;
  },
};
