/**
 * Shortened (broken) views: long parts drawn with a stretch taken out of the
 * middle so they fit the sheet, like Onshape's broken views. The band taken
 * out is replaced by a small gap with break lines either side; dimensions
 * still measure the real part, as they're worked out before the view is
 * shortened. Everything here is in a view's own coordinates (model mm).
 */
import type { ViewProjection } from "../kernel/protocol";
import type { Drawing, Shortening } from "../model/types";

/** One band taken out of a view, along X (0) or Y (1), between two coordinates. */
export interface Cut {
  axis: 0 | 1;
  from: number;
  to: number;
}

/** Gap left where a band is taken out, on paper (mm). */
export const SHORT_GAP = 5;

/** The bands on one axis, in order, overlaps merged. */
export function cutsOn(cuts: readonly Cut[] | undefined, axis: 0 | 1): { from: number; to: number }[] {
  const list = (cuts ?? []).filter((c) => c.axis === axis && c.to > c.from).map((c) => ({ from: c.from, to: c.to }));
  list.sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to);
    else out.push({ ...c });
  }
  return out;
}

/** Where a coordinate ends up once the bands are taken out (each leaving a gap `g`); inside a band it's squeezed into the gap. */
export function squeeze(v: number, bands: { from: number; to: number }[], g: number): number {
  let shift = 0;
  for (const b of bands) {
    if (v >= b.to) shift += b.to - b.from - g;
    else if (v > b.from) return v - shift - (v - b.from) + ((v - b.from) / (b.to - b.from)) * g;
  }
  return v - shift;
}

/** The other way: where a point on the shortened view really is. */
export function unsqueeze(u: number, bands: { from: number; to: number }[], g: number): number {
  let shift = 0;
  for (const b of bands) {
    const start = b.from - shift;
    if (u <= start) return u + shift;
    if (u < start + g) return b.from + ((u - start) / g) * (b.to - b.from);
    shift += b.to - b.from - g;
  }
  return u + shift;
}

/** How much shorter the view is along an axis (before adding the gaps back). */
export function removed(bands: { from: number; to: number }[]): number {
  return bands.reduce((t, b) => t + (b.to - b.from), 0);
}

/** A polyline (x0, y0, x1, y1…) with the parts inside the bands taken out: the pieces left. */
export function clipOut(line: number[], axis: 0 | 1, bands: { from: number; to: number }[]): number[][] {
  if (!bands.length) return [line];
  const inside = (x: number, y: number) => {
    const v = axis === 0 ? x : y;
    return bands.some((b) => v > b.from && v < b.to);
  };
  const out: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < line.length; i += 2) {
    const x = line[i];
    const y = line[i + 1];
    if (i > 0) {
      // Split the segment from the last point where it crosses a band's edge.
      const px = line[i - 2];
      const py = line[i - 1];
      const pv = axis === 0 ? px : py;
      const v = axis === 0 ? x : y;
      const edges = bands.flatMap((b) => [b.from, b.to]).filter((e) => (e - pv) * (e - v) < 0);
      edges.sort((a, b) => (v > pv ? a - b : b - a));
      for (const e of edges) {
        const t = (e - pv) / (v - pv);
        const ex = px + (x - px) * t;
        const ey = py + (y - py) * t;
        if (cur.length) cur.push(ex, ey);
        flush();
        // Leaving a band: start a new piece at its edge.
        const after = axis === 0 ? ex + (x - px) * 1e-9 : ey + (y - py) * 1e-9;
        if (!bands.some((b) => after > b.from && after < b.to)) cur.push(ex, ey);
      }
    }
    if (!inside(x, y)) cur.push(x, y);
    else flush();
  }
  flush();
  return out;
}

/** A view's bands, as cuts in its own coordinates, from fractions of its full size. */
export function cutsFromFractions(p: Pick<ViewProjection, "bounds">, list: { axis: "x" | "y"; from: number; to: number }[]): Cut[] {
  if (!p.bounds) return [];
  const [x0, y0, x1, y1] = p.bounds;
  return list.map((c) => {
    const axis = c.axis === "x" ? 0 : 1;
    const lo = axis === 0 ? x0 : y0;
    const span = axis === 0 ? x1 - x0 : y1 - y0;
    return { axis, from: lo + Math.min(c.from, c.to) * span, to: lo + Math.max(c.from, c.to) * span };
  });
}

/** Add (or replace) a shortening on a drawing. */
export function putShortening(d: Drawing, s: Shortening): Drawing {
  const list = d.shortened ?? [];
  return { ...d, shortened: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s] };
}

export function removeShortening(d: Drawing, id: string): Drawing {
  const list = (d.shortened ?? []).filter((x) => x.id !== id);
  const { shortened: _old, ...rest } = d;
  return list.length ? { ...rest, shortened: list } : rest;
}

/** The views' projections with each view's shortenings attached (the same objects where a view has none). */
export function withShortenings<T extends Partial<Record<string, ViewProjection>>>(projections: T, d: Pick<Drawing, "shortened">): T {
  if (!d.shortened?.length) return projections;
  const out: Partial<Record<string, ViewProjection>> = { ...projections };
  for (const [key, p] of Object.entries(projections)) {
    const list = d.shortened.filter((s) => s.host === key);
    if (p && list.length) out[key] = { ...p, shorten: cutsFromFractions(p, list) };
  }
  return out as T;
}
