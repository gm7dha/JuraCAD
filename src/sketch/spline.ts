/**
 * Splines: smooth curves through the points the user clicks (Onshape's
 * spline). Each stretch between two points is a cubic Bézier curve shaped so
 * the curve flows smoothly through every point (a Catmull-Rom spline); a
 * closed spline joins back to its first point.
 */
type P2 = [number, number];

/** The Bézier pieces (start, two handles, end) for a spline through `pts`. */
export function splineBeziers(pts: P2[], closed: boolean): [P2, P2, P2, P2][] {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number): P2 => {
    if (closed) return pts[((i % n) + n) % n];
    // Past the ends: mirror the next point, so the curve leaves the end straight towards it.
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const out: [P2, P2, P2, P2][] = [];
  const pieces = closed ? n : n - 1;
  for (let i = 0; i < pieces; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1: P2 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: P2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    out.push([p1, c1, c2, p2]);
  }
  return out;
}

/** A point on one Bézier piece (t from 0 to 1). */
export function bezierAt([a, b, c, d]: [P2, P2, P2, P2], t: number): P2 {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
}

/** The spline as short straight pieces (for drawing, picking and finding closed shapes). */
export function splinePolyline(pts: P2[], closed: boolean, steps = 16): P2[] {
  const pieces = splineBeziers(pts, closed);
  if (!pieces.length) return pts.slice();
  const out: P2[] = [pieces[0][0]];
  for (const b of pieces) for (let k = 1; k <= steps; k++) out.push(bezierAt(b, k / steps));
  return out;
}
