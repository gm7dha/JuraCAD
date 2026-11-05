/**
 * Gridfinity storage — Zack Freedman's open, modular standard: a baseplate of square cells that bins drop into and
 * click into place, and bins that also stack on each other. The sizes are the standard's, as documented on
 * gridfinity.xyz, in the Printables "Gridfinity Specification" (model 417152) and in gridfinity-rebuilt-openscad
 * (src/core/standard.scad and gridfinity-baseplate.scad), the implementation most generators follow:
 *
 *  - grid 42 mm; height unit 7 mm (a bin "H units" tall is 7 × H mm to the top of its wall, without the lip);
 *  - a bin is 42 × n − 0.5 mm across (a gap of 0.25 mm each side), its corners rounded 3.75 mm; the baseplate's
 *    cells are 42 mm at the top, rounded 4 mm;
 *  - the bin's foot (BASE_PROFILE [0,0] [0.8,0.8] [0.8,2.6] [2.95,4.75]): from the bottom 0.8 mm out at 45°, 1.8 mm
 *    straight up, 2.15 mm out at 45° — 4.75 mm tall, 35.6 → 41.5 mm across, corner radius 0.8 → 3.75 mm;
 *  - the baseplate's pocket (_BASEPLATE_PROFILE [0,0] [0.7,0.7] [0.7,2.5] [2.85,4.65]): 0.7 at 45°, 1.8 up, 2.15 at
 *    45° — 4.65 mm tall above 0.35 mm straight (BASEPLATE_HEIGHT 5), 36.3 → 42 mm across, radius 1.15 → 4 mm;
 *  - the stacking lip (STACKING_LIP_LINE [0,0] [0.7,0.7] [0.7,2.5] [2.6,4.4]): the same steps as the baseplate,
 *    0.7 at 45°, 1.8 up, 1.9 at 45°, rising 4.4 mm above the wall to a sharp edge at the outside; under it 1.2 mm
 *    straight (STACKING_LIP_SUPPORT_HEIGHT) and then a 45° slope back to the wall, so it prints without supports;
 *  - magnets 6 × 2 mm: holes 6.5 mm across and 2.4 mm deep (MAGNET_HOLE_RADIUS, MAGNET_HOLE_DEPTH) in the bottom of
 *    each foot, 13 mm from its middle each way (26 mm apart, 8 mm in from the cell's side).
 *
 * The stepped outlines are ruled Lofts (straight between rounded rectangles one above another, `loftRuled`): the
 * offset of a rounded rectangle is another with the corner radius changed by the same amount, so straight sides
 * between them are exact 45° slopes. Their heights are the standard's, fixed, so they're sketched on level planes
 * (`levelPlane`) rather than following variables; every size here is changed with Edit design sizes.
 */
import { lit } from "../ex";
import { extrudeFeature, outlineSketch, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { gridPatternFeature, levelPlane, loftFeature } from "../printKit";
import type { Feature } from "../../model/types";
import type { SketchPlane } from "../../sketch/planes";
import type { SketchData } from "../../sketch/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, roundedRect } from "./common";

/** The grid (mm) and the height unit (mm). */
export const GRID = 42;
export const UNIT = 7;
/** Bins: the standard gap each side (mm) and corner radius with it (4 − gap). */
export const BIN_GAP = 0.25;
/** The baseplate: its height, corner radius, and the straight part under the pocket's profile. */
export const PLATE_HEIGHT = 5;
export const PLATE_RADIUS = 4;
export const PLATE_CLEAR = 0.35;
/** How tall the bin's foot is (its profile), and the stacking lip above the wall. */
export const FOOT_HEIGHT = 4.75;
export const LIP_HEIGHT = 4.4;
/** How far in from the bin's outside the lip reaches, and the straight support under it. */
export const LIP_DEPTH = 2.6;
export const LIP_SUPPORT = 1.2;
/** Magnet holes: across, deep, and how far from the cell's middle each way. */
export const MAGNET = { d: 6.5, depth: 2.4, at: 13 };
/** Dividers' thickness. */
export const DIVIDER = 1.2;
/** How far the label ledge reaches into the walls, so it joins them (mm). */
const INTO_WALL = 0.02;
/**
 * Where a bin rests in a baseplate's cell: its bottom level with the plate's (its slopes then just touch the pocket's).
 * `CENTRED` is half-way up the pocket's straight bottom part, where it has the gap on every side — used to check the fit.
 */
export const RESTS = 0;
export const CENTRED = PLATE_CLEAR;

/** A height and how far in from a rounded rectangle an outline is there (its corner radius smaller by as much). */
export interface Step {
  z: number;
  inset: number;
}

/** The bin's foot, from the bottom (insets from the cell's top outline, 42 − 2 × gap across). */
export const FOOT_STEPS: Step[] = [
  { z: 0, inset: 2.95 },
  { z: 0.8, inset: 2.15 },
  { z: 2.6, inset: 2.15 },
  { z: FOOT_HEIGHT, inset: 0 },
];

/**
 * A baseplate cell's pocket, from below the bed to above the top (insets from 42 mm, radius 4): straight from under
 * the bed to 0.35, then 0.7 at 45°, 1.8 up, 2.15 at 45° to the top — and on past it, so the cut runs out cleanly.
 */
export const POCKET_STEPS: Step[] = [
  { z: -1, inset: 2.85 },
  { z: PLATE_CLEAR, inset: 2.85 },
  { z: PLATE_CLEAR + 0.7, inset: 2.15 },
  { z: PLATE_CLEAR + 2.5, inset: 2.15 },
  { z: PLATE_HEIGHT, inset: 0 },
  { z: PLATE_HEIGHT + 1, inset: -1 },
];

export const countOf = (v: DesignValues, k: string, lo = 1) => Math.max(lo, Math.round(num(v, k)));

/** Area of a rounded rectangle (mm²). */
export const area = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r;

/**
 * Volume (mm³) between a stack of outlines (a rounded rectangle w × h, radius r, each step inset from it), between
 * heights lo and hi. The area is a quadratic in the inset, which changes steadily between steps, so Simpson's rule is exact.
 */
export function stepsVolume(w: number, h: number, r: number, steps: Step[], lo = -Infinity, hi = Infinity): number {
  const at = (s: number) => area(w - 2 * s, h - 2 * s, r - s);
  let v = 0;
  for (let i = 0; i + 1 < steps.length; i++) {
    const [a, b] = [steps[i], steps[i + 1]];
    const za = Math.max(a.z, lo);
    const zb = Math.min(b.z, hi);
    if (zb <= za || b.z <= a.z) continue;
    const s = (z: number) => a.inset + ((b.inset - a.inset) * (z - a.z)) / (b.z - a.z);
    v += ((zb - za) / 6) * (at(s(za)) + 4 * at(s((za + zb) / 2)) + at(s(zb)));
  }
  return v;
}

/** A rounded rectangle centred on (cx, cy), as a sketch. */
export function roundedSketch(w: number, h: number, r: number, cx: number, cy: number, scope: Record<string, number>): SketchData {
  const s = shapesSketch([{ type: "rectangle", center: [String(round6(cx)), String(round6(cy))], width: String(round6(w)), height: String(round6(h)) }], scope);
  return roundCorners(s, lit(round6(r)), scope);
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * A stack of rounded rectangles one above another (each on a level plane) and the ruled Loft through them. Returns
 * the sketches and the loft (`role` names them: "<role>-0"… and "<role>").
 */
export function steppedLoft(ctx: MakeContext, role: string, label: string, w: number, h: number, r: number, centre: [number, number], steps: Step[], operation: "add" | "remove"): Feature[] {
  const sketches = steps.map((s, i) => {
    const plane: SketchPlane = levelPlane(`${mm(s.z)} up`, s.z);
    return sketchFeature(ctx.id(`${role}-${i}`), `${label} outline ${i + 1}`, plane, roundedSketch(w - 2 * s.inset, h - 2 * s.inset, r - s.inset, centre[0], centre[1], ctx.scope));
  });
  return [...sketches, loftFeature(ctx.id(role), label, sketches.map((s) => s.id), operation)];
}

/** Where the middle of the first cell is (the bin or baseplate centred on the origin). */
export const firstCell = (across: number, along: number): [number, number] => [(-GRID * (across - 1)) / 2, (-GRID * (along - 1)) / 2];

// ---------------------------------------------------------------------------------------------------------------
// Baseplate

export const gridfinityBaseplate: LibraryDesign = {
  id: "gridfinity-baseplate",
  name: "Gridfinity baseplate",
  description:
    "The grid that Gridfinity bins sit in: square cells 42 mm apart with the standard stepped edges, so any Gridfinity bin (yours, or one downloaded) drops in and stays put, and you can rearrange them whenever you like. Glue or tape it into a drawer, or just lay it on a shelf. It's the light, open style: it prints quickly, flat on the bed, no supports.",
  category: "print",
  group: "Gridfinity",
  prefix: "gridplate",
  icon: '<rect x="5" y="5" width="38" height="38" rx="3"/><rect x="9" y="9" width="13" height="13" rx="2" opacity=".55"/><rect x="26" y="9" width="13" height="13" rx="2" opacity=".55"/><rect x="9" y="26" width="13" height="13" rx="2" opacity=".55"/><rect x="26" y="26" width="13" height="13" rx="2" opacity=".55"/>',
  inputs: [
    { key: "across", label: "Cells across", kind: "count", default: 3, min: 1, max: 8, help: "Left to right. Each cell is 42 mm." },
    { key: "along", label: "Cells front to back", kind: "count", default: 3, min: 1, max: 8 },
  ],
  problems: () => [],
  summary: (v) => {
    const [x, y] = [countOf(v, "across") * GRID, countOf(v, "along") * GRID];
    const big = Math.max(x, y) > 180 ? " Check it fits your printer's bed (180 mm on an A1 mini, 256 mm on most others): if not, make two smaller ones and lay them side by side." : "";
    return `${countOf(v, "across") * countOf(v, "along")} cells, ${mm(x)} × ${mm(y)} and ${mm(PLATE_HEIGHT)} high.${big}`;
  },
  make: (ctx) => {
    const n = countOf(ctx.values, "across");
    const m = countOf(ctx.values, "along");
    const id = ctx.id("plate");
    const top = { kind: "default", name: "Top" } as const;
    const features: Feature[] = [
      sketchFeature(ctx.id("plate-sketch"), "Baseplate sketch", top, roundedSketch(GRID * n, GRID * m, PLATE_RADIUS, 0, 0, ctx.scope)),
      extrudeFeature(id, "Baseplate", ctx.id("plate-sketch"), { depth: lit(PLATE_HEIGHT), operation: "new" }),
      ...steppedLoft(ctx, "pocket", "Cell", GRID, GRID, PLATE_RADIUS, firstCell(n, m), POCKET_STEPS, "remove"),
    ];
    if (n * m > 1) features.push(gridPatternFeature(ctx.id("pockets"), "Cells", [ctx.id("pocket")], n, lit(GRID), m, lit(GRID)));
    return { features, partNames: { [id]: `${ctx.name} ${n}×${m}` } };
  },
  preview: (v) => cellsPreview(countOf(v, "across"), countOf(v, "along"), GRID, PLATE_RADIUS, GRID - 2 * 2.85, PLATE_RADIUS - 2.85),
};

export function cellsPreview(n: number, m: number, cell: number, r: number, inner: number, ri: number): PreviewShape[] {
  const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(GRID * n - (GRID - cell), GRID * m - (GRID - cell), r) }];
  const [x0, y0] = firstCell(n, m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out.push({ kind: "poly", closed: true, faint: true, points: roundedRect(inner, inner, Math.max(0, ri), x0 + GRID * i, y0 + GRID * j) });
  out.push({ kind: "text", at: [0, (-GRID * m) / 2 - 8], text: `${n} × ${m} cells, ${mm(GRID * n)} × ${mm(GRID * m)}` });
  return out;
}

/** For tests: the baseplate's volume (mm³). */
export function baseplateVolume(v: DesignValues): number {
  const [n, m] = [countOf(v, "across"), countOf(v, "along")];
  return area(GRID * n, GRID * m, PLATE_RADIUS) * PLATE_HEIGHT - n * m * stepsVolume(GRID, GRID, PLATE_RADIUS, POCKET_STEPS, 0, PLATE_HEIGHT);
}

// ---------------------------------------------------------------------------------------------------------------
// Bin

/** A bin's sizes and heights (mm), worked out from its values. */
export function binPlan(v: DesignValues) {
  const w = countOf(v, "across");
  const d = countOf(v, "along");
  const units = countOf(v, "units", 2);
  const gap = num(v, "fit");
  const wall = num(v, "wall");
  const lip = v.lip !== false;
  const cell = GRID - 2 * gap;
  const radius = PLATE_RADIUS - gap;
  const outer: [number, number] = [GRID * w - 2 * gap, GRID * d - 2 * gap];
  const inner: [number, number] = [outer[0] - 2 * wall, outer[1] - 2 * wall];
  const wallTop = UNIT * units;
  const top = lip ? wallTop + LIP_HEIGHT : wallTop;
  const floorTop = FOOT_HEIGHT + num(v, "floor");
  /** Where the support under the lip starts sloping in from the wall (the plain wall's top, without a lip). */
  const support = lip ? wallTop - LIP_SUPPORT - (LIP_DEPTH - wall) : wallTop;
  const dividers = Math.max(0, Math.round(num(v, "dividers")));
  const dividerTop = support - 0.4;
  const label = v.label === true;
  const ledge = num(v, "ledge");
  const ledgeTop = support - 0.8;
  /** The space inside, from the floor up (insets from the outside). */
  const cavity: Step[] = lip
    ? [
        { z: floorTop, inset: wall },
        { z: support, inset: wall },
        { z: wallTop - LIP_SUPPORT, inset: LIP_DEPTH },
        { z: wallTop, inset: LIP_DEPTH },
        { z: wallTop + 0.7, inset: 1.9 },
        { z: wallTop + 2.5, inset: 1.9 },
        { z: wallTop + LIP_HEIGHT + 1, inset: -1 },
      ]
    : [
        { z: floorTop, inset: wall },
        { z: wallTop + 1, inset: wall },
      ];
  /** Each compartment's width between dividers. */
  const compartment = (inner[0] - dividers * DIVIDER) / (dividers + 1);
  return { w, d, units, gap, wall, lip, cell, radius, outer, inner, wallTop, top, floorTop, support, dividers, dividerTop, label, ledge, ledgeTop, cavity, compartment, magnets: v.magnets === true };
}

export const gridfinityBin: LibraryDesign = {
  id: "gridfinity-bin",
  name: "Gridfinity bin",
  description:
    "A Gridfinity storage bin, any number of cells wide and deep and 7 mm height units tall: it drops into a Gridfinity baseplate, and with the stacking lip on top another bin sits on it too. Add dividers, a ledge for a label, and holes in the feet for 6 × 2 mm magnets (press them in, or a drop of glue). It prints standing as it is, no supports.",
  category: "print",
  group: "Gridfinity",
  prefix: "gridbin",
  icon: '<path d="M6 16l4-4h28l4 4v24H6z"/><path d="M6 16h36" opacity=".55"/><path d="M24 16v24" opacity=".55"/><path d="M9 40l2 3h26l2-3" opacity=".7"/>',
  inputs: [
    { key: "across", label: "Cells across", kind: "count", default: 2, min: 1, max: 8, help: "Left to right, in 42 mm cells." },
    { key: "along", label: "Cells front to back", kind: "count", default: 1, min: 1, max: 8 },
    { key: "units", label: "Height units", kind: "count", default: 3, min: 2, max: 20, help: "7 mm each: 3 units is 21 mm to the top of the wall, plus the lip." },
    { key: "lip", label: "Stacking lip", kind: "toggle", default: true, help: "A rim on top that another bin's feet sit in." },
    { key: "dividers", label: "Dividers", kind: "count", default: 0, min: 0, max: 9, help: "Walls across, splitting it into equal compartments left to right." },
    { key: "label", label: "Label ledge", kind: "toggle", default: false, help: "A shelf along the back, just under the top, for a label (and to grab the bin by)." },
    { key: "ledge", label: "Label ledge depth", kind: "length", default: 10, min: 5, max: 20, help: "How far the ledge comes forward from the back wall." },
    { key: "magnets", label: "Magnet holes", kind: "toggle", default: false, help: "Four holes under each cell for 6 × 2 mm round magnets. They only hold if the baseplate has magnets too, or sits on steel." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 1.2, min: 1.2, max: 2.4, help: "1.2 mm is three lines with a 0.4 mm nozzle." },
    { key: "floor", label: "Floor thickness", kind: "length", default: 2.25, min: 0.8, max: 10, help: "Above the feet. 2.25 mm puts the floor 7 mm up, as most bins have it." },
    { key: "fit", label: "Gap each side", kind: "length", default: BIN_GAP, min: 0, max: 0.5, help: "Gridfinity's standard is 0.25 mm, so the bin fits anyone's baseplate. Only change it if your bins come out tight." },
  ],
  problems: (v) => {
    const p = binPlan(v);
    const out: string[] = [];
    if (p.lip && p.support < p.floorTop + 1) out.push(`It's too short for a stacking lip with this floor: make it at least ${Math.ceil((p.floorTop + 1 + LIP_SUPPORT + LIP_DEPTH - p.wall) / UNIT)} units tall, or the floor thinner.`);
    if (!p.lip && p.wallTop < p.floorTop + 2) out.push(`It's too short for this floor: make it taller, or the floor thinner.`);
    if (p.dividers > 0 && p.compartment < 8) out.push(`${p.dividers} dividers leave compartments only ${mm(p.compartment)} wide: use fewer dividers, or a wider bin.`);
    if (p.label && p.ledgeTop - p.ledge < p.floorTop) out.push(`A label ledge ${mm(p.ledge)} deep doesn't fit in a bin this short: make the ledge at most ${mm(Math.max(0, Math.floor((p.ledgeTop - p.floorTop) * 10) / 10))} deep, or the bin taller.`);
    return out;
  },
  summary: (v) => {
    const p = binPlan(v);
    const big = Math.max(...p.outer) > 180 ? " Check it fits your printer's bed (180 mm on an A1 mini, 256 mm on most others)." : "";
    return `${p.w} × ${p.d} cells, ${p.units} units: ${mm(p.outer[0])} × ${mm(p.outer[1])} and ${mm(p.top)} tall${p.lip ? " with its stacking lip" : ""}${p.dividers ? `, ${p.dividers + 1} compartments ${mm(p.compartment)} wide` : ""}.${big}`;
  },
  make: (ctx) => {
    const p = binPlan(ctx.values);
    const id = ctx.id("bin");
    const [W, D] = p.outer;
    const features: Feature[] = [
      sketchFeature(ctx.id("body-sketch"), "Bin outline", levelPlane(`${mm(FOOT_HEIGHT)} up`, FOOT_HEIGHT), roundedSketch(W, D, p.radius, 0, 0, ctx.scope)),
      extrudeFeature(id, "Bin", ctx.id("body-sketch"), { depth: lit(round6(p.top - FOOT_HEIGHT)), operation: "new" }),
      // One foot under the first cell, then copied under every cell.
      ...steppedLoft(ctx, "foot", "Foot", p.cell, p.cell, p.radius, firstCell(p.w, p.d), FOOT_STEPS, "add"),
    ];
    if (p.w * p.d > 1) features.push(gridPatternFeature(ctx.id("feet"), "Feet", [ctx.id("foot")], p.w, lit(GRID), p.d, lit(GRID)));
    if (p.magnets) {
      const [cx, cy] = firstCell(p.w, p.d);
      const holes = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ type: "circle", center: [String(round6(cx + sx * MAGNET.at)), String(round6(cy + sy * MAGNET.at))], diameter: String(MAGNET.d) })));
      features.push(
        sketchFeature(ctx.id("magnet-sketch"), "Magnet holes sketch", { kind: "default", name: "Top" }, shapesSketch(holes, ctx.scope)),
        extrudeFeature(ctx.id("magnets"), "Magnet holes", ctx.id("magnet-sketch"), { depth: lit(MAGNET.depth), operation: "remove" }),
      );
      if (p.w * p.d > 1) features.push(gridPatternFeature(ctx.id("magnets-all"), "Magnet holes under every cell", [ctx.id("magnets")], p.w, lit(GRID), p.d, lit(GRID)));
    }
    features.push(...steppedLoft(ctx, "inside", "Inside", W, D, p.radius, [0, 0], p.cavity, "remove"));
    if (p.dividers > 0) {
      const [wi, di] = p.inner;
      const bars = Array.from({ length: p.dividers }, (_, k) => ({
        type: "rectangle",
        center: [String(round6(-wi / 2 + (k + 1) * p.compartment + (k + 0.5) * DIVIDER)), "0"],
        width: String(DIVIDER),
        // Half into the front and back walls, so they join.
        height: String(round6(di + p.wall)),
      }));
      features.push(
        sketchFeature(ctx.id("divider-sketch"), "Dividers sketch", levelPlane(`${mm(p.floorTop)} up`, p.floorTop), shapesSketch(bars, ctx.scope)),
        extrudeFeature(ctx.id("dividers"), "Dividers", ctx.id("divider-sketch"), { depth: lit(round6(p.dividerTop - p.floorTop)), operation: "add" }),
      );
    }
    if (p.label) {
      // Seen from the right (across = Y, up = Z): a 45° wedge under a flat top, along the back wall, so it prints without supports.
      const back = D / 2 - p.wall;
      const e = INTO_WALL;
      const pt = (y: number, z: number) => [lit(round6(y)), lit(round6(z))] as [ReturnType<typeof lit>, ReturnType<typeof lit>];
      const wedge = [pt(back + e, p.ledgeTop), pt(back - p.ledge, p.ledgeTop), pt(back + e, p.ledgeTop - p.ledge - e)];
      features.push(
        sketchFeature(ctx.id("label-sketch"), "Label ledge sketch", { kind: "default", name: "Right" }, outlineSketch(wedge, ctx.scope)),
        extrudeFeature(ctx.id("label"), "Label ledge", ctx.id("label-sketch"), { depth: lit(round6(p.inner[0] + 2 * e)), end: "symmetric", operation: "add" }),
      );
    }
    return { features, partNames: { [id]: `${ctx.name} ${p.w}×${p.d}×${p.units}` } };
  },
  preview: (v) => {
    const p = binPlan(v);
    const out = cellsPreview(p.w, p.d, p.cell, p.radius, p.cell - 2 * 2.95, p.radius - 2.95);
    out.splice(1, 0, { kind: "poly", closed: true, points: roundedRect(p.inner[0], p.inner[1], Math.max(0, p.radius - p.wall)) });
    for (let k = 0; k < p.dividers; k++) {
      const x = -p.inner[0] / 2 + (k + 1) * p.compartment + (k + 0.5) * DIVIDER;
      out.push({ kind: "poly", points: [[x, -p.inner[1] / 2], [x, p.inner[1] / 2]] });
    }
    if (p.label) out.push({ kind: "poly", closed: true, points: roundedRect(p.inner[0], p.ledge, 0, 0, p.inner[1] / 2 - p.ledge / 2) });
    out[out.length - 1 - (p.label ? 1 : 0) - p.dividers] = { kind: "text", at: [0, -p.outer[1] / 2 - 8], text: `${p.w} × ${p.d} × ${p.units} units, ${mm(p.top)} tall` };
    return out;
  },
};

/** For tests: the bin's volume (mm³). */
export function binVolume(v: DesignValues): number {
  const p = binPlan(v);
  const [W, D] = p.outer;
  let vol = area(W, D, p.radius) * (p.top - FOOT_HEIGHT);
  vol += p.w * p.d * stepsVolume(p.cell, p.cell, p.radius, FOOT_STEPS);
  if (p.magnets) vol -= p.w * p.d * 4 * Math.PI * (MAGNET.d / 2) ** 2 * MAGNET.depth;
  vol -= stepsVolume(W, D, p.radius, p.cavity, -Infinity, p.top);
  vol += p.dividers * DIVIDER * p.inner[1] * (p.dividerTop - p.floorTop);
  if (p.label) {
    // A triangle L × L along the inside, less what overlaps the inside's rounded back corners (worked out in slices).
    const L = p.ledge;
    const rho = p.radius - p.wall;
    let corner = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const s = ((i + 0.5) / n) * Math.min(rho, L);
      const outside = rho - Math.sqrt(Math.max(0, rho * rho - (rho - s) ** 2));
      corner += (L - s) * outside * (Math.min(rho, L) / n);
    }
    vol += (L * L * p.inner[0]) / 2 - 2 * corner;
    // The dividers already fill their share of it.
    vol -= (p.dividers * DIVIDER * L * L) / 2;
  }
  return vol;
}
