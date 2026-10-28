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
import { bezierAt, bezierD1, bezierD2, splineBeziers } from "./spline";
import { curvatureAt, curveParam, nearestParam, offsetAt, wrapParam, offsetError, offsetParams as fitParams, offsetPieces, OFFSET_TOLERANCE, splineThrough, tightestBend, type CurveParam } from "./curves";

type Bez = [Vec, Vec, Vec, Vec];
import { ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData, type SketchEllipse, type SketchSpline } from "./types";

type Vec = [number, number];

/** A block of residuals (without its constraint id). */
type Block = Omit<System["blocks"][number], "id">;

interface System {
  n: number;
  /** Variable index for each point's x (y is +1), and each circle's radius. */
  pointVar: Map<string, number>;
  radiusVar: Map<string, number>;
  x0: Float64Array;
  /** Residual blocks: one per constraint (plus hidden arc constraints). */
  blocks: {
    id: string | null;
    size: number;
    eval: (x: Float64Array, out: number[]) => void;
    /** Run once at the start of each solver step (before its Jacobian); true if the block's answers there changed. */
    prepare?: (x: Float64Array) => boolean;
  }[];
  /** Constraints that couldn't be used (e.g. a dimension with an invalid value), with the reason. */
  skipped: Map<string, string>;
  /**
   * Has blocks that search along splines or ellipses each time they're worked out (a touching Tangent, a
   * Normal to one). These are costly, so a solve that has stopped getting anywhere is given up early.
   */
  searching: boolean;
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
  /** The centre of a circle, arc or ellipse. */
  const centreOf = (id: string) => {
    const c = curves.get(id);
    if (c?.type === "ellipse") return P(c.center);
    return circular(id).centre;
  };
  const circular = (id: string) => {
    const c = curves.get(id);
    if (!c || c.type === "line" || c.type === "spline" || c.type === "ellipse") throw new Error(`${id} is not a circle or arc`);
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
  let searching = false;
  const pending: Block[] = [];

  /**
   * A spline's Bézier pieces for the current unknowns, worked out once and
   * shared by every point held on it (re-worked only when its points move).
   */
  const pieceCache = new Map<string, (x: Float64Array) => Bez[]>();
  const splinePieces = (id: string) => {
    const known = pieceCache.get(id);
    if (known) return known;
    const curve = curves.get(id);
    if (curve?.type !== "spline") throw new Error(`${id} is not a spline`);
    const ids = curve.points.map((pid) => P(pid));
    const handles = curve.points.map((pid) => curve.tangents?.[pid]);
    const handlesIn = curve.points.map((pid) => curve.tangentsIn?.[pid]);
    let lastKey: number[] = [];
    let last: Bez[] = [];
    const get = (x: Float64Array) => {
      const pts = ids.map((f) => f(x));
      const key = pts.flat();
      if (key.length !== lastKey.length || key.some((v, i) => v !== lastKey[i])) {
        lastKey = key;
        last = splineBeziers(pts, curve.closed, curve.conic, handles, handlesIn);
      }
      return last;
    };
    pieceCache.set(id, get);
    return get;
  };

  /** Any curve as a path walked by its parameter (see curves.ts), for the current unknowns. */
  const paramFn = (id: string): ((x: Float64Array) => CurveParam) => {
    const c = curves.get(id);
    if (!c) throw new Error(`missing curve ${id}`);
    const ids = curvePointIds(c);
    const ri = c.type === "circle" ? radiusVar.get(c.id)! : -1;
    // The same curve is asked for over and over while only other unknowns change (Jacobian columns): reuse it
    // while its own points (and radius) are unchanged.
    // Which unknowns hold its points (−1 for the origin) and radius, compared directly (no copying) to the last time.
    const vars = ids.flatMap((pid) => (pid === ORIGIN_ID ? [-1, -1] : [pointVar.get(pid)!, pointVar.get(pid)! + 1]));
    if (ri >= 0) vars.push(ri);
    const lastKey = new Float64Array(vars.length);
    let last: CurveParam | null = null;
    return (x) => {
      if (last) {
        let same = true;
        for (let i = 0; i < vars.length && same; i++) same = (vars[i] < 0 ? 0 : x[vars[i]]) === lastKey[i];
        if (same) return last;
      }
      for (let i = 0; i < vars.length; i++) lastKey[i] = vars[i] < 0 ? 0 : x[vars[i]];
      const points = ids.map((pid, i) => ({ id: pid, x: lastKey[2 * i], y: lastKey[2 * i + 1] }));
      last = curveParam({ points, curves: [], constraints: [] }, c.type === "circle" ? { ...c, radius: x[ri] } : c);
      return last;
    };
  };

  /**
   * The one Bézier piece of a spline that parameter u is on, as a path (lo = its index), worked out exactly as
   * splineBeziers does but reading only the points it depends on (that piece's ends and their neighbours).
   */
  const splinePieceParam = (c: SketchSpline, u: number): ((x: Float64Array) => CurveParam) => {
    const n = c.points.length;
    const m = c.closed ? n : n - 1;
    const k = Math.max(0, Math.min(m - 1, Math.floor(u)));
    const at = (i: number) => P(c.points[c.closed ? ((i % n) + n) % n : i]);
    const pointAt = (x: Float64Array, i: number): Vec => {
      if (c.closed) return at(i)(x);
      if (i < 0) {
        const a = at(0)(x), b = at(1)(x);
        return [2 * a[0] - b[0], 2 * a[1] - b[1]];
      }
      if (i >= n) {
        const a = at(n - 1)(x), b = at(n - 2)(x);
        return [2 * a[0] - b[0], 2 * a[1] - b[1]];
      }
      return at(i)(x);
    };
    const idOf = (i: number) => c.points[c.closed ? ((i % n) + n) % n : i];
    const tangent = (x: Float64Array, i: number): Vec => {
      const set = c.tangents?.[idOf(i)];
      if (set) return set;
      const a = pointAt(x, i + 1), b = pointAt(x, i - 1);
      return [(a[0] - b[0]) / 2, (a[1] - b[1]) / 2];
    };
    return (x) => {
      const j = c.closed ? (k + 1) % n : k + 1;
      const p1 = at(k)(x), p2 = at(j)(x);
      const t1 = tangent(x, k);
      const t2 = c.tangentsIn?.[idOf(j)] ?? tangent(x, c.closed ? j : k + 1);
      const b: Bez = [p1, [p1[0] + t1[0] / 3, p1[1] + t1[1] / 3], [p2[0] - t2[0] / 3, p2[1] - t2[1] / 3], p2];
      const d1 = (v: number) => bezierD1(b, v - k), d2 = (v: number) => bezierD2(b, v - k);
      return { lo: k, hi: k + 1, closed: false, at: (v) => bezierAt(b, v - k), d1, d2, before: (v) => ({ d1: d1(v), d2: d2(v) }), samples: [k, k + 1] };
    };
  };

  /** Ellipse "distance": zero on it, smooth either side (roughly mm). */
  const ellipseLevel = (cen: (x: Float64Array) => Vec, ma: (x: Float64Array) => Vec, mi: (x: Float64Array) => Vec) => (x: Float64Array, u: Vec) => {
    const c = cen(x), m = ma(x), n = mi(x);
    const ax = [m[0] - c[0], m[1] - c[1]];
    const rx = Math.hypot(ax[0], ax[1]) || 1e-12;
    const ry = Math.hypot(n[0] - c[0], n[1] - c[1]) || 1e-12;
    const q = [u[0] - c[0], u[1] - c[1]];
    const along = (q[0] * ax[0] + q[1] * ax[1]) / rx;
    const across = (q[1] * ax[0] - q[0] * ax[1]) / rx;
    return (Math.hypot(along / rx, across / ry) - 1) * Math.min(rx, ry);
  };

  /**
   * A function that's zero exactly on a curve (and changes smoothly across
   * it): the signed distance to a line (carried on) or spline, the distance
   * from a circle's rim, or the ellipse measure above.
   */
  const levelFn = (id: string): ((x: Float64Array, p: Vec) => number) => {
    const c = curves.get(id);
    if (!c) throw new Error(`missing curve ${id}`);
    if (c.type === "line") {
      const [m, n] = lineEnds(id);
      return (x, u) => {
        const s0 = m(x), e = n(x);
        const dx = e[0] - s0[0], dy = e[1] - s0[1];
        return (dx * (u[1] - s0[1]) - dy * (u[0] - s0[0])) / (Math.hypot(dx, dy) || 1);
      };
    }
    if (c.type === "circle" || c.type === "arc") {
      const k = circular(id);
      return (x, u) => {
        const cc = k.centre(x);
        return Math.hypot(u[0] - cc[0], u[1] - cc[1]) - k.radius(x);
      };
    }
    if (c.type === "ellipse") return ellipseLevel(P(c.center), P(c.major), P(c.minor));
    const pieces = splinePieces(id);
    return (x, u) => signedDistanceToBeziers(u, pieces(x));
  };

  /** The ends of a curve (where another can join it): line, arc, open spline or part of an ellipse. */
  const endsOf = (c: SketchCurve): string[] =>
    c.type === "line" ? [c.p1, c.p2] : c.type === "arc" ? [c.start, c.end] : c.type === "spline" ? (c.closed ? [] : [c.points[0], c.points[c.points.length - 1]]) : c.type === "ellipse" && c.start && c.end ? [c.start, c.end] : [];
  /** Points lying on a curve that another curve can join it at: its ends, or a spline's own points. */
  const joinsOf = (c: SketchCurve): string[] => (c.type === "spline" && c.conic === undefined ? c.points : endsOf(c));

  /**
   * Which way a curve runs at one of its own points, and how it bends there,
   * walking away from that point (into the curve).
   */
  const frameAt = (id: string, pointId: string): ((x: Float64Array) => { dir: Vec; bend: number }) => {
    const c = curves.get(id)!;
    if (c.type === "line") {
      const J = P(pointId), O = P(pointId === c.p1 ? c.p2 : c.p1);
      return (x) => {
        const j = J(x), o = O(x);
        return { dir: [o[0] - j[0], o[1] - j[1]], bend: 0 };
      };
    }
    if (c.type === "arc") {
      const k = circular(id);
      const J = P(pointId);
      const fromStart = pointId === c.start ? 1 : -1;
      return (x) => {
        const j = J(x), cc = k.centre(x);
        // Anticlockwise from the start; clockwise walking away from the end.
        return { dir: [-(j[1] - cc[1]) * fromStart, (j[0] - cc[0]) * fromStart], bend: fromStart / (k.radius(x) || 1e-12) };
      };
    }
    const param = paramFn(id);
    const J = P(pointId);
    if (c.type === "spline") {
      const i = c.points.indexOf(pointId);
      const last = !c.closed && i === c.points.length - 1;
      return (x) => {
        const p = param(x);
        const u = c.conic !== undefined ? (i === 0 ? 0 : 1) : Math.min(i, p.hi);
        const d = p.d1(u);
        return last ? { dir: [-d[0], -d[1]], bend: -curvatureAt(p, u) } : { dir: d, bend: curvatureAt(p, u) };
      };
    }
    // Part of an ellipse: at its start or end (or, for a whole one, wherever the point is).
    const el = c as SketchEllipse;
    const atEnd = pointId === el.end && pointId !== el.start;
    const atStart = pointId === el.start;
    return (x) => {
      const p = param(x);
      const u = atEnd ? p.hi : atStart ? p.lo : nearestParam(p, J(x));
      const d = p.d1(u);
      return atEnd ? { dir: [-d[0], -d[1]], bend: -curvatureAt(p, u) } : { dir: d, bend: curvatureAt(p, u) };
    };
  };

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

  // Every ellipse keeps its two axes square to each other.
  for (const c of sketch.curves) {
    if (c.type !== "ellipse") continue;
    const cen = P(c.center);
    const ma = P(c.major);
    const mi = P(c.minor);
    blocks.push({
      id: null,
      size: 1,
      eval: (x, out) => {
        const [cx, cy] = cen(x);
        const [ax, ay] = ma(x);
        const [bx, by] = mi(x);
        const u: Vec = [ax - cx, ay - cy];
        const w: Vec = [bx - cx, by - cy];
        // Scaled to millimetres, so it weighs the same as the other constraints.
        out.push((u[0] * w[0] + u[1] * w[1]) / (Math.hypot(...u) + Math.hypot(...w) || 1));
      },
    });
    // Part of an ellipse keeps its ends on it.
    if (c.start && c.end) {
      const level = ellipseLevel(cen, ma, mi);
      const st = P(c.start), en = P(c.end);
      blocks.push({ id: null, size: 2, eval: (x, out) => out.push(level(x, st(x)), level(x, en(x))) });
    }
  }

  for (const con of sketch.constraints) {
    // Reference dimensions only show a size; they never move anything.
    if (con.driven) continue;
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
      pending.length = 0;
      const block = makeBlock(con, value, a, b);
      if (block) blocks.push({ id: con.id, ...block });
      // Some constraints are many small blocks (an offset spline: one per point), so a Jacobian column only re-runs the ones it touches.
      for (const extra of pending) blocks.push({ id: con.id, ...extra });
    } catch (e) {
      skipped.set(con.id, e instanceof Error ? e.message : String(e));
    }
  }

  function makeBlock(
    con: SketchConstraint,
    value: number,
    a: string,
    b: string,
  ): Block | null {
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
        const wavy = (k: string) => k === "spline" || k === "ellipse";
        if (wavy(kind(a)) || wavy(kind(b))) return tangentBlock(a, b);
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
        const p = centreOf(a);
        const q = centreOf(b);
        return { size: 2, eval: (x, out) => { const u = p(x), w = q(x); out.push(u[0] - w[0], u[1] - w[1]); } };
      }
      case "midpoint": {
        const p = P(a);
        if (con.refs.length === 3) {
          // Halfway between two points.
          const m = P(b), n = P(con.refs[2]);
          return {
            size: 2,
            eval: (x, out) => {
              const u = p(x), s0 = m(x), e = n(x);
              out.push(u[0] - (s0[0] + e[0]) / 2, u[1] - (s0[1] + e[1]) / 2);
            },
          };
        }
        const arc = curves.get(b);
        if (arc?.type === "arc") {
          // Halfway round the arc (anticlockwise from its start to its end).
          const cen = P(arc.center), st = P(arc.start), en = P(arc.end);
          return {
            size: 2,
            eval: (x, out) => {
              const u = p(x), c = cen(x), s0 = st(x), e = en(x);
              const a0 = Math.atan2(s0[1] - c[1], s0[0] - c[0]);
              let sweep = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0;
              while (sweep <= 0) sweep += 2 * Math.PI;
              while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
              const r = Math.hypot(s0[0] - c[0], s0[1] - c[1]);
              const am = a0 + sweep / 2;
              out.push(u[0] - (c[0] + r * Math.cos(am)), u[1] - (c[1] + r * Math.sin(am)));
            },
          };
        }
        const [m, n] = lineEnds(b);
        return {
          size: 2,
          eval: (x, out) => {
            const u = p(x), s = m(x), e = n(x);
            out.push(u[0] - (s[0] + e[0]) / 2, u[1] - (s[1] + e[1]) / 2);
          },
        };
      }
      case "patternMove": {
        // The copy is the original moved a set distance: along a line, or at a set angle.
        const p = P(a), q = P(b);
        const [dist, deg] = [con.extra?.[0] ?? 0, con.extra?.[1] ?? 0];
        const along = con.refs[2] ? dir(con.refs[2]) : null;
        const fixed: Vec = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
        return {
          size: 2,
          eval: (x, out) => {
            const u = p(x), w = q(x);
            let d = fixed;
            if (along) {
              const v = along(x);
              const l = Math.hypot(v[0], v[1]) || 1;
              d = [v[0] / l, v[1] / l];
            }
            out.push(u[0] - (w[0] + d[0] * dist), u[1] - (w[1] + d[1] * dist));
          },
        };
      }
      case "normal": {
        // A line square to a curve where they meet.
        const [m, n] = lineEnds(a);
        const other = curves.get(b);
        if (!other || other.type === "line") throw new Error("Normal needs a line and a curve");
        if (other.type === "circle" || other.type === "arc") {
          // Square to a circle: the line (carried on) goes through its centre.
          const c = circular(b).centre;
          return {
            size: 1,
            eval: (x, out) => {
              const u = c(x), s0 = m(x), e = n(x);
              const dx = e[0] - s0[0], dy = e[1] - s0[1];
              out.push((dx * (u[1] - s0[1]) - dy * (u[0] - s0[0])) / (Math.hypot(dx, dy) || 1));
            },
          };
        }
        const end = con.extra?.[0] === 1 ? n : m;
        const param = paramFn(b);
        searching = true;
        // Remembers where along the curve the line's end was nearest last time and starts from there (a few Newton
        // steps instead of searching the whole curve); searches again only if that fails.
        let lastU: number | null = null;
        return {
          size: 1,
          eval: (x, out) => {
            const s0 = m(x), e = n(x);
            const pth = param(x);
            const q = end(x);
            let u = lastU === null ? null : nearestFrom(pth, q, lastU);
            if (u === null) u = nearestParam(pth, q);
            lastU = u;
            const t = pth.d1(u);
            const dx = e[0] - s0[0], dy = e[1] - s0[1];
            out.push((dx * t[0] + dy * t[1]) / ((Math.hypot(dx, dy) || 1) * (Math.hypot(t[0], t[1]) || 1)));
          },
        };
      }
      case "curvature": {
        // Meeting smoothly (one row) and bending the same amount (another) where they join.
        const joint = con.refs[2];
        const fa = frameAt(a, joint), fb = frameAt(b, joint);
        return {
          size: 2,
          eval: (x, out) => {
            const A = fa(x), B = fb(x);
            const la = Math.hypot(A.dir[0], A.dir[1]) || 1, lb = Math.hypot(B.dir[0], B.dir[1]) || 1;
            out.push((A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0]) / (la * lb), A.bend + B.bend);
          },
        };
      }
      case "patternCopy": {
        // The copy is the original turned round the centre by a set angle.
        const p = P(a), q = P(b), c = P(con.refs[2]);
        const t = ((con.extra?.[0] ?? 0) * Math.PI) / 180;
        const cs = Math.cos(t), sn = Math.sin(t);
        return {
          size: 2,
          eval: (x, out) => {
            const u = p(x), w = q(x), o = c(x);
            const dx = w[0] - o[0], dy = w[1] - o[1];
            out.push(u[0] - (o[0] + dx * cs - dy * sn), u[1] - (o[1] + dx * sn + dy * cs));
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
      case "pointOnCurve": {
        const p = P(a);
        const curve = curves.get(b);
        if (curve?.type === "ellipse") {
          const cen = P(curve.center), ma = P(curve.major), mi = P(curve.minor);
          return {
            size: 1,
            eval: (x, out) => {
              const u = p(x), c = cen(x), m = ma(x), n = mi(x);
              const ax = [m[0] - c[0], m[1] - c[1]];
              const rx = Math.hypot(ax[0], ax[1]) || 1e-12;
              const ry = Math.hypot(n[0] - c[0], n[1] - c[1]) || 1e-12;
              const q = [u[0] - c[0], u[1] - c[1]];
              const along = (q[0] * ax[0] + q[1] * ax[1]) / rx;
              const across = (q[1] * ax[0] - q[0] * ax[1]) / rx;
              // Roughly the distance (mm) to the ellipse: zero on it, and smooth either side.
              out.push((Math.hypot(along / rx, across / ry) - 1) * Math.min(rx, ry));
            },
          };
        }
        if (curve?.type === "spline") {
          const pieces = splinePieces(curve.id);
          return { size: 1, eval: (x, out) => out.push(signedDistanceToBeziers(p(x), pieces(x))) };
        }
        throw new Error(`${b} is not a spline or ellipse`);
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
      case "offset": {
        // Each [copy, original] pair stays `value` apart: a line's distance from the original line, an arc's or circle's radius from the original's.
        // Each pair's side (extra): a signed distance, so a copy can't flip over to the other side of its original.
        const pairs: ((x: Float64Array, out: number[]) => void)[] = [];
        let size = 0;
        for (let i = 0; i + 1 < con.refs.length; i += 2) {
          const [copy, orig] = [con.refs[i], con.refs[i + 1]];
          const side = con.extra?.[i / 2];
          const signed = (v: number) => (side === undefined ? Math.abs(v) : side * v);
          const copyCurve = curves.get(copy);
          if (copyCurve?.type === "spline" && (kind(orig) === "spline" || kind(orig) === "ellipse")) {
            // A spline following a spline or ellipse: each of its points sits that far from the original, square to it, at its own place along it.
            const us = copyCurve.offsetParams;
            if (!us || us.length !== copyCurve.points.length) throw new Error("offset copy has lost its places along the original");
            const pts = copyCurve.points.map((id) => P(id));
            const param = paramFn(orig);
            const dist = side ?? 1;
            searching = true;
            const origCurve = curves.get(orig)!;
            us.forEach((u, k) => {
              // Along a spline, only the piece the place is on (it reads just the points near it), so moving a far
              // point of the original doesn't re-run this block.
              const local = origCurve.type === "spline" && origCurve.conic === undefined ? splinePieceParam(origCurve, u) : null;
              pending.push({
                size: 2,
                eval: (x, out) => {
                  const want = offsetAt(local ? local(x) : param(x), u, dist * value).at;
                  const got = pts[k](x);
                  out.push(got[0] - want[0], got[1] - want[1]);
                },
              });
            });
          } else if (kind(copy) === "line" && kind(orig) === "line") {
            const [p] = lineEnds(copy);
            const [m, n] = lineEnds(orig);
            pairs.push((x, out) => {
              const u = p(x), s0 = m(x), e = n(x);
              const dx = e[0] - s0[0], dy = e[1] - s0[1];
              out.push(signed((dx * (u[1] - s0[1]) - dy * (u[0] - s0[0])) / (Math.hypot(dx, dy) || 1)) - value);
            });
            size++;
          } else {
            const c1 = circular(copy);
            const c2 = circular(orig);
            pairs.push((x, out) => out.push(signed(c1.radius(x) - c2.radius(x)) - value));
            size++;
          }
        }
        if (!pairs.length && !pending.length) throw new Error("offset has nothing to measure");
        return pairs.length ? { size, eval: (x, out) => { for (const f of pairs) f(x, out); } } : null;
      }
      case "arcLength":
      case "arcAngle": {
        const arc = curves.get(a);
        if (arc?.type !== "arc") throw new Error(`${a} is not an arc`);
        const cen = P(arc.center), st = P(arc.start), en = P(arc.end);
        const target = con.type === "arcAngle" ? (value * Math.PI) / 180 : value;
        return {
          size: 1,
          eval: (x, out) => {
            const c = cen(x), s0 = st(x), e = en(x);
            let sweep = Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s0[1] - c[1], s0[0] - c[0]);
            while (sweep <= 0) sweep += 2 * Math.PI;
            while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
            const r = Math.hypot(s0[0] - c[0], s0[1] - c[1]);
            out.push(con.type === "arcAngle" ? (sweep - target) * Math.max(r, 1) : r * sweep - target);
          },
        };
      }
      case "rimDistance": {
        const ra = circular(a);
        const mode = con.extra?.[0] ?? -1;
        const inside = con.extra?.[1] === 1;
        if (kind(b) === "line") {
          const [m, n] = lineEnds(b);
          return {
            size: 1,
            eval: (x, out) => {
              const u = ra.centre(x), s0 = m(x), e = n(x);
              const dx = e[0] - s0[0], dy = e[1] - s0[1];
              const h = Math.abs((dx * (u[1] - s0[1]) - dy * (u[0] - s0[0])) / (Math.hypot(dx, dy) || 1));
              out.push(h + mode * ra.radius(x) - value);
            },
          };
        }
        const rb = circular(b);
        return {
          size: 1,
          eval: (x, out) => {
            const p = ra.centre(x), q = rb.centre(x);
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            const r1 = ra.radius(x), r2 = rb.radius(x);
            const gap = mode > 0 ? d + r1 + r2 : inside ? Math.abs(r1 - r2) - d : d - r1 - r2;
            out.push(gap - value);
          },
        };
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
        // Which way along each line the measured angle opens (see angleRays in ops.ts).
        const s1 = con.extra?.[1] ?? 1;
        const s2 = con.extra?.[2] ?? 1;
        return {
          size: 1,
          eval: (x, out) => {
            const u0 = d1(x), w0 = d2(x);
            const u = [u0[0] * s1, u0[1] * s1], w = [w0[0] * s2, w0[1] * s2];
            const ang = Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]);
            const diff = ang - target;
            out.push(Math.atan2(Math.sin(diff), Math.cos(diff)));
          },
        };
      }
    }
    return null;
  }

  /**
   * Tangent where a spline or ellipse is involved. Where the two share a
   * point (one's end on the other), they run the same way there. Otherwise
   * they touch somewhere: along the spline or ellipse, the other curve's
   * "distance" has a low or high point that is exactly zero.
   */
  function tangentBlock(a: string, b: string): Block {
    const ca = curves.get(a)!, cb = curves.get(b)!;
    const unitCross = (A: Vec, B: Vec) => (A[0] * B[1] - A[1] * B[0]) / ((Math.hypot(A[0], A[1]) || 1) * (Math.hypot(B[0], B[1]) || 1));
    const sameWay = (fa: (x: Float64Array) => Vec, fb: (x: Float64Array) => Vec) => ({ size: 1, eval: (x: Float64Array, out: number[]) => out.push(unitCross(fa(x), fb(x))) });
    const frameDir = (id: string, pointId: string) => {
      const f = frameAt(id, pointId);
      return (x: Float64Array) => f(x).dir;
    };
    // They meet where one ends on the other: the same point, ...
    const shared = endsOf(ca).find((p) => joinsOf(cb).includes(p)) ?? endsOf(cb).find((p) => joinsOf(ca).includes(p));
    if (shared) return sameWay(frameDir(a, shared), frameDir(b, shared));
    // ... two points joined with Coincident, ...
    const joined = (one: SketchCurve, two: SketchCurve) => {
      for (const k of sketch.constraints) {
        if (k.type !== "coincident" || k.driven) continue;
        const [p, q] = k.refs;
        if (endsOf(one).includes(p) && joinsOf(two).includes(q)) return [p, q] as const;
        if (endsOf(one).includes(q) && joinsOf(two).includes(p)) return [q, p] as const;
      }
      return null;
    };
    const ab = joined(ca, cb);
    if (ab) return sameWay(frameDir(a, ab[0]), frameDir(b, ab[1]));
    const ba = joined(cb, ca);
    if (ba) return sameWay(frameDir(a, ba[1]), frameDir(b, ba[0]));
    // ... or one's end held on the other: the same way as the other runs there.
    // (Applying Tangent holds an end that merely lies on the other curve there first: see ops.ts.)
    const heldOn = (one: SketchCurve, two: SketchCurve) =>
      endsOf(one).find((p) => sketch.constraints.some((k) => (k.type === "pointOnLine" || k.type === "pointOnCircle" || k.type === "pointOnCurve") && k.refs[0] === p && k.refs[1] === two.id));
    for (const [one, two] of [[ca, cb], [cb, ca]] as const) {
      const end = heldOn(one, two);
      if (!end) continue;
      const fOne = frameDir(one.id, end);
      const along = dirNear(two.id);
      const at = P(end);
      return sameWay(fOne, (x) => along(x, at(x)));
    }
    // Otherwise they touch somewhere: walk along the spline (or the ellipse, if there's no spline); measure from the other.
    const walkId = ca.type === "spline" ? a : cb.type === "spline" ? b : ca.type === "ellipse" ? a : b;
    const otherId = walkId === a ? b : a;
    const param = paramFn(walkId);
    const otherParam = paramFn(otherId);
    const level = levelFn(otherId);
    const lineOther = curves.get(otherId)!.type === "line";
    searching = true;
    // NOTE: this block remembers state. `last` is where they touched (u along the walked curve, v along the
    // other) the previous time it was evaluated; each evaluation starts its Newton steps from there, which is far
    // cheaper than searching the whole curve each time. The value it returns is still the exact gap at that
    // touching place (found to ~1e-14), so it doesn't depend on the history unless the curves touch in more than
    // one place and Newton lands on a different one; if Newton fails, it searches again and remembers anew.
    let last: [number, number] | null = null;
    // The whole-curve search is slow, so it isn't run for every evaluation (each Jacobian column would run it):
    // only once per solver step (`prepare`, at the step's starting point), and once before the first step.
    let seed: [number, number] | null = null;
    let searchedOnce = false;
    // Whole-curve searches left in this step, and the end used when there's no low or high point.
    let searchesLeft = 3;
    let endU: number | null = null;
    // The low or high point of the other's "distance" along this one that the last search found (kept even when
    // Newton can't make it a touching place): the fallback below follows it.
    let extreme: { u: number; high: boolean; half: number; v: number } | null = null;
    const search = (x: Float64Array, p: CurveParam, q: CurveParam): [number, number] | null => {
      // The low or high point of the other's "distance" along this one, then the nearest place on the other.
      let hit: { u: number; high: boolean; half: number } | null = null;
      touchGap(p, (pt) => level(x, pt), (u, high, half) => (hit = { u, high, half }));
      extreme = null;
      if (!hit) return null;
      const h = hit as { u: number; high: boolean; half: number };
      seed = [h.u, nearestParam(q, p.at(h.u))];
      extreme = { ...h, v: seed[1] };
      return touchPoint(p, q, seed[0], seed[1], lineOther);
    };
    return {
      // Two rows: the gap, and (only while they can meet just at an end) how far off running the same way they are.
      size: 2,
      prepare: (x) => {
        searchesLeft = 3;
        const p = param(x), q = otherParam(x);
        if (last && touchPoint(p, q, last[0], last[1], lineOther)) return false;
        const found = search(x, p, q);
        if (!found) return false;
        last = found;
        return true;
      },
      eval: (x, out) => {
        const p = param(x), q = otherParam(x);
        let found = last ? touchPoint(p, q, last[0], last[1], lineOther) : null;
        // Search the whole curve when Newton can't follow from last time, except inside a Jacobian (its columns
        // are tiny nudges from a point `prepare` already searched at; searching for each would be very slow).
        // Outside one (a step being tried, the first evaluation, a freedom analysis) the value must be the true
        // touching gap there, or steps that would work get turned down.
        // (A few searches per step at most: a step's tries after that use the cheap ways below.)
        const mayFullySearch = !inJacobian && searchesLeft > 0;
        if (!found && mayFullySearch && !(last === null && searchedOnce)) {
          searchedOnce = true;
          searchesLeft--;
          found = search(x, p, q);
        }
        if (found) {
          last = found;
          const [u, v] = found;
          const a = p.at(u), b = q.at(v), d = q.d1(v);
          out.push(((a[0] - b[0]) * -d[1] + (a[1] - b[1]) * d[0]) / (Math.hypot(d[0], d[1]) || 1), 0);
          return;
        }
        if (mayFullySearch || (!extreme && endU === null)) {
          // Nowhere they run the same way side by side: the other's "distance" at its low or high point along this
          // curve nearest zero (zero only if they touch), searched for along the whole curve.
          if (mayFullySearch) searchesLeft--;
          let hit: { u: number; high: boolean; half: number } | null = null;
          endU = null;
          const value = touchGap(p, (pt) => level(x, pt), (u, high, half) => (hit = { u, high, half }), (u) => (endU = u));
          const h = hit as { u: number; high: boolean; half: number } | null;
          extreme = h ? { ...h, v: extreme?.v ?? 0 } : null;
          out.push(value, 0);
          return;
        }
        if (extreme) {
          // Inside a Jacobian: the same low or high point, followed from where it was just found (cheap).
          const e = extreme;
          const v = e.v;
          // The same "distance" the search used, so the low or high point is the same one.
          const f = (u: number) => (e.high ? -1 : 1) * level(x, p.at(wrapParam(p, u)));
          const r = (Math.sqrt(5) - 1) / 2;
          let lo = e.u - e.half, hi = e.u + e.half;
          let c = hi - r * (hi - lo), d = lo + r * (hi - lo);
          let fc = f(c), fd = f(d);
          for (let k = 0; k < 40 && hi - lo > 1e-12 * Math.max(1, Math.abs(lo)); k++) {
            if (fc < fd) {
              hi = d; d = c; fd = fc; c = hi - r * (hi - lo); fc = f(c);
            } else {
              lo = c; c = d; fc = fd; d = lo + r * (hi - lo); fd = f(d);
            }
          }
          const u = (lo + hi) / 2;
          const value = f(u) * (e.high ? -1 : 1);
          extreme = { ...e, u: wrapParam(p, u), v };
          out.push(value, 0);
          return;
        }
        // No low or high point at all (an open curve heading steadily away): as touchGap does, the nearer end's
        // gap and how far off running the same way it is, together (at the end found last time).
        out.push(endGap(p, (pt) => level(x, pt), endU ?? p.lo), 0);
      },
    };
  }

  /** Which way a curve runs at the place on it nearest q. */
  function dirNear(id: string): (x: Float64Array, q: Vec) => Vec {
    const c = curves.get(id)!;
    if (c.type === "line") {
      const d = dir(id);
      return (x) => d(x);
    }
    if (c.type === "circle" || c.type === "arc") {
      const k = circular(id);
      return (x, q) => {
        const cc = k.centre(x);
        return [-(q[1] - cc[1]), q[0] - cc[0]];
      };
    }
    const param = paramFn(id);
    return (x, q) => {
      const p = param(x);
      return p.d1(nearestParam(p, q));
    };
  }

  return { n: init.length, pointVar, radiusVar, x0: Float64Array.from(init), blocks, skipped, searching };
}

/**
 * Where two paths run the same way with the first's point square across from
 * the second's (Newton on both parameters from u, v): the place they touch, or
 * would if moved together. Null if it doesn't settle within the paths.
 */
function touchPoint(p: CurveParam, q: CurveParam, u: number, v: number, qUnbounded: boolean): [number, number] | null {
  for (let k = 0; k < 30; k++) {
    const P1 = p.d1(u), P2 = p.d2(u), Q1 = q.d1(v), Q2 = q.d2(v);
    const r: Vec = [p.at(u)[0] - q.at(v)[0], p.at(u)[1] - q.at(v)[1]];
    const f1 = P1[0] * Q1[1] - P1[1] * Q1[0];
    const f2 = r[0] * Q1[0] + r[1] * Q1[1];
    const a11 = P2[0] * Q1[1] - P2[1] * Q1[0], a12 = P1[0] * Q2[1] - P1[1] * Q2[0];
    const a21 = P1[0] * Q1[0] + P1[1] * Q1[1], a22 = -(Q1[0] * Q1[0] + Q1[1] * Q1[1]) + r[0] * Q2[0] + r[1] * Q2[1];
    const det = a11 * a22 - a12 * a21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
    const du = (-f1 * a22 + f2 * a12) / det;
    const dv = (-f2 * a11 + f1 * a21) / det;
    u += du;
    v += dv;
    if (p.closed) u = wrapParam(p, u);
    if (q.closed) v = wrapParam(q, v);
    // Wandered well off the end of an open curve: no touching place this way.
    const off = (c: CurveParam, t: number) => !c.closed && (t < c.lo - 0.5 * (c.hi - c.lo) || t > c.hi + 0.5 * (c.hi - c.lo));
    if (!Number.isFinite(u) || !Number.isFinite(v) || off(p, u) || (!qUnbounded && off(q, v))) return null;
    const span = Math.max(1, Math.abs(u), Math.abs(v));
    if (Math.abs(du) < 1e-14 * span && Math.abs(dv) < 1e-14 * span) {
      const inside = (c: CurveParam, t: number) => c.closed || (t >= c.lo - 1e-9 && t <= c.hi + 1e-9);
      return inside(p, u) && (qUnbounded || inside(q, v)) ? [u, v] : null;
    }
  }
  return null;
}

/** The place on a path nearest q by Newton steps from u (kept on the path); null if it doesn't settle. */
function nearestFrom(p: CurveParam, q: Vec, u: number): number | null {
  for (let k = 0; k < 12; k++) {
    const a = p.at(u), d1 = p.d1(u), d2 = p.d2(u);
    const r: Vec = [a[0] - q[0], a[1] - q[1]];
    const f = r[0] * d1[0] + r[1] * d1[1];
    const df = d1[0] * d1[0] + d1[1] * d1[1] + r[0] * d2[0] + r[1] * d2[1];
    // Only towards a nearest place (df > 0), not a farthest one.
    if (!(df > 0)) return null;
    const step = f / df;
    u = wrapParam(p, u - step);
    if (Math.abs(step) < 1e-14 * Math.max(1, Math.abs(u))) return u;
  }
  return null;
}



/**
 * How far a path is from touching a curve (given as a function that's zero
 * on the curve): among the places where that function has a low or high
 * point along the path, the value nearest zero. Zero = they touch.
 */
function touchGap(p: CurveParam, level: (q: Vec) => number, where?: (u: number, high: boolean, half: number) => void, atEnd?: (u: number) => void): number {
  const us = p.samples;
  // A closed path's last sample is its first again.
  const n = p.closed ? us.length - 1 : us.length;
  const g = us.slice(0, n).map((u) => level(p.at(u)));
  const value = (u: number) => level(p.at(wrapParam(p, u)));
  let best: number | null = null;
  const consider = (lo: number, hi: number, high: boolean) => {
    // Golden-section search for the low (or high) point between lo and hi.
    const f = (u: number) => (high ? -1 : 1) * value(u);
    const r = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi;
    let c = b - r * (b - a), d = a + r * (b - a);
    let fc = f(c), fd = f(d);
    for (let k = 0; k < 90 && b - a > 1e-14 * Math.max(1, Math.abs(a)); k++) {
      if (fc < fd) {
        b = d; d = c; fd = fc; c = b - r * (b - a); fc = f(c);
      } else {
        a = c; c = d; fc = fd; d = a + r * (b - a); fd = f(d);
      }
    }
    const v = value((a + b) / 2);
    if (best === null || Math.abs(v) < Math.abs(best)) {
      best = v;
      where?.(wrapParam(p, (a + b) / 2), high, (hi - lo) / 2);
    }
  };
  const step = (i: number) => (us[Math.min(i + 1, us.length - 1)] - us[Math.max(i - 1, 0)]) / 2 || 1e-9;
  for (let i = p.closed ? 0 : 1; i < (p.closed ? n : n - 1); i++) {
    const prev = g[(i - 1 + n) % n], cur = g[i], next = g[(i + 1) % n];
    const lo = us[i] - step(i), hi = us[i] + step(i);
    if (cur <= prev && cur <= next) consider(lo, hi, false);
    else if (cur >= prev && cur >= next) consider(lo, hi, true);
  }
  if (best !== null) return best;
  // No low or high point (an open path heading steadily away). Touching can then only be at an end, and only if
  // it runs the same way as the curve there as well as being on it.
  const u = Math.abs(g[0]) < Math.abs(g[n - 1]) ? us[0] : us[n - 1];
  atEnd?.(u);
  return endGap(p, level, u);
}

/** At an end u of a path: its gap from the curve and how far off square it runs, together (zero only if it touches there). */
function endGap(p: CurveParam, level: (q: Vec) => number, u: number): number {
  const q = p.at(u);
  const h = 1e-6 * Math.max(1, Math.abs(q[0]), Math.abs(q[1]));
  const grad: Vec = [(level([q[0] + h, q[1]]) - level([q[0] - h, q[1]])) / (2 * h), (level([q[0], q[1] + h]) - level([q[0], q[1] - h])) / (2 * h)];
  const d = p.d1(u);
  const off = (grad[0] * d[0] + grad[1] * d[1]) / ((Math.hypot(grad[0], grad[1]) || 1) * (Math.hypot(d[0], d[1]) || 1));
  return Math.hypot(level(q), off);
}

/**
 * Distance from `p` to the nearest place on a chain of cubic Bézier pieces,
 * plus on the curve's left (as it runs), minus on its right. The nearest place
 * is found on the true curve (a coarse search, then a few Newton steps), so the
 * side doesn't flicker near bends.
 */
function signedDistanceToBeziers(p: Vec, pieces: Bez[]): number {
  const at = ([a, b, c, d]: Bez, t: number): Vec => {
    const u = 1 - t;
    const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
    return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
  };
  const tangent = ([a, b, c, d]: Bez, t: number): Vec => {
    const u = 1 - t;
    const k0 = 3 * u * u, k1 = 6 * u * t, k2 = 3 * t * t;
    return [k0 * (b[0] - a[0]) + k1 * (c[0] - b[0]) + k2 * (d[0] - c[0]), k0 * (b[1] - a[1]) + k1 * (c[1] - b[1]) + k2 * (d[1] - c[1])];
  };
  const bend = ([a, b, c, d]: Bez, t: number): Vec => {
    const u = 1 - t;
    return [6 * u * (c[0] - 2 * b[0] + a[0]) + 6 * t * (d[0] - 2 * c[0] + b[0]), 6 * u * (c[1] - 2 * b[1] + a[1]) + 6 * t * (d[1] - 2 * c[1] + b[1])];
  };
  let best = Infinity;
  let bestPiece = -1;
  let bestT = 0;
  const STEPS = 12;
  pieces.forEach((bz, i) => {
    for (let k = 0; k <= STEPS; k++) {
      const q = at(bz, k / STEPS);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < best) {
        best = d;
        bestPiece = i;
        bestT = k / STEPS;
      }
    }
  });
  if (bestPiece < 0) return 0;
  const bz = pieces[bestPiece];
  let t = bestT;
  for (let iter = 0; iter < 6; iter++) {
    const q = at(bz, t), d1 = tangent(bz, t), d2 = bend(bz, t);
    const r: Vec = [q[0] - p[0], q[1] - p[1]];
    const f = r[0] * d1[0] + r[1] * d1[1];
    const df = d1[0] * d1[0] + d1[1] * d1[1] + r[0] * d2[0] + r[1] * d2[1];
    if (Math.abs(df) < 1e-15) break;
    t = Math.max(0, Math.min(1, t - f / df));
  }
  const q = at(bz, t);
  let dir = tangent(bz, t);
  if (Math.hypot(dir[0], dir[1]) < 1e-12) dir = [bz[3][0] - bz[0][0], bz[3][1] - bz[0][1]];
  const dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
  const side = dir[0] * (p[1] - q[1]) - dir[1] * (p[0] - q[0]);
  return side >= 0 ? dist : -dist;
}

/** Let blocks that search once per solver step do so at x; true if any now answer differently. */
function prepareAll(sys: System, x: Float64Array): boolean {
  let changed = false;
  for (const b of sys.blocks) if (b.prepare?.(x)) changed = true;
  return changed;
}

function evalAll(sys: System, x: Float64Array): number[] {
  const out: number[] = [];
  for (const b of sys.blocks) b.eval(x, out);
  return out;
}

/**
 * Which unknowns each block reads, found once by watching one evaluation.
 * A column of the Jacobian then only re-runs the blocks that read it.
 */
const dependsCache = new WeakMap<System, { rows: number[]; columns: number[][] }>();
function dependencies(sys: System, x: Float64Array): { rows: number[]; columns: number[][] } {
  const known = dependsCache.get(sys);
  if (known) return known;
  const columns: number[][] = Array.from({ length: sys.n }, () => []);
  const rows: number[] = [];
  let row = 0;
  sys.blocks.forEach((b, bi) => {
    const read = new Set<number>();
    const watched = new Proxy(Float64Array.from(x), {
      get(t, k) {
        if (typeof k === "string") {
          const i = Number(k);
          if (Number.isInteger(i) && i >= 0) read.add(i);
        }
        return Reflect.get(t, k);
      },
    });
    const out: number[] = [];
    b.eval(watched as unknown as Float64Array, out);
    rows.push(row);
    row += out.length;
    for (const i of read) if (i < sys.n) columns[i].push(bi);
  });
  const deps = { rows, columns };
  dependsCache.set(sys, deps);
  return deps;
}

/** True while a Jacobian is being worked out (blocks may then skip costly searches). */
let inJacobian = false;

/** Numerical Jacobian (m × n), central differences — re-running only the blocks that read each unknown. */
function jacobian(sys: System, x: Float64Array, m: number): Float64Array {
  inJacobian = true;
  try {
    return jacobianOf(sys, x, m);
  } finally {
    inJacobian = false;
  }
}

function jacobianOf(sys: System, x: Float64Array, m: number): Float64Array {
  const J = new Float64Array(m * sys.n);
  const { rows, columns } = dependencies(sys, x);
  const xp = Float64Array.from(x);
  const rp: number[][] = [];
  const rm: number[][] = [];
  for (let j = 0; j < sys.n; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[j]));
    const deps = columns[j];
    // All the blocks one way, then all the other way (so curves they share are worked out once each way).
    xp[j] = x[j] + h;
    deps.forEach((bi, k) => {
      rp[k] = [];
      sys.blocks[bi].eval(xp, rp[k]);
    });
    xp[j] = x[j] - h;
    deps.forEach((bi, k) => {
      rm[k] = [];
      sys.blocks[bi].eval(xp, rm[k]);
    });
    xp[j] = x[j];
    deps.forEach((bi, k) => {
      const r0 = rows[bi];
      const a = rp[k], b = rm[k];
      for (let i = 0; i < a.length && r0 + i < m; i++) J[(r0 + i) * sys.n + j] = (a[i] - b[i]) / (2 * h);
    });
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
  /** Put these points here first and prefer to keep them there (dragging an arc's rim: its ends and centre). */
  place?: { pointId: string; x: number; y: number }[];
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

// ---------------------------------------------------------------------------
// Pattern copies worked out rather than solved

/** An `equal` made by a sketch pattern: the copy's (refs[0]) size follows the original's. */
export const isPatternSize = (c: SketchConstraint) => c.type === "equal" && c.extra?.[0] === 1;

/** Where a pattern puts a copy of a point: turned round a centre, or moved along a line or at an angle. */
type CopyRule = { orig: string; centre: string; deg: number } | { orig: string; line?: string; dist: number; angle: number };

const isPatternCopy = (k: SketchConstraint) => (k.type === "patternCopy" && k.refs.length === 3) || (k.type === "patternMove" && k.refs.length >= 2);

interface Derived {
  /** The sketch without the copies that are only placed by their pattern. */
  reduced: SketchData;
  /** Each such copy: the point it's a copy of, and how the pattern moves it. */
  points: Map<string, CopyRule>;
  /** Copied circles whose size is the original circle's. */
  circles: Map<string, string>;
  /** Points of offset copies of splines and ellipses: where along the original, and how far to its left. */
  offsets: Map<string, { orig: string; u: number; dist: number }>;
}

/**
 * A circular pattern's copies that nothing else holds (no constraint or
 * dimension on them or their lines and circles) are simply the original
 * turned round the centre, so they're left out of the solve and placed
 * afterwards: a pattern of 100 copies costs no more to solve than its original.
 * Copies something else does hold stay in the solve. Null when there are none.
 */
function splitDerived(sketch: SketchData): Derived | null {
  const copies = sketch.constraints.filter(isPatternCopy);
  const offsetList = curveOffsets(sketch);
  if (!copies.length && !offsetList.length) return null;
  const used = new Set<string>();
  const copyCount = new Map<string, number>();
  for (const k of sketch.constraints) {
    if (k.type === "patternCopy" || k.type === "patternMove") copyCount.set(k.refs[0], (copyCount.get(k.refs[0]) ?? 0) + 1);
    k.refs.forEach((r, i) => {
      if (i === 0 && (k.type === "patternCopy" || k.type === "patternMove" || isPatternSize(k))) return;
      used.add(r);
    });
  }
  const curvesOf = new Map<string, SketchCurve[]>();
  for (const c of sketch.curves) for (const p of curvePointIds(c)) curvesOf.set(p, [...(curvesOf.get(p) ?? []), c]);
  const points = new Map<string, CopyRule>();
  const known = new Set(sketch.points.map((p) => p.id));
  const lines = new Set(sketch.curves.filter((c) => c.type === "line").map((c) => c.id));
  for (const k of copies) {
    const [copy, orig, third] = k.refs;
    if (copyCount.get(copy) !== 1 || used.has(copy) || !known.has(copy) || (curvesOf.get(copy) ?? []).some((c) => used.has(c.id))) continue;
    if (orig !== ORIGIN_ID && !known.has(orig)) continue;
    if (k.type === "patternMove") {
      if (third !== undefined && !lines.has(third)) continue;
      points.set(copy, { orig, ...(third ? { line: third } : {}), dist: k.extra?.[0] ?? 0, angle: k.extra?.[1] ?? 0 });
      continue;
    }
    if (third !== ORIGIN_ID && !known.has(third)) continue;
    points.set(copy, { orig, centre: third, deg: k.extra?.[0] ?? 0 });
  }
  const circles = new Map<string, string>();
  for (const k of sketch.constraints) if (isPatternSize(k)) circles.set(k.refs[0], k.refs[1]);
  const dropCurves = new Set(sketch.curves.filter((c) => curvePointIds(c).some((p) => points.has(p))).map((c) => c.id));
  for (const id of [...circles.keys()]) if (!dropCurves.has(id)) circles.delete(id);

  // Offset copies of splines and ellipses that nothing else rests on: their points are worked out from the original afterwards.
  const offsets = new Map<string, { orig: string; u: number; dist: number }>();
  const byId = curveById(sketch);
  for (const o of offsetList) {
    const copy = byId.get(o.copy) as SketchSpline;
    if (dropCurves.has(o.orig) || dropCurves.has(o.copy) || sketch.constraints.some((k) => k !== o.con && k.refs.includes(o.copy))) continue;
    copy.points.forEach((pid, j) => {
      if (used.has(pid) || points.has(pid) || offsets.has(pid) || (curvesOf.get(pid) ?? []).length > 1 || !known.has(pid)) return;
      offsets.set(pid, { orig: o.orig, u: copy.offsetParams![j], dist: o.dist });
    });
  }
  if (!points.size && !offsets.size) return null;
  // A copy keeps (as a stand-in for the solve) only its points that something else holds.
  const stubs = new Map<string, SketchSpline | null>();
  for (const o of offsetList) {
    const copy = byId.get(o.copy) as SketchSpline;
    if (!copy.points.some((pid) => offsets.has(pid))) continue;
    const keep = copy.points.map((pid, j) => [pid, copy.offsetParams![j]] as const).filter(([pid]) => !offsets.has(pid));
    stubs.set(copy.id, keep.length ? { id: copy.id, type: "spline", points: keep.map(([pid]) => pid), closed: false, construction: true, offsetParams: keep.map(([, u]) => u) } : null);
  }
  const reduced: SketchData = {
    points: sketch.points.filter((p) => !points.has(p.id) && !offsets.has(p.id)),
    curves: sketch.curves.flatMap((c) => (dropCurves.has(c.id) ? [] : stubs.has(c.id) ? (stubs.get(c.id) ? [stubs.get(c.id)!] : []) : [c])),
    constraints: sketch.constraints.flatMap((k): SketchConstraint[] => {
      if ((k.type === "patternCopy" || k.type === "patternMove") && points.has(k.refs[0])) return [];
      if (isPatternSize(k) && circles.has(k.refs[0])) return [];
      if (k.type !== "offset" || !k.refs.some((r) => stubs.get(r) === null)) return [k];
      // Pairs whose copy is placed entirely afterwards leave the solve.
      const refs: string[] = [];
      const extra: number[] = [];
      for (let i = 0; i + 1 < k.refs.length; i += 2) {
        if (stubs.get(k.refs[i]) === null) continue;
        refs.push(k.refs[i], k.refs[i + 1]);
        if (k.extra?.[i / 2] !== undefined) extra.push(k.extra[i / 2]);
      }
      return refs.length ? [{ ...k, refs, ...(k.extra ? { extra } : {}) }] : [];
    }),
  };
  return { reduced, points, circles, offsets };
}

const curvePointIds = (c: SketchCurve): string[] =>
  c.type === "line"
    ? [c.p1, c.p2]
    : c.type === "circle"
      ? [c.center]
      : c.type === "spline"
        ? c.points
        : c.type === "ellipse"
          ? [c.center, c.major, c.minor, ...(c.start && c.end ? [c.start, c.end] : [])]
          : [c.center, c.start, c.end];

/** The whole sketch from the solved reduced one: copies placed round their centres, copied circles sized like their originals. */
function placeDerived(full: SketchData, solved: SketchData, d: Derived): SketchData {
  const placed = placeCopies(full, solved, d);
  if (!d.offsets.size) return placed;
  // Offset copies' points, from the originals where they now are.
  const paths = new Map<string, CurveParam>();
  const byId = curveById(placed);
  return {
    ...placed,
    points: placed.points.map((p) => {
      const o = d.offsets.get(p.id);
      if (!o) return p;
      let path = paths.get(o.orig);
      if (!path) paths.set(o.orig, (path = curveParam(placed, byId.get(o.orig)!)));
      const [x, y] = offsetAt(path, o.u, o.dist).at;
      return x === p.x && y === p.y ? p : { ...p, x, y };
    }),
  };
}

function placeCopies(full: SketchData, solved: SketchData, d: Derived): SketchData {
  const at = new Map<string, [number, number]>(solved.points.map((p) => [p.id, [p.x, p.y]]));
  const pos = (id: string): [number, number] => (id === ORIGIN_ID ? [0, 0] : at.get(id) ?? [0, 0]);
  const radius = new Map<string, number>();
  for (const c of solved.curves) if (c.type === "circle") radius.set(c.id, c.radius);
  return {
    ...full,
    points: full.points.map((p) => {
      const k = d.points.get(p.id);
      let x: number, y: number;
      if (k && "centre" in k) {
        const o = pos(k.orig), c = pos(k.centre);
        const t = (k.deg * Math.PI) / 180;
        const dx = o[0] - c[0], dy = o[1] - c[1];
        [x, y] = [c[0] + dx * Math.cos(t) - dy * Math.sin(t), c[1] + dx * Math.sin(t) + dy * Math.cos(t)];
      } else if (k) {
        const o = pos(k.orig);
        let d: [number, number] = [Math.cos((k.angle * Math.PI) / 180), Math.sin((k.angle * Math.PI) / 180)];
        const line = k.line ? solved.curves.find((c) => c.id === k.line) : undefined;
        if (line?.type === "line") {
          const a = pos(line.p1), b = pos(line.p2);
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
        }
        [x, y] = [o[0] + d[0] * k.dist, o[1] + d[1] * k.dist];
      } else [x, y] = pos(p.id);
      return x === p.x && y === p.y ? p : { ...p, x, y };
    }),
    curves: full.curves.map((c) => {
      if (c.type !== "circle") return c;
      const r = d.circles.has(c.id) ? radius.get(d.circles.get(c.id)!) ?? c.radius : radius.get(c.id) ?? c.radius;
      return r === c.radius ? c : { ...c, radius: r };
    }),
  };
}

/** Does a drag (or other pull) act on a copy that's only placed by its pattern? Then the whole sketch is solved. */
function pullsCopy(d: Derived, o: SolveOptions): boolean {
  const placed = (id: string) => d.points.has(id) || d.offsets.has(id);
  if (o.drag && placed(o.drag.pointId)) return true;
  if (o.moveRigid?.pointIds.some(placed)) return true;
  if (o.resize && d.circles.has(o.resize.circleId)) return true;
  return !!o.place?.some((p) => placed(p.pointId));
}

/** Is this a point of an offset copy that only its original places (so dragging it does nothing)? */
export function placedByOffset(sketch: SketchData, pointId: string): boolean {
  return !!splitDerived(sketch)?.offsets.has(pointId);
}

/** Move the sketch so every constraint holds, changing it as little as possible. */
export function solveSketch(sketch: SketchData, options: SolveOptions = {}): SolveResult {
  const d = splitDerived(sketch);
  if (d && options.drag && d.offsets.has(options.drag.pointId)) {
    // A point of an offset copy is placed by its original: dragging it moves nothing (drag the original instead).
    const { drag: _drag, ...rest } = options;
    void _drag;
    return solveSketch(sketch, rest);
  }
  if (d && !pullsCopy(d, options)) {
    const r = solveWhole(d.reduced, options);
    return withOffsets({ ...r, sketch: placeDerived(sketch, r.sketch, d) }, options);
  }
  if (d && options.drag && d.points.has(options.drag.pointId)) {
    // Dragging a copy turns the pattern round its centre (the centre stays put; the original moves), like Onshape.
    const rule = d.points.get(options.drag.pointId)!;
    const centre = "centre" in rule ? rule.centre : null;
    const p = centre ? sketch.points.find((q) => q.id === centre) : undefined;
    if (p) return withOffsets(solveWhole(sketch, { ...options, place: [...(options.place ?? []), { pointId: p.id, x: p.x, y: p.y }] }), options);
  }
  return withOffsets(solveWhole(sketch, options), options);
}

// ---------------------------------------------------------------------------
// Offset copies of splines and ellipses

/** The [copy, original, signed distance] of every spline offset from a spline or ellipse. */
function curveOffsets(s: SketchData): { con: SketchConstraint; pair: number; copy: string; orig: string; dist: number }[] {
  const byId = curveById(s);
  const out: { con: SketchConstraint; pair: number; copy: string; orig: string; dist: number }[] = [];
  for (const k of s.constraints) {
    if (k.type !== "offset" || k.driven) continue;
    const v = evaluate(k.value ?? "");
    if (!v.ok) continue;
    for (let i = 0; i + 1 < k.refs.length; i += 2) {
      const copy = byId.get(k.refs[i]);
      const orig = byId.get(k.refs[i + 1]);
      if (copy?.type !== "spline" || !copy.offsetParams || (orig?.type !== "spline" && orig?.type !== "ellipse")) continue;
      out.push({ con: k, pair: i / 2, copy: copy.id, orig: orig.id, dist: (k.extra?.[i / 2] ?? 1) * v.value });
    }
  }
  return out;
}

/** The parameters an offset copy's pieces run between: one per point, and round to the first again when closed. */
export function offsetSpan(orig: CurveParam, us: number[], closed: boolean): number[] {
  return closed ? [...us, us[0] + (orig.hi - orig.lo)] : us;
}

/**
 * After solving, give each offset copy of a spline or ellipse the handles
 * that make it follow the true offset (its points are already in place). If
 * the original has changed so much that the copy strays more than the
 * tolerance, it gets more points.
 */
export function refreshOffsets(s: SketchData): SketchData {
  const list = curveOffsets(s);
  if (!list.length) return s;
  let out = s;
  for (const o of list) {
    const copy = out.curves.find((c) => c.id === o.copy);
    const orig = out.curves.find((c) => c.id === o.orig);
    if (copy?.type !== "spline" || !copy.offsetParams || !orig) continue;
    const param = curveParam(out, orig);
    const us = offsetSpan(param, copy.offsetParams, copy.closed);
    let pieces = offsetPieces(param, o.dist, us);
    let ids = copy.points;
    let params = copy.offsetParams;
    let points = out.points;
    // Fit again when the copy strays past the tolerance, or when far fewer points would now do. Not when the
    // original bends tighter than the offset distance: no fit can follow that (offsetWarnings explains), so
    // the copy keeps the points it has.
    let fresh: number[] | null = null;
    // A copy that is itself offset again keeps its points: its own copies' places are measured along its pieces.
    const parentOfCopies = list.some((other) => other.orig === copy.id);
    if (!parentOfCopies && !offsetTooTight(param, o.dist)) {
      const knots = orig.type === "spline" && orig.conic === undefined ? Array.from({ length: Math.round(param.hi - param.lo) + 1 }, (_, i) => param.lo + i) : undefined;
      const fit = () => fitParams(param, o.dist, OFFSET_TOLERANCE / 2, knots);
      if (offsetError(param, o.dist, us, pieces) > OFFSET_TOLERANCE) fresh = fit();
      else if (copy.points.length > 17) {
        const f = fit();
        if (2 * f.length <= copy.points.length) fresh = f;
      }
    }
    if (fresh) {
      // The ends stay, and so does every point something else uses (a line drawn from it, a constraint on it),
      // at its own place along the original; the others are replaced.
      const span = copy.closed ? fresh.slice(0, -1) : fresh;
      const others = new Set<string>();
      for (const c of out.curves) if (c.id !== copy.id) for (const pid of curvePointIds(c)) others.add(pid);
      for (const k of out.constraints) for (const r of k.refs) others.add(r);
      const last = copy.points.length - 1;
      const kept = new Map<number, string>();
      copy.points.forEach((pid, j) => {
        if (j === 0 || (!copy.closed && j === last) || others.has(pid)) kept.set(copy.offsetParams![j], pid);
      });
      const merged = [...new Set([...span, ...kept.keys()])].sort((x, y) => x - y);
      // Fresh places within a hair of a kept point's place are the same place.
      const near = (u: number) => [...kept.keys()].find((k) => Math.abs(k - u) < 1e-9);
      const all = merged.filter((u) => kept.has(u) || near(u) === undefined);
      const taken = new Set(out.points.map((p) => p.id));
      let n = 0;
      const newId = () => {
        let id: string;
        do id = `${copy.id}~${(n++).toString(36)}`;
        while (taken.has(id));
        taken.add(id);
        return id;
      };
      ids = all.map((u) => kept.get(u) ?? newId());
      params = all;
      pieces = offsetPieces(param, o.dist, offsetSpan(param, all, copy.closed));
      const gone = new Set(copy.points.filter((id) => !ids.includes(id)));
      const at = pieces.map((b) => b[0]);
      if (!copy.closed) at.push(pieces[pieces.length - 1][3]);
      points = [...out.points.filter((p) => !gone.has(p.id)), ...ids.filter((id) => !copy.points.includes(id)).map((id) => ({ id, x: at[ids.indexOf(id)][0], y: at[ids.indexOf(id)][1] }))];
    }
    const fitted = splineThrough(copy.id, ids, pieces, copy.closed, copy.construction);
    const next: SketchCurve = { ...fitted, offsetParams: params };
    out = { ...out, points, curves: out.curves.map((c) => (c.id === copy.id ? next : c)) };
  }
  return out;
}

/** Does the original bend more tightly than the offset distance somewhere on the copy's side? */
function offsetTooTight(param: CurveParam, dist: number): boolean {
  return tightestBend(param, Math.sign(dist) || 1) * Math.abs(dist) >= 0.999;
}

/** Plain-English notes about offset copies that can't follow their original any more (it now bends too tightly). */
export function offsetWarnings(s: SketchData): string[] {
  const out: string[] = [];
  for (const o of curveOffsets(s)) {
    const orig = s.curves.find((c) => c.id === o.orig);
    if (orig && offsetTooTight(curveParam(s, orig), o.dist))
      out.push(
        `An offset copy can't follow its ${orig.type === "ellipse" ? "ellipse" : "spline"} any more: it now bends more tightly than the offset distance on that side. Use a smaller distance, or reshape it more gently.`,
      );
  }
  return out;
}

/** Solve results with offset copies' handles brought up to date (and solved again if something else rests on those copies). */
function withOffsets(r: SolveResult, options: SolveOptions): SolveResult {
  const list = curveOffsets(r.sketch);
  if (!list.length) return r;
  const fresh = refreshOffsets(r.sketch);
  // Solving again only helps a sketch that was met; one that can't be met wouldn't be now either.
  if (!r.ok) return { ...r, sketch: fresh };
  const copies = new Set(list.map((o) => o.copy));
  const leaning = fresh.constraints.some((k) => k.type !== "offset" && k.refs.some((id) => copies.has(id)));
  if (!leaning) return { ...r, sketch: fresh };
  const again = solveWhole(fresh, options);
  return { ...again, sketch: refreshOffsets(again.sketch) };
}

function solveWhole(sketch: SketchData, options: SolveOptions): SolveResult {
  const interactive = options.drag || options.moveRigid || options.resize || options.place?.length;
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
  for (const p of options.place ?? []) {
    const i = sys.pointVar.get(p.pointId);
    if (i === undefined) continue;
    x[i] = p.x;
    x[i + 1] = p.y;
    weight[i] = weight[i + 1] = stiffness;
  }
  if (options.drag) {
    const i = sys.pointVar.get(options.drag.pointId);
    if (i !== undefined) {
      x[i] = options.drag.x;
      x[i + 1] = options.drag.y;
      weight[i] = weight[i + 1] = stiffness;
    }
  }

  prepareAll(sys, x);
  let r = evalAll(sys, x);
  const m = r.length;
  const maxIterations = options.maxIterations ?? 60;
  // Largest residual after each step (for giving up on hopeless searching solves; see System.searching).
  const history: number[] = [];
  for (let iter = 0; iter < maxIterations && maxAbs(r) > SOLVE_TOLERANCE * 0.01; iter++) {
    // Blocks that search afresh once per step (a touching Tangent) may now answer differently here.
    if (iter > 0 && prepareAll(sys, x)) r = evalAll(sys, x);
    if (sys.searching && !(globalThis as any).__noGiveUp) {
      history.push(maxAbs(r));
      // At the rate it has improved over the last 8 steps, it couldn't be met in the steps left: give up now.
      // (Sketches without such blocks run exactly as before.)
      // (Not judged too early, and with room to spare: a solve often speeds up once it's near.)
      if (history.length > 10) {
        const now = history[history.length - 1];
        const rate = Math.pow(now / history[history.length - 9], 1 / 8);
        const needed = rate >= 1 ? Infinity : Math.log((SOLVE_TOLERANCE * 100) / now) / Math.log(rate);
        if (needed > 1.5 * (maxIterations - iter)) break;
      }
      // Already met (well within the tolerance) and only creeping closer: the searching blocks' own rounding
      // won't let it go much further, so stop polishing.
      const n = history.length;
      if (n >= 2 && history[n - 1] <= SOLVE_TOLERANCE * 10 && history[n - 1] > 0.5 * history[n - 2]) break;
      // Met (within the tolerance) and no longer getting anywhere over the last few steps: stop.
      if (n >= 4 && history[n - 1] <= SOLVE_TOLERANCE * 100 && Math.min(history[n - 1], history[n - 2], history[n - 3]) >= 0.9 * history[n - 4]) break;
    }
    const J = jacobian(sys, x, m);
    // Weighted minimum-norm step: Δ = -W⁻² Jᵀ (J W⁻² Jᵀ + λI)⁻¹ r
    // A = J W⁻² Jᵀ, skipping the (many) zeros of J: each entry gets the same terms added in the same order as
    // the plain triple loop (adding zeros changes nothing), so the result is identical, just much faster for big sketches.
    const A = new Float64Array(m * m);
    const rowsIn: number[] = [];
    for (let j = 0; j < sys.n; j++) {
      rowsIn.length = 0;
      for (let i = 0; i < m; i++) if (J[i * sys.n + j] !== 0) rowsIn.push(i);
      const w2 = weight[j] * weight[j];
      for (let a = 0; a < rowsIn.length; a++) {
        const i = rowsIn[a];
        const ji = J[i * sys.n + j];
        for (let b = a; b < rowsIn.length; b++) {
          const k = rowsIn[b];
          A[i * m + k] += (ji * J[k * sys.n + j]) / w2;
        }
      }
    }
    for (let i = 0; i < m; i++) for (let k = i + 1; k < m; k++) A[k * m + i] = A[i * m + k];
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
  const d = splitDerived(sketch);
  if (!d) return analyzeWhole(sketch);
  // Copies placed by their pattern are as pinned down as their original and centre; they add no freedom.
  const r = analyzeWhole(d.reduced);
  const definedPoints = new Set(r.definedPoints);
  for (const [id, k] of d.points) {
    const line = "centre" in k ? undefined : k.line ? sketch.curves.find((c) => c.id === k.line) : undefined;
    // A row along a line only needs the line's direction pinned down: both ends, or held level or upright.
    const level = line?.type === "line" && sketch.constraints.some((c) => (c.type === "horizontal" || c.type === "vertical") && c.refs.length === 1 && c.refs[0] === line.id);
    const holders = "centre" in k ? [k.centre] : line?.type === "line" && !level ? [line.p1, line.p2] : [];
    if (r.definedPoints.has(k.orig) && holders.every((h) => r.definedPoints.has(h))) definedPoints.add(id);
  }
  // An offset copy's points are as pinned down as the original.
  const byId = curveById(sketch);
  for (const [id, o] of d.offsets) if (curvePointIds(byId.get(o.orig)!).every((p) => definedPoints.has(p))) definedPoints.add(id);
  const definedCurves = new Set(r.definedCurves);
  for (const c of sketch.curves) {
    if (!curvePointIds(c).some((p) => d.points.has(p) || d.offsets.has(p))) continue;
    // Judged on all its points (the solve only saw some of them).
    if (curvePointIds(c).some((p) => d.offsets.has(p))) definedCurves.delete(c.id);
    else if (r.definedCurves.has(c.id)) continue;
    const pts = curvePointIds(c).every((p) => definedPoints.has(p));
    if (c.type === "circle" ? pts && (!d.circles.has(c.id) || r.definedCurves.has(d.circles.get(c.id)!)) : pts) definedCurves.add(c.id);
  }
  return { freedom: r.freedom, definedPoints, definedCurves };
}

function analyzeWhole(sketch: SketchData): SketchAnalysis {
  const sys = buildSystem(sketch);
  prepareAll(sys, sys.x0);
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
        : c.type === "spline"
          ? c.points.every((p) => definedPoints.has(p))
          : c.type === "ellipse"
          ? curvePointIds(c).every((p) => definedPoints.has(p))
          : c.type === "circle"
          ? definedPoints.has(c.center) && determined[sys.radiusVar.get(c.id)!]
          : definedPoints.has(c.center) && definedPoints.has(c.start) && definedPoints.has(c.end);
    if (ok) definedCurves.add(c.id);
  }
  return { freedom: freeCols.length, definedPoints, definedCurves };
}
