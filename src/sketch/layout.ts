/**
 * Where to draw dimension lines/labels and constraint badges, in sketch mm.
 */
import { curveById, ellipsePoints, pointPos, radiusOf, splinePath } from "./ops";
import { isDimension, type SketchArc, type SketchCircle, type SketchConstraint, type SketchData, type SketchLine } from "./types";

type Pt = [number, number];
export type Segment2 = [Pt, Pt];

export interface DimensionLayout {
  /** Lines to draw: extension lines and the dimension line. */
  lines: Segment2[];
  /** Where the value label sits. */
  label: Pt;
  /** The point the label offset is measured from. */
  anchor: Pt;
}

const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const dotp = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const unit = (a: Pt): Pt => {
  const l = Math.hypot(a[0], a[1]);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** A linear dimension between two points, with the label pulled sideways by `offset`. */
function linear(a: Pt, b: Pt, offset: Pt): DimensionLayout {
  const anchor = mid(a, b);
  const along = unit(sub(b, a));
  const normal: Pt = [-along[1], along[0]];
  const side = dotp(offset, normal);
  const shift = scale(normal, side);
  const a2 = add(a, shift);
  const b2 = add(b, shift);
  return { lines: [[a, a2], [b, b2], [a2, b2]], label: add(anchor, offset), anchor };
}

function linePts(s: SketchData, l: SketchLine): [Pt, Pt] {
  return [pointPos(s, l.p1), pointPos(s, l.p2)];
}

export function dimensionLayout(s: SketchData, c: SketchConstraint): DimensionLayout | null {
  const offset: Pt = c.labelOffset ? [c.labelOffset.x, c.labelOffset.y] : [0, 0];
  try {
    switch (c.type) {
      case "length": {
        const [a, b] = linePts(s, curveById(s, c.refs[0]) as SketchLine);
        return linear(a, b, offset);
      }
      case "distance":
      case "horizontalDistance":
      case "verticalDistance":
        return linear(pointPos(s, c.refs[0]), pointPos(s, c.refs[1]), offset);
      case "pointLineDistance": {
        const p = pointPos(s, c.refs[0]);
        const [a, b] = linePts(s, curveById(s, c.refs[1]) as SketchLine);
        const d = unit(sub(b, a));
        const foot = add(a, scale(d, dotp(sub(p, a), d)));
        return linear(p, foot, offset);
      }
      case "radius":
      case "diameter": {
        const circ = curveById(s, c.refs[0]) as SketchCircle | SketchArc;
        const centre = pointPos(s, circ.center);
        const r = radiusOf(s, circ);
        const dir = unit(Math.hypot(offset[0], offset[1]) > 1e-9 ? offset : [1, 1]);
        const rim = add(centre, scale(dir, r));
        const from = c.type === "diameter" ? sub(centre, scale(dir, r)) : centre;
        const label = Math.hypot(offset[0], offset[1]) > 1e-9 ? add(centre, offset) : add(centre, scale(dir, r * 1.4));
        return { lines: [[from, rim], [rim, label]], label, anchor: centre };
      }
      case "angle": {
        const [a1, b1] = linePts(s, curveById(s, c.refs[0]) as SketchLine);
        const [a2, b2] = linePts(s, curveById(s, c.refs[1]) as SketchLine);
        // Corner = where the two lines (extended) cross; fall back to their midpoints.
        const d1 = sub(b1, a1);
        const d2 = sub(b2, a2);
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        let corner: Pt;
        if (Math.abs(den) > 1e-12) {
          const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
          corner = add(a1, scale(d1, t));
        } else corner = mid(mid(a1, b1), mid(a2, b2));
        const label = add(corner, offset);
        return { lines: [[corner, label]], label, anchor: corner };
      }
      default:
        return null;
    }
  } catch {
    return null; // refers to something that no longer exists
  }
}

/** Default label offset for a new dimension placed at `at` (sketch mm). */
export function offsetFor(s: SketchData, c: SketchConstraint, at: Pt): { x: number; y: number } {
  const layout = dimensionLayout(s, { ...c, labelOffset: { x: 0, y: 0 } });
  if (!layout) return { x: 0, y: 0 };
  return { x: at[0] - layout.anchor[0], y: at[1] - layout.anchor[1] };
}

/** Short symbol for each relation, shown in a small badge like Onshape's constraint icons. */
export const RELATION_SYMBOLS: Partial<Record<SketchConstraint["type"], string>> = {
  coincident: "●",
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "T",
  concentric: "◎",
  midpoint: "M",
  symmetric: "⇆",
  pointOnLine: "●",
  pointOnCircle: "●",
  fix: "⚓",
};

/** Where a relation's badge goes (sketch mm). Several badges at one spot are spread out on screen. */
export function badgeAnchors(s: SketchData, c: SketchConstraint): Pt[] {
  if (isDimension(c)) return [];
  const at = (id: string): Pt | null => {
    const curve = curveById(s, id);
    if (!curve) {
      try {
        return pointPos(s, id);
      } catch {
        return null;
      }
    }
    if (curve.type === "line") {
      const [a, b] = linePts(s, curve);
      return mid(a, b);
    }
    if (curve.type === "spline") {
      const pts = splinePath(s, curve);
      return pts[Math.floor(pts.length / 2)];
    }
    if (curve.type === "ellipse") return ellipsePoints(s, curve, 8)[1];
    const centre = pointPos(s, curve.center);
    const r = radiusOf(s, curve);
    if (curve.type === "circle") return add(centre, scale([Math.SQRT1_2, Math.SQRT1_2], r));
    const [sx, sy] = pointPos(s, curve.start);
    const [ex, ey] = pointPos(s, curve.end);
    const a0 = Math.atan2(sy - centre[1], sx - centre[0]);
    let a1 = Math.atan2(ey - centre[1], ex - centre[0]);
    while (a1 <= a0) a1 += 2 * Math.PI;
    const am = (a0 + a1) / 2;
    return add(centre, [r * Math.cos(am), r * Math.sin(am)]);
  };
  // Relations between two things get a badge on each, like Onshape.
  const refs = c.type === "horizontal" || c.type === "vertical" || c.type === "fix" ? c.refs.slice(0, 1) : c.type === "coincident" || c.type === "pointOnLine" || c.type === "pointOnCircle" || c.type === "midpoint" ? c.refs.slice(0, 1) : c.type === "symmetric" ? c.refs.slice(0, 2) : c.refs;
  return refs.map(at).filter((p): p is Pt => p !== null);
}
