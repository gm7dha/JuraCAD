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
  type Circle3,
  type FitSurface,
  type Vec3,
  circleDistance,
  canonicalX,
  coneAxisFromNormals,
} from "./shapeFit";

export type PlanCurve =
  | { kind: "line"; from: Vec3; to: Vec3 }
  /** Anticlockwise about `normal` from `from` to `to` (all the way round when `full`; then `to` = `from`). */
  | { kind: "arc"; centre: Vec3; normal: Vec3; radius: number; from: Vec3; to: Vec3; full: boolean };

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

/** planMesh's answer when a mesh is too detailed to tidy (or ran out of WORK_LIMIT). */
export const TOO_DETAILED = "Too detailed to tidy — brought in as it is.";
/** planMesh's answer when nothing could be joined or recognised (an organic shape): nothing to gain. */
export const NOTHING_TO_TIDY = "No flat areas or round shapes to tidy — brought in as it is.";

export interface PlanOptions {
  /** Flat faces only (no round faces looked for). */
  flatOnly?: boolean;
  maxTriangles?: number;
  workLimit?: number;
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
  const faces = (s: FitSurface, g: number) => Math.abs(dot(surfaceNormal(s, groups[g].centre), groups[g].normal)) >= facing;
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
    // Looked in many places, found nothing round anywhere: an organic shape, not worth looking further.
    if (!regions.length && fruitless >= FRUITLESS_SEEDS) break;
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
  if (work > budget) return TOO_DETAILED;
  // Nothing round, and hardly any flat areas joined: nothing to gain from rebuilding it.
  if (!options.flatOnly && !regions.length && groups.length > 0.3 * nt && nt > 200) return NOTHING_TO_TIDY;

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
    for (let pass = 0; pass < 6; pass++) {
      let moved = 0;
      for (let t = 0; t < nt; t++) {
        if (areas[t] < 1e-12) continue;
        const own = triRegion[t];
        let best = own;
        // A triangle of a flat facet group that lies on a round face beside it joins that face (slivers
        // can face well off the surface's normal even with their corners right on it, so it's lenient).
        let bestErr = all[own].curved ? triError(own, t) : 1 - Math.cos(tol.bend);
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
  type Half = { a: number; b: number; other: number; used: boolean };
  const halves: Half[][] = regions.map(() => []);
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
      if (o !== r) halves[r].push({ a: tri[k], b: tri[(k + 1) % 3], other: o, used: false });
    }
  });
  const corner = (v: number) => (regionsAt.get(v)?.size ?? 0) >= 3;

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
        h = out.get(h.b)?.find((x) => !x.used);
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
      const whole = fitted.kind === "arc" && fitted.full && c.verts[0] !== c.verts[c.verts.length - 1];
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
  const arcsAt = new Map<number, Circle3[]>();
  curves.forEach((c, i) => {
    if (c.kind !== "arc") return;
    for (const v of ends[i]) {
      if (v < 0) continue;
      const list = arcsAt.get(v) ?? [];
      list.push(c);
      arcsAt.set(v, list);
    }
  });
  const finalAt = new Map<number, Vec3>();
  const at = (v: number): Vec3 => {
    let p = finalAt.get(v);
    if (p) return p;
    p = place(v);
    const arcs = arcsAt.get(v) ?? [];
    for (let it = 0; it < (arcs.length > 1 ? 200 : 1); it++) for (const a of arcs) p = projectOnCircle(a, p);
    finalAt.set(v, p);
    return p;
  };
  curves.forEach((c, i) => {
    const [a, b] = ends[i];
    if (a >= 0) c.from = at(a);
    if (b >= 0) c.to = at(b);
    if (c.kind === "arc" && c.full && a >= 0) c.to = c.from;
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
      if (o.kind === "cylinder") {
        if (Math.abs(dot(o.axis, rs.axis)) < Math.cos(angle)) continue;
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

/** A chain of mesh edges as one line or arc, or null when it's neither (within the tolerance). */
function fitChain(c: Chain, pts: Vec3[], place: (v: number) => Vec3, sa: FitSurface, sb: FitSurface, tol: SimplifyTolerances): PlanCurve | null {
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
