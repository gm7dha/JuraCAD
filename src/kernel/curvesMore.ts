/**
 * More curve features' geometry (see model/curves.ts): Offset curve (edges moved a set distance across a face),
 * Isocline (where a face slopes at a set angle to a direction) and Trim curve (a curve cut back to where it first
 * meets a face, a plane or another curve). The contouring itself is pure, in geometry/isoContour.ts.
 */
import { assembleWire, cast, getOC, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { clipRun, contourRuns, insidePieces, joinRuns, thinRun, type P2 } from "../geometry/isoContour";
import { chainEdges, interpolatedEdge, takeVec, wirePolyline } from "./curves";
import { nearestOnFace } from "./faceBlend";
import { edgesOf } from "./topology";

type Vec3 = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const dist = (a: Vec3, b: Vec3) => len(sub(a, b));

/** A face's surface for walking on: the nearest point on it (untrimmed) and the face's outward normal there. */
function surfaceOf(face: Face): { at: (q: Vec3) => { p: Vec3; n: Vec3 } | null; free: () => void } {
  const oc = getOC() as any;
  const surface = oc.BRep_Tool.Surface(face.wrapped);
  const props = new oc.BRepGProp_Face(face.wrapped, false);
  const at = (q: Vec3) => {
    const pnt = new oc.gp_Pnt(q[0], q[1], q[2]);
    const proj = new oc.GeomAPI_ProjectPointOnSurf(pnt, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    const on = new oc.gp_Pnt();
    const nv = new oc.gp_Vec();
    try {
      if (proj.NbPoints() < 1) return null;
      const { U, V } = proj.LowerDistanceParameters(0, 0);
      props.Normal(U, V, on, nv);
      if (nv.Magnitude() < 1e-12) return null;
      return { p: [on.X(), on.Y(), on.Z()] as Vec3, n: unit([nv.X(), nv.Y(), nv.Z()]) };
    } finally {
      nv.delete();
      on.delete();
      proj.delete();
      pnt.delete();
    }
  };
  return { at, free: () => props.delete() };
}

/** Whether a point lies on the face itself (not just on its surface beyond the face's edges). */
function onFace(face: Face, p: Vec3, tol = 1e-4): boolean {
  const q = nearestOnFace(face, p);
  return !!q && dist(p, q) <= tol;
}

/** The shape of an offset made by OpenCascade's planar offset (BRepOffsetAPI_MakeOffset), as wires; null if it fails. */
function planarOffset(spine: Face | Wire, by: number, open: boolean): Wire[] | null {
  const oc = getOC() as any;
  let op: any;
  try {
    op = new oc.BRepOffsetAPI_MakeOffset(spine.wrapped, oc.GeomAbs_JoinType.GeomAbs_Arc, open);
    op.Perform(by, 0);
    if (!op.IsDone()) return null;
    const shape = cast(op.Shape()) as unknown as Shape3D;
    try {
      const wires = chainEdges(edgesOf(shape));
      return wires.length ? wires : null;
    } finally {
      shape.delete();
    }
  } catch {
    return null;
  } finally {
    op?.delete();
  }
}

/** Points along a wire, close together (as it's drawn), for checks. */
function wireSamples(w: Wire): Vec3[] {
  const flat = wirePolyline(w);
  const out: Vec3[] = [];
  const step = Math.max(1, Math.floor(flat.length / 3 / 400));
  for (let i = 0; i + 2 < flat.length; i += 3 * step) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}

/** Is the first wire's middle on the face? */
function wiresOnFace(face: Face, wires: Wire[]): boolean {
  return onFace(face, takeVec(wires[0].pointAt(0.5)));
}

/**
 * A wire lying on a flat face (closed, or with `open`: an open chain, each corner joined round or cut back where the
 * moved pieces cross) or the face's whole outline, moved `d` across it exactly (lines stay lines, arcs arcs): into the
 * face, or `out` of it. Null when OpenCascade can't (the caller then walks it across).
 */
function planarExactOffset(face: Face, spine: Face | Wire, d: number, out: boolean, open = false): Wire[] | null {
  for (const by of [-d, d]) {
    const w = planarOffset(spine, by, open);
    if (!w) continue;
    if (wiresOnFace(face, w) !== out) return w;
    w.forEach((x) => x.delete());
  }
  return null;
}

/** The edges of a wire in order from its start, each with whether it's walked backwards. The caller frees the edges. */
function orderedEdges(w: Wire): { e: Edge; rev: boolean }[] {
  const left = edgesOf(w).map((e) => ({ e, a: takeVec(e.startPoint), b: takeVec(e.endPoint) }));
  const out: { e: Edge; rev: boolean }[] = [];
  let cur = takeVec(w.startPoint);
  while (left.length) {
    let k = left.findIndex((x) => dist(x.a, cur) < 1e-6);
    let rev = false;
    if (k < 0) {
      k = left.findIndex((x) => dist(x.b, cur) < 1e-6);
      rev = true;
    }
    if (k < 0) {
      // Not joined end to end as expected: keep the rest in the order given.
      out.push(...left.map((x) => ({ e: x.e, rev: false })));
      break;
    }
    const [x] = left.splice(k, 1);
    out.push({ e: x.e, rev });
    cur = rev ? x.a : x.b;
  }
  return out;
}

/** A sample along a wire: where, which way the wire runs there. */
interface Sample {
  p: Vec3;
  t: Vec3;
}

/** A wire's smooth stretches (split where the direction jumps by more than 2°), each as samples along it. */
function smoothStretches(w: Wire): { stretches: Sample[][]; closed: boolean; smoothLoop: boolean } {
  const edges = orderedEdges(w);
  const closed = w.isClosed;
  try {
    const perEdge = edges.map(({ e, rev }) => {
      let length = 0;
      let prev = takeVec(e.pointAt(0));
      for (let i = 1; i <= 32; i++) {
        const q = takeVec(e.pointAt(i / 32));
        length += dist(prev, q);
        prev = q;
      }
      const n = Math.max(8, Math.min(120, Math.ceil(length / 1.5)));
      const s: Sample[] = [];
      for (let i = 0; i <= n; i++) {
        const f = rev ? 1 - i / n : i / n;
        const t = unit(takeVec(e.tangentAt(f)));
        s.push({ p: takeVec(e.pointAt(f)), t: rev ? scale(t, -1) : t });
      }
      return s;
    });
    const smooth = (a: Sample[], b: Sample[]) => dot(a[a.length - 1].t, b[0].t) > Math.cos((2 * Math.PI) / 180);
    const stretches: Sample[][] = [];
    for (const s of perEdge) {
      const last = stretches[stretches.length - 1];
      if (last && smooth(last, s)) last.push(...s.slice(1));
      else stretches.push([...s]);
    }
    let smoothLoop = false;
    if (closed && stretches.length > 1 && smooth(stretches[stretches.length - 1], stretches[0])) {
      const tail = stretches.pop()!;
      stretches[0] = [...tail, ...stretches[0].slice(1)];
    } else if (closed && stretches.length === 1) smoothLoop = smooth(stretches[0], stretches[0]);
    return { stretches, closed, smoothLoop };
  } finally {
    edges.forEach((x) => x.e.delete());
  }
}

/** The shortest gap between two 3D segments: the parameters on each and the gap. */
function segmentGap(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): { s: number; t: number; gap: number } {
  const u = sub(a1, a0);
  const v = sub(b1, b0);
  const w = sub(a0, b0);
  const A = dot(u, u), B = dot(u, v), C = dot(v, v), D = dot(u, w), E = dot(v, w);
  const den = A * C - B * B;
  let s = den > 1e-18 ? (B * E - C * D) / den : 0;
  s = Math.max(0, Math.min(1, s));
  let t = C > 1e-18 ? (B * s + E) / C : 0;
  if (t < 0 || t > 1) {
    t = Math.max(0, Math.min(1, t));
    s = A > 1e-18 ? Math.max(0, Math.min(1, (B * t - D) / A)) : 0;
  }
  const pa = add(a0, scale(u, s));
  const pb = add(b0, scale(v, t));
  return { s, t, gap: dist(pa, pb) };
}

/**
 * A wire on a face walked `d` across the face, square to the wire, point by point along the surface (so on a round
 * face it follows the face round). Each smooth stretch is walked on its own; where two meet at a corner, the moved
 * stretches are cut back to where they cross (an inside corner) or joined by an arc walked round the corner (an
 * outside one), so corners never make loops. Splines are fitted through each piece.
 */
function walkedOffset(face: Face, wire: Wire, d: number, out: boolean): Wire {
  const surf = surfaceOf(face);
  try {
    const { stretches, closed, smoothLoop } = smoothStretches(wire);
    const steps = Math.max(4, Math.ceil(d / 0.5));
    const h = d / steps;
    const walk = (from: Vec3, dir0: Vec3): Vec3 => {
      let p = from;
      let dir = dir0;
      for (let k = 0; k < steps; k++) {
        const next = surf.at(add(p, scale(dir, h)));
        if (!next) throw new Error("The offset runs off the face's surface. Use a smaller distance.");
        const moved = sub(next.p, p);
        p = next.p;
        // Carry the direction on along the surface.
        const along = len(moved) > 1e-12 ? unit(moved) : dir;
        dir = unit(sub(along, scale(next.n, dot(along, next.n))));
      }
      return p;
    };
    // Each stretch: which way is into the face (tried from its middle, a little way across), then every sample walked.
    const moved = stretches.map((st) => {
      const mid = st[Math.floor(st.length / 2)];
      const here = surf.at(mid.p);
      if (!here) throw new Error("Couldn't find the face under the edges. Pick the face they lie on.");
      const probe = surf.at(add(mid.p, scale(unit(cross(here.n, mid.t)), Math.min(d, 0.05))));
      const into = !!probe && onFace(face, probe.p, 1e-5);
      const sign = (into ? 1 : -1) * (out ? -1 : 1);
      const dirs: Vec3[] = [];
      const pts = st.map((s) => {
        const at = surf.at(s.p);
        if (!at) throw new Error("Couldn't walk across the face from one of the edges.");
        const dir = scale(unit(cross(at.n, s.t)), sign);
        dirs.push(dir);
        return walk(at.p, dir);
      });
      return { pts, dirs, src: st.map((s) => s.p) };
    });
    const fit = (pts: Vec3[], loop: boolean): Edge => {
      const clean = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-7);
      if (clean.length < 2) throw new Error("The offset folds over itself here. Use a smaller distance.");
      return interpolatedEdge(clean, loop);
    };
    if (closed && smoothLoop) {
      const pts = moved[0].pts.slice(0, -1);
      return chainEdges([fit(pts, true)])[0];
    }
    // Corners between stretch i and the next (and the last and the first of a closed wire).
    const pieces = moved.map((m) => ({ pts: [...m.pts] }));
    const arcs: (Vec3[] | null)[] = moved.map(() => null);
    const corners = closed ? moved.length : moved.length - 1;
    for (let i = 0; i < corners; i++) {
      const j = (i + 1) % moved.length;
      const A = pieces[i].pts;
      const B = pieces[j].pts;
      // An inside corner: the moved stretches cross near it. Look along the end of A and the start of B.
      let best: { ia: number; ib: number; s: number; t: number; gap: number } | null = null;
      const reachA = Math.max(1, Math.floor(A.length * 0.6));
      const reachB = Math.max(1, Math.floor(B.length * 0.6));
      for (let ia = A.length - 2; ia >= A.length - 1 - reachA && ia >= 0; ia--) {
        for (let ib = 0; ib < reachB && ib + 1 < B.length; ib++) {
          const g = segmentGap(A[ia], A[ia + 1], B[ib], B[ib + 1]);
          if (!best || g.gap < best.gap) best = { ia, ib, ...g };
        }
      }
      const corner = moved[i].src[moved[i].src.length - 1];
      if (best && best.gap < Math.max(1e-3, 0.02 * d) && !(best.ia === A.length - 2 && best.s > 1 - 1e-9 && best.ib === 0 && best.t < 1e-9)) {
        const pa = add(A[best.ia], scale(sub(A[best.ia + 1], A[best.ia]), best.s));
        const pb = add(B[best.ib], scale(sub(B[best.ib + 1], B[best.ib]), best.t));
        const x = surf.at(scale(add(pa, pb), 0.5))?.p ?? pa;
        pieces[i].pts = [...A.slice(0, best.ia + 1), x];
        pieces[j].pts = [x, ...B.slice(best.ib + 1)];
        continue;
      }
      // An outside corner: round it, walking out from the corner in directions turning from A's to B's.
      const da = moved[i].dirs[moved[i].dirs.length - 1];
      const db = moved[j].dirs[0];
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(da, db))));
      const m = Math.max(2, Math.ceil(angle / ((8 * Math.PI) / 180)));
      const arc: Vec3[] = [A[A.length - 1]];
      const at = surf.at(corner);
      const axis = at ? at.n : unit(cross(da, db));
      for (let k = 1; k < m; k++) {
        // Turn da towards db about the face's normal at the corner.
        const f = k / m;
        const turn = Math.atan2(dot(cross(da, db), axis), dot(da, db)) * f;
        const dir = unit(add(add(scale(da, Math.cos(turn)), scale(cross(axis, da), Math.sin(turn))), scale(axis, dot(axis, da) * (1 - Math.cos(turn)))));
        arc.push(walk(at ? at.p : corner, dir));
      }
      arc.push(B[0]);
      arcs[i] = arc;
    }
    const edges: Edge[] = [];
    try {
      pieces.forEach((pc, i) => {
        edges.push(fit(pc.pts, false));
        const arc = arcs[i];
        if (arc) edges.push(fit(arc, false));
      });
      return assembleWire(edges);
    } finally {
      edges.forEach((e) => e.delete());
    }
  } finally {
    surf.free();
  }
}

/** Refuse an offset into a face that runs off it or into itself (the pieces aren't trimmed). */
function checkInside(face: Face, wires: Wire[]): void {
  for (const w of wires)
    for (const p of wireSamples(w))
      if (!onFace(face, p, 1e-3)) throw new Error("At that distance the moved edges run off the face (a hole's outline grows past the face's edge, or a corner is passed). Use a smaller distance.");
  for (let i = 0; i < wires.length; i++)
    for (let k = i + 1; k < wires.length; k++)
      if (gapTo(wires[k], takeVec(wires[i].pointAt(0))) < 1e-9 || shapesTouch(wires[i], wires[k]))
        throw new Error("At that distance the moved outlines run into each other. Use a smaller distance.");
}

/**
 * A flat face's whole outline moved in: the moved outer outline(s) (anticlockwise seen from outside the face) must
 * still hold every moved hole outline (clockwise), and no outer outline may sit inside a hole — else a hole has grown
 * past the outline (a big circle swallowing a small rectangle), which is refused.
 */
function checkNesting(face: Face, wires: Wire[], roles?: ("outer" | "hole")[]): void {
  const n = unit(takeVec(face.normalAt()));
  const u = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const v = cross(n, u);
  const loops = wires.map((w) => {
    const pts = wireSamples(w).map((p): P2 => [dot(p, u), dot(p, v)]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const pieces = pts.map((p, i): [P2, P2] => [p, pts[(i + 1) % pts.length]]);
    return { pts, area: area / 2, pieces };
  });
  // Which is which: as given (each from the face's outer outline or a hole's), else by the way round it runs.
  const outers = loops.filter((l, i) => (roles ? roles[i] === "outer" : l.area > 0));
  const holes = loops.filter((l, i) => (roles ? roles[i] === "hole" : l.area < 0));
  const inside = (pts: P2[], of: { pieces: [P2, P2][] }) => pts.every((p) => insidePieces(p, of.pieces) || nearPieces(p, of.pieces));
  const bad = () => {
    throw new Error("At that distance a hole's outline grows past the face's outline. Use a smaller distance.");
  };
  if (holes.length && !outers.length) bad();
  for (const h of holes) if (!outers.some((o) => inside(h.pts, o))) bad();
  for (const o of outers) for (const h of holes) if (inside(o.pts, h)) bad();
}

/** A shape's bounding box. */
function boxOf(sh: { boundingBox: { bounds: unknown; delete(): void } }): [Vec3, Vec3] {
  const b = sh.boundingBox;
  try {
    return b.bounds as [Vec3, Vec3];
  } finally {
    b.delete();
  }
}

/** Is a point on (within a micron of) any of these pieces? */
function nearPieces(p: P2, pieces: [P2, P2][]): boolean {
  for (const [a, b] of pieces) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    if (Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < 1e-3) return true;
  }
  return false;
}

/** Do two shapes touch or cross? */
function shapesTouch(a: { wrapped: unknown }, b: { wrapped: unknown }): boolean {
  const oc = getOC() as any;
  const ds = new oc.BRepExtrema_DistShapeShape();
  try {
    ds.LoadS1(a.wrapped);
    ds.LoadS2(b.wrapped);
    if (!ds.Perform() || ds.NbSolution() === 0) return false;
    return ds.Value() < 1e-6;
  } finally {
    ds.delete();
  }
}

/**
 * Offset curve: `edges` (or, with none, every edge round the face) moved `d` across `face` — into it, or `out` of it.
 * On a flat face everything is exact (OpenCascade's offset; corners rounded outside, cut back inside); on curved faces
 * the edges are walked across the surface, stretch by stretch. Moved into the face, a result that runs off it or into
 * itself is refused.
 */
export function offsetOnFace(face: Face, edges: Edge[], d: number, out: boolean): Wire[] {
  if (!(d > 1e-9)) throw new Error("The distance must be more than 0.");
  const flat = face.geomType === "PLANE";
  const outWires: Wire[] = [];
  try {
    if (!edges.length && flat) {
      const exact = planarExactOffset(face, face, d, out);
      if (exact) {
        outWires.push(...exact);
        if (!out) {
          checkInside(face, outWires);
          checkNesting(face, outWires);
        }
        return outWires;
      }
    }
    // The edges (or the face's own, less a round face's seam, which runs along its side) joined into runs.
    let list = edges;
    if (!list.length) {
      const oc = getOC() as any;
      list = edgesOf(face).filter((e) => {
        const seam = oc.BRep_Tool.IsClosed(e.wrapped, face.wrapped);
        if (seam) e.delete();
        return !seam;
      });
      const seen: Edge[] = [];
      list = list.filter((e) => {
        if (seen.some((x) => x.isSame(e))) {
          e.delete();
          return false;
        }
        seen.push(e);
        return true;
      });
    }
    const wholeFace = !edges.length;
    const wires = chainEdges(list);
    const roles: ("outer" | "hole")[] = [];
    try {
      // (The face's own outline: its biggest loop is the outside, the rest holes.)
      const sizes = wires.map((w) => {
        const [lo, hi] = boxOf(w);
        return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      });
      const biggest = sizes.indexOf(Math.max(...sizes));
      wires.forEach((w, i) => {
        const exact = flat ? planarExactOffset(face, w, d, out, !w.isClosed) : null;
        const made = exact ?? [walkedOffset(face, w, d, out)];
        outWires.push(...made);
        made.forEach(() => roles.push(i === biggest ? "outer" : "hole"));
      });
    } finally {
      wires.forEach((w) => w.delete());
    }
    if (!out) {
      checkInside(face, outWires);
      if (wholeFace && flat) checkNesting(face, outWires, roles);
    }
    return outWires;
  } catch (e) {
    outWires.forEach((w) => w.delete());
    throw e;
  }
}

/** A face's outline in its own (u, v) parameters, as short straight pieces, each knowing its edge's curve on the face. */
function uvOutline(face: Face): { pieces: [P2, P2][]; at: (piece: number, t: number) => P2; free: () => void } {
  const oc = getOC() as any;
  const pieces: [P2, P2][] = [];
  const owners: { c: any; t0: number; t1: number }[] = [];
  const curves: any[] = [];
  const n = 48;
  for (const e of edgesOf(face)) {
    try {
      const c = new oc.BRepAdaptor_Curve2d(e.wrapped, face.wrapped);
      curves.push(c);
      const t0 = c.FirstParameter();
      const t1 = c.LastParameter();
      const value = (t: number): P2 => {
        const q = c.Value(t);
        const p: P2 = [q.X(), q.Y()];
        q.delete();
        return p;
      };
      let prev = value(t0);
      for (let k = 1; k <= n; k++) {
        const a = t0 + ((t1 - t0) * (k - 1)) / n;
        const b = t0 + ((t1 - t0) * k) / n;
        const p = value(b);
        pieces.push([prev, p]);
        owners.push({ c: { value }, t0: a, t1: b });
        prev = p;
      }
    } catch {
      // an edge with no curve on the face (shouldn't happen)
    } finally {
      e.delete();
    }
  }
  return {
    pieces,
    at: (piece, t) => owners[piece].c.value(owners[piece].t0 + (owners[piece].t1 - owners[piece].t0) * t),
    free: () => curves.forEach((c) => c.delete()),
  };
}

/**
 * Isocline: the lines on a face where its outward normal makes the slope given with a direction — n·dir = `sine`
 * (sine = sin of the angle: 0 = where the face is upright to the direction, its outline seen along it). Sampled on
 * the face's (u, v) grid, contoured (each crossing found exactly), cut to the face's outline — each line running
 * right up to the face's edge, where it meets it found exactly along the edge — and splines fitted through the lines.
 */
export function isoclineWires(face: Face, dir: Vec3, sine: number, gridSize = 96): Wire[] {
  const oc = getOC() as any;
  const d = unit(dir);
  const props = new oc.BRepGProp_Face(face.wrapped, false);
  const pnt = new oc.gp_Pnt();
  const vec = new oc.gp_Vec();
  const outline = uvOutline(face);
  try {
    const { uMin, uMax, vMin, vMax } = face.UVBounds;
    const eps = 1e-7;
    const nu = gridSize + 1;
    const nv = gridSize + 1;
    const U = (i: number) => uMin + (uMax - uMin) * (eps + ((1 - 2 * eps) * i) / gridSize);
    const V = (j: number) => vMin + (vMax - vMin) * (eps + ((1 - 2 * eps) * j) / gridSize);
    const f = (u: number, v: number) => {
      props.Normal(u, v, pnt, vec);
      const m = vec.Magnitude();
      if (m < 1e-12) return NaN;
      return (vec.X() * d[0] + vec.Y() * d[1] + vec.Z() * d[2]) / m - sine;
    };
    const values = new Float64Array(nu * nv);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) values[i + j * nu] = f(U(i), V(j));
    const bisect = (at: (s: number) => P2, fa: number): P2 | null => {
      let lo = 0;
      let hi = 1;
      let flo = fa;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        const p = at(m);
        const fm = f(p[0], p[1]);
        if (!Number.isFinite(fm)) return null;
        if (fm > 0 === flo > 0) {
          lo = m;
          flo = fm;
        } else hi = m;
      }
      return at((lo + hi) / 2);
    };
    const refine = (a: P2, b: P2, fa: number): P2 => bisect((m) => [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m], fa) ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // Where a line meets the face's edge: along that edge's own curve on the face, where the slope is just right.
    const onOutline = (piece: number, t: number, guess: P2): P2 => {
      const a = outline.at(piece, 0);
      const b = outline.at(piece, 1);
      const fa = f(a[0], a[1]);
      const fb = f(b[0], b[1]);
      if (!(Number.isFinite(fa) && Number.isFinite(fb)) || fa > 0 === fb > 0) return guess;
      void t;
      return bisect((m) => outline.at(piece, m), fa) ?? guess;
    };
    const runs = contourRuns({ nu, nv, u: U, v: V, values }, refine).flatMap((r) => clipRun(r, outline.pieces, onOutline));
    const point = (q: P2): Vec3 => {
      props.Normal(q[0], q[1], pnt, vec);
      return [pnt.X(), pnt.Y(), pnt.Z()];
    };
    const in3d = runs.map((r) => ({ points: r.points.map(point), closed: r.closed }));
    const joined = joinRuns(in3d, 1e-3);
    const out: Wire[] = [];
    for (const r of joined) {
      const pts = thinRun(r.points, 0.02, 400);
      if (pts.length < 2) continue;
      if (r.closed && pts.length < 3) continue;
      try {
        out.push(...chainEdges([interpolatedEdge(pts, r.closed)]));
      } catch {
        // too short to fit
      }
    }
    return out;
  } finally {
    outline.free();
    vec.delete();
    pnt.delete();
    props.delete();
  }
}

/** How far a point is from a shape (a face, a plane's sheet, a curve). */
function gapTo(shape: { wrapped: unknown }, p: Vec3): number {
  const oc = getOC() as any;
  const pt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const vertex = new oc.BRepBuilderAPI_MakeVertex(pt);
  const ds = new oc.BRepExtrema_DistShapeShape();
  try {
    ds.LoadS1(vertex.Vertex());
    ds.LoadS2(shape.wrapped);
    if (!ds.Perform() || ds.NbSolution() === 0) return Infinity;
    return ds.Value();
  } finally {
    ds.delete();
    vertex.delete();
    pt.delete();
  }
}

/**
 * Trim curve: a wire cut where it first meets `bound` (faces, a plane's sheet or another curve), walking from its
 * start — or, with `keepEnd`, from its end (the result still runs the wire's way). Throws a plain message when they
 * don't meet.
 */
export function trimWire(wire: Wire, bound: { wrapped: unknown }, keepEnd: boolean): Wire {
  const oc = getOC() as any;
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  let pieces: Edge[];
  try {
    args.Append(wire.wrapped);
    tools.Append(bound.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (splitter.HasErrors()) throw new Error("Couldn't find where the curve meets that.");
    const result = cast(splitter.Shape()) as unknown as Shape3D;
    pieces = edgesOf(result);
    result.delete();
  } finally {
    splitter.delete();
    args.delete();
    tools.delete();
  }
  const tol = 1e-4;
  const left = pieces.map((e) => ({ e, ends: [takeVec(e.startPoint), takeVec(e.endPoint)] as [Vec3, Vec3] }));
  const kept: Edge[] = [];
  try {
    const from = takeVec(keepEnd ? wire.endPoint : wire.startPoint);
    let cur = from;
    let met = false;
    while (left.length) {
      const k = left.findIndex((x) => dist(x.ends[0], cur) <= tol || dist(x.ends[1], cur) <= tol);
      if (k < 0) break;
      const [{ e, ends }] = left.splice(k, 1);
      kept.push(e);
      cur = dist(ends[0], cur) <= tol ? ends[1] : ends[0];
      if (gapTo(bound, cur) <= tol) {
        met = true;
        break;
      }
    }
    if (!met) {
      // (A meeting where the walk starts doesn't count: the curve is cut back to the next one.)
      if (gapTo(bound, from) <= tol)
        throw new Error(`The curve only touches that at its ${keepEnd ? "end" : "start"}, so there's nothing to cut back to.${keepEnd ? "" : " Tick “Keep the other end” to cut from its end instead."}`);
      throw new Error("The curve doesn't meet that face, plane or curve, so there's nothing to cut it back to.");
    }
    // In the wire's own order (the split pieces keep their direction), so the result runs the wire's way.
    return assembleWire(keepEnd ? [...kept].reverse() : kept);
  } finally {
    kept.forEach((e) => e.delete());
    left.forEach((x) => x.e.delete());
  }
}
