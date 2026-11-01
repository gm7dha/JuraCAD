/**
 * A sweep path cut into the stretches a twisted (or "kept facing one way")
 * sweep is built from, one at a time: pure 2D work on the path sketch's
 * segments, no OpenCascade.
 *
 * - Sharp corners split the path into smooth runs; the sweep is made run by
 *   run and each corner is filled by turning the profile round it.
 * - A closed loop is started where the profile sits (where its plane crosses
 *   the path), so the sweep goes all the way round from the profile and back.
 */
import type { Pt, Segment } from "../sketch/regions";

/** Joins turning by more than this (degrees) count as sharp corners, the same limit the twist always used. */
export const CORNER_DEG = 1;

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const TAU = 2 * Math.PI;

/** Centre, radius, start angle and signed sweep of a three-point arc. */
export function arcGeometry(from: Pt, mid: Pt, to: Pt): { c: Pt; r: number; a0: number; sweep: number } {
  const [ax, ay] = from;
  const [bx, by] = mid;
  const [cx, cy] = to;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const c: Pt = [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
  const ang = (p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(from);
  const wrap = (x: number) => ((x % TAU) + TAU) % TAU;
  const ccw = wrap(ang(to) - a0) || TAU;
  const sweep = wrap(ang(mid) - a0) < ccw ? ccw : ccw - TAU;
  return { c, r: Math.hypot(ax - c[0], ay - c[1]), a0, sweep };
}

const ellipsePoint = (s: { center: Pt; rx: number; ry: number; angle: number }, t: number): Pt => {
  const [ca, sa] = [Math.cos(s.angle), Math.sin(s.angle)];
  const x = s.rx * Math.cos(t);
  const y = s.ry * Math.sin(t);
  return [s.center[0] + x * ca - y * sa, s.center[1] + x * sa + y * ca];
};

/** Does a part of an ellipse walk its parameter forwards (from t0 to t1)? */
const forwards = (s: Extract<Segment, { kind: "ellipseArc" }>) => {
  const p = ellipsePoint(s, s.t0);
  const q = ellipsePoint(s, s.t1);
  return Math.hypot(p[0] - s.from[0], p[1] - s.from[1]) <= Math.hypot(q[0] - s.from[0], q[1] - s.from[1]);
};

/** The point a fraction `t` (0…1, by parameter) along a segment, walking it the way the path does. Whole circles and ellipses go anticlockwise from angle 0. */
export function segmentAt(s: Segment, t: number): Pt {
  switch (s.kind) {
    case "line":
      return lerp(s.from, s.to, t);
    case "arc": {
      const g = arcGeometry(s.from, s.mid, s.to);
      const a = g.a0 + g.sweep * t;
      return [g.c[0] + g.r * Math.cos(a), g.c[1] + g.r * Math.sin(a)];
    }
    case "circle":
      return [s.center[0] + s.radius * Math.cos(TAU * t), s.center[1] + s.radius * Math.sin(TAU * t)];
    case "bezier": {
      const u = 1 - t;
      const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      const q = [s.from, s.c1, s.c2, s.to];
      return [q.reduce((acc, p, i) => acc + p[0] * k[i], 0), q.reduce((acc, p, i) => acc + p[1] * k[i], 0)];
    }
    case "ellipse":
      return ellipsePoint(s, TAU * t);
    case "ellipseArc":
      return ellipsePoint(s, forwards(s) ? s.t0 + (s.t1 - s.t0) * t : s.t1 - (s.t1 - s.t0) * t);
  }
}

/** Which way the path heads at the start (end 0) or finish (end 1) of a segment (unit vector). */
export function segmentDirection(s: Segment, end: 0 | 1): Pt {
  const h = 1e-6;
  const a = segmentAt(s, end === 0 ? 0 : 1 - h);
  const b = segmentAt(s, end === 0 ? h : 1);
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

/** A segment cut in two at fraction `t` (by parameter); both halves keep its direction. */
export function splitSegment(s: Segment, t: number): [Segment, Segment] {
  const p = segmentAt(s, t);
  switch (s.kind) {
    case "line":
      return [
        { kind: "line", from: s.from, to: p },
        { kind: "line", from: p, to: s.to },
      ];
    case "arc":
      return [
        { kind: "arc", from: s.from, mid: segmentAt(s, t / 2), to: p },
        { kind: "arc", from: p, mid: segmentAt(s, (1 + t) / 2), to: s.to },
      ];
    case "bezier": {
      const l = (a: Pt, c: Pt): Pt => lerp(a, c, t);
      const p01 = l(s.from, s.c1), p12 = l(s.c1, s.c2), p23 = l(s.c2, s.to);
      const p012 = l(p01, p12), p123 = l(p12, p23);
      return [
        { kind: "bezier", from: s.from, c1: p01, c2: p012, to: p },
        { kind: "bezier", from: p, c1: p123, c2: p23, to: s.to },
      ];
    }
    case "ellipseArc": {
      const fw = forwards(s);
      const tm = fw ? s.t0 + (s.t1 - s.t0) * t : s.t1 - (s.t1 - s.t0) * t;
      return fw
        ? [
            { ...s, t0: s.t0, t1: tm, from: s.from, to: p },
            { ...s, t0: tm, t1: s.t1, from: p, to: s.to },
          ]
        : [
            { ...s, t0: tm, t1: s.t1, from: s.from, to: p },
            { ...s, t0: s.t0, t1: tm, from: p, to: s.to },
          ];
    }
    case "circle":
      // A whole loop: from angle 0 to the cut, and on round back to angle 0.
      return [
        { kind: "arc", from: segmentAt(s, 0), mid: segmentAt(s, t / 2), to: p },
        { kind: "arc", from: p, mid: segmentAt(s, (1 + t) / 2), to: segmentAt(s, 0) },
      ];
    case "ellipse": {
      const e = { center: s.center, rx: s.rx, ry: s.ry, angle: s.angle };
      return [
        { kind: "ellipseArc", ...e, t0: 0, t1: TAU * t, from: segmentAt(s, 0), to: p },
        { kind: "ellipseArc", ...e, t0: TAU * t, t1: TAU, from: p, to: segmentAt(s, 0) },
      ];
    }
  }
}

/** A place on a run of segments: segment `index`, fraction `t` along it. */
export interface PathPlace {
  index: number;
  t: number;
}

/**
 * Where on the loop the profile sits: of the places where `side` changes sign
 * (the profile's plane crossing the path), the one nearest the profile
 * (`distance`); with no crossing, simply the nearest place.
 */
export function profilePlace(segments: Segment[], side: (p: Pt) => number, distance: (p: Pt) => number, samples = 64): PathPlace {
  let best: PathPlace | null = null;
  let bestD = Infinity;
  let near: PathPlace = { index: 0, t: 0 };
  let nearD = Infinity;
  segments.forEach((s, index) => {
    let prevT = 0;
    let prev = side(segmentAt(s, 0));
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      const p = segmentAt(s, t);
      const d = distance(p);
      if (d < nearD) {
        nearD = d;
        near = { index, t };
      }
      const f = side(p);
      if (k > 0 && (f === 0 || (prev < 0) !== (f < 0))) {
        // Halve down to the crossing.
        let [lo, hi, flo] = [prevT, t, prev];
        for (let i = 0; i < 60; i++) {
          const m = (lo + hi) / 2;
          const fm = side(segmentAt(s, m));
          if (fm === 0) {
            lo = hi = m;
            break;
          }
          if ((fm < 0) === (flo < 0)) {
            lo = m;
            flo = fm;
          } else hi = m;
        }
        const tc = (lo + hi) / 2;
        const dc = distance(segmentAt(s, tc));
        if (dc < bestD) {
          bestD = dc;
          best = { index, t: tc };
        }
      }
      prev = f;
      prevT = t;
    }
  });
  return best ?? near;
}

/** The same closed loop walked from `place` all the way round back to it (the segment there cut in two). */
export function loopFrom(segments: Segment[], place: PathPlace): Segment[] {
  const end = 1e-9;
  if (place.t <= end) return [...segments.slice(place.index), ...segments.slice(0, place.index)];
  if (place.t >= 1 - end) return [...segments.slice(place.index + 1), ...segments.slice(0, place.index + 1)];
  const [a, b] = splitSegment(segments[place.index], place.t);
  return [b, ...segments.slice(place.index + 1), ...segments.slice(0, place.index), a];
}

const turnDeg = (a: Pt, b: Pt) => (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;

/**
 * The path split at its sharp corners into smooth runs, in order.
 * `cornerAfter[i]`: a sharp corner follows run i (for a closed loop the last
 * run's is the corner, if any, where the loop comes back to its start).
 * A closed loop with no corners at all is cut into two runs, so each run has
 * two ends.
 */
export function smoothRuns(segments: Segment[], closed: boolean): { runs: Segment[][]; cornerAfter: boolean[] } {
  const runs: Segment[][] = [[segments[0]]];
  const cornerAfter: boolean[] = [];
  for (let i = 1; i < segments.length; i++) {
    if (turnDeg(segmentDirection(segments[i - 1], 1), segmentDirection(segments[i], 0)) > CORNER_DEG) {
      cornerAfter.push(true);
      runs.push([segments[i]]);
    } else runs[runs.length - 1].push(segments[i]);
  }
  if (!closed) {
    cornerAfter.push(false);
    return { runs, cornerAfter };
  }
  const closing = turnDeg(segmentDirection(segments[segments.length - 1], 1), segmentDirection(segments[0], 0)) > CORNER_DEG;
  cornerAfter.push(closing);
  if (runs.length === 1 && !closing) {
    // Smooth all the way round: two halves.
    const only = runs[0];
    if (only.length >= 2) {
      const h = Math.ceil(only.length / 2);
      return { runs: [only.slice(0, h), only.slice(h)], cornerAfter: [false, false] };
    }
    const [a, b] = splitSegment(only[0], 0.5);
    return { runs: [[a], [b]], cornerAfter: [false, false] };
  }
  return { runs, cornerAfter };
}

/** Does an open or closed run of segments turn sharply anywhere (including, when closed, where it comes back to its start)? */
export function hasSharpCorner(segments: Segment[], closed: boolean): boolean {
  const { cornerAfter } = smoothRuns(segments, closed);
  return cornerAfter.some(Boolean);
}

/** A twist on a closed loop must come back round to where it started: a whole number of turns. */
export function wholeTurns(twistDeg: number): boolean {
  const turns = twistDeg / 360;
  return Math.abs(turns - Math.round(turns)) < 1e-6;
}

/** What to say when a closed loop's twist isn't a whole number of turns. */
export function wholeTurnsMessage(twistDeg: number): string {
  const nearest = Math.round(twistDeg / 360) * 360 || (twistDeg < 0 ? -360 : 360);
  const shown = Number(twistDeg.toFixed(3));
  return `On a closed loop the twist has to be a whole number of turns (360°, 720°, …) so the profile meets itself again where it started. ${shown}° isn't — try ${nearest}°, or 0° for no twist.`;
}
