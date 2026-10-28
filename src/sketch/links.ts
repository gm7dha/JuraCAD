/**
 * Reference geometry in a sketch (Onshape's reference geometry and "Use").
 *
 * When a sketch sits on a part's face, the face's edges (its outline and the
 * edges of any holes in it) are shown faintly in the sketch. They aren't part
 * of the sketch until they're needed: snapping to one of their corners, or
 * dimensioning to one, copies that edge in as a *reference* — a construction
 * line, circle or arc that is fixed where the edge is and remembers the edge
 * (`link`). "Use" copies one in as real geometry the same way. On every
 * rebuild the geometry engine finds each linked edge again and `followLinks`
 * moves the copy to it, so the sketch follows the part.
 *
 * Any sketch can also use what's elsewhere: other sketches' points, lines,
 * circles and arcs, and every part's corners, edges and circle centres, seen
 * square-on to the sketch (projected onto its plane). The engine lists them
 * for the sketch being edited (`GeometryEngine.sketchCandidates`, kept in the store as `sketchCandidates`; see
 * projected.ts). Snapping to one of their points brings in just that point (a
 * fixed construction point that follows it, `SketchPoint.link`); snapping onto
 * or dimensioning to one of their lines, circles or arcs brings that curve in.
 * Only sketches earlier in the feature list can be used (so nothing goes round
 * in a circle).
 *
 * All positions are sketch millimetres.
 */
import { sameRef, type EdgeRef, type FaceRef, type TopoPick, type Vec3 } from "../geometry/topoRef";
import { pointPos, settle, sketchId, type EditResult } from "./ops";
import { toSketch, type PlaneFrame, type SketchPlane } from "./planes";
import { isPartLink, type CurveLink, type PointLink, type SketchArc, type SketchCircle, type SketchConstraint, type SketchCurve, type SketchData, type SketchLine, type SketchPoint } from "./types";

type P2 = [number, number];

/** Where a reference that isn't a part edge comes from: another sketch's curve or point. */
export interface RefSource {
  /** The sketch's feature id, and the curve's (or the lone point's) id in it. */
  sketch: string;
  item: string;
  /** The ids, in that sketch, of the points at this reference's ends (a, b) and centre (c). */
  ends?: { a?: string; b?: string; c?: string };
  /** That sketch is further down the feature list than this one, so it can't be used (it's shown, and says why). */
  later?: boolean;
  /** That sketch's name (for messages). */
  name?: string;
}

/** A part edge, or another sketch's curve or point, as seen in the sketch's plane. */
export interface RefEdge {
  /** A part's edge (on its part), so it can be found again after a rebuild. Missing for other sketches' geometry. */
  pick?: TopoPick;
  /** A part edge that isn't one of the sketch face's own edges: it's seen square-on from wherever it is. */
  project?: boolean;
  /** Another sketch's curve or point. */
  source?: RefSource;
  /** Straight, a whole circle, part of a circle, some other curve (shown and snapped to its ends only), or a lone point. */
  kind: "line" | "circle" | "arc" | "curve" | "point";
  a: P2;
  b: P2;
  mid: P2;
  centre?: P2;
  radius?: number;
  /** An arc's ends, anticlockwise (start, end). */
  start?: P2;
  end?: P2;
  /** Other curves: points along it. */
  path?: P2[];
}

/** What the geometry engine found for a sketch's links on the latest rebuild. */
export interface SketchLinkInfo {
  /** Edges of the face the sketch is on (empty when it isn't on a part's face). */
  edges: RefEdge[];
  /** For each linked curve: where its edge (or other sketch's curve) is now, or null when it can't be found. */
  links: Record<string, RefEdge | null>;
  /** For each linked point: where it is now, or null when what it follows can't be found. Missing when there are none. */
  pointLinks?: Record<string, P2 | null>;
  /** The sketch's plane, moved to where its face is now (only when the face has moved). */
  plane?: SketchPlane;
  /** The face the sketch was put on can't be found any more. */
  faceLost?: boolean;
  /** The sketch as the engine used it (plane and data), when following the part changed it. */
  sketch?: { plane: SketchPlane; data: SketchData };
}

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function circleCentre(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/**
 * A part edge seen in a sketch: its ends, middle and (for round edges) centre
 * and radius, in sketch mm. Null when the edge isn't flat to the sketch (it
 * would be squashed seeing it end-on). `samples`: points along other curves.
 */
export function projectEdge(frame: PlaneFrame, pick: TopoPick, samples?: Vec3[]): RefEdge | null {
  const ref = pick.ref as EdgeRef;
  if (ref.kind !== "edge") return null;
  const height = (p: Vec3) => (p[0] - frame.origin[0]) * frame.n[0] + (p[1] - frame.origin[1]) * frame.n[1] + (p[2] - frame.origin[2]) * frame.n[2];
  const h0 = height(ref.mid);
  // Edge ends are kept to 0.1 µm, so on a sloping face they can be that far off the plane.
  if ([ref.a, ref.b, ...(samples ?? [])].some((p) => Math.abs(height(p) - h0) > 1e-3)) return null;
  const a = toSketch(frame, ref.a);
  const b = toSketch(frame, ref.b);
  const mid = toSketch(frame, ref.mid);
  if (ref.curve === "LINE") return dist(a, b) < 1e-6 ? null : { pick, kind: "line", a, b, mid };
  if (ref.curve === "CIRCLE") {
    const full = Math.hypot(ref.a[0] - ref.b[0], ref.a[1] - ref.b[1], ref.a[2] - ref.b[2]) < 1e-6;
    const centre = full ? ([(a[0] + mid[0]) / 2, (a[1] + mid[1]) / 2] as P2) : circleCentre(a, mid, b);
    if (!centre) return null;
    const radius = dist(a, centre);
    if (radius < 1e-6) return null;
    if (full) return { pick, kind: "circle", a, b, mid, centre, radius };
    const ang = (p: P2) => norm(Math.atan2(p[1] - centre[1], p[0] - centre[0]));
    const anticlockwise = norm(ang(mid) - ang(a)) < norm(ang(b) - ang(a));
    return { pick, kind: "arc", a, b, mid, centre, radius, start: anticlockwise ? a : b, end: anticlockwise ? b : a };
  }
  const path = samples?.length ? samples.map((p) => toSketch(frame, p)) : [a, mid, b];
  return { pick, kind: "curve", a, b, mid, path };
}

// ---------------------------------------------------------------------------
// Reference edges as stand-in sketch geometry (for drawing, hovering and snapping)

/** Ids of the stand-in geometry start with this; they're never stored in a sketch. */
export const REF_PREFIX = "ref:";
export const isRefId = (id: string) => id.startsWith(REF_PREFIX);

/** Which edge a stand-in id belongs to, and what part of it: an end (a, b), the centre (c), a point along a curve (q), or the edge itself. */
export function parseRefId(id: string): { index: number; what: "a" | "b" | "c" | "q" | "edge" } | null {
  const m = /^ref:(\d+)(?::([abcqs])\d*)?$/.exec(id);
  if (!m) return null;
  const what = m[2] === undefined || m[2] === "s" ? "edge" : (m[2] as "a" | "b" | "c" | "q");
  return { index: Number(m[1]), what };
}

/**
 * The reference edges as sketch geometry (ids "ref:<n>", its ends "ref:<n>:a"
 * and ":b", a round edge's centre ":c"), so they can be drawn, hovered and
 * snapped to like the sketch's own lines. A lone point is just "ref:<n>:a".
 * The same list always gives the same (shared) result, so the many references
 * of a busy design are only laid out once per rebuild.
 */
export function refSketch(edges: RefEdge[]): SketchData {
  const known = refSketchCache.get(edges);
  if (known) return known;
  const out = refSketchOf(edges, edges.map((_, i) => i));
  refSketchCache.set(edges, out);
  return out;
}

/** Just some of the references as stand-in geometry (for those near the pointer); ids keep their place in the whole list. */
export function refSketchOf(edges: RefEdge[], indices: number[]): SketchData {
  const points: SketchPoint[] = [];
  const curves: SketchCurve[] = [];
  for (const i of indices) {
    const e = edges[i];
    if (!e) continue;
    const id = `${REF_PREFIX}${i}`;
    const pt = (suffix: string, p: P2) => {
      points.push({ id: `${id}:${suffix}`, x: p[0], y: p[1] });
      return `${id}:${suffix}`;
    };
    if (e.kind === "point") pt("a", e.a);
    else if (e.kind === "line") curves.push({ id, type: "line", p1: pt("a", e.a), p2: pt("b", e.b), construction: false });
    else if (e.kind === "circle") curves.push({ id, type: "circle", center: pt("c", e.centre!), radius: e.radius!, construction: false });
    else if (e.kind === "arc") {
      const startIsA = dist(e.start!, e.a) < 1e-9;
      const a = pt("a", e.a), b = pt("b", e.b);
      curves.push({ id, type: "arc", center: pt("c", e.centre!), start: startIsA ? a : b, end: startIsA ? b : a, construction: false });
    } else {
      const path = e.path ?? [e.a, e.mid, e.b];
      const ids = path.map((p, k) => (k === 0 ? pt("a", p) : k === path.length - 1 ? pt("b", p) : pt(`q${k}`, p)));
      for (let k = 0; k + 1 < ids.length; k++) curves.push({ id: `${id}:s${k}`, type: "line", p1: ids[k], p2: ids[k + 1], construction: false });
      // A circle seen at a slant: its centre can be snapped to.
      if (e.centre) pt("c", e.centre);
    }
  }
  return { points, curves, constraints: [] };
}
const refSketchCache = new WeakMap<RefEdge[], SketchData>();

// ---------------------------------------------------------------------------
// Copying an edge in, linked

/** The face's own edges: snapping to one of their corners brings in the whole edge (as before other references existed). */
export const isFaceEdge = (e: RefEdge) => !!e.pick && !e.project && !e.source;

/** What a curve copied from this reference follows. */
function refLink(e: RefEdge): CurveLink | null {
  if (e.source) return { sketch: e.source.sketch, item: e.source.item };
  if (e.pick) return { partId: e.pick.partId, ref: e.pick.ref, ...(e.project ? { project: true as const } : {}) };
  return null;
}

/** Whether two links follow the same thing (an Intersect's cut is told apart by where it is, as before). */
function sameLink(a: CurveLink, b: CurveLink): boolean {
  if (isPartLink(a) && isPartLink(b)) return a.partId === b.partId && !!a.project === !!b.project && sameRef(a.ref, b.ref);
  if (!isPartLink(a) && !isPartLink(b)) return a.sketch === b.sketch && a.item === b.item;
  return false;
}

/** The sketch curve already following this reference, if any. */
export function linkedCurveFor(s: SketchData, edge: RefEdge): SketchCurve | undefined {
  const want = refLink(edge);
  if (!want) return undefined;
  return s.curves.find((c) => "link" in c && c.link && sameLink(c.link, want));
}

/** Why a reference from a later sketch can't be used, in plain English. */
export function laterMessage(e: RefEdge): string {
  const name = e.source?.name ? `"${e.source.name}"` : "That sketch";
  return `${name} comes after this sketch in the feature list, so this sketch can't use it (they'd depend on each other). Drag this sketch below it in the feature list first.`;
}

/** The points of a linked curve that sit on its edge's ends (a, b) and centre (c). */
function pointsOn(s: SketchData, c: SketchCurve, e: RefEdge): { a?: string; b?: string; c?: string } {
  if (c.type === "line") {
    const p1 = pointPos(s, c.p1);
    return dist(p1, e.a) <= dist(p1, e.b) ? { a: c.p1, b: c.p2 } : { a: c.p2, b: c.p1 };
  }
  if (c.type === "circle") return { c: c.center };
  if (c.type === "arc") {
    const st = pointPos(s, c.start);
    return dist(st, e.a) <= dist(st, e.b) ? { a: c.start, b: c.end, c: c.center } : { a: c.end, b: c.start, c: c.center };
  }
  return {};
}

const fixAt = (id: string, p: P2): SketchConstraint => ({ id: sketchId("c"), type: "fix", refs: [id], extra: [p[0], p[1]] });

/**
 * Bring a reference into the sketch, following what it came from: as a
 * reference (construction) for snapping and dimensioning, or as real geometry
 * ("Use"). One already in the sketch is reused (and made real if asked).
 * Returns the curve and the points on its ends and centre.
 */
export function linkEdge(
  s: SketchData,
  edge: RefEdge,
  construction: boolean,
  cut?: { face?: FaceRef },
): EditResult & { curveId: string; points: { a?: string; b?: string; c?: string } } {
  if (edge.source?.later) return { sketch: s, curveId: "", points: {}, error: laterMessage(edge) };
  const known = linkedCurveFor(s, edge);
  if (known) {
    const sketch = !construction && known.construction ? { ...s, curves: s.curves.map((c) => (c === known ? { ...c, construction: false } : c)) } : s;
    return { sketch, curveId: known.id, points: pointsOn(s, known, edge) };
  }
  if (edge.kind === "point") return { sketch: s, curveId: "", points: {}, error: "That's a single point: snap to it, or click it to dimension to it." };
  if (edge.kind === "curve") return { sketch: s, curveId: "", points: {}, error: "Only straight and round edges can be used in a sketch for now. Snap to its ends instead." };
  const base = refLink(edge);
  if (!base) return { sketch: s, curveId: "", points: {}, error: "That can't be used here." };
  const link: CurveLink = cut && isPartLink(base) ? { ...base, cut } : base;
  const pt = (p: P2): SketchPoint => ({ id: sketchId("p"), x: p[0], y: p[1] });
  const points: SketchPoint[] = [];
  const constraints: SketchConstraint[] = [];
  let curve: SketchCurve;
  let ids: { a?: string; b?: string; c?: string };
  if (edge.kind === "line") {
    const [pa, pb] = [pt(edge.a), pt(edge.b)];
    points.push(pa, pb);
    constraints.push(fixAt(pa.id, edge.a), fixAt(pb.id, edge.b));
    curve = { id: sketchId("l"), type: "line", p1: pa.id, p2: pb.id, construction, link } satisfies SketchLine;
    ids = { a: pa.id, b: pb.id };
  } else if (edge.kind === "circle") {
    const c = pt(edge.centre!);
    // A point on the rim holds the size (it's fixed too).
    const rim = pt([edge.centre![0] + edge.radius!, edge.centre![1]]);
    const id = sketchId("k");
    points.push(c, rim);
    constraints.push(fixAt(c.id, edge.centre!), fixAt(rim.id, [rim.x, rim.y]), { id: sketchId("c"), type: "pointOnCircle", refs: [rim.id, id] });
    curve = { id, type: "circle", center: c.id, radius: edge.radius!, construction, link } satisfies SketchCircle;
    ids = { c: c.id };
  } else {
    const c = pt(edge.centre!);
    const [pa, pb] = [pt(edge.a), pt(edge.b)];
    points.push(c, pa, pb);
    constraints.push(fixAt(c.id, edge.centre!), fixAt(pa.id, edge.a), fixAt(pb.id, edge.b));
    const startIsA = dist(edge.start!, edge.a) < 1e-9;
    curve = { id: sketchId("a"), type: "arc", center: c.id, start: startIsA ? pa.id : pb.id, end: startIsA ? pb.id : pa.id, construction, link } satisfies SketchArc;
    ids = { a: pa.id, b: pb.id, c: c.id };
  }
  const r = settle({ ...s, points: [...s.points, ...points], curves: [...s.curves, curve], constraints: [...s.constraints, ...constraints] });
  return { ...r, curveId: curve.id, points: ids };
}

/** Where a reference's end (a, b), middle or centre is in the sketch. */
export function refPointAt(e: RefEdge, at: "a" | "b" | "centre" | "mid"): P2 | null {
  if (at === "a") return e.a;
  if (at === "b") return e.b;
  if (at === "centre") return e.centre ?? null;
  return e.kind === "line" ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] : e.mid;
}

/** What a point brought in from this reference's end, middle or centre follows (null: there's nothing there to follow). */
export function pointLinkOf(e: RefEdge, at: "a" | "b" | "centre" | "mid"): PointLink | null {
  if (e.source) {
    if (at === "mid") return e.kind === "line" ? { sketch: e.source.sketch, item: e.source.item, end: "mid" } : null;
    const id = e.source.ends?.[at === "centre" ? "c" : at];
    return id ? { sketch: e.source.sketch, item: id } : null;
  }
  if (e.pick?.ref.kind === "edge") {
    if (at === "centre" && e.pick.ref.curve !== "CIRCLE") return null;
    return { partId: e.pick.partId, ref: e.pick.ref, end: at };
  }
  return null;
}

function samePointLink(a: PointLink, b: PointLink): boolean {
  if ("partId" in a && "partId" in b) return a.partId === b.partId && a.end === b.end && sameRef(a.ref, b.ref);
  if (!("partId" in a) && !("partId" in b)) return a.sketch === b.sketch && a.item === b.item && (a.end ?? "") === (b.end ?? "");
  return false;
}

/**
 * Bring in one point of a reference (an end, its middle or its centre) as a
 * fixed construction point that follows it. One already in the sketch is reused.
 */
export function linkPoint(s: SketchData, e: RefEdge, at: "a" | "b" | "centre" | "mid"): EditResult & { pointId: string } {
  if (e.source?.later) return { sketch: s, pointId: "", error: laterMessage(e) };
  const link = pointLinkOf(e, at);
  const p = refPointAt(e, at);
  if (!link || !p) return { sketch: s, pointId: "", error: "That point can't be used here. Snap to an end or a centre instead." };
  const known = s.points.find((q) => q.link && samePointLink(q.link, link));
  if (known) return { sketch: s, pointId: known.id };
  const id = sketchId("p");
  const r = settle({ ...s, points: [...s.points, { id, x: p[0], y: p[1], link }], constraints: [...s.constraints, fixAt(id, p)] });
  return { ...r, pointId: id };
}

/** Use every edge of the face (as real geometry). Edges that can't be used are skipped. */
export function linkAllEdges(s: SketchData, edges: RefEdge[]): EditResult & { curveIds: string[] } {
  let sketch = s;
  const curveIds: string[] = [];
  for (const e of edges) {
    const r = linkEdge(sketch, e, false);
    if (r.error) continue;
    sketch = r.sketch;
    curveIds.push(r.curveId);
  }
  if (!curveIds.length) return { sketch: s, curveIds, error: "None of this face's edges can be used (only straight and round edges can)." };
  // Edges meeting at a corner share the corner point, so the outline is closed and can be extruded.
  return { sketch: joinTouchingEnds(sketch, curveIds), curveIds };
}

/** Merge the end points of these curves that sit on top of each other (all fixed in the same place). */
function joinTouchingEnds(s: SketchData, curveIds: string[]): SketchData {
  const ids = new Set(curveIds);
  const ends: string[] = [];
  for (const c of s.curves) {
    if (!ids.has(c.id)) continue;
    if (c.type === "line") ends.push(c.p1, c.p2);
    else if (c.type === "arc") ends.push(c.start, c.end);
  }
  const keep = new Map<string, string>();
  const kept: string[] = [];
  for (const id of ends) {
    if (keep.has(id)) continue;
    const p = pointPos(s, id);
    const same = kept.find((k) => dist(pointPos(s, k), p) < 1e-6);
    keep.set(id, same ?? id);
    if (!same) kept.push(id);
  }
  const to = (id: string) => keep.get(id) ?? id;
  const gone = new Set([...keep].filter(([a, b]) => a !== b).map(([a]) => a));
  if (!gone.size) return s;
  return {
    ...s,
    points: s.points.filter((p) => !gone.has(p.id)),
    curves: s.curves.map((c) => (c.type === "line" ? { ...c, p1: to(c.p1), p2: to(c.p2) } : c.type === "arc" ? { ...c, start: to(c.start), end: to(c.end) } : c)),
    // The merged points' own fixes go (the kept point is fixed in the same place).
    constraints: s.constraints.filter((k) => !(k.type === "fix" && gone.has(k.refs[0]))),
  };
}

// ---------------------------------------------------------------------------
// Following the part (and other sketches)

/** Points of linked curves, and linked points (their fixes are part of the link, so they're not shown as anchors). */
export function linkedPoints(s: SketchData): Set<string> {
  const out = new Set<string>();
  for (const p of s.points) if (p.link) out.add(p.id);
  for (const c of s.curves) {
    if (!("link" in c) || !c.link) continue;
    if (c.type === "line") out.add(c.p1).add(c.p2);
    else if (c.type === "circle") {
      out.add(c.center);
      for (const k of s.constraints) if (k.type === "pointOnCircle" && k.refs[1] === c.id) out.add(k.refs[0]);
    } else if (c.type === "arc") out.add(c.center).add(c.start).add(c.end);
  }
  return out;
}

/**
 * Move each linked curve to where its edge is now (`links`: from the
 * geometry engine; null = the edge has gone, so the curve stays put), and
 * each linked point to where it is now (`points`), and re-solve, so anything
 * constrained to them follows. Returns the same sketch when nothing moved.
 */
export function followLinks(s: SketchData, links: Record<string, RefEdge | null | undefined>, points: Record<string, P2 | null | undefined> = {}): SketchData {
  const moves = new Map<string, P2>();
  const radii = new Map<string, number>();
  for (const p of s.points) {
    const to = p.link ? points[p.id] : undefined;
    if (to) moves.set(p.id, to);
  }
  for (const c of s.curves) {
    if (!("link" in c) || !c.link) continue;
    const e = links[c.id];
    if (!e) continue;
    if (c.type === "line" && e.kind === "line") {
      // Keep the line running the same way.
      const was = sub(pointPos(s, c.p2), pointPos(s, c.p1));
      const now = sub(e.b, e.a);
      const same = was[0] * now[0] + was[1] * now[1] >= 0;
      moves.set(c.p1, same ? e.a : e.b);
      moves.set(c.p2, same ? e.b : e.a);
    } else if (c.type === "circle" && e.kind === "circle") {
      const oldC = pointPos(s, c.center);
      moves.set(c.center, e.centre!);
      radii.set(c.id, e.radius!);
      for (const k of s.constraints) {
        if (k.type !== "pointOnCircle" || k.refs[1] !== c.id) continue;
        const rim = pointPos(s, k.refs[0]);
        const ang = Math.atan2(rim[1] - oldC[1], rim[0] - oldC[0]);
        moves.set(k.refs[0], [e.centre![0] + e.radius! * Math.cos(ang), e.centre![1] + e.radius! * Math.sin(ang)]);
      }
    } else if (c.type === "arc" && e.kind === "arc") {
      moves.set(c.center, e.centre!);
      moves.set(c.start, e.start!);
      moves.set(c.end, e.end!);
    }
  }
  let moved = false;
  for (const [id, p] of moves) if (dist(pointPos(s, id), p) > 1e-9) moved = true;
  for (const c of s.curves) if (c.type === "circle" && radii.has(c.id) && Math.abs(radii.get(c.id)! - c.radius) > 1e-9) moved = true;
  if (!moved) return s;
  const data: SketchData = {
    // Texts and pictures (and anything else the sketch holds) stay as they are.
    ...s,
    points: s.points.map((p) => {
      const to = moves.get(p.id);
      return to ? { ...p, x: to[0], y: to[1] } : p;
    }),
    curves: s.curves.map((c) => (c.type === "circle" && radii.has(c.id) ? { ...c, radius: radii.get(c.id)! } : c)),
    constraints: s.constraints.map((k) => {
      const to = k.type === "fix" ? moves.get(k.refs[0]) : undefined;
      return to ? { ...k, extra: [to[0], to[1]] } : k;
    }),
  };
  return settle(data).sketch;
}

/** How many references can't be found, by where they come from: parts (edges and their points) and other sketches. */
function lostCounts(s: SketchData | undefined, info: SketchLinkInfo): { part: number; sketch: number } {
  let part = 0, sketch = 0;
  const fromSketch = new Set<string>();
  if (s) {
    for (const c of s.curves) if ("link" in c && c.link && !isPartLink(c.link)) fromSketch.add(c.id);
    for (const p of s.points) if (p.link && !("partId" in p.link)) fromSketch.add(p.id);
  }
  for (const [id, e] of [...Object.entries(info.links), ...Object.entries(info.pointLinks ?? {})]) {
    if (e !== null) continue;
    if (fromSketch.has(id)) sketch++;
    else part++;
  }
  return { part, sketch };
}

const fromSketchesNote = (n: number) =>
  `${n === 1 ? "1 thing" : `${n} things`} this sketch takes from other sketches can't be found any more (that sketch, or the shape in it, was deleted or turned off, or moved below this one in the feature list), so ${n === 1 ? "its copy stays" : "their copies stay"} where ${n === 1 ? "it was" : "they were"}.`;

/** A plain-English note about linked edges that can't be found, or null when all is well. */
export function lostLinksMessage(s: SketchData, info: SketchLinkInfo | undefined): string | null {
  if (!info) return null;
  const lost = lostCounts(s, info);
  const parts: string[] = [];
  if (info.faceLost) parts.push("The face this sketch is on can't be found on the part any more, so its edges aren't shown and the sketch stays where it was. Pick the face again to put it back on the part.");
  if (lost.part)
    parts.push(
      `${lost.part === 1 ? "1 edge" : `${lost.part} edges`} this sketch uses ${lost.part === 1 ? "has" : "have"} gone from the part, so ${lost.part === 1 ? "it stays" : "they stay"} where ${lost.part === 1 ? "it was" : "they were"}. Delete ${lost.part === 1 ? "it" : "them"}, or use another edge.`,
    );
  if (lost.sketch) parts.push(`${fromSketchesNote(lost.sketch)} Delete ${lost.sketch === 1 ? "it" : "them"}, or move that sketch back above this one.`);
  return parts.length ? parts.join(" ") : null;
}

/** Ids of the sketch's curves and points whose references can't be found (to select them). */
export function lostLinkIds(s: SketchData, info: SketchLinkInfo | undefined): string[] {
  if (!info) return [];
  return [
    ...s.curves.filter((c) => "link" in c && c.link && info.links[c.id] === null).map((c) => c.id),
    ...s.points.filter((p) => p.link && info.pointLinks?.[p.id] === null).map((p) => p.id),
  ];
}

/** What to say on the sketch in the feature list when its face or edges can't be found, or null. */
export function linkProblem(info: SketchLinkInfo | undefined, s?: SketchData): string | null {
  if (!info) return null;
  const lost = lostCounts(s, info);
  if (info.faceLost)
    return "The face this sketch was on can't be found any more (the part has changed too much), so the sketch stays where it was. Edit the sketch and click Pick the face again.";
  if (lost.part)
    return `${lost.part === 1 ? "A part edge" : `${lost.part} part edges`} this sketch uses can't be found any more, so ${lost.part === 1 ? "its copy stays" : "their copies stay"} where ${lost.part === 1 ? "it was" : "they were"}. Edit the sketch and delete ${lost.part === 1 ? "it" : "them"} (shown in the sketch panel), or use other edges.`;
  if (lost.sketch) return `${fromSketchesNote(lost.sketch)} Edit the sketch and delete ${lost.sketch === 1 ? "it" : "them"} (shown in the sketch panel), or move that sketch back above this one.`;
  return null;
}

/**
 * Drop references brought in only to snap or measure to (construction lines,
 * circles and arcs following an edge or another sketch, and points following
 * something) that nothing uses: no other line, arc or circle shares their
 * points and no constraint or dimension refers to them, apart from those
 * holding them in place. Returns the same sketch when there's nothing to drop.
 */
export function pruneReferences(s: SketchData): SketchData {
  const gone = new Set<string>();
  for (const c of s.curves) {
    // Intersect's curves were asked for, so they stay.
    if (!("link" in c) || !c.link || !c.construction || (isPartLink(c.link) && c.link.cut)) continue;
    const own = new Set<string>(c.type === "line" ? [c.p1, c.p2] : c.type === "circle" ? [c.center] : c.type === "arc" ? [c.center, c.start, c.end] : []);
    // A circle's rim point holds its size: it's its own.
    for (const k of s.constraints) if (k.type === "pointOnCircle" && k.refs[1] === c.id && k.refs.length === 2) own.add(k.refs[0]);
    const holding = (k: SketchConstraint) => (k.type === "fix" && own.has(k.refs[0])) || (k.type === "pointOnCircle" && k.refs[1] === c.id && own.has(k.refs[0]));
    const usedByConstraint = s.constraints.some((k) => !holding(k) && k.refs.some((r) => r === c.id || own.has(r)));
    const sharesPoint = s.curves.some((o) => o !== c && curvePointsOf(o).some((p) => own.has(p)));
    if (!usedByConstraint && !sharesPoint) gone.add(c.id);
  }
  // Points brought in on their own: kept when a curve, a constraint (besides their own fix) or a text uses them, or they were placed as points.
  const goneLonePoints = new Set<string>();
  for (const p of s.points) {
    if (!p.link || p.standalone) continue;
    const onCurve = s.curves.some((c) => curvePointsOf(c).includes(p.id));
    const usedByConstraint = s.constraints.some((k) => !(k.type === "fix" && k.refs[0] === p.id) && k.refs.includes(p.id));
    const anchors = (s.texts ?? []).some((t) => t.anchor === p.id);
    if (!onCurve && !usedByConstraint && !anchors) goneLonePoints.add(p.id);
  }
  if (!gone.size && !goneLonePoints.size) return s;
  const curves = s.curves.filter((c) => !gone.has(c.id));
  const kept = new Set(curves.flatMap(curvePointsOf));
  const points = gone.size
    ? s.points.filter(
        (p) =>
          !goneLonePoints.has(p.id) &&
          (kept.has(p.id) || (p.standalone && !s.constraints.some((k) => k.type === "pointOnCircle" && gone.has(k.refs[1]) && k.refs[0] === p.id)) || !!p.link),
      )
    : s.points.filter((p) => !goneLonePoints.has(p.id));
  const alive = new Set(["origin", ...points.map((p) => p.id), ...curves.map((c) => c.id)]);
  return { ...s, points, curves, constraints: s.constraints.filter((k) => k.refs.every((r) => alive.has(r))) };
}

const curvePointsOf = (c: SketchCurve): string[] =>
  c.type === "line" ? [c.p1, c.p2] : c.type === "circle" ? [c.center] : c.type === "spline" ? c.points : c.type === "ellipse" ? [c.center, c.major, c.minor, ...(c.start && c.end ? [c.start, c.end] : [])] : [c.center, c.start, c.end];
