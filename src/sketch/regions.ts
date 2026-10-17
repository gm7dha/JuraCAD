/**
 * Finds the closed shapes in a sketch, ready to extrude.
 *
 * Solid (non-construction) lines and arcs are joined end to end into loops;
 * circles are loops on their own. A loop inside another loop becomes a hole;
 * a loop inside a hole becomes an island, and so on (even–odd nesting).
 *
 * Shapes that cross each other aren't split up yet — the loops should touch
 * only at their ends (the normal case for hobby parts).
 */
import { ellipseFrom, ellipsePolyline } from "./ellipse";
import { splineBeziers, splinePolyline } from "./spline";
import { ORIGIN_ID, type SketchCurve, type SketchData } from "./types";
import { splineHandles } from "./ops";

export type Pt = [number, number];

/** One piece of a loop's outline, in order around the loop. */
export type Segment =
  | { kind: "line"; from: Pt; to: Pt }
  | { kind: "arc"; from: Pt; mid: Pt; to: Pt }
  | { kind: "circle"; center: Pt; radius: number }
  /** A piece of a spline: a cubic Bézier curve. */
  | { kind: "bezier"; from: Pt; c1: Pt; c2: Pt; to: Pt }
  /** A whole ellipse: half-lengths along its turned x and y axes. */
  | { kind: "ellipse"; center: Pt; rx: number; ry: number; angle: number };

export interface Loop {
  segments: Segment[];
  /** Polygon approximation (anticlockwise), for area and inside tests. */
  polygon: Pt[];
  area: number;
}

/** An outer loop and the loops cut out of it. */
export interface Region {
  outer: Loop;
  holes: Loop[];
}

export interface RegionResult {
  regions: Region[];
  /** Plain-English notes about shapes that couldn't be used. */
  problems: string[];
}

const pointsById = (s: SketchData) => {
  const m = new Map<string, Pt>(s.points.map((p) => [p.id, [p.x, p.y]]));
  m.set(ORIGIN_ID, [0, 0]);
  return m;
};

function arcGeometry(center: Pt, start: Pt, end: Pt) {
  const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  while (a1 <= a0) a1 += 2 * Math.PI;
  return { r, a0, a1 };
}

/** Sample points along a curve from one end to the other (excluding the final point). */
function sampleArc(center: Pt, r: number, from: number, to: number, out: Pt[]) {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) / (Math.PI / 36)));
  for (let i = 0; i < steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function makeLoop(segments: Segment[], polygon: Pt[]): Loop {
  let area = signedArea(polygon);
  if (area < 0) {
    polygon.reverse();
    area = -area;
  }
  return { segments, polygon, area };
}

/** The sketch's curves as a graph: the standalone closed curves, and the end-to-end curves between shared points. */
function sketchGraph(sketch: SketchData) {
  const pts = pointsById(sketch);
  const loops: Loop[] = [];
  const solid = sketch.curves.filter((c) => !c.construction);

  // Circles are complete loops by themselves.
  for (const c of solid) {
    if (c.type !== "circle") continue;
    const center = pts.get(c.center)!;
    if (c.radius <= 1e-9) continue;
    const poly: Pt[] = [];
    sampleArc(center, c.radius, 0, 2 * Math.PI, poly);
    loops.push(makeLoop([{ kind: "circle", center, radius: c.radius }], poly));
  }

  // So are ellipses.
  for (const c of solid) {
    if (c.type !== "ellipse") continue;
    const g = ellipseFrom(pts.get(c.center)!, pts.get(c.major)!, pts.get(c.minor)!);
    if (g.rx <= 1e-9 || g.ry <= 1e-9) continue;
    loops.push(makeLoop([{ kind: "ellipse", center: g.centre, rx: g.rx, ry: g.ry, angle: g.angle }], ellipsePolyline(g).slice(0, -1)));
  }

  // Closed splines are complete loops by themselves too.
  for (const c of solid) {
    if (c.type !== "spline" || !c.closed || c.points.length < 3) continue;
    const ps = c.points.map((id) => pts.get(id)!);
    const hs = splineHandles(c);
    const segs: Segment[] = splineBeziers(ps, true, undefined, hs).map(([from, c1, c2, to]) => ({ kind: "bezier", from, c1, c2, to }));
    loops.push(makeLoop(segs, splinePolyline(ps, true, undefined, undefined, hs)));
  }

  // Join lines, arcs and open splines at shared end points (merged by position, so separate
  // but coincident points count as joined).
  const ends = solid.filter(
    (c): c is Exclude<SketchCurve, { type: "circle" | "ellipse" }> =>
      c.type !== "circle" && c.type !== "ellipse" && !(c.type === "spline" && (c.closed || c.points.length < 2)),
  );
  const keyOf = (p: Pt) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const nodeOf = new Map<string, number>();
  const nodePos: Pt[] = [];
  const node = (p: Pt) => {
    const k = keyOf(p);
    let i = nodeOf.get(k);
    if (i === undefined) {
      i = nodePos.length;
      nodeOf.set(k, i);
      nodePos.push(p);
    }
    return i;
  };
  interface GraphEdge {
    curve: (typeof ends)[number];
    a: number;
    b: number;
  }
  const edges: GraphEdge[] = [];
  for (const c of ends) {
    const [p, q] =
      c.type === "line"
        ? [pts.get(c.p1)!, pts.get(c.p2)!]
        : c.type === "spline"
          ? [pts.get(c.points[0])!, pts.get(c.points[c.points.length - 1])!]
          : [pts.get(c.start)!, pts.get(c.end)!];
    const a = node(p);
    const b = node(q);
    if (a === b) continue; // zero-length
    edges.push({ curve: c, a, b });
  }
  const adjacency = new Map<number, number[]>();
  edges.forEach((e, i) => {
    for (const n of [e.a, e.b]) adjacency.set(n, [...(adjacency.get(n) ?? []), i]);
  });

  /** One curve walked from node `at`: its pieces and polygon points (the polygon leaves out the end point). */
  const walkEdge = (ei: number, at: number): { segments: Segment[]; polygon: Pt[]; next: number } => {
    const e = edges[ei];
    const forward = e.a === at;
    const next = forward ? e.b : e.a;
    const from = nodePos[at];
    const to = nodePos[next];
    const segments: Segment[] = [];
    const polygon: Pt[] = [];
    if (e.curve.type === "line") {
      segments.push({ kind: "line", from, to });
      polygon.push(from);
    } else if (e.curve.type === "spline") {
      // Its pieces, the other way round when walking it backwards.
      const ps = e.curve.points.map((id) => pts.get(id)!);
      // Walked backwards, each handle points the other way too.
      const hs = splineHandles(e.curve).map((h) => (h && !forward ? ([-h[0], -h[1]] as [number, number]) : h));
      const pieces = splineBeziers(forward ? ps : [...ps].reverse(), false, e.curve.conic, forward ? hs : [...hs].reverse());
      for (const [f, c1, c2, t] of pieces) segments.push({ kind: "bezier", from: f, c1, c2, to: t });
      polygon.push(...splinePolyline(forward ? ps : [...ps].reverse(), false, undefined, e.curve.conic, forward ? hs : [...hs].reverse()).slice(0, -1));
    } else {
      const center = pts.get(e.curve.center)!;
      const s = pts.get(e.curve.start)!;
      const en = pts.get(e.curve.end)!;
      const { r, a0, a1 } = arcGeometry(center, s, en);
      const midA = (a0 + a1) / 2;
      const mid: Pt = [center[0] + r * Math.cos(midA), center[1] + r * Math.sin(midA)];
      segments.push({ kind: "arc", from, mid, to });
      if (forward) sampleArc(center, r, a0, a1, polygon);
      else sampleArc(center, r, a1, a0, polygon);
    }
    return { segments, polygon, next };
  };

  // The connected groups of curves: closed rings, open runs, or branching (a junction of three or more).
  const usedEdge = new Array<boolean>(edges.length).fill(false);
  const groups: { edges: number[]; kind: "closed" | "open" | "branching" }[] = [];
  for (let start = 0; start < edges.length; start++) {
    if (usedEdge[start]) continue;
    const group: number[] = [];
    const stack = [start];
    usedEdge[start] = true;
    while (stack.length) {
      const ei = stack.pop()!;
      group.push(ei);
      for (const n of [edges[ei].a, edges[ei].b]) {
        for (const nb of adjacency.get(n) ?? []) {
          if (!usedEdge[nb]) {
            usedEdge[nb] = true;
            stack.push(nb);
          }
        }
      }
    }
    const nodes = new Set(group.flatMap((ei) => [edges[ei].a, edges[ei].b]));
    const degrees = [...nodes].map((n) => (adjacency.get(n) ?? []).length);
    groups.push({ edges: group, kind: degrees.some((d) => d > 2) ? "branching" : degrees.some((d) => d < 2) ? "open" : "closed" });
  }

  /** Walk a ring or run from `at` along its curves, in order. */
  const walk = (group: number[], first: number, at: number): { segments: Segment[]; polygon: Pt[] } => {
    const segments: Segment[] = [];
    const polygon: Pt[] = [];
    const visited = new Set<number>();
    let current = first;
    while (!visited.has(current)) {
      visited.add(current);
      const step = walkEdge(current, at);
      segments.push(...step.segments);
      polygon.push(...step.polygon);
      at = step.next;
      const after = (adjacency.get(at) ?? []).find((ei) => ei !== current && !visited.has(ei) && group.includes(ei));
      if (after === undefined) break;
      current = after;
    }
    return { segments, polygon, end: nodePos[at] } as { segments: Segment[]; polygon: Pt[] } & { end: Pt };
  };

  return { loops, edges, nodePos, adjacency, groups, walk };
}

/** A run of curves joined end to end: a closed ring, or open with two free ends. */
export interface Chain {
  segments: Segment[];
  closed: boolean;
}

/**
 * Every run of the sketch's (non-construction) curves, closed or open, each
 * walked in order — for surfaces, which can be made from open outlines too.
 * Runs with a junction of three or more curves are left out.
 */
export function findChains(sketch: SketchData): { chains: Chain[]; problems: string[] } {
  const g = sketchGraph(sketch);
  const chains: Chain[] = g.loops.map((l) => ({ segments: l.segments, closed: true }));
  let branching = 0;
  for (const group of g.groups) {
    if (group.kind === "branching") {
      branching++;
      continue;
    }
    const first = group.kind === "open" ? group.edges.find((ei) => [g.edges[ei].a, g.edges[ei].b].some((n) => (g.adjacency.get(n) ?? []).length === 1))! : group.edges[0];
    const e = g.edges[first];
    const at = group.kind === "open" && (g.adjacency.get(e.b) ?? []).length === 1 ? e.b : e.a;
    const { segments } = g.walk(group.edges, first, at);
    chains.push({ segments, closed: group.kind === "closed" });
  }
  const problems: string[] = [];
  if (branching) problems.push(`${branching} shape${branching > 1 ? "s have" : " has"} lines meeting at a junction, so ${branching > 1 ? "they were" : "it was"} left out.`);
  return { chains, problems };
}

export function findRegions(sketch: SketchData): RegionResult {
  const g = sketchGraph(sketch);
  const problems: string[] = [];
  const loops: Loop[] = [...g.loops];
  let openShapes = 0;
  let branching = 0;
  for (const group of g.groups) {
    if (group.kind === "branching") {
      branching++;
      continue;
    }
    if (group.kind === "open") {
      openShapes++;
      continue;
    }
    const { segments, polygon } = g.walk(group.edges, group.edges[0], g.edges[group.edges[0]].a);
    const loop = makeLoop(segments, polygon);
    if (loop.area > 1e-9) loops.push(loop);
  }

  if (openShapes) problems.push(`${openShapes} shape${openShapes > 1 ? "s aren't" : " isn't"} closed, so ${openShapes > 1 ? "they were" : "it was"} left out.`);
  if (branching) problems.push(`${branching} shape${branching > 1 ? "s have" : " has"} lines meeting at a junction, so ${branching > 1 ? "they were" : "it was"} left out.`);

  // Nesting: how many other loops contain each loop.
  const depth = loops.map((l, i) =>
    loops.reduce((d, other, j) => (j !== i && other.area > l.area && pointInPolygon(l.polygon[0], other.polygon) ? d + 1 : d), 0),
  );
  const regions: Region[] = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2 !== 0) return;
    const holes = loops.filter(
      (l, j) => depth[j] === depth[i] + 1 && l.area < outer.area && pointInPolygon(l.polygon[0], outer.polygon),
    );
    regions.push({ outer, holes });
  });
  return { regions, problems };
}
