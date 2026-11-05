/**
 * A name puzzle for children: the letters of a name cut out of a board as separate pieces, to take out and put back.
 * Each letter is its own piece; the board has a letter-shaped hole for each. The middles of letters such as A, B, O and R
 * are cut out of the pieces (so they're real letters) but not out of the board — the hole is just the letter's outline.
 * An optional backing board glued under the board turns the holes into trays the letters sit in.
 *
 * Letters are laid out left to right, each `gap` from the next (so no two pieces or holes ever touch), each centred
 * on the board's middle line. Sizes as cut: a letter piece is its true outline; its hole is that outline moved out by
 * `play` all round, so it drops in easily. A laser burns away kerf/2 either side of every cut, so pieces are drawn
 * kerf/2 bigger and holes kerf/2 smaller (outlines.ts `offsetPolygon`).
 *
 * The outlines are straight pieces through the font's letter shapes (as Text draws them), each corner dimensioned from
 * the origin; "Edit design sizes" makes them again for a new name.
 */
import { lit, neg } from "../ex";
import { depths } from "../bridges";
import { joinSketches } from "../laserKit";
import { boxOf, crossesItself, offsetPolygon, outlineGap, round6, fitsBed, type Box, type P2 } from "../outlines";
import { extrudeFeature, moveFeature, outlineSketch, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { blockContours, fontInput, fontOf } from "../textKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import { mm, num } from "./common";
import { wordsInput, wordsProblems } from "./stencil";

const TOP = { kind: "default", name: "Top" } as const;
/** The thinnest strip of board allowed between two holes (mm). */
export const MIN_BRIDGE = 3;

export interface PuzzleLetter {
  ch: string;
  /** Its outlines (more than one for i, j, ! …) and the middles cut out of it, true size, where it sits. */
  outers: P2[][];
  counters: P2[][];
  box: Box;
}

export interface NamePuzzle {
  letters: PuzzleLetter[];
  /** The board: w × h, centred on the origin, corners rounded r. */
  w: number;
  h: number;
  r: number;
}

const cache = new Map<string, NamePuzzle>();

export function namePuzzle(v: DesignValues): NamePuzzle {
  const key = JSON.stringify([v.words, v.font, v.height, v.gap, v.margin]);
  const known = cache.get(key);
  if (known) return known;
  const [cap, gap, margin] = ["height", "gap", "margin"].map((k) => num(v, k));
  const font = fontOf(v);
  const text = String(v.words ?? "").trim();
  const letters: PuzzleLetter[] = [];
  let x = 0;
  for (const ch of Array.from(text)) {
    if (!ch.trim()) {
      x += cap * 0.5;
      continue;
    }
    const contours = blockContours({ font, capHeight: cap, lines: [ch] });
    if (!contours.length) continue;
    const dep = depths(contours);
    const outers = contours.filter((_, i) => dep[i] % 2 === 0);
    const counters = contours.filter((_, i) => dep[i] % 2 === 1);
    const b = boxOf(outers.flat());
    // Its left edge at x (after the gap), its middle on the board's middle line.
    const [dx, dy] = [x - b[0], -(b[1] + b[3]) / 2];
    const move = (c: P2[]) => round6(c.map(([px, py]) => [px + dx, py + dy] as P2));
    letters.push({ ch, outers: outers.map(move), counters: counters.map(move), box: [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy] });
    x += b[2] - b[0] + gap;
  }
  // The whole name centred on the origin.
  const width = letters.length ? letters[letters.length - 1].box[2] - letters[0].box[0] : 0;
  const shift = letters.length ? -letters[0].box[0] - width / 2 : 0;
  for (const l of letters) {
    l.outers = l.outers.map((c) => round6(c.map(([px, py]) => [px + shift, py] as P2)));
    l.counters = l.counters.map((c) => round6(c.map(([px, py]) => [px + shift, py] as P2)));
    l.box = [l.box[0] + shift, l.box[1], l.box[2] + shift, l.box[3]];
  }
  const tall = letters.reduce((m, l) => Math.max(m, l.box[3] - l.box[1]), 0);
  const out: NamePuzzle = { letters, w: Math.round((width + 2 * margin) * 1000) / 1000, h: Math.round((tall + 2 * margin) * 1000) / 1000, r: Math.min(10, margin) };
  if (cache.size > 20) cache.clear();
  cache.set(key, out);
  return out;
}

/** A letter's holes in the board (true size: its outlines moved out by the play). */
export const holesOf = (l: PuzzleLetter, play: number) => l.outers.map((c) => offsetPolygon(c, play));

/** As drawn for the laser: pieces kerf/2 bigger (their middles kerf/2 smaller), holes kerf/2 smaller. */
export function drawnLetter(l: PuzzleLetter, kerf: number): P2[][] {
  return [...l.outers.map((c) => round6(offsetPolygon(c, kerf / 2))), ...l.counters.map((c) => round6(offsetPolygon(c, -kerf / 2)))];
}
export const drawnHoles = (l: PuzzleLetter, play: number, kerf: number) => l.outers.map((c) => round6(offsetPolygon(c, play - kerf / 2)));

export function puzzleProblems(v: DesignValues): string[] {
  const out = wordsProblems(v);
  if (out.length) return out;
  const p = namePuzzle(v);
  if (!p.letters.length) return ["Type a name."];
  if (!fitsBed(p.w, p.h)) return [`The board would be ${mm(p.w)} × ${mm(p.h)}: too big for the laser's 600 × 300 mm bed. Use smaller letters or a shorter name.`];
  const [play, kerf, t] = ["play", "kerf", "thickness"].map((k) => num(v, k));
  if (kerf >= 1) return ["A kerf allowance that big is unusual: lasers usually burn away 0.1–0.3 mm."];
  const holes = p.letters.flatMap((l, i) => holesOf(l, play).map((c) => ({ i, c, box: boxOf(c) })));
  const room = Math.max(MIN_BRIDGE, t);
  for (let a = 0; a < holes.length; a++)
    for (let b = a + 1; b < holes.length; b++) {
      const [A, B] = [holes[a], holes[b]];
      const far = Math.hypot(Math.max(0, A.box[0] - B.box[2], B.box[0] - A.box[2]), Math.max(0, A.box[1] - B.box[3], B.box[1] - A.box[3]));
      if (far >= room) continue;
      if (outlineGap(A.c, B.c, room) < room) {
        const ch = p.letters[A.i].ch;
        return [A.i === B.i ? `The two parts of "${ch}" are too close together to cut apart: use capital letters, or make the letters bigger.` : `The letters would be less than ${mm(room)} apart: make the gap between letters bigger.`];
      }
    }
  for (const l of p.letters)
    for (const c of [...drawnLetter(l, kerf), ...drawnHoles(l, play, kerf)])
      if (crossesItself(c)) return [`"${l.ch}" has corners too sharp for that much room round it: use less room round the letters.`];
  return [];
}

/** Closed outlines, every corner dimensioned from the origin (so the sketch is fully defined). */
const loopsSketch = (loops: P2[][], scope: Record<string, number>): SketchData => joinSketches(...loops.map((l) => outlineSketch(l.map(([x, y]) => [lit(x), lit(y)]), scope)));

function board(p: NamePuzzle, scope: Record<string, number>): SketchData {
  const s = shapesSketch([{ type: "rectangle", center: [0, 0], width: p.w, height: p.h }], scope);
  return roundCorners(s, lit(p.r), scope);
}

export const namePuzzleDesign: LibraryDesign = {
  id: "name-puzzle",
  name: "Name puzzle",
  group: "Toys and gifts",
  description:
    "A child's name as a puzzle: each letter is a piece cut out of a board, to take out and put back in its own letter-shaped hole. With the backing board glued underneath, the holes become trays the letters sit in. Thick, chunky letters work best; sand the edges smooth for small hands.",
  category: "laser",
  prefix: "namepuzzle",
  icon: '<rect x="4" y="12" width="40" height="24" rx="3"/><path d="M10 31l5-14 5 14M12 26h6"/><path d="M24 17v14h7" /><path d="M34 31V17h4a4 4 0 0 1 0 8h-4" opacity=".6"/>',
  inputs: [
    wordsInput("ALEX", { label: "Name", maxLength: 12, help: "Up to 12 letters. Capitals are chunkiest." }),
    fontInput("bold"),
    { key: "height", label: "Letter height", kind: "length", default: 50, min: 20, max: 200, help: "How tall the capital letters are." },
    { key: "gap", label: "Gap between letters", kind: "length", default: 8, min: 3, max: 50, help: "Board left between the holes." },
    { key: "margin", label: "Border", kind: "length", default: 12, min: 6, max: 60, help: "Board round the letters." },
    { key: "play", label: "Room round each letter", kind: "length", default: 0.3, min: 0, max: 2, help: "How much bigger each hole is than its letter, all round, so little fingers can drop it in." },
    { key: "backing", label: "Backing board", kind: "toggle", default: true, help: "A plain board glued under the board, so the letters sit in trays." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1, max: 12, variable: true, help: "6 mm plywood or MDF makes sturdy pieces." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Letters are drawn this much bigger and holes this much smaller, so the room round them is just what you set." },
  ],
  problems: puzzleProblems,
  summary: (v) => {
    const p = namePuzzle(v);
    return `${p.letters.length} letter piece${p.letters.length === 1 ? "" : "s"} in a ${mm(p.w)} × ${mm(p.h)} board${v.backing !== false ? ", with a backing board" : ""}.`;
  },
  make: (ctx) => {
    const p = namePuzzle(ctx.values);
    const [play, kerf] = [num(ctx.values, "play"), num(ctx.values, "kerf")];
    const t = ctx.vars.thickness;
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const holes = p.letters.flatMap((l) => drawnHoles(l, play, kerf));
    const boardId = ctx.id("board");
    // Board: the plate with the holes, downwards from the Top plane (its top face level with the letters').
    features.push(
      sketchFeature(ctx.id("board-sketch"), "Board sketch", TOP, joinSketches(board(p, ctx.scope), loopsSketch(holes, ctx.scope))),
      extrudeFeature(boardId, "Board", ctx.id("board-sketch"), { depth: t, operation: "new", flip: true }),
    );
    partNames[boardId] = `${ctx.name} board`;
    if (ctx.values.backing !== false) {
      const back = ctx.id("backing");
      features.push(
        sketchFeature(ctx.id("backing-sketch"), "Backing sketch", TOP, board(p, ctx.scope)),
        extrudeFeature(back, "Backing board", ctx.id("backing-sketch"), { depth: t, operation: "new", flip: true }),
        moveFeature(ctx.id("backing-move"), "Backing board under it", back, { dz: neg(t) }),
      );
      partNames[back] = `${ctx.name} backing board`;
    }
    p.letters.forEach((l, i) => {
      const id = ctx.id(`letter-${i + 1}`);
      features.push(
        sketchFeature(ctx.id(`letter-${i + 1}-sketch`), `Letter ${i + 1} (${l.ch}) sketch`, TOP, loopsSketch(drawnLetter(l, kerf), ctx.scope)),
        // In its hole: its own New part.
        extrudeFeature(id, `Letter ${i + 1} (${l.ch})`, ctx.id(`letter-${i + 1}-sketch`), { depth: t, operation: "new", flip: true }),
      );
      partNames[id] = `${ctx.name} letter ${l.ch}`;
      // Letters in more than one piece (i, j, !…): the others are `<id>~2`….
      for (let k = 2; k <= l.outers.length; k++) partNames[`${id}~${k}`] = `${ctx.name} letter ${l.ch} (piece ${k})`;
    });
    return { features, partNames };
  },
  preview: (v) => {
    if (puzzleProblems(v).length) return [];
    const p = namePuzzle(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2]] }];
    for (const l of p.letters) {
      for (const c of holesOf(l, num(v, "play"))) out.push({ kind: "poly", closed: true, points: c });
      // The pieces below the board.
      for (const c of [...l.outers, ...l.counters]) out.push({ kind: "poly", closed: true, faint: true, points: c.map(([x, y]) => [x, y - p.h - 6] as P2) });
    }
    return out;
  },
};
