/**
 * Fitting simple shapes to points: lines, circles, planes, cylinders, cones
 * and spheres, by least squares. Used to recognise the real faces and edges
 * in a part that's only triangles (see meshSimplify.ts). Pure maths, no
 * OpenCascade.
 *
 * Every fit returns the shape and how far the furthest point is from it, so
 * the caller can accept it only within a tolerance.
 */

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
};
export const dist = (a: Vec3, b: Vec3) => norm(sub(a, b));

/** Two directions square to `a` (and to each other), so (u, v, a) is right-handed. */
export function frameOf(a: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(helper, a));
  return [u, cross(a, u)];
}

/**
 * The same sideways direction for a direction and its opposite (square to
 * both): where whole circles start, and where round faces' seams are, so the
 * two always agree.
 */
export function canonicalX(a: Vec3): Vec3 {
  const big = [0, 1, 2].reduce((i, j) => (Math.abs(a[j]) > Math.abs(a[i]) + 1e-12 ? j : i), 0);
  return frameOf(a[big] < 0 ? scale(a, -1) : a)[0];
}

/** The eigenvalues (smallest first) and unit eigenvectors of a symmetric 3 × 3 matrix (Jacobi rotations). */
export function eigenSym3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => unit([v[0][i], v[1][i], v[2][i]])) };
}

/** Solves the square system A x = b (Gaussian elimination with partial pivoting); null when it's singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-300) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = m.map((r, i) => r[n] / r[i]);
  return x.every(Number.isFinite) ? x : null;
}

/** Least squares: the x that makes rows · x closest to rhs (normal equations; rows are small). */
export function leastSquares(rows: number[][], rhs: number[]): number[] | null {
  const n = rows[0]?.length ?? 0;
  if (!n || rows.length < n) return null;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  rows.forEach((r, i) => {
    for (let p = 0; p < n; p++) {
      b[p] += r[p] * rhs[i];
      for (let q = 0; q < n; q++) A[p][q] += r[p] * r[q];
    }
  });
  return solveLinear(A, b);
}

export const centroid = (pts: Vec3[]): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return pts.length ? scale(c, 1 / pts.length) : c;
};

// ---------------------------------------------------------------- surfaces

export interface PlaneSurface {
  kind: "plane";
  /** Unit normal. */
  normal: Vec3;
  /** A point on the plane. */
  origin: Vec3;
}
export interface CylinderSurface {
  kind: "cylinder";
  /** A point on the axis. */
  origin: Vec3;
  axis: Vec3;
  radius: number;
}
export interface ConeSurface {
  kind: "cone";
  /** A point on the axis, where the radius is `radius`. */
  origin: Vec3;
  /** Unit axis; the radius grows by `slope` per mm along it. */
  axis: Vec3;
  radius: number;
  slope: number;
}
export interface SphereSurface {
  kind: "sphere";
  centre: Vec3;
  radius: number;
}
export interface TorusSurface {
  kind: "torus";
  /** The centre, on the axis. */
  origin: Vec3;
  axis: Vec3;
  /** From the axis to the middle of the tube. */
  major: number;
  /** The tube's radius (a fillet's radius). */
  minor: number;
}
export type FitSurface = PlaneSurface | CylinderSurface | ConeSurface | SphereSurface | TorusSurface;

/** Where a point is about a torus: its direction out from the axis, and (across, up) from the tube's middle. */
function torusPlace(s: TorusSurface, p: Vec3): { dir: Vec3; w: [number, number] } {
  const d = sub(p, s.origin);
  const h = dot(d, s.axis);
  const radial = sub(d, scale(s.axis, h));
  const r = norm(radial);
  const dir = r > 1e-12 ? scale(radial, 1 / r) : frameOf(s.axis)[0];
  return { dir, w: [r - s.major, h] };
}

/** How far a point is from a surface (always ≥ 0). */
export function surfaceDistance(s: FitSurface, p: Vec3): number {
  return norm(sub(projectOnSurface(s, p), p));
}

/** The nearest point on a surface (for a cone, near its sides — not past the apex). */
export function projectOnSurface(s: FitSurface, p: Vec3): Vec3 {
  switch (s.kind) {
    case "plane":
      return sub(p, scale(s.normal, dot(sub(p, s.origin), s.normal)));
    case "sphere": {
      const d = sub(p, s.centre);
      const n = norm(d);
      return n > 1e-12 ? add(s.centre, scale(d, s.radius / n)) : add(s.centre, [s.radius, 0, 0]);
    }
    case "cylinder": {
      const d = sub(p, s.origin);
      const t = dot(d, s.axis);
      const foot = add(s.origin, scale(s.axis, t));
      const r = sub(p, foot);
      const n = norm(r);
      const dir = n > 1e-12 ? scale(r, 1 / n) : frameOf(s.axis)[0];
      return add(foot, scale(dir, s.radius));
    }
    case "torus": {
      const { dir, w } = torusPlace(s, p);
      const len = Math.hypot(w[0], w[1]) || 1e-12;
      return add(add(s.origin, scale(dir, s.major + (s.minor * w[0]) / len)), scale(s.axis, (s.minor * w[1]) / len));
    }
    case "cone": {
      // In the plane through the axis and p: the side is the line r = radius + slope · t.
      const d = sub(p, s.origin);
      const t = dot(d, s.axis);
      const radial = sub(d, scale(s.axis, t));
      const r = norm(radial);
      const dir = r > 1e-12 ? scale(radial, 1 / r) : frameOf(s.axis)[0];
      const len = Math.hypot(1, s.slope);
      // Unit direction of the side line (t, r) and a point on it.
      const along = [1 / len, s.slope / len];
      const k = (t - 0) * along[0] + (r - s.radius) * along[1];
      const tt = k * along[0];
      const rr = s.radius + k * along[1];
      return add(add(s.origin, scale(s.axis, tt)), scale(dir, rr));
    }
  }
}

/** The surface's own normal at (near) a point: away from the axis/centre, or the plane's normal. */
export function surfaceNormal(s: FitSurface, p: Vec3): Vec3 {
  switch (s.kind) {
    case "plane":
      return s.normal;
    case "sphere":
      return unit(sub(p, s.centre));
    case "cylinder": {
      const d = sub(p, s.origin);
      return unit(sub(d, scale(s.axis, dot(d, s.axis))));
    }
    case "cone": {
      const d = sub(p, s.origin);
      const radial = unit(sub(d, scale(s.axis, dot(d, s.axis))));
      return unit(sub(radial, scale(s.axis, s.slope)));
    }
    case "torus": {
      const { dir, w } = torusPlace(s, p);
      const len = Math.hypot(w[0], w[1]) || 1e-12;
      return unit(add(scale(dir, w[0] / len), scale(s.axis, w[1] / len)));
    }
  }
}

// ---------------------------------------------------------------- fits

export interface Fit<T> {
  shape: T;
  /** The furthest any point is from the shape (mm). */
  maxError: number;
  /** Root-mean-square distance (mm). */
  rms: number;
}

function errors<T>(shape: T, pts: Vec3[], d: (s: T, p: Vec3) => number): Fit<T> {
  let max = 0;
  let sum = 0;
  for (const p of pts) {
    const e = d(shape, p);
    if (e > max) max = e;
    sum += e * e;
  }
  return { shape, maxError: max, rms: pts.length ? Math.sqrt(sum / pts.length) : 0 };
}

/** The plane through points (smallest spread of the scatter about their centre). `toward` picks the normal's side. */
export function fitPlane(pts: Vec3[], toward?: Vec3): Fit<PlaneSurface> | null {
  if (pts.length < 3) return null;
  const c = centroid(pts);
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
  }
  const { values, vectors } = eigenSym3(m);
  if (values[1] < 1e-18) return null; // all on a line
  let n = vectors[0];
  if (toward && dot(n, toward) < 0) n = scale(n, -1);
  return errors<PlaneSurface>({ kind: "plane", normal: n, origin: c }, pts, surfaceDistance);
}

export interface Circle2 {
  cx: number;
  cy: number;
  r: number;
}

/** Solves a 3 × 3 system (Cramer's rule); null when it's singular. */
function solve3(a: number[], b: number[]): [number, number, number] | null {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const det = a0 * (a4 * a8 - a5 * a7) - a1 * (a3 * a8 - a5 * a6) + a2 * (a3 * a7 - a4 * a6);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const x = (b[0] * (a4 * a8 - a5 * a7) - a1 * (b[1] * a8 - a5 * b[2]) + a2 * (b[1] * a7 - a4 * b[2])) / det;
  const y = (a0 * (b[1] * a8 - a5 * b[2]) - b[0] * (a3 * a8 - a5 * a6) + a2 * (a3 * b[2] - b[1] * a6)) / det;
  const z = (a0 * (a4 * b[2] - b[1] * a7) - a1 * (a3 * b[2] - b[1] * a6) + b[0] * (a3 * a7 - a4 * a6)) / det;
  return [x, y, z];
}

/** The circle through 2D points: an algebraic (Kåsa) fit, then (with `refine`) the true least-squares circle. */
export function fitCircle2D(xs: number[], ys: number[], refine = true): { circle: Circle2; maxError: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  // Work about the points' middle, for good numbers.
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  // x² + y² = A x + B y + C, by normal equations summed directly.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const s = solve3([sxx, sxy, sx, sxy, syy, sy, sx, sy, n], [sxz, syz, sz]);
  if (!s) return null;
  let cx = s[0] / 2;
  let cy = s[1] / 2;
  let r = Math.sqrt(Math.max(0, s[2] + cx * cx + cy * cy));
  if (!Number.isFinite(r) || r === 0) return null;
  // Gauss–Newton on the geometric distances.
  for (let it = 0; it < (refine ? 20 : 0); it++) {
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx - cx;
      const dy = ys[i] - my - cy;
      const d = Math.hypot(dx, dy) || 1e-12;
      const j0 = -dx / d;
      const j1 = -dy / d;
      const f = r - d;
      A[0] += j0 * j0;
      A[1] += j0 * j1;
      A[2] -= j0;
      A[4] += j1 * j1;
      A[5] -= j1;
      A[8] += 1;
      b[0] += j0 * f;
      b[1] += j1 * f;
      b[2] -= f;
    }
    A[3] = A[1];
    A[6] = A[2];
    A[7] = A[5];
    const step = solve3(A, b);
    if (!step) break;
    cx += step[0];
    cy += step[1];
    r += step[2];
    if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) < 1e-12 * (1 + r)) break;
  }
  let maxError = 0;
  for (let i = 0; i < n; i++) maxError = Math.max(maxError, Math.abs(Math.hypot(xs[i] - mx - cx, ys[i] - my - cy) - r));
  return { circle: { cx: cx + mx, cy: cy + my, r: Math.abs(r) }, maxError };
}

export interface Circle3 {
  centre: Vec3;
  /** Unit normal of the circle's plane. */
  normal: Vec3;
  radius: number;
}

export const circleDistance = (c: Circle3, p: Vec3) => {
  const d = sub(p, c.centre);
  const h = dot(d, c.normal);
  const inPlane = norm(sub(d, scale(c.normal, h)));
  return Math.hypot(h, inPlane - c.radius);
};

/** The nearest point on a circle. */
export function projectOnCircle(c: Circle3, p: Vec3): Vec3 {
  const d = sub(p, c.centre);
  const inPlane = sub(d, scale(c.normal, dot(d, c.normal)));
  const n = norm(inPlane);
  const dir = n > 1e-12 ? scale(inPlane, 1 / n) : frameOf(c.normal)[0];
  return add(c.centre, scale(dir, c.radius));
}

/** The circle through 3D points (a plane through them, then a circle in it). */
export function fitCircle3D(pts: Vec3[], refine = true): Fit<Circle3> | null {
  const plane = fitPlane(pts);
  if (!plane) return null;
  const [u, v] = frameOf(plane.shape.normal);
  const o = plane.shape.origin;
  const xs = pts.map((p) => dot(sub(p, o), u));
  const ys = pts.map((p) => dot(sub(p, o), v));
  const c = fitCircle2D(xs, ys, refine);
  if (!c) return null;
  const centre = add(o, add(scale(u, c.circle.cx), scale(v, c.circle.cy)));
  return errors<Circle3>({ centre, normal: plane.shape.normal, radius: c.circle.r }, pts, circleDistance);
}

export interface Line3 {
  origin: Vec3;
  dir: Vec3;
}
export const lineDistance = (l: Line3, p: Vec3) => {
  const d = sub(p, l.origin);
  return norm(sub(d, scale(l.dir, dot(d, l.dir))));
};

/** The straight line through 3D points (their main direction through their centre). */
export function fitLine(pts: Vec3[]): Fit<Line3> | null {
  if (pts.length < 2) return null;
  const c = centroid(pts);
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
  }
  const { vectors } = eigenSym3(m);
  return errors<Line3>({ origin: c, dir: vectors[2] }, pts, lineDistance);
}

/** A direction square to every normal given (the axis of a cylinder whose facets have these normals). */
export function axisFromNormals(normals: Vec3[], weights?: number[]): Vec3 {
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  normals.forEach((n, k) => {
    const w = weights?.[k] ?? 1;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += w * n[i] * n[j];
  });
  return eigenSym3(m).vectors[0];
}

/** The direction whose angle to every normal is the same (a cone's axis), from the normals' spread. */
export function coneAxisFromNormals(normals: Vec3[], weights?: number[]): Vec3 {
  let total = 0;
  let mean: Vec3 = [0, 0, 0];
  normals.forEach((n, k) => {
    const w = weights?.[k] ?? 1;
    mean = add(mean, scale(n, w));
    total += w;
  });
  mean = scale(mean, 1 / (total || 1));
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  normals.forEach((n, k) => {
    const w = weights?.[k] ?? 1;
    const d = sub(n, mean);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += w * d[i] * d[j];
  });
  const a = eigenSym3(m).vectors[0];
  // Pointing the way the normals lean.
  return dot(a, mean) < 0 ? scale(a, -1) : a;
}

/** A cylinder round a known axis direction through points. */
export function fitCylinderAlong(pts: Vec3[], axis: Vec3, refine = true): Fit<CylinderSurface> | null {
  const a = unit(axis);
  const [u, v] = frameOf(a);
  const o = centroid(pts);
  const xs = pts.map((p) => dot(sub(p, o), u));
  const ys = pts.map((p) => dot(sub(p, o), v));
  const c = fitCircle2D(xs, ys, refine);
  if (!c) return null;
  const origin = add(o, add(scale(u, c.circle.cx), scale(v, c.circle.cy)));
  return errors<CylinderSurface>({ kind: "cylinder", origin, axis: a, radius: c.circle.r }, pts, surfaceDistance);
}

/**
 * A cylinder through points, the axis first guessed from the facets' normals
 * (all square to it), then tilted to fit the points better.
 */
export function fitCylinder(pts: Vec3[], normals: Vec3[], weights?: number[], goal = 0): Fit<CylinderSurface> | null {
  let best = fitCylinderAlong(pts, axisFromNormals(normals, weights), false);
  if (!best) return null;
  // Tilt the axis a little each way while that helps (normals from noisy meshes are rough) — unless it's
  // already within `goal`, or so far off that tilting won't save it.
  if (goal > 0 && (best.maxError <= goal / 4 || best.maxError > 10 * goal)) return fitCylinderAlong(pts, best.shape.axis) ?? best;
  let step = 0.02;
  for (let it = 0; it < 40 && step > 1e-7; it++) {
    if (goal > 0 && best.maxError <= goal / 4) break;
    const [u, v] = frameOf(best.shape.axis);
    let improved = false;
    for (const [du, dv] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const a = unit(add(best.shape.axis, add(scale(u, du * step), scale(v, dv * step))));
      const f = fitCylinderAlong(pts, a, false);
      if (f && f.rms < best.rms - 1e-15) {
        best = f;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return fitCylinderAlong(pts, best.shape.axis) ?? best;
}

/** A cone through points round a known axis direction: the side's radius grows in a straight line along it. */
export function fitConeAlong(pts: Vec3[], axis: Vec3): Fit<ConeSurface> | null {
  const a = unit(axis);
  const [u, v] = frameOf(a);
  const o = centroid(pts);
  const rows: number[][] = [];
  const rhs: number[] = [];
  const coords = pts.map((p) => {
    const d = sub(p, o);
    return [dot(d, u), dot(d, v), dot(d, a)];
  });
  // x² + y² = A x + B y + C + D t + E t²  (linear in A…E).
  for (const [x, y, t] of coords) {
    rows.push([x, y, 1, t, t * t]);
    rhs.push(x * x + y * y);
  }
  const s = leastSquares(rows, rhs);
  if (!s) return null;
  const cx = s[0] / 2;
  const cy = s[1] / 2;
  // Radius against height, as a straight line.
  const rs = coords.map(([x, y]) => Math.hypot(x - cx, y - cy));
  const ts = coords.map((c) => c[2]);
  const line = leastSquares(
    ts.map((t) => [1, t]),
    rs,
  );
  if (!line) return null;
  const origin = add(o, add(scale(u, cx), scale(v, cy)));
  return errors<ConeSurface>({ kind: "cone", origin, axis: a, radius: line[0], slope: line[1] }, pts, surfaceDistance);
}

/** A cone through points, its axis from the facets' normals (all at the same angle to it). */
export function fitCone(pts: Vec3[], normals: Vec3[], weights?: number[], goal = 0): Fit<ConeSurface> | null {
  let best = fitConeAlong(pts, coneAxisFromNormals(normals, weights));
  if (!best) return null;
  if (goal > 0 && (best.maxError <= goal / 4 || best.maxError > 10 * goal)) return best;
  let step = 0.02;
  for (let it = 0; it < 40 && step > 1e-7; it++) {
    if (goal > 0 && best.maxError <= goal / 4) break;
    const [u, v] = frameOf(best.shape.axis);
    let improved = false;
    for (const [du, dv] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const f = fitConeAlong(pts, unit(add(best.shape.axis, add(scale(u, du * step), scale(v, dv * step)))));
      if (f && f.rms < best.rms - 1e-15) {
        best = f;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return best;
}

/** A sphere through points (algebraic fit, then refined). */
export function fitSphere(pts: Vec3[]): Fit<SphereSurface> | null {
  if (pts.length < 4) return null;
  const o = centroid(pts);
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const p of pts) {
    const d = sub(p, o);
    rows.push([d[0], d[1], d[2], 1]);
    rhs.push(dot(d, d));
  }
  const s = leastSquares(rows, rhs);
  if (!s) return null;
  let c: Vec3 = [s[0] / 2, s[1] / 2, s[2] / 2];
  let r = Math.sqrt(Math.max(0, s[3] + dot(c, c)));
  for (let it = 0; it < 20; it++) {
    const J: number[][] = [];
    const f: number[] = [];
    for (const p of pts) {
      const d = sub(sub(p, o), c);
      const n = norm(d) || 1e-12;
      J.push([-d[0] / n, -d[1] / n, -d[2] / n, -1]);
      f.push(-(n - r));
    }
    const step = leastSquares(J, f);
    if (!step) break;
    c = add(c, [step[0], step[1], step[2]]);
    r += step[3];
    if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) + Math.abs(step[3]) < 1e-12 * (1 + r)) break;
  }
  if (!Number.isFinite(r) || r <= 0) return null;
  return errors<SphereSurface>({ kind: "sphere", centre: add(o, c), radius: r }, pts, surfaceDistance);
}

/**
 * A torus (a fillet round a hole or a boss) through points, from the facets'
 * middles and normals: stepping in from each middle by the tube's radius along
 * its normal lands on the tube's middle circle, so the radius is the one that
 * puts those landing points best on one circle (searched), and that circle is
 * the torus's middle. `middles`/`normals` are per facet; `pts` are checked.
 */
export function fitTorus(pts: Vec3[], middles: Vec3[], normals: Vec3[], size: number): Fit<TorusSurface> | null {
  if (middles.length < 4) return null;
  // The search looks at up to 120 facets, with a quick circle fit; the answer is then fitted properly.
  const every = Math.max(1, Math.ceil(middles.length / 120));
  const few = middles.map((_, i) => i).filter((i) => i % every === 0);
  const spine = (r: number, all = false) => fitCircle3D((all ? middles.map((_, i) => i) : few).map((i) => sub(middles[i], scale(normals[i], r))), all);
  const score = (r: number) => spine(r)?.rms ?? Infinity;
  // A rough look over both signs (inside and outside fillets), then a closer one about the best.
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k <= 30; k++) {
    const r = size * 10 ** (-3 * (k / 30));
    for (const rr of [r, -r]) {
      const e = score(rr);
      if (e < bestScore) {
        bestScore = e;
        best = rr;
      }
    }
  }
  let lo = best / 10 ** (3 / 30);
  let hi = best * 10 ** (3 / 30);
  for (let it = 0; it < 30; it++) {
    const a = lo + (hi - lo) * 0.382;
    const b = lo + (hi - lo) * 0.618;
    if (score(a) < score(b)) hi = b;
    else lo = a;
  }
  const r = (lo + hi) / 2;
  const circle = spine(r, true);
  if (!circle) return null;
  const minor = Math.abs(r);
  const major = circle.shape.radius;
  if (!(major > minor * 1.0001)) return null;
  const surface: TorusSurface = { kind: "torus", origin: circle.shape.centre, axis: circle.shape.normal, major, minor };
  return errors<TorusSurface>(surface, pts, surfaceDistance);
}

// ---------------------------------------------------------------- tidy numbers

/** Round steps tried, coarsest first, when snapping a size to a "nice" number. */
const NICE_STEPS = [1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005, 0.001];

/**
 * A size moved to the roundest number within `tol` of it (4.9998 → 5,
 * 2.4999 → 2.5), or left as it is when none is that close.
 */
export function snapNice(value: number, tol: number): number {
  for (const step of NICE_STEPS) {
    const r = Math.round(value / step) * step;
    if (Math.abs(r - value) <= tol) return Number(r.toFixed(6)) + 0;
  }
  return value;
}

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** A direction moved onto X, Y or Z (keeping its sense) when it's within `angle` (radians) of one. */
export function snapDirection(d: Vec3, angle: number): Vec3 {
  for (const a of AXES) {
    const c = dot(d, a);
    if (Math.abs(c) >= Math.cos(angle)) return c > 0 ? a : (a.map((x) => (x ? -x : 0)) as Vec3);
  }
  return d;
}

/** A point's coordinates each snapped to a nice number within `tol`. */
export const snapPoint = (p: Vec3, tol: number): Vec3 => [snapNice(p[0], tol), snapNice(p[1], tol), snapNice(p[2], tol)];

/**
 * A fitted surface tidied: axes and normals onto X/Y/Z when nearly along one,
 * sizes and positions onto round numbers, each only within the tolerances
 * given (so it never moves further from the points than that).
 */
export function tidySurface(s: FitSurface, sizeTol: number, angle: number): FitSurface {
  switch (s.kind) {
    case "plane": {
      const normal = snapDirection(s.normal, angle);
      // The plane's offset along its normal, rounded.
      const off = dot(s.origin, normal);
      const nice = snapNice(off, sizeTol);
      const origin = add(sub(s.origin, scale(normal, dot(s.origin, normal))), scale(normal, nice));
      return { kind: "plane", normal, origin };
    }
    case "cylinder": {
      const axis = snapDirection(s.axis, angle);
      // The axis through the point nearest the world origin, rounded.
      const o = sub(s.origin, scale(axis, dot(s.origin, axis)));
      return { kind: "cylinder", axis, origin: snapPoint(o, sizeTol), radius: snapNice(2 * s.radius, sizeTol) / 2 };
    }
    case "sphere":
      return { kind: "sphere", centre: snapPoint(s.centre, sizeTol), radius: snapNice(2 * s.radius, sizeTol) / 2 };
    case "cone": {
      const axis = snapDirection(s.axis, angle);
      return { ...s, axis };
    }
    case "torus": {
      const axis = snapDirection(s.axis, angle);
      return { kind: "torus", axis, origin: snapPoint(s.origin, sizeTol), major: snapNice(s.major, sizeTol), minor: snapNice(2 * s.minor, sizeTol) / 2 };
    }
  }
}
