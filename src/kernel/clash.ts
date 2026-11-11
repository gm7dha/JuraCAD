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
  /** The part's key in the assembly (InstanceInput.id), passed on as ContactMeasure.ids. */
  id?: string;
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

type V3 = [number, number, number];

/** A round face of a placed part: a whole or partial cylinder. */
interface RoundFace {
  radius: number;
  origin: V3;
  axis: V3;
  /** How far along the axis it reaches, measured from `origin` (in the axis's direction). */
  from: number;
  to: number;
  /** A hole (the solid is outside the cylinder) rather than a pin or boss. */
  hole: boolean;
}

/** More round faces than this on one part and the pin-in-hole search is skipped (it stays cheap). */
const MAX_ROUND_FACES = 400;

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** A placed part's cylinder faces (null when it has too many to compare). */
function roundFacesOf(shape: Shape3D): RoundFace[] | null {
  const oc = getOC();
  const out: RoundFace[] = [];
  for (const f of shape.faces) {
    const made: { delete(): void }[] = [f];
    try {
      if (f.geomType !== "CYLINDRE") continue;
      if (out.length >= MAX_ROUND_FACES) return null;
      const adaptor = new oc.BRepAdaptor_Surface(f.wrapped, true);
      made.push(adaptor);
      const cyl = adaptor.Cylinder();
      const ax = cyl.Axis();
      const loc = ax.Location();
      const dir = ax.Direction();
      made.push(cyl, ax, loc, dir);
      const origin: V3 = [loc.X(), loc.Y(), loc.Z()];
      const axis: V3 = [dir.X(), dir.Y(), dir.Z()];
      const b = f.UVBounds;
      const props = new oc.BRepGProp_Face(f.wrapped, false);
      const at = new oc.gp_Pnt();
      const nv = new oc.gp_Vec();
      made.push(props, at, nv);
      props.Normal((b.uMin + b.uMax) / 2, (b.vMin + b.vMax) / 2, at, nv);
      const p: V3 = [at.X(), at.Y(), at.Z()];
      const rel = sub3(p, origin);
      const along = dot3(rel, axis);
      const radial: V3 = [rel[0] - axis[0] * along, rel[1] - axis[1] * along, rel[2] - axis[2] * along];
      out.push({ radius: cyl.Radius(), origin, axis, from: Math.min(b.vMin, b.vMax), to: Math.max(b.vMin, b.vMax), hole: dot3([nv.X(), nv.Y(), nv.Z()], radial) < 0 });
    } catch {
      // not measurable; leave it out
    } finally {
      made.forEach(safeDelete);
    }
  }
  return out;
}

/**
 * A pin in a hole: a round face of one part and a round hole of the other on
 * the same axis (within 0.01 mm and about 0.05°), side by side along it. Of
 * those, the pair whose radii are closest; `radial` is the hole's radius less
 * the pin's — the gap all round (negative: the pin is bigger, an overlap) — and
 * `diameter` the pin's. Null when there's no such pair within `range` mm.
 */
function pinInHole(a: RoundFace[], b: RoundFace[], range: number): { radial: number; diameter: number } | null {
  let best: { radial: number; diameter: number } | null = null;
  const check = (pin: RoundFace, hole: RoundFace) => {
    const radial = hole.radius - pin.radius;
    if (Math.abs(radial) > range || (best && Math.abs(radial) >= Math.abs(best.radial))) return;
    const c = dot3(pin.axis, hole.axis);
    if (Math.abs(c) < 0.9999996) return;
    // The hole's axis passes through the pin's.
    const d = sub3(hole.origin, pin.origin);
    const along = dot3(d, pin.axis);
    const off = Math.hypot(d[0] - pin.axis[0] * along, d[1] - pin.axis[1] * along, d[2] - pin.axis[2] * along);
    if (off > 0.01) return;
    // Side by side along the axis (both measured along the pin's axis).
    const h0 = along + c * hole.from;
    const h1 = along + c * hole.to;
    if (Math.min(pin.to, Math.max(h0, h1)) - Math.max(pin.from, Math.min(h0, h1)) <= 1e-6) return;
    best = { radial, diameter: 2 * pin.radius };
  };
  for (const p of a) for (const q of b) {
    if (!p.hole && q.hole) check(p, q);
    else if (p.hole && !q.hole) check(q, p);
  }
  return best;
}

/**
 * Measure every pair of parts whose boxes come within `tolerance` of each other.
 * Pairs that clearly don't meet are left out. With `fitRange` (mm, for the fit
 * check) pairs of solids up to that far apart are measured too: the smallest
 * gap between them, and for a pin in a hole the gap (or overlap) all round it
 * (ContactMeasure.ring).
 */
export function measureContacts(parts: PlacedShape[], tolerance: number, withGaps = true, fitRange = 0): ContactMeasure[] {
  const tol = Math.max(0, tolerance);
  const near = Math.max(tol, fitRange);
  const out: ContactMeasure[] = [];
  const boxes = parts.map((p) => boundsOf(p.shape));
  const rounds = new Map<number, RoundFace[] | null>();
  const roundOf = (k: number) => {
    if (!rounds.has(k)) rounds.set(k, roundFacesOf(parts[k].shape));
    return rounds.get(k)!;
  };
  const apart = (a: Bounds, b: Bounds) => [0, 1, 2].some((i) => a[1][i] + near < b[0][i] || b[1][i] + near < a[0][i]);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (apart(boxes[i], boxes[j])) continue;
      // A surface and a solid: the surface first.
      const swap = !parts[i].surface && parts[j].surface;
      const [p, q] = swap ? [parts[j], parts[i]] : [parts[i], parts[j]];
      const m: ContactMeasure = { a: p.name, b: q.name, ...(p.id !== undefined && q.id !== undefined ? { ids: [p.id, q.id] as [string, string] } : {}), ...(p.surface ? { surfaceA: true } : {}), ...(q.surface ? { surfaceB: true } : {}) };
      try {
        let meets = false;
        const solids = !p.surface && !q.surface;
        if (solids) {
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
        const fits = fitRange > 0 && solids;
        if (fits) {
          const [ri, rj] = [roundOf(i), roundOf(j)];
          const ring = ri && rj ? (swap ? pinInHole(rj, ri, fitRange) : pinInHole(ri, rj, fitRange)) : null;
          if (ring) m.ring = ring;
        }
        // Not overlapping: how far apart are they (only matters within the tolerance, and only when touching parts are listed — or for the fit check)?
        if (!meets) {
          if (!withGaps && !fits) continue;
          const gap = measureDistanceBetween(p.shape, q.shape);
          if (gap > (fits ? near : tol) + 1e-6 && !m.ring) continue;
          if (gap <= near + 1e-6) m.gap = gap;
        }
        out.push(m);
      } catch {
        // couldn't tell; say nothing rather than guess
      }
    }
  }
  return out;
}
