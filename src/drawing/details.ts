/**
 * Detail views: a circle drawn on a view, shown again bigger elsewhere on the
 * sheet ("DETAIL B (2 : 1)"). The detail's lines are the host view's lines
 * clipped to the circle; they stay in model millimetres (so dimensions on a
 * detail measure true sizes) and the view is drawn `zoom` times bigger.
 */
import type { ViewProjection } from "../kernel/protocol";
import type { DetailView, Drawing, ViewKind } from "../model/types";
import { nextSectionLetter } from "./sections";
import type { Projections } from "./sheet";

type P2 = [number, number];

/** Views a detail circle can be drawn on. */
export const DETAIL_HOSTS: ViewKind[] = ["front", "top", "right", "left", "back", "bottom"];
export const DETAIL_ZOOMS = [1.5, 2, 3, 4, 5, 10];

export const detailKey = (id: string) => `detail:${id}`;

/** Add a detail, with its view. */
export function addDetail(d: Drawing, detail: Omit<DetailView, "letter"> & { letter?: string }): Drawing {
  const full: DetailView = { ...detail, letter: detail.letter ?? nextSectionLetter(d) };
  return { ...d, details: [...(d.details ?? []), full], views: [...d.views, { id: `${d.id}-detail-${full.id}`, kind: "detail", detail: full.id }] };
}

export function updateDetail(d: Drawing, id: string, fn: (x: DetailView) => DetailView): Drawing {
  return { ...d, details: (d.details ?? []).map((x) => (x.id === id ? fn(x) : x)) };
}

/** Remove a detail, its view, and the dimensions on it. */
export function removeDetail(d: Drawing, id: string): Drawing {
  const key = detailKey(id);
  const details = (d.details ?? []).filter((x) => x.id !== id);
  const dims = (d.dimensions ?? []).filter((x) => x.view !== key);
  const { details: _x, dimensions: _d, ...rest } = d;
  return {
    ...rest,
    ...(details.length ? { details } : {}),
    ...(dims.length ? { dimensions: dims } : {}),
    views: d.views.filter((v) => !(v.kind === "detail" && v.detail === id)),
  };
}

/** The pieces of a polyline inside a circle. */
export function clipToCircle(line: number[], c: P2, r: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const inside = (x: number, y: number) => Math.hypot(x - c[0], y - c[1]) <= r;
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], ay = line[i + 1], bx = line[i + 2], by = line[i + 3];
    // Where the segment a→b crosses the circle: |a + t(b−a) − c|² = r².
    const dx = bx - ax, dy = by - ay;
    const fx = ax - c[0], fy = ay - c[1];
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    let t0 = 0, t1 = 1;
    if (A < 1e-18) {
      if (!inside(ax, ay)) continue;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc <= 0) {
        flush();
        continue;
      }
      const s = Math.sqrt(disc);
      t0 = Math.max(0, (-B - s) / (2 * A));
      t1 = Math.min(1, (-B + s) / (2 * A));
      if (t0 >= t1) {
        flush();
        continue;
      }
    }
    const p0: P2 = [ax + dx * t0, ay + dy * t0];
    const p1: P2 = [ax + dx * t1, ay + dy * t1];
    if (!cur.length || t0 > 1e-9) {
      flush();
      cur = [p0[0], p0[1]];
    }
    cur.push(p1[0], p1[1]);
    if (t1 < 1 - 1e-9) flush();
  }
  flush();
  return out;
}

/** A detail's lines: the host view's, clipped to the circle, to be drawn `zoom` times bigger. */
export function detailProjection(host: ViewProjection, detail: DetailView): ViewProjection | null {
  if (!host.bounds) return null;
  const [x0, y0, x1, y1] = host.bounds;
  const c: P2 = [x0 + detail.centre[0] * (x1 - x0), y0 + detail.centre[1] * (y1 - y0)];
  const r = detail.radius;
  if (!(r > 0)) return null;
  const clip = (lines: number[][]) => lines.flatMap((l) => clipToCircle(l, c, r));
  const points: number[] = [];
  for (let i = 0; i + 1 < host.points.length; i += 2) {
    if (Math.hypot(host.points[i] - c[0], host.points[i + 1] - c[1]) <= r + 1e-9) points.push(host.points[i], host.points[i + 1]);
  }
  return {
    kind: detailKey(detail.id),
    visible: clip(host.visible),
    hidden: clip(host.hidden),
    circles: host.circles.filter((k) => Math.hypot(k.cx - c[0], k.cy - c[1]) + k.r <= r + 1e-9),
    points,
    bounds: [c[0] - r, c[1] - r, c[0] + r, c[1] + r],
    zoom: detail.zoom,
  };
}

/** The drawing's projections plus its details' (worked out from their host views). */
export function withDetails(projections: Projections, drawing: Pick<Drawing, "details">): Projections {
  if (!drawing.details?.length) return projections;
  const out: Projections = { ...projections };
  for (const d of drawing.details) {
    const host = projections[d.host];
    const p = host && detailProjection(host, d);
    if (p) out[detailKey(d.id)] = p;
  }
  return out;
}
