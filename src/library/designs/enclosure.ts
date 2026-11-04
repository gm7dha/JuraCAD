/**
 * An electronics enclosure: a box for a circuit board (a Raspberry Pi, an Arduino Uno or your own) standing on
 * standoffs at the board's mounting holes, and a lid that either screws down into posts in the corners (countersunk
 * screws, a short lip inside the rim to line it up) or snaps on (a lip with a small 45° ridge along each long side
 * that clicks into a matching groove inside the box's walls). Optional vent slots in the lid and up to two
 * rectangular cut-outs in the sides for plugs and cables.
 *
 * The box prints standing as it is and the lid upside down beside it (its top on the bed), so neither needs
 * supports: the groove and ridge have 45° faces, and the side cut-outs are small bridges.
 *
 * Holes in the standoffs and corner posts are either pilot holes for self-tapping screws, or holes for brass heat-set
 * inserts — sized from Ruthex's data sheet for its short inserts (M2.5: 3.6 mm across × 4 mm long, a 3.2 mm hole;
 * M3: 4.6 × 5.7 mm, a 4.0 mm hole), which most other makers' inserts match. The holes go right down to the floor.
 */
import { lit, minus, neg, plus, times, ZERO, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { facePlane, gridPatternFeature } from "../printKit";
import { joinSketches } from "../laserKit";
import type { Feature } from "../../model/types";
import type { SketchPlane } from "../../sketch/planes";
import type { Pt } from "../fingers";
import type { DesignInput, DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, roundedRect, sixPlaces, varsOf } from "./common";

const VARS = ["width", "depth", "height", "wall", "standoff", "lid", "clearance"];
const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;

/** Mounting holes of the boards offered, from the middle of the board (mm), and the screw size they take. */
export const BOARDS: Record<string, { label: string; size: [number, number]; holes: [number, number][]; screw: ScrewSize }> = {
  // Raspberry Pi 4 and 5 (the same holes): an 85 × 56 board, holes 58 × 49 apart, 3.5 mm in from the left and the bottom.
  pi: { label: "Raspberry Pi 4 / 5", size: [85, 56], holes: [[-39, -24.5], [19, -24.5], [-39, 24.5], [19, 24.5]], screw: "M2.5" },
  // Arduino Uno R3: 68.58 × 53.34 (2.7 × 2.1 in), holes at (0.55, 0.1), (0.6, 2.0), (2.6, 0.3) and (2.6, 1.4) in from the corner.
  uno: { label: "Arduino Uno", size: [68.58, 53.34], holes: [[-20.32, -24.13], [-19.05, 24.13], [31.75, -19.05], [31.75, 8.89]], screw: "M3" },
  custom: { label: "Another board", size: [0, 0], holes: [], screw: "M3" },
};
export type ScrewSize = "M2.5" | "M3";

/** Holes for the screws: a pilot hole for a self-tapping screw, or a hole for a heat-set insert (and the insert's length). */
export const SCREW_HOLES: Record<ScrewSize, { selfTap: number; insert: number; insertLength: number }> = {
  "M2.5": { selfTap: 2.2, insert: 3.2, insertLength: 4 },
  M3: { selfTap: 2.6, insert: 4.0, insertLength: 5.7 },
};
/** The lid's countersunk M3 screws: the hole and the countersink (ISO 10642's 6.72 mm head, a little over). */
export const LID_SCREW = { d: 3.4, head: 6.8 };
/** Snap lid: the lip (how far it reaches down, how thick), the ridge (how far it stands out, 45° each side) and where it is. */
export const SNAP = { lip: 8, lipWall: 1.2, ridge: 0.5, below: 6.5 };
/** Screw-down lid: the short lip that lines it up. */
export const LOCATE = { lip: 3, lipWall: 1.6 };
/** Vent slots: how wide and how far apart. */
export const VENT = { width: 2.5, pitch: 5 };
/** The space between the box and its lid when the lid is beside it (mm). */
export const LID_GAP = 10;
/** √2 − 1 to six places: how much further a 45° face moves along its rise when it's moved a set distance square to itself. */
const ROOT2_LESS_1 = sixPlaces(Math.SQRT2 - 1);

export const SIDES = ["front", "back", "left", "right"] as const;
type Side = (typeof SIDES)[number];
const sideChoices = [
  { value: "none", label: "None" },
  { value: "front", label: "Front" },
  { value: "back", label: "Back" },
  { value: "left", label: "Left end" },
  { value: "right", label: "Right end" },
];

function portInputs(n: 1 | 2, side: string, along: number, up: number, w: number, h: number): DesignInput[] {
  const k = `port${n}`;
  return [
    { key: `${k}Side`, label: `Cut-out ${n}`, kind: "choice", default: side, choices: sideChoices, help: n === 1 ? "A rectangular hole in a side for a plug or a cable." : undefined },
    { key: `${k}Along`, label: `Cut-out ${n}: across`, kind: "length", default: along, min: -500, max: 500, help: "From the middle of that side, + to the right as you look at it." },
    { key: `${k}Up`, label: `Cut-out ${n}: up`, kind: "length", default: up, min: 0, max: 500, help: "Its bottom edge, up from the floor inside." },
    { key: `${k}Width`, label: `Cut-out ${n}: width`, kind: "length", default: w, min: 2, max: 500 },
    { key: `${k}Height`, label: `Cut-out ${n}: height`, kind: "length", default: h, min: 2, max: 500 },
  ];
}

/** The board's holes (from the middle of the box) and its size, for these values. */
export function boardOf(v: DesignValues): { size: [number, number]; holes: [number, number][]; screw: ScrewSize } {
  if (v.board !== "custom") {
    const b = BOARDS[String(v.board)] ?? BOARDS.pi;
    return { size: b.size, holes: b.holes, screw: b.screw };
  }
  const [x, y] = [num(v, "holesX") / 2, num(v, "holesY") / 2];
  return { size: [num(v, "boardWidth"), num(v, "boardDepth")], holes: [[-x, -y], [x, -y], [-x, y], [x, y]], screw: v.screw === "M2.5" ? "M2.5" : "M3" };
}

/** Every number the enclosure is made from (plain numbers, for checks, the preview and tests). */
export function enclosurePlan(v: DesignValues) {
  const [W, D, H, wall, standoff, lidT, c] = VARS.map((k) => num(v, k));
  const board = boardOf(v);
  const insert = v.holes === "insert";
  const hole = SCREW_HOLES[board.screw][insert ? "insert" : "selfTap"];
  const lidHole = SCREW_HOLES.M3[insert ? "insert" : "selfTap"];
  const snap = v.fixing === "snap";
  return {
    inner: [W, D, H] as [number, number, number],
    outer: [W + 2 * wall, D + 2 * wall, H + wall] as [number, number, number],
    wall,
    clearance: c,
    lidThickness: lidT,
    board,
    standoff: { height: standoff, hole, diameter: Math.max(6, hole + 3.2) },
    /** Insert length (0 for self-tapping screws). */
    insertLength: insert ? SCREW_HOLES[board.screw].insertLength : 0,
    snap,
    /** Screw-down lid: the posts in the corners (square, `post` across) and the hole in each. */
    post: snap ? 0 : Math.max(7, lidHole + 4),
    postHole: lidHole,
    lip: snap ? SNAP.lip : LOCATE.lip,
    lipWall: snap ? SNAP.lipWall : LOCATE.lipWall,
    /** Snap lid: how far the groove reaches into the walls. */
    groove: snap ? SNAP.ridge + ROOT2_LESS_1 * c : 0,
    /** Where the lid's middle is when it's beside the box (it's in front, towards −y). */
    lidAt: -(D + 2 * wall + LID_GAP),
    vents: Math.round(num(v, "vents")),
  };
}

/**
 * How far the snap lid's lip is bent as the ridge rides over the box's rim (a cantilever, `SNAP.below` long and
 * `SNAP.lipWall` thick, pushed in by the ridge less the clearance): the stretch at its root, 3 t δ / 2 L².
 */
export function snapStrain(c: number): number {
  const d = Math.max(0, SNAP.ridge - c);
  return (3 * SNAP.lipWall * d) / (2 * SNAP.below ** 2);
}

/** Which ports are on, with their sizes. */
export function portsOf(v: DesignValues): { n: 1 | 2; side: Side; along: number; up: number; w: number; h: number }[] {
  return ([1, 2] as const).flatMap((n) => {
    const side = String(v[`port${n}Side`]);
    if (!SIDES.includes(side as Side)) return [];
    return [{ n, side: side as Side, along: num(v, `port${n}Along`), up: num(v, `port${n}Up`), w: num(v, `port${n}Width`), h: num(v, `port${n}Height`) }];
  });
}

/** Rectangles as points round their corners. */
const rectPts = (cx: Ex, cy: Ex, hw: Ex, hh: Ex): Pt[] => [
  [minus(cx, hw), minus(cy, hh)],
  [plus(cx, hw), minus(cy, hh)],
  [plus(cx, hw), plus(cy, hh)],
  [minus(cx, hw), plus(cy, hh)],
];

/** A rectangle with each corner notched by a square `n` across (the screw-down lid's lip, clear of the corner posts). */
function notched(cy: Ex, hx: Ex, hy: Ex, n: Ex): Pt[] {
  const [nx, ny] = [minus(hx, n), minus(hy, n)];
  const pts: [Ex, Ex][] = [
    [hx, neg(ny)], [hx, ny], [nx, ny], [nx, hy], [neg(nx), hy], [neg(nx), ny],
    [neg(hx), ny], [neg(hx), neg(ny)], [neg(nx), neg(ny)], [neg(nx), neg(hy)], [nx, neg(hy)], [nx, neg(ny)],
  ];
  return pts.map(([x, y]) => [x, plus(cy, y)]);
}

/** A 45° triangle on the Right plane: its flat side at y = `base`, its point `out` further (+1 or −1 way), round height z. */
function wedge(base: Ex, tip: Ex, z: Ex, half: Ex): Pt[] {
  return [
    [base, minus(z, half)],
    [tip, z],
    [base, plus(z, half)],
  ];
}

/** The side's face plane on the box (its outward face; sketch x to the right as you look at it, y up from the bed). */
function sidePlane(side: Side, box: string, vars: Record<string, Ex>): SketchPlane {
  const { width, depth, wall, height } = vars;
  const halfW = plus(times(width, 0.5), wall).v;
  const halfD = plus(times(depth, 0.5), wall).v;
  const midZ = plus(height, wall).v / 2;
  const label = `Box ${side}`;
  switch (side) {
    case "front":
      return facePlane(label, box, [0, -halfD, 0], [1, 0, 0], [0, 0, 1], [0, -halfD, midZ], [0.5, 0, 0.5]);
    case "back":
      return facePlane(label, box, [0, halfD, 0], [-1, 0, 0], [0, 0, 1], [0, halfD, midZ], [0.5, 1, 0.5]);
    case "left":
      return facePlane(label, box, [-halfW, 0, 0], [0, -1, 0], [0, 0, 1], [-halfW, 0, midZ], [0, 0.5, 0.5]);
    case "right":
      return facePlane(label, box, [halfW, 0, 0], [0, 1, 0], [0, 0, 1], [halfW, 0, midZ], [1, 0.5, 0.5]);
  }
}

function makeEnclosure(ctx: MakeContext) {
  const v = ctx.values;
  const p = enclosurePlan(v);
  const { width, depth, height, wall, standoff, lid: lidT, clearance: c } = ctx.vars;
  const outerW = plus(width, times(wall, 2));
  const outerD = plus(depth, times(wall, 2));
  const boxH = plus(wall, height);
  const box = ctx.id("box");
  const lidId = ctx.id("lid");
  const sk = (role: string, name: string, plane: SketchPlane, data: Parameters<typeof sketchFeature>[3]) => sketchFeature(ctx.id(role), name, plane, data);
  const rect = (cx: Ex, cy: Ex, w: Ex, h: Ex) => ({ type: "rectangle", center: [cx.t, cy.t], width: w.t, height: h.t });
  const circle = (x: Ex, y: Ex, d: Ex | number) => ({ type: "circle", center: [x.t, y.t], diameter: typeof d === "number" ? String(d) : d.t });

  const features: Feature[] = [
    sk("floor-sketch", "Box floor sketch", TOP, shapesSketch([rect(ZERO, ZERO, outerW, outerD)], ctx.scope)),
    extrudeFeature(box, "Box floor", ctx.id("floor-sketch"), { depth: wall, operation: "new" }),
    sk("walls-sketch", "Box walls sketch", TOP, shapesSketch([rect(ZERO, ZERO, outerW, outerD), rect(ZERO, ZERO, width, depth)], ctx.scope)),
    extrudeFeature(ctx.id("walls"), "Box walls", ctx.id("walls-sketch"), { depth: boxH, operation: "add" }),
    // The standoffs: a ring at each of the board's holes, from the bed up past the floor (the floor fills under the holes).
    sk("standoffs-sketch", "Standoffs sketch", TOP, shapesSketch(p.board.holes.flatMap(([x, y]) => [circle(lit(x), lit(y), p.standoff.diameter), circle(lit(x), lit(y), p.standoff.hole)]), ctx.scope)),
    extrudeFeature(ctx.id("standoffs"), "Standoffs", ctx.id("standoffs-sketch"), { depth: plus(wall, standoff), operation: "add" }),
  ];
  const corners: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  /** Where each corner post's hole is (the middle of the post inside the box). */
  const postAt = (sx: number, sy: number, cy: Ex = ZERO): [Ex, Ex] => [times(minus(times(width, 0.5), lit(p.post / 2)), sx), plus(cy, times(minus(times(depth, 0.5), lit(p.post / 2)), sy))];
  if (!p.snap) {
    // Square posts in the corners, reaching half-way into the walls (so they join them firmly), full height.
    const reach = (half: Ex) => plus(half, lit(-p.post / 2), times(wall, 0.25));
    const across = plus(lit(p.post), times(wall, 0.5));
    const shapes = corners.flatMap(([sx, sy]) => {
      const [hx, hy] = postAt(sx, sy);
      return [rect(times(reach(times(width, 0.5)), sx), times(reach(times(depth, 0.5)), sy), across, across), circle(hx, hy, p.postHole)];
    });
    features.push(
      sk("posts-sketch", "Lid screw posts sketch", TOP, shapesSketch(shapes, ctx.scope)),
      extrudeFeature(ctx.id("posts"), "Lid screw posts", ctx.id("posts-sketch"), { depth: boxH, operation: "add" }),
    );
  } else {
    // A groove inside each long wall (front and back) for the lid's ridge: the ridge's 45° shape, the clearance bigger
    // all round, starting a little inside the box so the cut is clean.
    const zc = minus(boxH, lit(SNAP.below));
    const halfD = times(depth, 0.5);
    const groove = plus(lit(SNAP.ridge), times(c, ROOT2_LESS_1));
    const half = plus(groove, lit(0.3));
    const s = joinSketches(
      outlineSketch(wedge(minus(halfD, lit(0.3)), plus(halfD, groove), zc, half), ctx.scope),
      outlineSketch(wedge(neg(minus(halfD, lit(0.3))), neg(plus(halfD, groove)), zc, half), ctx.scope),
    );
    features.push(
      sk("grooves-sketch", "Snap grooves sketch", RIGHT, s),
      extrudeFeature(ctx.id("grooves"), "Snap grooves", ctx.id("grooves-sketch"), { depth: plus(times(width, 0.5), times(c, 2)), operation: "remove", end: "symmetric" }),
    );
  }
  for (const port of portsOf(v)) {
    const role = `port${port.n}`;
    features.push(
      sk(`${role}-sketch`, `Cut-out ${port.n} sketch`, sidePlane(port.side, box, ctx.vars), shapesSketch([rect(lit(port.along), plus(wall, lit(port.up + port.h / 2)), lit(port.w), lit(port.h))], ctx.scope)),
      extrudeFeature(ctx.id(role), `Cut-out ${port.n}`, ctx.id(`${role}-sketch`), { depth: plus(wall, lit(0.5)), operation: "remove", flip: true }),
    );
  }

  // The lid, upside down (its top on the bed) in front of the box.
  const lidAt = neg(plus(outerD, lit(LID_GAP)));
  const lipH = lit(p.lip);
  const lipW = lit(p.lipWall);
  const hx = minus(times(width, 0.5), c);
  const hy = minus(times(depth, 0.5), c);
  features.push(
    sk("lid-sketch", "Lid sketch", TOP, shapesSketch([rect(ZERO, lidAt, outerW, outerD)], ctx.scope)),
    extrudeFeature(lidId, "Lid", ctx.id("lid-sketch"), { depth: lidT, operation: "new" }),
  );
  const lip = p.snap
    ? joinSketches(outlineSketch(rectPts(ZERO, lidAt, hx, hy), ctx.scope), outlineSketch(rectPts(ZERO, lidAt, minus(hx, lipW), minus(hy, lipW)), ctx.scope))
    : joinSketches(outlineSketch(notched(lidAt, hx, hy, lit(p.post)), ctx.scope), outlineSketch(notched(lidAt, minus(hx, lipW), minus(hy, lipW), lit(p.post)), ctx.scope));
  features.push(sk("lip-sketch", "Lid lip sketch", TOP, lip), extrudeFeature(ctx.id("lip"), "Lid lip", ctx.id("lip-sketch"), { depth: plus(lidT, lipH), operation: "add" }));
  if (p.snap) {
    // The ridges, on the lip's two long sides, half the box's width long.
    const zc = plus(lidT, lit(SNAP.below));
    const half = lit(SNAP.ridge + 0.3);
    const s = joinSketches(
      outlineSketch(wedge(plus(lidAt, minus(hy, lit(0.3))), plus(lidAt, hy, lit(SNAP.ridge)), zc, half), ctx.scope),
      outlineSketch(wedge(minus(lidAt, minus(hy, lit(0.3))), minus(lidAt, plus(hy, lit(SNAP.ridge))), zc, half), ctx.scope),
    );
    features.push(sk("ridges-sketch", "Snap ridges sketch", RIGHT, s), extrudeFeature(ctx.id("ridges"), "Snap ridges", ctx.id("ridges-sketch"), { depth: times(width, 0.5), operation: "add", end: "symmetric" }));
  } else {
    const holes = corners.map(([sx, sy]) => {
      const [x, y] = postAt(sx, sy, lidAt);
      return circle(x, y, LID_SCREW.d);
    });
    const drill = countersunkHoleFeature(ctx.id("lid-holes"), "Lid screw holes", ctx.id("lid-holes-sketch"), lit(LID_SCREW.d), lit(LID_SCREW.head));
    // Drilled up from the bed, so the countersinks are in the lid's top (it's printed upside down).
    features.push(sk("lid-holes-sketch", "Lid screw holes sketch", TOP, shapesSketch(holes, ctx.scope)), { ...drill, hole: { ...drill.hole!, flip: true } });
  }
  if (p.vents > 0) {
    const first = lit(-((p.vents - 1) * VENT.pitch) / 2);
    const half = minus(times(depth, 0.25), lit(VENT.width / 2));
    const slot = { type: "slot", from: [first.t, minus(lidAt, half).t], to: [first.t, plus(lidAt, half).t], width: String(VENT.width) };
    features.push(sk("vent-sketch", "Vent slot sketch", TOP, shapesSketch([slot], ctx.scope)), extrudeFeature(ctx.id("vent"), "Vent slot", ctx.id("vent-sketch"), { depth: plus(lidT, lit(1)), operation: "remove" }));
    if (p.vents > 1) features.push(gridPatternFeature(ctx.id("vents"), "Vent slots", [ctx.id("vent")], p.vents, lit(VENT.pitch), 1, lit(VENT.pitch)));
  }
  // Turned over and lowered onto the box: the lid's top rests on the rim, its lip inside.
  if (v.placement === "on") features.push(moveFeature(ctx.id("lid-on"), "Lid on the box", lidId, { rx: lit(180), dy: neg(lidAt), dz: minus(boxH, lipH) }));
  return { features, partNames: { [box]: `${ctx.name}: box`, [lidId]: `${ctx.name}: lid` } };
}

export const enclosure: LibraryDesign = {
  id: "enclosure",
  name: "Electronics enclosure",
  description:
    "A box for a circuit board — a Raspberry Pi 4 or 5, an Arduino Uno or your own board — standing on standoffs at its mounting holes, with a lid that screws down or snaps on. Add vent slots in the lid and cut-outs in the sides for plugs and cables. The holes are sized for self-tapping screws or brass heat-set inserts. The box prints as it stands and the lid upside down beside it, no supports.",
  category: "print",
  group: "Electronics",
  prefix: "encl",
  icon: '<rect x="5" y="14" width="38" height="26" rx="2"/><rect x="11" y="19" width="24" height="16" rx="1" opacity=".5"/><circle cx="14" cy="22" r="1.6"/><circle cx="32" cy="22" r="1.6"/><circle cx="14" cy="32" r="1.6"/><circle cx="32" cy="32" r="1.6"/><path d="M43 22h-4v6h4" opacity=".6"/><path d="M8 9h32" opacity=".55"/>',
  inputs: [
    { key: "board", label: "Board", kind: "choice", default: "pi", choices: Object.entries(BOARDS).map(([value, b]) => ({ value, label: b.label })) },
    { key: "boardWidth", label: "Board width", kind: "length", default: 70, min: 10, max: 400, help: "For another board: its size, left to right." },
    { key: "boardDepth", label: "Board depth", kind: "length", default: 50, min: 10, max: 400 },
    { key: "holesX", label: "Holes apart, across", kind: "length", default: 60, min: 0, max: 400, help: "For another board: four holes in a rectangle in its middle — how far apart they are, left to right…" },
    { key: "holesY", label: "Holes apart, front to back", kind: "length", default: 40, min: 0, max: 400, help: "…and front to back." },
    { key: "screw", label: "Board screws", kind: "choice", default: "M3", choices: [{ value: "M2.5", label: "M2.5" }, { value: "M3", label: "M3" }], help: "For another board. A Pi takes M2.5, an Uno M3." },
    {
      key: "holes",
      label: "Screw holes for",
      kind: "choice",
      default: "insert",
      choices: [
        { value: "insert", label: "Heat-set inserts" },
        { value: "selfTap", label: "Self-tapping screws" },
      ],
      help: "Inserts (brass threads you press in with a soldering iron) hold best and let you undo the screws many times.",
    },
    { key: "width", label: "Inside width", kind: "length", default: 104, min: 20, max: 500, variable: true, help: "The space inside, left to right." },
    { key: "depth", label: "Inside depth", kind: "length", default: 74, min: 20, max: 500, variable: true },
    { key: "height", label: "Inside height", kind: "length", default: 30, min: 8, max: 300, variable: true, help: "From the floor to the rim." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1.2, max: 10, variable: true, help: "Walls and floor. 2 mm is sturdy with a 0.4 mm nozzle." },
    { key: "standoff", label: "Standoff height", kind: "length", default: 6.5, min: 2, max: 50, variable: true, help: "How far the board sits above the floor." },
    {
      key: "fixing",
      label: "Lid",
      kind: "choice",
      default: "screws",
      choices: [
        { value: "screws", label: "Screwed down (4 countersunk M3 screws)" },
        { value: "snap", label: "Snaps on" },
      ],
    },
    { key: "lid", label: "Lid thickness", kind: "length", default: 3, min: 1.2, max: 10, variable: true },
    { key: "clearance", label: "Lid fit", kind: "length", default: 0.2, min: 0.1, max: 1, variable: true, help: "The gap all round the lid's lip, inside the box. 0.2 mm is snug." },
    { key: "vents", label: "Vent slots", kind: "count", default: 8, min: 0, max: 60, help: "Slots across the lid's middle; 0 for none." },
    ...portInputs(1, "front", 0, 6, 12, 6),
    ...portInputs(2, "none", 0, 6, 10, 8),
    {
      key: "placement",
      label: "Lid position",
      kind: "choice",
      default: "beside",
      choices: [
        { value: "beside", label: "In front of the box, ready to print" },
        { value: "on", label: "On the box" },
      ],
      help: "On the box shows how they go together; put it back in front before printing.",
    },
  ],
  problems: (v) => {
    const p = enclosurePlan(v);
    const out: string[] = [];
    const [W, D, H] = p.inner;
    const [bw, bd] = p.board.size;
    if (v.board === "custom") {
      if (num(v, "holesX") > bw - 4 || num(v, "holesY") > bd - 4) out.push("The board's holes must be at least 2 mm in from its edges: make the holes closer together, or the board bigger.");
      if (num(v, "holesX") < p.standoff.diameter || num(v, "holesY") < p.standoff.diameter) out.push(`The standoffs (${mm(p.standoff.diameter)} across) would run into each other: put the holes at least that far apart.`);
    }
    if (W < bw + 2 || D < bd + 2) out.push(`The board (${mm(bw)} × ${mm(bd)}) needs at least ${mm(bw + 2)} × ${mm(bd + 2)} inside.`);
    for (const [x, y] of p.board.holes) {
      const r = p.standoff.diameter / 2;
      if (Math.abs(x) + r > W / 2 - 0.5 || Math.abs(y) + r > D / 2 - 0.5) {
        out.push("A standoff runs into the walls: make the inside bigger.");
        break;
      }
    }
    if (!p.snap) {
      const room = [(W - bw) / 2, (D - bd) / 2];
      if (room[0] < p.post + 0.5 && room[1] < p.post + 0.5)
        out.push(`The board's corners would sit on the lid's screw posts (${mm(p.post)} square, in the corners): make the inside at least ${mm(bw + 2 * p.post + 1)} wide or ${mm(bd + 2 * p.post + 1)} deep.`);
      if (p.lidThickness < (LID_SCREW.head - LID_SCREW.d) / 2 + 0.6) out.push(`A lid for countersunk screws must be at least ${mm((LID_SCREW.head - LID_SCREW.d) / 2 + 0.6)} thick.`);
      if (W < 2 * (p.post + p.lipWall + p.clearance) + 4 || D < 2 * (p.post + p.lipWall + p.clearance) + 4) out.push("The box is too small for screw posts in its corners: make it bigger, or have a snap-on lid.");
    } else {
      if (p.clearance > SNAP.ridge - 0.15) out.push(`A snap-on lid's ridge stands out ${mm(SNAP.ridge)}: make the lid fit at most ${mm(SNAP.ridge - 0.15)}, or it won't hold.`);
      if (p.wall < p.groove + 0.8) out.push(`The walls must be at least ${mm(p.groove + 0.8)} thick to take the snap groove.`);
    }
    if (H < p.standoff.height + 1.6 + 2 + p.lip) out.push(`The inside must be at least ${mm(p.standoff.height + 1.6 + 2 + p.lip)} high: the standoffs, a board 1.6 mm thick, 2 mm over it and the lid's ${mm(p.lip)} lip.`);
    if (p.insertLength && p.standoff.height < p.insertLength + 0.5) out.push(`${p.board.screw} inserts are ${mm(p.insertLength)} long: make the standoffs at least ${mm(p.insertLength + 0.5)} tall, or use self-tapping screws.`);
    if (p.vents > 0) {
      const room = W - 2 * (p.clearance + p.lipWall) - 4 - (p.snap ? 0 : 2 * p.post);
      if ((p.vents - 1) * VENT.pitch + VENT.width > room) out.push(`${p.vents} vent slots don't fit across the lid: have at most ${Math.max(0, Math.floor((room - VENT.width) / VENT.pitch) + 1)}.`);
    }
    for (const port of portsOf(v)) {
      const long = port.side === "front" || port.side === "back" ? W : D;
      const keep = (p.snap ? 0 : p.post) + 1;
      if (Math.abs(port.along) + port.w / 2 > long / 2 - keep) out.push(`Cut-out ${port.n} reaches past the end of its side${p.snap ? "" : " or into a screw post"}: move it nearer the middle, or make it narrower.`);
      if (port.up + port.h > H - p.lip - 1) out.push(`Cut-out ${port.n} reaches up into the lid's lip: keep its top at least ${mm(p.lip + 1)} below the rim (${mm(H - p.lip - 1)} up at most).`);
    }
    return out;
  },
  summary: (v) => {
    const p = enclosurePlan(v);
    const what = p.insertLength ? `${p.board.screw} heat-set inserts (${mm(p.standoff.hole)} holes)` : `${p.board.screw} self-tapping screws (${mm(p.standoff.hole)} holes)`;
    return `2 parts. The box is ${mm(p.outer[0])} × ${mm(p.outer[1])} × ${mm(p.outer[2])} outside; the board stands on ${p.board.holes.length} standoffs ${mm(p.standoff.height)} tall, for ${what}. ${p.snap ? "The lid snaps on." : "The lid takes four M3 countersunk screws."}`;
  },
  make: makeEnclosure,
  preview: (v) => {
    const p = enclosurePlan(v);
    const [W, D] = p.inner;
    const [Wo, Do] = p.outer;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: roundedRect(Wo, Do, 0) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(W, D, 0) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(p.board.size[0], p.board.size[1], 2) },
    ];
    for (const [x, y] of p.board.holes) out.push({ kind: "circle", c: [x, y], r: p.standoff.diameter / 2 }, { kind: "circle", c: [x, y], r: p.standoff.hole / 2, faint: true });
    if (!p.snap) for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) out.push({ kind: "poly", closed: true, points: roundedRect(p.post, p.post, 0, sx * (W / 2 - p.post / 2), sy * (D / 2 - p.post / 2)) });
    const y = p.lidAt;
    out.push({ kind: "poly", closed: true, points: roundedRect(Wo, Do, 0, 0, y) });
    for (let i = 0; i < p.vents; i++) out.push({ kind: "poly", closed: true, faint: true, points: roundedRect(VENT.width, D / 2, VENT.width / 2, (i - (p.vents - 1) / 2) * VENT.pitch, y) });
    out.push({ kind: "text", at: [0, y - Do / 2 - 6], text: "lid, upside down" });
    return out;
  },
};

/** For tests: the box's and the lid's volumes (mm³). */
export function enclosureVolumes(v: DesignValues): { box: number; lid: number } {
  const p = enclosurePlan(v);
  const [W, D, H] = p.inner;
  const [Wo, Do, Ho] = p.outer;
  const { wall, clearance: c, lidThickness: t } = p;
  const ring = (d: number, h: number) => (Math.PI / 4) * (d * d - h * h);
  let box = Wo * Do * Ho - W * D * H + p.board.holes.length * ring(p.standoff.diameter, p.standoff.hole) * p.standoff.height;
  if (!p.snap) box += 4 * (p.post * p.post - (Math.PI / 4) * p.postHole ** 2) * H;
  else box -= 2 * p.groove ** 2 * (W / 2 + 2 * c);
  for (const port of portsOf(v)) box -= port.w * port.h * wall;
  const [hx, hy] = [W / 2 - c, D / 2 - c];
  const lw = p.lipWall;
  let lip = 4 * hx * hy - 4 * (hx - lw) * (hy - lw);
  if (!p.snap) lip = 4 * hx * hy - 4 * p.post ** 2 - (4 * (hx - lw) * (hy - lw) - 4 * p.post ** 2);
  let lid = Wo * Do * t + lip * p.lip;
  if (p.snap) lid += 2 * SNAP.ridge ** 2 * (W / 2);
  else lid -= 4 * countersunkHoleVolume(LID_SCREW.d, LID_SCREW.head, t);
  const slot = (D / 2 - VENT.width) * VENT.width + (Math.PI / 4) * VENT.width ** 2;
  lid -= p.vents * slot * t;
  return { box, lid };
}

/** For tests: the variables' numbers as expressions. */
export const enclosureVars = (v: DesignValues) => varsOf(v, VARS);
