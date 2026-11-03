/**
 * Export for laser, engine side: the exact outline of a flat face, read from
 * OpenCascade and laid into the face's own flat coordinates — lines, arcs and
 * circles as they are, ellipses as ellipses, other curves (splines) as cubic
 * Bézier pieces within half a micron, straight pieces only as a last resort.
 * Pure geometry after that lives in src/laser/.
 */
import { getOC, measureArea, type Edge, type Face, type Shape3D } from "replicad";

import type { Pt, Segment } from "../sketch/regions";
import { edgesOf, facesOf, wiresOf } from "./topology";

type V3 = [number, number, number];

/** A flat face's own coordinates: origin, across (u), up (v), and out of the face (n). */
export interface FlatFrame {
  origin: V3;
  u: V3;
  v: V3;
  n: V3;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** How closely spline pieces must follow the edge (mm). */
const CURVE_TOLERANCE = 5e-4;

/**
 * The frame to lay a face out in, seen from outside the part (looking down on
 * it against its outward direction): across = the world X for faces facing up
 * or down, otherwise level (square to Z); up = out × across.
 */
export function faceFrame(n: V3, origin: V3 = [0, 0, 0]): FlatFrame {
  const nn = unit(n);
  const u: V3 = Math.abs(nn[2]) > 0.999 ? [1, 0, 0] : unit(crossV([0, 0, 1], nn));
  return { origin, u, v: crossV(nn, u), n: nn };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One edge as flat pieces in `frame` (pushed onto `out`). */
function edgeSegments(e: Edge, frame: FlatFrame, out: Segment[]): void {
  const oc = getOC() as any;
  const adaptor = new oc.BRepAdaptor_Curve(e.wrapped);
  const pnt = new oc.gp_Pnt();
  const vec = new oc.gp_Vec();
  const made: any[] = [];
  const keep = <T,>(o: T): T => (made.push(o), o);
  const local = (x: number, y: number, z: number): Pt => {
    const d: V3 = [x - frame.origin[0], y - frame.origin[1], z - frame.origin[2]];
    return [dot(d, frame.u), dot(d, frame.v)];
  };
  const at = (t: number): Pt => {
    adaptor.D0(t, pnt);
    return local(pnt.X(), pnt.Y(), pnt.Z());
  };
  const dirLocal = (x: number, y: number, z: number): Pt => [dot([x, y, z], frame.u), dot([x, y, z], frame.v)];
  try {
    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();
    if (!Number.isFinite(first) || !Number.isFinite(last) || last - first < 1e-12) return;
    const type = e.geomType;
    const whole = Math.abs(last - first - 2 * Math.PI) < 1e-9;
    if (type === "LINE") {
      out.push({ kind: "line", from: at(first), to: at(last) });
      return;
    }
    if (type === "CIRCLE") {
      const ci = keep(adaptor.Circle());
      const c = keep(ci.Location());
      const centre = local(c.X(), c.Y(), c.Z());
      if (whole) out.push({ kind: "circle", center: centre, radius: ci.Radius() });
      else out.push({ kind: "arc", from: at(first), mid: at((first + last) / 2), to: at(last) });
      return;
    }
    if (type === "ELLIPSE" && whole) {
      const el = keep(adaptor.Ellipse());
      const c = keep(el.Location());
      const xd = keep(keep(el.XAxis()).Direction());
      const d = dirLocal(xd.X(), xd.Y(), xd.Z());
      out.push({ kind: "ellipse", center: local(c.X(), c.Y(), c.Z()), rx: el.MajorRadius(), ry: el.MinorRadius(), angle: Math.atan2(d[1], d[0]) });
      return;
    }
    // Anything else: cubic pieces matching the edge's position and direction at each end, halved until they keep close.
    const sample = (n: number) => {
      const pts: Pt[] = [];
      const tans: Pt[] = [];
      const k = (last - first) / n;
      for (let i = 0; i <= n; i++) {
        adaptor.D1(first + k * i, pnt, vec);
        pts.push(local(pnt.X(), pnt.Y(), pnt.Z()));
        const t = dirLocal(vec.X(), vec.Y(), vec.Z());
        tans.push([t[0] * k, t[1] * k]);
      }
      return { pts, tans };
    };
    const miss = (s: { pts: Pt[]; tans: Pt[] }, n: number) => {
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const want = at(first + ((last - first) * (i + 0.5)) / n);
        const mx = (s.pts[i][0] + s.pts[i + 1][0]) / 2 + (s.tans[i][0] - s.tans[i + 1][0]) / 8;
        const my = (s.pts[i][1] + s.pts[i + 1][1]) / 2 + (s.tans[i][1] - s.tans[i + 1][1]) / 8;
        worst = Math.max(worst, Math.hypot(mx - want[0], my - want[1]));
        // And a quarter of the way along, so an S-bend can't hide from the middle.
        const q = at(first + ((last - first) * (i + 0.25)) / n);
        const [p0, p1, t0, t1] = [s.pts[i], s.pts[i + 1], s.tans[i], s.tans[i + 1]];
        const u = 0.25;
        const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
        const qx = h00 * p0[0] + h10 * t0[0] + h01 * p1[0] + h11 * t1[0];
        const qy = h00 * p0[1] + h10 * t0[1] + h01 * p1[1] + h11 * t1[1];
        worst = Math.max(worst, Math.hypot(qx - q[0], qy - q[1]));
      }
      return worst;
    };
    let n = 4;
    let s = sample(n);
    let m = miss(s, n);
    while (m > CURVE_TOLERANCE && n < 512) {
      n *= 2;
      s = sample(n);
      m = miss(s, n);
    }
    if (m <= 0.005) {
      for (let i = 0; i < n; i++) {
        const [p0, p1, t0, t1] = [s.pts[i], s.pts[i + 1], s.tans[i], s.tans[i + 1]];
        out.push({ kind: "bezier", from: p0, c1: [p0[0] + t0[0] / 3, p0[1] + t0[1] / 3], c2: [p1[0] - t1[0] / 3, p1[1] - t1[1] / 3], to: p1 });
      }
      return;
    }
    // Last resort: short straight pieces.
    const N = 2048;
    let prev = at(first);
    for (let i = 1; i <= N; i++) {
      const p = at(first + ((last - first) * i) / N);
      out.push({ kind: "line", from: prev, to: p });
      prev = p;
    }
  } finally {
    made.forEach((o) => o.delete());
    pnt.delete();
    vec.delete();
    adaptor.delete();
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** A face's wires (outer and holes), each as flat pieces in `frame`. */
export function faceWires(face: Face, frame: FlatFrame): Segment[][] {
  const out: Segment[][] = [];
  for (const w of wiresOf(face)) {
    const segs: Segment[] = [];
    try {
      for (const e of edgesOf(w)) {
        try {
          edgeSegments(e, frame, segs);
        } finally {
          e.delete();
        }
      }
    } finally {
      w.delete();
    }
    if (segs.length) out.push(segs);
  }
  return out;
}

/** The outward direction of a flat face (null for curved faces). */
export function flatFaceNormal(face: Face): V3 | null {
  if (face.geomType !== "PLANE") return null;
  const c = face.center;
  try {
    const nv = face.normalAt(c);
    const n: V3 = [nv.x, nv.y, nv.z];
    nv.delete();
    return n;
  } finally {
    c.delete();
  }
}

/** A part's biggest flat face (facing up the most when several are as big), or null if it has none. Caller frees it. */
export function biggestFlatFace(shape: Shape3D): { face: Face; normal: V3 } | null {
  let best: { face: Face; normal: V3; area: number } | null = null;
  for (const f of facesOf(shape)) {
    const n = flatFaceNormal(f);
    const area = n ? measureArea(f) : 0;
    const better = n && (!best || area > best.area * (1 + 1e-3) || (area > best.area * (1 - 1e-3) && n[2] > best.normal[2] + 1e-6));
    if (better) {
      best?.face.delete();
      best = { face: f, normal: n, area };
    } else f.delete();
  }
  return best ? { face: best.face, normal: best.normal } : null;
}

/**
 * Every edge of the flat faces lying in a plane (a sheet metal part laid out
 * flat: its walls and unrolled bends side by side), leaving out edges two of
 * them share, so what's left is the outline and the holes.
 */
export function planeOutline(shape: Shape3D, frame: FlatFrame): Segment[] {
  const pieces: Segment[] = [];
  const counted = new Map<string, number>();
  const keyOf = (s: Segment) => {
    const r = (p: Pt) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
    if (s.kind === "circle" || s.kind === "ellipse") return `o:${r(s.center)}`;
    const mid = s.kind === "arc" ? s.mid : s.kind === "bezier" ? ([(s.c1[0] + s.c2[0]) / 2, (s.c1[1] + s.c2[1]) / 2] as Pt) : ([(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2] as Pt);
    return [r(s.from), r(s.to)].sort().join("|") + `|${r(mid)}`;
  };
  for (const f of facesOf(shape)) {
    try {
      const n = flatFaceNormal(f);
      if (!n || Math.abs(Math.abs(dot(unit(n), frame.n)) - 1) > 1e-6) continue;
      const c = f.center;
      const h = dot([c.x - frame.origin[0], c.y - frame.origin[1], c.z - frame.origin[2]], frame.n);
      c.delete();
      if (Math.abs(h) > 1e-4) continue;
      for (const w of faceWires(f, frame))
        for (const s of w) {
          // A Bézier piece's key uses its control points: an edge two faces share is read the same way from both.
          const k = keyOf(s);
          counted.set(k, (counted.get(k) ?? 0) + 1);
          pieces.push(s);
        }
    } finally {
      f.delete();
    }
  }
  return pieces.filter((s) => counted.get(keyOf(s)) === 1);
}
