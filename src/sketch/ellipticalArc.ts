/**
 * Elliptical arc tool (Onshape's): click the centre, the end of the long
 * axis, where the arc starts (which also sets how wide the ellipse is) and
 * where it ends. Made as an ellipse with `start`/`end` — the same as Trim and
 * Split leave — running anticlockwise from start to end the short way round
 * from the start.
 */
import { placePoint, settle, sketchId, type EditResult, type Placed } from "./ops";
import { ellipseAt, type EllipseGeom } from "./ellipse";
import type { SketchData, SketchEllipse } from "./types";

type P2 = [number, number];
const TAU = Math.PI * 2;

/** The ellipse through `start` with its centre and long axis' end, and the parameters of start and end on it. */
export function ellipticalArcShape(centre: P2, major: P2, start: P2, end: P2 | null): { g: EllipseGeom; t0: number; t1: number } | null {
  const rx = Math.hypot(major[0] - centre[0], major[1] - centre[1]);
  if (rx < 1e-6) return null;
  const angle = Math.atan2(major[1] - centre[1], major[0] - centre[0]);
  const local = (p: P2): P2 => {
    const dx = p[0] - centre[0];
    const dy = p[1] - centre[1];
    return [dx * Math.cos(angle) + dy * Math.sin(angle), -dx * Math.sin(angle) + dy * Math.cos(angle)];
  };
  const [sx, sy] = local(start);
  if (Math.abs(sy) < 1e-6) return null;
  // The ellipse passing through the start; near the long axis' ends, its width is the start's distance off the axis.
  const k = Math.abs(sx) / rx;
  const ry = k < 0.98 ? Math.abs(sy) / Math.sqrt(1 - k * k) : Math.abs(sy);
  const g: EllipseGeom = { centre, rx, ry, angle };
  const param = (p: P2) => {
    const [x, y] = local(p);
    return Math.atan2(y / ry, x / rx);
  };
  const t0 = param(start);
  const t1 = end ? param(end) : t0;
  return { g, t0, t1 };
}

/** The arc's points along it (for the preview), start to end the short way round. */
export function ellipticalArcPath(shape: { g: EllipseGeom; t0: number; t1: number }, steps = 48): P2[] {
  let sweep = shape.t1 - shape.t0;
  while (sweep > Math.PI) sweep -= TAU;
  while (sweep <= -Math.PI) sweep += TAU;
  return Array.from({ length: steps + 1 }, (_, i) => ellipseAt(shape.g, shape.t0 + (sweep * i) / steps) as P2);
}

export function addEllipticalArc(s: SketchData, centre: Placed, major: Placed, start: Placed, end: Placed, construction = false): EditResult & { ellipseId: string } {
  const fail = (error: string) => ({ sketch: s, ellipseId: "", error });
  const shape = ellipticalArcShape([centre.x, centre.y], [major.x, major.y], [start.x, start.y], [end.x, end.y]);
  if (!shape) return fail("Click the centre, the end of the long axis, then where the arc starts (off the axis) and where it ends.");
  let sweep = shape.t1 - shape.t0;
  while (sweep > Math.PI) sweep -= TAU;
  while (sweep <= -Math.PI) sweep += TAU;
  if (Math.abs(sweep) < 1e-4) return fail("Move round from the start to make the arc.");
  const { g } = shape;
  let sk = s;
  const c = placePoint(sk, centre);
  sk = c.sketch;
  // The long axis' end sits exactly on the ellipse (as clicked, it's its length).
  const m = placePoint(sk, major);
  sk = m.sketch;
  if (c.id === m.id) return fail("Click the centre, then the end of the long axis.");
  const minor = ellipseAt(g, Math.PI / 2) as P2;
  const [a, b] = sweep > 0 ? [shape.t0, shape.t0 + sweep] : [shape.t0 + sweep, shape.t0];
  const pa = ellipseAt(g, a) as P2;
  const pb = ellipseAt(g, b) as P2;
  const ids = { minor: sketchId("p"), start: sketchId("p"), end: sketchId("p"), arc: sketchId("el") };
  const ellipse: SketchEllipse = { id: ids.arc, type: "ellipse", center: c.id, major: m.id, minor: ids.minor, start: ids.start, end: ids.end, construction };
  const r = settle({
    ...sk,
    points: [...sk.points, { id: ids.minor, x: minor[0], y: minor[1] }, { id: ids.start, x: pa[0], y: pa[1] }, { id: ids.end, x: pb[0], y: pb[1] }],
    curves: [...sk.curves, ellipse],
  });
  return { ...r, ellipseId: ids.arc };
}
