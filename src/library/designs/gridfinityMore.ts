/**
 * More Gridfinity (see gridfinity.ts for the standard's sizes and where they come from): a baseplate with magnets
 * under each bin corner, a bit / screwdriver holder that drops into the grid, and a "lite" bin with thin walls and
 * hollow feet that prints quickly. All of them reuse the bins' and baseplate's stepped outlines (ruled Lofts on level
 * planes), so, like the others, they have no variables: change them with Edit design sizes.
 *
 * The magnet baseplate is the open baseplate standing on a solid floor: the same pocket in every cell, starting at
 * the floor's top, and in the floor four magnet holes 6.5 mm across and 2.4 mm deep (MAGNET: for 6 × 2 mm magnets,
 * gridfinity-rebuilt-openscad's MAGNET_HOLE_RADIUS / MAGNET_HOLE_DEPTH) 13 mm from the cell's middle each way, right
 * under the magnet holes in a bin's feet. A bin rests on the floor exactly where its slopes meet the pocket's.
 */
import { lit } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { gridPatternFeature, levelPlane } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { hexagon } from "../../model/fasteners";
import { mm, num, roundedRect } from "./common";
import { hexArea } from "./boltSizes";
import {
  area,
  BIN_GAP,
  cellsPreview,
  countOf,
  firstCell,
  FOOT_HEIGHT,
  FOOT_STEPS,
  GRID,
  MAGNET,
  PLATE_CLEAR,
  PLATE_HEIGHT,
  PLATE_RADIUS,
  roundedSketch,
  steppedLoft,
  stepsVolume,
  UNIT,
  type Step,
} from "./gridfinity";
import { circleShape, outlineShape } from "./printShapes";

const six = (n: number) => Math.round(n * 1e6) / 1e6;
const TOP = { kind: "default", name: "Top" } as const;
const bedNote = (w: number, d: number) => (Math.max(w, d) > 180 ? " Check it fits your printer's bed (180 mm on an A1 mini, 256 mm on most others)." : "");

// ---------------------------------------------------------------------------------------------------------------
// Magnet baseplate

/** The solid floor under the magnets (mm). */
export const MAGNET_FLOOR = 1;
/** The floor's top: where the pockets start (and the bins' bottoms rest). */
export const FLOOR_TOP = MAGNET.depth + MAGNET_FLOOR;

/** The pocket of one cell, standing on the floor (insets from the 42 mm cell): the open baseplate's, raised. */
export const MAGNET_POCKET_STEPS: Step[] = [
  { z: FLOOR_TOP, inset: 2.85 },
  { z: FLOOR_TOP + PLATE_CLEAR, inset: 2.85 },
  { z: FLOOR_TOP + PLATE_CLEAR + 0.7, inset: 2.15 },
  { z: FLOOR_TOP + PLATE_CLEAR + 2.5, inset: 2.15 },
  { z: FLOOR_TOP + PLATE_HEIGHT, inset: 0 },
  { z: FLOOR_TOP + PLATE_HEIGHT + 1, inset: -1 },
];

/** Where a cell's four magnets are, from its middle. */
export const magnetSpots = (cx: number, cy: number): [number, number][] => [-1, 1].flatMap((sx) => [-1, 1].map((sy): [number, number] => [cx + sx * MAGNET.at, cy + sy * MAGNET.at]));

export const gridfinityMagnetBaseplate: LibraryDesign = {
  id: "gridfinity-magnet-baseplate",
  name: "Gridfinity magnet baseplate",
  description:
    "A Gridfinity baseplate with a pocket for a 6 × 2 mm round magnet under each corner of every cell, so bins with magnets in their feet click down and stay put (even upside down in a toolbox lid). The pockets are a little bigger than the magnets, so glue them in (a drop of superglue each) and check they all face the same way up. It prints flat on the bed, no supports.",
  category: "print",
  group: "Gridfinity",
  prefix: "gridmag",
  icon: '<rect x="5" y="5" width="38" height="38" rx="3"/><rect x="9" y="9" width="13" height="13" rx="2" opacity=".55"/><rect x="26" y="9" width="13" height="13" rx="2" opacity=".55"/><rect x="9" y="26" width="13" height="13" rx="2" opacity=".55"/><rect x="26" y="26" width="13" height="13" rx="2" opacity=".55"/><circle cx="11.5" cy="11.5" r="1.3"/><circle cx="36.5" cy="36.5" r="1.3"/><circle cx="36.5" cy="11.5" r="1.3"/><circle cx="11.5" cy="36.5" r="1.3"/>',
  inputs: [
    { key: "across", label: "Cells across", kind: "count", default: 3, min: 1, max: 8, help: "Left to right. Each cell is 42 mm." },
    { key: "along", label: "Cells front to back", kind: "count", default: 3, min: 1, max: 8 },
  ],
  problems: () => [],
  summary: (v) => {
    const [n, m] = [countOf(v, "across"), countOf(v, "along")];
    return `${n * m} cells and ${4 * n * m} magnets (6 × 2 mm), ${mm(GRID * n)} × ${mm(GRID * m)} and ${mm(FLOOR_TOP + PLATE_HEIGHT)} high.${bedNote(GRID * n, GRID * m)}`;
  },
  make: (ctx) => {
    const n = countOf(ctx.values, "across");
    const m = countOf(ctx.values, "along");
    const id = ctx.id("plate");
    const [cx, cy] = firstCell(n, m);
    const features: Feature[] = [
      sketchFeature(ctx.id("plate-sketch"), "Baseplate sketch", TOP, roundedSketch(GRID * n, GRID * m, PLATE_RADIUS, 0, 0, ctx.scope)),
      extrudeFeature(id, "Baseplate", ctx.id("plate-sketch"), { depth: lit(FLOOR_TOP + PLATE_HEIGHT), operation: "new" }),
      ...steppedLoft(ctx, "pocket", "Cell", GRID, GRID, PLATE_RADIUS, [cx, cy], MAGNET_POCKET_STEPS, "remove"),
      sketchFeature(ctx.id("magnet-sketch"), "Magnet pockets sketch", levelPlane(`${mm(FLOOR_TOP)} up`, FLOOR_TOP), shapesSketch(magnetSpots(cx, cy).map(([x, y]) => circleShape(x, y, MAGNET.d)), ctx.scope)),
      // Down into the floor from its top.
      extrudeFeature(ctx.id("magnets"), "Magnet pockets", ctx.id("magnet-sketch"), { depth: lit(MAGNET.depth), operation: "remove", flip: true }),
    ];
    if (n * m > 1) features.push(gridPatternFeature(ctx.id("cells"), "Every cell", [ctx.id("pocket"), ctx.id("magnets")], n, lit(GRID), m, lit(GRID)));
    return { features, partNames: { [id]: `${ctx.name} ${n}×${m}` } };
  },
  preview: (v) => {
    const [n, m] = [countOf(v, "across"), countOf(v, "along")];
    const out = cellsPreview(n, m, GRID, PLATE_RADIUS, GRID - 2 * 2.85, PLATE_RADIUS - 2.85);
    const [x0, y0] = firstCell(n, m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) for (const c of magnetSpots(x0 + GRID * i, y0 + GRID * j)) out.push({ kind: "circle", c, r: MAGNET.d / 2 });
    return out;
  },
};

/** For tests: the magnet baseplate's volume (mm³). */
export function magnetBaseplateVolume(v: DesignValues): number {
  const [n, m] = [countOf(v, "across"), countOf(v, "along")];
  const top = FLOOR_TOP + PLATE_HEIGHT;
  const pocket = stepsVolume(GRID, GRID, PLATE_RADIUS, MAGNET_POCKET_STEPS, FLOOR_TOP, top);
  return area(GRID * n, GRID * m, PLATE_RADIUS) * top - n * m * (pocket + 4 * Math.PI * (MAGNET.d / 2) ** 2 * MAGNET.depth);
}

// ---------------------------------------------------------------------------------------------------------------
// The bin's body and feet (shared by the bit holder and the lite bin)

function binBody(ctx: MakeContext, id: string, w: number, d: number, top: number): Feature[] {
  const cell = GRID - 2 * BIN_GAP;
  const radius = PLATE_RADIUS - BIN_GAP;
  const [W, D] = [GRID * w - 2 * BIN_GAP, GRID * d - 2 * BIN_GAP];
  const features: Feature[] = [
    sketchFeature(ctx.id("body-sketch"), "Bin outline", levelPlane(`${mm(FOOT_HEIGHT)} up`, FOOT_HEIGHT), roundedSketch(W, D, radius, 0, 0, ctx.scope)),
    extrudeFeature(id, "Bin", ctx.id("body-sketch"), { depth: lit(six(top - FOOT_HEIGHT)), operation: "new" }),
    ...steppedLoft(ctx, "foot", "Foot", cell, cell, radius, firstCell(w, d), FOOT_STEPS, "add"),
  ];
  if (w * d > 1) features.push(gridPatternFeature(ctx.id("feet"), "Feet", [ctx.id("foot")], w, lit(GRID), d, lit(GRID)));
  return features;
}

/** A bin's outside (no lip) w × d cells, `top` tall: volume (mm³). */
function bodyVolume(w: number, d: number, top: number): number {
  const cell = GRID - 2 * BIN_GAP;
  const radius = PLATE_RADIUS - BIN_GAP;
  return area(GRID * w - 2 * BIN_GAP, GRID * d - 2 * BIN_GAP, radius) * (top - FOOT_HEIGHT) + w * d * stepsVolume(cell, cell, radius, FOOT_STEPS);
}

// ---------------------------------------------------------------------------------------------------------------
// Bit and screwdriver holder

/** Room kept round the holes, to the bin's outside (mm), and the solid left under the deepest hole above the feet. */
export const HOLDER_EDGE = 3;
export const HOLDER_FLOOR = 1;

export function holderPlan(v: DesignValues) {
  const w = countOf(v, "across");
  const d = countOf(v, "along");
  const units = countOf(v, "units", 2);
  const top = UNIT * units;
  const hex = v.shape !== "round";
  const fit = num(v, "fit");
  const size = num(v, "size") + 2 * fit;
  /** How big a hole is along x and y (a hex's corners point along x). */
  const extent: [number, number] = hex ? [(size * 2) / Math.sqrt(3), size] : [size, size];
  const spacing = num(v, "spacing");
  const outer: [number, number] = [GRID * w - 2 * BIN_GAP, GRID * d - 2 * BIN_GAP];
  const cols = Math.max(1, Math.floor((outer[0] - 2 * HOLDER_EDGE - extent[0]) / spacing) + 1);
  const rows = Math.max(1, Math.floor((outer[1] - 2 * HOLDER_EDGE - extent[1]) / spacing) + 1);
  const depth = num(v, "depth");
  return { w, d, units, top, hex, size, extent, spacing, outer, cols, rows, depth, first: [(-(cols - 1) * spacing) / 2, (-(rows - 1) * spacing) / 2] as [number, number] };
}

const holeArea = (p: ReturnType<typeof holderPlan>) => (p.hex ? hexArea(p.size) : (Math.PI * p.size * p.size) / 4);

export const gridfinityBitHolder: LibraryDesign = {
  id: "gridfinity-bit-holder",
  name: "Gridfinity bit and screwdriver holder",
  description:
    "A solid Gridfinity block full of holes that drops into any Gridfinity baseplate: hex holes for standard ¼-inch screwdriver bits, or round holes for screwdrivers, drills, pens or hex keys standing upright. As many holes as fit at the spacing you choose. It prints as it stands, no supports.",
  category: "print",
  group: "Gridfinity",
  prefix: "gridbits",
  icon: '<path d="M6 14h36v26H6z"/><path d="M9 40l2 3h26l2-3" opacity=".7"/><path d="M12 20l3-2 3 2v3l-3 2-3-2zM22 20l3-2 3 2v3l-3 2-3-2zM32 20l3-2 3 2v3l-3 2-3-2zM12 30l3-2 3 2v3l-3 2-3-2zM22 30l3-2 3 2v3l-3 2-3-2zM32 30l3-2 3 2v3l-3 2-3-2z" opacity=".6"/>',
  inputs: [
    { key: "across", label: "Cells across", kind: "count", default: 1, min: 1, max: 6, help: "Left to right, in 42 mm cells." },
    { key: "along", label: "Cells front to back", kind: "count", default: 1, min: 1, max: 6 },
    { key: "units", label: "Height units", kind: "count", default: 3, min: 2, max: 12, help: "7 mm each." },
    {
      key: "shape",
      label: "Holes",
      kind: "choice",
      default: "hex",
      choices: [
        { value: "hex", label: "Hex (for screwdriver bits)" },
        { value: "round", label: "Round (screwdrivers, drills, pens)" },
      ],
    },
    { key: "size", label: "Bit or shaft size", kind: "length", default: 6.35, min: 2, max: 25, help: "Hex: across the flats (¼-inch bits are 6.35 mm). Round: the shaft's diameter." },
    { key: "fit", label: "Fit", kind: "length", default: 0.2, min: 0, max: 1, help: "How much bigger the holes are than the bits, each side. 0.2 mm holds bits snugly; screwdrivers like 0.5." },
    { key: "spacing", label: "Spacing", kind: "length", default: 10, min: 5, max: 40, help: "From one hole's middle to the next." },
    { key: "depth", label: "Hole depth", kind: "length", default: 12, min: 3, max: 80 },
  ],
  problems: (v) => {
    const p = holderPlan(v);
    const out: string[] = [];
    const fits = p.top - FOOT_HEIGHT - HOLDER_FLOOR;
    if (p.depth > fits) out.push(`Holes ${mm(p.depth)} deep don't fit in a block ${p.units} units tall: make them at most ${mm(Math.floor(fits * 10) / 10)} deep, or the block taller.`);
    if (p.spacing < p.extent[0] + 1.2) out.push(`The holes would run into each other: make the spacing at least ${mm(Math.ceil((p.extent[0] + 1.2) * 10) / 10)}.`);
    if (p.extent[0] > p.outer[0] - 2 * HOLDER_EDGE || p.extent[1] > p.outer[1] - 2 * HOLDER_EDGE) out.push("The holes are too big for this block: use more cells, or smaller holes.");
    return out;
  },
  summary: (v) => {
    const p = holderPlan(v);
    return `${p.cols * p.rows} ${p.hex ? "hex" : "round"} holes (${p.cols} × ${p.rows}), ${mm(p.size)} across${p.hex ? " the flats" : ""} and ${mm(p.depth)} deep, in a block ${mm(p.outer[0])} × ${mm(p.outer[1])} and ${mm(p.top)} tall.${bedNote(...p.outer)}`;
  },
  make: (ctx) => {
    const p = holderPlan(ctx.values);
    const id = ctx.id("holder");
    const [x, y] = p.first;
    const hole = p.hex ? outlineShape(hexagon(p.size, x, y)) : circleShape(x, y, p.size);
    const features: Feature[] = [
      ...binBody(ctx, id, p.w, p.d, p.top),
      sketchFeature(ctx.id("hole-sketch"), "Hole sketch", levelPlane(`${mm(p.top)} up`, p.top), shapesSketch([hole], ctx.scope)),
      extrudeFeature(ctx.id("hole"), "Hole", ctx.id("hole-sketch"), { depth: lit(p.depth), operation: "remove", flip: true }),
    ];
    if (p.cols * p.rows > 1) features.push(gridPatternFeature(ctx.id("holes"), "Holes", [ctx.id("hole")], p.cols, lit(p.spacing), p.rows, lit(p.spacing)));
    return { features, partNames: { [id]: `${ctx.name} ${p.w}×${p.d}` } };
  },
  preview: (v) => {
    const p = holderPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(p.outer[0], p.outer[1], PLATE_RADIUS - BIN_GAP) }];
    for (let i = 0; i < p.cols; i++)
      for (let j = 0; j < p.rows; j++) {
        const [x, y] = [p.first[0] + i * p.spacing, p.first[1] + j * p.spacing];
        out.push(p.hex ? { kind: "poly", closed: true, points: hexagon(p.size, x, y) } : { kind: "circle", c: [x, y], r: p.size / 2 });
      }
    return out;
  },
};

/** For tests: the holder's volume (mm³). */
export function bitHolderVolume(v: DesignValues): number {
  const p = holderPlan(v);
  return bodyVolume(p.w, p.d, p.top) - p.cols * p.rows * holeArea(p) * p.depth;
}

// ---------------------------------------------------------------------------------------------------------------
// Lite bin: thin walls, hollow feet

/** How much further in the foot's inside stays than a straight offset, where it meets the bin's inside (no faces in common). */
const LITE_EPS = 0.05;

/**
 * The inside of one foot (insets from the cell's outline): the foot's own steps moved in square to every face by the
 * wall — a 45° face's offset is √2 × wall further across — on a floor `wall` thick, up into the bin's inside.
 */
export function liteFootSteps(wall: number): Step[] {
  const k = (Math.SQRT2 - 1) * wall;
  return [
    { z: wall, inset: FOOT_STEPS[0].inset + k },
    { z: FOOT_STEPS[1].z + k, inset: FOOT_STEPS[1].inset + wall },
    { z: FOOT_STEPS[2].z + k, inset: FOOT_STEPS[2].inset + wall },
    { z: FOOT_HEIGHT + k, inset: wall + LITE_EPS },
    { z: FOOT_HEIGHT + wall + 0.1, inset: wall + LITE_EPS },
  ];
}

export function litePlan(v: DesignValues) {
  const w = countOf(v, "across");
  const d = countOf(v, "along");
  const units = countOf(v, "units", 2);
  const wall = num(v, "wall");
  return { w, d, units, wall, top: UNIT * units, outer: [GRID * w - 2 * BIN_GAP, GRID * d - 2 * BIN_GAP] as [number, number] };
}

export const gridfinityLiteBin: LibraryDesign = {
  id: "gridfinity-lite-bin",
  name: "Gridfinity lite bin",
  description:
    "A quick, light Gridfinity bin: thin walls and hollow feet, so it uses about half the plastic of a standard bin and prints fast — handy for lots of bins at once. It fits any Gridfinity baseplate like a standard bin, but has no stacking lip or magnet holes. Prints as it stands, no supports.",
  category: "print",
  group: "Gridfinity",
  prefix: "gridlite",
  icon: '<path d="M6 16l4-4h28l4 4v24H6z"/><path d="M8 18h32v20H8z" opacity=".4"/><path d="M9 40l2 3h26l2-3" opacity=".7"/>',
  inputs: [
    { key: "across", label: "Cells across", kind: "count", default: 2, min: 1, max: 8, help: "Left to right, in 42 mm cells." },
    { key: "along", label: "Cells front to back", kind: "count", default: 1, min: 1, max: 8 },
    { key: "units", label: "Height units", kind: "count", default: 3, min: 2, max: 20, help: "7 mm each." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 0.8, min: 0.8, max: 1.2, help: "0.8 mm is two lines with a 0.4 mm nozzle." },
  ],
  problems: () => [],
  summary: (v) => {
    const p = litePlan(v);
    return `${p.w} × ${p.d} cells, ${p.units} units: ${mm(p.outer[0])} × ${mm(p.outer[1])} and ${mm(p.top)} tall, walls ${mm(p.wall)}.${bedNote(...p.outer)}`;
  },
  make: (ctx) => {
    const p = litePlan(ctx.values);
    const id = ctx.id("bin");
    const cell = GRID - 2 * BIN_GAP;
    const radius = PLATE_RADIUS - BIN_GAP;
    const floor = FOOT_HEIGHT + p.wall;
    const features: Feature[] = [
      ...binBody(ctx, id, p.w, p.d, p.top),
      ...steppedLoft(ctx, "hollow", "Hollow foot", cell, cell, radius, firstCell(p.w, p.d), liteFootSteps(p.wall), "remove"),
    ];
    if (p.w * p.d > 1) features.push(gridPatternFeature(ctx.id("hollows"), "Hollow feet", [ctx.id("hollow")], p.w, lit(GRID), p.d, lit(GRID)));
    features.push(
      sketchFeature(ctx.id("inside-sketch"), "Inside sketch", levelPlane(`${mm(floor)} up`, floor), roundedSketch(p.outer[0] - 2 * p.wall, p.outer[1] - 2 * p.wall, radius - p.wall, 0, 0, ctx.scope)),
      extrudeFeature(ctx.id("inside"), "Inside", ctx.id("inside-sketch"), { depth: lit(six(p.top - floor + 1)), operation: "remove" }),
    );
    return { features, partNames: { [id]: `${ctx.name} ${p.w}×${p.d}×${p.units}` } };
  },
  preview: (v) => {
    const p = litePlan(v);
    const cell = GRID - 2 * BIN_GAP;
    const out = cellsPreview(p.w, p.d, cell, PLATE_RADIUS - BIN_GAP, cell - 2 * 2.95, PLATE_RADIUS - BIN_GAP - 2.95);
    out.splice(1, 0, { kind: "poly", closed: true, points: roundedRect(p.outer[0] - 2 * p.wall, p.outer[1] - 2 * p.wall, PLATE_RADIUS - BIN_GAP - p.wall) });
    return out;
  },
};

/** For tests: the lite bin's volume (mm³). */
export function liteBinVolume(v: DesignValues): number {
  const p = litePlan(v);
  const cell = GRID - 2 * BIN_GAP;
  const radius = PLATE_RADIUS - BIN_GAP;
  const floor = FOOT_HEIGHT + p.wall;
  const feet = p.w * p.d * stepsVolume(cell, cell, radius, liteFootSteps(p.wall), -Infinity, floor);
  return bodyVolume(p.w, p.d, p.top) - feet - area(p.outer[0] - 2 * p.wall, p.outer[1] - 2 * p.wall, radius - p.wall) * (p.top - floor);
}
