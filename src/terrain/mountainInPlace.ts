/**
 * The Mountain puzzle printed put together (pure, mm), two ways:
 *
 * - "layers": each layer of the puzzle on a plate of its own, every piece where it sits in the finished puzzle. A layer's
 *   pieces only have side gaps between them (as the Island puzzle printed together), so each comes off the bed as a
 *   ready-made jigsaw; the layers are then stacked.
 * - "together": the whole mountain on one plate, layers on top of each other, with a thin layer of breakaway support
 *   filament (Bambu's "Support for PLA") between them so they don't fuse. Each layer is lifted so its underside lands on
 *   a print layer boundary at least one print layer above the layer below (`liftsFor`); the gap is filled by the
 *   breakaway layer — under each piece its outline less its pocket's mouth (the key below comes up through that hole),
 *   and in each pocket a cap from the key's top up to the pocket's ceiling, so the ceiling isn't printed onto air.
 *
 * "apart" (the usual) is `platesFor` in puzzle3mf.ts.
 */
import { keyLoop, Mesh, pocketAt, type Body, type KeySizes, type MountainPuzzle, type PuzzlePiece } from "./mountainPuzzle";
import { BED_MARGIN, type BedRect, type Plate } from "./puzzle3mf";

type P2 = [number, number];

/** How the pieces go onto the printer. */
export type PrintWay = "apart" | "layers" | "together";

/** Bambu Studio's first layer is always this thick (mm); later ones are the layer height chosen. */
export const FIRST_LAYER = 0.2;
/** Layer heights offered (mm), for lining the breakaway layer up with the print's own layers. */
export const LAYER_HEIGHTS = [0.12, 0.16, 0.2, 0.24, 0.28] as const;
/** How much smaller than the key's top or the pocket's ceiling a cap is all round (mm), so it never touches their sides. */
export const CAP_CLEAR = 0.05;

/** The first print layer boundary at or above z (mm). */
export function boundaryAtOrAbove(z: number, layer: number, first = FIRST_LAYER): number {
  if (z <= first + 1e-6) return first;
  return first + Math.ceil((z - first) / layer - 1e-6) * layer;
}

function boxOf(pieces: PuzzlePiece[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pieces)
    for (const [x, y] of p.outline) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  return [x0, y0, x1, y1];
}

/** The move that centres the whole puzzle on the bed (where Bambu Studio puts a file anyway), and whether it fits `room`. */
function centred(pieces: PuzzlePiece[], bed: [number, number, number], room: BedRect): { dx: number; dy: number; size: [number, number]; fits: boolean } {
  const [x0, y0, x1, y1] = boxOf(pieces);
  const [w, d] = [x1 - x0, y1 - y0];
  const e = 1e-6;
  const fits = (bed[0] - w) / 2 >= room[0] + BED_MARGIN - e && (bed[0] + w) / 2 <= room[2] - BED_MARGIN + e && (bed[1] - d) / 2 >= room[1] + BED_MARGIN - e && (bed[1] + d) / 2 <= room[3] - BED_MARGIN + e;
  return { dx: (bed[0] - w) / 2 - x0, dy: (bed[1] - d) / 2 - y0, size: [w, d], fits };
}

const order = (a: PuzzlePiece, b: PuzzlePiece) => a.layer - b.layer || a.row - b.row || a.col - b.col;

/**
 * One plate per layer, lowest first, each piece where it sits in the finished puzzle (the whole puzzle centred on the
 * bed, so every layer is in the same place), standing on the bed.
 */
export function layerPlates(pieces: PuzzlePiece[], bed: [number, number, number], room: BedRect = [0, 0, bed[0], bed[1]]): { plates: Plate[]; size: [number, number]; fits: boolean } {
  if (!pieces.length) return { plates: [], size: [0, 0], fits: true };
  const { dx, dy, size, fits } = centred(pieces, bed, room);
  const layers = [...new Set(pieces.map((p) => p.layer))].sort((a, b) => a - b);
  const plates = layers.map((L) => ({ pieces: pieces.filter((p) => p.layer === L).sort(order).map((p) => ({ piece: p, move: [dx, dy, -p.z0] as [number, number, number] })) }));
  return { plates, size, fits };
}

/** Where each layer's underside is in the finished puzzle (mm), by layer. */
function undersides(pieces: PuzzlePiece[]): number[] {
  const out: number[] = [];
  for (const p of pieces) out[p.layer] = out[p.layer] === undefined ? p.z0 : Math.min(out[p.layer], p.z0);
  return out;
}

/**
 * How far each layer is lifted (mm) so its underside lands on a print layer boundary at least one print layer above the
 * top of the layer below — the room the breakaway layer fills. Layer 0 stays on the bed.
 */
export function liftsFor(pieces: PuzzlePiece[], layer: number, first = FIRST_LAYER): number[] {
  const z = undersides(pieces);
  const lifts: number[] = [];
  for (let L = 0; L < z.length; L++) {
    if (L === 0 || z[L] === undefined) {
      lifts[L] = L === 0 ? 0 : lifts[L - 1];
      continue;
    }
    // The layer below's whole cubes end where this layer starts.
    const below = z[L] + lifts[L - 1];
    lifts[L] = boundaryAtOrAbove(below, layer, first) + layer - z[L];
  }
  return lifts;
}

const lifted = (b: Body, dz: number): Body => ({ part: b.part, vertices: b.vertices.map((v, i) => (i % 3 === 2 ? v + dz : v)), triangles: b.triangles });

/** The pocket's cap: the smaller of the key's top and the pocket's ceiling, `CAP_CLEAR` smaller all round. */
export function capLoop(pocket: NonNullable<PuzzlePiece["pocket"]>, g: KeySizes): P2[] {
  const keyTop = pocket.half - g.slope;
  const ceiling = pocket.half + g.fit - (g.slope * g.depth) / g.h;
  const half = Math.min(keyTop, ceiling) - CAP_CLEAR;
  const inset = pocket.half - half;
  return keyLoop(pocket.c, half, Math.max(0.5, 2 - inset), pocket.cut);
}

export interface Stacked {
  /** The puzzle's pieces, lifted, then one breakaway piece per layer above the first (layer = the layer it's under). */
  pieces: PuzzlePiece[];
  /** How far each layer was lifted (mm). */
  lifts: number[];
  /** How tall it all is (mm). */
  height: number;
  /** The puzzle's own piece for each lifted copy (the breakaway pieces have none). */
  originals: Map<PuzzlePiece, PuzzlePiece>;
}

/** The whole mountain stacked as it's printed together, with the breakaway layers between. */
export function stackWithBreakaway(puzzle: MountainPuzzle, layer: number, first = FIRST_LAYER): Stacked {
  const lifts = liftsFor(puzzle.pieces, layer, first);
  const z = undersides(puzzle.pieces);
  const g = puzzle.keys;
  const originals = new Map<PuzzlePiece, PuzzlePiece>();
  const pieces: PuzzlePiece[] = puzzle.pieces.map((p) => {
    const dz = lifts[p.layer] ?? 0;
    const q = dz ? { ...p, z0: p.z0 + dz, bodies: p.bodies.map((b) => lifted(b, dz)) } : p;
    originals.set(q, p);
    return q;
  });
  for (let L = 1; L < z.length; L++) {
    const onIt = puzzle.pieces.filter((p) => p.layer === L);
    if (!onIt.length) continue;
    const lo = z[L] + lifts[L - 1];
    const hi = z[L] + lifts[L];
    const m = new Mesh();
    for (const p of onIt) {
      const mouth = p.pocket ? [pocketAt(p.pocket, g, 0)] : [];
      m.wall(p.outline, lo, hi);
      m.face(p.outline, mouth, lo, false);
      m.face(p.outline, mouth, hi, true);
      if (p.pocket) {
        m.wall(mouth[0], lo, hi, false);
        // From the key's top (on the layer below) up to the pocket's ceiling (in this layer, lifted).
        const cap = capLoop(p.pocket, g);
        const [c0, c1] = [lo + g.h, hi + g.depth];
        m.wall(cap, c0, c1);
        m.face(cap, [], c0, false);
        m.face(cap, [], c1, true);
      }
    }
    const [x0, y0, x1, y1] = boxOf(onIt);
    pieces.push({
      name: `Breakaway layer ${L}`,
      col: -1,
      row: -1,
      layer: L,
      top: false,
      z0: lo,
      height: hi + g.depth - lo,
      outline: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      key: null,
      pocket: null,
      bodies: [m.body("breakaway")],
    });
  }
  let height = 0;
  for (const p of pieces) height = Math.max(height, p.z0 + p.height);
  return { pieces, lifts, height, originals };
}

/** The stacked puzzle on one plate, centred on the bed, at the heights it's printed at. */
export function togetherPlate(stacked: Stacked, bed: [number, number, number], room: BedRect = [0, 0, bed[0], bed[1]]): { plates: Plate[]; size: [number, number]; fits: boolean } {
  const { dx, dy, size, fits } = centred(stacked.pieces, bed, room);
  return { plates: [{ pieces: [...stacked.pieces].sort(order).map((p) => ({ piece: p, move: [dx, dy, 0] as [number, number, number] })) }], size, fits };
}

/**
 * About how many filament changes a stacked print needs: at each joint between layers, the print layers where the
 * breakaway filament and the puzzle's own share a layer (the caps beside the pieces' bottoms), twice each (there and back).
 */
export function breakawaySwaps(stacked: Stacked, layer: number, keys: KeySizes): number {
  const joints = stacked.pieces.filter((p) => p.bodies.some((b) => b.part === "breakaway")).length;
  // The cap reaches the pocket's depth above the breakaway layer's top; the layer itself is breakaway alone.
  const shared = Math.ceil(keys.depth / layer) + 1;
  return joints * shared * 2;
}

/**
 * The stacked plate with the puzzle's own pieces (not their lifted copies), each moved up by its layer's lift instead —
 * so pieces coloured in bands (worked out on the puzzle's own pieces) keep their parts. The breakaway pieces stay.
 */
export function unliftedPlate(plate: Plate, stacked: Stacked): Plate {
  return {
    pieces: plate.pieces.map(({ piece, move }) => {
      const own = stacked.originals.get(piece);
      if (!own || own === piece) return { piece, move };
      return { piece: own, move: [move[0], move[1], move[2] + (piece.z0 - own.z0)] as [number, number, number] };
    }),
  };
}

/** The breakaway pieces as colour-band parts of their own filament (heights from their own undersides, as band parts). */
export function breakawayParts(stacked: Stacked, filament: number): Map<PuzzlePiece, { filament: number; vertices: number[]; triangles: number[]; low: number; high: number }[]> {
  const out = new Map<PuzzlePiece, { filament: number; vertices: number[]; triangles: number[]; low: number; high: number }[]>();
  for (const p of stacked.pieces)
    if (!stacked.originals.has(p)) out.set(p, p.bodies.map((b) => ({ filament, vertices: b.vertices, triangles: b.triangles, low: 0, high: p.height })));
  return out;
}

/**
 * The filament the breakaway layers use when none is chosen: the next after every filament the puzzle uses (plain
 * puzzles keep the usual 3, after rock and snow).
 */
export function freeBreakawaySlot(used: readonly number[], plain: boolean): number {
  if (plain && !used.includes(3)) return 3;
  return (used.length ? Math.max(...used) : 0) + 1;
}

/**
 * Roughly how often a stacked print switches between its two nozzles when the breakaway filament is on the second one:
 * layer by layer (heights as printed, from the bed), the nozzle it ended on is used first if it's needed there.
 * `parts`: every part on the plate, heights from the bed.
 */
export function nozzleSwitches(parts: { filament: number; low: number; high: number }[], layer: number, second: number): number {
  let top = 0;
  for (const p of parts) top = Math.max(top, p.high);
  const n = Math.ceil(top / layer - 1e-6);
  const main = new Array<boolean>(n).fill(false);
  const aux = new Array<boolean>(n).fill(false);
  for (const p of parts) {
    const a = Math.max(0, Math.floor(p.low / layer + 1e-6));
    const b = Math.min(n, Math.ceil(p.high / layer - 1e-6));
    for (let l = a; l < b; l++) (p.filament === second ? aux : main)[l] = true;
  }
  let last = 0;
  let switches = 0;
  for (let l = 0; l < n; l++) {
    const want = [main[l] ? 1 : 0, aux[l] ? 2 : 0].filter(Boolean);
    if (!want.length) continue;
    if (want.length === 2) {
      switches += 1;
      last = last === 2 ? 1 : 2;
    } else {
      if (last && want[0] !== last) switches += 1;
      last = want[0];
    }
  }
  return switches;
}

/**
 * Every part of a stacked plain puzzle (rock, snow, breakaway) as the filament it's printed in and its heights from the
 * bed, for counting changes (`nozzleSwitches`, colour.ts's `filamentSwaps`).
 */
export function stackedPartRanges(stacked: Stacked, filaments: Readonly<Record<"rock" | "snow" | "breakaway", number>>): { filament: number; low: number; high: number }[] {
  const out: { filament: number; low: number; high: number }[] = [];
  for (const p of stacked.pieces)
    for (const b of p.bodies) {
      let [lo, hi] = [Infinity, -Infinity];
      for (let i = 2; i < b.vertices.length; i += 3) [lo, hi] = [Math.min(lo, b.vertices[i]), Math.max(hi, b.vertices[i])];
      if (hi > lo) out.push({ filament: filaments[b.part], low: lo, high: hi });
    }
  return out;
}
