/**
 * 3D-print check on the real shape (OpenCascade): overhangs from the mesh,
 * wall thickness measured straight through the exact surfaces, and holes and
 * pins too narrow to print, read from the exact cylinders. The rules and the
 * wording are in src/model/printCheck.ts.
 */
import { getOC, type Face, type Shape3D } from "replicad";

import { bedExtents, findOverhangs, triangleSoup, unit, type PrintPartResult, type Vec3 } from "../model/printCheck";
import { facesOf } from "./topology";

export interface PrintCheckOptions {
  /** Into the bed, in model coordinates. */
  down: Vec3;
  overhangAngle: number;
  minWall: number;
  minHole: number;
  minPin: number;
  /** At most this many places measured for wall thickness. */
  samples?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const MESH = { tolerance: 0.02, angularTolerance: 0.2 };

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dotv = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossv = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A ray-casting tree over a mesh's triangles. */
class TriangleTree {
  private readonly tri: Float64Array;
  private readonly nodes: { min: V; max: V; left?: number; right?: number; start: number; end: number }[] = [];
  private readonly order: Uint32Array;

  constructor(vertices: ArrayLike<number>, triangles: ArrayLike<number>) {
    const count = triangles.length / 3;
    this.tri = new Float64Array(count * 9);
    for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) this.tri[t * 9 + k * 3 + j] = vertices[triangles[t * 3 + k] * 3 + j];
    this.order = new Uint32Array(count);
    for (let i = 0; i < count; i++) this.order[i] = i;
    if (count) this.build(0, count);
  }

  private centre(t: number, axis: number): number {
    const o = t * 9 + axis;
    return this.tri[o] + this.tri[o + 3] + this.tri[o + 6];
  }

  private build(start: number, end: number): number {
    const min: V = [Infinity, Infinity, Infinity];
    const max: V = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const o = this.order[i] * 9;
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) {
        const v = this.tri[o + k * 3 + j];
        if (v < min[j]) min[j] = v;
        if (v > max[j]) max[j] = v;
      }
    }
    const id = this.nodes.length;
    this.nodes.push({ min, max, start, end });
    if (end - start > 8) {
      const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
      const part = Array.from(this.order.subarray(start, end)).sort((a, b) => this.centre(a, axis) - this.centre(b, axis));
      this.order.set(part, start);
      const mid = (start + end) >> 1;
      const left = this.build(start, mid);
      const right = this.build(mid, end);
      Object.assign(this.nodes[id], { left, right });
    }
    return id;
  }

  /** Nearest hit along the ray beyond `tMin` (skipping `skip`), as [distance, triangle], or null. */
  cast(o: V, d: V, tMin: number, skip: (t: number) => boolean): [number, number] | null {
    if (!this.nodes.length) return null;
    let best = Infinity;
    let bestT = -1;
    const inv: V = [1 / d[0], 1 / d[1], 1 / d[2]];
    const stack = [0];
    while (stack.length) {
      const n = this.nodes[stack.pop()!];
      // Slab test against the box.
      let t0 = tMin;
      let t1 = best;
      for (let j = 0; j < 3; j++) {
        let a = (n.min[j] - o[j]) * inv[j];
        let b = (n.max[j] - o[j]) * inv[j];
        if (a > b) [a, b] = [b, a];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        t0 = Math.max(t0, a - 1e-9);
        t1 = Math.min(t1, b + 1e-9);
      }
      if (t0 > t1) continue;
      if (n.left !== undefined) {
        stack.push(n.left, n.right!);
        continue;
      }
      for (let i = n.start; i < n.end; i++) {
        const t = this.order[i];
        if (skip(t)) continue;
        const h = this.hit(t, o, d);
        if (h !== null && h > tMin && h < best) {
          best = h;
          bestT = t;
        }
      }
    }
    return bestT >= 0 ? [best, bestT] : null;
  }

  private hit(t: number, o: V, d: V): number | null {
    const q = this.tri;
    const k = t * 9;
    const e1: V = [q[k + 3] - q[k], q[k + 4] - q[k + 1], q[k + 5] - q[k + 2]];
    const e2: V = [q[k + 6] - q[k], q[k + 7] - q[k + 1], q[k + 8] - q[k + 2]];
    const p = crossv(d, e2);
    const det = dotv(e1, p);
    if (Math.abs(det) < 1e-14) return null;
    const inv = 1 / det;
    const s: V = [o[0] - q[k], o[1] - q[k + 1], o[2] - q[k + 2]];
    const u = dotv(s, p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    const qq = crossv(s, e1);
    const v = dotv(d, qq) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return null;
    return dotv(e2, qq) * inv;
  }
}

/** Exact place and outward direction on a face nearest a point. */
function onFace(oc: any, face: Face, surface: any, near: V, planar: { normal: V } | null): { p: V; n: V } | null {
  if (planar) return { p: near, n: planar.normal };
  try {
    const pnt = new oc.gp_Pnt(near[0], near[1], near[2]);
    const proj = new oc.GeomAPI_ProjectPointOnSurf(pnt, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    let out: { p: V; n: V } | null = null;
    if (proj.NbPoints() > 0) {
      const { U, V: Vv } = proj.LowerDistanceParameters(0, 0);
      const props = new oc.BRepGProp_Face(face.wrapped, false);
      const at = new oc.gp_Pnt();
      const nv = new oc.gp_Vec();
      props.Normal(U, Vv, at, nv);
      const n = unit([nv.X(), nv.Y(), nv.Z()]);
      if (nv.Magnitude() > 1e-12) out = { p: [at.X(), at.Y(), at.Z()], n };
      props.delete();
      at.delete();
      nv.delete();
    }
    proj.delete();
    pnt.delete();
    return out;
  } catch {
    return null;
  }
}

/** Where the ray from `o` along `d` really meets a face's surface, starting from a guess `t`. */
function refineHit(oc: any, surface: any, o: V, d: V, t: number): number {
  let tt = t;
  for (let i = 0; i < 4; i++) {
    try {
      const q = new oc.gp_Pnt(o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt);
      const proj = new oc.GeomAPI_ProjectPointOnSurf(q, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
      if (proj.NbPoints() > 0) {
        const p = proj.NearestPoint();
        const next = dotv(sub([p.X(), p.Y(), p.Z()], o), d);
        p.delete();
        proj.delete();
        q.delete();
        if (Math.abs(next - tt) < 1e-7) return next;
        tt = next;
      } else {
        proj.delete();
        q.delete();
        return tt;
      }
    } catch {
      return tt;
    }
  }
  return tt;
}

interface RoundFace {
  radius: number;
  hole: boolean;
  span: number;
  axis: V;
  at: V;
  group: number;
}

/** The part's round faces (cylinders): radius, axis, how far round they go, and whether they're a hole. */
function roundFaces(oc: any, faces: Face[], groupOf: Map<Face, number>): RoundFace[] {
  const out: RoundFace[] = [];
  for (const f of faces) {
    if (f.geomType !== "CYLINDRE") continue;
    try {
      const adaptor = new oc.BRepAdaptor_Surface(f.wrapped, true);
      const cyl = adaptor.Cylinder();
      const ax = cyl.Axis();
      const loc = ax.Location();
      const dir = ax.Direction();
      const radius = cyl.Radius();
      const axis: V = [dir.X(), dir.Y(), dir.Z()];
      const origin: V = [loc.X(), loc.Y(), loc.Z()];
      const b = f.UVBounds;
      const mid = new oc.gp_Pnt();
      adaptor.D0((b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2, mid);
      const p: V = [mid.X(), mid.Y(), mid.Z()];
      mid.delete();
      const props = new oc.BRepGProp_Face(f.wrapped, false);
      const at = new oc.gp_Pnt();
      const nv = new oc.gp_Vec();
      props.Normal((b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2, at, nv);
      const n: V = [nv.X(), nv.Y(), nv.Z()];
      props.delete();
      at.delete();
      nv.delete();
      const rel = sub(p, origin);
      const radial = sub(rel, axis.map((a) => a * dotv(rel, axis)) as V);
      out.push({ radius, hole: dotv(n, radial) < 0, span: b.uMax - b.uMin, axis, at: origin, group: groupOf.get(f) ?? -1 });
      [cyl, ax, loc, dir, adaptor].forEach((x) => x.delete?.());
    } catch {
      // not measurable; leave it out
    }
  }
  return out;
}

/** Round faces on the same axis and radius make one hole or pin (OpenCascade often splits a hole into halves). */
function roundFeatures(list: RoundFace[]): { radius: number; hole: boolean; groups: number[] }[] {
  const out: { radius: number; hole: boolean; span: number; axis: V; at: V; groups: number[] }[] = [];
  for (const r of list) {
    const same = out.find((o) => {
      if (o.hole !== r.hole || Math.abs(o.radius - r.radius) > 1e-4) return false;
      if (Math.abs(Math.abs(dotv(o.axis, r.axis)) - 1) > 1e-6) return false;
      const rel = sub(r.at, o.at);
      const off = sub(rel, o.axis.map((a) => a * dotv(rel, o.axis)) as V);
      return Math.hypot(...off) < 1e-4;
    });
    if (same) {
      same.span += r.span;
      same.groups.push(r.group);
    } else out.push({ ...r, groups: [r.group] });
  }
  // Only (nearly) whole rounds: a fillet is a part of a round and isn't a hole or a pin.
  return out.filter((o) => o.span >= 1.8 * Math.PI - 1e-6).map((o) => ({ radius: o.radius, hole: o.hole, groups: o.groups }));
}

/** Check one solid part for 3D printing, sitting on the bed with `down` pointing into it. */
export function analysePrint(partId: string, name: string, shape: Shape3D, opts: PrintCheckOptions): PrintPartResult {
  const oc = getOC() as any;
  const down = unit(opts.down);
  const mesh = shape.mesh(MESH);
  const { vertices, triangles, faceGroups } = mesh;
  const triCount = triangles.length / 3;

  const size = bedExtents(vertices, down).size;
  const over = findOverhangs(vertices, triangles, down, opts.overhangAngle);

  // Which B-rep face each triangle belongs to.
  const faces = facesOf(shape);
  const byHash = new Map<number, Face[]>();
  for (const f of faces) byHash.set(f.hashCode, [...(byHash.get(f.hashCode) ?? []), f]);
  const faceOfTri = new Int32Array(triCount).fill(-1);
  const groupFace: (Face | null)[] = [];
  const groupOf = new Map<Face, number>();
  faceGroups.forEach((g, gi) => {
    const f = byHash.get(g.faceId)?.shift() ?? null;
    groupFace.push(f);
    if (f) groupOf.set(f, gi);
    for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) faceOfTri[t] = gi;
  });
  const surfaces = groupFace.map((f) => (f ? oc.BRep_Tool.Surface(f.wrapped) : null));
  const planar = groupFace.map((f) => {
    if (!f || f.geomType !== "PLANE") return null;
    try {
      const n = f.normalAt();
      const out = { normal: unit([n.x, n.y, n.z]) };
      n.delete();
      return out;
    } catch {
      return null;
    }
  });

  // Wall thickness: from places spread evenly over the surface, measure straight in to the far side.
  const tree = new TriangleTree(vertices, triangles);
  const triArea = (t: number) => {
    const P = (k: number): V => [vertices[triangles[t * 3 + k] * 3], vertices[triangles[t * 3 + k] * 3 + 1], vertices[triangles[t * 3 + k] * 3 + 2]];
    const [a, b, c] = [P(0), P(1), P(2)];
    return Math.hypot(...crossv(sub(b, a), sub(c, a))) / 2;
  };
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) totalArea += triArea(t);
  const budget = opts.samples ?? 4000;
  const spacing = Math.max(Math.sqrt(totalArea / budget), 1e-3);
  let thinnest: number | null = null;
  let thinnestAt: V | null = null;
  let thinArea = 0;
  const thinSoup: number[] = [];
  const sag = 4 * MESH.tolerance;
  for (let t = 0; t < triCount; t++) {
    const g = faceOfTri[t];
    const face = g >= 0 ? groupFace[g] : null;
    if (!face) continue;
    const P = (k: number): V => [vertices[triangles[t * 3 + k] * 3], vertices[triangles[t * 3 + k] * 3 + 1], vertices[triangles[t * 3 + k] * 3 + 2]];
    const [a, b, c] = [P(0), P(1), P(2)];
    const A = triArea(t);
    if (A < 1e-12) continue;
    const triNormal = crossv(sub(b, a), sub(c, a));
    // Split big triangles into L × L smaller ones and measure from the middle of each upright one.
    const L = Math.max(1, Math.min(40, Math.ceil(Math.sqrt(A) / spacing)));
    const at = (i: number, j: number): V => {
      const u = i / L;
      const v = j / L;
      return [a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v];
    };
    // Every small triangle: the upright ones (i, j) and the upside-down ones between them.
    const cells: [V, V, V][] = [];
    for (let i = 0; i < L; i++) {
      for (let j = 0; i + j < L; j++) {
        cells.push([at(i, j), at(i + 1, j), at(i, j + 1)]);
        if (i + j < L - 1) cells.push([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
      }
    }
    for (const [c0, c1, c2] of cells) {
      const mid: V = [(c0[0] + c1[0] + c2[0]) / 3, (c0[1] + c1[1] + c2[1]) / 3, (c0[2] + c1[2] + c2[2]) / 3];
      const exact = onFace(oc, face, surfaces[g], mid, planar[g]);
      if (!exact) continue;
      // Inwards: against the outside direction, which the mesh's triangles always face (the face's own may be flipped).
      const flip = dotv(exact.n, triNormal) < 0 ? -1 : 1;
      const dir: V = [-flip * exact.n[0], -flip * exact.n[1], -flip * exact.n[2]];
      let tMin = 1e-5;
      let thickness: number | null = null;
      for (let tries = 0; tries < 4; tries++) {
        const hit = tree.cast(exact.p, dir, tMin, (x) => x === t);
        if (!hit) break;
        const [dist, tri] = hit;
        const hg = faceOfTri[tri];
        // Its own face, a hair's breadth in (the mesh cuts corners on curves): look further.
        if (hg === g && dist < sag) {
          tMin = dist + 1e-6;
          continue;
        }
        const exactDist = hg >= 0 && surfaces[hg] && !planar[hg] ? refineHit(oc, surfaces[hg], exact.p, dir, dist) : dist;
        if (exactDist < 1e-4) {
          tMin = dist + 1e-6;
          continue;
        }
        thickness = exactDist;
        break;
      }
      if (thickness === null) continue;
      if (thinnest === null || thickness < thinnest) {
        thinnest = thickness;
        thinnestAt = exact.p;
      }
      if (thickness < opts.minWall - 1e-6) {
        thinArea += A / cells.length;
        thinSoup.push(...c0, ...c1, ...c2);
      }
    }
  }

  // Holes and pins: whole round faces narrower than allowed.
  const rounds = roundFeatures(roundFaces(oc, faces.filter((f) => groupOf.has(f)), groupOf));
  const smallHoles: number[] = [];
  const thinPins: number[] = [];
  const smallTris: number[] = [];
  for (const r of rounds) {
    const d = 2 * r.radius;
    const small = r.hole ? d < opts.minHole - 1e-6 : d < opts.minPin - 1e-6;
    if (!small) continue;
    (r.hole ? smallHoles : thinPins).push(d);
    for (const gi of r.groups) {
      const fg = faceGroups[gi];
      if (fg) for (let t = fg.start / 3; t < (fg.start + fg.count) / 3; t++) smallTris.push(t);
    }
  }

  surfaces.forEach((s) => s?.delete?.());
  faces.forEach((f) => f.delete());

  return {
    partId,
    name,
    size,
    overhangArea: over.area,
    bedArea: over.bedArea,
    thinnest,
    thinnestAt,
    thinArea,
    smallHoles: smallHoles.sort((x, y) => x - y),
    thinPins: thinPins.sort((x, y) => x - y),
    marks: {
      overhang: triangleSoup(vertices, triangles, over.triangles),
      bed: triangleSoup(vertices, triangles, over.onBed),
      thin: new Float32Array(thinSoup),
      small: triangleSoup(vertices, triangles, smallTris),
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
