/**
 * Baseline, chain and ordinate dimensions: click a datum point, then the next
 * point, the next, and so on.
 *  - Baseline measures each from the datum, in rows stacked outwards.
 *  - Chain measures each from the point before, end to end in one row.
 *  - Ordinate just writes each point's distance from the datum (0 at the
 *    datum) at the end of a short leader, all lined up.
 * The run goes across or up-and-down, whichever the first dimension does.
 */
import type { ViewProjection } from "../kernel/protocol";
import type { Dimension } from "../model/types";
import { rowOffset, rowSide } from "./autoDimension";
import { dimPoint } from "./dimensions";

type P2 = [number, number];
export type LinearKind = "baseline" | "chain" | "ordinate";

export interface LinearRun {
  view: string;
  kind: LinearKind;
  datum: P2;
  /** The last point dimensioned to (chain dimensions start from here). */
  last: P2;
  /** Across ("h") or up-and-down ("v"), set by the first dimension. */
  dir: "h" | "v" | null;
  /** How many dimensions the run has made so far. */
  count: number;
}

export function startRun(view: string, kind: LinearKind, datum: P2): LinearRun {
  return { view, kind, datum, last: datum, dir: null, count: 0 };
}

const same = (q: P2, r: P2) => Math.abs(q[0] - r[0]) < 1e-6 && Math.abs(q[1] - r[1]) < 1e-6;

/**
 * The dimensions a click on `target` would add to the run: none if it's level
 * with where it'd measure from or already measured; two for an ordinate run's
 * first point (the datum's 0 as well).
 */
export function nextLinear(run: LinearRun, p: ViewProjection, target: P2, scale: number, existing: Dimension[]): Omit<Dimension, "id">[] {
  const from = run.kind === "chain" ? run.last : run.datum;
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const dir = run.dir ?? (Math.abs(dx) >= Math.abs(dy) ? "h" : "v");
  const i = dir === "h" ? 0 : 1;
  if (Math.abs(i === 0 ? dx : dy) < 1e-6) return [];
  const type = run.kind === "ordinate" ? "ordinate" : dir === "h" ? "horizontal" : "vertical";
  const mine = (d: Dimension) => d.view === run.view && d.type === type && (type !== "ordinate" || d.axis === dir);
  // Already measured from the same point to the same place along the run: nothing new.
  if (existing.some((d) => mine(d) && d.b && same(d.a.at, from) && Math.abs(d.b.at[i] - target[i]) < 1e-6)) return [];
  // Rows start outside any dimensions of this kind the view already had before this run.
  const madeHere = run.kind === "ordinate" && run.count > 0 ? run.count + 1 : run.count;
  const before = Math.max(0, existing.filter(mine).length - madeHere);
  const row = run.kind === "ordinate" ? (before > 0 ? 1 : 0) : before + (run.kind === "baseline" ? run.count : 0);
  const side = rowSide(run.view, dir);
  const dim = (a: P2, b: P2): Omit<Dimension, "id"> => ({
    view: run.view,
    type,
    a: dimPoint(a, p),
    b: dimPoint(b, p),
    // Ordinate leaders all end on one line, set by the datum and the whole view.
    offset: rowOffset(p, side, a, b, scale, row),
    ...(type === "ordinate" ? { axis: dir } : {}),
  });
  if (run.kind === "ordinate" && run.count === 0) return [dim(run.datum, run.datum), dim(run.datum, target)];
  return [dim(from, target)];
}

/** The run after the dimensions to `target` were added. */
export function advanceRun(run: LinearRun, target: P2, made: Omit<Dimension, "id">[]): LinearRun {
  const last = made[made.length - 1];
  const dir = last.type === "ordinate" ? (last.axis ?? "h") : last.type === "horizontal" ? "h" : "v";
  return { ...run, last: target, dir, count: run.count + 1 };
}
