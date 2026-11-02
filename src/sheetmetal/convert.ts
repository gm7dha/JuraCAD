/**
 * Sheet metal from a solid (Onshape's Sheet metal model › Convert): flat faces
 * of a part picked as the sheet's walls. Where two walls meet along a straight
 * edge there's a bend; edges picked as rips are left open (a small gap) so the
 * sheet can be unfolded.
 *
 * The result is an ordinary sheet (see sheet.ts): the first face picked is the
 * base wall and every other wall a flange (`FlangeSpec.shape`: the wall's own
 * outline) bent off the wall it joins, so the folded part, the flat pattern
 * and later flanges work as for any sheet.
 *
 * The picked faces are one side of the metal; it goes into the part from them
 * (or, flipped, out of it). Each wall is cut back from the edge where it meets
 * another by the bend's setback, so the bend's face on that side meets both
 * picked faces smoothly. At a rip one wall runs to the edge and the other
 * stops short of it, `gap` clear.
 */
import type { Segment } from "../sketch/regions";
import { anticlockwise, foldSheet, outlinePoints, wallPoint, type FlangeSpec, type Frame3, type P2, type SheetSpec, type V3 } from "./sheet";

/** One edge of a face: its points from end to end (just the two ends for a straight edge; samples along a curve). */
export interface SolidEdge {
  curve: "LINE" | "CIRCLE" | "OTHER";
  pts: V3[];
}

export interface SolidFace {
  /** A flat face (anything else is refused). */
  flat: boolean;
  /** Pointing out of the part. */
  normal: V3;
  /** The edges round its outside, and round each hole, in any order. */
  outer: SolidEdge[];
  holes: SolidEdge[][];
}

export interface ConvertOptions {
  thickness: number;
  radius: number;
  k: number;
  /** The gap left at rips (mm). */
  gap: number;
  /** The metal goes out of the part from the faces (they become its inside) instead of into it. */
  flip?: boolean;
  /** The feature's id: the walls are flanges "<id>:w<n>" (n = which face, from 0). */
  idPrefix: string;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const dist = (a: V3, b: V3) => len(sub(a, b));
const round2 = (x: number) => Math.round(x * 100) / 100;
const ordinal = (i: number) => {
  const n = i + 1;
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `the ${n}${s} face picked`;
};

/** Edges joined end to end into one loop (each turned to run on from the one before), or null if they don't. */
export function chainEdges(edges: SolidEdge[], tol: number): SolidEdge[] | null {
  if (!edges.length) return null;
  const left = edges.slice(1);
  const out: SolidEdge[] = [edges[0]];
  for (;;) {
    const end = out[out.length - 1].pts[out[out.length - 1].pts.length - 1];
    if (!left.length) return dist(end, out[0].pts[0]) <= tol ? out : null;
    const i = left.findIndex((e) => dist(e.pts[0], end) <= tol || dist(e.pts[e.pts.length - 1], end) <= tol);
    if (i < 0) return null;
    const [e] = left.splice(i, 1);
    out.push(dist(e.pts[0], end) <= tol ? e : { ...e, pts: [...e.pts].reverse() });
  }
}

/** A loop's edges as outline pieces in a face's flat coordinates, and which edge each piece came from. */
function loopSegments(loop: SolidEdge[], to2: (p: V3) => P2, tol: number): { segs: Segment[]; from: number[] } {
  const segs: Segment[] = [];
  const from: number[] = [];
  loop.forEach((e, i) => {
    const pts = e.pts.map(to2);
    const closed = e.pts.length > 2 && dist(e.pts[0], e.pts[e.pts.length - 1]) <= tol;
    if (e.curve === "LINE" || pts.length < 3) {
      segs.push({ kind: "line", from: pts[0], to: pts[pts.length - 1] });
      from.push(i);
    } else if (e.curve === "CIRCLE" && closed) {
      const c = centre(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
      if (c) {
        segs.push({ kind: "circle", center: c, radius: Math.hypot(pts[0][0] - c[0], pts[0][1] - c[1]) });
        from.push(i);
      }
    } else if (e.curve === "CIRCLE") {
      segs.push({ kind: "arc", from: pts[0], mid: pts[Math.floor(pts.length / 2)], to: pts[pts.length - 1] });
      from.push(i);
    } else {
      for (let k = 0; k + 1 < pts.length; k++) {
        segs.push({ kind: "line", from: pts[k], to: pts[k + 1] });
        from.push(i);
      }
    }
  });
  return { segs, from };
}

function centre(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

function signedArea(pts: P2[]): number {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  });
  return a / 2;
}

/** A picked face made ready: its frame (n into the metal) and its outline (anticlockwise) and holes in that frame. */
interface Prepared {
  frame: Frame3;
  outline: Segment[];
  holes: Segment[][];
  /** For each outline piece, the face edge it came from (its outer loop's edges, as chained). */
  from: number[];
  edges: SolidEdge[];
}

/**
 * Each outline piece moved in (to its left, into the wall) by `d[i]`, the
 * pieces either side made to meet it; or why it can't be.
 */
export function offsetEdges(outline: Segment[], d: number[], what: string): Segment[] | string {
  const k = outline.length;
  const moved = (i: number) => d[i] > 1e-12;
  const lineOf = (i: number) => {
    const s = outline[i] as Extract<Segment, { kind: "line" }>;
    const L = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
    const t: P2 = [(s.to[0] - s.from[0]) / L, (s.to[1] - s.from[1]) / L];
    const nrm: P2 = [-t[1], t[0]];
    return { p: [s.from[0] + nrm[0] * d[i], s.from[1] + nrm[1] * d[i]] as P2, t, nrm };
  };
  const corners: (P2 | null)[] = [];
  for (let i = 0; i < k; i++) {
    const prev = (i - 1 + k) % k;
    if (!moved(i) && !moved(prev)) {
      corners.push(null);
      continue;
    }
    if (outline[i].kind !== "line" || outline[prev].kind !== "line")
      return `${what} has a curved edge right beside a bend or rip. The edges either side of a bend or rip must be straight.`;
    const a = lineOf(prev);
    const b = lineOf(i);
    const den = a.t[0] * b.t[1] - a.t[1] * b.t[0];
    if (Math.abs(den) < 1e-9) {
      // In line with each other: they must move in together.
      if (Math.abs(d[i] - d[prev]) > 1e-9) return `${what} has a bend or rip on only part of a straight edge. Bends and rips must run along whole edges.`;
      corners.push(b.p);
      continue;
    }
    const s = ((b.p[0] - a.p[0]) * b.t[1] - (b.p[1] - a.p[1]) * b.t[0]) / den;
    corners.push([a.p[0] + a.t[0] * s, a.p[1] + a.t[1] * s]);
  }
  const out = outline.map((seg, i): Segment => {
    const a = corners[i];
    const b = corners[(i + 1) % k];
    if (!a && !b) return seg;
    // Only lines have a moved end (the check above).
    const s = seg as Extract<Segment, { kind: "line" }>;
    return { kind: "line", from: a ?? s.from, to: b ?? s.to };
  });
  // Every moved edge (and its neighbours) must still run the same way, with some length left.
  for (let i = 0; i < k; i++) {
    const was = outline[i];
    const now = out[i];
    if (was.kind !== "line" || now.kind !== "line") continue;
    const dw: P2 = [was.to[0] - was.from[0], was.to[1] - was.from[1]];
    const dn: P2 = [now.to[0] - now.from[0], now.to[1] - now.from[1]];
    if (dw[0] * dn[0] + dw[1] * dn[1] <= 0 || Math.hypot(dn[0], dn[1]) < 0.01) {
      const most = Math.max(...d);
      return `${what} is too small for its bends and rips: they cut it back up to ${round2(most)} mm from each edge they're on. Use a smaller bend radius or thinner metal, or pick bigger faces.`;
    }
  }
  if (signedArea(outlinePoints(out)) <= 1e-9) return `${what} is too small for its bends and rips. Use a smaller bend radius or thinner metal.`;
  return out;
}

/** Faces of a solid → the sheet, or a plain-English reason it can't be made. */
export function convertToSheet(faces: SolidFace[], rips: [V3, V3][], opts: ConvertOptions): { spec: SheetSpec; order: number[] } | string {
  const { thickness: T, radius: R, gap } = opts;
  if (faces.length === 0) return "Click the flat faces of the part that become the sheet's walls.";
  if (!(gap > 0)) return "Gap at rips: make it more than 0 mm.";
  // How near counts as the same point: tiny next to the part.
  const all = faces.flatMap((f) => f.outer.flatMap((e) => e.pts));
  const size = all.length ? Math.max(...[0, 1, 2].map((j) => Math.max(...all.map((p) => p[j])) - Math.min(...all.map((p) => p[j])))) : 1;
  const tol = Math.max(1e-6, size * 1e-7, 1e-4);

  // Each face: flat, its loops joined up, laid out in its own frame (n into the metal).
  const prepared: Prepared[] = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!f.flat) return `Walls must be flat, but ${ordinal(i)} is curved. Remove it (curved faces can't be walls yet).`;
    const outer = chainEdges(f.outer, tol * 10);
    if (!outer) return `The edges round ${ordinal(i)} don't join up. Pick another face.`;
    const holes = f.holes.map((h) => chainEdges(h, tol * 10));
    if (holes.some((h) => !h)) return `The edges round a hole in ${ordinal(i)} don't join up. Pick another face.`;
    const n = unit(opts.flip ? f.normal : mul(f.normal, -1));
    // u along the face's longest straight edge (any direction across it, if none).
    const lines = outer.filter((e) => e.curve === "LINE");
    let u: V3;
    if (lines.length) {
      const longest = lines.reduce((a, b) => (dist(a.pts[0], a.pts[a.pts.length - 1]) >= dist(b.pts[0], b.pts[b.pts.length - 1]) ? a : b));
      u = unit(sub(longest.pts[longest.pts.length - 1], longest.pts[0]));
    } else u = unit(Math.abs(n[0]) < 0.9 ? cross([1, 0, 0], n) : cross([0, 1, 0], n));
    u = unit(sub(u, mul(n, dot(u, n))));
    const v = cross(n, u);
    const origin = outer[0].pts[0];
    const frame: Frame3 = { origin, u, v, n };
    const to2 = (p: V3): P2 => [dot(sub(p, origin), u), dot(sub(p, origin), v)];
    let { segs, from } = loopSegments(outer, to2, tol * 10);
    if (signedArea(outlinePoints(segs)) < 0) {
      segs = anticlockwise(segs);
      from = [...from].reverse();
    }
    prepared.push({ frame, outline: segs, holes: holes.map((h) => anticlockwise(loopSegments(h!, to2, tol * 10).segs, false)), from, edges: outer });
  }
  const to3 = (w: Prepared, p: P2): V3 => add(add(w.frame.origin, mul(w.frame.u, p[0])), mul(w.frame.v, p[1]));
  const ends3 = (w: Prepared, i: number): [V3, V3] => {
    const s = w.outline[i] as Extract<Segment, { kind: "line" }>;
    return [to3(w, s.from), to3(w, s.to)];
  };

  // Where two walls meet: the same edge (both ends, and its middle) in both outer loops.
  interface Joint {
    a: number;
    ia: number;
    b: number;
    ib: number;
    rip: boolean;
  }
  const joints: Joint[] = [];
  const pieceOf = (w: Prepared, edge: number) => w.from.indexOf(edge);
  for (let a = 0; a < faces.length; a++)
    for (let b = a + 1; b < faces.length; b++) {
      prepared[a].edges.forEach((ea, ja) => {
        prepared[b].edges.forEach((eb, jb) => {
          const pa = ea.pts;
          const pb = eb.pts;
          const sameEnds = (dist(pa[0], pb[0]) <= tol * 10 && dist(pa[pa.length - 1], pb[pb.length - 1]) <= tol * 10) || (dist(pa[0], pb[pb.length - 1]) <= tol * 10 && dist(pa[pa.length - 1], pb[0]) <= tol * 10);
          if (!sameEnds) return;
          const midA = ea.curve === "LINE" ? mul(add(pa[0], pa[pa.length - 1]), 0.5) : pa[Math.floor(pa.length / 2)];
          const midB = eb.curve === "LINE" ? mul(add(pb[0], pb[pb.length - 1]), 0.5) : pb[Math.floor(pb.length / 2)];
          if (dist(midA, midB) > Math.max(tol * 100, 1e-3)) return;
          joints.push({ a, ia: ja, b, ib: jb, rip: false });
        });
      });
    }
  for (const j of joints) {
    if (prepared[j.a].edges[j.ia].curve !== "LINE" || prepared[j.b].edges[j.ib].curve !== "LINE")
      return `${ordinal(j.a)[0].toUpperCase() + ordinal(j.a).slice(1)} and ${ordinal(j.b)} meet along a curved edge. Bends must be straight: remove one of them.`;
  }
  // Rips: picked edges where two walls meet.
  for (const [p, q] of rips) {
    const j = joints.find((x) => {
      const [a, b] = [prepared[x.a].edges[x.ia].pts[0], prepared[x.a].edges[x.ia].pts[1]];
      return (dist(a, p) <= 1e-3 && dist(b, q) <= 1e-3) || (dist(a, q) <= 1e-3 && dist(b, p) <= 1e-3);
    });
    if (!j) return "One of the rips isn't an edge where two of the walls meet. Pick only edges between two of the picked faces as rips (or remove that one).";
    j.rip = true;
  }
  // The bends must join every wall up, without going round in a loop.
  const bends = joints.filter((j) => !j.rip);
  const order: number[] = [0];
  const parentOf = new Map<number, Joint>();
  for (let at = 0; at < order.length; at++) {
    const w = order[at];
    for (const j of bends) {
      const other = j.a === w ? j.b : j.b === w ? j.a : -1;
      if (other < 0 || order.includes(other)) continue;
      order.push(other);
      parentOf.set(other, j);
    }
  }
  if (order.length < faces.length) {
    const lone = faces.findIndex((_, i) => !order.includes(i));
    return joints.some((j) => j.rip && (j.a === lone || j.b === lone))
      ? `The rips cut ${ordinal(lone)} off from the rest of the sheet. Every wall must stay joined to another by a bend: remove a rip.`
      : `${ordinal(lone)[0].toUpperCase() + ordinal(lone).slice(1)} doesn't meet the other walls along an edge. Every wall must share a straight edge with another: remove it, or pick the faces between.`;
  }
  if (bends.length > faces.length - 1)
    return "The walls join up in a ring, so the sheet couldn't be unfolded. Click one of the edges where two walls meet in that ring, to make it a rip (left open).";

  // Each bend's angle, which way, and how far it cuts both walls back.
  const rank = new Map(order.map((w, i) => [w, i]));
  const cut: number[][] = prepared.map((w) => w.outline.map(() => 0));
  interface BendPlan {
    parent: number;
    child: number;
    pe: number;
    ce: number;
    angle: number;
    down: boolean;
  }
  const plans: BendPlan[] = [];
  /** Into a wall, square to one of its outline pieces (in 3D), and the piece's direction. */
  const inward = (w: number, i: number) => {
    const [p, q] = ends3(prepared[w], i);
    const t = unit(sub(q, p));
    return { t, d: cross(prepared[w].frame.n, t), p };
  };
  for (const child of order.slice(1)) {
    const j = parentOf.get(child)!;
    const parent = j.a === child ? j.b : j.a;
    const pe = pieceOf(prepared[parent], j.a === parent ? j.ia : j.ib);
    const ce = pieceOf(prepared[child], j.a === child ? j.ia : j.ib);
    const A = inward(parent, pe);
    const B = inward(child, ce);
    const nA = prepared[parent].frame.n;
    const nB = prepared[child].frame.n;
    const theta = Math.atan2(dot(B.d, nA), -dot(B.d, A.d));
    const up = theta > 0;
    const th = Math.abs(theta);
    const names = `${ordinal(parent)} and ${ordinal(child)}`;
    if (th < 1e-3) return `${names[0].toUpperCase() + names.slice(1)} lie flat to each other, so there's nothing to bend. Pick only one of them.`;
    if (th > Math.PI - 1e-3) return `${names[0].toUpperCase() + names.slice(1)} fold right back on each other. They can't be bent that far.`;
    // The child's metal must be on the side the bend carries it to.
    const wantN = add(mul(A.d, up ? Math.sin(th) : -Math.sin(th)), mul(nA, Math.cos(th)));
    if (dot(wantN, nB) < 0.999 || dot(A.t, B.t) > 0)
      return `${names[0].toUpperCase() + names.slice(1)} are on different sides of the metal. Pick faces that are all on the outside of the part (or all on the inside).`;
    const setback = (up ? R + T : R) * Math.tan(th / 2);
    cut[parent][pe] = setback;
    cut[child][ce] = setback;
    plans.push({ parent, child, pe, ce, angle: (th * 180) / Math.PI, down: !up });
  }
  // Rips: the wall made later stops short of the other, `gap` clear of it; the other runs to the edge (cut back only
  // where its metal would poke out past the first's face).
  for (const j of joints.filter((x) => x.rip)) {
    const [full, short] = rank.get(j.a)! < rank.get(j.b)! ? [j.a, j.b] : [j.b, j.a];
    const fi = pieceOf(prepared[full], full === j.a ? j.ia : j.ib);
    const si = pieceOf(prepared[short], short === j.a ? j.ia : j.ib);
    const F = inward(full, fi);
    const S = inward(short, si);
    const nF = prepared[full].frame.n;
    const nS = prepared[short].frame.n;
    const c = dot(S.d, nF);
    if (Math.abs(c) < 1e-3) return `${ordinal(full)[0].toUpperCase() + ordinal(full).slice(1)} and ${ordinal(short)} lie flat to each other: a rip between them isn't needed. Pick only one of them.`;
    const sign = c > 0 ? 1 : -1;
    const target = sign > 0 ? T + gap : gap;
    cut[short][si] = (target - Math.min(0, sign * T * dot(nS, nF))) / Math.abs(c);
    const cf = dot(F.d, nS);
    cut[full][fi] = cf > 1e-9 ? Math.max(0, -T * dot(nF, nS)) / cf : 0;
  }
  // Every wall cut back at its bends and rips.
  const trimmed: Segment[][] = [];
  for (let w = 0; w < prepared.length; w++) {
    const name = ordinal(w);
    const t = offsetEdges(prepared[w].outline, cut[w], name[0].toUpperCase() + name.slice(1));
    if (typeof t === "string") return t;
    trimmed.push(t);
  }

  // The sheet: the first face the base, the others flanges, each in its own wall's coordinates.
  const base = prepared[0];
  const spec: SheetSpec = {
    thickness: T,
    radius: R,
    k: opts.k,
    base: { frame: base.frame, outer: trimmed[0], holes: base.holes },
    flanges: [],
  };
  const wallId = (w: number) => (w === 0 ? "base" : `${opts.idPrefix}:w${w}`);
  /** Each wall's outline pieces, renumbered as the sheet has them: face piece → wall edge. */
  const edgeIn = new Map<number, (i: number) => number>([[0, (i) => i]]);
  for (const plan of plans) {
    const P = prepared[plan.parent];
    const C = prepared[plan.child];
    // The parent's edge (cut back), and the child's frame as the bend will make it: x back along that edge from its
    // end, y on into the child, from where the bend meets it.
    const [, pEnd] = (() => {
      const s = trimmed[plan.parent][plan.pe] as Extract<Segment, { kind: "line" }>;
      return [to3(P, s.from), to3(P, s.to)];
    })();
    const ce = trimmed[plan.child][plan.ce] as Extract<Segment, { kind: "line" }>;
    const c0 = to3(C, ce.from);
    const c1 = to3(C, ce.to);
    const e = unit(sub(c0, c1)); // the parent's edge direction (the child runs it the other way)
    const dC = cross(C.frame.n, unit(sub(c1, c0)));
    const origin = add(c1, mul(e, dot(sub(pEnd, c1), e)));
    const toChild = (p: P2): P2 => {
      const q = sub(to3(C, p), origin);
      return [dot(q, mul(e, -1)), dot(q, dC)];
    };
    const k = trimmed[plan.child].length;
    const r = plan.ce;
    const rot = <T>(list: T[]) => [...list.slice(r), ...list.slice(0, r)];
    const outline = rot(trimmed[plan.child]).map((s) => mapSegment(s, toChild));
    // The bend's edge exactly on y = 0.
    const e0 = outline[0] as Extract<Segment, { kind: "line" }>;
    e0.from = [e0.from[0], 0];
    e0.to = [e0.to[0], 0];
    (outline[1] as { from: P2 }).from = e0.to;
    (outline[k - 1] as { to: P2 }).to = e0.from;
    edgeIn.set(plan.child, (i) => (i - r + k) % k);
    const fl: FlangeSpec = {
      id: wallId(plan.child),
      wall: wallId(plan.parent),
      edge: edgeIn.get(plan.parent)!(plan.pe),
      length: 0,
      angle: plan.angle,
      down: plan.down,
      shape: { outline, holes: C.holes.map((h) => h.map((s) => mapSegment(s, toChild))) },
    };
    spec.flanges.push(fl);
  }

  // Check: every wall folds back exactly onto its face (cut back), else something's gone wrong.
  const folded = foldSheet(spec);
  const problem = Object.values(folded.errors)[0];
  if (problem) return problem;
  for (let w = 0; w < prepared.length; w++) {
    const wall = folded.walls.find((x) => x.id === wallId(w));
    if (!wall) return "Couldn't lay the walls out as a sheet. Try picking the faces in another order.";
    const want = outlinePoints(trimmed[w], 2).map((p) => to3(prepared[w], p));
    const map = edgeIn.get(w)!;
    const k = trimmed[w].length;
    const got = outlinePoints(Array.from({ length: k }, (_, i) => wall.outline[map(i)]), 2).map((p) => wallPoint(wall.frame, p));
    if (want.some((p, i) => dist(p, got[i]) > Math.max(1e-5, size * 1e-7)))
      return "Couldn't lay the walls out as a sheet (they don't fold back onto the faces). Try picking the faces in another order.";
  }
  return { spec, order };
}

function mapSegment(s: Segment, map: (p: P2) => P2): Segment {
  switch (s.kind) {
    case "line":
      return { kind: "line", from: map(s.from), to: map(s.to) };
    case "arc":
      return { kind: "arc", from: map(s.from), mid: map(s.mid), to: map(s.to) };
    case "circle":
      return { kind: "circle", center: map(s.center), radius: s.radius };
    case "bezier":
      return { kind: "bezier", from: map(s.from), c1: map(s.c1), c2: map(s.c2), to: map(s.to) };
    default:
      return s;
  }
}
