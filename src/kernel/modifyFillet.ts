/**
 * Modify fillet (Onshape's): rounded faces of a part — fillets, also on
 * imported or simplified parts — taken off (the sharp edge put back), or
 * given a new radius (taken off, then the recovered sharp edges rounded again).
 *
 * A fillet face here is a piece of a cylinder (a straight fillet) or a torus
 * (a fillet round a hole's rim or a boss's foot) that blends smoothly into the
 * faces either side. The sharp edge is put back by filling (or, for an inside
 * fillet, cutting away) the "wedge" between the round and the corner where the
 * two faces beside it would meet: its cross-section (two straight lines along
 * the faces' tangents and the arc) pushed along a straight fillet, or spun
 * round a round one. Neighbouring pieces' wedges meet exactly, so a run of
 * tangent fillets (a rounded rectangle's edge) comes off as one.
 */
import { assembleWire, basicFaceExtrusion, getOC, makeFace, makeLine, makeThreePointArc, revolution, Vector, type Edge, type Face, type Shape3D } from "replicad";
import { circleThrough3D } from "../geometry/measureMath";
import type { Vec3 } from "../geometry/topoRef";
import { edgesOf, facesOf, solidsOf } from "./topology";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const take = (v: Vector): Vec3 => {
  const out: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return out;
};

/** The wedge that puts one fillet piece's sharp edge back, and where that edge runs. */
export interface FilletWedge {
  /** The cross-section's corner (where the faces either side meet), its arc's middle and the arc's radius. */
  corner: Vec3;
  radius: number;
  /** True for a fillet on an outside edge (the wedge is added); false for one in an inside corner (cut). */
  outside: boolean;
  /** Straight fillets: the corner line runs from `corner` along `along` (a vector, the fillet's length). */
  along?: Vec3;
  /** Round fillets: the corner circle's axis (a point on it and its direction) and the angle it spans. */
  axis?: { origin: Vec3; dir: Vec3; angle: number };
}

/** A friendly error for a face that isn't a fillet this can take apart. */
export class NotAFillet extends Error {}

/** The face's sides as a cross-section: its two edges' points, the arc's middle and centre, the plane's normal. */
function crossSection(p1: Vec3, pm: Vec3, p2: Vec3) {
  const c = circleThrough3D(p1, pm, p2);
  if (!c) throw new NotAFillet("This face isn't round, so it isn't a fillet.");
  const n = unit(cross(sub(pm, p1), sub(p2, p1)));
  // Each side's tangent, square to its radius in the section's plane; the corner is where they meet.
  const r1 = sub(p1, c.centre);
  const r2 = sub(p2, c.centre);
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(r1, r2) / (len(r1) * len(r2)))));
  if (!(turn > 1e-3) || turn > (175 * Math.PI) / 180) throw new NotAFillet("This rounded face turns too far (or too little) to be a fillet between two faces.");
  // The two tangent lines meet on the bisector, at radius / cos(half the turn) from the centre.
  const bisector = unit(sub(pm, c.centre));
  const corner = add(c.centre, scale(bisector, c.radius / Math.cos(turn / 2)));
  return { centre: c.centre, radius: c.radius, normal: n, corner };
}

/** The cross-section as a flat face: corner → one side, round the arc, back to the corner. */
function sectionFace(p1: Vec3, pm: Vec3, p2: Vec3, corner: Vec3): Face {
  const edges: Edge[] = [makeLine(corner, p1), makeThreePointArc(p1, pm, p2), makeLine(p2, corner)];
  const wire = assembleWire(edges);
  edges.forEach((e) => e.delete());
  const face = makeFace(wire);
  wire.delete();
  return face;
}

/** The corner lies outside the part when the face's outward normal at the arc's middle points towards it (a fillet on an outside edge). */
function cornerOutside(face: Face, pm: Vec3, corner: Vec3): boolean {
  const n = take(face.normalAt(pm));
  return dot(n, sub(corner, pm)) > 0;
}

/**
 * The wedge between one fillet face and its sharp corner (the caller frees the
 * solid). Throws NotAFillet with a plain message when the face isn't one.
 */
export function filletWedge(face: Face): { solid: Shape3D; wedge: FilletWedge } {
  const kind = face.geomType;
  if (kind !== "CYLINDRE" && kind !== "TORUS") throw new NotAFillet("Pick rounded faces made by a fillet: a piece of a cylinder (along a straight edge) or of a ring (round a hole or a boss).");
  // replicad's pointOnSurface takes shares (0…1) of the face's own u and v ranges.
  const { uMin, uMax } = face.UVBounds;
  const at = (u: number, v: number) => take(face.pointOnSurface(u, v));
  const uMin0 = 0, uMax0 = 1, vMin = 0, vMax = 1;
  if (kind === "CYLINDRE") {
    // u goes round, v along: the section at the start, pushed along the fillet's length.
    const p1 = at(uMin0, vMin);
    const p2 = at(uMax0, vMin);
    const pm = at(0.5, vMin);
    const s = crossSection(p1, pm, p2);
    const along = sub(at(uMin0, vMax), p1);
    if (len(along) < 1e-6) throw new NotAFillet("This rounded face has no length.");
    const outside = cornerOutside(face, pm, s.corner);
    const section = sectionFace(p1, pm, p2, s.corner);
    const vec = new Vector(along);
    try {
      const solid = basicFaceExtrusion(section, vec) as Shape3D;
      return { solid, wedge: { corner: s.corner, radius: s.radius, outside, along } };
    } finally {
      section.delete();
      vec.delete();
    }
  }
  // A torus: u goes round its axis, v round the tube. The section at the start, spun round the axis.
  const p1 = at(uMin0, vMin);
  const p2 = at(uMin0, vMax);
  const pm = at(uMin0, 0.5);
  const s = crossSection(p1, pm, p2);
  const vm = 0.5;
  const span = uMax - uMin;
  if (!(span > 1e-6)) throw new NotAFillet("This rounded face has no length.");
  // The axis, from three points round it (in the order u grows, so spinning forwards follows the face).
  const steps = span > Math.PI ? [0, 1 / 3, 2 / 3] : [0, 0.5, 1];
  const q = steps.map((d) => at(d, vm)) as [Vec3, Vec3, Vec3];
  const round = circleThrough3D(q[0], q[1], q[2]);
  if (!round) throw new NotAFillet("This rounded face isn't a ring-shaped fillet.");
  const dir = unit(cross(sub(q[1], q[0]), sub(q[2], q[0])));
  const angle = Math.min(360, (span * 180) / Math.PI);
  const outside = cornerOutside(face, pm, s.corner);
  const section = sectionFace(p1, pm, p2, s.corner);
  try {
    const solid = revolution(section, round.centre, dir, angle);
    return { solid, wedge: { corner: s.corner, radius: s.radius, outside, axis: { origin: round.centre, dir, angle } } };
  } finally {
    section.delete();
  }
}

/** The faces sharing an edge with this one. */
function neighbours(face: Face, all: Face[]): Face[] {
  const mine = edgesOf(face);
  try {
    return all.filter((f) => !f.isSame(face) && edgesOf(f).some((e) => {
      const hit = mine.some((m) => m.isSame(e));
      e.delete();
      return hit;
    }));
  } finally {
    mine.forEach((e) => e.delete());
  }
}

/** A round face's tube radius (cylinder radius, or a torus's tube), for matching neighbouring fillets. */
function tubeRadius(face: Face): number | null {
  const kind = face.geomType;
  if (kind !== "CYLINDRE" && kind !== "TORUS") return null;
  const at = (u: number, v: number) => take(face.pointOnSurface(u, v));
  const pts = kind === "CYLINDRE" ? [at(0, 0), at(0.5, 0), at(1, 0)] : [at(0, 0), at(0, 0.5), at(0, 1)];
  return circleThrough3D(pts[0], pts[1], pts[2])?.radius ?? null;
}

/**
 * Onshape's "Propagate": the picked fillet faces plus the round faces of the
 * same radius that run on from them (a fillet round a rounded rectangle's
 * edge is several pieces). Returns new handles into `all`.
 */
export function propagateFillets(picked: Face[], all: Face[]): Face[] {
  const out: Face[] = all.filter((f) => picked.some((p) => p.isSame(f)));
  const queue = [...out];
  while (queue.length) {
    const f = queue.pop()!;
    const r = tubeRadius(f);
    if (r === null) continue;
    for (const n of neighbours(f, all)) {
      if (out.includes(n)) continue;
      const rn = tubeRadius(n);
      if (rn === null || Math.abs(rn - r) > Math.max(1e-4, r * 1e-4)) continue;
      out.push(n);
      queue.push(n);
    }
  }
  return out;
}

/** Edges of the part lying on the wedges' corner lines or circles: the sharp edges put back. */
export function recoveredEdges(shape: Shape3D, wedges: FilletWedge[]): Edge[] {
  const size = (() => {
    const b = shape.boundingBox;
    const s = Math.hypot(b.width, b.height, b.depth);
    b.delete();
    return s;
  })();
  const tol = Math.max(1e-4, size * 1e-6);
  const onCorner = (p: Vec3) =>
    wedges.some((w) => {
      if (w.along) {
        const L = len(w.along);
        const d = unit(w.along);
        const t = dot(sub(p, w.corner), d);
        if (t < -tol || t > L + tol) return false;
        return len(sub(sub(p, w.corner), scale(d, t))) < tol * 10;
      }
      const a = w.axis!;
      const rc = sub(w.corner, a.origin);
      const hc = dot(rc, a.dir);
      const rho = len(sub(rc, scale(a.dir, hc)));
      const rp = sub(p, a.origin);
      const hp = dot(rp, a.dir);
      return Math.abs(hp - hc) < tol * 10 && Math.abs(len(sub(rp, scale(a.dir, hp))) - rho) < tol * 10;
    });
  const out: Edge[] = [];
  for (const e of edgesOf(shape)) {
    const pts = [0.1, 0.5, 0.9].map((t) => take(e.pointAt(t)));
    if (pts.every(onCorner)) out.push(e);
    else e.delete();
  }
  return out;
}

export interface ModifyResult {
  shape: Shape3D;
  /** How many rounded faces were taken off (with Propagate, more than were picked). */
  faces: number;
}

/**
 * Take the fillet faces off (put the sharp edges back) and, with `radius`,
 * round the recovered edges again at that radius. Throws plain-English
 * errors; the input shape is left alone.
 */
export function modifyFillets(shape: Shape3D, picked: Face[], opts: { radius?: number; propagate: boolean }): ModifyResult {
  const all = facesOf(shape);
  let targets: Face[] = [];
  const pieces: { solid: Shape3D; wedge: FilletWedge }[] = [];
  try {
    targets = opts.propagate ? propagateFillets(picked, all) : all.filter((f) => picked.some((p) => p.isSame(f)));
    if (targets.length === 0) throw new NotAFillet("The picked faces can't be found on the part.");
    for (const f of targets) pieces.push(filletWedge(f));
    const join = (list: Shape3D[]): Shape3D | null => {
      let acc: Shape3D | null = null;
      for (const s of list) {
        if (!acc) {
          acc = s.clone();
          continue;
        }
        const next: Shape3D = acc.fuse(s, { simplify: false });
        acc.delete();
        acc = next;
      }
      return acc;
    };
    const grow = join(pieces.filter((p) => p.wedge.outside).map((p) => p.solid));
    const shrink = join(pieces.filter((p) => !p.wedge.outside).map((p) => p.solid));
    let result: Shape3D = shape;
    try {
      if (grow) result = result.fuse(grow);
      if (shrink) {
        const cut: Shape3D = result.cut(shrink);
        if (result !== shape) result.delete();
        result = cut;
      }
    } finally {
      grow?.delete();
      shrink?.delete();
    }
    if (result === shape) result = shape.clone();
    if (!soundSolid(result)) {
      result.delete();
      throw new Error("Couldn't take these fillets off cleanly — the faces either side don't meet in a sharp edge.");
    }
    if (opts.radius === undefined) return { shape: result, faces: targets.length };
    const edges = recoveredEdges(result, pieces.map((p) => p.wedge));
    if (edges.length === 0) {
      result.delete();
      throw new Error("The fillets came off, but the sharp edges they left couldn't be found to round again.");
    }
    let rounded: Shape3D;
    try {
      rounded = result.fillet((e: Edge) => (edges.some((c) => c.isSame(e)) ? opts.radius! : null));
    } catch {
      rounded = result;
    } finally {
      edges.forEach((e) => e.delete());
    }
    if (rounded === result || !soundSolid(rounded)) {
      if (rounded !== result) rounded.delete();
      result.delete();
      throw new Error(`Couldn't round these edges at ${round3(opts.radius)} mm. Try a smaller radius — it has to fit on the faces next to each edge.`);
    }
    result.delete();
    return { shape: rounded, faces: targets.length };
  } finally {
    pieces.forEach((p) => p.solid.delete());
    all.forEach((f) => f.delete());
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function soundSolid(shape: Shape3D): boolean {
  try {
    const solids = solidsOf(shape);
    const n = solids.length;
    solids.forEach((s) => s.delete());
    if (n === 0) return false;
    const analyzer = new (getOC().BRepCheck_Analyzer)(shape.wrapped, true, false, false);
    const ok = analyzer.IsValid();
    analyzer.delete();
    return ok;
  } catch {
    return false;
  }
}
