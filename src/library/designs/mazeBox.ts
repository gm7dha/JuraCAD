/**
 * Cylinder maze gift box (3D printing, Puzzles). A round box with a maze cut into its outside, and a lid — a sleeve —
 * with two small nubs inside. To open it you twist and slide the lid so the nubs follow the maze from where the lid
 * sits closed to the way out at the top; to close it, back again. A new maze for every pattern number.
 *
 * - The maze is a perfect maze (exactly one way between any two places, so there's always one way out) on a grid of
 *   `cols` × `rows` cells round half the box, made by a seeded random walk (`makeMaze`); the other half is the same, so
 *   the two nubs, opposite each other, follow it together and the lid can't tip.
 * - The closed place is a cell on the bottom row; the way out is the top-row cell furthest from it along the maze.
 * - Grooves are `GROOVE_DEPTH` deep and `groove` wide (the nub, its chamfer and play); ribs between are `RIB` wide.
 * - The box stands on the bed with its flange; the lid prints upside down beside it (its top on the bed), its nubs
 *   chamfered at 45° on their bed side so they print without support.
 * - Every groove is a part of a turn (a Revolve, centred on its own sketch) so it follows the box's curve exactly.
 * No variables: the maze is worked out from the sizes, so "Edit design sizes" makes it again.
 */
import { seeded } from "../puzzle";
import { fixedPlane } from "../printKit";
import { lit, type Ex } from "../ex";
import { outlineSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num } from "./common";

/** How deep the maze is cut into the box (mm). */
export const GROOVE_DEPTH = 1.6;
/** Plastic between neighbouring grooves (mm). */
export const RIB = 2;
/** The box's wall inside the grooves, its floor, the lid's wall and top (mm). */
export const BOX_WALL = 1.6;
export const FLOOR = 2;
export const LID_WALL = 2;
export const LID_TOP = 2;
/** The flange round the box's foot that the closed lid rests on (mm high). */
export const FLANGE = 4;
/** How much further the cuts up the box reach than those along it, so no two cuts share a face (mm). */
const NUDGE = 0.05;
/** Room above the box's rim inside the closed lid (mm). */
export const TOP_GAP = 0.5;

/** Track sizes: the nub (across and along) for each difficulty, mm. Smaller = more cells = a longer maze. */
export const NUBS: Record<string, { label: string; nub: number }> = {
  easy: { label: "Easy (big track)", nub: 3.2 },
  medium: { label: "Medium", nub: 2.6 },
  hard: { label: "Hard (fine track)", nub: 2.2 },
};

export interface MazeSizes {
  /** Inside of the box (mm). */
  inside: number;
  /** The maze's surface radius, the flange's radius, the lid's inside radius (mm). */
  core: number;
  flange: number;
  lidInside: number;
  fit: number;
  nub: number;
  /** Groove width: the nub, the part of its chamfer that reaches into the groove, and play. */
  groove: number;
  pitch: number;
  /** The box's height (flange + maze), the lid's height (mm). */
  boxHeight: number;
  lidHeight: number;
  /** Where the closed lid's nubs are: this far above the lid's open edge (mm). */
  nubFromEdge: number;
  /** Cells round half the box and up it. */
  cols: number;
  rows: number;
  /** Bottom row's middle (mm up from the bed, box standing). */
  row0: number;
}

export function mazeSizes(v: DesignValues): MazeSizes {
  const inside = num(v, "diameter") / 2;
  const fit = num(v, "fit");
  const nub = (NUBS[String(v.difficulty)] ?? NUBS.medium).nub;
  const core = inside + BOX_WALL + GROOVE_DEPTH;
  const lidInside = core + fit;
  const flange = lidInside + LID_WALL;
  // The nub's chamfer starts at the lid's wall, so at the box's surface it's GROOVE_DEPTH − 2·fit taller than its tip.
  const groove = nub + (GROOVE_DEPTH - 2 * fit) + 0.6;
  const pitch = groove + RIB;
  const boxHeight = FLOOR + num(v, "height");
  const nubFromEdge = groove / 2 + 1;
  const row0 = FLANGE + nubFromEdge;
  const rows = Math.floor((boxHeight - row0 - groove / 2 - RIB) / pitch) + 1;
  const cols = Math.floor((Math.PI * core) / pitch);
  const lidHeight = LID_TOP + boxHeight - FLANGE + TOP_GAP;
  return { inside, core, flange, lidInside, fit, nub, groove, pitch, boxHeight, lidHeight, nubFromEdge, cols, rows, row0 };
}

/** A maze: for each cell (col + row·cols), whether its way right (to col + 1, wrapping round) and up are open. */
export interface Maze {
  cols: number;
  rows: number;
  right: boolean[];
  up: boolean[];
  /** The closed place (bottom row) and the way out (top row), as columns. */
  home: number;
  exit: number;
  /** Cells along the way from home to the way out, home first. */
  path: number[];
}

const cell = (m: { cols: number }, c: number, r: number) => r * m.cols + ((c % m.cols) + m.cols) % m.cols;

/** Neighbours of a cell through open ways. */
export function openNeighbours(m: Maze, i: number): number[] {
  const c = i % m.cols;
  const r = Math.floor(i / m.cols);
  const out: number[] = [];
  if (m.right[i]) out.push(cell(m, c + 1, r));
  if (m.right[cell(m, c - 1, r)]) out.push(cell(m, c - 1, r));
  if (r + 1 < m.rows && m.up[i]) out.push(cell(m, c, r + 1));
  if (r > 0 && m.up[cell(m, c, r - 1)]) out.push(cell(m, c, r - 1));
  return out;
}

/** A perfect maze on a `cols` × `rows` band that wraps round (seeded random walk with backtracking). */
export function makeMaze(cols: number, rows: number, seed: number): Maze {
  const rnd = seeded(seed * 7919 + 13);
  const n = cols * rows;
  const right = new Array<boolean>(n).fill(false);
  const up = new Array<boolean>(n).fill(false);
  const seen = new Array<boolean>(n).fill(false);
  const stack = [Math.floor(rnd() * n)];
  seen[stack[0]] = true;
  while (stack.length) {
    const i = stack[stack.length - 1];
    const c = i % cols;
    const r = Math.floor(i / cols);
    const options: [number, () => void][] = [];
    const R = cell({ cols }, c + 1, r);
    const L = cell({ cols }, c - 1, r);
    if (cols > 1 && !seen[R]) options.push([R, () => (right[i] = true)]);
    if (cols > 2 && !seen[L]) options.push([L, () => (right[L] = true)]);
    if (r + 1 < rows && !seen[i + cols]) options.push([i + cols, () => (up[i] = true)]);
    if (r > 0 && !seen[i - cols]) options.push([i - cols, () => (up[i - cols] = true)]);
    if (!options.length) {
      stack.pop();
      continue;
    }
    const [next, open] = options[Math.floor(rnd() * options.length)];
    open();
    seen[next] = true;
    stack.push(next);
  }
  // Closed at a bottom-row cell; out at the top-row cell furthest from it along the maze.
  const m: Maze = { cols, rows, right, up, home: Math.floor(rnd() * cols), exit: 0, path: [] };
  const from = new Int32Array(n).fill(-2);
  from[m.home] = -1;
  const queue = [m.home];
  let last = m.home;
  for (let k = 0; k < queue.length; k++) {
    for (const j of openNeighbours(m, queue[k]))
      if (from[j] === -2) {
        from[j] = queue[k];
        queue.push(j);
      }
  }
  let best = -1;
  for (let c = 0; c < cols; c++) {
    const i = (rows - 1) * cols + c;
    let len = 0;
    for (let j = i; j !== -1; j = from[j]) len++;
    if (len > best) [best, last] = [len, i];
  }
  m.exit = last % cols;
  for (let j = last; j !== -1; j = from[j]) m.path.unshift(j);
  return m;
}

/** A Revolve of a sketch, a part of a turn centred on the sketch (degrees). */
function arcCut(id: string, name: string, sketchRef: string, degrees: number, operation: "add" | "remove"): Feature {
  return {
    id,
    name,
    type: "revolve",
    operation,
    suppressed: false,
    params: { angle: String(Math.round(degrees * 1e4) / 1e4) },
    sketchRef,
    revolve: { axis: "vertical", flip: false, symmetric: true },
  };
}

const rad = Math.PI / 180;
/** A sketch plane through a vertical axis at (cx, 0), turned `deg` round it: x out from the axis, y up. */
const turnedPlane = (label: string, deg: number, cx = 0) => fixedPlane(label, [cx, 0, 0], [Math.cos(deg * rad), Math.sin(deg * rad), 0], [0, 0, 1]);
const outline = (pts: [number, number][], ctx: MakeContext) => outlineSketch(pts.map(([x, y]) => [lit(x), lit(y)] as [Ex, Ex]), ctx.scope);

export const mazeBox: LibraryDesign = {
  id: "maze-box",
  name: "Cylinder maze gift box",
  description: "A round box with a maze round its outside and a lid that only comes off when you twist it through the maze — a new maze for every pattern number. A gift box with a puzzle to open it.",
  category: "print",
  group: "Puzzles",
  prefix: "maze",
  icon: '<rect x="12" y="8" width="24" height="34" rx="3"/><path d="M12 15h8v6h8v-6M36 21h-4v7h-12v6h8v8M20 28v-7"/>',
  inputs: [
    { key: "diameter", label: "Inside diameter", kind: "length", default: 40, min: 15, max: 120, help: "The space inside the box." },
    { key: "height", label: "Inside height", kind: "length", default: 50, min: 25, max: 160 },
    { key: "difficulty", label: "Maze", kind: "choice", default: "medium", choices: Object.entries(NUBS).map(([value, n]) => ({ value, label: n.label })) },
    { key: "pattern", label: "Pattern", kind: "count", default: 1, min: 1, max: 99999, help: "Each number gives a different maze." },
    { key: "fit", label: "Fit gap", kind: "length", default: 0.3, min: 0.1, max: 0.6, help: "Room between the lid and the box, each side. 0.3 mm suits most printers." },
  ],
  problems: (v) => {
    const s = mazeSizes(v);
    const out: string[] = [];
    if (s.rows < 3) out.push(`The box is too short for a maze: make it at least ${mm(Math.ceil(s.row0 + 2 * s.pitch + s.groove / 2 + RIB - FLOOR))} tall inside.`);
    if (s.cols < 3) out.push("The box is too narrow for a maze: make it wider.");
    return out;
  },
  make: (ctx) => {
    const v = ctx.values;
    const s = mazeSizes(v);
    const maze = makeMaze(s.cols, s.rows, num(v, "pattern"));
    const features: Feature[] = [];
    const step = 180 / s.cols;
    const colAngle = (c: number) => (c + 0.5) * step;
    const z = (r: number) => s.row0 + r * s.pitch;
    const width = s.groove / s.core / rad;
    const [r0, r1] = [s.core - GROOVE_DEPTH, s.core + 1];

    // The box: flange, maze core and the space inside, in one turn.
    const boxSketch = ctx.id("box-sketch");
    const box = ctx.id("box");
    features.push(
      sketchFeature(
        boxSketch,
        "Box profile",
        { kind: "default", name: "Front" },
        outline(
          [
            [0, 0],
            [s.flange, 0],
            [s.flange, FLANGE],
            [s.core, FLANGE],
            [s.core, s.boxHeight],
            [s.inside, s.boxHeight],
            [s.inside, FLOOR],
            [0, FLOOR],
          ],
          ctx,
        ),
      ),
      { ...arcCut(box, "Box", boxSketch, 360, "remove"), operation: "new", revolve: { axis: "vertical", flip: false }, apart: true },
    );

    // The maze, on both halves: each column's way up as one cut, each run along a row as one cut.
    for (const half of [0, 180]) {
      for (let c = 0; c < s.cols; c++) {
        const spans: [number, number][] = [];
        for (let r = 0; r < s.rows; r++) {
          const up = r + 1 < s.rows ? maze.up[r * s.cols + c] : c === maze.exit;
          if (!up) continue;
          const top = r + 1 < s.rows ? z(r + 1) + s.groove / 2 : s.boxHeight + 1;
          // A hair longer and deeper than the runs along the rows, so no two cuts share a face (OpenCascade's booleans
          // are unreliable on faces that exactly meet).
          const last = spans[spans.length - 1];
          if (last && Math.abs(last[1] - (z(r) + s.groove / 2 + NUDGE)) < 1e-9) last[1] = top + NUDGE;
          else spans.push([z(r) - s.groove / 2 - NUDGE, top + NUDGE]);
        }
        spans.forEach(([a, b], k) => {
          const sk = ctx.id(`up-${half}-${c}-${k}-sketch`);
          features.push(
            sketchFeature(sk, `Maze up ${c + 1}${half ? "b" : ""}`, turnedPlane(`Maze ${c + 1}`, half + colAngle(c)), outline([[r0 - NUDGE, a], [r1, a], [r1, b], [r0 - NUDGE, b]], ctx)),
            arcCut(ctx.id(`up-${half}-${c}-${k}`), `Maze way up ${c + 1}${half ? "b" : ""}`, sk, width, "remove"),
          );
        });
      }
      for (let r = 0; r < s.rows; r++) {
        // Runs of open ways along the row, starting just after a closed one (there's always one: the maze has no loops).
        const startAt = [...Array(s.cols).keys()].find((c) => !maze.right[r * s.cols + ((c - 1 + s.cols) % s.cols)]) ?? 0;
        let c = startAt;
        for (let k = 0; k < s.cols; ) {
          let len = 0;
          while (k + len < s.cols && maze.right[r * s.cols + ((c + len) % s.cols)]) len++;
          if (len) {
            const mid = colAngle(c) + (len * step) / 2;
            const sk = ctx.id(`along-${half}-${r}-${c}-sketch`);
            features.push(
              sketchFeature(sk, `Maze along ${r + 1}${half ? "b" : ""}`, turnedPlane(`Maze row ${r + 1}`, half + mid), outline([[r0, z(r) - s.groove / 2], [r1, z(r) - s.groove / 2], [r1, z(r) + s.groove / 2], [r0, z(r) + s.groove / 2]], ctx)),
              arcCut(ctx.id(`along-${half}-${r}-${c}`), `Maze way along ${r + 1}${half ? "b" : ""}`, sk, len * step + width, "remove"),
            );
          }
          k += len + 1;
          c = (c + len + 1) % s.cols;
        }
      }
    }

    // The lid, upside down beside the box: a sleeve with its top on the bed.
    const cx = s.flange * 2 + 10;
    const lidSketch = ctx.id("lid-sketch");
    const lid = ctx.id("lid");
    features.push(
      sketchFeature(lidSketch, "Lid profile", turnedPlane("Lid", 0, cx), outline([[0, 0], [s.flange, 0], [s.flange, s.lidHeight], [s.lidInside, s.lidHeight], [s.lidInside, LID_TOP], [0, LID_TOP]], ctx)),
      { ...arcCut(lid, "Lid", lidSketch, 360, "remove"), operation: "new", revolve: { axis: "vertical", flip: false }, apart: true },
    );
    // Two nubs inside its open edge, opposite each other; chamfered at 45° on the side towards the bed.
    const tip = s.core - GROOVE_DEPTH + 2 * s.fit;
    // Its chamfer reaches (core − tip) further towards the lid's top at the box's surface: centre the whole footprint
    // on the groove (in the upside-down lid, towards the lid's top is down).
    const mid = s.lidHeight - s.nubFromEdge + (s.core - tip) / 2;
    const [lo, hi] = [mid - s.nub / 2, mid + s.nub / 2];
    for (const a of [0, 180]) {
      const sk = ctx.id(`nub-${a}-sketch`);
      features.push(
        sketchFeature(sk, `Nub ${a ? 2 : 1}`, turnedPlane(`Nub ${a ? 2 : 1}`, a, cx), outline([[s.lidInside + 0.4, lo - (s.lidInside + 0.4 - tip)], [s.lidInside + 0.4, hi], [tip, hi], [tip, lo]], ctx)),
        arcCut(ctx.id(`nub-${a}`), `Nub ${a ? 2 : 1}`, sk, s.nub / s.lidInside / rad, "add"),
      );
    }
    return { features, partNames: { [box]: `${ctx.name} box`, [lid]: `${ctx.name} lid` } };
  },
  preview: (v) => {
    const s = mazeSizes(v);
    if (s.rows < 1 || s.cols < 1) return [];
    const maze = makeMaze(s.cols, s.rows, num(v, "pattern"));
    // The maze unrolled: half the box's way round, bottom row at the bottom.
    const w = (Math.PI * s.core) / s.cols;
    const at = (i: number): [number, number] => [((i % s.cols) + 0.5) * w, s.row0 + Math.floor(i / s.cols) * s.pitch];
    const shapes: PreviewShape[] = [{ kind: "poly", points: [[0, 0], [Math.PI * s.core, 0], [Math.PI * s.core, s.boxHeight], [0, s.boxHeight]], closed: true, faint: true }];
    for (let i = 0; i < s.cols * s.rows; i++) {
      const [x, y] = at(i);
      if (maze.right[i]) shapes.push({ kind: "poly", points: (i % s.cols) === s.cols - 1 ? [[x, y], [x + w / 2, y]] : [[x, y], at(i + 1)] });
      if (maze.right[i] && i % s.cols === s.cols - 1) shapes.push({ kind: "poly", points: [[0, y], [w / 2, y]] });
      if (Math.floor(i / s.cols) + 1 < s.rows && maze.up[i]) shapes.push({ kind: "poly", points: [[x, y], at(i + s.cols)] });
    }
    const [ex, ey] = at((s.rows - 1) * s.cols + maze.exit);
    shapes.push({ kind: "poly", points: [[ex, ey], [ex, s.boxHeight]] });
    shapes.push({ kind: "circle", c: at(maze.home), r: s.nub / 2 });
    shapes.push({ kind: "text", at: [(Math.PI * s.core) / 2, -6], text: "the maze unrolled (half way round)" });
    return shapes;
  },
  summary: (v) => {
    const s = mazeSizes(v);
    if (s.rows < 3 || s.cols < 3) return null;
    const maze = makeMaze(s.cols, s.rows, num(v, "pattern"));
    return `A ${s.cols * 2} × ${s.rows} maze; the way out takes ${maze.path.length - 1} moves. Box ${mm(s.flange * 2)} across and ${mm(s.boxHeight)} tall; the lid prints upside down beside it.`;
  },
};
