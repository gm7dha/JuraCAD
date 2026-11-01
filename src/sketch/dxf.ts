/**
 * Insert DXF: reads the drawing in a DXF file (lines, arcs, circles,
 * polylines, splines, ellipses and points) and adds it to a sketch as real
 * sketch geometry, so it can be dimensioned, trimmed and extruded.
 *
 * Ends that meet are joined into one point, so closed outlines come in as
 * closed shapes. Nothing is constrained. Sizes follow the file's units (when
 * it says) times the scale chosen; the drawing's origin goes on the sketch's.
 */
import { sketchId, type EditResult } from "./ops";
import type { SketchCurve, SketchData, SketchPoint } from "./types";

type Pt = [number, number];

export type DxfEntity =
  | { kind: "line"; a: Pt; b: Pt }
  | { kind: "circle"; c: Pt; r: number }
  /** Anticlockwise from a0 to a1 (degrees), as DXF has them. */
  | { kind: "arc"; c: Pt; r: number; a0: number; a1: number }
  /** Straight or bulged pieces between vertices (bulge = tan(¼ of the turn), + anticlockwise). */
  | { kind: "polyline"; points: { p: Pt; bulge: number }[]; closed: boolean }
  | { kind: "spline"; degree: number; control: Pt[]; knots: number[]; weights: number[]; fit: Pt[]; closed: boolean }
  /** Centre, the end of the long axis (relative to the centre), short ÷ long, and the part drawn (radians). */
  | { kind: "ellipse"; c: Pt; major: Pt; ratio: number; t0: number; t1: number }
  | { kind: "point"; p: Pt };

export interface DxfDrawing {
  entities: DxfEntity[];
  /** Millimetres per drawing unit, from the file's $INSUNITS (null when it doesn't say). */
  unitMm: number | null;
  /** The file's unit, in words (for the panel), or null. */
  unitName: string | null;
  /** Kinds of thing in the file that can't be brought in (TEXT, HATCH…), with how many of each. */
  skipped: Record<string, number>;
}

/** $INSUNITS codes JuraCAD understands: millimetres per unit, and the unit's name. */
const UNITS: Record<number, [number, string]> = {
  1: [25.4, "inches"],
  2: [304.8, "feet"],
  4: [1, "millimetres"],
  5: [10, "centimetres"],
  6: [1000, "metres"],
  8: [0.0254, "thousandths of an inch"],
  9: [0.0254 / 1000, "millionths of an inch"],
  10: [914.4, "yards"],
  13: [0.001, "microns"],
  14: [100, "decimetres"],
};

/** A problem with the file, in plain English (anything else thrown while reading one is a bug or a damaged file). */
export class DxfError extends Error {}

/** Files bigger than this (characters) aren't read: they'd freeze the page. */
export const MAX_DXF_SIZE = 20 * 1024 * 1024;
/** Nor drawings with more than this many shapes. */
export const MAX_DXF_ENTITIES = 20000;

const TWO_PI = 2 * Math.PI;
/** An angle brought into 0…period (so huge values from a broken file can't make loops run for ever). */
const wrapAngle = (a: number, period: number) => ((a % period) + period) % period;

/** Every number in an entity is a real, finite number (a broken file can hold "abc" or 1e999). */
function finite(e: DxfEntity): boolean {
  const nums: number[] = [];
  const add = (...v: number[]) => nums.push(...v);
  switch (e.kind) {
    case "line":
      add(...e.a, ...e.b);
      break;
    case "circle":
      add(...e.c, e.r);
      break;
    case "arc":
      add(...e.c, e.r, e.a0, e.a1);
      break;
    case "point":
      add(...e.p);
      break;
    case "polyline":
      for (const q of e.points) add(...q.p, q.bulge);
      break;
    case "spline":
      add(e.degree, ...e.control.flat(), ...e.knots, ...e.weights, ...e.fit.flat());
      break;
    case "ellipse":
      add(...e.c, ...e.major, e.ratio, e.t0, e.t1);
      break;
  }
  return nums.every(Number.isFinite);
}

/** Read a DXF file's text. Throws a plain-English error when it isn't a DXF drawing. */
export function parseDxf(text: string): DxfDrawing {
  if (text.length > MAX_DXF_SIZE) throw new DxfError("That DXF file is too big to bring in (over 20 MB). Open it in a drawing program and save just the part you need.");
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new DxfError("That doesn't look like a DXF file (or it's a binary DXF, which can't be read). Save it as an ASCII DXF and try again.");
    pairs.push([code, lines[i + 1].trim()]);
  }
  if (!pairs.some(([c, v]) => c === 0 && v === "SECTION")) throw new DxfError("That doesn't look like a DXF file. Choose a .dxf drawing.");

  // Units, from the header.
  let unitMm: number | null = null;
  let unitName: string | null = null;
  const u = pairs.findIndex(([c, v]) => c === 9 && v === "$INSUNITS");
  if (u >= 0 && pairs[u + 1]?.[0] === 70) {
    const known = UNITS[Number(pairs[u + 1][1])];
    if (known) [unitMm, unitName] = known;
  }

  // The ENTITIES section.
  let start = -1;
  for (let i = 0; i + 1 < pairs.length; i++) if (pairs[i][0] === 0 && pairs[i][1] === "SECTION" && pairs[i + 1][0] === 2 && pairs[i + 1][1] === "ENTITIES") start = i + 2;
  const entities: DxfEntity[] = [];
  const skipped: Record<string, number> = {};
  if (start < 0) return { entities, unitMm, unitName, skipped };

  // Split into entities: each starts with a 0 code.
  const items: { type: string; g: [number, string][] }[] = [];
  for (let i = start; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0) {
      if (v === "ENDSEC") break;
      items.push({ type: v, g: [] });
    } else items[items.length - 1]?.g.push([c, v]);
  }

  /** A value by its code: the fallback when it's missing, NaN when it isn't a number (the entity is then left out). */
  const num = (g: [number, string][], code: number, fallback = 0) => {
    const f = g.find(([c]) => c === code);
    if (!f || f[1] === "") return fallback;
    const n = Number(f[1]);
    return Number.isFinite(n) ? n : NaN;
  };
  const all = (g: [number, string][], code: number) => g.filter(([c]) => c === code).map(([, v]) => Number(v));
  /** Points from paired x (code) and y (code + 10) values, in order. */
  const points = (g: [number, string][], xCode: number): Pt[] => {
    const out: Pt[] = [];
    let x: number | null = null;
    for (const [c, v] of g) {
      if (c === xCode) x = Number(v);
      else if (c === xCode + 10 && x !== null) {
        out.push([x, Number(v)]);
        x = null;
      }
    }
    return out;
  };

  for (let k = 0; k < items.length; k++) {
    const { type, g } = items[k];
    switch (type) {
      case "LINE":
        entities.push({ kind: "line", a: [num(g, 10), num(g, 20)], b: [num(g, 11), num(g, 21)] });
        break;
      case "CIRCLE":
        entities.push({ kind: "circle", c: [num(g, 10), num(g, 20)], r: num(g, 40) });
        break;
      case "ARC":
        entities.push({ kind: "arc", c: [num(g, 10), num(g, 20)], r: num(g, 40), a0: num(g, 50), a1: num(g, 51) });
        break;
      case "POINT":
        entities.push({ kind: "point", p: [num(g, 10), num(g, 20)] });
        break;
      case "LWPOLYLINE": {
        // Vertices in order; a bulge (42) belongs to the vertex before it.
        const pts: { p: Pt; bulge: number }[] = [];
        let x: number | null = null;
        for (const [c, v] of g) {
          if (c === 10) x = Number(v);
          else if (c === 20 && x !== null) {
            pts.push({ p: [x, Number(v)], bulge: 0 });
            x = null;
          } else if (c === 42 && pts.length) pts[pts.length - 1].bulge = Number(v) || 0;
        }
        entities.push({ kind: "polyline", points: pts, closed: (num(g, 70) & 1) === 1 });
        break;
      }
      case "POLYLINE": {
        // The old kind: VERTEX entities follow, up to SEQEND.
        const pts: { p: Pt; bulge: number }[] = [];
        while (items[k + 1]?.type === "VERTEX") {
          k++;
          const vg = items[k].g;
          // Vertices that are only spline frame points are left out.
          if (num(vg, 70) & 16) continue;
          pts.push({ p: [num(vg, 10), num(vg, 20)], bulge: num(vg, 42) });
        }
        if (items[k + 1]?.type === "SEQEND") k++;
        entities.push({ kind: "polyline", points: pts, closed: (num(g, 70) & 1) === 1 });
        break;
      }
      case "SPLINE":
        entities.push({
          kind: "spline",
          degree: num(g, 71, 3),
          control: points(g, 10),
          knots: all(g, 40),
          weights: all(g, 41),
          fit: points(g, 11),
          closed: (num(g, 70) & 1) === 1,
        });
        break;
      case "ELLIPSE":
        entities.push({ kind: "ellipse", c: [num(g, 10), num(g, 20)], major: [num(g, 11), num(g, 21)], ratio: num(g, 40, 1), t0: num(g, 41, 0), t1: num(g, 42, 2 * Math.PI) });
        break;
      case "SEQEND":
      case "VERTEX":
        break;
      default:
        skipped[type] = (skipped[type] ?? 0) + 1;
    }
    if (entities.length > MAX_DXF_ENTITIES)
      throw new DxfError(`That drawing has more than ${MAX_DXF_ENTITIES.toLocaleString("en")} shapes, too many for a sketch. Open it in a drawing program and save just the part you need.`);
  }
  // Long polylines and splines count by their points.
  const pieces = entities.reduce((n, e) => n + (e.kind === "polyline" ? e.points.length : e.kind === "spline" ? e.control.length + e.fit.length : 1), 0);
  if (pieces > 2.5 * MAX_DXF_ENTITIES)
    throw new DxfError(`That drawing has more than ${(2.5 * MAX_DXF_ENTITIES).toLocaleString("en")} points and pieces, too many for a sketch. Open it in a drawing program and save just the part you need.`);
  // Shapes with broken numbers in them are left out (and counted).
  const good = entities.filter(finite);
  if (good.length < entities.length) skipped["shapes with unreadable numbers"] = entities.length - good.length;
  return { entities: good, unitMm, unitName, skipped };
}

/** A point on a B-spline (de Boor), with weights for a rational one. */
function deBoor(degree: number, control: Pt[], knots: number[], weights: number[], t: number): Pt {
  const n = control.length;
  let k = degree;
  while (k < n - 1 && t >= knots[k + 1]) k++;
  const w = (i: number) => weights[i] ?? 1;
  const d = Array.from({ length: degree + 1 }, (_, j) => {
    const i = j + k - degree;
    return [control[i][0] * w(i), control[i][1] * w(i), w(i)];
  });
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const den = knots[i + degree - r + 1] - knots[i];
      const a = den > 0 ? (t - knots[i]) / den : 0;
      d[j] = [0, 1, 2].map((q) => (1 - a) * d[j - 1][q] + a * d[j][q]);
    }
  }
  const [x, y, ww] = d[degree];
  return [x / ww, y / ww];
}

/** Points along a spline from its control points (when the file gives no points it passes through). */
export function sampleSpline(e: Extract<DxfEntity, { kind: "spline" }>): Pt[] {
  const { degree, control, knots, weights } = e;
  if (control.length < 2) return [...control];
  if (!Number.isInteger(degree) || degree < 1 || degree > 11 || knots.length !== control.length + degree + 1) return [...control];
  const t0 = knots[degree];
  const t1 = knots[control.length];
  const steps = Math.max(8, Math.min(200, control.length * 4));
  return Array.from({ length: steps + 1 }, (_, i) => deBoor(degree, control, knots, weights, i === steps ? t1 - 1e-12 * Math.max(1, Math.abs(t1)) : t0 + ((t1 - t0) * i) / steps));
}

export interface InsertResult extends EditResult {
  curveIds: string[];
  /** How many lines, arcs, circles, splines, ellipses and points came in. */
  count: number;
}

/**
 * Add a DXF drawing to a sketch, `scale` × the file's own unit (or × 1 mm when
 * the file doesn't say). New shapes are construction geometry if asked.
 */
export function insertDxf(s: SketchData, drawing: DxfDrawing, scale: number, construction = false): InsertResult {
  const fail = (error: string): InsertResult => ({ sketch: s, curveIds: [], count: 0, error });
  if (!(scale > 0)) return fail("The scale must be more than 0.");
  const k = scale * (drawing.unitMm ?? 1);
  const points: SketchPoint[] = [];
  const curves: SketchCurve[] = [];
  // Everything's size, to judge which ends meet.
  let size = 0;
  const grow = (p: Pt) => (size = Math.max(size, Math.abs(p[0] * k), Math.abs(p[1] * k)));
  for (const e of drawing.entities) {
    if (e.kind === "line") [e.a, e.b].forEach(grow);
    else if (e.kind === "polyline") e.points.forEach((q) => grow(q.p));
    else if (e.kind === "point") grow(e.p);
    else if (e.kind === "spline") [...e.control, ...e.fit].forEach(grow);
    else grow([Math.abs(e.c[0]) + ("r" in e ? e.r : Math.hypot(e.major[0], e.major[1])), Math.abs(e.c[1])]);
  }
  const tol = 1e-6 * Math.max(1, size);
  const byKey = new Map<string, string>();
  /** A point at p (drawing units), shared with any end already there. */
  const at = (p: Pt, shared = true): string => {
    const x = p[0] * k;
    const y = p[1] * k;
    const key = `${Math.round(x / tol)},${Math.round(y / tol)}`;
    const known = shared ? byKey.get(key) : undefined;
    if (known) return known;
    const id = sketchId("p");
    points.push({ id, x, y });
    if (shared) byKey.set(key, id);
    return id;
  };
  let count = 0;
  const line = (a: Pt, b: Pt) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) * k <= tol) return;
    curves.push({ id: sketchId("l"), type: "line", p1: at(a), p2: at(b), construction });
  };
  /** An arc anticlockwise from angle a0 to a1 (radians). */
  const arc = (c: Pt, r: number, a0: number, a1: number) => {
    if (r * k <= tol) return;
    const start: Pt = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
    const end: Pt = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
    curves.push({ id: sketchId("a"), type: "arc", center: at(c, false), start: at(start), end: at(end), construction });
  };
  const spline = (raw: Pt[], closed: boolean) => {
    // Points on top of the one before are dropped (and a closing point on top of the first).
    const pts = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) * k > tol);
    if (closed && pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) * k <= tol) pts.pop();
    if (pts.length < 2 || (closed && pts.length < 3)) return false;
    const ids = pts.map((p) => at(p, false));
    // The ends of an open spline join what meets them.
    if (!closed) {
      ids[0] = rejoin(ids[0]);
      ids[ids.length - 1] = rejoin(ids[ids.length - 1]);
    }
    curves.push({ id: sketchId("sp"), type: "spline", points: ids, closed, construction });
    return true;
  };
  /** Swap a lone point for an end already at the same place (or register it as one). */
  const rejoin = (id: string): string => {
    const p = points.find((q) => q.id === id)!;
    const key = `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
    const known = byKey.get(key);
    if (known && known !== id) {
      points.splice(points.indexOf(p), 1);
      return known;
    }
    byKey.set(key, id);
    return id;
  };

  for (const e of drawing.entities) {
    switch (e.kind) {
      case "line":
        line(e.a, e.b);
        count++;
        break;
      case "circle":
        if (e.r * k > tol) {
          curves.push({ id: sketchId("k"), type: "circle", center: at(e.c, false), radius: e.r * k, construction });
          count++;
        }
        break;
      case "arc": {
        const a0 = (wrapAngle(e.a0, 360) * Math.PI) / 180;
        let a1 = (wrapAngle(e.a1, 360) * Math.PI) / 180;
        if (a1 <= a0) a1 += TWO_PI;
        arc(e.c, e.r, a0, a1);
        count++;
        break;
      }
      case "point":
        points.push({ id: sketchId("p"), x: e.p[0] * k, y: e.p[1] * k, standalone: true });
        count++;
        break;
      case "polyline": {
        const n = e.points.length;
        const last = e.closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
          const p = e.points[i].p;
          const q = e.points[(i + 1) % n].p;
          const b = e.points[i].bulge;
          if (Math.abs(b) < 1e-9) line(p, q);
          else {
            // A bulged piece is an arc turning 4·atan(bulge) (anticlockwise when positive) from p to q.
            const turn = 4 * Math.atan(b);
            const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (chord * k <= tol) continue;
            const r = chord / (2 * Math.sin(Math.abs(turn) / 2));
            const m: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
            // From the chord's middle to the centre: square to the chord, to the left when anticlockwise (less than a half turn).
            const off = r * Math.cos(Math.abs(turn) / 2) * Math.sign(b);
            const dir: Pt = [(q[0] - p[0]) / chord, (q[1] - p[1]) / chord];
            const c: Pt = [m[0] - dir[1] * off, m[1] + dir[0] * off];
            const ang = (x: Pt) => Math.atan2(x[1] - c[1], x[0] - c[0]);
            const [from, to] = b > 0 ? [p, q] : [q, p];
            let a1 = ang(to);
            const a0 = ang(from);
            if (a1 <= a0) a1 += TWO_PI;
            arc(c, r, a0, a1);
          }
        }
        if (n >= 2) count++;
        break;
      }
      case "spline": {
        const fit = e.fit.length >= 2;
        const pts = fit ? e.fit : sampleSpline(e);
        const first = pts[0];
        const lastP = pts[pts.length - 1];
        const closed = e.closed || (pts.length > 3 && !!first && Math.hypot(first[0] - lastP[0], first[1] - lastP[1]) * k <= tol);
        if (spline(pts, closed)) count++;
        break;
      }
      case "ellipse": {
        const len = Math.hypot(e.major[0], e.major[1]);
        if (len * k <= tol || !(e.ratio > 0)) break;
        const turn = e.t1 - e.t0;
        const whole = Math.abs(turn - TWO_PI) < 1e-6 || Math.abs(turn) < 1e-9 || Math.abs(turn) > TWO_PI;
        const major: Pt = [e.c[0] + e.major[0], e.c[1] + e.major[1]];
        const minor: Pt = [e.c[0] - e.major[1] * e.ratio, e.c[1] + e.major[0] * e.ratio];
        if (whole) {
          curves.push({ id: sketchId("el"), type: "ellipse", center: at(e.c, false), major: at(major, false), minor: at(minor, false), construction });
          count++;
          break;
        }
        // Part of an ellipse: a real elliptical arc, anticlockwise from t0 to t1 (its ends join what meets them).
        const ang = Math.atan2(e.major[1], e.major[0]);
        const onIt = (t: number): Pt => {
          const x = len * Math.cos(t);
          const y = len * e.ratio * Math.sin(t);
          return [e.c[0] + x * Math.cos(ang) - y * Math.sin(ang), e.c[1] + x * Math.sin(ang) + y * Math.cos(ang)];
        };
        const t0 = wrapAngle(e.t0, TWO_PI);
        const t1 = wrapAngle(e.t1, TWO_PI);
        const start = onIt(t0);
        const end = onIt(t1);
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) * k <= tol) break;
        curves.push({ id: sketchId("el"), type: "ellipse", center: at(e.c, false), major: at(major, false), minor: at(minor, false), start: at(start), end: at(end), construction });
        count++;
        break;
      }
    }
  }
  if (!count) {
    const what = Object.keys(drawing.skipped);
    return fail(what.length ? `Nothing in that file can be brought in: it only has ${what.join(", ")}. Lines, arcs, circles, polylines, splines and ellipses can.` : "That DXF file has no drawing in it.");
  }
  return { sketch: { ...s, points: [...s.points, ...points], curves: [...s.curves, ...curves] }, curveIds: curves.map((c) => c.id), count };
}

/** A plain-English note of what was brought in and what was left out. */
export function insertSummary(drawing: DxfDrawing, count: number, scale: number): string {
  const unit = drawing.unitName ? ` The file is in ${drawing.unitName}${scale !== 1 ? `, scaled × ${scale}` : ""}.` : scale !== 1 ? ` Scaled × ${scale}.` : " The file doesn't say its units, so 1 unit = 1 mm.";
  const left = Object.entries(drawing.skipped);
  const skipped = left.length ? ` Left out: ${left.map(([t, n]) => `${n} ${t}`).join(", ")} (only lines, arcs, circles, polylines, splines, ellipses and points come in).` : "";
  return `Brought in ${count} shape${count === 1 ? "" : "s"}.${unit}${skipped}`;
}
