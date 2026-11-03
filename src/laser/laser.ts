/**
 * Export for laser: true-size 2D outlines to cut, score and engrave, kept as
 * exact curves (lines, arcs, circles, Bézier pieces, ellipses) for as long as
 * possible. Pure: the engine (src/kernel/laserFaces.ts) and the sketch code
 * hand over raw outline pieces; this joins them into loops, sorts outer cuts
 * from inner ones, lays several pieces out side by side, and gives the SVG/DXF
 * writers (laserFiles.ts) one clean sheet in millimetres, y up.
 */
import { arrangeOnBed } from "../model/printCheck";
import { pointInPolygon, type Pt, type Segment } from "../sketch/regions";

/** What the laser does with a line: cut the outside, cut a hole (first), score (low power), or engrave an area. */
export type LaserLayer = "outer" | "inner" | "score" | "engrave";

export interface LaserLayerInfo {
  /** Short name, for the colour key. */
  label: string;
  /** Colour in the SVG (strokes; engraving is filled). */
  colour: string;
  /** Layer name in the DXF and the SVG group's id. */
  dxf: string;
  /** AutoCAD colour number for the DXF layer. */
  aci: number;
  /** What to set it up as, in plain words. */
  hint: string;
}

/** The layers, in the order a laser should do them: engrave and score first, holes next, the outside last. */
export const LASER_LAYERS: Record<LaserLayer, LaserLayerInfo> = {
  engrave: { label: "Engrave", colour: "#000000", dxf: "ENGRAVE", aci: 7, hint: "black filled areas: set them to engrave (fill)" },
  score: { label: "Score", colour: "#00FF00", dxf: "SCORE", aci: 3, hint: "green lines: a light pass that marks without cutting through (bend lines, fold lines)" },
  inner: { label: "Inner cuts", colour: "#0000FF", dxf: "CUT_INNER", aci: 5, hint: "blue lines: holes and cut-outs, cut right through, before the outside" },
  outer: { label: "Outer cuts", colour: "#FF0000", dxf: "CUT_OUTER", aci: 1, hint: "red lines: the outside of each piece, cut right through, last" },
};
export const LAYER_ORDER: LaserLayer[] = ["engrave", "score", "inner", "outer"];

/** One outline: a closed loop or an open run of curves, all on one layer. */
export interface LaserPath {
  layer: LaserLayer;
  segments: Segment[];
  closed: boolean;
}

/** One thing to cut (a face, a sketch, a flat pattern), in its own flat coordinates (mm). */
export interface LaserPiece {
  name: string;
  paths: LaserPath[];
}

/** Everything laid out on one sheet: bottom-left corner at (0, 0), y up, mm. */
export interface LaserSheet {
  paths: LaserPath[];
  size: [number, number];
  /** Where each piece went: its name and its box [x0, y0, x1, y1]. */
  pieces: { name: string; box: [number, number, number, number] }[];
}

/** How close two ends must be to join (mm). */
export const JOIN_TOLERANCE = 1e-3;
/** Curves that can't be kept exact are drawn as straight pieces at most this far from them (mm). */
export const FLAT_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------
// Small geometry helpers.

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The circle through three points (null when they lie on a line). */
export function circleThrough(a: Pt, b: Pt, c: Pt): { centre: Pt; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const centre: Pt = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  return { centre, r: dist(centre, a) };
}

/** An arc through three points: its centre, radius, start angle and signed turn (+ anticlockwise, radians). */
export function arcInfo(s: Extract<Segment, { kind: "arc" }>): { centre: Pt; r: number; a0: number; turn: number } | null {
  const c = circleThrough(s.from, s.mid, s.to);
  if (!c) return null;
  const ccw = cross(sub(s.mid, s.from), sub(s.to, s.mid)) > 0;
  const a0 = Math.atan2(s.from[1] - c.centre[1], s.from[0] - c.centre[0]);
  const a1 = Math.atan2(s.to[1] - c.centre[1], s.to[0] - c.centre[0]);
  const TWO_PI = 2 * Math.PI;
  let turn = ccw ? (a1 - a0) % TWO_PI : -((a0 - a1) % TWO_PI);
  if (ccw && turn <= 0) turn += TWO_PI;
  if (!ccw && turn >= 0) turn -= TWO_PI;
  // The same end as the start (a whole circle drawn as an arc).
  if (dist(s.from, s.to) < 1e-9) turn = ccw ? TWO_PI : -TWO_PI;
  return { centre: c.centre, r: c.r, a0, turn };
}

/** A curve's two ends (none for whole circles and ellipses). */
export function segmentEnds(s: Segment): [Pt, Pt] | null {
  if (s.kind === "circle" || s.kind === "ellipse") return null;
  return [s.from, s.to];
}

/** The same curve walked the other way. */
export function reverseSegment(s: Segment): Segment {
  switch (s.kind) {
    case "line":
      return { kind: "line", from: s.to, to: s.from };
    case "arc":
      return { kind: "arc", from: s.to, mid: s.mid, to: s.from };
    case "bezier":
      return { kind: "bezier", from: s.to, c1: s.c2, c2: s.c1, to: s.from };
    case "ellipseArc":
      return { ...s, from: s.to, to: s.from };
    default:
      return s;
  }
}

const ellipsePoint = (c: Pt, rx: number, ry: number, angle: number, t: number): Pt => {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const x = rx * Math.cos(t);
  const y = ry * Math.sin(t);
  return [c[0] + x * ca - y * sa, c[1] + x * sa + y * ca];
};
const ellipseTangent = (rx: number, ry: number, angle: number, t: number): Pt => {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const x = -rx * Math.sin(t);
  const y = ry * Math.cos(t);
  return [x * ca - y * sa, x * sa + y * ca];
};

/**
 * Part of an ellipse as cubic Bézier pieces (each at most π/8 of its turn, so
 * within a few millionths of its size), walked from its `from` end.
 */
export function ellipseArcBeziers(s: Extract<Segment, { kind: "ellipseArc" }>): Segment[] {
  const forward = dist(ellipsePoint(s.center, s.rx, s.ry, s.angle, s.t0), s.from) <= dist(ellipsePoint(s.center, s.rx, s.ry, s.angle, s.t1), s.from);
  const [u0, u1] = forward ? [s.t0, s.t1] : [s.t1, s.t0];
  const n = Math.max(1, Math.ceil(Math.abs(u1 - u0) / (Math.PI / 8)));
  const out: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const a = u0 + ((u1 - u0) * i) / n;
    const b = u0 + ((u1 - u0) * (i + 1)) / n;
    const k = (4 / 3) * Math.tan((b - a) / 4);
    const p0 = i === 0 ? s.from : ellipsePoint(s.center, s.rx, s.ry, s.angle, a);
    const p3 = i === n - 1 ? s.to : ellipsePoint(s.center, s.rx, s.ry, s.angle, b);
    const d0 = ellipseTangent(s.rx, s.ry, s.angle, a);
    const d1 = ellipseTangent(s.rx, s.ry, s.angle, b);
    out.push({ kind: "bezier", from: p0, c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]], c2: [p3[0] - k * d1[0], p3[1] - k * d1[1]], to: p3 });
  }
  return out;
}

/** Points along a curve from its start to its end (both included), within `tol` mm of it. */
export function segmentPoints(s: Segment, tol = FLAT_TOLERANCE): Pt[] {
  const stepsFor = (r: number, turn: number) => {
    const half = r > tol ? Math.acos(1 - tol / r) : Math.PI / 4;
    return Math.max(2, Math.min(100_000, Math.ceil(Math.abs(turn) / (2 * Math.max(half, 1e-6)))));
  };
  switch (s.kind) {
    case "line":
      return [s.from, s.to];
    case "arc": {
      const a = arcInfo(s);
      if (!a) return [s.from, s.to];
      const n = stepsFor(a.r, a.turn);
      const pts: Pt[] = [s.from];
      for (let i = 1; i < n; i++) {
        const t = a.a0 + (a.turn * i) / n;
        pts.push([a.centre[0] + a.r * Math.cos(t), a.centre[1] + a.r * Math.sin(t)]);
      }
      pts.push(s.to);
      return pts;
    }
    case "circle": {
      const n = stepsFor(s.radius, 2 * Math.PI);
      const pts: Pt[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (2 * Math.PI * i) / n;
        pts.push([s.center[0] + s.radius * Math.cos(t), s.center[1] + s.radius * Math.sin(t)]);
      }
      return pts;
    }
    case "ellipse": {
      const n = stepsFor(Math.max(s.rx, s.ry) * Math.max(1, Math.max(s.rx, s.ry) / Math.max(1e-9, Math.min(s.rx, s.ry))), 2 * Math.PI);
      const pts: Pt[] = [];
      for (let i = 0; i <= n; i++) pts.push(ellipsePoint(s.center, s.rx, s.ry, s.angle, (2 * Math.PI * i) / n));
      return pts;
    }
    case "ellipseArc":
      return ellipseArcBeziers(s).flatMap((b, i) => segmentPoints(b, tol).slice(i ? 1 : 0));
    case "bezier": {
      const pts: Pt[] = [s.from];
      const split = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, depth: number) => {
        // Flat enough when both control points lie within tol of the chord.
        const chord = sub(p3, p0);
        const len = Math.hypot(chord[0], chord[1]);
        const off = (p: Pt) => (len < 1e-12 ? dist(p, p0) : Math.abs(cross(chord, sub(p, p0))) / len);
        if (depth > 18 || Math.max(off(p1), off(p2)) <= tol) {
          pts.push(p3);
          return;
        }
        const m = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const p01 = m(p0, p1), p12 = m(p1, p2), p23 = m(p2, p3);
        const p012 = m(p01, p12), p123 = m(p12, p23);
        const mid = m(p012, p123);
        split(p0, p01, p012, mid, depth + 1);
        split(mid, p123, p23, p3, depth + 1);
      };
      split(s.from, s.c1, s.c2, s.to, 0);
      return pts;
    }
  }
}

/** A path's outline as points (closed paths: the first point isn't repeated at the end). */
export function pathPoints(segments: Segment[], closed: boolean, tol = FLAT_TOLERANCE): Pt[] {
  const pts: Pt[] = [];
  for (const s of segments) {
    const p = segmentPoints(s, tol);
    pts.push(...(pts.length ? p.slice(1) : p));
  }
  if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
  return pts;
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The box round some paths [x0, y0, x1, y1] (null when there's nothing). */
export function pathsBox(paths: LaserPath[]): [number, number, number, number] | null {
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (p: Pt) => {
    b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
  };
  for (const path of paths) for (const s of path.segments) for (const p of extremePoints(s)) add(p);
  return Number.isFinite(b[0]) ? b : null;
}

/** The points of a curve that reach furthest left, right, down and up (its ends and any turning points between). */
function extremePoints(s: Segment): Pt[] {
  switch (s.kind) {
    case "line":
      return [s.from, s.to];
    case "circle":
      return [
        [s.center[0] - s.radius, s.center[1] - s.radius],
        [s.center[0] + s.radius, s.center[1] + s.radius],
      ];
    case "arc": {
      const a = arcInfo(s);
      if (!a) return [s.from, s.to];
      const out: Pt[] = [s.from, s.to];
      const lo = Math.min(a.a0, a.a0 + a.turn);
      const hi = Math.max(a.a0, a.a0 + a.turn);
      for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) {
        const t = k * (Math.PI / 2);
        out.push([a.centre[0] + a.r * Math.cos(t), a.centre[1] + a.r * Math.sin(t)]);
      }
      return out;
    }
    case "ellipse": {
      const c = Math.cos(s.angle), sn = Math.sin(s.angle);
      const hx = Math.hypot(s.rx * c, s.ry * sn);
      const hy = Math.hypot(s.rx * sn, s.ry * c);
      return [
        [s.center[0] - hx, s.center[1] - hy],
        [s.center[0] + hx, s.center[1] + hy],
      ];
    }
    case "ellipseArc":
      return ellipseArcBeziers(s).flatMap(extremePoints);
    case "bezier": {
      // Where dx/dt or dy/dt is 0: a quadratic in t for each direction.
      const out: Pt[] = [s.from, s.to];
      const at = (t: number): Pt => {
        const u = 1 - t;
        return [0, 1].map((j) => u * u * u * s.from[j] + 3 * u * u * t * s.c1[j] + 3 * u * t * t * s.c2[j] + t * t * t * s.to[j]) as Pt;
      };
      for (const j of [0, 1]) {
        const p0 = s.from[j], p1 = s.c1[j], p2 = s.c2[j], p3 = s.to[j];
        const A = -p0 + 3 * p1 - 3 * p2 + p3;
        const B = 2 * (p0 - 2 * p1 + p2);
        const C = p1 - p0;
        const roots: number[] = [];
        if (Math.abs(A) < 1e-12) {
          if (Math.abs(B) > 1e-12) roots.push(-C / B);
        } else {
          const D = B * B - 4 * A * C;
          if (D >= 0) roots.push((-B + Math.sqrt(D)) / (2 * A), (-B - Math.sqrt(D)) / (2 * A));
        }
        for (const t of roots) if (t > 0 && t < 1) out.push(at(t));
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Joining pieces into loops, and telling outer cuts from inner ones.

/**
 * Join curves end to end (either way round) into closed loops and open runs.
 * Whole circles and ellipses are loops by themselves. Pieces of an outline
 * may come in any order and direction (as OpenCascade's edges do).
 */
export function chainEdges(edges: Segment[], tol = JOIN_TOLERANCE): { loops: Segment[][]; open: Segment[][] } {
  const loops: Segment[][] = [];
  const open: Segment[][] = [];
  const pieces: { s: Segment; a: Pt; b: Pt }[] = [];
  for (const s of edges) {
    const ends = segmentEnds(s);
    if (!ends) loops.push([s]);
    else if (dist(ends[0], ends[1]) <= tol && s.kind !== "line") loops.push([s]);
    else if (dist(ends[0], ends[1]) > tol) pieces.push({ s, a: ends[0], b: ends[1] });
  }
  // Ends in a grid of cells `tol` across, so finding the next piece looks only nearby.
  const cell = (p: Pt) => [Math.floor(p[0] / tol), Math.floor(p[1] / tol)];
  const grid = new Map<string, number[]>();
  pieces.forEach((pc, i) => {
    for (const p of [pc.a, pc.b]) {
      const [x, y] = cell(p);
      const k = `${x},${y}`;
      grid.set(k, [...(grid.get(k) ?? []), i]);
    }
  });
  const used = new Array<boolean>(pieces.length).fill(false);
  const near = (p: Pt): { i: number; flip: boolean } | null => {
    const [cx, cy] = cell(p);
    let best: { i: number; flip: boolean; d: number } | null = null;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (used[i]) continue;
          const da = dist(pieces[i].a, p);
          const db = dist(pieces[i].b, p);
          if (da <= tol && (!best || da < best.d)) best = { i, flip: false, d: da };
          if (db <= tol && (!best || db < best.d)) best = { i, flip: true, d: db };
        }
    return best;
  };
  for (let start = 0; start < pieces.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const chain: Segment[] = [pieces[start].s];
    let head = pieces[start].a;
    let tail = pieces[start].b;
    let closed = false;
    // Onwards from the end…
    for (;;) {
      if (chain.length > 1 && dist(tail, head) <= tol) {
        closed = true;
        break;
      }
      const next = near(tail);
      if (!next) break;
      used[next.i] = true;
      const s = next.flip ? reverseSegment(pieces[next.i].s) : pieces[next.i].s;
      chain.push(s);
      tail = segmentEnds(s)![1];
    }
    // …then back from the start, for an open run picked up in its middle.
    if (!closed) {
      for (;;) {
        const prev = near(head);
        if (!prev) break;
        used[prev.i] = true;
        const s = prev.flip ? pieces[prev.i].s : reverseSegment(pieces[prev.i].s);
        chain.unshift(s);
        head = segmentEnds(s)![0];
        if (dist(tail, head) <= tol) {
          closed = true;
          break;
        }
      }
    }
    (closed ? loops : open).push(chain);
  }
  return { loops, open };
}

/**
 * Closed loops sorted into outer cuts (not inside any other loop) and inner
 * cuts (holes, and anything else inside a loop), cut first so the piece
 * doesn't move before its holes are done.
 */
export function sortLoops(loops: Segment[][]): LaserPath[] {
  const polys = loops.map((l) => pathPoints(l, true, 0.01));
  const areas = polys.map((p) => Math.abs(signedArea(p)));
  return loops.flatMap((segments, i): LaserPath[] => {
    if (polys[i].length < 2 || (areas[i] < 1e-9 && segments.length > 1)) return [];
    // A point just along the loop's first side (corners may touch other loops).
    const p0 = polys[i][0];
    const p1 = polys[i][1 % polys[i].length];
    const probe: Pt = [p0[0] + (p1[0] - p0[0]) * 0.37, p0[1] + (p1[1] - p0[1]) * 0.37];
    const inside = polys.some((q, j) => j !== i && areas[j] > areas[i] && pointInPolygon(probe, q));
    return [{ layer: inside ? "inner" : "outer", segments, closed: true }];
  });
}

/** Raw outline pieces (any order) as cut paths: outer and inner loops, and open runs on `openLayer`. */
export function outlinePaths(edges: Segment[], openLayer: LaserLayer = "inner"): LaserPath[] {
  const { loops, open } = chainEdges(edges);
  return [...sortLoops(loops), ...open.map((segments): LaserPath => ({ layer: openLayer, segments, closed: false }))];
}

// ---------------------------------------------------------------------------
// Moving, turning and mirroring.

/** x' = a·x + c·y + e, y' = b·x + d·y + f (moves, turns and mirrors only: no stretching). */
export type Affine = [number, number, number, number, number, number];

const apply = (m: Affine, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

export function moveSegment(s: Segment, m: Affine): Segment {
  const P = (p: Pt) => apply(m, p);
  switch (s.kind) {
    case "line":
      return { kind: "line", from: P(s.from), to: P(s.to) };
    case "arc":
      return { kind: "arc", from: P(s.from), mid: P(s.mid), to: P(s.to) };
    case "bezier":
      return { kind: "bezier", from: P(s.from), c1: P(s.c1), c2: P(s.c2), to: P(s.to) };
    case "circle":
      return { kind: "circle", center: P(s.center), radius: s.radius };
    case "ellipse": {
      const dir: Pt = [Math.cos(s.angle), Math.sin(s.angle)];
      const moved: Pt = [m[0] * dir[0] + m[2] * dir[1], m[1] * dir[0] + m[3] * dir[1]];
      return { kind: "ellipse", center: P(s.center), rx: s.rx, ry: s.ry, angle: Math.atan2(moved[1], moved[0]) };
    }
    case "ellipseArc":
      // (movePaths turns these into Bézier pieces first: mirrored, an ellipse's turning direction flips.)
      throw new Error("Part of an ellipse can't be moved as it is: use movePaths.");
  }
}

/** Paths moved (ellipse arcs become their Bézier pieces first, so mirroring them is exact). */
export function movePaths(paths: LaserPath[], m: Affine): LaserPath[] {
  return paths.map((p) => ({ ...p, segments: p.segments.flatMap((s) => (s.kind === "ellipseArc" ? ellipseArcBeziers(s) : [s])).map((s) => moveSegment(s, m)) }));
}

// ---------------------------------------------------------------------------
// Laying pieces out.

export interface LayoutOptions {
  /** Space between pieces (mm). */
  gap?: number;
  /** Rows no wider than this (mm), e.g. the laser's bed. */
  width?: number;
  /** Flip left to right (for engraving on the back). */
  mirror?: boolean;
}

/** The Bambu Lab R1's bed is 600 × 300 mm. */
export const DEFAULT_SHEET_WIDTH = 600;
export const DEFAULT_GAP = 5;

/**
 * Lay the pieces out side by side in rows (biggest first, `gap` apart, each
 * row no wider than `width`; a piece turns a quarter turn only when that's the
 * only way it fits), with the whole sheet's bottom-left corner at (0, 0).
 */
export function layoutPieces(pieces: LaserPiece[], opts: LayoutOptions = {}): LaserSheet {
  const gap = Math.max(0, opts.gap ?? DEFAULT_GAP);
  const width = Math.max(1, opts.width ?? DEFAULT_SHEET_WIDTH);
  const withBoxes = pieces.map((p, i) => ({ p, i, box: pathsBox(p.paths) })).filter((x): x is { p: LaserPiece; i: number; box: [number, number, number, number] } => !!x.box);
  const placed: { name: string; paths: LaserPath[] }[] = [];
  if (withBoxes.length === 1) {
    const { p, box } = withBoxes[0];
    placed.push({ name: p.name, paths: movePaths(p.paths, [1, 0, 0, 1, -box[0], -box[1]]) });
  } else if (withBoxes.length > 1) {
    const layout = arrangeOnBed(
      withBoxes.map(({ i, box }) => ({ id: String(i), size: [box[2] - box[0], box[3] - box[1]] as [number, number] })),
      [width, 1e6],
      gap,
    );
    withBoxes.forEach(({ p, i, box }) => {
      const place = layout.places.find((pl) => pl.id === String(i))!;
      const cx = (box[0] + box[2]) / 2;
      const cy = (box[1] + box[3]) / 2;
      // Centre on the origin, turn a quarter turn anticlockwise if it must, then to its place.
      const m: Affine = place.turned ? [0, 1, -1, 0, place.x + cy, place.y - cx] : [1, 0, 0, 1, place.x - cx, place.y - cy];
      placed.push({ name: p.name, paths: movePaths(p.paths, m) });
    });
  }
  const all = placed.flatMap((p) => p.paths);
  const box = pathsBox(all) ?? [0, 0, 0, 0];
  const W = box[2] - box[0];
  const H = box[3] - box[1];
  // To the origin, mirrored left to right if asked.
  const toSheet: Affine = opts.mirror ? [-1, 0, 0, 1, box[2], -box[1]] : [1, 0, 0, 1, -box[0], -box[1]];
  const final = placed.map((p) => ({ name: p.name, paths: movePaths(p.paths, toSheet) }));
  return {
    paths: final.flatMap((p) => p.paths),
    size: [W, H],
    pieces: final.map((p) => ({ name: p.name, box: pathsBox(p.paths) ?? [0, 0, 0, 0] })),
  };
}

/** How many paths there are on each layer. */
export function layerCounts(sheet: Pick<LaserSheet, "paths">): Record<LaserLayer, number> {
  const out: Record<LaserLayer, number> = { outer: 0, inner: 0, score: 0, engrave: 0 };
  for (const p of sheet.paths) out[p.layer]++;
  return out;
}
