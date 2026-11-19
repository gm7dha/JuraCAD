/**
 * Planes and the origin as sketch references (Onshape's): where Top, Front,
 * Right and Plane features cross the sketch's plane is a line the sketch can
 * snap onto, dimension to and use in relations (seen edge-on only — a plane
 * lying flat to the sketch gives nothing), and the origin, seen square-on, is a
 * point. They're offered as ordinary references (`RefEdge` with a `source`),
 * so bringing one in is the same as bringing in another sketch's line: a
 * construction line following `{ sketch: <plane id>, item: PLANE_ITEM }`,
 * found again on every rebuild (a Plane feature that moves moves it).
 *
 * Default planes have ids "@Top", "@Front", "@Right"; the origin "@origin".
 * Pure: frames in, sketch millimetres out.
 */
import type { RefEdge } from "./links";
import { cross, dot, planeFrame, toSketch, type DefaultPlane, type PlaneFrame, type Vec3 } from "./planes";

type P2 = [number, number];

/** The item id of a plane's line in its link (`{ sketch: <plane id>, item: PLANE_ITEM }`). */
export const PLANE_ITEM = "@plane";
/** The origin's id in a point's link (`{ sketch: ORIGIN_REF, item: ORIGIN_REF }`). */
export const ORIGIN_REF = "@origin";
/** Half the length of a plane's line as brought in (it's endless; the copy needs ends). */
export const PLANE_LINE_HALF = 100;

const DEFAULTS: DefaultPlane[] = ["Top", "Front", "Right"];

export const defaultPlaneId = (name: DefaultPlane) => `@${name}`;
/** The ids of what's always there: the default planes and the origin. */
export const DEFAULT_PLANE_REFS: readonly string[] = ["@Top", "@Front", "@Right", "@origin"];
const defaultFrom = (id: string): DefaultPlane | null => {
  const name = id.startsWith("@") ? id.slice(1) : "";
  return (DEFAULTS as string[]).includes(name) ? (name as DefaultPlane) : null;
};

/** A plane a sketch can use: a default plane or a Plane feature (with where it is now). */
export interface PlaneSource {
  id: string;
  name: string;
  frame: PlaneFrame;
  /** Further down the feature list than the sketch (shown, but it says why it can't be used). */
  later?: boolean;
}

/** Whether a link (of a curve or point) follows a plane or the origin rather than another sketch. */
export const isPlaneLink = (l: { sketch: string; item: string }): boolean => l.item === PLANE_ITEM || l.sketch === ORIGIN_REF;

/** Whether a reference is a plane's line or the origin. */
export const isPlaneRef = (e: RefEdge): boolean => !!e.source && isPlaneLink(e.source);

/** Whether a link's plane is a default plane (or the origin): always there, always shown. */
export const isDefaultPlaneId = (id: string): boolean => id === ORIGIN_REF || defaultFrom(id) !== null;

/**
 * Where a plane crosses the sketch's plane, as a line in the sketch: through
 * the place nearest where the plane's own origin is seen, PLANE_LINE_HALF each
 * way, running towards +x (or, upright, +y) so it's found the same way round on
 * every rebuild. Null when the plane lies flat to the sketch (parallel to it).
 */
export function planeCrossing(sketch: PlaneFrame, plane: PlaneFrame): { a: P2; b: P2; mid: P2 } | null {
  const d = cross(sketch.n, plane.n);
  if (Math.hypot(...d) < 1e-9) return null;
  // The line: g · (x, y) = c, from n_p · (o_s + x u + y v − o_p) = 0.
  const g: P2 = [dot(plane.n, sketch.u), dot(plane.n, sketch.v)];
  const gg = g[0] * g[0] + g[1] * g[1];
  if (gg < 1e-18) return null;
  const off: Vec3 = [plane.origin[0] - sketch.origin[0], plane.origin[1] - sketch.origin[1], plane.origin[2] - sketch.origin[2]];
  const c = dot(plane.n, off);
  const anchor = toSketch(sketch, plane.origin);
  const k = (c - (g[0] * anchor[0] + g[1] * anchor[1])) / gg;
  const mid: P2 = [clean(anchor[0] + k * g[0]), clean(anchor[1] + k * g[1])];
  const len = Math.sqrt(gg);
  let t: P2 = [-g[1] / len, g[0] / len];
  if (t[0] < -1e-9 || (Math.abs(t[0]) <= 1e-9 && t[1] < 0)) t = [-t[0], -t[1]];
  const h = PLANE_LINE_HALF;
  return { a: [clean(mid[0] - h * t[0]), clean(mid[1] - h * t[1])], b: [clean(mid[0] + h * t[0]), clean(mid[1] + h * t[1])], mid };
}

/** Rounding dust (1e-12 mm) taken off, so a line through the origin is exactly there. */
const clean = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x);

/** A plane's line as a reference (null when it lies flat to the sketch). */
export function planeRef(sketch: PlaneFrame, p: PlaneSource): RefEdge | null {
  const line = planeCrossing(sketch, p.frame);
  if (!line) return null;
  return { kind: "line", ...line, source: { sketch: p.id, item: PLANE_ITEM, ends: {}, name: p.name, ...(p.later ? { later: true } : {}) } };
}

/** Where the origin is seen in the sketch. */
export const originSeen = (sketch: PlaneFrame): P2 => {
  const [x, y] = toSketch(sketch, [0, 0, 0]);
  return [clean(x), clean(y)];
};

/**
 * Everything planes give a sketch: the lines where Top, Front and Right (and
 * the Plane features given) cross it, and the origin as a point when it isn't
 * already the sketch's own origin (a sketch on a face or plane away from it).
 */
export function planeRefs(sketch: PlaneFrame, planes: PlaneSource[] = []): RefEdge[] {
  const out: RefEdge[] = [];
  for (const name of DEFAULTS) {
    const r = planeRef(sketch, { id: defaultPlaneId(name), name, frame: planeFrame({ kind: "default", name }) });
    if (r) out.push(r);
  }
  for (const p of planes) {
    const r = planeRef(sketch, p);
    if (r) out.push(r);
  }
  const o = originSeen(sketch);
  if (Math.hypot(o[0], o[1]) > 1e-6) out.push({ kind: "point", a: o, b: o, mid: o, source: { sketch: ORIGIN_REF, item: ORIGIN_REF, ends: { a: ORIGIN_REF }, name: "the origin" } });
  return out;
}

/**
 * A plane's line (or the origin) found again for a link: `planes` are the
 * Plane features built so far, by id. Null when it's gone, later in the list
 * (not in `planes`), or lies flat to the sketch now.
 */
export function seePlaneLink(sketch: PlaneFrame, link: { sketch: string; item: string }, planes: ReadonlyMap<string, PlaneFrame>): RefEdge | null {
  if (link.sketch === ORIGIN_REF) {
    const o = originSeen(sketch);
    return { kind: "point", a: o, b: o, mid: o };
  }
  if (link.item !== PLANE_ITEM) return null;
  const name = defaultFrom(link.sketch);
  const frame = name ? planeFrame({ kind: "default", name }) : planes.get(link.sketch);
  return frame ? planeRef(sketch, { id: link.sketch, name: name ?? "", frame }) : null;
}
