/**
 * Remembering which edge or face the user picked, in a way that survives
 * rebuilds (a simple answer to the "topological naming" problem).
 *
 * OpenCascade renumbers edges and faces whenever the model is rebuilt, so we
 * never store numbers. Instead we store what the edge or face looks like —
 * its kind of curve or surface and where it is — and on every rebuild look
 * for the best match on the new shape. If you make a box wider, the edge you
 * rounded moves a little, and the nearest edge of the same kind and direction
 * is still the one you meant.
 */

export type Vec3 = [number, number, number];

/** A picked edge: its kind of curve, its two ends and its middle. */
export interface EdgeRef {
  kind: "edge";
  /** OpenCascade curve type, e.g. "LINE" or "CIRCLE". */
  curve: string;
  a: Vec3;
  b: Vec3;
  mid: Vec3;
  /** The middle as a fraction of the part's bounding box (0 = min side, 1 = max side) on each axis. */
  rel?: Vec3;
}

/** A picked face: its kind of surface, its centre and which way it faces. */
export interface FaceRef {
  kind: "face";
  /** OpenCascade surface type, e.g. "PLANE" or "CYLINDRE". */
  surface: string;
  center: Vec3;
  normal: Vec3;
  /** The centre as a fraction of the part's bounding box on each axis. */
  rel?: Vec3;
}

export type TopoRef = EdgeRef | FaceRef;

/** A picked edge or face on a particular part (parts are named by the feature that made them). */
export interface TopoPick {
  partId: string;
  ref: TopoRef;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 | null => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/** Where a point sits within a bounding box, 0…1 on each axis (0.5 on a flat axis). */
export function relativeTo(p: Vec3, min: Vec3, max: Vec3): Vec3 {
  return [0, 1, 2].map((i) => {
    const extent = max[i] - min[i];
    return extent > 1e-6 ? Math.round(((p[i] - min[i]) / extent) * 1e4) / 1e4 : 0.5;
  }) as Vec3;
}

/** Round to 0.1 µm so saved files stay tidy. */
export function roundVec(v: Vec3): Vec3 {
  return v.map((x) => Math.round(x * 1e4) / 1e4) as Vec3;
}

/**
 * How different two references are, in millimetres (roughly how far the
 * edge or face would have had to move). Infinity when they can't be the same
 * thing: different kinds, or pointing different ways.
 */
export function refDistance(want: TopoRef, have: TopoRef, size?: number): number {
  const d = absoluteDistance(want, have);
  // Also compare positions relative to the part's size: when the whole part is
  // scaled, an edge "at the right-hand end, half way up" stays there.
  if (size && Number.isFinite(d) && want.rel && have.rel) return Math.min(d, dist(want.rel, have.rel) * size);
  return d;
}

function absoluteDistance(want: TopoRef, have: TopoRef): number {
  if (want.kind === "edge" && have.kind === "edge") {
    if (want.curve !== have.curve) return Infinity;
    const d1 = unit(sub(want.b, want.a));
    const d2 = unit(sub(have.b, have.a));
    if (want.curve === "LINE" && d1 && d2) {
      if (Math.abs(dot(d1, d2)) < 0.97) return Infinity;
      // Mostly: how far the line it lies along has moved. Making a part longer
      // stretches an edge but leaves that line where it was.
      const off = sub(want.mid, have.mid);
      const along = dot(off, d2);
      const sideways = len([off[0] - along * d2[0], off[1] - along * d2[1], off[2] - along * d2[2]]);
      return sideways + 0.1 * len(off);
    }
    const ends = Math.min(dist(want.a, have.a) + dist(want.b, have.b), dist(want.a, have.b) + dist(want.b, have.a));
    return dist(want.mid, have.mid) + 0.25 * ends;
  }
  if (want.kind === "face" && have.kind === "face") {
    if (want.surface !== have.surface) return Infinity;
    if (want.surface === "PLANE") {
      if (dot(want.normal, have.normal) < 0.9) return Infinity;
      // Mostly: how far the face's plane has moved.
      const off = sub(want.center, have.center);
      return Math.abs(dot(off, have.normal)) + 0.1 * len(off);
    }
    return dist(want.center, have.center);
  }
  return Infinity;
}

/** References this close are the same edge or face on the same shape (used for highlighting and toggling). */
export const SAME_REF_TOLERANCE = 1e-3;

export function sameRef(a: TopoRef, b: TopoRef): boolean {
  return refDistance(a, b) <= SAME_REF_TOLERANCE;
}

/** Index of the reference in `candidates` that is exactly `ref`, or -1. */
export function indexOfRef(candidates: TopoRef[], ref: TopoRef): number {
  let best = -1;
  let bestD = SAME_REF_TOLERANCE;
  candidates.forEach((c, i) => {
    const d = refDistance(ref, c);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * Find each wanted reference on a (possibly changed) shape. Each candidate is
 * used at most once, closest matches first. `size` is the part's overall size
 * (bounding-box diagonal), which sets how far something may have moved and
 * still count as the same.
 *
 * Returns, for each wanted reference, the index of its match or null.
 */
export function matchRefs(wants: TopoRef[], candidates: TopoRef[], size: number): (number | null)[] {
  const limit = Math.max(1, 0.3 * size);
  const pairs: { w: number; c: number; d: number }[] = [];
  wants.forEach((want, w) =>
    candidates.forEach((have, c) => {
      const d = refDistance(want, have, size);
      if (d <= limit) pairs.push({ w, c, d });
    }),
  );
  pairs.sort((p, q) => p.d - q.d);
  const result: (number | null)[] = wants.map(() => null);
  const used = new Set<number>();
  for (const p of pairs) {
    if (result[p.w] !== null || used.has(p.c)) continue;
    result[p.w] = p.c;
    used.add(p.c);
  }
  return result;
}

/** Short description for lists, e.g. "Straight edge" or "Flat face". */
export function describeRef(ref: TopoRef, faceOnly = false): string {
  if (ref.kind === "edge") {
    if (ref.curve === "LINE") return "Straight edge";
    if (ref.curve === "CIRCLE") return dist(ref.a, ref.b) < 1e-6 ? "Circular edge" : "Curved edge";
    return "Curved edge";
  }
  const all = faceOnly ? "" : " (all its edges)";
  if (ref.surface === "PLANE") return `Flat face${all}`;
  if (ref.surface === "CYLINDRE") return `Round face${all}`;
  return `Curved face${all}`;
}

/** Check untrusted JSON for a pick. */
export function parsePick(data: unknown): TopoPick | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ref = d.ref as Record<string, unknown> | undefined;
  if (typeof d.partId !== "string" || !ref || typeof ref !== "object") return null;
  const vec = (v: unknown): Vec3 | null =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as Vec3) : null;
  const rel = vec(ref.rel);
  if (ref.kind === "edge" && typeof ref.curve === "string") {
    const a = vec(ref.a);
    const b = vec(ref.b);
    const mid = vec(ref.mid);
    if (a && b && mid) return { partId: d.partId, ref: { kind: "edge", curve: ref.curve, a, b, mid, ...(rel ? { rel } : {}) } };
  }
  if (ref.kind === "face" && typeof ref.surface === "string") {
    const center = vec(ref.center);
    const normal = vec(ref.normal);
    if (center && normal) return { partId: d.partId, ref: { kind: "face", surface: ref.surface, center, normal, ...(rel ? { rel } : {}) } };
  }
  return null;
}
