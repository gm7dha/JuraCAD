/**
 * Where to draw dimension lines/labels and constraint badges, in sketch mm.
 */
import { angleRays, curveById, ellipsePoints, pointPos, radiusOf, splinePath } from "./ops";
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

/** A horizontal (k = 0) or vertical (k = 1) dimension between two points: square extension lines out to the label's level. */
function squared(a: Pt, b: Pt, offset: Pt, k: 0 | 1): DimensionLayout {
  const anchor = mid(a, b);
  const label = add(anchor, offset);
  // The dimension line runs across (or up) at the label's height (or position).
  const at = (p: Pt): Pt => (k === 0 ? [p[0], label[1]] : [label[0], p[1]]);
  const a2 = at(a);
  const b2 = at(b);
  return { lines: [[a, a2], [b, b2], [a2, b2]], label, anchor };
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
        return linear(pointPos(s, c.refs[0]), pointPos(s, c.refs[1]), offset);
      case "horizontalDistance":
      case "verticalDistance":
        return squared(pointPos(s, c.refs[0]), pointPos(s, c.refs[1]), offset, c.type === "horizontalDistance" ? 0 : 1);
      case "offset": {
        // Drawn on the first copy: across to its original.
        const copy = curveById(s, c.refs[0]);
        const orig = curveById(s, c.refs[1]);
        if (copy?.type === "line" && orig?.type === "line") {
          const [a, b] = linePts(s, copy);
          const p = mid(a, b);
          const [m, n] = linePts(s, orig);
          const d = unit(sub(n, m));
          const foot = add(m, scale(d, dotp(sub(p, m), d)));
          return { lines: [[p, foot]], label: add(mid(p, foot), offset), anchor: mid(p, foot) };
        }
        if ((copy?.type === "arc" || copy?.type === "circle") && (orig?.type === "arc" || orig?.type === "circle")) {
          const centre = pointPos(s, copy.center);
          // Along the middle of the copy (an arc), or up and to the right (a circle).
          let dir: Pt = [Math.SQRT1_2, Math.SQRT1_2];
          if (copy.type === "arc") {
            const a0 = Math.atan2(pointPos(s, copy.start)[1] - centre[1], pointPos(s, copy.start)[0] - centre[0]);
            let a1 = Math.atan2(pointPos(s, copy.end)[1] - centre[1], pointPos(s, copy.end)[0] - centre[0]);
            while (a1 <= a0) a1 += 2 * Math.PI;
            dir = [Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2)];
          }
          const p = add(centre, scale(dir, radiusOf(s, copy)));
          const q = add(centre, scale(dir, radiusOf(s, orig)));
          return { lines: [[p, q]], label: add(mid(p, q), offset), anchor: mid(p, q) };
        }
        return null;
      }
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
        // An arc round the corner between the two rays, as far out as the label; the lines are
        // extended (dashed-looking thin lines) out to the arc where they stop short of it.
        const { corner, u, w } = angleRays(s, c);
        const r = Math.max(Math.hypot(offset[0], offset[1]), 2);
        const label = add(corner, offset);
        const a0 = Math.atan2(u[1], u[0]);
        let sweep = Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]);
        if (Math.abs(sweep) < 1e-9) sweep = Math.PI;
        const steps = Math.max(8, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 96));
        const lines: Segment2[] = [];
        let prev: Pt = add(corner, scale(u, r));
        for (let i = 1; i <= steps; i++) {
          const a = a0 + (sweep * i) / steps;
          const p: Pt = add(corner, [r * Math.cos(a), r * Math.sin(a)]);
          lines.push([prev, p]);
          prev = p;
        }
        for (const [ray, ref] of [
          [u, c.refs[0]],
          [w, c.refs[1]],
        ] as [Pt, string][]) {
          const [p, q] = linePts(s, curveById(s, ref) as SketchLine);
          const reach = Math.max(dotp(sub(p, corner), ray), dotp(sub(q, corner), ray));
          if (reach < r) lines.push([add(corner, scale(ray, Math.max(reach, 0))), add(corner, scale(ray, r))]);
        }
        return { lines, label, anchor: corner };
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
