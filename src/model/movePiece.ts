/**
 * Move face on round faces (a hole, a boss), the pure parts the dialog needs: where the piece's axis runs and which
 * end opens onto the part, worked out from the 3D view's mesh (a whole cylinder's picked face keeps no normal), so a
 * new Translate can start sideways and its arrow can sit at the opening.
 */
import type { FaceRef, TopoPick } from "../geometry/topoRef";
import type { Axis } from "./types";

type Vec3 = [number, number, number];

/** A part's mesh as the view has it (faces in order, with their triangles). */
export interface PieceMesh {
  id: string;
  faceRefs?: readonly FaceRef[];
  vertices?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  triangles?: ArrayLike<number>;
  faceGroups?: readonly { start: number; count: number }[];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/** The index of a picked face in the mesh (the same ref, else the same kind of surface at the same centre). */
function faceIndex(mesh: PieceMesh, ref: FaceRef): number {
  const refs = mesh.faceRefs ?? [];
  const same = refs.indexOf(ref);
  if (same >= 0) return same;
  return refs.findIndex((r) => r.surface === ref.surface && Math.hypot(r.center[0] - ref.center[0], r.center[1] - ref.center[1], r.center[2] - ref.center[2]) < 1e-4);
}

/** The direction that the vectors spread least along (the smallest eigenvector of their scatter about their mean). */
function leastSpread(vs: Vec3[]): Vec3 | null {
  if (vs.length < 3) return null;
  const m: Vec3 = [0, 0, 0];
  for (const v of vs) for (let k = 0; k < 3; k++) m[k] += v[k] / vs.length;
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of vs) {
    const d: Vec3 = [v[0] - m[0], v[1] - m[1], v[2] - m[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] += d[i] * d[j];
  }
  const tr = M[0] + M[4] + M[8];
  if (!(tr > 1e-12)) return null;
  // Power iteration on (tr·I − M): its biggest eigenvector is M's smallest.
  const apply = (x: Vec3): Vec3 => [0, 1, 2].map((i) => tr * x[i] - (M[i * 3] * x[0] + M[i * 3 + 1] * x[1] + M[i * 3 + 2] * x[2])) as Vec3;
  let best: Vec3 | null = null;
  let bestQ = -Infinity;
  for (const start of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]] as Vec3[]) {
    let x = unit(start)!;
    for (let k = 0; k < 100; k++) {
      const y = unit(apply(x));
      if (!y) break;
      x = y;
    }
    const q = dot(x, apply(x));
    if (q > bestQ) {
      bestQ = q;
      best = x;
    }
  }
  if (!best) return null;
  // One fixed way round: its biggest part positive.
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(best![b]) > Math.abs(best![a]) ? b : a), 0);
  return best[k] < 0 ? [-best[0], -best[1], -best[2]] : best;
}

/** A face's axis (a cylinder's, a cone's) from its mesh (face `i`), with where along it the face starts and ends. */
function axisAt(mesh: PieceMesh, i: number): { dir: Vec3; through: Vec3; lo: number; hi: number } | null {
  const ref = mesh.faceRefs?.[i];
  const g = mesh.faceGroups?.[i];
  const tris = mesh.triangles;
  const vs = mesh.vertices;
  const ns = mesh.normals;
  if (!ref || !g || !tris || !vs || !ns) return null;
  const normals: Vec3[] = [];
  const points: Vec3[] = [];
  const seen = new Set<number>();
  for (let t = g.start; t < g.start + g.count && t < tris.length; t++) {
    const v = tris[t];
    if (seen.has(v)) continue;
    seen.add(v);
    const n = unit([ns[v * 3], ns[v * 3 + 1], ns[v * 3 + 2]]);
    if (n) normals.push(n);
    points.push([vs[v * 3], vs[v * 3 + 1], vs[v * 3 + 2]]);
  }
  const dir = leastSpread(normals);
  if (!dir) return null;
  const through = ref.center;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = dot([p[0] - through[0], p[1] - through[1], p[2] - through[2]], dir);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { dir, through, lo, hi };
}

/** A round face's axis (a cylinder's, a cone's) from its mesh, with where along it the face starts and ends. */
export function roundFaceAxis(mesh: PieceMesh, ref: FaceRef): { dir: Vec3; through: Vec3; lo: number; hi: number } | null {
  return axisAt(mesh, faceIndex(mesh, ref));
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** How far a face (centre `c`, axis `dir`) is from where one was wanted: mostly across its axis (moved along it, a hole's middle shifts by less). */
function offBy(c: Vec3, dir: Vec3, want: Vec3): number {
  const d = sub3(c, want);
  const along = dot(d, dir);
  const across = Math.hypot(d[0] - dir[0] * along, d[1] - dir[1] * along, d[2] - dir[2] * along);
  return across + 0.25 * Math.abs(along);
}

function sizeOf(mesh: PieceMesh): number {
  const v = mesh.vertices;
  if (!v || v.length < 3) return 1;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[i + k]);
      hi[k] = Math.max(hi[k], v[i + k]);
    }
  return Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
}

/**
 * The piece the picked faces make (when one of them is round): its axis, and the middle of its opening — the end of
 * the round faces away from any picked flat face (a blind hole's floor, a boss's top); with none, the end its axis
 * points to (the top, for a hole in a top face). The picked faces are found among the part's faces as the engine
 * finds them (near and unambiguous, so they follow earlier changes); `guess` says where the move being made puts a
 * point, for parts shown with it already moved — `moved` then says it was found there. Null when there's no round
 * face, its mesh isn't known, or it can't be told which face it is.
 */
export function pieceOfPicks(picks: readonly TopoPick[] | undefined, parts: readonly PieceMesh[], guess?: (p: Vec3) => Vec3): { axis: Vec3; mouth: Vec3; moved: boolean } | null {
  const faces = (picks ?? []).filter((p): p is TopoPick & { ref: FaceRef } => p.ref.kind === "face");
  const round = faces.find((p) => p.ref.surface !== "PLANE");
  if (!round) return null;
  const mesh = parts.find((m) => m.id === round.partId);
  if (!mesh?.faceRefs) return null;
  const refs = mesh.faceRefs;
  const axes = new Map<number, ReturnType<typeof axisAt>>();
  const axis = (i: number) => {
    if (!axes.has(i)) axes.set(i, axisAt(mesh, i));
    return axes.get(i)!;
  };
  const size = sizeOf(mesh);
  const ways = guess ? [(p: Vec3) => p, guess] : [(p: Vec3) => p];
  /** The face of the part a picked round face is now, by way `w`: nearest and unambiguous, else -1. */
  const find = (ref: FaceRef, w: number): { i: number; d: number } => {
    const want = ways[w](ref.center);
    let best = -1;
    let bestD = Infinity;
    let second = Infinity;
    refs.forEach((r, i) => {
      if (r.surface !== ref.surface) return;
      const ax = axis(i);
      if (!ax) return;
      const d = offBy(r.center, ax.dir, want);
      if (d < bestD) {
        second = bestD;
        bestD = d;
        best = i;
      } else if (d < second) second = d;
    });
    if (best < 0 || bestD > Math.max(0.5, 0.1 * size) || (bestD > 1e-3 && second < 1.5 * bestD)) return { i: -1, d: Infinity };
    return { i: best, d: bestD };
  };
  let way = 0;
  let hit = find(round.ref, 0);
  if (guess) {
    const other = find(round.ref, 1);
    if (other.d < hit.d - 1e-6) {
      hit = other;
      way = 1;
    }
  }
  if (hit.i < 0) return null;
  const ax = axis(hit.i)!;
  let lo = ax.lo;
  let hi = ax.hi;
  for (const f of faces) {
    if (f === round || f.ref.surface === "PLANE" || f.partId !== round.partId) continue;
    const at = find(f.ref, way);
    const other = at.i >= 0 ? axis(at.i) : null;
    if (!other || Math.abs(dot(other.dir, ax.dir)) < 0.9999) continue;
    for (const e of [other.lo, other.hi]) {
      const p: Vec3 = [other.through[0] + other.dir[0] * e, other.through[1] + other.dir[1] * e, other.through[2] + other.dir[2] * e];
      const t = dot(sub3(p, ax.through), ax.dir);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  }
  const flats = faces.filter((f) => f.ref.surface === "PLANE").map((f) => dot(sub3(ways[way](f.ref.center), ax.through), ax.dir));
  let t = hi;
  if (flats.length) {
    const mean = flats.reduce((a, b) => a + b, 0) / flats.length;
    t = Math.abs(mean - lo) > Math.abs(mean - hi) ? lo : hi;
  }
  const mouth: Vec3 = [ax.through[0] + ax.dir[0] * t, ax.through[1] + ax.dir[1] * t, ax.through[2] + ax.dir[2] * t];
  return { axis: ax.dir, mouth, moved: way === 1 };
}
/** The first of X, Y, Z most square to `dir` (a sideways way to slide a hole along that axis). */
export function sidewaysAxis(dir: Vec3): Axis {
  const ks: Axis[] = ["x", "y", "z"];
  let best = 0;
  for (let k = 1; k < 3; k++) if (Math.abs(dir[k]) < Math.abs(dir[best]) - 1e-9) best = k;
  return ks[best];
}
