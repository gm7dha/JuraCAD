/**
 * Is a part symmetric — the same shape as its own mirror image? For mirroring
 * in an assembly (Onshape's "mirror as instance"): the mirror image of a
 * symmetric part is the part itself, turned round, so a mirrored copy can show
 * the same part and the parts list counts one part, not a left and a right.
 *
 * Worked out from the part's display mesh, in its own coordinates: every face
 * (its area and middle) must have a partner of the same size at its mirror
 * image across a plane through the middle of the part's box, square to its
 * own X, Y or Z.
 */
import type { PartMesh } from "../kernel/protocol";
import type { OwnPlane } from "./patterns";

interface FaceSummary {
  area: number;
  centre: [number, number, number];
}

function faces(mesh: Pick<PartMesh, "vertices" | "triangles" | "faceGroups">): FaceSummary[] {
  const v = mesh.vertices;
  const t = mesh.triangles;
  return mesh.faceGroups.map((g) => {
    let area = 0;
    const c: [number, number, number] = [0, 0, 0];
    // (A face's range counts corner indices, three per triangle.)
    for (let i = g.start; i < g.start + g.count && i + 2 < t.length; i += 3) {
      const [a, b, d] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
      const w = [v[d] - v[a], v[d + 1] - v[a + 1], v[d + 2] - v[a + 2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const ar = Math.hypot(n[0], n[1], n[2]) / 2;
      area += ar;
      for (let k = 0; k < 3; k++) c[k] += (ar * (v[a + k] + v[b + k] + v[d + k])) / 3;
    }
    return { area, centre: area > 0 ? [c[0] / area, c[1] / area, c[2] / area] : c };
  });
}

const cache = new WeakMap<object, OwnPlane | null>();

/**
 * A plane of the part's own that it's symmetric across (its own X, then Y,
 * then Z, through the middle of its box), or null when it isn't symmetric.
 */
export function ownSymmetry(mesh: Pick<PartMesh, "vertices" | "triangles" | "faceGroups">): OwnPlane | null {
  const known = cache.get(mesh);
  if (known !== undefined) return known;
  const list = faces(mesh);
  const v = mesh.vertices;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k]);
      max[k] = Math.max(max[k], v[i + k]);
    }
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  // Display meshes are within about 0.05 mm of the true shape: allow for that, and for curved faces' facets.
  const near = Math.max(0.02, size * 2e-3);
  let found: OwnPlane | null = null;
  if (list.length && size > 0) {
    for (const [k, axis] of [[0, "x"], [1, "y"], [2, "z"]] as const) {
      const at = (min[k] + max[k]) / 2;
      const ok = list.every((f) => {
        const m = [...f.centre];
        m[k] = 2 * at - m[k];
        return list.some((g) => Math.abs(g.area - f.area) <= Math.max(1e-6, f.area * 0.01) && Math.hypot(g.centre[0] - m[0], g.centre[1] - m[1], g.centre[2] - m[2]) <= near);
      });
      if (ok) {
        found = { axis, at };
        break;
      }
    }
  }
  cache.set(mesh, found);
  return found;
}
