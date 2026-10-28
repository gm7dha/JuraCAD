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
 * centre and size) must have a partner at its mirror image across a plane
 * square to the part's own X, Y or Z, to within SYMMETRY_TOLERANCE. Faces must
 * also have about the same area (from the display triangles, which only adds
 * a check). Wrongly saying "not symmetric" is safe (the copy is then a true
 * mirror image), so the checks are strict.
 */
import type { EdgeRef, FaceRef, Vec3 } from "../geometry/topoRef";
import type { PartMesh } from "../kernel/protocol";
import type { OwnPlane } from "./patterns";

/** How far apart (mm) a feature and its partner's mirror image may be. (The engine's shape data is rounded to 0.0001 mm.) */
export const SYMMETRY_TOLERANCE = 0.01;
/** How much a face's area may differ from its partner's (a fraction), as measured on the display triangles. */
const AREA_TOLERANCE = 0.002;

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

/** What an edge looks like, in a way that doesn't depend on which way round it runs or where a closed one starts. */
interface EdgeSummary {
  curve: string;
  /** Points that must each have a partner: a circle's centre; otherwise its ends and (lines) middle. */
  points: Vec3[];
  /** A full circle's radius, or a straight line's length (0 when not known). */
  size: number;
}

function edgeSummary(e: EdgeRef): EdgeSummary {
  const closed = dist(e.a, e.b) <= 1e-6;
  if (e.curve === "CIRCLE" && closed) {
    // The middle of a full circle is half a turn from its start: across a diameter.
    return { curve: e.curve, points: [[(e.a[0] + e.mid[0]) / 2, (e.a[1] + e.mid[1]) / 2, (e.a[2] + e.mid[2]) / 2]], size: dist(e.a, e.mid) / 2 };
  }
  if (e.curve === "LINE") return { curve: e.curve, points: [e.mid], size: dist(e.a, e.b) };
  return { curve: e.curve, points: closed ? [] : [e.a, e.b], size: 0 };
}

const cache = new WeakMap<object, OwnPlane | null>();

/**
 * A plane of the part's own that it's symmetric across (its own X, then Y,
 * then Z), or null when it isn't symmetric (or the shape data is missing).
 */
export function ownSymmetry(mesh: ShapeData): OwnPlane | null {
  const known = cache.get(mesh);
  if (known !== undefined) return known;
  const faces: FaceRef[] = mesh.faceRefs ?? [];
  const areas = faceAreas(mesh);
  const edges = (mesh.edgeRefs ?? []).map(edgeSummary);
  let found: OwnPlane | null = null;
  const usable = faces.length > 0 && faces.length === areas.length && faces.every((f) => f.surface !== "UNKNOWN");
  if (usable) {
    for (const [k, axis] of [[0, "x"], [1, "y"], [2, "z"]] as const) {
      // For a symmetric part the face centres are symmetric too, so the plane is halfway between the outermost ones.
      const along = faces.map((f) => f.center[k]);
      const at = (Math.min(...along) + Math.max(...along)) / 2;
      const flip = (p: readonly number[]): Vec3 => {
        const m = [...p] as Vec3;
        m[k] = 2 * at - m[k];
        return m;
      };
      const flipDir = (p: readonly number[]): Vec3 => {
        const m = [...p] as Vec3;
        m[k] = -m[k];
        return m;
      };
      const facesOk = faces.every((f, i) => {
        const c = flip(f.center);
        const n = flipDir(f.normal);
        return faces.some(
          (g, j) =>
            g.surface === f.surface &&
            near(g.center, c) &&
            (f.surface !== "PLANE" || dist(g.normal, n) <= 1e-3) &&
            Math.abs(areas[j] - areas[i]) <= Math.max(1e-6, AREA_TOLERANCE * areas[i]),
        );
      });
      const edgesOk =
        facesOk &&
        edges.every((e) => {
          const pts = e.points.map(flip);
          return edges.some((g) => g.curve === e.curve && Math.abs(g.size - e.size) <= SYMMETRY_TOLERANCE && pts.every((p) => g.points.some((q) => near(p, q))));
        });
      if (facesOk && edgesOk) {
        found = { axis, at };
        break;
      }
    }
  }
  cache.set(mesh, found);
  return found;
}
