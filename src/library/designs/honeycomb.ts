/**
 * Honeycomb Storage Wall (HSW, RostaP's open system on Printables): a wall of hexagon holes that inserts click into.
 * The sizes follow the HSW-GENERATOR (github.com/bigtaed-sys/HSW-GENERATOR, src/geometry/constants.ts and
 * lattice.ts) and PStover's standard insert (PSTOV-HSW-CONNECTOR-STD, measured from its mesh in that repository):
 *
 *  - holes 20 mm across the flats, flat at the top and bottom as the wall hangs, with 1.8 mm of wall each side: the
 *    holes in a column are 23.6 mm apart, the columns 23.6 × √3/2 = 20.44 mm apart, every other one half a hole up;
 *  - 8 mm thick; the hole's profile from the front face (`HOLE_PROFILE`): a 0.4 mm lead-in to 20.8 at the face, 20 mm
 *    from 0.5 to 5.1 deep, then a taper out to 22 mm at 6.0 and 22 mm to the back — the taper is what an insert's
 *    snap bumps sit against;
 *  - inserts: a 19.7 mm body 7.5 mm long behind a 22.5 mm lip 3 mm thick; snap bumps on the top and bottom flats,
 *    0.37 mm over the 20 mm hole at their peak 5.75 mm behind the face, sloping both ways (`BUMP`) — so they click
 *    in, can be pulled out again, and a genuine PStover insert fits our tile as ours fits a genuine tile.
 *
 * The tile prints face down (the lead-in at the bed). The inserts print standing on the end of their plug, the lip
 * above it, like PStover's: the snap fingers and bumps are upright walls and the lip overhangs only 1.4 mm. A hook
 * rises from the lip with its tip at 45°. A bin can't print that way (its floor would be a ceiling), so the bin is
 * two parts: a clip-in insert with a dovetail rail on its lip, and a bin printed upright that slides down onto it.
 */
import { lit } from "../ex";
import { countersunkHoleFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { gridPatternFeature, levelPlane, loftFeature } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { DEFAULT_FITS } from "../../model/printSettings";
import { countersunkHoleVolume, mm, num } from "./common";
import { CLEAT_SCREW } from "./frenchCleat";
import { areaOf, cantileverStrain, clipToBox, outlineShape, rectShape, SNAP_STRAIN, type P2 } from "./printShapes";

/** The HSW grid (mm). */
export const HSW = { hole: 20, wall: 1.8, depth: 8, body: 19.7, lip: 22.5, lipThickness: 3, length: 7.5 };
/** Holes in a column, and columns, apart. */
export const HSW_PITCH = HSW.hole + 2 * HSW.wall;
export const HSW_COLUMN = (HSW_PITCH * Math.sqrt(3)) / 2;
/** The hole across the flats at each depth from the front face: [depth, across] (HSW-GENERATOR's HOLE_PROFILE). */
export const HOLE_PROFILE: [number, number][] = [
  [0, 20.8],
  [0.5, 20],
  [5.1, 20],
  [6, 22],
  [HSW.depth, 22],
];
/** A screw cell's filling: a hexagon a little bigger than the hole's widest, so it joins the walls (and no neighbour's hole). */
export const SCREW_FILL = 22.4;
/** Wood screws for the tile (4 mm, countersunk). */
export const TILE_SCREW = CLEAT_SCREW;

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;
const countOf = (v: DesignValues, k: string, lo = 1) => Math.max(lo, Math.round(num(v, k)));
const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** A hexagon `flats` across, flat at the top and bottom (corners pointing along x), anticlockwise from the right corner. */
export function flatHex(flats: number, cx = 0, cy = 0): P2[] {
  const r = flats / Math.sqrt(3);
  return Array.from({ length: 6 }, (_, i): P2 => [cx + r * Math.cos((Math.PI / 3) * i), cy + r * Math.sin((Math.PI / 3) * i)]);
}

/** The hole's width across the flats at depth d from the front face. */
export function holeAt(d: number): number {
  const p = HOLE_PROFILE;
  if (d <= p[0][0]) return p[0][1] + ((p[1][1] - p[0][1]) / (p[1][0] - p[0][0])) * (d - p[0][0]);
  for (let i = 0; i + 1 < p.length; i++) if (d <= p[i + 1][0]) return p[i][1] + ((p[i + 1][1] - p[i][1]) * (d - p[i][0])) / (p[i + 1][0] - p[i][0]);
  return p[p.length - 1][1];
}

// ---------------------------------------------------------------------------------------------------------------
// The tile

export interface Cell {
  i: number;
  j: number;
  x: number;
  y: number;
}

/** A tile's size and its holes (centred on the origin; y is up the wall): N columns × M holes each. */
export function tilePlan(v: DesignValues) {
  const n = countOf(v, "across", 2);
  const m = countOf(v, "rows", 2);
  const W = n * HSW_COLUMN;
  const H = m * HSW_PITCH;
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const odd = i % 2 === 1;
    for (let j = 0; j < (odd ? m + 1 : m); j++) cells.push({ i, j, x: -W / 2 + HSW_COLUMN * (i + 0.5), y: -H / 2 + HSW_PITCH * (odd ? j : j + 0.5) });
  }
  const whole = (c: Cell) => c.i % 2 === 0 || (c.j > 0 && c.j < m);
  const ends = (i: number) => {
    const col = cells.filter((c) => c.i === i && whole(c));
    return [col[0], col[col.length - 1]];
  };
  const [l, r] = [ends(0), ends(n - 1)];
  const screws = v.screws === "0" ? [] : v.screws === "2" ? [l[1], r[1]] : [l[0], r[0], l[1], r[1]];
  return { n, m, W, H, cells, screws, whole };
}

const isScrew = (p: ReturnType<typeof tilePlan>, c: Cell) => p.screws.some((s) => s.i === c.i && s.j === c.j);

/** A hexagon of the tile (across the flats), clipped to the tile. */
const tileHex = (p: ReturnType<typeof tilePlan>, flats: number, c: Cell): P2[] => clipToBox(flatHex(flats, c.x, c.y), -p.W / 2, -p.H / 2, p.W / 2, p.H / 2);

/** The loft's sections (height, across), run out a little past both faces so the cut is clean. */
const HOLE_SECTIONS: [number, number][] = [[-0.5, holeAt(-0.5)], ...HOLE_PROFILE.slice(1, -1), [HSW.depth + 1, 22]];

function makeTile(ctx: MakeContext) {
  const p = tilePlan(ctx.values);
  const id = ctx.id("tile");
  const features: Feature[] = [
    sketchFeature(ctx.id("tile-sketch"), "Tile sketch", TOP, shapesSketch([rectShape(-p.W / 2, -p.H / 2, p.W, p.H)], ctx.scope)),
    extrudeFeature(id, "Tile", ctx.id("tile-sketch"), { depth: lit(HSW.depth), operation: "new" }),
  ];
  // One hole of each kind of column, lofted through the profile, then patterned: the even columns, then the odd ones
  // (half a hole up, one more in each).
  for (const [col, c, across, rows] of [
    ["even", p.cells.find((x) => x.i === 0)!, Math.ceil(p.n / 2), p.m],
    ["odd", p.cells.find((x) => x.i === 1)!, Math.floor(p.n / 2), p.m + 1],
  ] as const) {
    const sections = HOLE_SECTIONS.map(([z, w], k) =>
      sketchFeature(ctx.id(`hole-${col}-${k}`), `Hole outline ${k + 1} (${col} columns)`, levelPlane(`${mm(z)} up`, z), shapesSketch([outlineShape(flatHex(w, c.x, c.y))], ctx.scope)),
    );
    features.push(
      ...sections,
      loftFeature(ctx.id(`hole-${col}`), `Hole (${col} columns)`, sections.map((s) => s.id), "remove"),
      gridPatternFeature(ctx.id(`hole-${col}-all`), `Holes (${col} columns)`, [ctx.id(`hole-${col}`)], across, lit(2 * HSW_COLUMN), rows, lit(HSW_PITCH)),
    );
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
    "A tile of the Honeycomb Storage Wall: hexagon holes on the standard HSW grid (20 mm holes, flat top and bottom, 23.6 mm apart, 8 mm thick, with the clip taper inside), so hooks, bins and holders made for HSW click into it, ours or downloaded. Screw it to the wall through the solid corner cells; tiles above each other, or side by side with an even number of columns, carry the grid on. It prints face down, no supports.",
  category: "print",
  group: "Storage",
  prefix: "hsw",
  icon: '<path d="M4 12l3.5-6h7l3.5 6-3.5 6h-7zM4 36l3.5-6h7l3.5 6-3.5 6h-7zM16 24l3.5-6h7l3.5 6-3.5 6h-7zM28 12l3.5-6h7l3.5 6-3.5 6h-7zM28 36l3.5-6h7l3.5 6-3.5 6h-7z"/>',
  inputs: [
    { key: "across", label: "Columns", kind: "count", default: 6, min: 2, max: 12, help: "Left to right, 20.4 mm each: 6 is 122.6 mm wide. An even number lets tiles sit side by side." },
    { key: "rows", label: "Holes up each column", kind: "count", default: 6, min: 2, max: 10, help: "23.6 mm each: 6 is 141.6 mm high." },
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
    const holes = p.cells.filter(p.whole).length - p.screws.length;
    return `1 part, ${mm(p.W)} × ${mm(p.H)} and ${mm(HSW.depth)} thick: ${holes} holes for inserts${p.screws.length ? `, ${p.screws.length} screw cells` : ""}.${big}`;
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

/** ∫ f over [a, b] by Simpson's rule in n pieces (n even). */
function simpson(f: (x: number) => number, a: number, b: number, n = 64): number {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * f(a + k * h);
  return (s * h) / 3;
}

/** For tests: the tile's volume (mm³). */
export function tileVolume(v: DesignValues): number {
  const p = tilePlan(v);
  let vol = p.W * p.H * HSW.depth;
  for (const c of p.cells) {
    if (isScrew(p, c)) continue;
    for (let k = 0; k + 1 < HOLE_PROFILE.length; k++) vol -= simpson((d) => areaOf(tileHex(p, holeAt(d), c)), HOLE_PROFILE[k][0], HOLE_PROFILE[k + 1][0]);
  }
  return vol - p.screws.length * countersunkHoleVolume(TILE_SCREW.d, TILE_SCREW.head, HSW.depth);
}

// ---------------------------------------------------------------------------------------------------------------
// Inserts, as they print: standing on the plug's back end (z = 0), the wall face at z = 7.5, the lip above it, and
// what the insert holds above that. x is across and y is up, as on the wall.

/** Half the body across the flats. */
export const PLUG_HALF = HSW.body / 2;
/** The wall face (the lip's back) and the lip's top. */
export const FACE_Z = HSW.length;
export const LIP_TOP = HSW.length + HSW.lipThickness;
/** The snap fingers on the top and bottom flats: thickness, width, the slots that free them, how far behind the face they're fixed. */
export const FINGER = { thickness: 1, width: 8, slot: 0.8, root: 0.3 };
/**
 * The snap bump on each finger (PStover's shape), as [depth behind the wall face, how far it stands out from the
 * middle]: from the body's flat up to 0.37 mm over the hole at 5.75, and back down by 6.3 — both slopes under 45°, so
 * it prints, pushes in and pulls out again. It sits inside the hole's taper (5.1–6.0) when the lip is on the face.
 */
export const BUMP: [number, number][] = [
  [5.0, PLUG_HALF],
  [5.75, HSW.hole / 2 + 0.37],
  [6.3, PLUG_HALF],
];
/** The bump's width along the flat. */
export const BUMP_WIDTH = 7;
const INTO = 0.05;

/** How much the fingers stretch going in: each bends in by the bump's height over the hole, from its root to the peak. */
export function plugStrain(): number {
  return cantileverStrain(FINGER.thickness, BUMP[1][1] - HSW.hole / 2, BUMP[1][0] - FINGER.root);
}

/** The slot freeing the top finger (x, y, seen from the plug's end): a gap behind the finger and a slit each side. */
export function slotOutline(side: 1 | -1): P2[] {
  const { thickness: t, width: w, slot: g } = FINGER;
  const a = PLUG_HALF;
  const pts: P2[] = [
    [-w / 2 - g, a - t - g],
    [w / 2 + g, a - t - g],
    [w / 2 + g, a + 1],
    [w / 2, a + 1],
    [w / 2, a - t],
    [-w / 2, a - t],
    [-w / 2, a + 1],
    [-w / 2 - g, a + 1],
  ];
  return side === 1 ? pts : pts.map(([x, y]): P2 => [x, -y]).reverse();
}

/** A bump seen from the side (y, z): `side` 1 on the top finger, −1 on the bottom one. */
export function bumpOutline(side: 1 | -1): P2[] {
  const pts: P2[] = [[PLUG_HALF - INTO, FACE_Z - BUMP[0][0]], ...BUMP.map(([d, r]): P2 => [r, FACE_Z - d]), [PLUG_HALF - INTO, FACE_Z - BUMP[2][0]]];
  return side === 1 ? pts : pts.map(([y, z]): P2 => [-y, z]).reverse();
}

/** The plug, lip, finger slots and bumps (the insert's New part is `id`). */
function insertFeatures(ctx: MakeContext, id: string): Feature[] {
  return [
    sketchFeature(ctx.id("plug-sketch"), "Plug sketch", TOP, shapesSketch([outlineShape(flatHex(HSW.body))], ctx.scope)),
    extrudeFeature(id, "Plug", ctx.id("plug-sketch"), { depth: lit(HSW.length), operation: "new" }),
    sketchFeature(ctx.id("lip-sketch"), "Lip sketch", levelPlane(`${mm(FACE_Z)} up`, FACE_Z), shapesSketch([outlineShape(flatHex(HSW.lip))], ctx.scope)),
    extrudeFeature(ctx.id("lip"), "Lip", ctx.id("lip-sketch"), { depth: lit(HSW.lipThickness), operation: "add" }),
    sketchFeature(ctx.id("slots-sketch"), "Finger slots sketch", levelPlane("1 mm below the bed", -1), shapesSketch([outlineShape(slotOutline(1)), outlineShape(slotOutline(-1))], ctx.scope)),
    extrudeFeature(ctx.id("slots"), "Finger slots", ctx.id("slots-sketch"), { depth: lit(FACE_Z - FINGER.root + 1), operation: "remove" }),
    sketchFeature(ctx.id("bumps-sketch"), "Snap bumps sketch", RIGHT, shapesSketch([outlineShape(bumpOutline(1)), outlineShape(bumpOutline(-1))], ctx.scope)),
    extrudeFeature(ctx.id("bumps"), "Snap bumps", ctx.id("bumps-sketch"), { depth: lit(BUMP_WIDTH), end: "symmetric", operation: "add" }),
  ];
}

/** For tests: the plug with its lip, fingers and bumps (mm³). */
export function insertVolume(): number {
  const { thickness: t, width: w, slot: g, root } = FINGER;
  // Each slot: the gap behind its finger, and the two slits beside the finger (the rest of the outline is outside the plug).
  const slots = 2 * ((w + 2 * g) * g + 2 * g * t) * (FACE_Z - root);
  const bump = areaOf(clipToBox(bumpOutline(1), PLUG_HALF, -100, 100, 100)) * BUMP_WIDTH;
  return areaOf(flatHex(HSW.body)) * HSW.length + areaOf(flatHex(HSW.lip)) * HSW.lipThickness - slots + 2 * bump;
}

const insertProblems = (): string[] => (plugStrain() > SNAP_STRAIN ? ["The clip fingers would bend too far."] : []);

// --- The hook

export function hookPlan(v: DesignValues) {
  return { reach: num(v, "reach"), tip: num(v, "tip"), width: num(v, "width"), arm: num(v, "arm"), gusset: Math.min(5, num(v, "reach") / 3) };
}

/** Where the arm leaves the lip (y, as on the wall): along the bottom of the plug. */
export const ARM_FROM = -PLUG_HALF;

/**
 * The hook seen from the side (y up the wall, z out from it, as it prints): an arm straight out from the lip, a 45°
 * brace at its root, and the tip turned up at 45°.
 */
export function hookOutline(v: DesignValues): P2[] {
  const h = hookPlan(v);
  const y0 = ARM_FROM;
  const z0 = LIP_TOP;
  const end = z0 + h.reach;
  return [
    [y0, z0 - INTO],
    [y0 + h.arm + h.gusset, z0 - INTO],
    [y0 + h.arm, z0 + h.gusset - INTO],
    [y0 + h.arm, end - h.arm],
    [y0 + h.tip, end - 2 * h.arm + h.tip],
    [y0 + h.tip, end + h.tip],
    [y0, end],
  ];
}

export const hswHook: LibraryDesign = {
  id: "hsw-hook",
  name: "Honeycomb wall hook (HSW)",
  description:
    "A hook that clicks into any hole of a Honeycomb Storage Wall: push it in until the lip meets the wall and its two snap fingers spring out inside; pull firmly to take it out again. For light things — headphones, keys, cables, tools up to about 1 kg. It prints standing on the end of its plug, no supports.",
  category: "print",
  group: "Storage",
  prefix: "hswhook",
  icon: '<path d="M2 10l3-5h6l3 5-3 5H5z" opacity=".55"/><path d="M14 13h24l6-6 3 3-8 8H14z"/>',
  inputs: [
    { key: "reach", label: "Hook length", kind: "length", default: 40, min: 15, max: 100, help: "How far it sticks out from the wall." },
    { key: "tip", label: "Tip height", kind: "length", default: 15, min: 8, max: 40, help: "How high the end turns up (at 45°), so things don't slide off." },
    { key: "width", label: "Width", kind: "length", default: 10, min: 6, max: 13 },
    { key: "arm", label: "Arm thickness", kind: "length", default: 6, min: 4, max: 10 },
  ],
  problems: (v) => {
    const h = hookPlan(v);
    const out = insertProblems();
    if (h.tip <= h.arm + 2) out.push(`The tip must stand at least 2 mm above the arm: make it more than ${mm(h.arm + 2)} high.`);
    if (h.reach < 2 * h.arm + h.gusset) out.push(`Make the hook at least ${mm(2 * h.arm + h.gusset)} long.`);
    return out;
  },
  summary: (v) => {
    const h = hookPlan(v);
    return `1 part: a ${mm(HSW.body)} plug with two snap fingers (each bends in ${mm(BUMP[1][1] - HSW.hole / 2)}, stretching ${Math.round(plugStrain() * 1000) / 10}%), and a hook ${mm(h.reach)} long, ${mm(h.width)} wide.`;
  },
  make: (ctx) => {
    const id = ctx.id("hook");
    const h = hookPlan(ctx.values);
    return {
      features: [
        ...insertFeatures(ctx, id),
        sketchFeature(ctx.id("arm-sketch"), "Hook sketch", RIGHT, shapesSketch([outlineShape(hookOutline(ctx.values))], ctx.scope)),
        extrudeFeature(ctx.id("arm"), "Hook", ctx.id("arm-sketch"), { depth: lit(h.width), end: "symmetric", operation: "add" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => [
    { kind: "poly", closed: true, faint: true, points: [[-PLUG_HALF, 0], [PLUG_HALF, 0], [PLUG_HALF, FACE_Z], [-PLUG_HALF, FACE_Z]] },
    { kind: "poly", closed: true, points: [[-HSW.lip / 2, FACE_Z], [HSW.lip / 2, FACE_Z], [HSW.lip / 2, LIP_TOP], [-HSW.lip / 2, LIP_TOP]] },
    { kind: "poly", closed: true, points: hookOutline(v) },
    { kind: "text", at: [0, -6], text: "seen from the side, as it prints; up the wall is to the right" },
  ],
};

/** For tests: the hook's volume (mm³). */
export function hookVolume(v: DesignValues): number {
  const prof = hookOutline(v);
  const above = areaOf(clipToBox(prof, -100, LIP_TOP, 100, 1000));
  return insertVolume() + above * hookPlan(v).width;
}

// --- The bin: an insert with a dovetail rail, and a bin that slides down onto it
//
// The rail stands on the lip, up the wall, with 45° dovetail sides; its top end is cut back at 45°. The bin's back has a
// matching groove, open at the bin's bottom and closed near its top by a 45° roof (`fit` clear of the rail's end, square
// to it) — so the bin, printed upright, needs no supports, and lowered onto the rail it comes to rest with that roof on
// the rail's end, which pulls it in against the wall. Lift it to take it off.

/** The rail on the lip (across at its root, how high it stands, how long up the wall), with 45° sides. */
export const RAIL = { root: 10, height: 2.5, length: 18 };
/** The bin's back wall must hold the groove: rail + fit + this much behind it. */
export const GROOVE_BACK = 1.6;
/** Solid left above the groove's roof, at the bin's top (mm). */
export const GROOVE_TOP = 2;
/** Space between the insert and the bin on the bed. */
const BIN_GAP = 10;

/** The rail seen from below (x across, z out from the lip): a dovetail, wider at its top. */
export function railOutline(): P2[] {
  const { root: b, height: h } = RAIL;
  return [
    [-b / 2 + INTO, LIP_TOP - INTO],
    [b / 2 - INTO, LIP_TOP - INTO],
    [b / 2 + h, LIP_TOP + h],
    [-b / 2 - h, LIP_TOP + h],
  ];
}

/** What's cut off the rail's top end, seen from the side (y up the wall, z out): everything past a 45° line from its root at the end. */
export function railEndOutline(): P2[] {
  const top = RAIL.length / 2;
  const h = RAIL.height;
  return [
    [top, LIP_TOP],
    [top + 1, LIP_TOP],
    [top + 1, LIP_TOP + h + 1],
    [top - h - 1, LIP_TOP + h + 1],
  ];
}

export function hswBinPlan(v: DesignValues) {
  const width = num(v, "width");
  const depth = num(v, "depth");
  const height = num(v, "height");
  const wall = num(v, "wall");
  const floor = num(v, "floor");
  const fit = num(v, "fit");
  const back = Math.max(wall, RAIL.height + fit + GROOVE_BACK);
  /** The groove's half-width at the bin's back face, and its depth into the back wall (its 45° sides `fit` clear of the rail's). */
  const mouth = RAIL.root / 2 + fit * Math.SQRT2;
  const deep = RAIL.height + fit;
  /** Where the groove's roof meets the back face (height up the bin), and where its full depth stops. */
  const roofTop = height - GROOVE_TOP;
  const roofFoot = roofTop - deep;
  /** Where the bin sits on the bed: beside the insert's lip, its back face at y0. */
  const x0 = HSW.lip / 2 + BIN_GAP + width / 2;
  const y0 = -depth / 2;
  /** Hung on the rail: how far the bin's bottom is below the hole's middle (the roof fit × √2 above the rail's chamfer). */
  const hangsBelow = roofTop - RAIL.length / 2 - fit * Math.SQRT2;
  return { width, depth, height, wall, floor, fit, back, mouth, deep, roofTop, roofFoot, x0, y0, hangsBelow };
}

/** The groove in the bin's back seen from above (x, y), from 1 mm outside the back face to `s` deep (its full depth by default). */
export function grooveOutline(v: DesignValues, s = hswBinPlan(v).deep): P2[] {
  const b = hswBinPlan(v);
  const at = (d: number) => b.mouth + d;
  return [
    [b.x0 - at(-1), b.y0 - 1],
    [b.x0 + at(-1), b.y0 - 1],
    [b.x0 + at(s), b.y0 + s],
    [b.x0 - at(s), b.y0 + s],
  ];
}

export const hswBin: LibraryDesign = {
  id: "hsw-bin",
  name: "Honeycomb wall bin (HSW)",
  description:
    "A small open-topped bin for a Honeycomb Storage Wall, for screws, pens, bits or sweets. It's two parts: a clip-in insert with a dovetail rail on its lip, which clicks into a hole like any HSW insert, and the bin, which slides down onto the rail and lifts off again to empty it. The insert prints standing on its plug and the bin as it stands, no supports.",
  category: "print",
  group: "Storage",
  prefix: "hswbin",
  icon: '<path d="M2 10l3-5h6l3 5-3 5H5z" opacity=".55"/><path d="M16 10v30h26V10h-4v26H20V10z"/><path d="M14 8h3v8h-3z" opacity=".75"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 50, min: 26, max: 120, help: "Left to right, outside." },
    { key: "depth", label: "Depth", kind: "length", default: 35, min: 12, max: 80, help: "Out from the wall, outside." },
    { key: "height", label: "Height", kind: "length", default: 40, min: RAIL.length + GROOVE_TOP + 6, max: 100, help: "It hangs with its top about level with the top of the hole." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 1.6, min: 1.2, max: 4 },
    { key: "floor", label: "Floor thickness", kind: "length", default: 1.6, min: 1, max: 5 },
    { key: "fit", label: "Rail fit", kind: "length", default: DEFAULT_FITS.sliding, min: 0.1, max: 0.6, help: "The gap round the dovetail rail, so the bin slides on and off." },
  ],
  problems: (v) => {
    const b = hswBinPlan(v);
    const out = insertProblems();
    if (b.depth < b.back + b.wall + 6) out.push(`Make it at least ${mm(b.back + b.wall + 6)} deep, for room inside.`);
    if (b.width < 2 * (b.mouth + b.deep) + 2 * b.wall) out.push(`Make it at least ${mm(Math.ceil(2 * (b.mouth + b.deep + b.wall)))} wide, for the groove in its back.`);
    return out;
  },
  summary: (v) => {
    const b = hswBinPlan(v);
    return `2 parts: a clip-in insert with a ${mm(RAIL.length)} dovetail rail, and a bin ${mm(b.width - 2 * b.wall)} × ${mm(b.depth - b.back - b.wall)} inside and ${mm(b.height - b.floor)} deep that slides onto it.`;
  },
  make: (ctx) => {
    const id = ctx.id("insert");
    const binId = ctx.id("bin");
    const b = hswBinPlan(ctx.values);
    const features: Feature[] = [
      ...insertFeatures(ctx, id),
      sketchFeature(ctx.id("rail-sketch"), "Rail sketch", FRONT, shapesSketch([outlineShape(railOutline())], ctx.scope)),
      extrudeFeature(ctx.id("rail"), "Rail", ctx.id("rail-sketch"), { depth: lit(RAIL.length), end: "symmetric", operation: "add" }),
      sketchFeature(ctx.id("rail-end-sketch"), "Rail end sketch", RIGHT, shapesSketch([outlineShape(railEndOutline())], ctx.scope)),
      extrudeFeature(ctx.id("rail-end"), "Rail end", ctx.id("rail-end-sketch"), { depth: lit(RAIL.root + 2 * RAIL.height + 2), end: "symmetric", operation: "remove" }),
      sketchFeature(ctx.id("box-sketch"), "Bin sketch", TOP, shapesSketch([rectShape(b.x0 - b.width / 2, b.y0, b.width, b.depth)], ctx.scope)),
      extrudeFeature(binId, "Bin", ctx.id("box-sketch"), { depth: lit(b.height), operation: "new" }),
      sketchFeature(
        ctx.id("inside-sketch"),
        "Bin inside sketch",
        levelPlane(`${mm(b.floor)} up`, b.floor),
        shapesSketch([rectShape(b.x0 - b.width / 2 + b.wall, b.y0 + b.back, b.width - 2 * b.wall, b.depth - b.back - b.wall)], ctx.scope),
      ),
      extrudeFeature(ctx.id("inside"), "Bin inside", ctx.id("inside-sketch"), { depth: lit(b.height - b.floor + 1), operation: "remove" }),
      // The groove: open at the bottom, then its 45° roof (a straight loft from its full depth to nothing at the back face).
      sketchFeature(ctx.id("groove-sketch"), "Groove sketch", levelPlane("1 mm below the bed", -1), shapesSketch([outlineShape(grooveOutline(ctx.values))], ctx.scope)),
      extrudeFeature(ctx.id("groove"), "Groove", ctx.id("groove-sketch"), { depth: lit(six(b.roofFoot + 1)), operation: "remove" }),
      sketchFeature(ctx.id("roof-low"), "Groove roof outline 1", levelPlane(`${mm(b.roofFoot)} up`, b.roofFoot), shapesSketch([outlineShape(grooveOutline(ctx.values))], ctx.scope)),
      sketchFeature(ctx.id("roof-high"), "Groove roof outline 2", levelPlane(`${mm(b.roofTop)} up`, b.roofTop), shapesSketch([outlineShape(grooveOutline(ctx.values, 0))], ctx.scope)),
      loftFeature(ctx.id("roof"), "Groove roof", [ctx.id("roof-low"), ctx.id("roof-high")], "remove"),
    ];
    return { features, partNames: { [id]: `${ctx.name}: insert`, [binId]: `${ctx.name}: bin` } };
  },
  preview: (v) => {
    const b = hswBinPlan(v);
    return [
      { kind: "poly", closed: true, points: flatHex(HSW.lip) },
      { kind: "poly", closed: true, faint: true, points: [[-RAIL.root / 2, -RAIL.length / 2], [RAIL.root / 2, -RAIL.length / 2], [RAIL.root / 2, RAIL.length / 2], [-RAIL.root / 2, RAIL.length / 2]] },
      { kind: "poly", closed: true, points: [[b.x0 - b.width / 2, b.y0], [b.x0 + b.width / 2, b.y0], [b.x0 + b.width / 2, b.y0 + b.depth], [b.x0 - b.width / 2, b.y0 + b.depth]] },
      { kind: "poly", closed: true, faint: true, points: grooveOutline(v) },
      { kind: "text", at: [b.x0 / 2, b.y0 - 8], text: "the insert and the bin, seen from above as they print" },
    ];
  },
};

/** For tests: the insert's and bin's volumes (mm³). */
export function hswBinVolumes(v: DesignValues): { insert: number; bin: number } {
  const b = hswBinPlan(v);
  const { root: w, height: h, length: L } = RAIL;
  // The rail, less its 45° end: at height s up the rail, s of its length is cut off, (w + 2s) wide.
  const rail = (w + h) * h * L - ((w * h * h) / 2 + (2 * h * h * h) / 3);
  // The groove inside the back wall: its full depth up to the roof, then the roof's wedge (depth falling to 0 at 45°).
  const section = (s: number) => 2 * b.mouth * s + s * s;
  const groove = section(b.deep) * b.roofFoot + b.mouth * b.deep * b.deep + (b.deep * b.deep * b.deep) / 3;
  const inside = (b.width - 2 * b.wall) * (b.depth - b.back - b.wall) * (b.height - b.floor);
  return { insert: insertVolume() + rail, bin: b.width * b.depth * b.height - inside - groove };
}
