/**
 * Honeycomb Storage Wall (HSW, RostaP's open system on Printables): a wall of hexagon holes that inserts click into.
 * The sizes follow the HSW grid as written down in the "HSW-GENERATOR" README's geometry table
 * (github.com/bigtaed-sys/HSW-GENERATOR) and the DDD-Printable-Wall-Control-System discussion #85 (github.com/aderusha,
 * "the 20mm hexagons", "8mm depth to match the HSW dimension"):
 *
 *  - holes 20 mm across the flats, 1.8 mm of wall on each side of a hole, so the holes are 23.6 mm apart;
 *  - the wall is 8 mm thick; from 6 mm deep the hole widens to 22 mm (the step a clip catches behind). We put that
 *    wider part at the back, towards the wall, so an insert's clips catch behind the 6 mm front part;
 *  - inserts: a 19.7 mm body in the 20 mm hole and a 22.5 mm lip in front (23.6 mm apart, so neighbours' lips clear).
 *
 * The hexagons stand on a corner (pointy-top as it hangs), rows staggered half a hole: so an insert has two upright
 * flats at its sides, and its snap fingers are upright plates that print standing on the bed. The tile prints face
 * down (front on the bed); every insert prints standing as it's used (floor down), with no supports.
 *
 * Tiles are N holes across × M rows: N × 23.6 wide and M × 20.44 high, so tiles laid side by side and on top of each
 * other (an even number of rows) carry the grid on; the odd rows' end holes are half holes that meet the next tile's.
 * The screw cells are left solid with a countersunk hole for a 4 mm wood screw.
 */
import { lit } from "../ex";
import { countersunkHoleFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { fixedPlane, gridPatternFeature, levelPlane } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num } from "./common";
import { CLEAT_SCREW } from "./frenchCleat";
import { areaOf, cantileverStrain, clipToBox, outlineShape, pointyHex, rectShape, SNAP_STRAIN, type P2 } from "./printShapes";

/** The HSW grid (mm). */
export const HSW = { hole: 20, wall: 1.8, pitch: 23.6, depth: 8, recess: 22, recessFrom: 6, body: 19.7, lip: 22.5 };
/** How far apart the rows are (the hexagons' flats meet at 60°). */
export const HSW_ROW = (HSW.pitch * Math.sqrt(3)) / 2;
/** A screw cell's filling: a hexagon a little bigger than the wide part, so it joins the walls (and no neighbour's hole). */
export const SCREW_FILL = 22.4;
/** Wood screws for the tile (4 mm, countersunk). */
export const TILE_SCREW = CLEAT_SCREW;

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
const countOf = (v: DesignValues, k: string, lo = 1) => Math.max(lo, Math.round(num(v, k)));
const six = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------------
// The tile

export interface Cell {
  i: number;
  j: number;
  x: number;
  y: number;
}

/** A tile's size and its holes (centred on the origin; y is up the wall). */
export function tilePlan(v: DesignValues) {
  const n = countOf(v, "across", 2);
  const m = countOf(v, "rows", 2);
  const W = n * HSW.pitch;
  const H = m * HSW_ROW;
  const cells: Cell[] = [];
  for (let j = 0; j < m; j++) {
    const odd = j % 2 === 1;
    for (let i = 0; i < (odd ? n + 1 : n); i++) cells.push({ i, j, x: -W / 2 + HSW.pitch * (odd ? i : i + 0.5), y: -H / 2 + HSW_ROW * (j + 0.5) });
  }
  const whole = (c: Cell) => c.j % 2 === 0 || (c.i > 0 && c.i < n);
  const rowCells = (j: number) => cells.filter((c) => c.j === j && whole(c));
  const ends = (j: number) => [rowCells(j)[0], rowCells(j)[rowCells(j).length - 1]];
  const screws = v.screws === "0" ? [] : v.screws === "2" ? ends(m - 1) : [...ends(0), ...ends(m - 1)];
  return { n, m, W, H, cells, screws };
}

const isScrew = (p: ReturnType<typeof tilePlan>, c: Cell) => p.screws.some((s) => s.i === c.i && s.j === c.j);

/** A hexagon of the tile (across the flats), clipped to the tile. */
const tileHex = (p: ReturnType<typeof tilePlan>, flats: number, c: Cell): P2[] => clipToBox(pointyHex(flats, c.x, c.y), -p.W / 2, -p.H / 2, p.W / 2, p.H / 2);

function makeTile(ctx: MakeContext) {
  const p = tilePlan(ctx.values);
  const id = ctx.id("tile");
  const even = p.cells.find((c) => c.j === 0)!;
  const odd = p.cells.find((c) => c.j === 1)!;
  const hexSketch = (role: string, name: string, z: number, flats: number, c: Cell) =>
    sketchFeature(ctx.id(role), name, levelPlane(`${mm(z)} up`, z), shapesSketch([outlineShape(pointyHex(flats, c.x, c.y))], ctx.scope));
  const features: Feature[] = [
    sketchFeature(ctx.id("tile-sketch"), "Tile sketch", TOP, shapesSketch([rectShape(-p.W / 2, -p.H / 2, p.W, p.H)], ctx.scope)),
    extrudeFeature(id, "Tile", ctx.id("tile-sketch"), { depth: lit(HSW.depth), operation: "new" }),
  ];
  // Each kind of hole once, then patterned: the even rows, then the odd rows (shifted half a hole, one more across).
  const holes: [string, string, number, number, number][] = [
    ["hole", "Hole", -1, HSW.hole, HSW.depth + 2],
    ["recess", "Clip step", HSW.recessFrom, HSW.recess, HSW.depth - HSW.recessFrom + 1],
  ];
  for (const [role, name, z, flats, depth] of holes) {
    for (const [row, c, across, rows] of [
      ["even", even, p.n, Math.ceil(p.m / 2)],
      ["odd", odd, p.n + 1, Math.floor(p.m / 2)],
    ] as const) {
      features.push(
        hexSketch(`${role}-${row}-sketch`, `${name} sketch (${row} rows)`, z, flats, c),
        extrudeFeature(ctx.id(`${role}-${row}`), `${name} (${row} rows)`, ctx.id(`${role}-${row}-sketch`), { depth: lit(depth), operation: "remove" }),
        gridPatternFeature(ctx.id(`${role}-${row}-all`), `${name}s (${row} rows)`, [ctx.id(`${role}-${row}`)], across, lit(HSW.pitch), rows, lit(2 * HSW_ROW)),
      );
    }
  }
  if (p.screws.length) {
    const drill = countersunkHoleFeature(ctx.id("screws"), "Screw holes", ctx.id("screws-sketch"), lit(TILE_SCREW.d), lit(TILE_SCREW.head));
    features.push(
      sketchFeature(ctx.id("fill-sketch"), "Screw cells sketch", TOP, shapesSketch(p.screws.map((c) => outlineShape(tileHex(p, SCREW_FILL, c))), ctx.scope)),
      extrudeFeature(ctx.id("fill"), "Screw cells", ctx.id("fill-sketch"), { depth: lit(HSW.depth), operation: "add" }),
      sketchFeature(ctx.id("screws-sketch"), "Screw holes sketch", TOP, shapesSketch(p.screws.map((c) => ({ type: "circle", center: [String(six(c.x)), String(six(c.y))], diameter: String(TILE_SCREW.d) })), ctx.scope)),
      // Drilled up from the bed, so the countersinks are in the tile's front.
      { ...drill, hole: { ...drill.hole!, flip: true } },
    );
  }
  return { features, partNames: { [id]: `${ctx.name} ${p.n}×${p.m}` } };
}

export const hswTile: LibraryDesign = {
  id: "hsw-tile",
  name: "Honeycomb wall tile (HSW)",
  description:
    "A tile of the Honeycomb Storage Wall: hexagon holes on the standard HSW grid (20 mm holes, 23.6 mm apart, 8 mm thick), so hooks, bins and holders made for HSW click into it, ours or downloaded. Screw it to the wall through the solid corner cells; tiles put side by side (or above each other, with an even number of rows) carry the grid on. It prints face down, no supports.",
  category: "print",
  group: "Storage",
  prefix: "hsw",
  icon: '<path d="M14 6l6 3.5v7L14 20l-6-3.5v-7zM28 6l6 3.5v7L28 20l-6-3.5v-7zM21 18l6 3.5v7L21 32l-6-3.5v-7zM35 18l6 3.5v7L35 32l-6-3.5v-7zM7 18l6 3.5v7L7 32l-6-3.5v-7zM14 30l6 3.5v7L14 44l-6-3.5v-7zM28 30l6 3.5v7L28 44l-6-3.5v-7z"/>',
  inputs: [
    { key: "across", label: "Holes across", kind: "count", default: 6, min: 2, max: 10, help: "Each is 23.6 mm: 6 across is 141.6 mm wide." },
    { key: "rows", label: "Rows", kind: "count", default: 6, min: 2, max: 12, help: "Each row is 20.4 mm. An even number lets tiles stack above each other." },
    {
      key: "screws",
      label: "Screw holes",
      kind: "choice",
      default: "4",
      choices: [
        { value: "4", label: "4, in the corner cells" },
        { value: "2", label: "2, in the top corners" },
        { value: "0", label: "None (stick it up)" },
      ],
      help: "For 4 mm countersunk wood screws. The screw cells are left solid.",
    },
  ],
  problems: () => [],
  summary: (v) => {
    const p = tilePlan(v);
    const big = Math.max(p.W, p.H) > 180 ? " Check it fits your printer's bed (180 mm on an A1 mini, 256 mm on most others)." : "";
    const whole = p.cells.filter((c) => c.j % 2 === 0 || (c.i > 0 && c.i < p.n)).length - p.screws.length;
    return `1 part, ${mm(p.W)} × ${mm(p.H)} and ${mm(HSW.depth)} thick: ${whole} holes for inserts${p.screws.length ? `, ${p.screws.length} screw cells` : ""}.${big}`;
  },
  make: makeTile,
  preview: (v) => {
    const p = tilePlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: [[-p.W / 2, -p.H / 2], [p.W / 2, -p.H / 2], [p.W / 2, p.H / 2], [-p.W / 2, p.H / 2]] }];
    for (const c of p.cells) {
      if (isScrew(p, c)) out.push({ kind: "circle", c: [c.x, c.y], r: TILE_SCREW.head / 2 });
      else out.push({ kind: "poly", closed: true, faint: true, points: tileHex(p, HSW.hole, c) });
    }
    return out;
  },
};

/** For tests: the tile's volume (mm³). */
export function tileVolume(v: DesignValues): number {
  const p = tilePlan(v);
  let vol = p.W * p.H * HSW.depth;
  for (const c of p.cells) {
    if (isScrew(p, c)) continue;
    vol -= areaOf(tileHex(p, HSW.hole, c)) * HSW.recessFrom + areaOf(tileHex(p, HSW.recess, c)) * (HSW.depth - HSW.recessFrom);
  }
  return vol - p.screws.length * countersunkHoleVolume(TILE_SCREW.d, TILE_SCREW.head, HSW.depth);
}

// ---------------------------------------------------------------------------------------------------------------
// Inserts: a plug that goes into a hole, with two snap fingers at its sides

/**
 * The plug, as it prints (and is used): x across, y out of the wall (the wall face at y = 0, the plug behind it),
 * z up. It's the 19.7 mm hexagon cut flat where its upright flats end, so it stands on the bed; two slots free an
 * upright finger at each side, and a ridge at the end of each finger springs out behind the hole's 6 mm front part.
 */
export const PLUG = {
  /** Half the body across the flats. */
  half: HSW.body / 2,
  /** How long the plug is (just inside the wall's 8 mm). */
  length: 7.5,
  /** The fingers: how thick, the slots freeing them, and how far short of the wall face the slots stop. */
  finger: 1,
  slot: 0.8,
  root: 0.3,
  /** How far the ridge reaches past the hole's flat (mm) — what the finger must bend in to go through. */
  catchBy: 0.4,
  /** Play between the ridge's catch and the end of the hole's narrow part, so the lip sits flat. */
  play: 0.15,
};
/** The plug's middle above the bed: half an upright flat (the flats are 19.7 / √3 long). */
export const PLUG_MID = HSW.body / Math.sqrt(3) / 2;
/** How high the fingers reach (a little below the top of the upright flats, under the slit that frees them). */
export const FINGER_TOP = 2 * PLUG_MID - PLUG.slot - 0.2;
/** How far the ridge stands out from the finger. */
export const RIDGE = HSW.hole / 2 + PLUG.catchBy - PLUG.half;
/** Where the ridge's catch is (y), just behind the hole's narrow part. */
export const CATCH_AT = -(HSW.recessFrom + PLUG.play);
/** The lip in front: thickness. */
export const LIP_THICKNESS = 2;
const INTO = 0.05;

/** A hexagon `flats` across, standing on a corner round the plug's middle, cut flat at the bed (x across, z up). */
export function plugOutline(flats: number): P2[] {
  return clipToBox(pointyHex(flats, 0, PLUG_MID), -100, 0, 100, 100);
}

/** The slot freeing the right-hand finger (x, z), an upside-down L: up beside the finger, then out over its top. */
export function slotOutline(side: 1 | -1): P2[] {
  const { half: a, finger: t, slot: g } = PLUG;
  const pts: P2[] = [
    [a - t - g, -1],
    [a - t, -1],
    [a - t, FINGER_TOP],
    [a + 1, FINGER_TOP],
    [a + 1, FINGER_TOP + g],
    [a - t - g, FINGER_TOP + g],
  ];
  return side === 1 ? pts : pts.map(([x, z]): P2 => [-x, z]).reverse();
}

/** The right-hand ridge (x, y, seen from above): a 45° lead-in from the plug's end, then the catch. */
export function ridgeOutline(side: 1 | -1): P2[] {
  const a = PLUG.half;
  const L = PLUG.length;
  const pts: P2[] = [
    [a - INTO, -L],
    [a, -L],
    [a + RIDGE, -L + RIDGE],
    [a + RIDGE, CATCH_AT],
    [a - INTO, CATCH_AT],
  ];
  return side === 1 ? pts : pts.map(([x, y]): P2 => [-x, y]).reverse();
}

/** How much the fingers stretch going in: each bends in by the ridge's overlap, from its root to the ridge. */
export function plugStrain(): number {
  return cantileverStrain(PLUG.finger, PLUG.catchBy, -CATCH_AT - PLUG.root);
}

/** The plug, made from the Front plane (the wall face) back towards the wall. */
function plugFeatures(ctx: MakeContext, id: string): Feature[] {
  return [
    sketchFeature(ctx.id("plug-sketch"), "Plug sketch", FRONT, shapesSketch([outlineShape(plugOutline(HSW.body))], ctx.scope)),
    extrudeFeature(id, "Plug", ctx.id("plug-sketch"), { depth: lit(PLUG.length), operation: "new" }),
  ];
}

/** The slots and ridges that make the snap fingers (after everything else is on the part). */
function fingerFeatures(ctx: MakeContext): Feature[] {
  const slotPlane = fixedPlane(`${mm(PLUG.root)} behind the wall face`, [0, -PLUG.root, 0], [1, 0, 0], [0, 0, 1]);
  return [
    sketchFeature(ctx.id("slots-sketch"), "Finger slots sketch", slotPlane, shapesSketch([outlineShape(slotOutline(1)), outlineShape(slotOutline(-1))], ctx.scope)),
    extrudeFeature(ctx.id("slots"), "Finger slots", ctx.id("slots-sketch"), { depth: lit(PLUG.length - PLUG.root + 1), operation: "remove" }),
    sketchFeature(ctx.id("ridges-sketch"), "Clip ridges sketch", TOP, shapesSketch([outlineShape(ridgeOutline(1)), outlineShape(ridgeOutline(-1))], ctx.scope)),
    extrudeFeature(ctx.id("ridges"), "Clip ridges", ctx.id("ridges-sketch"), { depth: lit(six(FINGER_TOP)), operation: "add" }),
  ];
}

/** For tests: the plug with its fingers (mm³). */
export function plugVolume(): number {
  const { finger: t, slot: g, length: L, root: r } = PLUG;
  const slots = 2 * (g * (FINGER_TOP + g) + t * g) * (L - r);
  const ridges = 2 * areaOf(clipToBox(ridgeOutline(1), PLUG.half, -100, 100, 100)) * FINGER_TOP;
  return areaOf(plugOutline(HSW.body)) * L - slots + ridges;
}

const plugProblems = (): string[] => (plugStrain() > SNAP_STRAIN ? ["The clip fingers would bend too far."] : []);

// --- The hook

export function hookPlan(v: DesignValues) {
  return { reach: num(v, "reach"), tip: num(v, "tip"), width: num(v, "width"), arm: num(v, "arm"), gusset: Math.min(5, num(v, "reach") / 3) };
}

/** The hook seen from the side (y out from the wall, z up): an arm along the bed from the lip, its tip turned up, a 45° brace at the root. */
export function hookOutline(v: DesignValues): P2[] {
  const h = hookPlan(v);
  const f = LIP_THICKNESS;
  return [
    [f - INTO, 0],
    [f + h.reach, 0],
    [f + h.reach, h.tip],
    [f + h.reach - h.arm, h.tip],
    [f + h.reach - h.arm, h.arm],
    [f + h.gusset, h.arm],
    [f - INTO, h.arm + h.gusset + INTO],
  ];
}

export const hswHook: LibraryDesign = {
  id: "hsw-hook",
  name: "Honeycomb wall hook (HSW)",
  description:
    "A hook that clicks into any hole of a Honeycomb Storage Wall: push it in until the lip meets the wall and its two little clip fingers spring out behind; squeeze them (or pull firmly) to take it out. For light things — headphones, keys, cables, tools up to about 1 kg. It prints standing as it hangs, no supports.",
  category: "print",
  group: "Storage",
  prefix: "hswhook",
  icon: '<path d="M8 10l6 3.5v7L8 24l-6-3.5v-7z" opacity=".55"/><path d="M14 20h26v-10h4v14H14z"/>',
  inputs: [
    { key: "reach", label: "Hook length", kind: "length", default: 40, min: 15, max: 100, help: "How far it sticks out from the wall." },
    { key: "tip", label: "Tip height", kind: "length", default: 15, min: 8, max: 40, help: "How high the end turns up, so things don't slide off." },
    { key: "width", label: "Width", kind: "length", default: 10, min: 6, max: 19 },
    { key: "arm", label: "Arm thickness", kind: "length", default: 6, min: 4, max: 10 },
  ],
  problems: (v) => {
    const h = hookPlan(v);
    const out = plugProblems();
    if (h.tip <= h.arm + 2) out.push(`The tip must stand at least 2 mm above the arm: make it more than ${mm(h.arm + 2)} high.`);
    if (h.reach < h.arm + h.gusset + 4) out.push(`Make the hook at least ${mm(h.arm + h.gusset + 4)} long.`);
    return out;
  },
  summary: (v) => {
    const h = hookPlan(v);
    return `1 part: a ${mm(HSW.body)} plug with two clip fingers (each bends in ${mm(PLUG.catchBy)}, stretching ${Math.round(plugStrain() * 1000) / 10}%), and a hook ${mm(h.reach)} long, ${mm(h.width)} wide.`;
  },
  make: (ctx) => {
    const id = ctx.id("hook");
    const h = hookPlan(ctx.values);
    return {
      features: [
        ...plugFeatures(ctx, id),
        sketchFeature(ctx.id("lip-sketch"), "Lip sketch", FRONT, shapesSketch([outlineShape(plugOutline(HSW.lip))], ctx.scope)),
        extrudeFeature(ctx.id("lip"), "Lip", ctx.id("lip-sketch"), { depth: lit(LIP_THICKNESS), operation: "add", flip: true }),
        sketchFeature(ctx.id("arm-sketch"), "Hook sketch", RIGHT, shapesSketch([outlineShape(hookOutline(ctx.values))], ctx.scope)),
        extrudeFeature(ctx.id("arm"), "Hook", ctx.id("arm-sketch"), { depth: lit(h.width), end: "symmetric", operation: "add" }),
        ...fingerFeatures(ctx),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const side = (pts: P2[]) => pts.map(([y, z]): [number, number] => [y, z]);
    return [
      { kind: "poly", closed: true, points: [[-PLUG.length, 0], [0, 0], [0, 2 * PLUG_MID], [-PLUG.length, 2 * PLUG_MID]], faint: true },
      { kind: "poly", closed: true, points: [[0, 0], [LIP_THICKNESS, 0], [LIP_THICKNESS, PLUG_MID + HSW.lip / Math.sqrt(3)], [0, PLUG_MID + HSW.lip / Math.sqrt(3)]] },
      { kind: "poly", closed: true, points: side(hookOutline(v)) },
      { kind: "text", at: [10, -6], text: "seen from the side; the wall is on the left" },
    ];
  },
};

/** For tests: the hook's volume (mm³). */
export function hookVolume(v: DesignValues): number {
  const h = hookPlan(v);
  const prof = hookOutline(v);
  const outside = areaOf(prof) - areaOf(clipToBox(prof, -100, -100, LIP_THICKNESS, 100));
  return plugVolume() + areaOf(plugOutline(HSW.lip)) * LIP_THICKNESS + outside * h.width;
}

// --- The bin

export function binPlan5(v: DesignValues) {
  return { width: num(v, "width"), depth: num(v, "depth"), height: num(v, "height"), wall: num(v, "wall"), floor: num(v, "floor") };
}

export const hswBin: LibraryDesign = {
  id: "hsw-bin",
  name: "Honeycomb wall bin (HSW)",
  description:
    "A small open-topped bin that clicks into a hole of a Honeycomb Storage Wall, for screws, pens, bits or sweets. Its back is the lip that sits on the wall; two clip fingers on its plug spring out behind the hole. It prints standing as it's used, open at the top, no supports.",
  category: "print",
  group: "Storage",
  prefix: "hswbin",
  icon: '<path d="M8 6l6 3.5v7L8 20l-6-3.5v-7z" opacity=".55"/><path d="M14 10v30h28V10h-4v26H18V10z"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 45, min: 24, max: 120, help: "Left to right, outside." },
    { key: "depth", label: "Depth", kind: "length", default: 30, min: 12, max: 80, help: "Out from the wall, outside." },
    { key: "height", label: "Height", kind: "length", default: 30, min: 20, max: 100 },
    { key: "wall", label: "Wall thickness", kind: "length", default: 1.6, min: 1.2, max: 4 },
    { key: "floor", label: "Floor thickness", kind: "length", default: 1.6, min: 1, max: 5 },
  ],
  problems: (v) => {
    const b = binPlan5(v);
    const out = plugProblems();
    if (b.depth < 2 * b.wall + 6) out.push(`Make it at least ${mm(2 * b.wall + 6)} deep, for room inside.`);
    if (b.width < HSW.lip + 1) out.push(`Make it at least ${mm(HSW.lip + 1)} wide, so its back covers the hole.`);
    return out;
  },
  summary: (v) => {
    const b = binPlan5(v);
    return `1 part: a bin ${mm(b.width - 2 * b.wall)} × ${mm(b.depth - 2 * b.wall)} inside and ${mm(b.height - b.floor)} deep, on a ${mm(HSW.body)} plug with two clip fingers.`;
  },
  make: (ctx) => {
    const id = ctx.id("bin");
    const b = binPlan5(ctx.values);
    return {
      features: [
        ...plugFeatures(ctx, id),
        sketchFeature(ctx.id("box-sketch"), "Bin sketch", TOP, shapesSketch([rectShape(-b.width / 2, 0, b.width, b.depth)], ctx.scope)),
        extrudeFeature(ctx.id("box"), "Bin", ctx.id("box-sketch"), { depth: lit(b.height), operation: "add" }),
        sketchFeature(ctx.id("inside-sketch"), "Bin inside sketch", levelPlane(`${mm(b.floor)} up`, b.floor), shapesSketch([rectShape(-b.width / 2 + b.wall, b.wall, b.width - 2 * b.wall, b.depth - 2 * b.wall)], ctx.scope)),
        extrudeFeature(ctx.id("inside"), "Bin inside", ctx.id("inside-sketch"), { depth: lit(b.height - b.floor + 1), operation: "remove" }),
        ...fingerFeatures(ctx),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const b = binPlan5(v);
    return [
      { kind: "poly", closed: true, points: [[-b.width / 2, 0], [b.width / 2, 0], [b.width / 2, b.depth], [-b.width / 2, b.depth]] },
      { kind: "poly", closed: true, faint: true, points: [[-b.width / 2 + b.wall, b.wall], [b.width / 2 - b.wall, b.wall], [b.width / 2 - b.wall, b.depth - b.wall], [-b.width / 2 + b.wall, b.depth - b.wall]] },
      { kind: "poly", closed: true, points: [[-PLUG.half, -PLUG.length], [PLUG.half, -PLUG.length], [PLUG.half, 0], [-PLUG.half, 0]] },
      { kind: "text", at: [0, -PLUG.length - 6], text: "seen from above; the wall is at the bottom" },
    ];
  },
};

/** For tests: the bin's volume (mm³). */
export function hswBinVolume(v: DesignValues): number {
  const b = binPlan5(v);
  return plugVolume() + b.width * b.depth * b.height - (b.width - 2 * b.wall) * (b.depth - 2 * b.wall) * (b.height - b.floor);
}
