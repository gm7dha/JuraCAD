/**
 * Is a part symmetric — the same shape as its own mirror image? For mirroring
 * in an assembly (Onshape's "mirror as instance"): the mirror image of a
 * symmetric part is the part itself, turned round, so a mirrored copy can show
 * the same part and the parts list counts one part, not a left and a right.
 *
 * Worked out in the part's own coordinates from the exact shape data the
 * engine sends with every part (not the display triangles): every face (its
 * kind of surface and its exact centre, and for flat faces which way it
 * faces) and every edge (its kind, its exact ends and middle; for a circle its
 * centre and size) must have a partner at its mirror image across the plane,
 * to within SYMMETRY_TOLERANCE. Faces must also have about the same area (from
 * the display triangles, which only adds a check). Wrongly saying "not
 * symmetric" is safe (the copy is then a true mirror image), so the checks are
 * strict.
 *
 * The planes tried: square to the part's own X, Y and Z first (as before),
 * then square to the principal directions of its face centres and of its edge
 * points (a symmetry plane is always square to one of those when they're
 * distinct), to its flat faces, and halfway between pairs of flat faces of the
 * same size — so a part drawn at a slant is found symmetric too. Each plane
 * passes halfway between the outermost face centres along it.
 *
 * A whole sub-assembly is checked the same way, with all its parts' faces and
 * edges together where they sit in it (`subAssemblySymmetry`).
 */
import type { EdgeRef, FaceRef, Vec3 } from "../geometry/topoRef";
import type { PartMesh } from "../kernel/protocol";
import type { Assembly } from "../model/types";
import { symmetricEigen } from "./connectors";
import { findMesh, meshIdOf } from "./configured";
import { applyPlacement, IDENTITY, rotate } from "./math";
import type { OwnPlane } from "./patterns";
import { leavesOf } from "./subassembly";

/** How far apart (mm) a feature and its partner's mirror image may be. (The engine's shape data is rounded to 0.0001 mm.) */
export const SYMMETRY_TOLERANCE = 0.01;
/** How much a face's area may differ from its partner's (a fraction), as measured on the display triangles. */
const AREA_TOLERANCE = 0.002;
/** At most this many slanted planes are tried (after X, Y and Z). */
const MAX_SLANTED = 48;

type ShapeData = Pick<PartMesh, "vertices" | "triangles" | "faceGroups" | "faceRefs"> & Partial<Pick<PartMesh, "edgeRefs">>;

function faceAreas(mesh: ShapeData): number[] {
  const v = mesh.vertices;
  const t = mesh.triangles;
  return mesh.faceGroups.map((g) => {
    let area = 0;
    // (A face's range counts corner indices, three per triangle.)
    for (let i = g.start; i < g.start + g.count && i + 2 < t.length; i += 3) {
      const [a, b, d] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
      const w = [v[d] - v[a], v[d + 1] - v[a + 1], v[d + 2] - v[a + 2]];
      area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
    return area;
  });
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (a: readonly number[], b: readonly number[]) => dist(a, b) <= SYMMETRY_TOLERANCE;
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** What an edge looks like, in a way that doesn't depend on which way round it runs or where a closed one starts. */
interface EdgeSummary {
  curve: string;
  /** Points that must each have a partner: a circle's centre; otherwise its ends and (lines) middle. */
  points: Vec3[];
  /** A full circle's radius, or a straight line's length (0 when not known). */
  size: number;
}

function edgeSummary(e: Pick<EdgeRef, "curve" | "a" | "b" | "mid">): EdgeSummary {
  const closed = dist(e.a, e.b) <= 1e-6;
  if (e.curve === "CIRCLE" && closed) {
    // The middle of a full circle is half a turn from its start: across a diameter.
    return { curve: e.curve, points: [[(e.a[0] + e.mid[0]) / 2, (e.a[1] + e.mid[1]) / 2, (e.a[2] + e.mid[2]) / 2]], size: dist(e.a, e.mid) / 2 };
  }
  if (e.curve === "LINE") return { curve: e.curve, points: [e.mid], size: dist(e.a, e.b) };
  return { curve: e.curve, points: closed ? [] : [e.a, e.b], size: 0 };
}

/** A shape as the check sees it: faces (with their areas) and edges. */
interface Shape {
  faces: Pick<FaceRef, "surface" | "center" | "normal">[];
  areas: number[];
  edges: EdgeSummary[];
}

/** Points looked up by where they are: a grid of cells a little bigger than the tolerance. */
class PointGrid<T> {
  private cells = new Map<string, T[]>();
  private static readonly CELL = 4 * SYMMETRY_TOLERANCE;
  private static cell = (p: readonly number[]) => p.map((v) => Math.floor(v / PointGrid.CELL));
  add(p: readonly number[], item: T) {
    const k = PointGrid.cell(p).join(",");
    const list = this.cells.get(k);
    if (list) list.push(item);
    else this.cells.set(k, [item]);
  }
  /** Everything filed within a cell of `p` (a superset of what's within the tolerance). */
  near(p: readonly number[]): T[] {
    const [x, y, z] = PointGrid.cell(p);
    const out: T[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) out.push(...(this.cells.get(`${x + i},${y + j},${z + k}`) ?? []));
    return out;
  }
}

/** Does the shape fit its mirror image across the plane p · n = at (n of length 1)? */
function fitsAcross(shape: Shape, n: Vec3, at: number, faceGrid: PointGrid<number>, edgeGrid: PointGrid<number>): boolean {
  const flip = (p: readonly number[]): Vec3 => {
    const d = 2 * (dot(p, n) - at);
    return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
  };
  const flipDir = (p: readonly number[]): Vec3 => {
    const d = 2 * dot(p, n);
    return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
  };
  const { faces, areas, edges } = shape;
  const facesOk = faces.every((f, i) => {
    const c = flip(f.center);
    const fn = flipDir(f.normal);
    return faceGrid
      .near(c)
      .some(
        (j) =>
          faces[j].surface === f.surface &&
          near(faces[j].center, c) &&
          (f.surface !== "PLANE" || dist(faces[j].normal, fn) <= 1e-3) &&
          Math.abs(areas[j] - areas[i]) <= Math.max(1e-6, AREA_TOLERANCE * areas[i]),
      );
  });
  if (!facesOk) return false;
  return edges.every((e) => {
    const pts = e.points.map(flip);
    const fits = (g: EdgeSummary) => g.curve === e.curve && Math.abs(g.size - e.size) <= SYMMETRY_TOLERANCE && pts.every((p) => g.points.some((q) => near(p, q)));
    // (An edge with no points to match — a closed curve other than a circle — takes any edge of its kind and size, as before.)
    return pts.length ? edgeGrid.near(pts[0]).some((j) => fits(edges[j])) : edges.some(fits);
  });
}

/** Directions worth trying for a slanted plane (length 1, sign fixed so the same direction isn't tried twice). */
function slantedDirections(shape: Shape): Vec3[] {
  const out: Vec3[] = [];
  const add = (v: readonly number[]) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (!(len > 1e-9)) return;
    let u: Vec3 = [v[0] / len, v[1] / len, v[2] / len];
    const big = [0, 1, 2].reduce((k, j) => (Math.abs(u[j]) > Math.abs(u[k]) ? j : k), 0);
    if (u[big] < 0) u = [-u[0], -u[1], -u[2]];
    // (X, Y and Z were tried already.)
    if (Math.abs(u[big]) > 1 - 1e-12) return;
    if (out.some((w) => Math.abs(dot(w, u)) > 1 - 1e-10)) return;
    out.push(u);
  };
  const principal = (points: readonly (readonly number[])[]) => {
    if (points.length < 2) return;
    const mean = [0, 1, 2].map((k) => points.reduce((t, p) => t + p[k], 0) / points.length);
    const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => points.reduce((t, p) => t + (p[r] - mean[r]) * (p[c] - mean[c]), 0)));
    for (const v of symmetricEigen(m).vectors) add(v);
  };
  principal(shape.faces.map((f) => f.center));
  principal(shape.edges.flatMap((e) => e.points));
  const flats = shape.faces.map((f, i) => ({ f, i })).filter(({ f }) => f.surface === "PLANE");
  for (const { f } of flats) add(f.normal);
  // A plane between two flat faces of the same size: their normals' difference points across it.
  for (let x = 0; x < flats.length && out.length < MAX_SLANTED; x++)
    for (let y = x + 1; y < flats.length && out.length < MAX_SLANTED; y++) {
      const a = flats[x];
      const b = flats[y];
      if (Math.abs(shape.areas[a.i] - shape.areas[b.i]) > Math.max(1e-6, AREA_TOLERANCE * shape.areas[a.i])) continue;
      add([a.f.normal[0] - b.f.normal[0], a.f.normal[1] - b.f.normal[1], a.f.normal[2] - b.f.normal[2]]);
    }
  return out.slice(0, MAX_SLANTED);
}

/** The plane a shape is symmetric across (its own X, Y, Z first, then slanted ones), or null. */
function symmetryOf(shape: Shape): OwnPlane | null {
  const { faces } = shape;
  if (!faces.length || faces.length !== shape.areas.length || faces.some((f) => f.surface === "UNKNOWN")) return null;
  const faceGrid = new PointGrid<number>();
  faces.forEach((f, i) => faceGrid.add(f.center, i));
  const edgeGrid = new PointGrid<number>();
  shape.edges.forEach((e, i) => {
    for (const p of e.points) edgeGrid.add(p, i);
  });
  // For a symmetric part the face centres are symmetric too, so the plane is halfway between the outermost ones.
  const middle = (n: readonly number[]) => {
    const along = faces.map((f) => dot(f.center, n));
    return (Math.min(...along) + Math.max(...along)) / 2;
  };
  for (const [k, axis] of [[0, "x"], [1, "y"], [2, "z"]] as const) {
    const n: Vec3 = [0, 0, 0];
    n[k] = 1;
    const at = middle(n);
    if (fitsAcross(shape, n, at, faceGrid, edgeGrid)) return { axis, at };
  }
  for (const n of slantedDirections(shape)) {
    const at = middle(n);
    if (fitsAcross(shape, n, at, faceGrid, edgeGrid)) {
      const axis = (["x", "y", "z"] as const)[[0, 1, 2].reduce((k, j) => (Math.abs(n[j]) > Math.abs(n[k]) ? j : k), 0)];
      return { axis, at, normal: n };
    }
  }
  return null;
}

/** A part's faces, areas and edges in its own coordinates (worked out once per built part). */
const shapes = new WeakMap<object, Shape>();
function shapeOf(mesh: ShapeData): Shape {
  let s = shapes.get(mesh);
  if (!s) shapes.set(mesh, (s = { faces: mesh.faceRefs ?? [], areas: faceAreas(mesh), edges: (mesh.edgeRefs ?? []).map(edgeSummary) }));
  return s;
}

const cache = new WeakMap<object, OwnPlane | null>();

/**
 * A plane of the part's own that it's symmetric across (its own X, then Y,
 * then Z, then slanted planes), or null when it isn't symmetric (or the shape
 * data is missing).
 */
export function ownSymmetry(mesh: ShapeData): OwnPlane | null {
  const known = cache.get(mesh);
  if (known !== undefined) return known;
  const found = symmetryOf(shapeOf(mesh));
  cache.set(mesh, found);
  return found;
}

/** Solved sub-assembly symmetries, by the parts as built and the document's assemblies. */
const subCache = new WeakMap<readonly PartMesh[], WeakMap<readonly Assembly[], Map<string, OwnPlane | null>>>();

/**
 * A plane of a sub-assembly's own (in its coordinates) that it's symmetric
 * across — all its parts together, each where its own mates put it — or null
 * (also when any of its parts isn't built). A mirror can then show the same
 * sub-assembly, turned, instead of its mirror image.
 */
export function subAssemblySymmetry(subId: string, parts: readonly PartMesh[], assemblies: readonly Assembly[]): OwnPlane | null {
  let byAll = subCache.get(parts);
  if (!byAll) subCache.set(parts, (byAll = new WeakMap()));
  let byId = byAll.get(assemblies);
  if (!byId) byAll.set(assemblies, (byId = new Map()));
  if (byId.has(subId)) return byId.get(subId)!;
  let found: OwnPlane | null = null;
  if (assemblies.some((a) => a.id === subId)) {
    const probe: Assembly = { id: "@symmetry", name: "", instances: [{ id: "@sub", partId: "", subAssembly: subId, name: "", placement: IDENTITY, fixed: true }] };
    const shape: Shape = { faces: [], areas: [], edges: [] };
    let complete = true;
    const leaves = leavesOf(probe, parts, assemblies);
    for (const l of leaves) {
      const mesh = findMesh(parts, meshIdOf(l.instance));
      if (!mesh) {
        complete = false;
        break;
      }
      const own = shapeOf(mesh);
      // Each part's faces and edges where it sits in the sub-assembly (flipped first when it's a mirror image).
      const m = !!l.instance.mirrored;
      const flipX = (v: readonly number[]): Vec3 => (m ? [-v[0], v[1], v[2]] : [v[0], v[1], v[2]]);
      const place = (v: readonly number[]) => applyPlacement(l.relative, flipX(v));
      const turn = (v: readonly number[]) => rotate(l.relative.rotation, flipX(v));
      for (const f of own.faces) shape.faces.push({ surface: f.surface, center: place(f.center), normal: turn(f.normal) });
      shape.areas.push(...own.areas);
      for (const e of own.edges) shape.edges.push({ ...e, points: e.points.map(place) });
    }
    found = complete && leaves.length ? symmetryOf(shape) : null;
  }
  byId.set(subId, found);
  return found;
}
