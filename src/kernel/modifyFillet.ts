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
import { assembleWire, basicFaceExtrusion, getOC, makeBox, makeFace, makeLine, makePolygon, makeThreePointArc, revolution, Vector, type Edge, type Face, type Shape3D } from "replicad";
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
export function filletWedge(face: Face, extend: [number, number] = [0, 0]): { solid: Shape3D; wedge: FilletWedge } {
  const kind = face.geomType;
  if (kind !== "CYLINDRE" && kind !== "TORUS") throw new NotAFillet("Pick rounded faces made by a fillet: a piece of a cylinder (along a straight edge) or of a ring (round a hole or a boss).");
  // replicad's pointOnSurface takes shares (0…1) of the face's own u and v ranges.
  const { uMin, uMax } = face.UVBounds;
  const at = (u: number, v: number) => take(face.pointOnSurface(u, v));
  const uMin0 = 0, uMax0 = 1, vMin = 0, vMax = 1;
  if (kind === "CYLINDRE") {
    // u goes round, v along: the section at the start, pushed along the fillet's length.
    const p1a = at(uMin0, vMin);
    const run = sub(at(uMin0, vMax), p1a);
    if (len(run) < 1e-6) throw new NotAFillet("This rounded face has no length.");
    // Carried on past an end that's cut by a flat face (trimmed back to that face afterwards).
    const d = unit(run);
    const back = scale(d, -extend[0]);
    const p1 = add(p1a, back);
    const p2 = add(at(uMax0, vMin), back);
    const pm = add(at(0.5, vMin), back);
    const s = crossSection(p1, pm, p2);
    const along = add(run, scale(d, extend[0] + extend[1]));
    const outside = cornerOutside(face, sub(pm, back), sub(s.corner, back));
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


const ROUND_KINDS = new Set(["CYLINDRE", "TORUS"]);
/** Normals within this of each other (about 1°) count as a smooth (tangent) join. */
const SMOOTH = Math.cos((1 * Math.PI) / 180);
const HASH_MAX = 2147483647;

/** Which faces share which edges (edge index → face indices), by hash so big parts stay quick. */
function adjacency(all: Face[]): { edges: Edge[]; faces: number[][]; edgesOfFace: number[][] } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const edges: Edge[] = [];
  const faces: number[][] = [];
  const edgesOfFace: number[][] = all.map(() => []);
  const buckets = new Map<number, number[]>();
  all.forEach((f, fi) => {
    for (const e of edgesOf(f)) {
      const h = oc.ReplicadShapeHasher.HashCode(e.wrapped, HASH_MAX) as number;
      const bucket = buckets.get(h) ?? [];
      const found = bucket.find((k) => edges[k].isSame(e));
      if (found !== undefined) {
        e.delete();
        if (!faces[found].includes(fi)) faces[found].push(fi);
        if (!edgesOfFace[fi].includes(found)) edgesOfFace[fi].push(found);
        continue;
      }
      const k = edges.length;
      edges.push(e);
      faces.push([fi]);
      edgesOfFace[fi].push(k);
      bucket.push(k);
      buckets.set(h, bucket);
    }
  });
  return { edges, faces, edgesOfFace };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const normalAt = (f: Face, p: Vec3) => unit(take(f.normalAt(p)));
/** Two faces meet smoothly at a point of their shared edge (their outward normals agree there). */
const smoothAt = (a: Face, b: Face, p: Vec3) => dot(normalAt(a, p), normalAt(b, p)) > SMOOTH;
const edgeMid = (e: Edge) => take(e.pointAt(0.5));

/**
 * Whether a point of a round face's edge lies on one of its long sides (where the faces it blends into are)
 * or on one of its ends: a cylinder's sides run along it (its u is the angle round), a torus's round it.
 */
function onSide(face: Face, kind: string, p: Vec3): boolean {
  const { uMin, uMax, vMin, vMax } = face.UVBounds;
  const [u0, v] = face.uvCoordinates(p);
  // u is an angle on both: bring it into the face's range a whole turn at a time.
  let u = u0;
  while (u < uMin - 1e-6) u += 2 * Math.PI;
  while (u > uMax + 1e-6) u -= 2 * Math.PI;
  const du = Math.min(Math.abs(u - uMin), Math.abs(u - uMax)) / Math.max(uMax - uMin, 1e-12);
  const dv = Math.min(Math.abs(v - vMin), Math.abs(v - vMax)) / Math.max(vMax - vMin, 1e-12);
  return kind === "CYLINDRE" ? du < dv : dv < du;
}

/** A round face's tube radius (cylinder radius, or a torus's tube), for matching neighbouring fillets. */
function tubeRadius(face: Face): number | null {
  const kind = face.geomType;
  if (!ROUND_KINDS.has(kind)) return null;
  const at = (u: number, v: number) => take(face.pointOnSurface(u, v));
  const pts = kind === "CYLINDRE" ? [at(0, 0), at(0.5, 0), at(1, 0)] : [at(0, 0), at(0, 0.5), at(0, 1)];
  return circleThrough3D(pts[0], pts[1], pts[2])?.radius ?? null;
}

interface Topology {
  all: Face[];
  kinds: string[];
  adj: ReturnType<typeof adjacency>;
}

/** The faces next to face i, each with the edges they share. */
function around(t: Topology, i: number): { j: number; edges: number[] }[] {
  const out = new Map<number, number[]>();
  for (const k of t.adj.edgesOfFace[i]) for (const j of t.adj.faces[k]) if (j !== i) out.set(j, [...(out.get(j) ?? []), k]);
  return [...out].map(([j, edges]) => ({ j, edges }));
}

/**
 * Onshape's "Propagate": the picked faces plus the rounded faces that carry on SMOOTHLY from them — across a
 * fillet's ends only (never sideways into the faces it blends), to pieces of the same radius or corner blends
 * (a ball where three fillets meet), each tangent at the shared edge. Mitred joins and slot ends aren't tangent,
 * so they aren't followed.
 */
function propagate(t: Topology, picked: number[]): number[] {
  const out = [...picked];
  const queue = [...picked];
  while (queue.length) {
    const i = queue.pop()!;
    const round = ROUND_KINDS.has(t.kinds[i]);
    const r = round ? tubeRadius(t.all[i]) : null;
    for (const { j, edges } of around(t, i)) {
      if (out.includes(j) || t.kinds[j] === "PLANE") continue;
      const p = edgeMid(t.adj.edges[edges[0]]);
      if (round && onSide(t.all[i], t.kinds[i], p)) continue;
      if (!smoothAt(t.all[i], t.all[j], p)) continue;
      if (ROUND_KINDS.has(t.kinds[j])) {
        const rj = tubeRadius(t.all[j]);
        // From a corner blend, a round neighbour must be a fillet of the chain's radius too (checked from its side).
        const ref = r ?? out.map((k) => (ROUND_KINDS.has(t.kinds[k]) ? tubeRadius(t.all[k]) : null)).find((x) => x !== null) ?? rj;
        if (rj === null || ref === null || Math.abs(rj - ref) > Math.max(1e-4, ref * 1e-4)) continue;
        if (onSide(t.all[j], t.kinds[j], p)) continue;
      }
      out.push(j);
      queue.push(j);
    }
  }
  return out;
}

const NOT_TANGENT = "This round face isn't a fillet — it meets the face beside it at a corner, not smoothly.";

/** Edges of the part lying on the wedges' corner lines or circles: the sharp edges put back. */
export function recoveredEdges(shape: Shape3D, wedges: FilletWedge[], beyond = 0): Edge[] {
  const tol = Math.max(1e-4, sizeOf(shape) * 1e-6);
  const onCorner = (p: Vec3) =>
    wedges.some((w) => {
      if (w.along) {
        const L = len(w.along);
        const d = unit(w.along);
        const t = dot(sub(p, w.corner), d);
        // (Past its ends by `beyond`: where a corner ball was, the sharp edge carries on to the corner.)
        if (t < -tol - beyond || t > L + tol + beyond) return false;
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
  return pickEdges(shape, onCorner);
}

function pickEdges(shape: Shape3D, test: (p: Vec3) => boolean): Edge[] {
  const out: Edge[] = [];
  for (const e of edgesOf(shape)) {
    const pts = [0.1, 0.5, 0.9].map((t) => take(e.pointAt(t)));
    if (pts.every(test)) out.push(e);
    else e.delete();
  }
  return out;
}

function sizeOf(shape: Shape3D): number {
  const b = shape.boundingBox;
  const s = Math.hypot(b.width, b.height, b.depth);
  b.delete();
  return s;
}

/** A flat face's plane: a point on it and its outward normal. */
interface Plane {
  p: Vec3;
  n: Vec3;
}
const planeOf = (f: Face): Plane => {
  const p = take(f.center);
  return { p, n: normalAt(f, p) };
};
const offPlane = (q: Vec3, pl: Plane) => dot(sub(q, pl.p), pl.n);

/** The side of a plane the part is on (behind its outward normal), as a block big enough to hold `box`. */
function behind(pl: Plane, box: [Vec3, Vec3]): Shape3D {
  const c: Vec3 = scale(add(box[0], box[1]), 0.5);
  const h = len(sub(box[1], box[0])) + 10;
  const foot = sub(c, scale(pl.n, offPlane(c, pl)));
  const u = unit(cross(pl.n, Math.abs(pl.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const v = cross(pl.n, u);
  const corner = (a: number, b: number): Vec3 => add(foot, add(scale(u, a * h), scale(v, b * h)));
  const square = makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  const depth = new Vector(scale(pl.n, -2 * h));
  try {
    return basicFaceExtrusion(square, depth) as Shape3D;
  } finally {
    square.delete();
    depth.delete();
  }
}

function boxOf(faces: Face[], grow: number): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    const b = f.boundingBox;
    const [a, z] = b.bounds;
    b.delete();
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k] - grow);
      hi[k] = Math.max(hi[k], z[k] + grow);
    }
  }
  return [lo, hi];
}

/** `a` cut down to the part of it on the inner side of every plane (frees `a`). */
function within(a: Shape3D, planes: Plane[], box: [Vec3, Vec3]): Shape3D {
  let out = a;
  for (const pl of planes) {
    const side = behind(pl, box);
    const next: Shape3D = out.intersect(side, { simplify: false });
    side.delete();
    out.delete();
    out = next;
  }
  return out;
}

export interface ModifyResult {
  shape: Shape3D;
  /** How many rounded faces were taken off (with Propagate, more than were picked). */
  faces: number;
  /** The ones taken with them by Propagate, in words ("4 upright edges, 8 corner pieces"); empty when none. */
  also: string;
}

/** Propagate's extra pieces in words, by kind: straight fillets by direction, round ones, corner pieces. */
function describeExtra(kinds: string[], along: (Vec3 | undefined)[]): string {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  kinds.forEach((kind, i) => {
    if (kind === "TORUS") return bump("round");
    if (kind !== "CYLINDRE") return bump("corner");
    const d = along[i] ? unit(along[i]!) : null;
    if (!d) return bump("straight");
    if (Math.abs(d[2]) > 0.999) return bump("upright");
    if (Math.abs(d[0]) > 0.999) return bump("x");
    if (Math.abs(d[1]) > 0.999) return bump("y");
    bump("straight");
  });
  const words: Record<string, [string, string]> = {
    x: ["edge along X", "edges along X"],
    y: ["edge along Y", "edges along Y"],
    upright: ["upright edge", "upright edges"],
    straight: ["slanted straight edge", "slanted straight edges"],
    round: ["round edge piece", "round edge pieces"],
    corner: ["corner piece where edges meet", "corner pieces where edges meet"],
  };
  const parts = ["x", "y", "upright", "straight", "round", "corner"].filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${counts.get(k) === 1 ? words[k][0] : words[k][1]}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Take the fillet faces off (put the sharp edges back) and, with `radius`,
 * round the recovered edges again at that radius. Throws plain-English
 * errors (NotAFillet for faces that aren't fillets it can take apart); the
 * input shape is left alone.
 *
 * Only what the fillets took away goes back: each round piece's own wedge
 * (added on an outside edge, cut in an inside corner), carried past ends cut
 * by a flat face and trimmed back to it, and each corner ball's corner block.
 * Holes, grooves and chamfers next to the fillets are left alone.
 */
export function modifyFillets(shape: Shape3D, picked: Face[], opts: { radius?: number; propagate: boolean }): ModifyResult {
  const all = facesOf(shape);
  const t: Topology = { all, kinds: all.map((f) => f.geomType), adj: adjacency(all) };
  const pieces: { solid: Shape3D; wedge: FilletWedge }[] = [];
  try {
    const pickedIdx = all.map((f, i) => (picked.some((p) => p.isSame(f)) ? i : -1)).filter((i) => i >= 0);
    if (pickedIdx.length === 0) throw new NotAFillet("The picked faces can't be found on the part.");
    for (const i of pickedIdx) {
      if (t.kinds[i] === "PLANE") throw new NotAFillet("Pick rounded faces made by a fillet, not flat ones.");
    }
    const chain = opts.propagate ? propagate(t, pickedIdx) : pickedIdx;
    const inChain = new Set(chain);
    // Every piece must blend smoothly into the faces along its sides; its ends may meet flat faces at any angle,
    // or other pieces of the chain. Anything else round at an end can't be put back sharp on its own.
    const sidesOf = new Map<number, number[]>();
    for (const i of chain) {
      const round = ROUND_KINDS.has(t.kinds[i]);
      const sides: number[] = [];
      for (const { j, edges } of around(t, i)) {
        if (inChain.has(j)) continue;
        for (const k of edges) {
          const p = edgeMid(t.adj.edges[k]);
          const side = round ? onSide(all[i], t.kinds[i], p) : true;
          if (side) {
            if (!smoothAt(all[i], all[j], p)) throw new NotAFillet(NOT_TANGENT);
            if (!sides.includes(j)) sides.push(j);
          } else if (t.kinds[j] !== "PLANE") {
            throw new NotAFillet(
              smoothAt(all[i], all[j], p)
                ? "This fillet carries on smoothly into the next rounded face. Tick “Propagate” to change them together."
                : "This fillet meets another rounded face at its end (a mitred corner). Pick the rounded faces meeting it too, so they're changed together.",
            );
          }
        }
      }
      sidesOf.set(i, sides);
      if (round) {
        if (sides.length === 0) throw new NotAFillet("This rounded face doesn't blend into any face beside it, so it isn't a fillet.");
      } else if (sides.some((j) => t.kinds[j] !== "PLANE")) {
        throw new NotAFillet("These rounded faces include a corner piece that blends into a curved face. They can't be put back sharp here.");
      }
    }
    const chainFaces = chain.map((i) => all[i]);
    const rounds = chain.filter((i) => ROUND_KINDS.has(t.kinds[i]));
    // Wedges for the round pieces (also tells which side each is on, and the corner lines).
    const planarEnds = (i: number, end: 0 | 1): Plane[] => {
      const out: Plane[] = [];
      for (const { j, edges } of around(t, i)) {
        if (inChain.has(j) || t.kinds[j] !== "PLANE") continue;
        for (const k of edges) {
          const p = edgeMid(t.adj.edges[k]);
          if (onSide(all[i], t.kinds[i], p)) continue;
          const [, v] = all[i].uvCoordinates(p);
          const { vMin, vMax } = all[i].UVBounds;
          if ((Math.abs(v - vMin) < Math.abs(v - vMax) ? 0 : 1) === end) out.push(planeOf(all[j]));
        }
      }
      return out;
    };
    const tubes = rounds.map((i) => tubeRadius(all[i]) ?? 0);
    const reach = 4 * Math.max(1, ...tubes);
    const trims: Plane[][] = [];
    for (const i of rounds) {
      const ends = t.kinds[i] === "CYLINDRE" ? [planarEnds(i, 0), planarEnds(i, 1)] : [[], []];
      const piece = filletWedge(all[i], [ends[0].length ? reach : 0, ends[1].length ? reach : 0]);
      if (t.kinds[i] === "TORUS") {
        // A ring piece ending on a flat face must end square to it (the face holds the ring's axis).
        for (const { j, edges } of around(t, i)) {
          if (inChain.has(j) || t.kinds[j] !== "PLANE") continue;
          const p = edgeMid(t.adj.edges[edges[0]]);
          if (onSide(all[i], "TORUS", p)) continue;
          const pl = planeOf(all[j]);
          const a = piece.wedge.axis!;
          if (Math.abs(dot(pl.n, a.dir)) > 1e-6 || Math.abs(offPlane(a.origin, pl)) > 1e-4) {
            piece.solid.delete();
            throw new NotAFillet("This round fillet ends on a slanted face, which can't be put back sharp yet.");
          }
        }
      }
      pieces.push(piece);
      trims.push([...ends[0], ...ends[1]]);
    }
    // Corner pieces (a ball where three fillets on outside edges meet): the corner block they rounded off — the
    // material within a radius of each of the three flat faces the fillets beside them blend into.
    const blends = chain.filter((i) => !ROUND_KINDS.has(t.kinds[i]));
    const blocks: Shape3D[] = [];
    let ballReach = 0;
    try {
      for (const b of blends) {
        const nextTo = around(t, b).map(({ j }) => j).filter((j) => inChain.has(j) && ROUND_KINDS.has(t.kinds[j]));
        const k = nextTo.map((j) => rounds.indexOf(j));
        if (!nextTo.length || k.some((x) => x < 0 || !pieces[x].wedge.outside)) {
          throw new NotAFillet("These rounded faces include a corner piece in an inside corner. It can't be put back sharp here.");
        }
        const faceIds = [...new Set(nextTo.flatMap((j) => (sidesOf.get(j) ?? []).filter((x) => t.kinds[x] === "PLANE")))];
        if (faceIds.length !== 3) throw new NotAFillet("These rounded faces include a corner piece that isn't where three flat faces meet. It can't be put back sharp here.");
        const d = Math.max(...nextTo.map((j) => tubeRadius(all[j]) ?? 0));
        ballReach = Math.max(ballReach, d);
        const planes = faceIds.map((x) => planeOf(all[x]));
        const box = boxOf([all[b]], 2 * d + 1);
        const slabs = planes.flatMap((pl) => [pl, { p: sub(pl.p, scale(pl.n, d)), n: scale(pl.n, -1) }]);
        blocks.push(within(makeBox(box[0], box[1]), slabs, box));
      }
    } catch (e) {
      blocks.forEach((x) => x.delete());
      throw e;
    }
    const join = (list: Shape3D[]): Shape3D | null => {
      let acc: Shape3D | null = null;
      for (const sh of list) {
        if (!acc) {
          acc = sh.clone();
          continue;
        }
        const next: Shape3D = acc.fuse(sh, { simplify: false });
        acc.delete();
        acc = next;
      }
      return acc;
    };
    // Only what the fillets took away goes back: each piece's own wedge (trimmed to the flat faces its ends meet) and
    // each corner block — never a region round them, which would fill holes and cuts next to the fillets.
    const box = boxOf(chainFaces, reach + 1);
    const trimmed = pieces.map((p, k) => (trims[k].length ? within(p.solid.clone(), trims[k], box) : p.solid.clone()));
    const grow = join([...trimmed.filter((_, k) => pieces[k].wedge.outside), ...blocks]);
    const shrink = join(trimmed.filter((_, k) => !pieces[k].wedge.outside));
    trimmed.forEach((x) => x.delete());
    blocks.forEach((x) => x.delete());
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
    const edgesFor = (r: Shape3D) => recoveredEdges(r, pieces.map((p) => p.wedge), ballReach * 1.01);
    const extra = chain.filter((i) => !pickedIdx.includes(i));
    const also = describeExtra(extra.map((i) => t.kinds[i]), extra.map((i) => pieces[rounds.indexOf(i)]?.wedge.along));
    if (!soundSolid(result)) {
      result.delete();
      throw new Error("Couldn't take these fillets off cleanly — the faces either side don't meet in a sharp edge.");
    }
    // Nothing round may be left where the fillets were.
    if (leftovers(result, chainFaces)) {
      result.delete();
      throw new Error("Couldn't take these fillets off cleanly — part of a rounded face was left behind.");
    }
    if (opts.radius === undefined) return { shape: result, faces: chain.length, also };
    const edges = edgesFor(result);
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
    return { shape: rounded, faces: chain.length, also };
  } finally {
    pieces.forEach((p) => p.solid.delete());
    t.adj.edges.forEach((e) => e.delete());
    all.forEach((f) => f.delete());
  }
}

/** Whether a face of the new part still lies on one of the old rounded faces (at its middle). */
function leftovers(result: Shape3D, old: Face[]): boolean {
  const mids = old.map((f) => take(f.pointOnSurface(0.5, 0.5)));
  const tol = Math.max(1e-4, sizeOf(result) * 1e-6) * 10;
  const faces = facesOf(result);
  try {
    return faces.some((f) => {
      if (f.geomType === "PLANE") return false;
      const c = take(f.pointOnSurface(0.5, 0.5));
      return mids.some((m) => len(sub(m, c)) < tol);
    });
  } finally {
    faces.forEach((f) => f.delete());
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
