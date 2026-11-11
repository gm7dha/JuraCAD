/**
 * Six-piece burr (3D printing, Puzzles): the classic interlocking puzzle of six notched square sticks, a new one for
 * every pattern number, checked to come apart (src/library/burr.ts). Each piece lies on the bed along x, turned about
 * its length so as few cubes as possible bridge a gap, side by side in y. Every piece is `fit` smaller all round than
 * its cubes, and every notch `fit` bigger, so the pieces slide. No variables: the pieces are worked out from the
 * pattern, so "Edit design sizes" makes them again.
 */
import { AXIS, CROSS, DIFFICULTIES, LENGTH, laidFlat, makeBurr, type V3 } from "../burr";
import { lit, type Ex } from "../ex";
import { BADGE_ROOT, CUT_START, MOST_SHAPES, badgesFree, isPlain, pieceWork, shapeCount, surfaceInputs, surfaceOf, type FaceWork } from "../burrSurface";
import { addTextBlock } from "../textKit";
import { loopsSketch } from "./mouldKit";
import { circleShape } from "./printShapes";
import { MIN_LABEL } from "./testPrints";
import { offsetPolygon, type P2 } from "../outlines";
import { fixedPlane, levelPlane } from "../printKit";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num } from "./common";

/** Room between pieces on the bed (mm). */
export const PIECE_GAP = 6;

/** The outlines of a set of unit squares (cells [x, y]), anticlockwise, corners at whole numbers. */
export function cellOutlines(cells: [number, number][]): P2[][] {
  const has = new Set(cells.map(([x, y]) => `${x},${y}`));
  const on = (x: number, y: number) => has.has(`${x},${y}`);
  // Each boundary edge, walked with the cells on its left; a corner two squares only touch at has two ways on.
  const next = new Map<string, P2[]>();
  const edge = (from: P2, to: P2) => {
    const k = `${from[0]},${from[1]}`;
    next.set(k, [...(next.get(k) ?? []), to]);
  };
  for (const [x, y] of cells) {
    if (!on(x, y - 1)) edge([x, y], [x + 1, y]);
    if (!on(x + 1, y)) edge([x + 1, y], [x + 1, y + 1]);
    if (!on(x, y + 1)) edge([x + 1, y + 1], [x, y + 1]);
    if (!on(x - 1, y)) edge([x, y + 1], [x, y]);
  }
  const take = (from: P2, dir: P2 | null): P2 | null => {
    const k = `${from[0]},${from[1]}`;
    const ways = next.get(k);
    if (!ways?.length) return null;
    // At a corner where squares only touch, turn left: that keeps each square's outline to itself.
    let pick = 0;
    if (dir && ways.length > 1) {
      const turn = (w: P2) => dir[0] * (w[1] - from[1]) - dir[1] * (w[0] - from[0]);
      pick = ways.reduce((best, w, i) => (turn(w) > turn(ways[best]) ? i : best), 0);
    }
    const [to] = ways.splice(pick, 1);
    if (!ways.length) next.delete(k);
    return to;
  };
  const loops: P2[][] = [];
  while (next.size) {
    const [startKey] = next.keys();
    const start = startKey.split(",").map(Number) as P2;
    const loop: P2[] = [start];
    let from = start;
    let to = take(start, null);
    while (to && !(to[0] === start[0] && to[1] === start[1])) {
      loop.push(to);
      const dir: P2 = [to[0] - from[0], to[1] - from[1]];
      from = to;
      to = take(to, dir);
    }
    // Keep only the corners.
    loops.push(loop.filter((p, i) => {
      const [a, b] = [loop[(i + loop.length - 1) % loop.length], loop[(i + 1) % loop.length]];
      return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
    }));
  }
  return loops;
}

export interface BurrLayout {
  /** The pieces' cubes in the assembled puzzle. */
  pieces: V3[][];
  unit: number;
  fit: number;
  /** Each piece's cubes as laid on the bed: (along, across, up) in cubes. */
  laid: V3[][];
  /** How each piece was turned about its length, and its cross-section's lowest cube (before turning). */
  turns: number[];
  mins: [number, number][];
  level: number;
  gaps: number;
  bridges: number;
}

export function burrLayout(v: DesignValues): BurrLayout {
  const burr = makeBurr(num(v, "pattern"), String(v.difficulty));
  const laid = burr.pieces.map((p, i) => laidFlat(p, AXIS[i]));
  return { pieces: burr.pieces, unit: num(v, "size") / 2, fit: num(v, "fit"), laid: laid.map((l) => l.cells), turns: laid.map((l) => l.turn), mins: laid.map((l) => l.min), level: burr.level, gaps: burr.gaps, bridges: laid.reduce((n, l) => n + l.overhangs, 0) };
}

/**
 * Where a point of the assembled puzzle (mm, the middle at the origin) is on piece i as it lies on the bed (mm): the
 * piece's length along x, its cross-section turned as laid, and f lower as the piece is drawn standing on the bed.
 */
export function assembledToBed(L: BurrLayout, i: number, p: V3): V3 {
  const U = L.unit;
  const axis = AXIS[i];
  let u = p[CROSS[axis][0]] / U - L.mins[i][0];
  let w = p[CROSS[axis][1]] / U - L.mins[i][1];
  for (let k = 0; k < L.turns[i]; k++) [u, w] = [2 - w, u];
  return [(p[axis] / U + LENGTH / 2) * U, pieceY(i, U) + u * U, w * U - L.fit];
}

/** Where piece i lies across the bed (its y, mm). */
export const pieceY = (i: number, unit: number) => i * (2 * unit + PIECE_GAP);

const outline = (pts: P2[], ctx: MakeContext) => outlineSketch(pts.map(([x, y]) => [lit(x), lit(y)] as [Ex, Ex]), ctx.scope);

/** What's engraved on (or added to) each piece's faces — nothing at all for plain sticks (burrSurface.ts). */
export function burrWork(v: DesignValues, L = burrLayout(v)): FaceWork[][] {
  const s = surfaceOf(v, L.unit);
  return L.pieces.map((piece, i) => pieceWork(s, { piece, axis: AXIS[i], turn: L.turns[i], min: L.mins[i], y0: pieceY(i, L.unit) }, i, L.unit, L.fit));
}

const FACE_LABEL = { top: "top", bed: "underside", front: "front side", back: "back side", left: "left end", right: "right end" } as const;

/**
 * Marks per sketch. The engine fuses a sketch's shapes one after another (each fuse slower than the last), so a face's
 * marks are cut a batch at a time: about as quick as it gets for many small shapes.
 */
export const MARKS_PER_CUT = 12;

/** One face's decoration as sketches on a plane by the face and extrudes (cut in, or the badge added). */
function faceFeatures(w: FaceWork, i: number, ctx: MakeContext): Feature[] {
  const role = `piece-${i}-${w.face}-${w.kind}`;
  const label = `Piece ${i + 1} ${w.kind === "badge" ? "badge" : w.kind === "number" ? "number" : "pattern"}`;
  const batches: FaceWork["marks"][] = [];
  for (let k = 0; k < w.marks.length; k += MARKS_PER_CUT) batches.push(w.marks.slice(k, k + MARKS_PER_CUT));
  if (!batches.length) batches.push([]);
  return batches.flatMap((marks, k) => {
    const r = k ? `${role}-${k + 1}` : role;
    let data = loopsSketch(marks.map((m) => ("pts" in m ? outline(m.pts, ctx) : shapesSketch([circleShape(m.c[0], m.c[1], m.d)], ctx.scope))));
    if (w.number) data = addTextBlock(data, { font: "bold", capHeight: w.number.cap, lines: [w.number.text], centre: w.number.centre });
    const sk = sketchFeature(ctx.id(`${r}-sketch`), label, fixedPlane(`Piece ${i + 1} ${FACE_LABEL[w.face]}`, w.origin, w.u, w.v), data);
    const cut =
      w.kind === "badge"
        ? extrudeFeature(ctx.id(r), label, sk.id, { depth: lit(r6(w.depth + BADGE_ROOT)), operation: "add" })
        : extrudeFeature(ctx.id(r), label, sk.id, { depth: lit(r6(w.depth + CUT_START)), operation: "remove", flip: true });
    return [sk, cut];
  });
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const sixPieceBurr: LibraryDesign = {
  id: "six-piece-burr",
  name: "Six-piece burr",
  description:
    "The classic interlocking puzzle of six notched square sticks — a different one for every pattern number, checked to come apart and go back together. Decorate the sticks with a surface pattern and number their ends: patterns are cut shallowly into the faces that show when it's together, so the sliding is never affected.",
  category: "print",
  group: "Puzzles",
  prefix: "burr",
  icon: '<path d="M6 20h36v8H6zM20 6h8v36h-8z"/><path d="M20 20h8v8h-8z" opacity=".55"/>',
  inputs: [
    { key: "size", label: "Stick thickness", kind: "length", default: 20, min: 8, max: 60, help: "Each stick is this square and four times as long." },
    { key: "difficulty", label: "Difficulty", kind: "choice", default: "medium", choices: Object.entries(DIFFICULTIES).map(([value, d]) => ({ value, label: d.label })) },
    { key: "pattern", label: "Puzzle number", kind: "count", default: 1, min: 1, max: 99999, help: "Each number gives a different burr." },
    { key: "fit", label: "Fit gap", kind: "length", default: 0.2, min: 0, max: 0.6, help: "Room round every piece, each side. 0.2 mm suits most printers." },
    ...surfaceInputs(),
  ],
  problems: (v) => {
    if (num(v, "fit") * 4 >= num(v, "size") / 2) return ["The fit gap is too big for sticks this thin."];
    const L = burrLayout(v);
    const s = surfaceOf(v, L.unit);
    if (isPlain(s)) return [];
    const out: string[] = [];
    const work = burrWork(v, L);
    if (Math.max(...work.map(shapeCount)) > MOST_SHAPES) out.push("That's too much pattern detail to build quickly — choose fewer pattern repeats across.");
    if (s.pattern !== "none" && work.every((w) => w.every((f) => f.kind !== "engrave"))) out.push("The sticks are too thin for this pattern — choose fewer pattern repeats across, or thicker sticks.");
    // Numbers smaller than the fit test's smallest don't print legibly.
    if (s.ends === "badge" || s.ends === "number") {
      const caps = work.flatMap((w) => w.filter((f) => f.number).map((f) => f.number!.cap));
      if (!caps.length || Math.min(...caps) < MIN_LABEL)
        out.push(s.ends === "badge" ? "These sticks are too thin for raised badges — choose engraved numbers, or thicker sticks." : "These sticks are too thin for engraved numbers — choose plain ends, or thicker sticks.");
    }
    if (s.ends === "badge" && !badgesFree(L.pieces, L.level, `${num(v, "pattern")}:${String(v.difficulty)}`))
      out.push("Raised badges on the ends would get in the way of this puzzle's moves — choose engraved numbers instead.");
    return out;
  },
  make: (ctx) => {
    const L = burrLayout(ctx.values);
    const { unit: U, fit: f } = L;
    const work = burrWork(ctx.values, L);
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    L.laid.forEach((cells, i) => {
      const y0 = pieceY(i, U);
      const sk = ctx.id(`piece-${i}-sketch`);
      const id = ctx.id(`piece-${i}`);
      features.push(
        sketchFeature(sk, `Piece ${i + 1}`, { kind: "default", name: "Top" }, outline([[f, y0 + f], [LENGTH * U - f, y0 + f], [LENGTH * U - f, y0 + 2 * U - f], [f, y0 + 2 * U - f]], ctx)),
        extrudeFeature(id, `Piece ${i + 1}`, sk, { depth: lit(2 * U - 2 * f), operation: "new" }),
      );
      partNames[id] = `${ctx.name} piece ${i + 1}`;
      // Notches: columns with no cubes (cut through), the top cube only, or the bottom cube only (a short bridge).
      const has = new Set(cells.map(([a, u, w]) => `${a},${u},${w}`));
      const kinds: Record<"through" | "top" | "bottom", [number, number][]> = { through: [], top: [], bottom: [] };
      for (let a = 0; a < LENGTH; a++)
        for (let u = 0; u < 2; u++) {
          const [lo, hi] = [has.has(`${a},${u},0`), has.has(`${a},${u},1`)];
          if (!lo && !hi) kinds.through.push([a, u]);
          else if (lo && !hi) kinds.top.push([a, u]);
          else if (!lo && hi) kinds.bottom.push([a, u]);
        }
      // The piece is drawn f lower than its cubes (it stands on the bed), so its layers meet at U − f.
      const span = { through: [-1, 2 * U + 1], top: [U - 2 * f, 2 * U + 1], bottom: [-1, U] };
      for (const kind of ["through", "top", "bottom"] as const)
        cellOutlines(kinds[kind]).forEach((loop, k) => {
          const pts = offsetPolygon(loop.map(([a, u]): P2 => [a * U, y0 + u * U]), f);
          const nsk = ctx.id(`piece-${i}-${kind}-${k}-sketch`);
          const [z0, z1] = span[kind];
          features.push(
            sketchFeature(nsk, `Piece ${i + 1} notch`, levelPlane(`Piece ${i + 1} notch`, z0), outline(pts, ctx)),
            extrudeFeature(ctx.id(`piece-${i}-${kind}-${k}`), `Piece ${i + 1} notch`, nsk, { depth: lit(z1 - z0), operation: "remove" }),
          );
        });
      // Decorations last, while this piece is still the latest part (none at all for plain sticks).
      for (const w of work[i]) features.push(...faceFeatures(w, i, ctx));
    });
    return { features, partNames };
  },
  preview: (v) => {
    const L = burrLayout(v);
    const s = 2 * L.unit;
    const shapes: PreviewShape[] = [];
    // Each piece seen from above, its top layer's cubes drawn, cubes only underneath faint.
    L.laid.forEach((cells, i) => {
      const y0 = pieceY(i, L.unit);
      shapes.push({ kind: "poly", points: [[0, y0], [LENGTH * L.unit, y0], [LENGTH * L.unit, y0 + s], [0, y0 + s]], closed: true, faint: true });
      for (const [a, u, w] of cells)
        if (w === 1 || !cells.some((c) => c[0] === a && c[1] === u && c[2] === 1))
          shapes.push({ kind: "poly", points: [[a * L.unit, y0 + u * L.unit], [(a + 1) * L.unit, y0 + u * L.unit], [(a + 1) * L.unit, y0 + (u + 1) * L.unit], [a * L.unit, y0 + (u + 1) * L.unit]], closed: true, faint: w === 0 });
    });
    return shapes;
  },
  summary: (v) => {
    const L = burrLayout(v);
    const plain = `Comes apart in ${L.level} ${L.level === 1 ? "move" : "moves"} before the first piece is free${L.gaps ? `; ${L.gaps} empty cubes inside` : ""}. Sticks ${mm(2 * L.unit)} square, ${mm(LENGTH * L.unit)} long${L.bridges ? `; ${L.bridges} short bridges to print` : ""}.`;
    const s = surfaceOf(v, L.unit);
    if (isPlain(s)) return plain;
    const notes: string[] = [];
    if (s.pattern !== "none")
      notes.push(`Pattern cut ${mm(s.depth)} deep${s.depth < s.asked - 1e-9 ? " (the most for sticks this thin)" : ""} into the faces that show when it's together; the face lying on the bed is left plain, as its first layers would fill a shallow groove.`);
    if (s.ends === "number" || s.ends === "badge") notes.push(`Each end carries its piece's number (1–6)${s.ends === "badge" ? ` on a raised diamond ${mm(s.depth)} high, sloping at 45° so it prints without supports` : ""}.`);
    else if (s.ends === "pattern" && s.pattern !== "none") notes.push("The ends have the pattern too.");
    return [plain, ...notes].join(" ");
  },
};
