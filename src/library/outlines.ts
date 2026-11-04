/**
 * Plain polygon geometry for the laser designs (pure, numbers in mm): outlines moved in or out (a kerf allowance, a
 * letter's room in its hole), how far apart two outlines are, whether one crosses itself, convex hulls, and points
 * inside. Outlines are lists of corners, closed (the last joins the first).
 */
export type P2 = [number, number];

/** Signed area (positive = anticlockwise), mm². */
export function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export const anticlockwise = (poly: P2[]): P2[] => (signedArea(poly) < 0 ? [...poly].reverse() : poly);

/** Corners in a row on one straight line, and repeated corners, dropped. */
export function tidyPolygon(poly: P2[], eps = 1e-9): P2[] {
  let out = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > eps;
  });
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (Math.abs(cross) < eps && dot > 0) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * The outline moved `d` outwards all round (negative = inwards), anticlockwise whichever way it was given: each side
 * moved square to itself and the corners joined where the moved sides meet. A very sharp outward corner is cut off
 * (two corners, `limit` × d out) rather than reaching far out to a point.
 */
export function offsetPolygon(poly: P2[], d: number, limit = 2): P2[] {
  const p = tidyPolygon(anticlockwise(poly));
  if (Math.abs(d) < 1e-12) return p;
  const n = p.length;
  const normal = (a: P2, b: P2): P2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  };
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = p[(i + n - 1) % n];
    const here = p[i];
    const next = p[(i + 1) % n];
    const n1 = normal(prev, here);
    const n2 = normal(here, next);
    const cos = n1[0] * n2[0] + n1[1] * n2[1];
    const m: P2 = [(n1[0] + n2[0]) / (1 + cos), (n1[1] + n2[1]) / (1 + cos)];
    const reach = Math.hypot(m[0], m[1]);
    // Turning outwards (convex for d > 0) and sharp: cut square across, |d| out from the corner — so the outline still
    // keeps at least |d| from every point of the old one — rather than reaching far out to a point.
    const turn = n1[0] * n2[1] - n1[1] * n2[0];
    if (cos < -0.999) {
      out.push([here[0] + d * n1[0], here[1] + d * n1[1]], [here[0] + d * n2[0], here[1] + d * n2[1]]);
    } else if (reach > limit && turn * d > 0) {
      const b: P2 = [m[0] / reach, m[1] / reach];
      const u1: P2 = [-n1[1], n1[0]];
      const u2: P2 = [-n2[1], n2[0]];
      const l1 = (d * (1 - (n1[0] * b[0] + n1[1] * b[1]))) / (u1[0] * b[0] + u1[1] * b[1]);
      const l2 = (d * (1 - (n2[0] * b[0] + n2[1] * b[1]))) / (u2[0] * b[0] + u2[1] * b[1]);
      out.push([here[0] + d * n1[0] + l1 * u1[0], here[1] + d * n1[1] + l1 * u1[1]], [here[0] + d * n2[0] + l2 * u2[0], here[1] + d * n2[1] + l2 * u2[1]]);
    } else out.push([here[0] + d * m[0], here[1] + d * m[1]]);
  }
  return tidyPolygon(out);
}

/** Is the point inside the outline (even–odd)? */
export function insidePolygon(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Distance from a point to a line piece. */
export function pointSegment(p: P2, a: P2, b: P2): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
}

const orient = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Do two line pieces cross (touching ends don't count)? */
export function piecesCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const [o1, o2, o3, o4] = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  return o1 * o2 < -1e-18 && o3 * o4 < -1e-18;
}

/** Distance between two line pieces (0 when they cross). */
export function segmentDistance(a: P2, b: P2, c: P2, d: P2): number {
  if (piecesCross(a, b, c, d)) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}

export type Box = [number, number, number, number];

export function boxOf(poly: P2[]): Box {
  let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of poly) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
}

/** How far apart two boxes are (0 when they overlap). */
export const boxGap = (a: Box, b: Box) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));

/**
 * The narrowest gap between two outlines' edges: 0 if they cross or one is inside the other. Stops early (returning
 * something ≤ `enough`) once it's found a gap that small.
 */
export function outlineGap(a: P2[], b: P2[], enough = -1): number {
  if (insidePolygon(a[0], b) || insidePolygon(b[0], a)) return 0;
  let best = Infinity;
  const bb = b.map((_, j) => boxOf([b[j], b[(j + 1) % b.length]]));
  for (let i = 0; i < a.length; i++) {
    const [p, q] = [a[i], a[(i + 1) % a.length]];
    const ab = boxOf([p, q]);
    for (let j = 0; j < b.length; j++) {
      if (boxGap(ab, bb[j]) >= best) continue;
      best = Math.min(best, segmentDistance(p, q, b[j], b[(j + 1) % b.length]));
      if (best <= enough) return best;
    }
  }
  return best;
}

/** How close an outline comes to the edge of another it's inside (∞ when it isn't inside). */
export function insideGap(inner: P2[], outer: P2[]): number {
  if (!inner.every((p) => insidePolygon(p, outer))) return 0;
  let best = Infinity;
  for (let i = 0; i < inner.length; i++)
    for (let j = 0; j < outer.length; j++) best = Math.min(best, segmentDistance(inner[i], inner[(i + 1) % inner.length], outer[j], outer[(j + 1) % outer.length]));
  return best;
}

/** Does the outline cross itself (sides that aren't neighbours meeting)? */
export function crossesItself(poly: P2[]): boolean {
  const n = poly.length;
  const boxes = poly.map((_, i) => boxOf([poly[i], poly[(i + 1) % n]]));
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (boxGap(boxes[i], boxes[j]) > 0) continue;
      if (piecesCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  return false;
}

/** The convex hull of some points, anticlockwise (Andrew's monotone chain). */
export function convexHull(points: P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: P2[]) => {
    const h: P2[] = [];
    for (const p of list) {
      while (h.length >= 2 && orient(h[h.length - 2], h[h.length - 1], p) <= 1e-12) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** Numbers to 6 places, so outlines read cleanly in sketches. */
export const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const round6 = (poly: P2[]): P2[] => poly.map(([x, y]) => [r6(x), r6(y)]);

/** The R1's bed is 600 × 300 mm; leave a little room round each piece. */
export const BED: [number, number] = [590, 290];

/** Does a piece this size fit the laser's bed (either way round)? */
export const fitsBed = (w: number, h: number) => Math.max(w, h) <= BED[0] && Math.min(w, h) <= BED[1];
