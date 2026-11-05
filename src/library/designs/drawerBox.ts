/**
 * A box of drawers: a finger-jointed case open at the front (a finger box made on its back, boxPanels.ts "onBack": its
 * back, floor, top and two sides), shelves between the drawers held by tabs through slots in the sides, and N drawers —
 * each an open-topped finger box with a pull slot in its front — that slide in with `clearance` all round.
 *
 * Case coordinates: x across (0…W), y from the front (0, open) to the back (D), z up (0…H). Inside: x t…W − t, y 0…D − t,
 * z t…H − t. The space between the floor and top is shared by the N drawers and N − 1 shelves:
 * each drawer's space is s = (H − 2t − (N − 1)t) / N high; shelf i (1…N − 1) lies at z = t + i·s + (i − 1)·t.
 * Drawer i (0…N − 1) stands on the floor or a shelf at z = t + i(s + t), x = t + c…W − t − c, y = 0…D − t − c (its front
 * flush with the case's), and is s − c high, so it has c above, either side and behind: it slides out of the front and
 * nothing else.
 */
import { lit } from "../ex";
import { boxProblems, fingerCounts, type BoxSizes } from "../fingers";
import { boxFeatures, panelsFit, plateSketch, type PlateHole } from "../boxPanels";
import { fitsBed, offsetPolygon, r6, type P2 } from "../outlines";
import { extrudeFeature, moveFeature, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import { mm, num } from "./common";

/** The pull slot: this tall (finger room), its top this far below the drawer front's top edge (mm). */
export const PULL = { height: 14, below: 6 };
/** A drawer must be at least this high (mm), so its pull slot fits. */
export const MIN_DRAWER = 35;
/** Shelf tabs: across the middle 40% of the depth. */
export const SHELF_TAB = [0.3, 0.7] as const;

export interface DrawerBox {
  /** The case as a finger box made on its back: W across, D = the case's height, H = the case's depth. */
  caseBox: BoxSizes;
  W: number;
  D: number;
  H: number;
  t: number;
  kerf: number;
  c: number;
  n: number;
  /** Each drawer's space, floor to shelf. */
  space: number;
  /** The shelves' undersides (z). */
  shelves: number[];
  /** Where the shelf tabs run (y). */
  tab: [number, number];
  /** Each drawer: a finger box, and where its corner goes. */
  drawer: BoxSizes;
  drawerAt: { dx: number; dy: number; dz: number }[];
  /** The pull slot in each drawer's front (its own x, z): centres of the round ends, and how tall. */
  pull: { a: P2; b: P2; w: number };
}

export function drawerBox(v: DesignValues): DrawerBox {
  const [W, D, H, n, c, pullW, t, kerf, finger] = ["width", "depth", "height", "drawers", "clearance", "pull", "thickness", "kerf", "finger"].map((k) => num(v, k));
  const caseBox: BoxSizes = { W: lit(W), D: lit(H), H: lit(D), t: lit(t), kerf: lit(kerf), lid: false, finger };
  const space = (H - 2 * t - (n - 1) * t) / n;
  const shelves = Array.from({ length: n - 1 }, (_, i) => r6(t + (i + 1) * space + i * t));
  const dw = r6(W - 2 * t - 2 * c);
  const dd = r6(D - t - c);
  const dh = r6(space - c);
  const drawer: BoxSizes = { W: lit(dw), D: lit(dd), H: lit(dh), t: lit(t), kerf: lit(kerf), lid: false, finger };
  const drawerAt = Array.from({ length: n }, (_, i) => ({ dx: r6(t + c), dy: 0, dz: r6(t + i * (space + t)) }));
  const zc = r6(dh - PULL.below - PULL.height / 2);
  const half = Math.max(0, Math.min(pullW, dw - 2 * t - 20) - PULL.height) / 2;
  const inside = D - t;
  return {
    caseBox,
    W,
    D,
    H,
    t,
    kerf,
    c,
    n,
    space: r6(space),
    shelves,
    tab: [r6(inside * SHELF_TAB[0]), r6(inside * SHELF_TAB[1])],
    drawer,
    drawerAt,
    pull: { a: [r6(dw / 2 - half), zc], b: [r6(dw / 2 + half), zc], w: PULL.height },
  };
}

/** A shelf seen from above, true size: the inside width with a tab out through each side. */
export function shelfOutline(d: DrawerBox): P2[] {
  const { W, D, t } = d;
  const [ya, yb] = d.tab;
  const back = r6(D - t);
  return [
    [t, 0],
    [W - t, 0],
    [W - t, ya],
    [W, ya],
    [W, yb],
    [W - t, yb],
    [W - t, back],
    [t, back],
    [t, yb],
    [0, yb],
    [0, ya],
    [t, ya],
  ].map(([x, y]): P2 => [r6(x), r6(y)]);
}

/** The slots in a side for the shelves' tabs, true size, in the side's sketch (Right plane: y, z). */
export function sideSlots(d: DrawerBox): PlateHole[] {
  const [ya, yb] = d.tab;
  return d.shelves.map((z): PlateHole => ({
    kind: "poly",
    points: [
      [ya, z],
      [yb, z],
      [yb, r6(z + d.t)],
      [ya, r6(z + d.t)],
    ],
  }));
}

const pullHole = (d: DrawerBox): PlateHole[] => (d.pull.b[0] - d.pull.a[0] > 1e-6 ? [{ kind: "slot", ...d.pull }] : [{ kind: "circle", c: d.pull.a, d: d.pull.w }]);

export function drawerProblems(v: DesignValues): string[] {
  const d = drawerBox(v);
  const out = boxProblems(d.caseBox);
  if (out.length) return out;
  if (d.space - d.c < MIN_DRAWER) return [`The drawers would be only ${mm(d.space - d.c)} high: make the box taller, or have fewer drawers (each needs at least ${mm(MIN_DRAWER)}).`];
  const inner = boxProblems(d.drawer);
  if (inner.length) return inner.map((p) => `The drawers: ${p.charAt(0).toLowerCase()}${p.slice(1)}`);
  if (d.c * 2 >= d.t) out.push(`A clearance of ${mm(d.c)} is a lot: the drawers would rattle about. About 0.5 mm is plenty.`);
  if (!panelsFit(d.caseBox, fitsBed)) out.push("The box is too big for the laser's 600 × 300 mm bed.");
  return out;
}

export const drawerBoxDesign: LibraryDesign = {
  id: "drawer-box",
  name: "Box with drawers",
  group: "Boxes and stands",
  description:
    "A little chest of drawers for a desk or workbench: a finger-jointed case with shelves between the drawers, and drawers that are finger-jointed trays with a pull slot in the front. They slide in with a small clearance all round, so they run smoothly but don't wobble. Shown put together.",
  category: "laser",
  prefix: "drawers",
  icon: '<path d="M8 8h32v34H8z"/><path d="M11 12h26v8H11zM11 24h26v8H11z" opacity=".7"/><path d="M21 16h6M21 28h6M21 38h6" />',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 200, min: 60, max: 400, help: "Outside sizes of the case." },
    { key: "depth", label: "Depth", kind: "length", default: 150, min: 50, max: 290 },
    { key: "height", label: "Height", kind: "length", default: 150, min: 50, max: 290 },
    { key: "drawers", label: "Drawers", kind: "count", default: 3, min: 1, max: 6, help: "Stacked one above the other." },
    { key: "clearance", label: "Room round the drawers", kind: "length", default: 0.5, min: 0.1, max: 3, help: "Each side, above and behind, so they slide easily." },
    { key: "pull", label: "Pull slot width", kind: "length", default: 40, min: 14, max: 150, help: "The finger slot in each drawer front." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 10, min: 2, max: 100, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: drawerProblems,
  summary: (v) => {
    const d = drawerBox(v);
    const fc = fingerCounts(d.drawer);
    return `${5 + (d.n - 1) + 5 * d.n} pieces: the case, ${d.n - 1} shel${d.n - 1 === 1 ? "f" : "ves"} and ${d.n} drawer${d.n === 1 ? "" : "s"} ${mm(d.drawer.W.v)} × ${mm(d.drawer.D.v)} × ${mm(d.drawer.H.v)} (${fc.width} fingers across).`;
  },
  make: (ctx) => {
    const d = drawerBox(ctx.values);
    const k2 = Math.max(0, d.kerf) / 2;
    const slots = sideSlots(d);
    const made = boxFeatures(ctx, {
      b: d.caseBox,
      stance: "onBack",
      panels: { bottom: "Back", front: "Floor", back: "Top", left: "Left side", right: "Right side" },
      sketchHoles: { left: slots, right: slots },
    });
    const features: Feature[] = [...made.features];
    const partNames = { ...made.partNames };
    d.shelves.forEach((z, i) => {
      const role = `shelf-${i + 1}`;
      const label = d.shelves.length > 1 ? `Shelf ${i + 1}` : "Shelf";
      features.push(
        sketchFeature(ctx.id(`${role}-sketch`), `${label} sketch`, { kind: "default", name: "Top" }, plateSketch(offsetPolygon(shelfOutline(d), k2), [], ctx.scope)),
        extrudeFeature(ctx.id(role), label, ctx.id(`${role}-sketch`), { depth: lit(d.t), operation: "new" }),
        moveFeature(ctx.id(`${role}-move`), `${label} in place`, ctx.id(role), { dz: lit(z) }),
      );
      partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`;
    });
    d.drawerAt.forEach((at, i) => {
      const n = i + 1;
      const name = d.n > 1 ? `Drawer ${n}` : "Drawer";
      const m = boxFeatures(ctx, {
        b: d.drawer,
        stance: "upright",
        prefix: `drawer-${n}-`,
        panels: { bottom: `${name} bottom`, front: `${name} front`, back: `${name} back`, left: `${name} left side`, right: `${name} right side` },
        holes: { front: pullHole(d) },
        shift: at,
      });
      features.push(...m.features);
      Object.assign(partNames, m.partNames);
    });
    return { features, partNames };
  },
  preview: (v) => {
    if (drawerProblems(v).length) return [];
    const d = drawerBox(v);
    const rect = (x0: number, y0: number, x1: number, y1: number): P2[] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: rect(0, 0, d.W, d.H) }];
    out.push({ kind: "poly", closed: true, faint: true, points: rect(d.t, d.t, d.W - d.t, d.H - d.t) });
    for (const z of d.shelves) out.push({ kind: "poly", closed: true, points: rect(d.t, z, d.W - d.t, z + d.t) });
    for (const at of d.drawerAt) {
      const [x0, z0] = [at.dx, at.dz];
      out.push({ kind: "poly", closed: true, points: rect(x0, z0, x0 + d.drawer.W.v, z0 + d.drawer.H.v) });
      const [a, b] = [d.pull.a, d.pull.b];
      out.push({ kind: "poly", closed: true, points: rect(x0 + a[0] - d.pull.w / 2, z0 + a[1] - d.pull.w / 2, x0 + b[0] + d.pull.w / 2, z0 + b[1] + d.pull.w / 2) });
    }
    out.push({ kind: "text", at: [d.W / 2, -8], text: "from the front" });
    return out;
  },
};
