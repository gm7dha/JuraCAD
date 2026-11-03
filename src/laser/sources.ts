/**
 * What can be sent to the laser, turned into pieces (laser.ts): a sketch (its
 * closed shapes, lines that don't close and text), or outlines the engine read
 * from parts (a flat face, a part's biggest flat face, a sheet metal part's
 * flat pattern with its bend lines).
 */
import type { TopoPick } from "../geometry/topoRef";
import { findChains, type Pt, type Segment } from "../sketch/regions";
import { textContours, textsOf } from "../sketch/sketchText";
import type { SketchData } from "../sketch/types";
import { chainEdges, sortLoops, type LaserLayer, type LaserPath, type LaserPiece } from "./laser";

/** What to ask the engine for. */
export type LaserSource =
  /** One clicked face (it must be flat). */
  | { kind: "face"; pick: TopoPick }
  /** A whole part: its biggest flat face (a flat panel gives its outline). */
  | { kind: "part"; partId: string }
  /** A sheet metal part laid out flat. */
  | { kind: "flat"; partId: string };

/** The engine's answer for one source: outline pieces in the face's own flat coordinates (mm), or a plain-English problem. */
export type LaserOutline =
  | {
      ok: true;
      /** The part's name (and which face, for a clicked one). */
      name: string;
      partId: string;
      /** Each wire's pieces (in any order and direction); for a flat pattern, every edge of the flat sheet together. */
      wires: Segment[][];
      /** Flat patterns: the bend lines. */
      bends?: [Pt, Pt][];
    }
  | { ok: false; partId?: string; error: string };

export interface SketchLaserOptions {
  /** Closed shapes: cut them out, or engrave them as filled areas. */
  shapes?: "cut" | "engrave";
  /** Text: cut the letters out, or engrave them. */
  text?: "cut" | "engrave";
  /** Lines that don't close: cut along them, or score them. */
  open?: "cut" | "score";
}

/** A sketch's solid curves and text as a piece to cut (construction lines are left out). */
export function sketchPiece(name: string, sketch: SketchData, opts: SketchLaserOptions = {}): LaserPiece {
  const { chains } = findChains({ ...sketch, texts: [] }, { branching: true });
  const shapeLoops = chains.filter((c) => c.closed).map((c) => c.segments);
  const textLoops = textsOf(sketch)
    .filter((t) => !t.construction)
    .flatMap((t) => textContours(sketch, t))
    .filter((c) => c.length >= 3)
    .map((c): Segment[] => c.map((p, i) => ({ kind: "line", from: p, to: c[(i + 1) % c.length] })));
  const engraveShapes = opts.shapes === "engrave";
  const engraveText = opts.text === "engrave";
  // What's cut is sorted together (a letter cut through a plate is inside the plate's outline).
  const cut = [...(engraveShapes ? [] : shapeLoops), ...(engraveText ? [] : textLoops)];
  const engraved = [...(engraveShapes ? shapeLoops : []), ...(engraveText ? textLoops : [])];
  const openLayer: LaserLayer = opts.open === "score" ? "score" : "inner";
  const paths: LaserPath[] = [
    ...sortLoops(cut),
    ...engraved.map((segments): LaserPath => ({ layer: "engrave", segments, closed: true })),
    ...chains.filter((c) => !c.closed).map((c): LaserPath => ({ layer: openLayer, segments: c.segments, closed: false })),
  ];
  return { name, paths };
}

/** A part face or flat pattern read by the engine, as a piece: its loops sorted, bend lines as scores (when `bends`). */
export function outlinePiece(outline: Extract<LaserOutline, { ok: true }>, opts: { bends?: boolean } = {}): LaserPiece {
  const loops: Segment[][] = [];
  const open: Segment[][] = [];
  for (const w of outline.wires) {
    const c = chainEdges(w);
    loops.push(...c.loops);
    open.push(...c.open);
  }
  const paths: LaserPath[] = [...sortLoops(loops), ...open.map((segments): LaserPath => ({ layer: "inner", segments, closed: false }))];
  if (opts.bends !== false)
    for (const [a, b] of outline.bends ?? []) paths.push({ layer: "score", segments: [{ kind: "line", from: a, to: b }], closed: false });
  return { name: outline.name, paths };
}
