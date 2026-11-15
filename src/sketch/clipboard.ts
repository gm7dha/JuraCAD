/**
 * Copy, paste and duplicate in a sketch (Onshape's sketch copy and paste), and moving several picked things
 * at once. Pure: the app keeps the copied set (see app/sketchClipboardApp.ts) and the sketch controller places it.
 *
 * What comes along: the picked lines, arcs, circles, splines, ellipses, points and text, with the points they
 * use, and every relation and dimension that lies wholly inside that set (so a copied rectangle stays a
 * rectangle of the same size). Anything tying them to what wasn't copied — the origin, a fixed spot, a part's
 * edge or another sketch — is left behind, so the copy is free to go wherever it's put.
 */
import { curveById, curvePoints, settle, sketchId } from "./ops";
import { solveSketch } from "./solver";
import { ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData, type SketchPoint, type SketchText } from "./types";

type P2 = [number, number];

/** A copied set of sketch geometry, in the coordinates of the sketch it came from. */
export interface SketchClip {
  kind: "juracad-sketch";
  version: 1;
  points: SketchPoint[];
  curves: SketchCurve[];
  constraints: SketchConstraint[];
  texts: SketchText[];
  /** The middle of the copied points' box: the copy is placed by it (it follows the pointer). */
  middle: P2;
}

/** Relations that hold things to a spot rather than to each other: never carried with a copy. */
const LEFT_BEHIND = new Set<SketchConstraint["type"]>(["fix"]);

function withoutLink<T extends { link?: unknown }>(x: T): T {
  if (!("link" in x)) return x;
  const { link: _link, ...rest } = x;
  void _link;
  return rest as T;
}

/**
 * Copy the picked items (ids of curves, points and text; dimensions and relations picked are ignored — the
 * ones inside the set come anyway). Null when nothing that can be copied is picked.
 */
export function copySketchItems(s: SketchData, ids: readonly string[]): SketchClip | null {
  const picked = new Set(ids);
  const curves = s.curves.filter((c) => picked.has(c.id));
  const texts = (s.texts ?? []).filter((t) => picked.has(t.id));
  const pointIds = new Set<string>();
  for (const c of curves) for (const p of curvePoints(c)) pointIds.add(p);
  for (const p of s.points) if (picked.has(p.id)) pointIds.add(p.id);
  for (const t of texts) pointIds.add(t.anchor);
  if (!curves.length && !texts.length && !pointIds.size) return null;
  // The origin isn't a point of the sketch: a copy of something on it gets a point of its own there.
  const points: SketchPoint[] = [];
  for (const id of pointIds) {
    if (id === ORIGIN_ID) {
      points.push({ id: ORIGIN_ID, x: 0, y: 0 });
      continue;
    }
    const p = s.points.find((q) => q.id === id);
    if (!p) continue;
    // A copy doesn't follow other sketches or parts.
    points.push(withoutLink(p));
  }
  const inside = new Set<string>([...points.map((p) => p.id).filter((id) => id !== ORIGIN_ID), ...curves.map((c) => c.id)]);
  const constraints = s.constraints.filter((c) => !LEFT_BEHIND.has(c.type) && c.refs.length > 0 && c.refs.every((r) => inside.has(r)));
  // An offset copy without its offset dimension is just a curve.
  const offsetKept = new Set(constraints.filter((c) => c.type === "offset").flatMap((c) => c.refs));
  const copied = curves.map((c) => {
    let k = withoutLink(c);
    if (k.type === "spline" && k.offsetParams && !offsetKept.has(k.id)) {
      const { offsetParams: _o, ...rest } = k;
      void _o;
      k = rest;
    }
    return k;
  });
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const middle: P2 = xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : [0, 0];
  return { kind: "juracad-sketch", version: 1, points, curves: copied, constraints, texts: texts.map((t) => ({ ...t })), middle };
}

/** The clip's own geometry with its middle moved to `at` (same ids; for drawing where it would go). */
export function clipAt(clip: SketchClip, at: P2): SketchData {
  const dx = at[0] - clip.middle[0];
  const dy = at[1] - clip.middle[1];
  return {
    points: clip.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    curves: clip.curves,
    constraints: clip.constraints,
    texts: clip.texts,
  };
}

/** Every id in the clip given a fresh one (points, curves, constraints and text). */
function renamed(clip: SketchClip): { data: SketchData; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const fresh = (id: string, prefix: string) => {
    let n = ids.get(id);
    if (!n) {
      n = sketchId(prefix);
      ids.set(id, n);
    }
    return n;
  };
  for (const p of clip.points) fresh(p.id, "p");
  for (const c of clip.curves) fresh(c.id, c.type === "line" ? "l" : c.type === "circle" ? "k" : c.type === "arc" ? "a" : c.type === "spline" ? "sp" : "el");
  const id = (x: string) => ids.get(x) ?? x;
  const map = (h?: Record<string, P2>) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [id(k), v])) : undefined);
  const curves = clip.curves.map((c): SketchCurve => {
    switch (c.type) {
      case "line":
        return { ...c, id: id(c.id), p1: id(c.p1), p2: id(c.p2) };
      case "circle":
        return { ...c, id: id(c.id), center: id(c.center) };
      case "arc":
        return { ...c, id: id(c.id), center: id(c.center), start: id(c.start), end: id(c.end) };
      case "ellipse":
        return { ...c, id: id(c.id), center: id(c.center), major: id(c.major), minor: id(c.minor), ...(c.start && c.end ? { start: id(c.start), end: id(c.end) } : {}) };
      case "spline": {
        const tangents = map(c.tangents);
        const tangentsIn = map(c.tangentsIn);
        return { ...c, id: id(c.id), points: c.points.map(id), ...(tangents ? { tangents } : {}), ...(tangentsIn ? { tangentsIn } : {}) };
      }
    }
  });
  const constraints = clip.constraints.map((c) => ({ ...c, id: sketchId("c"), refs: c.refs.map(id) }));
  const texts = clip.texts.map((t) => ({ ...t, id: sketchId("tx"), anchor: id(t.anchor) }));
  const points = clip.points.map((p) => ({ ...p, id: id(p.id) }));
  return { data: { points, curves, constraints, texts }, ids };
}

export interface PasteResult {
  sketch: SketchData;
  /** What was pasted (its curves, points placed on their own and text), to select. */
  ids: string[];
  error?: string;
}

/** Add a copy of the clip to the sketch with its middle at `at`. Everything gets new ids; the sketch is solved. */
export function pasteSketchClip(s: SketchData, clip: SketchClip, at: P2): PasteResult {
  const { data } = renamed({ ...clip, points: clipAt(clip, at).points });
  if (!data.points.length && !data.curves.length) return { sketch: s, ids: [], error: "Nothing to paste." };
  const texts = data.texts ?? [];
  const next: SketchData = {
    ...s,
    points: [...s.points, ...data.points],
    curves: [...s.curves, ...data.curves],
    constraints: [...s.constraints, ...data.constraints],
    ...(texts.length ? { texts: [...(s.texts ?? []), ...texts] } : {}),
  };
  const solved = settle(next).sketch;
  const used = new Set(data.curves.flatMap(curvePoints));
  const anchors = new Set(texts.map((t) => t.anchor));
  const ids = [...data.curves.map((c) => c.id), ...data.points.filter((p) => !used.has(p.id) && !anchors.has(p.id)).map((p) => p.id), ...texts.map((t) => t.id)];
  return { sketch: solved, ids };
}

/** Read a clip back from text (as kept in the browser), checking it's one; null if it isn't. */
export function readSketchClip(text: string | null | undefined): SketchClip | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<SketchClip>;
    if (v?.kind !== "juracad-sketch" || v.version !== 1) return null;
    if (!Array.isArray(v.points) || !Array.isArray(v.curves) || !Array.isArray(v.constraints)) return null;
    const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
    if (!v.points.every((p) => p && typeof p.id === "string" && ok(p.x) && ok(p.y))) return null;
    if (!v.curves.every((c) => c && typeof c.id === "string" && ["line", "circle", "arc", "spline", "ellipse"].includes(c.type))) return null;
    // Every point a curve uses must be in the clip.
    const pts = new Set(v.points.map((p) => p.id));
    if (!v.curves.every((c) => curvePoints(c).every((p) => pts.has(p)))) return null;
    if (!v.constraints.every((c) => c && typeof c.id === "string" && typeof c.type === "string" && Array.isArray(c.refs))) return null;
    const texts = Array.isArray(v.texts) ? v.texts.filter((t) => t && typeof t.id === "string" && pts.has(t.anchor)) : [];
    const middle: P2 = Array.isArray(v.middle) && ok(v.middle[0]) && ok(v.middle[1]) ? [v.middle[0], v.middle[1]] : [0, 0];
    return { kind: "juracad-sketch", version: 1, points: v.points, curves: v.curves, constraints: v.constraints, texts, middle };
  } catch {
    return null;
  }
}

/** A short "2 lines and a circle" style count of what's in a clip. */
export function clipSummary(clip: SketchClip): string {
  const n = clip.curves.length + clip.texts.length + clip.points.filter((p) => p.standalone).length;
  return n === 1 ? "1 item" : `${n} items`;
}

// ---------------------------------------------------------------------------
// Moving several at once

/** The points that move when the picked items are dragged together (their curves' points, picked points, text anchors). */
export function selectionPoints(s: SketchData, ids: readonly string[]): string[] {
  const out = new Set<string>();
  const pointIds = new Set(s.points.map((p) => p.id));
  for (const id of ids) {
    const c = curveById(s, id);
    if (c) for (const p of curvePoints(c)) out.add(p);
    else if (pointIds.has(id)) out.add(id);
    const t = (s.texts ?? []).find((x) => x.id === id);
    if (t) out.add(t.anchor);
  }
  out.delete(ORIGIN_ID);
  // Points following a part's edge or another sketch stay where those are.
  for (const p of s.points) if (p.link && out.has(p.id)) out.delete(p.id);
  return [...out];
}

/** How many draggable things are picked (curves, points, text) — dragging one of them moves them all when there are two or more. */
export function draggableCount(s: SketchData, ids: readonly string[]): number {
  const pointIds = new Set(s.points.map((p) => p.id));
  return ids.filter((id) => !!curveById(s, id) || pointIds.has(id) || (s.texts ?? []).some((t) => t.id === id)).length;
}

/**
 * Drag the picked items together by (dx, dy) from where they are in `start` (their relations and dimensions held;
 * whatever they're tied to follows or holds them back, as when dragging one). `start` back if it can't be solved.
 */
export function dragSelection(start: SketchData, ids: readonly string[], dx: number, dy: number): SketchData {
  const pointIds = selectionPoints(start, ids);
  if (!pointIds.length) return start;
  const r = solveSketch(start, { moveRigid: { pointIds, dx, dy } });
  return r.ok ? r.sketch : start;
}
