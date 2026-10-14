/**
 * 2D sketch constraint solver.
 *
 * Unknowns: every point's (x, y) and every circle's radius. Each constraint
 * contributes one or two "residuals" that are zero when it is satisfied.
 * We drive all residuals to zero with damped Gauss–Newton steps that change
 * the geometry as little as possible (minimum-norm steps), which is what makes
 * dragging feel natural: the rest of the sketch only moves when it has to.
 *
 * `analyzeSketch` then looks at which unknowns are pinned down by the
 * constraints, so fully defined geometry can be drawn black, as in Onshape.
 */
import { evaluate } from "../model/expr";
import { ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData } from "./types";

type Vec = [number, number];

interface System {
  n: number;
  /** Variable index for each point's x (y is +1), and each circle's radius. */
  pointVar: Map<string, number>;
  radiusVar: Map<string, number>;
  x0: Float64Array;
  /** Residual blocks: one per constraint (plus hidden arc constraints). */
  blocks: { id: string | null; size: number; eval: (x: Float64Array, out: number[]) => void }[];
  /** Constraints that couldn't be used (e.g. a dimension with an invalid value), with the reason. */
  skipped: Map<string, string>;
}

const curveById = (s: SketchData) => new Map(s.curves.map((c) => [c.id, c]));

function buildSystem(sketch: SketchData): System {
  const pointVar = new Map<string, number>();
  const radiusVar = new Map<string, number>();
  const init: number[] = [];
  for (const p of sketch.points) {
    pointVar.set(p.id, init.length);
    init.push(p.x, p.y);
  }
  for (const c of sketch.curves) {
    if (c.type === "circle") {
      radiusVar.set(c.id, init.length);
      init.push(c.radius);
    }
  }
  const curves = curveById(sketch);
  const skipped = new Map<string, string>();

  const P = (id: string) => {
    if (id === ORIGIN_ID) return (_x: Float64Array): Vec => [0, 0];
    const i = pointVar.get(id);
    if (i === undefined) throw new Error(`missing point ${id}`);
    return (x: Float64Array): Vec => [x[i], x[i + 1]];
  };
  const lineEnds = (id: string) => {
    const c = curves.get(id);
    if (!c || c.type !== "line") throw new Error(`${id} is not a line`);
    return [P(c.p1), P(c.p2)] as const;
  };
  /** Centre and radius accessors for a circle or arc. */
  const circular = (id: string) => {
    const c = curves.get(id);
    if (!c || c.type === "line") throw new Error(`${id} is not a circle or arc`);
    const centre = P(c.center);
    if (c.type === "circle") {
      const ri = radiusVar.get(c.id)!;
      return { centre, radius: (x: Float64Array) => x[ri] };
    }
    const start = P(c.start);
    return {
      centre,
      radius: (x: Float64Array) => {
        const [cx, cy] = centre(x);
        const [sx, sy] = start(x);
        return Math.hypot(sx - cx, sy - cy);
      },
    };
  };
  const dir = (id: string) => {
    const [a, b] = lineEnds(id);
    return (x: Float64Array): Vec => {
      const pa = a(x);
      const pb = b(x);
      return [pb[0] - pa[0], pb[1] - pa[1]];
    };
  };
  const kind = (id: string): "point" | SketchCurve["type"] =>
    id === ORIGIN_ID || pointVar.has(id) ? "point" : curves.get(id)?.type ?? "point";

  const blocks: System["blocks"] = [];

  // Every arc keeps its start and end at the same distance from the centre.
  for (const c of sketch.curves) {
    if (c.type !== "arc") continue;
    const cen = P(c.center);
    const s = P(c.start);
    const e = P(c.end);
    blocks.push({
      id: null,
      size: 1,
      eval: (x, out) => {
        const [cx, cy] = cen(x);
        const [sx, sy] = s(x);
        const [ex, ey] = e(x);
        out.push(Math.hypot(sx - cx, sy - cy) - Math.hypot(ex - cx, ey - cy));
      },
    });
  }

  for (const con of sketch.constraints) {
    let value = 0;
    if (con.value !== undefined) {
      const r = evaluate(con.value);
      if (!r.ok) {
        skipped.set(con.id, r.error);
        continue;
      }
      value = r.value;
    }
    const [a, b] = con.refs;
    try {
      const block = makeBlock(con, value, a, b);
      if (block) blocks.push({ id: con.id, ...block });
    } catch (e) {
      skipped.set(con.id, e instanceof Error ? e.message : String(e));
    }
  }

  function makeBlock(
    con: SketchConstraint,
    value: number,
    a: string,
    b: string,
  ): { size: number; eval: (x: Float64Array, out: number[]) => void } | null {
    switch (con.type) {
      case "coincident": {
        const p = P(a);
        const q = P(b);
        return { size: 2, eval: (x, out) => { const u = p(x), w = q(x); out.push(u[0] - w[0], u[1] - w[1]); } };
      }
      case "fix": {
        const p = P(a);
        const [fx, fy] = con.extra ?? [0, 0];
        return { size: 2, eval: (x, out) => { const u = p(x); out.push(u[0] - fx, u[1] - fy); } };
      }
      case "horizontal":
      case "vertical": {
        const k = con.type === "horizontal" ? 1 : 0;
        const [p, q] = kind(a) === "line" ? lineEnds(a) : [P(a), P(b)];
        return { size: 1, eval: (x, out) => out.push(p(x)[k] - q(x)[k]) };
      }
      case "parallel":
      case "perpendicular": {
        const d1 = dir(a);
        const d2 = dir(b);
        const cross = con.type === "parallel";
        return {
          size: 1,
          eval: (x, out) => {
            const u = d1(x), w = d2(x);
            const len = Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]) || 1;
            out.push((cross ? u[0] * w[1] - u[1] * w[0] : u[0] * w[0] + u[1] * w[1]) / len);
          },
        };
      }
      case "equal": {
        if (kind(a) === "line" && kind(b) === "line") {
          const d1 = dir(a);
          const d2 = dir(b);
          return { size: 1, eval: (x, out) => { const u = d1(x), w = d2(x); out.push(Math.hypot(u[0], u[1]) - Math.hypot(w[0], w[1])); } };
        }
        const c1 = circular(a);
        const c2 = circular(b);
        return { size: 1, eval: (x, out) => out.push(c1.radius(x) - c2.radius(x)) };
      }
      case "tangent": {
        if (kind(a) === "line" || kind(b) === "line") {
          const [lineId, circId] = kind(a) === "line" ? [a, b] : [b, a];
          const [p, q] = lineEnds(lineId);
          const c = circular(circId);
          // When the line ends on the arc (a slot, a rounded corner), "distance to the line = radius"
          // gives the solver no sense of direction there, so use "line at right angles to the radius
          // where they join" instead.
          const line = sketch.curves.find((k) => k.id === lineId);
          const arc = sketch.curves.find((k) => k.id === circId);
          const joint =
            line?.type === "line" && arc?.type === "arc"
              ? [line.p1, line.p2].find((id) => id === arc.start || id === arc.end)
              : undefined;
          if (joint && line?.type === "line") {
            const J = P(joint);
            const other = P(joint === line.p1 ? line.p2 : line.p1);
            return {
              size: 1,
              eval: (x, out) => {
                const j = J(x), o = other(x), cc = c.centre(x);
                const dx = o[0] - j[0], dy = o[1] - j[1];
                out.push((dx * (j[0] - cc[0]) + dy * (j[1] - cc[1])) / (Math.hypot(dx, dy) || 1));
              },
            };
          }
          return {
            size: 1,
            eval: (x, out) => {
              const pa = p(x), pb = q(x), cc = c.centre(x);
              const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
              const dist = Math.abs(dx * (cc[1] - pa[1]) - dy * (cc[0] - pa[0])) / (Math.hypot(dx, dy) || 1);
              out.push(dist - c.radius(x));
            },
          };
        }
        const c1 = circular(a);
        const c2 = circular(b);
        const internal = (con.extra?.[0] ?? 0) === 1;
        return {
          size: 1,
          eval: (x, out) => {
            const p = c1.centre(x), q = c2.centre(x);
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            const r1 = c1.radius(x), r2 = c2.radius(x);
            out.push(internal ? d - Math.abs(r1 - r2) : d - (r1 + r2));
          },
        };
      }
      case "concentric": {
        const p = circular(a).centre;
        const q = circular(b).centre;
        return { size: 2, eval: (x, out) => { const u = p(x), w = q(x); out.push(u[0] - w[0], u[1] - w[1]); } };
      }
      case "midpoint": {
        const p = P(a);
        const [m, n] = lineEnds(b);
        return {
          size: 2,
          eval: (x, out) => {
            const u = p(x), s = m(x), e = n(x);
            out.push(u[0] - (s[0] + e[0]) / 2, u[1] - (s[1] + e[1]) / 2);
          },
        };
      }
      case "symmetric": {
        // Two points mirror images across a line: halfway between them is on the line, and the line between them is square to it.
        const p = P(a);
        const q = P(b);
        const [m, n] = lineEnds(con.refs[2]);
        return {
          size: 2,
          eval: (x, out) => {
            const u = p(x), w = q(x), s = m(x), e = n(x);
            const dx = e[0] - s[0], dy = e[1] - s[1];
            const len = Math.hypot(dx, dy) || 1;
            const mx = (u[0] + w[0]) / 2, my = (u[1] + w[1]) / 2;
            out.push((dx * (my - s[1]) - dy * (mx - s[0])) / len, ((w[0] - u[0]) * dx + (w[1] - u[1]) * dy) / len);
          },
        };
      }
      case "pointOnLine":
      case "pointLineDistance": {
        const p = P(a);
        const [m, n] = lineEnds(b);
        const signed = con.type === "pointOnLine";
        return {
          size: 1,
          eval: (x, out) => {
            const u = p(x), s = m(x), e = n(x);
            const dx = e[0] - s[0], dy = e[1] - s[1];
            const cross = (dx * (u[1] - s[1]) - dy * (u[0] - s[0])) / (Math.hypot(dx, dy) || 1);
            out.push(signed ? cross : Math.abs(cross) - value);
          },
        };
      }
      case "pointOnCircle": {
        const p = P(a);
        const c = circular(b);
        return {
          size: 1,
          eval: (x, out) => {
            const u = p(x), cc = c.centre(x);
            out.push(Math.hypot(u[0] - cc[0], u[1] - cc[1]) - c.radius(x));
          },
        };
      }
      case "distance": {
        const p = P(a);
        const q = P(b);
        return { size: 1, eval: (x, out) => { const u = p(x), w = q(x); out.push(Math.hypot(u[0] - w[0], u[1] - w[1]) - value); } };
      }
      case "length": {
        const d = dir(a);
        return { size: 1, eval: (x, out) => { const u = d(x); out.push(Math.hypot(u[0], u[1]) - value); } };
      }
      case "horizontalDistance":
      case "verticalDistance": {
        const k = con.type === "horizontalDistance" ? 0 : 1;
        const p = P(a);
        const q = P(b);
        const sign = con.extra?.[0] ?? 1;
        return { size: 1, eval: (x, out) => out.push(sign * (q(x)[k] - p(x)[k]) - value) };
      }
      case "radius":
      case "diameter": {
        const c = circular(a);
        const f = con.type === "diameter" ? 2 : 1;
        return { size: 1, eval: (x, out) => out.push(f * c.radius(x) - value) };
      }
      case "angle": {
        const d1 = dir(a);
        const d2 = dir(b);
        const target = ((con.extra?.[0] ?? 1) * value * Math.PI) / 180;
        return {
          size: 1,
          eval: (x, out) => {
            const u = d1(x), w = d2(x);
            const ang = Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]);
            const diff = ang - target;
            out.push(Math.atan2(Math.sin(diff), Math.cos(diff)));
          },
        };
      }
    }
    return null;
  }

  return { n: init.length, pointVar, radiusVar, x0: Float64Array.from(init), blocks, skipped };
}

function evalAll(sys: System, x: Float64Array): number[] {
  const out: number[] = [];
  for (const b of sys.blocks) b.eval(x, out);
  return out;
}

/** Numerical Jacobian (m × n), central differences. */
function jacobian(sys: System, x: Float64Array, m: number): Float64Array {
  const J = new Float64Array(m * sys.n);
  const xp = Float64Array.from(x);
  for (let j = 0; j < sys.n; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[j]));
    xp[j] = x[j] + h;
    const rp = evalAll(sys, xp);
    xp[j] = x[j] - h;
    const rm = evalAll(sys, xp);
    xp[j] = x[j];
    for (let i = 0; i < m; i++) J[i * sys.n + j] = (rp[i] - rm[i]) / (2 * h);
  }
  return J;
}

/** Solve the square system A y = b (A is k × k, overwritten). Returns null if singular. */
function solveLinear(A: Float64Array, b: Float64Array, k: number): Float64Array | null {
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r * k + col]) > Math.abs(A[piv * k + col])) piv = r;
    if (Math.abs(A[piv * k + col]) < 1e-300) return null;
    if (piv !== col) {
      for (let c = 0; c < k; c++) [A[col * k + c], A[piv * k + c]] = [A[piv * k + c], A[col * k + c]];
      [b[col], b[piv]] = [b[piv], b[col]];
    }
    for (let r = col + 1; r < k; r++) {
      const f = A[r * k + col] / A[col * k + col];
      if (f === 0) continue;
      for (let c = col; c < k; c++) A[r * k + c] -= f * A[col * k + c];
      b[r] -= f * b[col];
    }
  }
  const y = new Float64Array(k);
  for (let r = k - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < k; c++) s -= A[r * k + c] * y[c];
    y[r] = s / A[r * k + r];
  }
  return y;
}

const norm2 = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
const maxAbs = (r: number[]) => r.reduce((s, v) => Math.max(s, Math.abs(v)), 0);

/** Residuals below this count as satisfied (mm, or radians for angles). */
export const SOLVE_TOLERANCE = 1e-7;

export interface SolveOptions {
  /** Pull a point to a position (dragging). Its coordinates are preferred to stay put while others adjust. */
  drag?: { pointId: string; x: number; y: number };
  /** Move these points rigidly by (dx, dy) first (dragging a whole line or circle). */
  moveRigid?: { pointIds: string[]; dx: number; dy: number };
  /** Resize this circle first (dragging its rim). */
  resize?: { circleId: string; radius: number };
  maxIterations?: number;
}

export interface SolveResult {
  sketch: SketchData;
  /** True when every constraint is satisfied. */
  ok: boolean;
  /** Constraints that aren't satisfied (conflicts), or couldn't be used. */
  failing: string[];
  skipped: Map<string, string>;
  maxResidual: number;
}

function writeBack(sketch: SketchData, sys: System, x: Float64Array): SketchData {
  return {
    ...sketch,
    points: sketch.points.map((p) => {
      const i = sys.pointVar.get(p.id)!;
      return x[i] === p.x && x[i + 1] === p.y ? p : { ...p, x: x[i], y: x[i + 1] };
    }),
    curves: sketch.curves.map((c) => {
      if (c.type !== "circle") return c;
      const r = x[sys.radiusVar.get(c.id)!];
      return r === c.radius ? c : { ...c, radius: r };
    }),
  };
}

/** Move the sketch so every constraint holds, changing it as little as possible. */
export function solveSketch(sketch: SketchData, options: SolveOptions = {}): SolveResult {
  const interactive = options.drag || options.moveRigid || options.resize;
  if (!interactive) return solveOnce(sketch, options, 1);
  // First try to keep what's being dragged exactly under the pointer; if the
  // constraints make that impossible, let it give way as little as possible.
  const exact = solveOnce(sketch, options, 1e4);
  return exact.ok ? exact : solveOnce(sketch, options, 30);
}

function solveOnce(sketch: SketchData, options: SolveOptions, stiffness: number): SolveResult {
  const sys = buildSystem(sketch);
  const x = Float64Array.from(sys.x0);
  // Column weights: larger = the solver prefers not to move that unknown.
  const weight = new Float64Array(sys.n).fill(1);

  if (options.moveRigid) {
    for (const id of options.moveRigid.pointIds) {
      const i = sys.pointVar.get(id);
      if (i === undefined) continue;
      x[i] += options.moveRigid.dx;
      x[i + 1] += options.moveRigid.dy;
      weight[i] = weight[i + 1] = stiffness;
    }
  }
  if (options.resize) {
    const i = sys.radiusVar.get(options.resize.circleId);
    if (i !== undefined) {
      x[i] = options.resize.radius;
      weight[i] = stiffness;
    }
  }
  if (options.drag) {
    const i = sys.pointVar.get(options.drag.pointId);
    if (i !== undefined) {
      x[i] = options.drag.x;
      x[i + 1] = options.drag.y;
      weight[i] = weight[i + 1] = stiffness;
    }
  }

  let r = evalAll(sys, x);
  const m = r.length;
  const maxIterations = options.maxIterations ?? 60;
  for (let iter = 0; iter < maxIterations && maxAbs(r) > SOLVE_TOLERANCE * 0.01; iter++) {
    const J = jacobian(sys, x, m);
    // Weighted minimum-norm step: Δ = -W⁻² Jᵀ (J W⁻² Jᵀ + λI)⁻¹ r
    const A = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      for (let k = i; k < m; k++) {
        let s = 0;
        for (let j = 0; j < sys.n; j++) s += (J[i * sys.n + j] * J[k * sys.n + j]) / (weight[j] * weight[j]);
        A[i * m + k] = A[k * m + i] = s;
      }
    }
    let trace = 0;
    for (let i = 0; i < m; i++) trace += A[i * m + i];
    const lambda = 1e-10 * (trace / Math.max(m, 1)) + 1e-14;
    for (let i = 0; i < m; i++) A[i * m + i] += lambda;
    const y = solveLinear(A, Float64Array.from(r), m);
    if (!y) break;
    const step = new Float64Array(sys.n);
    for (let j = 0; j < sys.n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i * sys.n + j] * y[i];
      step[j] = -s / (weight[j] * weight[j]);
    }
    // Backtracking: accept the largest step that reduces the error.
    const before = norm2(r);
    let alpha = 1;
    let accepted = false;
    const trial = new Float64Array(sys.n);
    for (let tries = 0; tries < 12; tries++) {
      for (let j = 0; j < sys.n; j++) trial[j] = x[j] + alpha * step[j];
      const rt = evalAll(sys, trial);
      if (norm2(rt) < before) {
        x.set(trial);
        r = rt;
        accepted = true;
        break;
      }
      alpha /= 2;
    }
    if (!accepted) break;
  }

  // Report which constraints are still unsatisfied.
  const failing = new Set<string>(sys.skipped.keys());
  let offset = 0;
  for (const b of sys.blocks) {
    const part = r.slice(offset, offset + b.size);
    offset += b.size;
    if (b.id && maxAbs(part) > SOLVE_TOLERANCE * 100) failing.add(b.id);
  }
  const maxResidual = maxAbs(r);
  return {
    sketch: writeBack(sketch, sys, x),
    ok: maxResidual <= SOLVE_TOLERANCE * 100 && sys.skipped.size === 0,
    failing: [...failing],
    skipped: sys.skipped,
    maxResidual,
  };
}

// ---------------------------------------------------------------------------
// Degrees of freedom

export interface SketchAnalysis {
  /** How many independent ways the sketch can still move or resize. 0 = fully defined. */
  freedom: number;
  /** Points whose position is completely pinned down. */
  definedPoints: Set<string>;
  /** Curves whose position and size are completely pinned down. */
  definedCurves: Set<string>;
}

/**
 * Works out what is still free to move. Uses the constraint equations'
 * Jacobian: a point is fixed when no remaining freedom can move it.
 */
export function analyzeSketch(sketch: SketchData): SketchAnalysis {
  const sys = buildSystem(sketch);
  const r = evalAll(sys, sys.x0);
  const m = r.length;
  const n = sys.n;
  const definedPoints = new Set<string>([ORIGIN_ID]);
  const definedCurves = new Set<string>();
  if (n === 0) return { freedom: 0, definedPoints, definedCurves };

  // Row-reduce J (full pivoting) to find its rank and null space.
  const J = m > 0 ? jacobian(sys, sys.x0, m) : new Float64Array(0);
  const A = Array.from({ length: m }, (_, i) => Array.from(J.subarray(i * n, (i + 1) * n)));
  const scale = J.reduce((s, v) => Math.max(s, Math.abs(v)), 0) || 1;
  const tol = 1e-7 * scale;
  const pivotCols: number[] = [];
  let row = 0;
  const used = new Array<boolean>(n).fill(false);
  while (row < m) {
    // Pick the largest remaining entry among unused columns.
    let best = 0;
    let br = -1;
    let bc = -1;
    for (let i = row; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const v = Math.abs(A[i][j]);
        if (v > best) {
          best = v;
          br = i;
          bc = j;
        }
      }
    }
    if (best <= tol) break;
    [A[row], A[br]] = [A[br], A[row]];
    const pv = A[row][bc];
    for (let j = 0; j < n; j++) A[row][j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = A[i][bc];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) A[i][j] -= f * A[row][j];
    }
    used[bc] = true;
    pivotCols.push(bc);
    row++;
  }
  const freeCols = [...Array(n).keys()].filter((j) => !used[j]);
  // A variable is determined when every null-space vector has a zero in it.
  const determined = new Array<boolean>(n).fill(true);
  for (const f of freeCols) {
    determined[f] = false;
    pivotCols.forEach((pc, k) => {
      if (Math.abs(A[k][f]) > 1e-6) determined[pc] = false;
    });
  }

  for (const [id, i] of sys.pointVar) if (determined[i] && determined[i + 1]) definedPoints.add(id);
  for (const c of sketch.curves) {
    const ok =
      c.type === "line"
        ? definedPoints.has(c.p1) && definedPoints.has(c.p2)
        : c.type === "circle"
          ? definedPoints.has(c.center) && determined[sys.radiusVar.get(c.id)!]
          : definedPoints.has(c.center) && definedPoints.has(c.start) && definedPoints.has(c.end);
    if (ok) definedCurves.add(c.id);
  }
  return { freedom: freeCols.length, definedPoints, definedCurves };
}
