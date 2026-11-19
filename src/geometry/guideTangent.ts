/**
 * A loft's guide that "matches tangent" (Onshape's guide continuity): where a station's outline passes through a guide
 * that is an edge of a part, the outline there is turned to leave the guide along the face beside that edge (carried
 * on past the edge), so the loft meets the face with no crease. Pure 2D, in the station's plane: a bend of the outline
 * near the guide point only — a turn that fades smoothly to nothing a little way off, so the rest is left as it was.
 */
import type { P2 } from "./warp2d";

/** How far the bend reaches along the outline, as a share of the outline's size (its farthest point from the middle). */
export const BEND_REACH = 0.35;
/** A branch turned less than this already matches (radians, ~0.05°). */
const TINY = 1e-3;
/** Two branches meeting at more than this are a corner (one branch is turned on its own). */
const CORNER = (10 * Math.PI) / 180;
/** A branch within this of running into a face lies on that face (the loft sits on it there). */
const ON_FACE = (5 * Math.PI) / 180;

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const norm = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => {
  const l = norm(a);
  return l > 1e-15 ? [a[0] / l, a[1] / l] : a;
};
const angleOf = (a: P2, b: P2) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
const signed = (from: P2, to: P2) => Math.atan2(from[0] * to[1] - from[1] * to[0], from[0] * to[0] + from[1] * to[1]);
const turn = (p: P2, a: number): P2 => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];

/** The bend found: the map to apply to the outline's points, which face it matches, and how far the outline was turned there. */
export interface TangentBend {
  map: (p: P2) => P2;
  face: number;
  angle: number;
}

/**
 * The bend that makes the closed outline `poly` (points in order) leave the point `g` (on it) along one of `across` —
 * the directions the faces beside the guide edge carry on in, past the edge, in this plane. A face one branch of the
 * outline already runs into is skipped (the loft sits on it); of the rest, `prefer` (an index into `across`) if it's
 * free, else the first free one. At a corner of the outline only the branch nearer that way is turned; on a smooth
 * stretch both are, together. Null when there's nothing to do (no free face, or it already matches).
 */
export function tangentBend(poly: P2[], g: P2, across: P2[], prefer = 0): TangentBend | null {
  const n = poly.length;
  if (n < 3 || !across.length) return null;
  let i = 0;
  for (let k = 1; k < n; k++) if (norm(sub(poly[k], g)) < norm(sub(poly[i], g))) i = k;
  const mid: P2 = poly.reduce<P2>((m, p) => [m[0] + p[0] / n, m[1] + p[1] / n], [0, 0]);
  const size = Math.max(...poly.map((p) => norm(sub(p, mid))));
  if (!(size > 0)) return null;
  // The way the outline leaves g each way round (far enough along that a sample's spacing doesn't matter).
  const branch = (step: number): P2 => {
    for (let k = 1; k < n; k++) {
      const q = poly[(((i + step * k) % n) + n) % n];
      if (norm(sub(q, g)) > 0.01 * size) return unit(sub(q, g));
    }
    return [0, 0];
  };
  const fwd = branch(1);
  const back = branch(-1);
  const dirs = across.map(unit);
  const taken = (d: P2) => angleOf(fwd, [-d[0], -d[1]]) < ON_FACE || angleOf(back, [-d[0], -d[1]]) < ON_FACE;
  const free = dirs.map((d, k) => (taken(d) ? -1 : k)).filter((k) => k >= 0);
  if (!free.length) return null;
  const face = free.includes(prefer) ? prefer : free[0];
  const want = dirs[face];
  const corner = angleOf(fwd, [-back[0], -back[1]]) > CORNER;
  const reach = BEND_REACH * size;
  const weight = (r: number) => (r >= reach ? 0 : 0.5 * (1 + Math.cos((Math.PI * r) / reach)));
  if (corner) {
    // The branch nearer the face's way is turned on its own; the other stays as it was.
    const which = angleOf(fwd, want) <= angleOf(back, want) ? fwd : back;
    const other = which === fwd ? back : fwd;
    const angle = signed(which, want);
    if (Math.abs(angle) < TINY) return null;
    const map = (p: P2): P2 => {
      const d = sub(p, g);
      const r = norm(d);
      if (r < 1e-15 || r >= reach) return p;
      const u = unit(d);
      if (angleOf(u, which) > angleOf(u, other)) return p;
      const q = turn(d, angle * weight(r));
      return [g[0] + q[0], g[1] + q[1]];
    };
    return { map, face, angle };
  }
  // A smooth stretch: its tangent line turned onto the face's way (whichever way round needs less).
  const a1 = signed(fwd, want);
  const a2 = signed(back, want);
  const angle = Math.abs(a1) <= Math.abs(a2) ? a1 : a2;
  if (Math.abs(angle) < TINY) return null;
  const map = (p: P2): P2 => {
    const d = sub(p, g);
    const r = norm(d);
    if (r < 1e-15 || r >= reach) return p;
    const q = turn(d, angle * weight(r));
    return [g[0] + q[0], g[1] + q[1]];
  };
  return { map, face, angle };
}
