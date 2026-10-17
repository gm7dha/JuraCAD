/**
 * Sheet metal: a part made of flat walls of one thickness joined by bends,
 * like Onshape's sheet metal. The part is kept as this small model — a base
 * wall from a sketch, and flanges bent up (or down) off the walls' straight
 * edges — so the folded part and its flat pattern (for laser cutting) always
 * come from the same thing.
 *
 * Each wall is a flat outline in its own frame: it covers its outline in
 * (u, v) and runs from 0 to the thickness along n. Outlines go round
 * anticlockwise, so each edge's outside is on its right. Flange walls are
 * rectangles: edge 0 is where they bend off their parent, 1 and 3 their sides,
 * 2 their tip.
 *
 * A flange's length is measured on the outside, from the face it bends away
 * from to its tip (for a right-angle flange: how tall it stands). The flat
 * pattern adds each bend's allowance, angle × (radius + K-factor × thickness).
 */
import type { Segment } from "../sketch/regions";

export type V3 = [number, number, number];
export type P2 = [number, number];

export interface Frame3 {
  origin: V3;
  u: V3;
  v: V3;
  n: V3;
}

/** Where a wall lies in the flat pattern: local (x, y) → origin + x·u + y·v. */
export interface Flat2 {
  origin: P2;
  u: P2;
  v: P2;
}

export interface FlangeSpec {
  id: string;
  /** The wall it bends off, and which of that wall's edges. */
  wall: string;
  edge: number;
  /** Outside length, from the face it bends away from to its tip (mm). */
  length: number;
  /** Bend angle in degrees (90 = straight up), more than 0 and less than 180. */
  angle: number;
  /** Bend the other way (down instead of up). */
  down: boolean;
  /** The flat part's length straight after the bend, instead of working it out from `length` (sheets from an open outline). */
  straight?: number;
  /** Shorten the flange this much at each end of the edge (a bend relief is cut at each end so it can bend). */
  inset?: number;
  /** Its own inside bend radius (hems fold back with a tiny one), instead of the sheet's. */
  radius?: number;
  /** A hem: the edge folded right back on itself (angle 180, `straight` the length of the folded-over part). */
  hem?: boolean;
  /**
   * Close the corner where this flange meets another on the next edge round
   * (both full-length, at 90°, on a square corner): the walls are extended so
   * one laps over the other's end instead of leaving a gap.
   */
  closeCorners?: boolean;
  /** The shape of the bend relief notches cut when the flange is shortened (missing = rectangle). */
  reliefShape?: ReliefShape;
  /** Where this flange meets another at a corner of their wall (and the corner isn't closed): a relief cut there. */
  cornerRelief?: "round" | "square";
}

/** Bend relief notches: square-ended, round-ended (obround), or a thin tear. */
export type ReliefShape = "rectangle" | "round" | "tear";

/** A relief cut where two bends meet at a corner of a wall (in the wall's coordinates): a circle or square of half-size `r` on the corner. */
export interface CornerRelief {
  wall: string;
  at: P2;
  /** The two edges' directions away from the corner (along the first, then the second). */
  e1: P2;
  e2: P2;
  r: number;
  shape: "round" | "square";
  /** The two flanges meeting there. */
  flanges: [string, string];
  /** How far it reaches below the wall's bottom and above its top (the bends' radius). */
  below: number;
  above: number;
}

/** A corner relief's outline in its wall's coordinates (a circle as many points, or the square). */
export function cornerReliefPoints(c: CornerRelief, steps = 32): P2[] {
  const at = (s: number, t: number): P2 => [c.at[0] + c.e1[0] * s + c.e2[0] * t, c.at[1] + c.e1[1] * s + c.e2[1] * t];
  if (c.shape === "square") return [at(-c.r, -c.r), at(c.r, -c.r), at(c.r, c.r), at(-c.r, c.r)];
  return Array.from({ length: steps }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return at(c.r * Math.cos(a), c.r * Math.sin(a));
  });
}

export interface TabSpec {
  id: string;
  wall: string;
  /** In the wall's own coordinates. */
  outline: Segment[];
  holes: Segment[][];
}

export interface SheetSpec {
  thickness: number;
  /** Inside bend radius. */
  radius: number;
  /** Where the material neither stretches nor squashes in a bend, as a fraction of the thickness from the inside (0.45 is usual). */
  k: number;
  base: { frame: Frame3; outer: Segment[]; holes: Segment[][] };
  flanges: FlangeSpec[];
  /** Tabs: flat shapes sketched on a wall's face, joined onto that wall. */
  tabs?: TabSpec[];
}

export interface Wall {
  id: string;
  frame: Frame3;
  outline: Segment[];
  holes: Segment[][];
  flat: Flat2;
  /** Flange walls: edge 0 is the bend. */
  bendEdge?: number;
  /** Tabs: extra flat shapes joined onto the wall (in its coordinates). */
  tabs?: { outline: Segment[]; holes: Segment[][] }[];
}

export interface Bend {
  flangeId: string;
  parent: string;
  /** The parent's edge it bends off. */
  edge: number;
  child: string;
  /** How much shorter than its edge it is at each end, and the relief notches cut into the parent there (in the parent's coordinates, start end first). */
  inset: number;
  reliefs: Segment[][];
  /** The bend's inside radius, angle (degrees), which way, and the flat wall's height after it. */
  radius: number;
  angle: number;
  down: boolean;
  straight: number;
  /** The bend's cross-section, drawn in the plane through `start` with x along `out` and y along `up`, swept along `along` for `length`. */
  start: V3;
  out: V3;
  up: V3;
  along: V3;
  length: number;
  profile: Segment[];
  /** Flat pattern: the line down the middle of the bend, and the strip's width (the bend allowance). */
  flatLine: [P2, P2];
  allowance: number;
  /**
   * Where the bend's strip lies in the flat pattern: a point `x` along the bend
   * (from `start`, along `along`) and `s` across it (unrolled, from the parent's
   * side, 0 to `allowance`) is at origin + x·u + s·v.
   */
  flat: Flat2;
}

export interface FoldedSheet {
  walls: Wall[];
  bends: Bend[];
  /** Relief cuts where bends meet at a wall's corners. */
  cornerReliefs?: CornerRelief[];
  /** Flange id → why it couldn't be made. */
  errors: Record<string, string>;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add2 = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: P2, s: number): P2 => [a[0] * s, a[1] * s];

/** A wall's local point in 3D (on its 0 side, or `h` along n). */
export function wallPoint(f: Frame3, p: P2, h = 0): V3 {
  return add(add(add(f.origin, mul(f.u, p[0])), mul(f.v, p[1])), mul(f.n, h));
}

/** A wall's local point in the flat pattern. */
export function flatPoint(f: Flat2, p: P2): P2 {
  return add2(add2(f.origin, mul2(f.u, p[0])), mul2(f.v, p[1]));
}


/** The outline as points (curves sampled), anticlockwise. */
export function outlinePoints(segments: Segment[], steps = 12): P2[] {
  // The start of each piece, then points along it (not its end, which is the next piece's start).
  const out: P2[] = [];
  for (const s of segments) {
    switch (s.kind) {
      case "line":
        out.push(s.from);
        break;
      case "arc": {
        const c = circleCentre(s.from, s.mid, s.to);
        if (!c) {
          out.push(s.from);
          break;
        }
        const r = Math.hypot(s.from[0] - c[0], s.from[1] - c[1]);
        const a0 = Math.atan2(s.from[1] - c[1], s.from[0] - c[0]);
        const am = Math.atan2(s.mid[1] - c[1], s.mid[0] - c[0]);
        const a1 = Math.atan2(s.to[1] - c[1], s.to[0] - c[0]);
        // Which way round passes through the middle point.
        const ccw = ((am - a0 + 4 * Math.PI) % (2 * Math.PI)) < ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI));
        let sweep = ccw ? (a1 - a0 + 4 * Math.PI) % (2 * Math.PI) : -((a0 - a1 + 4 * Math.PI) % (2 * Math.PI));
        if (Math.abs(sweep) < 1e-12) sweep = ccw ? 2 * Math.PI : -2 * Math.PI;
        for (let k = 0; k < steps; k++) out.push([c[0] + r * Math.cos(a0 + (sweep * k) / steps), c[1] + r * Math.sin(a0 + (sweep * k) / steps)]);
        break;
      }
      case "bezier":
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
          out.push([
            w[0] * s.from[0] + w[1] * s.c1[0] + w[2] * s.c2[0] + w[3] * s.to[0],
            w[0] * s.from[1] + w[1] * s.c1[1] + w[2] * s.c2[1] + w[3] * s.to[1],
          ]);
        }
        break;
      case "circle":
        for (let k = 0; k < steps * 4; k++) out.push([s.center[0] + s.radius * Math.cos((2 * Math.PI * k) / (steps * 4)), s.center[1] + s.radius * Math.sin((2 * Math.PI * k) / (steps * 4))]);
        break;
      case "ellipse":
        for (let k = 0; k < steps * 4; k++) {
          const t = (2 * Math.PI * k) / (steps * 4);
          const x = s.rx * Math.cos(t);
          const y = s.ry * Math.sin(t);
          out.push([s.center[0] + x * Math.cos(s.angle) - y * Math.sin(s.angle), s.center[1] + x * Math.sin(s.angle) + y * Math.cos(s.angle)]);
        }
        break;
    }
  }
  return out;
}

function circleCentre(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

function signedArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The same outline the other way round. */
export function reverseSegments(segments: Segment[]): Segment[] {
  return [...segments].reverse().map((s): Segment => {
    switch (s.kind) {
      case "line":
        return { kind: "line", from: s.to, to: s.from };
      case "arc":
        return { kind: "arc", from: s.to, mid: s.mid, to: s.from };
      case "bezier":
        return { kind: "bezier", from: s.to, c1: s.c2, c2: s.c1, to: s.from };
      default:
        return s;
    }
  });
}

/** An outline turned to go anticlockwise (holes: clockwise). */
export function anticlockwise(segments: Segment[], wantCcw = true): Segment[] {
  const ccw = signedArea(outlinePoints(segments)) > 0;
  return ccw === wantCcw ? segments : reverseSegments(segments);
}

const rect = (w: number, h: number): Segment[] => [
  { kind: "line", from: [0, 0], to: [w, 0] },
  { kind: "line", from: [w, 0], to: [w, h] },
  { kind: "line", from: [w, h], to: [0, h] },
  { kind: "line", from: [0, h], to: [0, 0] },
];

/** Fold the sheet: every wall where it ends up, and the bends between them. */
export function foldSheet(spec: SheetSpec): FoldedSheet {
  const T = spec.thickness;
  const base: Wall = {
    id: "base",
    frame: spec.base.frame,
    outline: anticlockwise(spec.base.outer),
    holes: spec.base.holes.map((h) => anticlockwise(h, false)),
    flat: { origin: [0, 0], u: [1, 0], v: [0, 1] },
  };
  const walls: Wall[] = [base];
  const bends: Bend[] = [];
  const errors: Record<string, string> = {};
  const used = new Set<string>();

  for (const fl of spec.flanges) {
    const parent = walls.find((w) => w.id === fl.wall);
    const seg = parent?.outline[fl.edge];
    if (!parent || !seg) {
      errors[fl.id] = "The edge it bends off can't be found any more. Edit this flange and pick the edge again.";
      continue;
    }
    if (seg.kind !== "line") {
      errors[fl.id] = "Flanges bend off straight edges. Pick a straight edge.";
      continue;
    }
    if (parent.bendEdge === fl.edge) {
      errors[fl.id] = "That edge is already bent (it's where this wall joins the one before).";
      continue;
    }
    const key = `${fl.wall}:${fl.edge}`;
    if (used.has(key)) {
      errors[fl.id] = "That edge already has a flange.";
      continue;
    }
    if (!(fl.angle > 0 && (fl.angle < 180 || (fl.hem && fl.angle <= 180)))) {
      errors[fl.id] = "The bend angle must be more than 0° and less than 180°.";
      continue;
    }
    const R = fl.radius ?? spec.radius;
    const theta = (fl.angle * Math.PI) / 180;
    const straight = fl.straight ?? fl.length - (R + T) * Math.tan(theta / 2);
    if (straight < 0.01) {
      errors[fl.id] =
        fl.straight !== undefined
          ? "A line in the outline is too short for the bends at its ends. Make it longer, or use a smaller bend radius."
          : `Too short for its bend: make it longer than ${Math.ceil(((R + T) * Math.tan(theta / 2) + 0.01) * 100) / 100} mm, or use a smaller bend radius.`;
      continue;
    }
    used.add(key);

    const [ax, ay] = seg.from;
    const [bx, by] = seg.to;
    const full = Math.hypot(bx - ax, by - ay);
    const e2: P2 = [(bx - ax) / full, (by - ay) / full];
    const inset = Math.max(0, fl.inset ?? 0);
    const len = full - 2 * inset;
    if (len < 0.01) {
      used.delete(key);
      errors[fl.id] = `Shortened too much: that edge is only ${Math.round(full * 100) / 100} mm long.`;
      continue;
    }
    // The flange's ends along the edge, and relief notches (thickness wide and deep) into the parent beyond them.
    const along = (t: number): P2 => [ax + e2[0] * t, ay + e2[1] * t];
    const startP = along(inset);
    const endP = along(full - inset);
    const into: P2 = [-e2[1], e2[0]];
    const shape = fl.reliefShape ?? "rectangle";
    // A tear is just a thin cut; the others are as wide as the sheet is thick (or the shortening, if less).
    const w = shape === "tear" ? Math.min(0.2, T / 4, inset) : Math.min(T, inset);
    const notch = (t0: number): Segment[] => {
      const p = along(t0);
      const q = along(t0 + w);
      const deep = (x: P2, d: number): P2 => [x[0] + into[0] * d, x[1] + into[1] * d];
      if (shape === "round") {
        // Round-ended: straight sides, then a half circle at the bottom, T deep in all.
        const side = T - w / 2;
        const mid = deep(along(t0 + w / 2), T);
        return anticlockwise([
          { kind: "line", from: p, to: q },
          { kind: "line", from: q, to: deep(q, side) },
          { kind: "arc", from: deep(q, side), mid, to: deep(p, side) },
          { kind: "line", from: deep(p, side), to: p },
        ]);
      }
      return anticlockwise([
        { kind: "line", from: p, to: q },
        { kind: "line", from: q, to: deep(q, T) },
        { kind: "line", from: deep(q, T), to: deep(p, T) },
        { kind: "line", from: deep(p, T), to: p },
      ]);
    };
    const reliefs = inset > 1e-9 ? [notch(inset - w), notch(full - inset)] : [];
    const f = parent.frame;
    const e = add(mul(f.u, e2[0]), mul(f.v, e2[1]));
    const n = f.n;
    const o = cross3(e, n); // outward: the right of an anticlockwise edge
    const s0 = wallPoint(f, endP);
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    let origin: V3;
    let d: V3;
    let nn: V3;
    let profile: Segment[];
    const at = (c: P2, r: number, a: number, down: boolean): P2 => (down ? [c[0] + r * Math.sin(a), c[1] + r * Math.cos(a)] : [c[0] + r * Math.sin(a), c[1] - r * Math.cos(a)]);
    if (!fl.down) {
      const c: P2 = [0, T + R];
      origin = add(s0, add(mul(o, (R + T) * sin), mul(n, T + R - (R + T) * cos)));
      d = add(mul(o, cos), mul(n, sin));
      nn = add(mul(o, -sin), mul(n, cos));
      profile = [
        { kind: "arc", from: [0, 0], mid: at(c, R + T, theta / 2, false), to: at(c, R + T, theta, false) },
        { kind: "line", from: at(c, R + T, theta, false), to: at(c, R, theta, false) },
        { kind: "arc", from: at(c, R, theta, false), mid: at(c, R, theta / 2, false), to: [0, T] },
        { kind: "line", from: [0, T], to: [0, 0] },
      ];
    } else {
      const c: P2 = [0, -R];
      origin = add(s0, add(mul(o, R * sin), mul(n, -R + R * cos)));
      d = add(mul(o, cos), mul(n, -sin));
      nn = add(mul(o, sin), mul(n, cos));
      profile = [
        { kind: "arc", from: [0, 0], mid: at(c, R, theta / 2, true), to: at(c, R, theta, true) },
        { kind: "line", from: at(c, R, theta, true), to: at(c, R + T, theta, true) },
        { kind: "arc", from: at(c, R + T, theta, true), mid: at(c, R + T, theta / 2, true), to: [0, T] },
        { kind: "line", from: [0, T], to: [0, 0] },
      ];
    }
    const allowance = theta * (R + spec.k * T);
    // Flat: the parent's edge, then the bend's strip outwards, then the flange.
    const pf = parent.flat;
    const eF: P2 = add2(mul2(pf.u, e2[0]), mul2(pf.v, e2[1]));
    const outF: P2 = [eF[1], -eF[0]];
    const bF = flatPoint(pf, endP);
    const aF = flatPoint(pf, startP);
    const child: Wall = {
      id: fl.id,
      frame: { origin, u: mul(e, -1), v: d, n: nn },
      outline: rect(len, straight),
      holes: [],
      flat: { origin: add2(bF, mul2(outF, allowance)), u: mul2(eF, -1), v: outF },
      bendEdge: 0,
    };
    walls.push(child);
    bends.push({
      flangeId: fl.id,
      parent: parent.id,
      edge: fl.edge,
      child: child.id,
      inset,
      reliefs,
      radius: R,
      angle: fl.angle,
      down: fl.down,
      straight,
      start: s0,
      out: o,
      up: n,
      along: mul(e, -1),
      length: len,
      profile,
      flatLine: [add2(aF, mul2(outF, allowance / 2)), add2(bF, mul2(outF, allowance / 2))],
      allowance,
      flat: { origin: bF, u: mul2(eF, -1), v: outF },
    });
  }
  closeCorners(spec, walls, bends);
  const cornerReliefs = findCornerReliefs(spec, walls, bends);
  for (const t of spec.tabs ?? []) {
    const w = walls.find((x) => x.id === t.wall);
    if (!w) {
      errors[t.id] = "The wall this tab was on can't be found any more. Edit the tab's sketch.";
      continue;
    }
    w.tabs = [...(w.tabs ?? []), { outline: anticlockwise(t.outline), holes: t.holes.map((h) => anticlockwise(h, false)) }];
  }
  return { walls, bends, errors, ...(cornerReliefs.length ? { cornerReliefs } : {}) };
}

/**
 * Corner reliefs: where bends off two neighbouring edges of a wall meet at
 * their shared corner (neither shortened there, and the corner not closed),
 * and either flange asks for one, a round or square cut on the corner, the
 * size of the bend (radius plus thickness), so the bends don't tear into
 * each other.
 */
function findCornerReliefs(spec: SheetSpec, walls: Wall[], bends: Bend[]): CornerRelief[] {
  const T = spec.thickness;
  const flange = new Map(spec.flanges.map((f) => [f.id, f]));
  const out: CornerRelief[] = [];
  for (const w of walls) {
    const k = w.outline.length;
    for (let i = 0; i < k; i++) {
      const a = bends.find((b) => b.parent === w.id && b.edge === i);
      const b = bends.find((x) => x.parent === w.id && x.edge === (i + 1) % k);
      if (!a || !b || a.inset > 1e-9 || b.inset > 1e-9) continue;
      const fa = flange.get(a.flangeId);
      const fb = flange.get(b.flangeId);
      if (fa?.closeCorners || fb?.closeCorners) continue;
      const shape = fa?.cornerRelief ?? fb?.cornerRelief;
      if (!shape) continue;
      const sa = w.outline[i];
      const sb = w.outline[(i + 1) % k];
      if (sa.kind !== "line" || sb.kind !== "line") continue;
      const R = Math.max(a.radius, b.radius);
      out.push({
        wall: w.id,
        at: sa.to,
        e1: unit2([sa.from[0] - sa.to[0], sa.from[1] - sa.to[1]]),
        e2: unit2([sb.to[0] - sb.from[0], sb.to[1] - sb.from[1]]),
        r: R + T,
        shape,
        flanges: [a.flangeId, b.flangeId],
        below: a.down || b.down ? R : 0,
        above: a.down && b.down ? 0 : R,
      });
    }
  }
  return out;
}

/** A wall's rectangle from u0 to u1 along its bend edge, `h` high. */
const rectRange = (u0: number, u1: number, h: number): Segment[] => [
  { kind: "line", from: [u0, 0], to: [u1, 0] },
  { kind: "line", from: [u1, 0], to: [u1, h] },
  { kind: "line", from: [u1, h], to: [u0, h] },
  { kind: "line", from: [u0, h], to: [u0, 0] },
];

/**
 * Closed corners: where two full-length right-angle flanges meet at a square
 * corner of their wall and either asks for it, extend their ends so the
 * corner is closed — the first flange's wall runs on to the outside of the
 * second's, and the second's runs on to butt against the first's inside.
 */
function closeCorners(spec: SheetSpec, walls: Wall[], bends: Bend[]): void {
  const T = spec.thickness;
  const wants = new Set(spec.flanges.filter((f) => f.closeCorners).map((f) => f.id));
  if (!wants.size) return;
  const ext = new Map<string, { lo: number; hi: number }>();
  const more = (child: string, lo: number, hi: number) => {
    const e = ext.get(child) ?? { lo: 0, hi: 0 };
    ext.set(child, { lo: Math.max(e.lo, lo), hi: Math.max(e.hi, hi) });
  };
  for (const w of walls) {
    const k = w.outline.length;
    for (let i = 0; i < k; i++) {
      const a = bends.find((b) => b.parent === w.id && b.edge === i);
      const b = bends.find((x) => x.parent === w.id && x.edge === (i + 1) % k);
      if (!a || !b || (!wants.has(a.flangeId) && !wants.has(b.flangeId))) continue;
      const sa = w.outline[i];
      const sb = w.outline[(i + 1) % k];
      if (sa.kind !== "line" || sb.kind !== "line") continue;
      const ea = unit2([sa.to[0] - sa.from[0], sa.to[1] - sa.from[1]]);
      const eb = unit2([sb.to[0] - sb.from[0], sb.to[1] - sb.from[1]]);
      const square = Math.abs(ea[0] * eb[0] + ea[1] * eb[1]) < 1e-6 && ea[0] * eb[1] - ea[1] * eb[0] > 0;
      const right = (x: Bend) => Math.abs(x.angle - 90) < 1e-6 && x.inset < 1e-9;
      if (!square || !right(a) || !right(b) || a.down !== b.down) continue;
      // a's wall runs past the corner to b's outside face; b's runs to a's inside face.
      more(a.child, b.radius + T, 0);
      more(b.child, 0, a.radius);
    }
  }
  for (const [id, e] of ext) {
    const wall = walls.find((x) => x.id === id);
    const bend = bends.find((x) => x.child === id);
    if (!wall || !bend) continue;
    wall.outline = rectRange(-e.lo, bend.length + e.hi, bend.straight);
  }
}

const unit2 = (v: P2): P2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

/** The flat pattern: one outline to cut round (and the holes in it), and the bend lines. */
export interface FlatBend {
  line: [P2, P2];
  /** Degrees; up = towards the sheet's top (n) side. */
  angle: number;
  radius: number;
  up: boolean;
}

export function flatPattern(folded: FoldedSheet): { outline: P2[]; holes: P2[][]; bendLines: [P2, P2][]; bends: FlatBend[] } {
  const childOn = new Map<string, Wall>();
  const bendOn = new Map<string, Bend>();
  for (const b of folded.bends) {
    childOn.set(`${b.parent}:${b.edge}`, folded.walls.find((w) => w.id === b.child)!);
    bendOn.set(`${b.parent}:${b.edge}`, b);
  }
  /** A relief notch's outline in order along the edge: from where it leaves the edge, round its inside, back to the edge. */
  const notchPoints = (wall: Wall, r: Segment[], e2: P2, from: P2): P2[] => {
    const pts = outlinePoints(r);
    const t = (p: P2) => (p[0] - from[0]) * e2[0] + (p[1] - from[1]) * e2[1];
    const onEdge = (p: P2) => Math.abs((p[0] - from[0]) * e2[1] - (p[1] - from[1]) * e2[0]) < 1e-9;
    const n = pts.length;
    // The two corners on the edge are next to each other round the outline; walk the long way from the nearer one to the further.
    const ends = pts.map((_, i) => i).filter((i) => onEdge(pts[i]));
    if (ends.length < 2) return [];
    const [lo, hi] = [...ends].sort((a, b) => t(pts[a]) - t(pts[b]));
    const step = (lo + 1) % n === hi ? -1 : 1;
    const path: P2[] = [];
    for (let i = lo; ; i = (i + step + n) % n) {
      path.push(pts[i]);
      if (i === hi) break;
    }
    return path.map((p) => flatPoint(wall.flat, p));
  };
  const out: P2[] = [];
  /** Go round a wall's outline (skipping its bend edge, where it joins its parent), detouring round any flange on its edges. */
  const walk = (wall: Wall, skip: number | undefined) => {
    const k = wall.outline.length;
    const start = skip === undefined ? 0 : (skip + 1) % k;
    for (let j = 0; j < k; j++) {
      const i = (start + j) % k;
      if (i === skip) continue;
      const seg = wall.outline[i];
      const child = childOn.get(`${wall.id}:${i}`);
      if (seg.kind === "line" && child) {
        const bend = bendOn.get(`${wall.id}:${i}`)!;
        const L = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
        const e2: P2 = [(seg.to[0] - seg.from[0]) / L, (seg.to[1] - seg.from[1]) / L];
        const at = (t: number): P2 => flatPoint(wall.flat, [seg.from[0] + e2[0] * t, seg.from[1] + e2[1] * t]);
        out.push(flatPoint(wall.flat, seg.from));
        if (bend.reliefs.length) out.push(...notchPoints(wall, bend.reliefs[0], e2, seg.from));
        out.push(at(bend.inset));
        // Across the bend's strip to the wall, round the wall (its bottom edge may run past the bend at either
        // end, for a closed corner), and back across the strip.
        out.push(flatPoint(child.flat, [bend.length, 0]));
        walk(child, 0);
        const bottom = child.outline[0];
        if (bottom.kind === "line") out.push(flatPoint(child.flat, bottom.from));
        out.push(flatPoint(child.flat, [0, 0]));
        out.push(at(L - bend.inset));
        if (bend.reliefs.length) out.push(...notchPoints(wall, bend.reliefs[1], e2, seg.from));
      } else {
        for (const p of outlinePoints([seg])) out.push(flatPoint(wall.flat, p));
      }
    }
  };
  walk(folded.walls[0], undefined);
  const holes = folded.walls.flatMap((w) => w.holes.map((h) => outlinePoints(h).map((p) => flatPoint(w.flat, p))));
  return {
    outline: dedupe(out),
    holes,
    bendLines: folded.bends.map((b) => b.flatLine),
    bends: folded.bends.map((b) => ({ line: b.flatLine, angle: b.angle, radius: b.radius, up: !b.down })),
  };
}

/**
 * Line pieces joined end to end into closed loops (pieces that don't close
 * up are left out). Ends within `tol` count as the same point.
 */
export function chainLoops(pieces: [P2, P2][], tol = 1e-6): P2[][] {
  const left = pieces.filter(([a, b]) => Math.hypot(a[0] - b[0], a[1] - b[1]) > tol);
  const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const loops: P2[][] = [];
  while (left.length) {
    const [first] = left.splice(0, 1);
    const loop: P2[] = [first[0], first[1]];
    for (;;) {
      const end = loop[loop.length - 1];
      if (same(end, loop[0])) {
        loop.pop();
        if (loop.length >= 3) loops.push(loop);
        break;
      }
      const i = left.findIndex(([a, b]) => same(a, end) || same(b, end));
      if (i < 0) break;
      const [next] = left.splice(i, 1);
      loop.push(same(next[0], end) ? next[1] : next[0]);
    }
  }
  return loops;
}

function dedupe(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out;
}

/**
 * The wall edge a picked straight edge of the folded part lies along (on
 * either face of the sheet), or null. Edges already bent aren't offered.
 */
export function findSheetEdge(folded: FoldedSheet, thickness: number, a: V3, b: V3, tol = 1e-3): { wall: string; edge: number } | null {
  const bent = new Set(folded.bends.map((x) => `${x.parent}:${x.edge}`));
  const onLine = (p: V3, q0: V3, q1: V3) => {
    const dir = sub3(q1, q0);
    const L = Math.hypot(...dir);
    if (L < 1e-9) return false;
    const t = dot3(sub3(p, q0), dir) / (L * L);
    const foot = add(q0, mul(dir, t));
    return Math.hypot(...sub3(p, foot)) < tol && t > -tol / L && t < 1 + tol / L;
  };
  for (const w of folded.walls) {
    for (let i = 0; i < w.outline.length; i++) {
      const s = w.outline[i];
      if (s.kind !== "line" || i === w.bendEdge || bent.has(`${w.id}:${i}`)) continue;
      for (const h of [0, thickness]) {
        const q0 = wallPoint(w.frame, s.from, h);
        const q1 = wallPoint(w.frame, s.to, h);
        if (onLine(a, q0, q1) && onLine(b, q0, q1)) return { wall: w.id, edge: i };
      }
    }
  }
  return null;
}

/**
 * How to lay a wall down flat: the frame it occupies in the unfolded sheet
 * (in the base wall's plane), and the turn (axis and degrees about the
 * wall's origin) that takes the wall's frame onto it. For bends, the flat
 * strip each one unrolls into.
 */
export function unfoldMoves(folded: FoldedSheet): {
  walls: { id: string; from: Frame3; to: Frame3; axis: V3; angle: number }[];
  strips: { frame: Frame3; length: number; width: number }[];
} {
  const base = folded.walls[0].frame;
  const inBase = (p: P2): V3 => add(add(base.origin, mul(base.u, p[0])), mul(base.v, p[1]));
  const dirInBase = (d: P2): V3 => add(mul(base.u, d[0]), mul(base.v, d[1]));
  const walls = folded.walls.map((w) => {
    const to: Frame3 = { origin: inBase(w.flat.origin), u: dirInBase(w.flat.u), v: dirInBase(w.flat.v), n: base.n };
    // The rotation taking (u, v, n) to (u', v', n'): R = B · Aᵀ, as an axis and angle.
    const A = [w.frame.u, w.frame.v, w.frame.n];
    const B = [to.u, to.v, to.n];
    const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => B[0][r] * A[0][c] + B[1][r] * A[1][c] + B[2][r] * A[2][c]));
    const trace = R[0][0] + R[1][1] + R[2][2];
    const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
    let axis: V3 = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
    const l = Math.hypot(...axis);
    if (l > 1e-9) axis = mul(axis, 1 / l);
    else if (angle > 1e-9) {
      // A half turn: the axis is the eigenvector for +1.
      const k = [0, 1, 2].reduce((best, i) => (R[i][i] > R[best][best] ? i : best), 0);
      const col: V3 = [R[0][k] + (k === 0 ? 1 : 0), R[1][k] + (k === 1 ? 1 : 0), R[2][k] + (k === 2 ? 1 : 0)];
      axis = mul(col, 1 / (Math.hypot(...col) || 1));
    } else axis = [0, 0, 1];
    return { id: w.id, from: w.frame, to, axis, angle: (angle * 180) / Math.PI };
  });
  const strips = folded.bends.map((b) => {
    const [a, c] = b.flatLine;
    const along: P2 = [c[0] - a[0], c[1] - a[1]];
    const L = Math.hypot(along[0], along[1]) || 1;
    const e: P2 = [along[0] / L, along[1] / L];
    // The strip is centred on the bend line: from its outer side back towards the parent (a right-handed frame).
    const inward: P2 = [-e[1], e[0]];
    const corner: P2 = [a[0] - (inward[0] * b.allowance) / 2, a[1] - (inward[1] * b.allowance) / 2];
    return { frame: { origin: inBase(corner), u: dirInBase(e), v: dirInBase(inward), n: base.n }, length: L, width: b.allowance };
  });
  return { walls, strips };
}

/**
 * The wall a plane lies on (on either face of the sheet, facing either way),
 * or null. `origin` and `n` are the plane's.
 */
export function wallOnPlane(folded: FoldedSheet, thickness: number, origin: V3, n: V3, tol = 1e-4): Wall | null {
  for (const w of folded.walls) {
    const f = w.frame;
    if (Math.abs(Math.abs(dot3(f.n, n)) - 1) > 1e-6) continue;
    const h = dot3(sub3(origin, f.origin), f.n);
    if (Math.abs(h) < tol || Math.abs(h - thickness) < tol) return w;
  }
  return null;
}

/** Outline pieces moved by `map` (a point-by-point change of coordinates that keeps distances). */
export function mapSegments(segments: Segment[], map: (p: P2) => P2): Segment[] {
  return segments.map((s): Segment => {
    switch (s.kind) {
      case "line":
        return { kind: "line", from: map(s.from), to: map(s.to) };
      case "arc":
        return { kind: "arc", from: map(s.from), mid: map(s.mid), to: map(s.to) };
      case "bezier":
        return { kind: "bezier", from: map(s.from), c1: map(s.c1), c2: map(s.c2), to: map(s.to) };
      case "circle":
        return { kind: "circle", center: map(s.center), radius: s.radius };
      case "ellipse": {
        const c = map(s.center);
        const a = map([s.center[0] + Math.cos(s.angle), s.center[1] + Math.sin(s.angle)]);
        return { kind: "ellipse", center: c, rx: s.rx, ry: s.ry, angle: Math.atan2(a[1] - c[1], a[0] - c[0]) };
      }
    }
  });
}
