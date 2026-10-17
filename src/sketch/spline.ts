/**
 * Splines: smooth curves through the points the user clicks (Onshape's
 * spline). Each stretch between two points is a cubic Bézier curve shaped so
 * the curve flows smoothly through every point (a Catmull-Rom spline); a
 * closed spline joins back to its first point.
 */
type P2 = [number, number];

/**
 * A conic (Onshape's conic): from `a` to `b`, pulled towards the corner point
 * `apex` by `rho` — 0.5 is a parabola, less is flatter (an ellipse's arc),
 * more is fuller (a hyperbola's). It's a rational quadratic Bézier curve with
 * weight rho / (1 − rho) on the corner, given here as cubic pieces that follow
 * it to well within a thousandth of a millimetre.
 */
export function conicBeziers(a: P2, apex: P2, b: P2, rho: number, pieces = 8): [P2, P2, P2, P2][] {
  const r = Math.min(0.99, Math.max(0.01, rho));
  const w = r / (1 - r);
  const at = (t: number): { p: P2; d: P2 } => {
    const u = 1 - t;
    const k0 = u * u;
    const k1 = 2 * w * u * t;
    const k2 = t * t;
    const D = k0 + k1 + k2;
    const N: P2 = [k0 * a[0] + k1 * apex[0] + k2 * b[0], k0 * a[1] + k1 * apex[1] + k2 * b[1]];
    const d0 = -2 * u;
    const d1 = 2 * w * (1 - 2 * t);
    const d2 = 2 * t;
    const dD = d0 + d1 + d2;
    const dN: P2 = [d0 * a[0] + d1 * apex[0] + d2 * b[0], d0 * a[1] + d1 * apex[1] + d2 * b[1]];
    return { p: [N[0] / D, N[1] / D], d: [(dN[0] * D - N[0] * dD) / (D * D), (dN[1] * D - N[1] * dD) / (D * D)] };
  };
  const out: [P2, P2, P2, P2][] = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = i / pieces;
    const t1 = (i + 1) / pieces;
    const s = at(t0);
    const e = at(t1);
    const h = (t1 - t0) / 3;
    out.push([s.p, [s.p[0] + s.d[0] * h, s.p[1] + s.d[1] * h], [e.p[0] - e.d[0] * h, e.p[1] - e.d[1] * h], e.p]);
  }
  // Exactly through the end points.
  out[0][0] = a;
  out[out.length - 1][3] = b;
  return out;
}

/**
 * The curve's direction and speed at each point (its tangent vector): the
 * one the user set by dragging a handle, or else the natural one — half the
 * way from the point before to the point after (so the curve flows smoothly),
 * straight on at an open spline's ends.
 */
export function splineTangents(pts: P2[], closed: boolean, set?: (P2 | undefined)[]): P2[] {
  const n = pts.length;
  const at = (i: number): P2 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  return pts.map((_, i) => set?.[i] ?? [(at(i + 1)[0] - at(i - 1)[0]) / 2, (at(i + 1)[1] - at(i - 1)[1]) / 2]);
}

/**
 * The Bézier pieces (start, two handles, end) for a spline through `pts` — or,
 * given `conic`, a conic over its three points. `tangents` are the user's
 * handles (per point; missing ones curve naturally).
 */
export function splineBeziers(pts: P2[], closed: boolean, conic?: number, tangents?: (P2 | undefined)[]): [P2, P2, P2, P2][] {
  if (conic !== undefined && pts.length === 3) return conicBeziers(pts[0], pts[1], pts[2], conic);
  const n = pts.length;
  if (n < 2) return [];
  const t = splineTangents(pts, closed, tangents);
  const out: [P2, P2, P2, P2][] = [];
  const pieces = closed ? n : n - 1;
  for (let i = 0; i < pieces; i++) {
    const j = (i + 1) % n;
    const p1 = pts[i];
    const p2 = pts[j];
    const c1: P2 = [p1[0] + t[i][0] / 3, p1[1] + t[i][1] / 3];
    const c2: P2 = [p2[0] - t[j][0] / 3, p2[1] - t[j][1] / 3];
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
export function splinePolyline(pts: P2[], closed: boolean, steps = 16, conic?: number, tangents?: (P2 | undefined)[]): P2[] {
  const pieces = splineBeziers(pts, closed, conic, tangents);
  if (conic !== undefined) steps = Math.max(2, Math.round(steps / 3));
  if (!pieces.length) return pts.slice();
  const out: P2[] = [pieces[0][0]];
  for (const b of pieces) for (let k = 1; k <= steps; k++) out.push(bezierAt(b, k / steps));
  return out;
}
