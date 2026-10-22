/**
 * Measuring how pairs of placed parts meet, for the assembly's clash check.
 * Only measures: what counts as a clash or as touching is decided by
 * `judgeContact` in src/assembly/assemblyCheck.ts, so it can be tested without
 * the geometry engine.
 *  - two solids: the volume they share, and that shared piece's surface area
 *    (so the overlap's thickness can be estimated);
 *  - a surface and a solid: how much of the surface is inside the solid, and
 *    how deep inside it goes;
 *  - two surfaces: how long a line they cross along (away from their edges).
 * Pairs that don't overlap get the gap between them, when it's within the
 * tolerance (to tell "touching" from "apart") — unless touching parts aren't
 * wanted, when that (slow) measurement is skipped.
 */
import { cast, getOC, makeCompound, makeVertex, measureArea, measureDistanceBetween, measureLength, measureVolume, type Shape3D } from "replicad";
import type { ContactMeasure } from "./protocol";

export interface PlacedShape {
  name: string;
  shape: Shape3D;
  surface?: boolean;
}

type Bounds = [[number, number, number], [number, number, number]];

function boundsOf(shape: Shape3D): Bounds {
  const b = shape.boundingBox;
  return [b.bounds[0] as [number, number, number], b.bounds[1] as [number, number, number]];
}

const safeDelete = (s: { delete(): void } | null | undefined) => {
  try {
    s?.delete();
  } catch {
    // already freed
  }
};

/** Pieces gathered into one shape (the pieces' own wrappers are then freed; the compound keeps what it needs). */
function gather<T extends { delete(): void }>(pieces: T[]) {
  const all = makeCompound(pieces as unknown as Parameters<typeof makeCompound>[0]);
  pieces.forEach((p) => safeDelete(p));
  return all;
}

/** The faces of a shape gathered into one shape (its boundary — distances to it aren't 0 inside a solid). */
function boundary(shape: Shape3D) {
  return gather(shape.faces);
}

/** All the edges of a shape gathered into one shape. */
function edgesCompound(shape: Shape3D) {
  return gather(shape.edges);
}



/**
 * The smallest side of the tightest box round a shape, turned to fit it (an
 * oriented box) — so a chunk of overlap at a corner of parts at an angle is
 * measured across its real thickness, not across a box lined up with X, Y, Z.
 * Falls back to the lined-up box if the turned one can't be made.
 */
function smallestSide(shape: Shape3D): number {
  try {
    const oc = getOC();
    const obb = new oc.Bnd_OBB();
    try {
      oc.BRepBndLib.AddOBB(shape.wrapped, obb, false, false, false);
      if (!obb.IsVoid()) return 2 * Math.min(obb.XHSize(), obb.YHSize(), obb.ZHSize());
    } finally {
      obb.delete();
    }
  } catch {
    // fall back below
  }
  const [lo, hi] = boundsOf(shape);
  return Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/** Solid ∩ solid: the shared volume, its surface area and the smallest side of the turned-to-fit box round it. */
function solidOverlap(a: Shape3D, b: Shape3D): { volume: number; area: number; boxMin: number } {
  const common = a.intersect(b);
  try {
    const volume = measureVolume(common);
    if (volume <= 1e-9) return { volume, area: 0, boxMin: 0 };
    return { volume, area: measureArea(common), boxMin: smallestSide(common) };
  } finally {
    safeDelete(common);
  }
}

/**
 * How much of a surface lies inside a solid (area, mm²), and how deep inside
 * it goes: the furthest any piece's middle is from the solid's outside.
 */
function surfaceInside(surface: Shape3D, solid: Shape3D): { area: number; depth: number } {
  const common = surface.intersect(solid);
  try {
    const area = measureArea(common);
    if (area <= 1e-9) return { area: 0, depth: 0 };
    const skin = boundary(solid);
    let depth = 0;
    try {
      for (const f of common.faces) {
        const c = f.center;
        const v = makeVertex([c.x, c.y, c.z]);
        depth = Math.max(depth, measureDistanceBetween(v, skin));
        safeDelete(v);
        safeDelete(c);
        safeDelete(f);
      }
    } finally {
      safeDelete(skin);
    }
    return { area, depth };
  } finally {
    safeDelete(common);
  }
}

/**
 * Where two surfaces cross: the total length of the lines where they meet,
 * leaving out lines along either one's edges (surfaces meeting edge to edge
 * only touch).
 */
function surfacesCross(a: Shape3D, b: Shape3D, tolerance: number): number {
  const oc = getOC();
  const op = new oc.BRepAlgoAPI_Section(a.wrapped, b.wrapped, true);
  const section = cast(op.Shape());
  const ea = edgesCompound(a);
  const eb = edgesCompound(b);
  let total = 0;
  try {
    for (const e of (section as unknown as Shape3D).edges) {
      const len = measureLength(e);
      const mid = e.pointAt(0.5);
      const v = makeVertex([mid.x, mid.y, mid.z]);
      const onEdge = measureDistanceBetween(v, ea) <= tolerance + 1e-6 || measureDistanceBetween(v, eb) <= tolerance + 1e-6;
      if (!onEdge) total += len;
      safeDelete(v);
      safeDelete(mid);
      safeDelete(e);
    }
  } finally {
    safeDelete(ea);
    safeDelete(eb);
    safeDelete(section);
    op.delete();
  }
  return total;
}

/**
 * Measure every pair of parts whose boxes come within `tolerance` of each other.
 * Pairs that clearly don't meet are left out.
 */
export function measureContacts(parts: PlacedShape[], tolerance: number, withGaps = true): ContactMeasure[] {
  const tol = Math.max(0, tolerance);
  const out: ContactMeasure[] = [];
  const boxes = parts.map((p) => boundsOf(p.shape));
  const apart = (a: Bounds, b: Bounds) => [0, 1, 2].some((i) => a[1][i] + tol < b[0][i] || b[1][i] + tol < a[0][i]);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (apart(boxes[i], boxes[j])) continue;
      // A surface and a solid: the surface first.
      const [p, q] = !parts[i].surface && parts[j].surface ? [parts[j], parts[i]] : [parts[i], parts[j]];
      const m: ContactMeasure = { a: p.name, b: q.name, ...(p.surface ? { surfaceA: true } : {}), ...(q.surface ? { surfaceB: true } : {}) };
      try {
        let meets = false;
        if (!p.surface && !q.surface) {
          const o = solidOverlap(p.shape, q.shape);
          m.volume = o.volume;
          m.area = o.area;
          if (o.boxMin > 0) m.boxMin = o.boxMin;
          meets = o.volume > 1e-6;
        } else if (p.surface && !q.surface) {
          const o = surfaceInside(p.shape, q.shape);
          m.area = o.area;
          m.depth = o.depth;
          meets = o.area > 1e-6;
        } else {
          m.crossLength = surfacesCross(p.shape, q.shape, tol);
          meets = m.crossLength > tol;
        }
        // Not overlapping: how far apart are they (only matters within the tolerance, and only when touching parts are listed)?
        if (!meets) {
          if (!withGaps) continue;
          const gap = measureDistanceBetween(p.shape, q.shape);
          if (gap > tol + 1e-6) continue;
          m.gap = gap;
        }
        out.push(m);
      } catch {
        // couldn't tell; say nothing rather than guess
      }
    }
  }
  return out;
}
