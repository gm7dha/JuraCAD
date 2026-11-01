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
  /** About this many places measured for wall thickness, spread evenly by area. */
  samples?: number;
}

/** A part's mesh (as the 3D view has it): corners, triangles and which face each run of triangles is. */
export interface PrintMesh {
  vertices: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faceGroups: { start: number; count: number; faceId: number }[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The same mesh as the 3D view shows, so the marks lie exactly on its faces (and it's quick). */
const MESH = { tolerance: 0.05, angularTolerance: 0.25 };

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

/** A face's exact surface: the nearest place on it to a point, and the direction square to it there (either way out). */
type Project = (near: V) => { p: V; n: V } | null;

/** Planes, cylinders and spheres are worked out directly; other surfaces ask OpenCascade. */
function projector(oc: any, face: Face): Project | null {
  const kind = face.geomType;
  if (kind === "PLANE") {
    let n: V;
    try {
      const v = face.normalAt();
      n = unit([v.x, v.y, v.z]);
      v.delete();
    } catch {
      return null;
    }
    const at = (() => {
      const c = face.center;
      const out: V = [c.x, c.y, c.z];
      c.delete();
      return out;
    })();
    return (q) => {
      const d = dotv(sub(q, at), n);
      return { p: [q[0] - n[0] * d, q[1] - n[1] * d, q[2] - n[2] * d], n };
    };
  }
  if (kind === "CYLINDRE" || kind === "SPHERE") {
    const made: any[] = [];
    try {
      const adaptor = new oc.BRepAdaptor_Surface(face.wrapped, true);
      made.push(adaptor);
      if (kind === "CYLINDRE") {
        const cyl = adaptor.Cylinder();
        const ax = cyl.Axis();
        const loc = ax.Location();
        const dir = ax.Direction();
        made.push(cyl, ax, loc, dir);
        const o: V = [loc.X(), loc.Y(), loc.Z()];
        const a: V = [dir.X(), dir.Y(), dir.Z()];
        const r = cyl.Radius();
        return (q) => {
          const rel = sub(q, o);
          const along = dotv(rel, a);
          const radial = sub(rel, [a[0] * along, a[1] * along, a[2] * along]);
          const len = Math.hypot(...radial);
          if (len < 1e-9) return null;
          const n: V = [radial[0] / len, radial[1] / len, radial[2] / len];
          return { p: [o[0] + a[0] * along + n[0] * r, o[1] + a[1] * along + n[1] * r, o[2] + a[2] * along + n[2] * r], n };
        };
      }
      const sph = adaptor.Sphere();
      const loc = sph.Location();
      made.push(sph, loc);
      const c: V = [loc.X(), loc.Y(), loc.Z()];
      const r = sph.Radius();
      return (q) => {
        const rel = sub(q, c);
        const len = Math.hypot(...rel);
        if (len < 1e-9) return null;
        const n: V = [rel[0] / len, rel[1] / len, rel[2] / len];
        return { p: [c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r], n };
      };
    } catch {
      // fall back to OpenCascade below
    } finally {
      made.forEach((x) => x?.delete?.());
    }
  }
  let surface: any;
  try {
    surface = oc.BRep_Tool.Surface(face.wrapped);
  } catch {
    return null;
  }
  const project: Project = (near) => {
    const made: any[] = [];
    try {
      const pnt = new oc.gp_Pnt(near[0], near[1], near[2]);
      made.push(pnt);
      const proj = new oc.GeomAPI_ProjectPointOnSurf(pnt, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
      made.push(proj);
      if (proj.NbPoints() < 1) return null;
      const { U, V: Vv } = proj.LowerDistanceParameters(0, 0);
      const props = new oc.BRepGProp_Face(face.wrapped, false);
      const at = new oc.gp_Pnt();
      const nv = new oc.gp_Vec();
      made.push(props, at, nv);
      props.Normal(U, Vv, at, nv);
      if (nv.Magnitude() < 1e-12) return null;
      return { p: [at.X(), at.Y(), at.Z()], n: unit([nv.X(), nv.Y(), nv.Z()]) };
    } catch {
      return null;
    } finally {
      made.forEach((x) => x?.delete?.());
    }
  };
  (project as Project & { free?: () => void }).free = () => surface?.delete?.();
  return project;
}

/** Where the ray from `o` along `d` really meets a surface, starting from a guess `t`. */
function refineHit(project: Project, o: V, d: V, t: number): { t: number; n: V | null } {
  let tt = t;
  let n: V | null = null;
  for (let i = 0; i < 6; i++) {
    const hit = project([o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt]);
    if (!hit) break;
    n = hit.n;
    const next = dotv(sub(hit.p, o), d);
    if (Math.abs(next - tt) < 1e-8) return { t: next, n };
    tt = next;
  }
  return { t: tt, n };
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
    const made: any[] = [];
    try {
      const adaptor = new oc.BRepAdaptor_Surface(f.wrapped, true);
      made.push(adaptor);
      const cyl = adaptor.Cylinder();
      const ax = cyl.Axis();
      const loc = ax.Location();
      const dir = ax.Direction();
      made.push(cyl, ax, loc, dir);
      const radius = cyl.Radius();
      const axis: V = [dir.X(), dir.Y(), dir.Z()];
      const origin: V = [loc.X(), loc.Y(), loc.Z()];
      const b = f.UVBounds;
      const mid = new oc.gp_Pnt();
      const props = new oc.BRepGProp_Face(f.wrapped, false);
      const at = new oc.gp_Pnt();
      const nv = new oc.gp_Vec();
      made.push(mid, props, at, nv);
      adaptor.D0((b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2, mid);
      props.Normal((b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2, at, nv);
      const p: V = [mid.X(), mid.Y(), mid.Z()];
      const n: V = [nv.X(), nv.Y(), nv.Z()];
      const rel = sub(p, origin);
      const radial = sub(rel, axis.map((a) => a * dotv(rel, axis)) as V);
      out.push({ radius, hole: dotv(n, radial) < 0, span: b.uMax - b.uMin, axis, at: origin, group: groupOf.get(f) ?? -1 });
    } catch {
      // not measurable; leave it out
    } finally {
      made.forEach((x) => x?.delete?.());
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

/** Distance from a point to the nearest of some line pieces (6 numbers each). */
function distanceToSegments(p: V, segs: number[]): number {
  let best = Infinity;
  for (let i = 0; i < segs.length; i += 6) {
    const a: V = [segs[i], segs[i + 1], segs[i + 2]];
    const ab = sub([segs[i + 3], segs[i + 4], segs[i + 5]], a);
    const l2 = dotv(ab, ab);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dotv(sub(p, a), ab) / l2)) : 0;
    const d = Math.hypot(...sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
    if (d < best) best = d;
  }
  return best;
}

/** Where two faces meet, as line pieces from the mesh, by face pair "a,b" (a < b). */
function sharedEdges(vertices: ArrayLike<number>, triangles: ArrayLike<number>, faceOfTri: Int32Array): Map<string, number[]> {
  // Faces don't share mesh corners, so corners are matched by position.
  const key = (i: number) => `${Math.round(vertices[i * 3] * 1e4)},${Math.round(vertices[i * 3 + 1] * 1e4)},${Math.round(vertices[i * 3 + 2] * 1e4)}`;
  const edges = new Map<string, { face: number; a: number; b: number }[]>();
  for (let t = 0; t < triangles.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t * 3 + k];
      const b = triangles[t * 3 + ((k + 1) % 3)];
      const ka = key(a);
      const kb = key(b);
      const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = edges.get(e) ?? [];
      list.push({ face: faceOfTri[t], a, b });
      edges.set(e, list);
    }
  }
  const out = new Map<string, number[]>();
  for (const list of edges.values()) {
    if (list.length < 2 || list[0].face === list[1].face || list[0].face < 0 || list[1].face < 0) continue;
    const [f, g] = [list[0].face, list[1].face].sort((x, y) => x - y);
    const segs = out.get(`${f},${g}`) ?? [];
    const { a, b } = list[0];
    segs.push(vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2], vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]);
    out.set(`${f},${g}`, segs);
  }
  return out;
}

/** Check one solid part for 3D printing, sitting on the bed with `down` pointing into it. */
export function analysePrint(partId: string, name: string, shape: Shape3D, opts: PrintCheckOptions, shown?: PrintMesh): PrintPartResult {
  const oc = getOC() as any;
  const down = unit(opts.down);
  const faces = facesOf(shape);
  // The view's mesh when it's at hand and still matches the shape's faces; otherwise make one.
  const known = new Set(faces.map((f) => f.hashCode));
  const mesh: PrintMesh = shown && shown.faceGroups.length === faces.length && shown.faceGroups.every((g) => known.has(g.faceId)) ? shown : shape.mesh(MESH);
  const { vertices, triangles, faceGroups } = mesh;
  const triCount = triangles.length / 3;

  const size = bedExtents(vertices, down).size;
  const over = findOverhangs(vertices, triangles, down, opts.overhangAngle);

  // Which B-rep face each triangle belongs to.
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
  const projectors = groupFace.map((f) => (f ? projector(oc, f) : null));

  let thinnest: number | null = null;
  let thinnestAt: V | null = null;
  let thinArea = 0;
  let sharpEdges = false;
  const thinSoup: number[] = [];
  try {
    // Wall thickness: from places spread evenly over the surface, measure straight in to the far side.
    const tree = new TriangleTree(vertices, triangles);
    const corner = (t: number, k: number): V => {
      const v = triangles[t * 3 + k] * 3;
      return [vertices[v], vertices[v + 1], vertices[v + 2]];
    };
    const areas = new Float64Array(triCount);
    let totalArea = 0;
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = [corner(t, 0), corner(t, 1), corner(t, 2)];
      areas[t] = Math.hypot(...crossv(sub(b, a), sub(c, a))) / 2;
      totalArea += areas[t];
    }
    const budget = opts.samples ?? 2500;
    const perArea = totalArea > 0 ? budget / totalArea : 0;
    const edgesBetween = sharedEdges(vertices, triangles, faceOfTri);
    const sag = 4 * MESH.tolerance;
    let carry = 0;
    for (let t = 0; t < triCount; t++) {
      const g = faceOfTri[t];
      const project = g >= 0 ? projectors[g] : null;
      const A = areas[t];
      if (!project || A < 1e-12) continue;
      // This triangle's share of the samples (fractions carried on, so small triangles take turns).
      carry += A * perArea;
      const count = Math.floor(carry);
      if (count < 1) continue;
      carry -= count;
      const [a, b, c] = [corner(t, 0), corner(t, 1), corner(t, 2)];
      const triNormal = crossv(sub(b, a), sub(c, a));
      // L × L small triangles, about `count` of them.
      const L = Math.max(1, Math.min(40, Math.round(Math.sqrt(count))));
      const at = (i: number, j: number): V => {
        const u = i / L;
        const v = j / L;
        return [a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v];
      };
      const cells: [V, V, V][] = [];
      for (let i = 0; i < L; i++) {
        for (let j = 0; i + j < L; j++) {
          cells.push([at(i, j), at(i + 1, j), at(i, j + 1)]);
          if (i + j < L - 1) cells.push([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
      }
      for (const [c0, c1, c2] of cells) {
        const mid: V = [(c0[0] + c1[0] + c2[0]) / 3, (c0[1] + c1[1] + c2[1]) / 3, (c0[2] + c1[2] + c2[2]) / 3];
        const exact = project(mid);
        if (!exact) continue;
        // Outwards is the way the mesh's triangles face (a face's own direction may be flipped).
        const nF: V = dotv(exact.n, triNormal) < 0 ? [-exact.n[0], -exact.n[1], -exact.n[2]] : exact.n;
        const dir: V = [-nF[0], -nF[1], -nF[2]];
        let tMin = 1e-5;
        let thickness: number | null = null;
        let hitFace = -1;
        let hitNormal: V | null = null;
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
          const [p0, p1, p2] = [corner(tri, 0), corner(tri, 1), corner(tri, 2)];
          const hitTri = crossv(sub(p1, p0), sub(p2, p0));
          const hp = hg >= 0 ? projectors[hg] : null;
          const refined = hp ? refineHit(hp, exact.p, dir, dist) : { t: dist, n: unit(hitTri) };
          if (refined.t < 1e-4) {
            tMin = dist + 1e-6;
            continue;
          }
          thickness = refined.t;
          hitFace = hg;
          hitNormal = refined.n ? (dotv(refined.n, hitTri) < 0 ? [-refined.n[0], -refined.n[1], -refined.n[2]] : refined.n) : unit(hitTri);
          break;
        }
        if (thickness === null) continue;
        // A sharp edge (two faces meeting at a narrow angle) is thin only right at its tip; that's the shape, not a weak wall.
        if (thickness < opts.minWall && hitFace >= 0 && hitFace !== g && hitNormal) {
          const segs = edgesBetween.get(g < hitFace ? `${g},${hitFace}` : `${hitFace},${g}`);
          if (segs) {
            const inside = Math.PI - Math.acos(Math.max(-1, Math.min(1, dotv(nF, hitNormal))));
            const reach = Math.min(6 * opts.minWall, 1.25 * Math.max(opts.minWall, inside < Math.PI / 2 - 1e-6 ? opts.minWall / Math.tan(inside) : 0));
            if (distanceToSegments(exact.p, segs) <= reach) {
              sharpEdges = true;
              continue;
            }
          }
        }
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
  } finally {
    projectors.forEach((p) => (p as (Project & { free?: () => void }) | null)?.free?.());
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
    ...(sharpEdges ? { sharpEdges } : {}),
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
