/**
 * What can be sent to the laser, turned into pieces (laser.ts): a sketch (its
 * closed shapes, lines that don't close and text), or outlines the engine read
 * from parts (a flat face, a part's biggest flat face, a sheet metal part's
 * flat pattern with its bend lines).
 */
import type { TopoPick } from "../geometry/topoRef";
import type { Feature } from "../model/types";
import { sketchAreas } from "../sketch/areas";
import { planeFrame, type SketchPlane } from "../sketch/planes";
import { findChains, type Chain, type Pt, type Segment } from "../sketch/regions";
import { textContours, textsOf } from "../sketch/sketchText";
import type { SketchData } from "../sketch/types";
import { chainEdges, segmentPoints, sortLoops, type LaserLayer, type LaserPath, type LaserPiece } from "./laser";

/** What to ask the engine for. */
export type LaserSource =
  /** One clicked face (it must be flat). */
  | { kind: "face"; pick: TopoPick }
  /**
   * A whole part: its biggest flat face (a flat panel gives its outline). When two are as big, the one facing
   * `toward` (the sketch it was made from: see partFacing), else +Z, −Y (Front), +X (Right).
   */
  | { kind: "part"; partId: string; toward?: [number, number, number] }
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

/**
 * Where three or more curves meet (a house: a rectangle with a roof on its top
 * corners; a rectangle with a diagonal), say which curves are the outline. Each
 * group of curves joined at a junction is judged by itself — the areas its own
 * curves make, so a house-shaped hole in a plate is still a closed shape: a
 * curve with open space (no area) on one side runs round the outside of the
 * shape, one with area on both sides is a line inside it, and one with open
 * space on both sides is a lone line. Outline curves are joined into closed
 * loops (cut), the others are kept as lines (cut or scored).
 */
function junctionCurves(sketch: SketchData, runs: Chain[]): { loops: Segment[][]; lines: Segment[][] } {
  const loops: Segment[][] = [];
  const lines: Segment[][] = [];
  const groups = new Map<number, Chain[]>();
  for (const r of runs) groups.set(r.group ?? 0, [...(groups.get(r.group ?? 0) ?? []), r]);
  for (const group of groups.values()) {
    // The same curve drawn twice (two rectangles sharing a side) is judged and cut once.
    const curves = uniqueRuns(group.map((g) => g.segments));
    const ids = new Set(group.map((g) => g.curve));
    const map = sketchAreas({ ...sketch, curves: sketch.curves.filter((c) => ids.has(c.id)), texts: [], images: [] });
    const pts = curves.flat().flatMap((c) => segmentPoints(c, 0.05));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const size = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const eps = Math.max(1e-4, size * 1e-5);
    const outline: Segment[] = [];
    for (const run of curves) {
      // Look either side of the curve's middle.
      const along = run.flatMap((c, i) => segmentPoints(c, 0.01).slice(i ? 1 : 0));
      const at = Math.max(0, Math.min(along.length - 2, Math.floor(along.length / 2)));
      const p = along[at];
      const q = along[at + 1] ?? along[at];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const nrm: Pt = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
      const left = map.areaAt([mid[0] + nrm[0] * eps, mid[1] + nrm[1] * eps]) >= 0;
      const right = map.areaAt([mid[0] - nrm[0] * eps, mid[1] - nrm[1] * eps]) >= 0;
      if (left !== right) outline.push(...run);
      else lines.push(run);
    }
    const joined = chainEdges(outline);
    loops.push(...joined.loops);
    // An outline piece that didn't close (a gap in the drawing) is still cut along.
    lines.push(...joined.open);
  }
  return { loops, lines };
}

/** A curve run's ends and middle, either way round (to find the same line drawn twice). */
function runKey(run: Segment[]): string {
  const pts = run.flatMap((c, i) => segmentPoints(c, 0.01).slice(i ? 1 : 0));
  const r = (p: Pt) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const a = r(pts[0]);
  const b = r(pts[pts.length - 1]);
  // The point halfway along (by length), the same whichever way the run is walked.
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let walked = 0;
  let mid = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (walked + d >= total / 2) {
      const t = d ? (total / 2 - walked) / d : 0;
      mid = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      break;
    }
    walked += d;
  }
  return `${[a, b].sort().join("|")}|${Math.round(mid[0] * 1e3)},${Math.round(mid[1] * 1e3)}`;
}

/** Runs with the same ends and middle (either way round) kept once. */
export function uniqueRuns(runs: Segment[][]): Segment[][] {
  const seen = new Set<string>();
  return runs.filter((r) => {
    if (!r.length) return false;
    const k = runKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A sketch's solid curves and text as a piece to cut (construction lines are left out). */
export function sketchPiece(name: string, sketch: SketchData, opts: SketchLaserOptions = {}): LaserPiece {
  const { chains } = findChains({ ...sketch, texts: [] }, { branching: true });
  const junction = junctionCurves(
    sketch,
    chains.filter((c) => c.branching),
  );
  const shapeLoops = [...chains.filter((c) => c.closed).map((c) => c.segments), ...junction.loops];
  const openRuns = uniqueRuns([...chains.filter((c) => !c.closed && !c.branching).map((c) => c.segments), ...junction.lines]);
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
    // (A "loop" that's only a line drawn there and back comes back open: it's a line like the others.)
    ...sortLoops(cut).map((p) => (p.closed ? p : { ...p, layer: openLayer })),
    ...engraved.map((segments): LaserPath => ({ layer: "engrave", segments, closed: true })),
    ...openRuns.map((segments): LaserPath => ({ layer: openLayer, segments, closed: false })),
  ];
  return { name, paths };
}

/**
 * Which way to look at a whole part when several flat faces are as big (a
 * plate's two sides): down onto the sketch it was made from, as drawn — the
 * normal of the sketch plane of the part's first feature — or null.
 */
export function partFacing(featureIds: string[], features: Feature[], planeOf: (sketch: Feature) => SketchPlane | null = (f) => f.sketch?.plane ?? null): [number, number, number] | null {
  for (const id of featureIds.slice(0, 1)) {
    const f = features.find((x) => x.id === id);
    const sk = f?.sketchRef ? features.find((x) => x.id === f.sketchRef) : f?.type === "sketch" ? f : undefined;
    const plane = sk ? planeOf(sk) : null;
    if (plane) {
      try {
        return planeFrame(plane).n;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The same outline asked for twice (a face and its whole part, or one face twice): keep the first… but a clicked face beats its whole part. */
export function uniqueSources(sources: LaserSource[]): LaserSource[] {
  const facesOn = new Set(sources.filter((s) => s.kind === "face").map((s) => (s as Extract<LaserSource, { kind: "face" }>).pick.partId));
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (s.kind !== "face" && facesOn.has(s.partId)) return false;
    const key = s.kind === "face" ? `face:${s.pick.partId}:${JSON.stringify(s.pick.ref)}` : `${s.kind}:${s.partId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
