/**
 * Extra marks on drawing views: centre marks on holes, centre lines along
 * round faces seen from the side, hatching on cut faces (section views) and
 * numbered balloons that point at the parts of an assembly.
 *
 * Everything here works in a view's own flat coordinates (model mm) unless
 * it says "sheet".
 */
import type { ViewProjection } from "../kernel/protocol";

type P2 = [number, number];

/** How far centre lines run past the edge of what they mark (sheet mm). */
export const CENTRE_OVERRUN = 2;

/**
 * Centre marks: a cross on each visible hole or round boss seen end-on.
 * Circles sharing a centre (a counterbore, say) get one cross, sized to the
 * biggest. Circles smaller than `minSheet` mm across on paper are skipped.
 */
export function centreMarks(p: ViewProjection, scale: number, minSheet = 2): number[][] {
  const tol = 1e-3 * Math.max(1, ...(p.bounds ? p.bounds.map(Math.abs) : [1]));
  const groups: { cx: number; cy: number; r: number }[] = [];
  for (const c of p.circles) {
    if (c.hidden || !c.full || 2 * c.r * scale < minSheet) continue;
    const g = groups.find((x) => Math.hypot(x.cx - c.cx, x.cy - c.cy) < tol);
    if (g) g.r = Math.max(g.r, c.r);
    else groups.push({ cx: c.cx, cy: c.cy, r: c.r });
  }
  const over = CENTRE_OVERRUN / scale;
  return groups.flatMap(({ cx, cy, r }) => [
    [cx - r - over, cy, cx + r + over, cy],
    [cx, cy - r - over, cx, cy + r + over],
  ]);
}

/**
 * Centre lines along round faces seen side-on: the view's axes, with
 * overlapping pieces on one line joined, and each run a little past its ends.
 */
export function centreLines(p: ViewProjection, scale: number): number[][] {
  const over = CENTRE_OVERRUN / scale;
  const size = p.bounds ? Math.max(p.bounds[2] - p.bounds[0], p.bounds[3] - p.bounds[1], 1) : 1;
  return mergeSegments(p.axes ?? [], size * 1e-4).map(([x0, y0, x1, y1]) => {
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    const dx = ((x1 - x0) / l) * over;
    const dy = ((y1 - y0) / l) * over;
    return [x0 - dx, y0 - dy, x1 + dx, y1 + dy];
  });
}

/** Join straight pieces that lie on the same line and overlap (or touch). */
export function mergeSegments(segs: number[][], tol: number): number[][] {
  const out: { a: P2; d: P2; t0: number; t1: number }[] = [];
  for (const s of segs) {
    if (s.length < 4) continue;
    const l = Math.hypot(s[2] - s[0], s[3] - s[1]);
    if (l < tol) continue;
    let d: P2 = [(s[2] - s[0]) / l, (s[3] - s[1]) / l];
    // Point every line the same way, so lines on one axis compare equal.
    if (d[0] < -1e-9 || (Math.abs(d[0]) <= 1e-9 && d[1] < 0)) d = [-d[0], -d[1]];
    const p0: P2 = [s[0], s[1]];
    const p1: P2 = [s[2], s[3]];
    const match = out.find((o) => {
      if (Math.abs(o.d[0] * d[1] - o.d[1] * d[0]) > 1e-6) return false;
      // Distance of this piece's start from the other's line.
      return Math.abs((p0[0] - o.a[0]) * o.d[1] - (p0[1] - o.a[1]) * o.d[0]) < tol;
    });
    const along = (o: { a: P2; d: P2 }, q: P2) => (q[0] - o.a[0]) * o.d[0] + (q[1] - o.a[1]) * o.d[1];
    if (match) {
      const ta = along(match, p0);
      const tb = along(match, p1);
      const lo = Math.min(ta, tb);
      const hi = Math.max(ta, tb);
      if (lo <= match.t1 + tol && hi >= match.t0 - tol) {
        match.t0 = Math.min(match.t0, lo);
        match.t1 = Math.max(match.t1, hi);
        continue;
      }
    }
    const o = { a: p0, d, t0: 0, t1: 0 };
    const t = along(o, p1);
    o.t0 = Math.min(0, t);
    o.t1 = Math.max(0, t);
    out.push(o);
  }
  // A later piece can bridge two earlier ones on the same line: join again until nothing changes.
  const result = out.map((o) => [o.a[0] + o.d[0] * o.t0, o.a[1] + o.d[1] * o.t0, o.a[0] + o.d[0] * o.t1, o.a[1] + o.d[1] * o.t1]);
  return result.length < segs.length ? mergeSegments(result, tol) : result;
}

/**
 * Hatching for cut faces: parallel lines `spacing` apart at `angle` degrees,
 * clipped to the triangles (x, y × 3 each). Returns straight pieces.
 */
export function hatchLines(triangles: number[], spacing: number, angle = 45): number[][] {
  if (triangles.length < 6 || spacing <= 0) return [];
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Turn everything so the hatch lines run along u (v is constant on each).
  const toU = (x: number, y: number) => x * c + y * s;
  const toV = (x: number, y: number) => -x * s + y * c;
  const tris: [number, number][][] = [];
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i + 5 < triangles.length; i += 6) {
    const t: [number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const x = triangles[i + 2 * k];
      const y = triangles[i + 2 * k + 1];
      const v = toV(x, y);
      t.push([toU(x, y), v]);
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    tris.push(t);
  }
  const out: number[][] = [];
  const first = Math.ceil(vMin / spacing);
  const last = Math.floor(vMax / spacing);
  if (last - first > 5000) return [];
  for (let k = first; k <= last; k++) {
    const v = k * spacing;
    const spans: [number, number][] = [];
    for (const t of tris) {
      const us: number[] = [];
      for (let e = 0; e < 3; e++) {
        const [u0, v0] = t[e];
        const [u1, v1] = t[(e + 1) % 3];
        if ((v0 <= v && v1 > v) || (v1 <= v && v0 > v)) us.push(u0 + ((v - v0) / (v1 - v0)) * (u1 - u0));
      }
      if (us.length >= 2) spans.push([Math.min(...us), Math.max(...us)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    const joined: [number, number][] = [];
    const tol = spacing * 1e-6;
    for (const sp of spans) {
      const lastSpan = joined[joined.length - 1];
      if (lastSpan && sp[0] <= lastSpan[1] + tol) lastSpan[1] = Math.max(lastSpan[1], sp[1]);
      else joined.push([sp[0], sp[1]]);
    }
    for (const [u0, u1] of joined) {
      if (u1 - u0 < tol) continue;
      // Back from (u, v) to (x, y).
      out.push([u0 * c - v * s, u0 * s + v * c, u1 * c - v * s, u1 * s + v * c]);
    }
  }
  return out;
}

/**
 * Where to put numbered balloons (sheet mm) around a view, each pointing at
 * its spot on the view: pushed straight out from the view's middle to just
 * outside its outline, then turned a little until it doesn't touch another.
 */
export function placeBalloons(box: [number, number, number, number], targets: P2[], radius = 4, gap = 6): P2[] {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const hw = (box[2] - box[0]) / 2 + gap + radius;
  const hh = (box[3] - box[1]) / 2 + gap + radius;
  /** The point on the grown outline in a direction from the middle. */
  const onOutline = (ang: number): P2 => {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const t = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
    return [cx + dx * t, cy + dy * t];
  };
  const placed: P2[] = [];
  targets.forEach((t, i) => {
    const dx = t[0] - cx;
    const dy = t[1] - cy;
    // Pointing straight at the middle: spread them round instead.
    const base = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : Math.PI / 4 + (i * Math.PI) / 3;
    let best = onOutline(base);
    for (let step = 0; step < 48; step++) {
      // Try 0, +7.5°, −7.5°, +15°…
      const turn = (Math.ceil(step / 2) * (step % 2 ? 1 : -1) * Math.PI) / 24;
      const at = onOutline(base + turn);
      if (placed.every((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) >= 2 * radius + 1)) {
        best = at;
        break;
      }
    }
    placed.push(best);
  });
  return placed;
}

/** The point of a mesh nearest the middle of its bounding box (a spot on its surface for a balloon to point at). */
export function surfacePointNearCentre(vertices: ArrayLike<number>): [number, number, number] | null {
  if (vertices.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], vertices[i + k]);
      hi[k] = Math.max(hi[k], vertices[i + k]);
    }
  }
  const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const d = (vertices[i] - mid[0]) ** 2 + (vertices[i + 1] - mid[1]) ** 2 + (vertices[i + 2] - mid[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return [vertices[best], vertices[best + 1], vertices[best + 2]];
}
