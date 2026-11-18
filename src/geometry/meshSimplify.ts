/**
 * Recognising real faces in a closed triangle mesh (an STL, or a STEP file
 * that's really a mesh): which triangles make up one flat face, a hole, a
 * fillet…, the exact surface of each (plane, cylinder, cone or sphere, fitted
 * by least squares), and the exact edges where they meet (lines and circular
 * arcs, from the surfaces themselves where they can be worked out). The
 * result is a plan the engine turns into a proper solid (src/kernel/simplify.ts).
 * Pure maths, no OpenCascade.
 *
 * Steps:
 *  1. Triangles lying flat together (within the angle and distance) are
 *     grouped. On a round face each group is one facet strip.
 *  2. Groups meeting at gentle angles are grown into round faces: from the
 *     smallest group, neighbours are added while one cylinder, cone or sphere
 *     still fits every point within the distance. Flat faces don't fit, so a
 *     fillet stops where the flat face beside it starts.
 *  3. Where faces meet, the mesh edges are chained, and each chain is fitted
 *     as a line or a circle (exactly the circle where a plane cuts a cylinder
 *     square-on, say). A round face whose edges can't all be fitted is given
 *     back as its flat facets ("left as mesh").
 */
import type { SimplifyTolerances } from "../model/simplify";
import {
  add,
  cross,
  dist,
  dot,
  fitCircle3D,
  fitCone,
  fitCylinder,
  fitPlane,
  fitSphere,
  fitTorus,
  frameOf,
  norm,
  projectOnCircle,
  projectOnSurface,
  scale,
  sub,
  surfaceDistance,
  surfaceNormal,
  tidySurface,
  unit,
  ellipseParam,
  ellipsePoint,
  ontoBoth,
  projectOnEllipse,
  type Circle3,
  type Ellipse3,
  type FitSurface,
  type Vec3,
  circleDistance,
  canonicalX,
  coneAxisFromNormals,
} from "./shapeFit";

export type PlanCurve =
  | { kind: "line"; from: Vec3; to: Vec3 }
  /** Anticlockwise about `normal` from `from` to `to` (all the way round when `full`; then `to` = `from`). */
  | { kind: "arc"; centre: Vec3; normal: Vec3; radius: number; from: Vec3; to: Vec3; full: boolean }
  /**
   * Where a plane cuts a cylinder at a slant (a slanted hole's rim): anticlockwise about `normal`
   * from `from` to `to` (all the way round when `full`; then `to` = `from`).
   */
  | { kind: "ellipse"; centre: Vec3; normal: Vec3; xdir: Vec3; major: number; minor: number; from: Vec3; to: Vec3; full: boolean }
  /**
   * Where two surfaces cross in a curve that isn't a line or a conic (two round faces meeting: a
   * pipe into a pipe, a hole through a hole): points lying exactly on both, in order from `from` to
   * `to`, for a smooth spline through them. `closed`: a loop (the first point isn't repeated at the end; `to` = `from`).
   */
  | { kind: "spline"; points: Vec3[]; closed: boolean; from: Vec3; to: Vec3 };

export interface CurveUse {
  curve: number;
  /** Walked from its `to` back to its `from`. */
  reversed: boolean;
}

export interface PlanFace {
  surface: FitSurface;
  /** Closed loops of edges, each walked with the face on its left seen from outside. */
  loops: CurveUse[][];
  /** The surface's own normal points out of the part (else the face is the other way round). */
  forward: boolean;
  /** Left as a flat piece of the original triangles: nothing simpler fitted round it. */
  mesh: boolean;
  /** Round faces: they go all the way round their axis. */
  full: boolean;
  /** Round faces: they curve inwards (holes, inside fillets). */
  concave: boolean;
  triangles: number;
  /** A point inside the face (on the mesh). */
  sample: Vec3;
}

export interface MeshPlan {
  faces: PlanFace[];
  curves: PlanCurve[];
  /** The mesh's own volume (mm³), to compare the result with. */
  volume: number;
  triangles: number;
  /** Round faces found but given back as facets (their edges weren't lines or arcs). */
  gaveUp: number;
}

const edgeKey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

interface Group {
  tris: number[];
  normal: Vec3;
  area: number;
  points: number[];
  centre: Vec3;
}

/** Above this many triangles a mesh isn't tidied (it'd take minutes, and such detailed files are rarely mechanical parts). */
export const MAX_TRIANGLES = 50_000;
/**
 * The most points the fits may look at while finding round faces (a count, so it's the same on any
 * machine). Mechanical parts need a small part of it; a big organic mesh, where nothing fits, runs out.
 */
export const WORK_LIMIT = 60_000_000;
/** After this many places where something round was looked for and nothing fitted (and nothing yet has), it stops looking. */
export const FRUITLESS_SEEDS = 150;

/** …or after this many misses for every round face found. */
export const FRUITLESS_RATIO = 20;
/** A plan leaving more than this many facet faces (or more than half the triangles as facets) isn't built: nothing to gain. */
export const MAX_FACET_FACES = 5_000;

/** planMesh's answer when a mesh is too detailed to tidy (or ran out of WORK_LIMIT). */
export const TOO_DETAILED = "Too detailed to tidy — brought in as it is.";
/** planMesh's answer when nothing could be joined or recognised (an organic shape): nothing to gain. */
export const NOTHING_TO_TIDY = "Mostly shapes that aren't flat or round — nothing worth tidying, so it's brought in as it is.";

export interface PlanOptions {
  /** Flat faces only (no round faces looked for). */
  flatOnly?: boolean;
  maxTriangles?: number;
  workLimit?: number;
  /** Filled in with how much work was done (points looked at by fits), for tests. */
  stats?: { work: number };
}

interface Region {
  groups: number[];
  surface: FitSurface;
  curved: boolean;
}

/**
 * The plan for one closed, consistently oriented body (welded: corners
 * shared by index). Returns a plain-English reason instead when it can't be
 * done (an open or tangled mesh).
 */
export function planMesh(vertices: ArrayLike<number>, triangles: ArrayLike<number>, tol: SimplifyTolerances, options: PlanOptions = {}): MeshPlan | string {
  const nv = vertices.length / 3;
  const nt = triangles.length / 3;
  if (nt > (options.maxTriangles ?? MAX_TRIANGLES)) return TOO_DETAILED;
  const V: Vec3[] = Array.from({ length: nv }, (_, i) => [vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]]);
  if (nt < 4) return "There are too few triangles to make a solid.";
  const budget = options.workLimit ?? WORK_LIMIT;
  /** Points looked at by fits so far (see WORK_LIMIT). */
  let work = 0;
  const T: [number, number, number][] = Array.from({ length: nt }, (_, t) => [triangles[3 * t], triangles[3 * t + 1], triangles[3 * t + 2]]);
  const normals: Vec3[] = [];
  const areas: number[] = [];
  let volume = 0;
  for (const [a, b, c] of T) {
    const n = cross(sub(V[b], V[a]), sub(V[c], V[a]));
    const len = norm(n);
    areas.push(len / 2);
    normals.push(len > 1e-14 ? scale(n, 1 / len) : [0, 0, 0]);
    volume += dot(V[a], cross(V[b], V[c])) / 6;
  }

  // Each edge's two triangles.
  const edges = new Map<number, number[]>();
  T.forEach((tri, t) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(tri[k], tri[(k + 1) % 3], nv);
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  });
  for (const list of edges.values()) if (list.length !== 2) return "The mesh isn't closed (or some edges are shared by more than two triangles).";
  const across = (t: number, k: number) => {
    const tri = T[t];
    const list = edges.get(edgeKey(tri[k], tri[(k + 1) % 3], nv))!;
    return list[0] === t ? list[1] : list[0];
  };

  // ---- 1. flat groups
  const groupOf = new Int32Array(nt).fill(-1);
  const groups: Group[] = [];
  for (let s = 0; s < nt; s++) {
    if (groupOf[s] >= 0) continue;
    const g = groups.length;
    let nsum = scale(normals[s], areas[s]);
    let n = norm(nsum) > 0 ? unit(nsum) : normals[s];
    const origin = V[T[s][0]];
    const tris = [s];
    groupOf[s] = g;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      for (let k = 0; k < 3; k++) {
        const u = across(t, k);
        if (groupOf[u] >= 0) continue;
        const nu = normals[u];
        const degenerate = areas[u] < 1e-12;
        if (!degenerate && dot(nu, n) < Math.cos(tol.angle)) continue;
        if (!T[u].every((v) => Math.abs(dot(sub(V[v], origin), n)) <= tol.distance)) continue;
        groupOf[u] = g;
        tris.push(u);
        if (!degenerate) {
          nsum = add(nsum, scale(nu, areas[u]));
          n = unit(nsum);
        }
      }
    }
    const pts = new Set<number>();
    let area = 0;
    let c: Vec3 = [0, 0, 0];
    for (const t of tris) {
      T[t].forEach((v) => pts.add(v));
      area += areas[t];
      const tc = scale(add(add(V[T[t][0]], V[T[t][1]]), V[T[t][2]]), 1 / 3);
      c = add(c, scale(tc, areas[t]));
    }
    groups.push({ tris, normal: n, area, points: [...pts], centre: area > 0 ? scale(c, 1 / area) : V[T[s][0]] });
  }

  // Neighbouring groups.
  const near: Set<number>[] = groups.map(() => new Set());
  // How long an edge each pair of neighbouring groups shares.
  const shared: Map<number, number>[] = groups.map(() => new Map());
  for (const [key, list] of edges) {
    const a = groupOf[list[0]];
    const b = groupOf[list[1]];
    if (a !== b) {
      near[a].add(b);
      near[b].add(a);
      const len = dist(V[Math.floor(key / nv)], V[key % nv]);
      shared[a].set(b, (shared[a].get(b) ?? 0) + len);
      shared[b].set(a, (shared[b].get(a) ?? 0) + len);
    }
  }
  const soft = (a: number, b: number) => dot(groups[a].normal, groups[b].normal) >= Math.cos(tol.bend);

  // ---- 2. round faces
  const regionOf = new Int32Array(groups.length).fill(-1);
  const regions: Region[] = [];
  const pointsOf = (gs: number[]) => {
    const set = new Set<number>();
    for (const g of gs) for (const p of groups[g].points) set.add(p);
    return [...set].map((i) => V[i]);
  };
  // Size of the whole body, to throw out "cylinders" so big they're really flat.
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of V) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  const bodySize = dist(lo, hi);

  // A facet faces the way the surface does at its middle (exactly, for a tessellated CAD part); this
  // much leeway is allowed. It's what tells a real round face from a nearly flat stretch that a big
  // cylinder happens to fit within the distance.
  const facing = Math.cos(Math.max(2 * tol.angle, (1.5 * Math.PI) / 180));
  const triMiddle = (t: number) => scale(add(add(V[T[t][0]], V[T[t][1]]), V[T[t][2]]), 1 / 3);
  // (A flat group can be a long strip round a ring — the top of a fillet round a boss — whose middle is far off
  // the surface: then each of its triangles is asked instead.)
  const faces = (s: FitSurface, g: number) =>
    Math.abs(dot(surfaceNormal(s, groups[g].centre), groups[g].normal)) >= facing ||
    (groups[g].tris.length > 2 && groups[g].tris.every((t) => areas[t] < 1e-12 || Math.abs(dot(surfaceNormal(s, triMiddle(t)), normals[t])) >= facing));
  const fitRound = (gs: number[]): FitSurface | null => {
    const pts = pointsOf(gs);
    work += pts.length;
    const ns = gs.map((g) => groups[g].normal);
    const ws = gs.map((g) => groups[g].area);
    const ok = (s: FitSurface) => gs.every((g) => faces(s, g));
    const cyl = fitCylinder(pts, ns, ws, tol.distance);
    if (cyl && cyl.maxError <= tol.distance && cyl.shape.radius < 20 * bodySize && ok(cyl.shape)) return cyl.shape;
    const cone = gs.length >= 3 ? fitCone(pts, ns, ws, tol.distance) : null;
    if (cone && cone.maxError <= tol.distance && Math.abs(cone.shape.slope) > 0.02 && Math.abs(cone.shape.slope) < 20 && ok(cone.shape)) return cone.shape;
    const sph = pts.length >= 6 ? fitSphere(pts) : null;
    if (sph && sph.maxError <= tol.distance && sph.shape.radius < 20 * bodySize && ok(sph.shape)) return sph.shape;
    // A torus is slow to look for, so only where something round nearly fitted.
    const near20 = (e?: number) => e !== undefined && e <= 20 * tol.distance;
    if (gs.length >= 4 && (near20(cyl?.maxError) || near20(cone?.maxError) || near20(sph?.maxError))) {
      // Each facet's own corners' middle and normal (planar groups of a torus are single facets or near enough).
      const tor = fitTorus(
        pts,
        gs.map((g) => groups[g].centre),
        ns,
        bodySize,
      );
      if (tor && tor.maxError <= tol.distance && tor.shape.major < 20 * bodySize && ok(tor.shape)) return tor.shape;
    }
    return null;
  };
  // Does the group sit on the surface: every corner on it, and facing the way it does there?
  const sits = (s: FitSurface, g: number) => {
    const gr = groups[g];
    for (const p of gr.points) if (surfaceDistance(s, V[p]) > tol.distance) return false;
    return faces(s, g);
  };

  /**
   * One facet tall, with gently turning facets beyond both its ends: a ring of something round that
   * isn't a cylinder, cone or sphere (a fillet round a boss is a torus, made of rings that each happen
   * to fit a cone). Not taken as a face of its own.
   */
  const thinBand = (s: FitSurface, members: number[]) => {
    if (s.kind === "plane") return false;
    const axis = s.kind === "sphere" ? null : s.axis;
    const a = axis ?? coneAxisFromNormals(members.map((g) => groups[g].normal));
    const o = s.kind === "sphere" ? s.centre : s.origin;
    const heights = pointsOf(members)
      .map((p) => dot(sub(p, o), a))
      .sort((x, y) => x - y);
    let rows = 1;
    for (let i = 1; i < heights.length; i++) if (heights[i] - heights[i - 1] > tol.distance) rows++;
    if (rows > 2) return false;
    const lo = heights[0];
    const hi = heights[heights.length - 1];
    const inside = new Set(members);
    let below = false;
    let above = false;
    for (const m of members)
      for (const h of near[m]) {
        if (inside.has(h) || !soft(m, h)) continue;
        // Gently turning, and not just carrying on along the same surface.
        if (sits(s, h)) continue;
        const t = dot(sub(groups[h].centre, o), a);
        if (t < lo + tol.distance) below = true;
        if (t > hi - tol.distance) above = true;
      }
    return below && above;
  };

  // Within twice the distance of one plane: no evidence it's round (a huge cylinder would fit anything that flat).
  const flatEnough = (gs: number[]) => {
    const pts = pointsOf(gs);
    work += pts.length;
    const f = fitPlane(pts);
    return !f || f.maxError <= 2 * tol.distance;
  };
  // Biggest first: a real round face's facets are bigger than the bits of whatever's beside it.
  const order = groups.map((_, i) => i).sort((a, b) => groups[b].area - groups[a].area);
  const tried = new Set<number>();
  let fruitless = 0;
  for (const seed of options.flatOnly ? [] : order) {
    if (work > budget) return TOO_DETAILED;
    // Looked in many places, found nothing round anywhere — or far more misses than finds (a round base under an
    // organic figure): not worth looking further.
    if (fruitless >= FRUITLESS_SEEDS && fruitless > FRUITLESS_RATIO * regions.length) break;
    if (regionOf[seed] >= 0 || tried.has(seed)) continue;
    const members: number[] = [];
    const inside = new Set<number>();
    // Neighbours not yet taken and how firmly each is joined (shared edge length), kept up to date as members are added.
    const join = new Map<number, number>();
    const add = (g: number) => {
      members.push(g);
      inside.add(g);
      join.delete(g);
      for (const h of near[g]) {
        if (inside.has(h) || regionOf[h] >= 0 || !soft(g, h)) continue;
        join.set(h, (join.get(h) ?? 0) + (shared[g].get(h) ?? 0));
      }
    };
    // The most firmly joined first.
    const frontier = () => [...join.keys()].sort((a, b) => join.get(b)! - join.get(a)!);
    add(seed);
    // Enough groups first to show it really curves (at least three, and not flat within the distance) — checked
    // as it grows by a quarter, not at every step.
    let surface: FitSurface | null = null;
    // (Not a much bigger neighbour: that's a flat face or another round face beside this one.)
    let biggest = groups[seed].area;
    let checkAt = 3;
    let flat = true;
    while (members.length < 400) {
      if (members.length >= checkAt) {
        flat = flatEnough(members);
        if (!flat) break;
        checkAt = Math.max(checkAt + 1, Math.ceil(members.length * 1.25));
      }
      let next: number | undefined;
      for (const [h] of join) if (groups[h].area <= 10 * biggest && (next === undefined || join.get(h)! > join.get(next)!)) next = h;
      if (next === undefined) break;
      biggest = Math.max(biggest, groups[next].area);
      add(next);
    }
    if (members.length < 3 || (flat && flatEnough(members))) continue;
    surface = fitRound(members);
    // Grown over two round faces before it was sure it curved (small facets of a fillet round a boss, which lie
    // nearly flat going round it): the first few on their own may fit.
    for (let n = Math.floor(members.length / 2); !surface && n >= 4; n = Math.floor(n / 2)) {
      const first = members.slice(0, n);
      if (flatEnough(first)) break;
      const s = fitRound(first);
      if (!s) continue;
      members.length = 0;
      inside.clear();
      join.clear();
      first.forEach(add);
      surface = s;
    }
    if (!surface) {
      // Its neighbourhood fits nothing round: don't start again from right beside it.
      for (const m of members.slice(0, 3)) tried.add(m);
      fruitless++;
      continue;
    }
    let fittedAt = members.length;
    let misses = 0;
    for (;;) {
      let grew = false;
      for (const h of frontier()) {
        if (inside.has(h)) continue;
        if (sits(surface, h)) {
          add(h);
          grew = true;
        } else if (misses < 6 && groups[h].points.every((p) => surfaceDistance(surface!, V[p]) <= 3 * tol.distance)) {
          // A near miss: maybe a better fit with it (the first fit came from only a few facets) — try all the shapes again.
          misses++;
          const s = fitRound([...members, h]);
          if (s) {
            surface = s;
            add(h);
            fittedAt = members.length;
            grew = true;
          }
        }
        if (members.length >= fittedAt * 1.5) {
          const s = fitRound(members);
          if (s) surface = s;
          fittedAt = members.length;
        }
      }
      if (!grew) break;
    }
    const final = fitRound(members);
    if (!final || thinBand(final, members) || flatEnough(members)) {
      fruitless++;
      continue;
    }
    const r = regions.length;
    regions.push({ groups: members, surface: final, curved: true });
    for (const m of members) regionOf[m] = r;
  }
  // A round face grown from several seeds can come out in pieces, each fitting something simpler on its
  // own (a fillet's corner — part of a torus — as slivers of cylinders): neighbouring round faces that
  // one surface fits together are joined.
  for (let pass = 0; pass < 8 && !options.flatOnly; pass++) {
    let merged = 0;
    for (let i = 0; i < regions.length; i++) {
      if (!regions[i].groups.length) continue;
      const others = new Set<number>();
      for (const g of regions[i].groups) for (const h of near[g]) if (regionOf[h] >= 0 && regionOf[h] !== i && soft(g, h)) others.add(regionOf[h]);
      for (const j of [...others].sort((a, b) => regions[b].groups.length - regions[a].groups.length)) {
        if (work > budget) break;
        const both = [...regions[i].groups, ...regions[j].groups];
        const s = fitRound(both);
        if (!s || thinBand(s, both)) continue;
        for (const g of regions[j].groups) regionOf[g] = i;
        regions[i] = { groups: both, surface: s, curved: true };
        regions[j].groups = [];
        merged++;
        break;
      }
    }
    if (!merged) break;
  }
  if (options.stats) options.stats.work = work;
  if (work > budget) return TOO_DETAILED;
  // Nothing round, and hardly any flat areas joined: nothing to gain from rebuilding it.
  if (!options.flatOnly && !regions.length && groups.length > 0.3 * nt && nt > 200) return NOTHING_TO_TIDY;
  // Most of it would stay facets (flat pieces meeting at gentle angles, in no round face): rebuilding them all
  // gains nothing and takes OpenCascade minutes, so it's brought in as it is.
  let facetTriangles = 0;
  let facetGroups = 0;
  groups.forEach((g, i) => {
    if (regionOf[i] >= 0) return;
    for (const h of near[i])
      if (regionOf[h] < 0 && soft(i, h)) {
        facetTriangles += g.tris.length;
        facetGroups++;
        return;
      }
  });
  if (nt > 200 && (facetGroups > MAX_FACET_FACES || facetTriangles > 0.5 * nt)) return NOTHING_TO_TIDY;

  // Where two faces meet smoothly (a fillet into a flat or round face), the facets nearest the join
  // fit both within the distance, and growing gives them to whichever got there first, leaving a
  // ragged edge. Give each facet along a join to the face it really faces like, then fit again.
  const facingError = (s: FitSurface, g: number) => 1 - Math.abs(dot(surfaceNormal(s, groups[g].centre), groups[g].normal));
  const onIt = (s: FitSurface, g: number) => groups[g].points.every((p) => surfaceDistance(s, V[p]) <= tol.distance);
  for (let pass = 0; pass < 4; pass++) {
    let moved = 0;
    for (let g = 0; g < groups.length; g++) {
      const own = regionOf[g];
      const options = new Set<number>();
      for (const h of near[g]) if (regionOf[h] >= 0 && regionOf[h] !== own && soft(g, h)) options.add(regionOf[h]);
      if (!options.size) continue;
      let best = own;
      // (A facet in no face joins one it sits on.)
      let bestErr = own >= 0 ? facingError(regions[own].surface, g) : Infinity;
      for (const r of options) {
        const sr = regions[r].surface;
        if (!onIt(sr, g) || !faces(sr, g)) continue;
        const e = facingError(sr, g);
        if (e < bestErr - 1e-9) {
          bestErr = e;
          best = r;
        }
      }
      if (best !== own) {
        regionOf[g] = best;
        moved++;
      }
    }
    if (!moved) break;
    regions.forEach((r, i) => {
      r.groups = groups.map((_, g) => g).filter((g) => regionOf[g] === i);
      const s = r.groups.length >= 3 ? fitRound(r.groups) : null;
      if (s) r.surface = s;
    });
  }
  // A face left with too little to be sure of goes back to flat facets.
  regions.forEach((r) => {
    if (r.groups.length >= 3 && !flatEnough(r.groups)) return;
    for (const g of r.groups) regionOf[g] = -1;
    r.groups = [];
  });

  // ---- 3. edges, and giving back round faces whose edges don't fit
  const demoted = new Set<number>();
  for (let attempt = 0; attempt < 12; attempt++) {
    const all: Region[] = [];
    const regionOfGroup = new Int32Array(groups.length).fill(-1);
    regions.forEach((r, i) => {
      if (demoted.has(i) || !r.groups.length) return;
      r.groups.forEach((g) => (regionOfGroup[g] = all.length));
      all.push(r);
    });
    groups.forEach((g, i) => {
      if (regionOfGroup[i] >= 0) return;
      regionOfGroup[i] = all.length;
      const plane = fitPlane(
        g.points.map((p) => V[p]),
        g.normal,
      );
      all.push({ groups: [i], surface: plane?.shape ?? { kind: "plane", normal: g.normal, origin: g.centre }, curved: false });
    });
    // Tidy each surface (round numbers, X/Y/Z), keeping it only if it still fits. Sizes move only as far
    // as the fit itself is unsure (its own scatter, at least 2 µm: a mesh of a CAD part has its corners
    // within a few µm of the true surface), so a Ø5.06 hole isn't rounded to 5.05.
    const snapAngle = Math.min(tol.angle, (0.5 * Math.PI) / 180) / 2;
    for (const r of all) {
      const pts = pointsOf(r.groups);
      let scatter = 0;
      for (const p of pts) scatter = Math.max(scatter, surfaceDistance(r.surface, p));
      const sizeTol = Math.min(tol.distance / 2, Math.max(0.002, 1.5 * scatter));
      const tidy = tidySurface(r.surface, sizeTol, snapAngle);
      if (pts.every((p) => surfaceDistance(tidy, p) <= tol.distance)) r.surface = tidy;
    }
    // Along smooth joins, single triangles go to the face they face like (a flat group can straddle
    // a join where the surfaces are within the angle of each other, which would leave a zigzag edge).
    const triRegion = new Int32Array(nt);
    for (let t = 0; t < nt; t++) triRegion[t] = regionOfGroup[groupOf[t]];
    const triCentre = (t: number) => scale(add(add(V[T[t][0]], V[T[t][1]]), V[T[t][2]]), 1 / 3);
    const triError = (r: number, t: number) => {
      const s = all[r].surface;
      if (!T[t].every((v) => surfaceDistance(s, V[v]) <= tol.distance)) return Infinity;
      return 1 - Math.abs(dot(surfaceNormal(s, triCentre(t)), normals[t]));
    };
    const regionArea = all.map(() => 0);
    for (let t = 0; t < nt; t++) regionArea[triRegion[t]] += areas[t];
    for (let pass = 0; pass < 6; pass++) {
      let moved = 0;
      for (let t = 0; t < nt; t++) {
        if (areas[t] < 1e-12) continue;
        const own = triRegion[t];
        let best = own;
        // A triangle of a flat facet group that lies on a round face beside it joins that face (slivers
        // can face well off the surface's normal even with their corners right on it, so it's lenient).
        // (Not a triangle lying square on its own flat face, though: near a smooth curved join — a fillet round
        // a corner — the flat face's own triangles lie on the round face within the distance too.)
        const ownSurface = all[own].surface;
        const realFlat = ownSurface.kind === "plane" && regionArea[own] > 20 * areas[t];
        let bestErr = all[own].curved ? triError(own, t) : realFlat ? Math.min(1 - Math.cos(tol.bend), 1 - Math.abs(dot(ownSurface.normal, normals[t]))) : 1 - Math.cos(tol.bend);
        for (let k = 0; k < 3; k++) {
          const r = triRegion[across(t, k)];
          if (r === own || r === best) continue;
          if (!all[r].curved) continue;
          const e = triError(r, t);
          if (e < bestErr - 1e-12) {
            bestErr = e;
            best = r;
          }
        }
        if (best !== own) {
          triRegion[t] = best;
          moved++;
        }
      }
      if (!moved) break;
    }
    // Where two round faces meet smoothly in a circle whose plane parts them (a straight fillet running into
    // the corner of a rounded rectangle), triangles near the join lie on both within the distance and are
    // shared out raggedly; each goes to the face on its side of the circle's plane.
    {
      const pairs = new Map<number, [number, number]>();
      for (let t = 0; t < nt; t++)
        for (let k = 0; k < 3; k++) {
          const a = triRegion[t];
          const b = triRegion[across(t, k)];
          if (a < b && all[a].curved && all[b].curved) pairs.set(a * all.length + b, [a, b]);
        }
      const reshaped = new Set<number>();
      if (pairs.size) {
        const trisOfRegion: number[][] = all.map(() => []);
        for (let t = 0; t < nt; t++) trisOfRegion[triRegion[t]].push(t);
        for (const [a, b] of pairs.values()) {
          const sa = all[a].surface;
          const sb = all[b].surface;
          const ring = meetCircle(sa, sb, triCentre(trisOfRegion[a][0]), Math.max(tol.angle, (2 * Math.PI) / 180), tol.distance);
          if (!ring) continue;
          const side = (t: number) => dot(sub(triCentre(t), ring.centre), ring.normal);
          // Only where the plane really parts them (most of each face clearly on its own side).
          const vote = (ts: number[]) => {
            let plus = 0;
            let minus = 0;
            for (const t of ts) {
              const d = side(t);
              if (d > tol.distance) plus++;
              else if (d < -tol.distance) minus++;
            }
            return plus > 4 * minus && plus > 0 ? 1 : minus > 4 * plus && minus > 0 ? -1 : 0;
          };
          const va = vote(trisOfRegion[a]);
          const vb = vote(trisOfRegion[b]);
          if (!va || va !== -vb) continue;
          for (let pass = 0; pass < 50; pass++) {
            let moved = 0;
            for (const [from, to, sign] of [
              [a, b, vb],
              [b, a, va],
            ] as const)
              for (const t of trisOfRegion[from]) {
                if (triRegion[t] !== from || side(t) * sign <= 0) continue;
                if (!T[t].every((v) => surfaceDistance(all[to].surface, V[v]) <= tol.distance)) continue;
                // Only triangles beside the join (touching the other face, or a triangle already moved to it).
                if (![0, 1, 2].some((k) => triRegion[across(t, k)] === to)) continue;
                triRegion[t] = to;
                trisOfRegion[to].push(t);
                reshaped.add(to);
                reshaped.add(from);
                moved++;
              }
            if (!moved) break;
          }
        }
      }
      // Faces that gained or lost triangles fitted again to the ones they have now (and tidied as before).
      for (const r of reshaped) {
        const ts: number[] = [];
        for (let t = 0; t < nt; t++) if (triRegion[t] === r) ts.push(t);
        const s0 = all[r].surface;
        // (A torus's fit is a search, less exact than the one it was given from all its facets: kept.)
        if (s0.kind === "torus" || s0.kind === "plane") continue;
        const ids = new Set<number>();
        for (const t of ts) T[t].forEach((v) => ids.add(v));
        const pts = [...ids].map((v) => V[v]);
        const ns = ts.map((t) => normals[t]);
        const ws = ts.map((t) => areas[t]);
        work += pts.length;
        const f =
          s0.kind === "cylinder" ? fitCylinder(pts, ns, ws, tol.distance) : s0.kind === "cone" ? fitCone(pts, ns, ws, tol.distance) : s0.kind === "sphere" ? fitSphere(pts) : null;
        if (!f || f.maxError > tol.distance) continue;
        const sizeTol = Math.min(tol.distance / 2, Math.max(0.002, 1.5 * f.maxError));
        const tidy = tidySurface(f.shape, sizeTol, snapAngle);
        all[r].surface = pts.every((p) => surfaceDistance(tidy, p) <= tol.distance) ? tidy : f.shape;
      }
    }
    const regionOfTri = (t: number) => triRegion[t];
    const result = buildEdges(V, T, nv, across, regionOfTri, all, tol);
    if (typeof result === "string") return result;
    if (result.demote.length) {
      let any = false;
      for (const k of result.demote) {
        const original = regions.indexOf(all[k]);
        if (original >= 0 && !demoted.has(original)) {
          demoted.add(original);
          any = true;
        }
      }
      if (any) continue;
      return "Some edges couldn't be worked out.";
    }
    // Faces.
    // Faces (by the triangles each region ended up with).
    const trisOf: number[][] = all.map(() => []);
    for (let t = 0; t < nt; t++) trisOf[triRegion[t]].push(t);
    const faces: PlanFace[] = [];
    all.forEach((r, i) => {
      const ts = trisOf[i];
      if (!ts.length) return;
      let nsum: Vec3 = [0, 0, 0];
      let concaveVote = 0;
      let biggest = ts[0];
      const pts = new Set<number>();
      for (const t of ts) {
        nsum = add(nsum, scale(normals[t], areas[t]));
        concaveVote += dot(surfaceNormal(r.surface, triCentre(t)), normals[t]) * areas[t];
        if (areas[t] > areas[biggest]) biggest = t;
        T[t].forEach((v) => pts.add(v));
      }
      const forward = r.surface.kind === "plane" ? dot(r.surface.normal, nsum) > 0 : concaveVote > 0;
      const full = r.curved && r.surface.kind !== "plane" && goesRound(r.surface, [...pts].map((v) => V[v]), tol.bend);
      faces.push({
        surface: r.surface,
        loops: result.loops[i],
        forward,
        // A flat face meeting another flat face at a gentle angle: facets of something round left as they were.
        mesh: !r.curved && ts.some((t) => [0, 1, 2].some((k) => {
          const u = across(t, k);
          const o = triRegion[u];
          return o !== i && !all[o].curved && dot(normals[t], normals[u]) >= Math.cos(tol.bend);
        })),
        full,
        concave: r.curved && !forward,
        triangles: ts.length,
        sample: projectOnSurface(r.surface, triCentre(biggest)),
      });
    });
    return { faces, curves: result.curves, volume, triangles: nt, gaveUp: demoted.size };
  }
  return "Too many round faces had edges that couldn't be worked out.";
}

/** Whether points spread all the way round a round surface's axis (no gap wider than a facet or two). */
function goesRound(s: FitSurface, pts: Vec3[], bend: number): boolean {
  if (s.kind === "plane") return false;
  if (s.kind === "sphere") return false;
  const [u, v] = frameOf(s.axis);
  const angles = pts.map((p) => Math.atan2(dot(sub(p, s.origin), v), dot(sub(p, s.origin), u))).sort((a, b) => a - b);
  if (angles.length < 3) return false;
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  return gap <= bend * 1.5;
}

interface Chain {
  verts: number[];
  closed: boolean;
  left: number;
  right: number;
}

/**
 * The edges between the regions: chains of mesh edges between corners, each
 * fitted as a line or an arc; and each region's loops. Lists regions to give
 * back as facets when a round one has an edge that isn't a line or an arc.
 */
function buildEdges(
  V: Vec3[],
  T: [number, number, number][],
  nv: number,
  across: (t: number, k: number) => number,
  regionOfTri: (t: number) => number,
  regions: Region[],
  tol: SimplifyTolerances,
): { curves: PlanCurve[]; loops: CurveUse[][][]; demote: number[] } | string {
  // Boundary half-edges of each region (the region on their left).
  type Half = { a: number; b: number; other: number; used: boolean; t: number; k: number };
  const halves: Half[][] = regions.map(() => []);
  /** Each boundary half-edge by its triangle and side (3t + k). */
  const halfAt = new Map<number, Half>();
  /** How many boundary half-edges (both sides') start or end at each corner of the mesh. */
  const boundaryAt = new Map<number, number>();
  const regionsAt = new Map<number, Set<number>>();
  T.forEach((tri, t) => {
    const r = regionOfTri(t);
    for (const v of tri) {
      let set = regionsAt.get(v);
      if (!set) regionsAt.set(v, (set = new Set()));
      set.add(r);
    }
    for (let k = 0; k < 3; k++) {
      const o = regionOfTri(across(t, k));
      if (o !== r) {
        const h = { a: tri[k], b: tri[(k + 1) % 3], other: o, used: false, t, k };
        halves[r].push(h);
        halfAt.set(3 * t + k, h);
        boundaryAt.set(h.a, (boundaryAt.get(h.a) ?? 0) + 1);
        boundaryAt.set(h.b, (boundaryAt.get(h.b) ?? 0) + 1);
      }
    }
  });
  // Where three or more faces meet — or where one face's outline passes twice (two faces touching at a
  // point, which a ragged join can leave): either way more than two boundary edges meet there.
  const corner = (v: number) => (regionsAt.get(v)?.size ?? 0) >= 3 || (boundaryAt.get(v) ?? 0) > 4;
  /** The boundary half-edge after h round its own face: turning about h's end through the face's triangles. */
  const nextHalf = (h: Half, r: number): Half | undefined => {
    let cur = h.t;
    let j = (h.k + 1) % 3;
    for (let guard = 0; guard < 10_000; guard++) {
      const u = across(cur, j);
      if (regionOfTri(u) !== r) return halfAt.get(3 * cur + j);
      const x = T[cur][(j + 1) % 3];
      const m = T[u].findIndex((w, i) => w === x && T[u][(i + 1) % 3] === h.b);
      if (m < 0) return undefined;
      cur = u;
      j = (m + 1) % 3;
    }
    return undefined;
  };

  const chains: Chain[] = [];
  const chainOfEdge = new Map<number, number>();
  const loopsOf: { chain: number; reversed: boolean }[][][] = regions.map(() => []);
  for (let r = 0; r < regions.length; r++) {
    const out = new Map<number, Half[]>();
    for (const h of halves[r]) {
      const list = out.get(h.a);
      if (list) list.push(h);
      else out.set(h.a, [h]);
    }
    for (const start of halves[r]) {
      if (start.used) continue;
      const loop: Half[] = [];
      let h: Half | undefined = start;
      while (h) {
        h.used = true;
        loop.push(h);
        if (h.b === start.a) break;
        const turned: Half | undefined = nextHalf(h, r);
        h = turned && !turned.used ? turned : out.get(h.b)?.find((x) => !x.used);
      }
      if (!h) return "A face's outline doesn't close up.";
      // Where the loop breaks into separate edges: at corners, or where the face on the other side changes.
      const n = loop.length;
      const breaks: number[] = [];
      for (let i = 0; i < n; i++) {
        const prev = loop[(i - 1 + n) % n];
        if (corner(loop[i].a) || prev.other !== loop[i].other) breaks.push(i);
      }
      const runs: Half[][] = [];
      if (!breaks.length) runs.push(loop);
      else
        for (let k = 0; k < breaks.length; k++) {
          const from = breaks[k];
          const to = breaks[(k + 1) % breaks.length];
          const run: Half[] = [];
          for (let i = from; ; i = (i + 1) % n) {
            if (run.length && i === to) break;
            run.push(loop[i]);
            if (run.length > n) break;
          }
          runs.push(run);
        }
      const uses: { chain: number; reversed: boolean }[] = [];
      for (const run of runs) {
        const key = edgeKey(run[0].a, run[0].b, nv);
        const verts = [run[0].a, ...run.map((x) => x.b)];
        const closed = !breaks.length;
        const existing = chainOfEdge.get(key);
        if (existing !== undefined) {
          const c = chains[existing];
          if (c.verts.length !== verts.length) return "Two faces disagree about the edge between them.";
          // The other side walks it the other way.
          uses.push({ chain: existing, reversed: true });
          continue;
        }
        const id = chains.length;
        chains.push({ verts, closed, left: r, right: run[0].other });
        for (const x of run) chainOfEdge.set(edgeKey(x.a, x.b, nv), id);
        uses.push({ chain: id, reversed: false });
      }
      loopsOf[r].push(uses);
    }
  }

  // Corner points moved onto every surface that meets there (exactly where they cross, when that's well defined).
  const placed = new Map<number, Vec3>();
  const place = (v: number): Vec3 => {
    const got = placed.get(v);
    if (got) return got;
    const surfaces = [...(regionsAt.get(v) ?? [])].map((r) => regions[r].surface);
    const p = meetPoint(V[v], surfaces, tol.distance);
    placed.set(v, p);
    return p;
  };

  const curves: PlanCurve[] = [];
  /** Each chain's curves, in its own direction. */
  const curvesOf: number[][] = [];
  /** Each curve's end corners (mesh vertex numbers; −1 for a whole circle with no corner). */
  const ends: [number, number][] = [];
  const demote = new Set<number>();
  for (const c of chains) {
    const sa = regions[c.left];
    const sb = regions[c.right];
    const pts = c.verts.map((v) => V[v]);
    const fitted = fitChain(c, pts, place, sa.surface, sb.surface, tol);
    if (fitted) {
      curvesOf.push([curves.length]);
      curves.push(fitted);
      // (A loop with no corner keeps the start it was given: where the round faces' seams are.)
      const whole = (fitted.kind === "arc" || fitted.kind === "ellipse") && fitted.full && (c.closed || c.verts[0] !== c.verts[c.verts.length - 1]);
      ends.push(whole ? [-1, -1] : [c.verts[0], c.verts[c.verts.length - 1]]);
      continue;
    }
    // A run of straight pieces: fine between flat faces, but a round face can't be bounded by it.
    if (sa.curved) demote.add(c.left);
    if (sb.curved) demote.add(c.right);
    const ids: number[] = [];
    for (let i = 0; i + 1 < c.verts.length; i++) {
      ids.push(curves.length);
      curves.push({ kind: "line", from: place(c.verts[i]), to: place(c.verts[i + 1]) });
      ends.push([c.verts[i], c.verts[i + 1]]);
    }
    curvesOf.push(ids);
  }
  if (demote.size) return { curves: [], loops: [], demote: [...demote] };
  // Corners exactly on the arcs that end there (where two arcs meet, where their circles cross), and every
  // line and arc ending exactly there, so the edges join up to OpenCascade's precision.
  const arcsAt = new Map<number, ((p: Vec3) => Vec3)[]>();
  curves.forEach((c, i) => {
    if (c.kind !== "arc" && c.kind !== "ellipse") return;
    const onto = c.kind === "arc" ? (p: Vec3) => projectOnCircle(c, p) : (p: Vec3) => projectOnEllipse(c, p);
    for (const v of ends[i]) {
      if (v < 0) continue;
      const list = arcsAt.get(v) ?? [];
      list.push(onto);
      arcsAt.set(v, list);
    }
  });
  const finalAt = new Map<number, Vec3>();
  const at = (v: number): Vec3 => {
    let p = finalAt.get(v);
    if (p) return p;
    p = place(v);
    const arcs = arcsAt.get(v) ?? [];
    for (let it = 0; it < (arcs.length > 1 ? 200 : 1); it++) for (const a of arcs) p = a(p);
    finalAt.set(v, p);
    return p;
  };
  curves.forEach((c, i) => {
    const [a, b] = ends[i];
    if (c.kind === "spline") {
      // A loop keeps its own first point (exactly on both surfaces); an open one ends on its corners.
      if (c.closed) return;
      c.from = at(a);
      c.to = at(b);
      c.points[0] = c.from;
      c.points[c.points.length - 1] = c.to;
      return;
    }
    if (a >= 0) c.from = at(a);
    if (b >= 0) c.to = at(b);
    if ((c.kind === "arc" || c.kind === "ellipse") && c.full && a >= 0) c.to = c.from;
  });
  const loops: CurveUse[][][] = loopsOf.map((ls) =>
    ls.map((uses) => uses.flatMap((u): CurveUse[] => (u.reversed ? [...curvesOf[u.chain]].reverse().map((curve) => ({ curve, reversed: true })) : curvesOf[u.chain].map((curve) => ({ curve, reversed: false }))))),
  );
  return { curves, loops, demote: [] };
}

/**
 * The point nearest p lying on all the surfaces (planes solved exactly, round
 * ones by turns), or p itself if that would move it further than `limit`
 * (surfaces meeting at a glancing angle, where "exactly" is meaningless).
 */
export function meetPoint(p: Vec3, surfaces: FitSurface[], limit: number): Vec3 {
  const planes = surfaces.filter((s) => s.kind === "plane") as Extract<FitSurface, { kind: "plane" }>[];
  const round = surfaces.filter((s) => s.kind !== "plane");
  const ontoPlanes = (q: Vec3): Vec3 | null => {
    if (!planes.length) return q;
    // x = q − Σ λi ni with ni · x = ni · oi.
    const k = planes.length;
    const A = planes.map((a) => planes.map((b) => dot(a.normal, b.normal) + 0));
    const rhs = planes.map((a) => dot(a.normal, q) - dot(a.normal, a.origin));
    // Least squares (more than three planes, or parallel ones): solve the normal equations with a tiny damping.
    for (let i = 0; i < k; i++) A[i][i] += 1e-12;
    const lambda = solveSmall(A, rhs);
    if (!lambda) return null;
    let x = q;
    planes.forEach((pl, i) => (x = sub(x, scale(pl.normal, lambda[i]))));
    return x;
  };
  let q: Vec3 | null = p;
  for (let it = 0; it < (round.length ? 60 : 1) && q; it++) {
    for (const s of round) q = projectOnSurface(s, q);
    q = ontoPlanes(q);
  }
  if (!q || dist(q, p) > limit) return p;
  return q;
}

function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-9) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((r, i) => r[n] / r[i]);
}

/** The circle where two surfaces meet, when that's a circle we can work out exactly (round surface + plane square to its axis…). */
export function meetCircle(a: FitSurface, b: FitSurface, near: Vec3, angle: number, slack = 0): Circle3 | null {
  const roundOf = (s: FitSurface) => (s.kind === "plane" ? null : s);
  for (const [r, o] of [
    [a, b],
    [b, a],
  ] as const) {
    const rs = roundOf(r);
    if (!rs) continue;
    if (rs.kind === "sphere") {
      if (o.kind !== "plane") continue;
      const h = dot(sub(rs.centre, o.origin), o.normal);
      const rr = rs.radius ** 2 - h * h;
      if (rr <= 0) return null;
      return { centre: sub(rs.centre, scale(o.normal, h)), normal: o.normal, radius: Math.sqrt(rr) };
    }
    if (rs.kind === "torus") {
      const placeNear = (h: number, rho: number) => ({ centre: add(rs.origin, scale(rs.axis, h)), normal: rs.axis, radius: rho });
      const nd = sub(near, rs.origin);
      const nh = dot(nd, rs.axis);
      const nrho = norm(sub(nd, scale(rs.axis, nh)));
      if (o.kind === "plane") {
        if (Math.abs(dot(o.normal, rs.axis)) < Math.cos(angle)) continue;
        const h = dot(sub(o.origin, rs.origin), rs.axis);
        const k = rs.minor ** 2 - h * h;
        if (k < -1e-6 - 2 * rs.minor * slack) return null;
        const options = [rs.major + Math.sqrt(Math.max(0, k)), rs.major - Math.sqrt(Math.max(0, k))];
        return placeNear(h, options.reduce((x, y) => (Math.abs(y - nrho) < Math.abs(x - nrho) ? y : x)));
      }
      if (o.kind === "cylinder" && Math.abs(dot(o.axis, rs.axis)) >= Math.cos(angle)) {
        const off = sub(o.origin, rs.origin);
        if (norm(sub(off, scale(rs.axis, dot(off, rs.axis)))) > 1e-3) continue;
        // (Just touching, as a fillet does, k is 0; fitting leaves it a little either way.)
        const k = rs.minor ** 2 - (o.radius - rs.major) ** 2;
        if (k < -1e-9 - 2 * rs.minor * slack) return null;
        const options = [Math.sqrt(Math.max(0, k)), -Math.sqrt(Math.max(0, k))];
        return placeNear(
          options.reduce((x, y) => (Math.abs(y - nh) < Math.abs(x - nh) ? y : x)),
          o.radius,
        );
      }
      if (o.kind === "cylinder" && Math.abs(dot(o.axis, rs.axis)) < Math.sin(angle)) {
        // A straight fillet running on into a fillet round a corner: the cylinder's axis touches the torus's
        // middle circle, and they meet in the tube's circle there.
        if (Math.abs(o.radius - rs.minor) > Math.max(slack, 1e-6)) return null;
        const off = sub(o.origin, rs.origin);
        const lift = dot(off, rs.axis);
        if (Math.abs(lift) > Math.max(slack, 1e-6)) continue;
        // The point of the axis line nearest the torus's centre must be a major radius out.
        const foot = sub(off, scale(o.axis, dot(off, o.axis)));
        const footFlat = sub(foot, scale(rs.axis, dot(foot, rs.axis)));
        if (Math.abs(norm(footFlat) - rs.major) > Math.max(slack, 1e-6)) continue;
        return { centre: add(rs.origin, footFlat), normal: o.axis, radius: rs.minor };
      }
      continue;
    }
    if (o.kind === "torus") continue;
    // Cylinder or cone: the circle lies square to the axis.
    const radiusAt = (t: number) => (rs.kind === "cylinder" ? rs.radius : rs.radius + rs.slope * t);
    if (o.kind === "plane") {
      const c = Math.abs(dot(o.normal, rs.axis));
      if (c < Math.cos(angle)) continue;
      // Where the axis passes through the plane.
      const t = dot(sub(o.origin, rs.origin), o.normal) / dot(rs.axis, o.normal);
      const radius = radiusAt(t);
      if (radius <= 0) return null;
      return { centre: add(rs.origin, scale(rs.axis, t)), normal: rs.axis, radius };
    }
    if (o.kind === "cylinder" || o.kind === "cone") {
      // Two round surfaces on the same axis (a cone into a cylinder): where their radii agree, nearest `near`.
      if (Math.abs(dot(o.axis, rs.axis)) < Math.cos(angle)) continue;
      const off = sub(o.origin, rs.origin);
      if (norm(sub(off, scale(rs.axis, dot(off, rs.axis)))) > 1e-3) continue;
      const t = dot(sub(near, rs.origin), rs.axis);
      const tOther = dot(sub(near, o.origin), o.axis);
      const radius = radiusAt(t);
      const otherR = o.kind === "cylinder" ? o.radius : o.radius + o.slope * tOther;
      if (Math.abs(radius - otherR) > 0.05 * Math.max(radius, 1)) continue;
      return { centre: add(rs.origin, scale(rs.axis, t)), normal: rs.axis, radius: (radius + otherR) / 2 };
    }
  }
  return null;
}

/**
 * A chain of mesh edges as one line or arc — or, where the surfaces either
 * side give it exactly, an ellipse (a plane across a cylinder at a slant) or
 * the curve where two surfaces cross — or null when it's none of them
 * (within the tolerance).
 */
function fitChain(c: Chain, pts: Vec3[], place: (v: number) => Vec3, sa: FitSurface, sb: FitSurface, tol: SimplifyTolerances): PlanCurve | null {
  const ring = c.closed ? pts.slice(0, -1) : pts;
  const slanted = meetEllipse(sa, sb, Math.max(tol.angle, (2 * Math.PI) / 180));
  if (slanted) {
    const e = ellipseChain(c, pts, place, slanted, sa, sb, tol);
    if (e) return e;
  }
  const plain = fitLineOrArc(c, pts, place, sa, sb, tol);
  if (plain) return plain;
  if (sa.kind === "plane" && sb.kind === "plane") return null;
  if (ring.length < 3) return null;
  return crossingChain(c, pts, place, sa, sb, tol);
}

/** A chain of mesh edges as one line or arc, or null when it's neither (within the tolerance). */
function fitLineOrArc(c: Chain, pts: Vec3[], place: (v: number) => Vec3, sa: FitSurface, sb: FitSurface, tol: SimplifyTolerances): PlanCurve | null {
  const onBoth = (p: Vec3) => surfaceDistance(sa, p) <= tol.distance && surfaceDistance(sb, p) <= tol.distance;
  const ring = c.closed ? pts.slice(0, -1) : pts;
  const mid = ring[Math.floor(ring.length / 2)];
  // An exact circle from the surfaces, else one fitted to the points.
  let circle: Circle3 | null = meetCircle(sa, sb, mid, Math.max(tol.angle, (2 * Math.PI) / 180), tol.distance);
  // Where the faces meet smoothly the mesh's edge between them can wander (every point near the join is
  // on both); the exact circle is right as long as every point is on both faces.
  if (circle && !ring.every(onBoth)) circle = null;
  if (!circle && !c.closed) {
    const from = place(c.verts[0]);
    const to = place(c.verts[c.verts.length - 1]);
    const d = sub(to, from);
    const len = norm(d);
    if (len > 1e-9) {
      const dir = scale(d, 1 / len);
      const straight = pts.every((p) => {
        const q = sub(p, from);
        return norm(sub(q, scale(dir, dot(q, dir)))) <= tol.distance;
      });
      const samples = [0.25, 0.5, 0.75].map((k) => add(from, scale(d, k)));
      if (straight && samples.every(onBoth)) return { kind: "line", from, to };
    }
  }
  // Two flat faces meet in a straight line: an arc needs a round face on one side.
  if (!circle && sa.kind === "plane" && sb.kind === "plane") return null;
  if (!circle && ring.length >= (c.closed ? 6 : 4)) {
    const f = fitCircle3D(ring);
    if (f && f.maxError <= tol.distance) {
      circle = f.shape;
      // Square to a round face's axis when it nearly is, centred on it.
      for (const s of [sa, sb]) {
        if (s.kind !== "cylinder" && s.kind !== "cone" && s.kind !== "torus") continue;
        if (Math.abs(dot(circle.normal, s.axis)) < Math.cos(Math.max(tol.angle, (2 * Math.PI) / 180))) continue;
        const t = dot(sub(circle.centre, s.origin), s.axis);
        const snapped: Circle3 = { centre: add(s.origin, scale(s.axis, t)), normal: s.axis, radius: circle.radius };
        if (ring.every((p) => circleDistance(snapped, p) <= tol.distance)) circle = snapped;
        break;
      }
    }
  }
  if (!circle) return null;
  // The arc must look like a circle (small steps round it), not a polygon, and lie on both surfaces.
  const [u, v] = frameOf(circle.normal);
  const angleOf = (p: Vec3) => Math.atan2(dot(sub(p, circle!.centre), v), dot(sub(p, circle!.centre), u));
  for (let i = 1; i < pts.length; i++) {
    let step = Math.abs(angleOf(pts[i]) - angleOf(pts[i - 1]));
    if (step > Math.PI) step = 2 * Math.PI - step;
    if (step > tol.bend * 1.05) return null;
  }
  const samples = ring.map((p) => projectOnCircle(circle!, p));
  if (!samples.every(onBoth)) return null;
  if (c.closed) {
    // Anticlockwise the way the chain goes.
    const turn = winding(ring, circle);
    const normal = turn >= 0 ? circle.normal : scale(circle.normal, -1);
    // Starting where round faces' seams are (see canonicalX), so their edges match.
    const from = add(circle.centre, scale(canonicalX(circle.normal), circle.radius));
    return { kind: "arc", centre: circle.centre, normal, radius: circle.radius, from, to: from, full: true };
  }
  const from = projectOnCircle(circle, place(c.verts[0]));
  const to = projectOnCircle(circle, place(c.verts[c.verts.length - 1]));
  if (c.verts[0] === c.verts[c.verts.length - 1]) {
    // All the way round, from one corner back to it.
    const normal = winding(pts, circle) >= 0 ? circle.normal : scale(circle.normal, -1);
    return { kind: "arc", centre: circle.centre, normal, radius: circle.radius, from, to: from, full: true };
  }
  if (dist(from, place(c.verts[0])) > tol.distance || dist(to, place(c.verts[c.verts.length - 1])) > tol.distance) return null;
  const turn = winding(pts, circle);
  const normal = turn >= 0 ? circle.normal : scale(circle.normal, -1);
  return { kind: "arc", centre: circle.centre, normal, radius: circle.radius, from, to, full: false };
}

/** Which way points go round a circle: + anticlockwise about its normal. */
function winding(pts: Vec3[], c: Circle3): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = sub(pts[i - 1], c.centre);
    const b = sub(pts[i], c.centre);
    total += Math.atan2(dot(cross(a, b), c.normal), dot(a, b));
  }
  return total;
}

/**
 * The ellipse where a plane cuts a cylinder at a slant (not square to its
 * axis, nor along it), worked out exactly from the two surfaces.
 */
export function meetEllipse(a: FitSurface, b: FitSurface, angle: number): Ellipse3 | null {
  for (const [cyl, pl] of [
    [a, b],
    [b, a],
  ] as const) {
    if (cyl.kind !== "cylinder" || pl.kind !== "plane") continue;
    const c = dot(cyl.axis, pl.normal);
    // Square to the axis is a circle; nearly along it, two lines (or a very long ellipse no edge needs).
    if (Math.abs(c) >= Math.cos(angle) || Math.abs(c) < 0.05) return null;
    const t = dot(sub(pl.origin, cyl.origin), pl.normal) / c;
    const centre = add(cyl.origin, scale(cyl.axis, t));
    // The short axis lies in the plane square to the cylinder's axis; the long one square to it, in the plane.
    const minorDir = unit(cross(cyl.axis, pl.normal));
    const xdir = unit(cross(minorDir, pl.normal));
    return { centre, normal: pl.normal, xdir, major: cyl.radius / Math.abs(c), minor: cyl.radius };
  }
  return null;
}

/** A chain on an exact ellipse: every point on it and on both surfaces. */
function ellipseChain(c: Chain, pts: Vec3[], place: (v: number) => Vec3, e: Ellipse3, sa: FitSurface, sb: FitSurface, tol: SimplifyTolerances): PlanCurve | null {
  const ring = c.closed ? pts.slice(0, -1) : pts;
  if (ring.length < 3) return null;
  const onBoth = (p: Vec3) => surfaceDistance(sa, p) <= tol.distance && surfaceDistance(sb, p) <= tol.distance;
  if (!ring.every((p) => onBoth(p) && dist(projectOnEllipse(e, p), p) <= tol.distance)) return null;
  // Small steps round it (an ellipse, not a polygon).
  const ts = pts.map((p) => ellipseParam(e, p));
  let turn = 0;
  for (let i = 1; i < ts.length; i++) {
    let step = ts[i] - ts[i - 1];
    step -= 2 * Math.PI * Math.round(step / (2 * Math.PI));
    if (Math.abs(step) > tol.bend * 1.05) return null;
    turn += step;
  }
  const normal = turn >= 0 ? e.normal : scale(e.normal, -1);
  // Turned round the other way, the short axis flips so the ellipse is the same one.
  const shape = { centre: e.centre, normal, xdir: e.xdir, major: e.major, minor: e.minor };
  if (c.closed || c.verts[0] === c.verts[c.verts.length - 1]) {
    // A loop starts on the cylinder's seam (see canonicalX), where a face cut from a band of it is split.
    const cyl = sa.kind === "cylinder" ? sa : sb.kind === "cylinder" ? sb : null;
    const seam = cyl ? add(cyl.origin, scale(canonicalX(cyl.axis), cyl.radius)) : e.centre;
    const onSeam = cyl ? add(seam, scale(cyl.axis, dot(sub(e.centre, seam), e.normal) / dot(cyl.axis, e.normal))) : ellipsePoint(shape, 0);
    const from = c.closed ? projectOnEllipse(shape, onSeam) : projectOnEllipse(shape, place(c.verts[0]));
    return { kind: "ellipse", ...shape, from, to: from, full: true };
  }
  const from = projectOnEllipse(shape, place(c.verts[0]));
  const to = projectOnEllipse(shape, place(c.verts[c.verts.length - 1]));
  if (dist(from, place(c.verts[0])) > tol.distance || dist(to, place(c.verts[c.verts.length - 1])) > tol.distance) return null;
  return { kind: "ellipse", ...shape, from, to, full: false };
}

/** Points along a crossing curve between mesh corners: enough that a spline through them stays on it. */
const CROSSING_STEPS = 4;
/** The most points a crossing curve is given. */
const MOST_CROSSING_POINTS = 600;

/**
 * A chain where two surfaces cross in a curve that isn't a conic (a pipe into
 * a pipe): each corner moved exactly onto both surfaces (within the
 * distance), with more points between, exactly on both. Null where they
 * don't cross cleanly (they touch, or the chain wanders off either).
 */
function crossingChain(c: Chain, pts: Vec3[], place: (v: number) => Vec3, sa: FitSurface, sb: FitSurface, tol: SimplifyTolerances): PlanCurve | null {
  const ring = c.closed ? pts.slice(0, -1) : pts;
  if (!c.closed && c.verts[0] === c.verts[c.verts.length - 1]) return null;
  const exact: Vec3[] = [];
  for (let i = 0; i < ring.length; i++) {
    const end = !c.closed && (i === 0 || i === ring.length - 1);
    const q = end ? place(c.verts[i]) : ontoBoth(ring[i], sa, sb);
    if (!q || dist(q, ring[i]) > tol.distance) return null;
    if (end && (surfaceDistance(sa, q) > 1e-6 || surfaceDistance(sb, q) > 1e-6)) {
      const r = ontoBoth(q, sa, sb);
      if (!r || dist(r, q) > 1e-4) return null;
    }
    exact.push(q);
  }
  const n = exact.length;
  const segments = c.closed ? n : n - 1;
  const steps = Math.max(1, Math.min(CROSSING_STEPS, Math.floor(MOST_CROSSING_POINTS / segments)));
  const out: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = exact[i];
    const b = exact[(i + 1) % n];
    out.push(a);
    for (let k = 1; k < steps; k++) {
      const q = ontoBoth(add(a, scale(sub(b, a), k / steps)), sa, sb);
      if (!q) return null;
      out.push(q);
    }
  }
  if (!c.closed) out.push(exact[n - 1]);
  // Smooth and going one way: no step turning back, nor sharply.
  const m = out.length;
  for (let i = 0; i < (c.closed ? m : m - 2); i++) {
    const p0 = out[i];
    const p1 = out[(i + 1) % m];
    const p2 = out[(i + 2) % m];
    const d0 = sub(p1, p0);
    const d1 = sub(p2, p1);
    const l0 = norm(d0);
    const l1 = norm(d1);
    if (l0 < 1e-7 || l1 < 1e-7) return null;
    if (dot(d0, d1) < Math.cos(Math.min(tol.bend, (30 * Math.PI) / 180)) * l0 * l1) return null;
  }
  if (c.closed) {
    // A loop starts as far round as it can from the seams of the round faces either side (a face cut from a
    // band of its surface is split there, and a corner just beside it would leave a sliver of an edge).
    const seamGap = (p: Vec3) => {
      let least = Infinity;
      for (const s of [sa, sb]) {
        if (s.kind !== "cylinder" && s.kind !== "cone") continue;
        const x = canonicalX(s.axis);
        const y = cross(s.axis, x);
        const d = sub(p, s.origin);
        least = Math.min(least, Math.abs(Math.atan2(dot(d, y), dot(d, x))));
      }
      return least;
    };
    let start = 0;
    for (let i = 1; i < m; i++) if (seamGap(out[i]) > seamGap(out[start])) start = i;
    const turned = [...out.slice(start), ...out.slice(0, start)];
    return { kind: "spline", points: turned, closed: true, from: turned[0], to: turned[0] };
  }
  return { kind: "spline", points: out, closed: false, from: out[0], to: out[m - 1] };
}

/** Points along a plan curve (both ends, and enough between to follow it), for measuring where it lies. */
export function curveSamples(c: PlanCurve, n = 32): Vec3[] {
  switch (c.kind) {
    case "line":
      return [c.from, c.to];
    case "spline":
      return c.points;
    case "arc":
    case "ellipse": {
      const shape: Ellipse3 = c.kind === "arc" ? { centre: c.centre, normal: c.normal, xdir: unit(sub(c.from, c.centre)), major: c.radius, minor: c.radius } : c;
      const t0 = ellipseParam(shape, c.from);
      let span = c.full ? 2 * Math.PI : ellipseParam(shape, c.to) - t0;
      if (!c.full) span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return Array.from({ length: n + 1 }, (_, i) => ellipsePoint(shape, t0 + (span * i) / n));
    }
  }
}
