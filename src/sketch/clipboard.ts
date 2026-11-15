/**
 * Copy, paste and duplicate in a sketch (Onshape's sketch copy and paste), and moving several picked things
 * at once. Pure: the app keeps the copied set (see app/sketchClipboardApp.ts) and the sketch controller places it.
 *
 * What comes along: the picked lines, arcs, circles, splines, ellipses, points and text, with the points they
 * use, and every relation and dimension that lies wholly inside that set (so a copied rectangle stays a
 * rectangle of the same size). Anything tying them to what wasn't copied — the origin, a fixed spot, a part's
 * edge or another sketch — is left behind, so the copy is free to go wherever it's put.
 */
import { evaluate, namesIn } from "../model/expr";
import { curveById, curvePoints, measure, pointPos, sketchId } from "./ops";
import { solveSketch } from "./solver";
import { parseSketchData } from "./validate";
import { isDimension, ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData, type SketchPoint, type SketchText } from "./types";

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
  /**
   * Each dimension's size as it was when copied (mm, or degrees), by constraint id: pasted where its expression can't be
   * worked out (a variable the design hasn't got), so the copy keeps its size. Missing in clips without dimensions.
   */
  sizes?: Record<string, number>;
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
  const sizes: Record<string, number> = {};
  for (const c of constraints) {
    if (!isDimension(c) || c.driven) continue;
    const r = evaluate(c.value ?? "");
    let v = r.ok ? r.value : NaN;
    if (!Number.isFinite(v)) {
      try {
        v = measure(s, c);
      } catch {
        v = NaN;
      }
    }
    if (Number.isFinite(v)) sizes[c.id] = v;
  }
  return { kind: "juracad-sketch", version: 1, points, curves: copied, constraints, texts: texts.map((t) => ({ ...t })), middle, ...(Object.keys(sizes).length ? { sizes } : {}) };
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
  const constraints = clip.constraints.map((c) => {
    // A size worked out from variables this design hasn't got keeps its number instead.
    const size = clip.sizes?.[c.id];
    const keep = c.value === undefined || size === undefined || evaluate(c.value).ok;
    return { ...c, id: sketchId("c"), refs: c.refs.map(id), ...(keep ? {} : { value: String(Math.round(size * 1e6) / 1e6) }) };
  });
  const texts = clip.texts.map((t) => ({ ...t, id: sketchId("tx"), anchor: id(t.anchor) }));
  const points = clip.points.map((p) => ({ ...p, id: id(p.id) }));
  return { data: { points, curves, constraints, texts }, ids };
}

export interface PasteResult {
  sketch: SketchData;
  /** What was pasted (its curves, points placed on their own and text), to select. */
  ids: string[];
  error?: string;
  /** Sizes that used variables this design hasn't got, pasted as plain numbers instead (the variables' names). */
  unknownNames?: string[];
}

/** Variable names in the clip's dimensions that can't be worked out here. */
function unknownNamesIn(clip: SketchClip): string[] {
  const out = new Set<string>();
  for (const c of clip.constraints) {
    if (c.value === undefined || !isDimension(c) || c.driven || evaluate(c.value).ok) continue;
    for (const m of namesIn(c.value)) if (!evaluate(m).ok) out.add(m);
  }
  return [...out];
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
  const r = solveSketch(next);
  if (!r.ok) return { sketch: s, ids: [], error: "The copy couldn't be pasted: its relations and dimensions can't all be met here." };
  const solved = r.sketch;
  const unknownNames = unknownNamesIn(clip);
  const used = new Set(data.curves.flatMap(curvePoints));
  const anchors = new Set(texts.map((t) => t.anchor));
  const ids = [...data.curves.map((c) => c.id), ...data.points.filter((p) => !used.has(p.id) && !anchors.has(p.id)).map((p) => p.id), ...texts.map((t) => t.id)];
  return { sketch: solved, ids, ...(unknownNames.length ? { unknownNames } : {}) };
}

/**
 * Read a clip back from text (as kept in the browser), checking it fully: it must be a well-formed sketch (the
 * same checks as a saved file's) whose ids are all different and where every point a curve uses, every
 * spline handle, every constraint's ref and every text's point is in the clip itself — else null, so a bad
 * clip can never tie itself to the sketch it's pasted into or make that sketch unreadable.
 */
export function readSketchClip(text: string | null | undefined): SketchClip | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<SketchClip>;
    if (v?.kind !== "juracad-sketch" || v.version !== 1) return null;
    if (!Array.isArray(v.points) || !Array.isArray(v.curves) || !Array.isArray(v.constraints)) return null;
    const rawTexts = Array.isArray(v.texts) ? v.texts : [];
    const parsed = parseSketchData({ points: v.points, curves: v.curves, constraints: v.constraints, texts: rawTexts });
    if (!parsed) return null;
    const texts = parsed.texts ?? [];
    if (parsed.points.length !== v.points.length || parsed.curves.length !== v.curves.length || parsed.constraints.length !== v.constraints.length || texts.length !== rawTexts.length) return null;
    const all = [...parsed.points, ...parsed.curves, ...parsed.constraints, ...texts].map((x) => x.id);
    if (new Set(all).size !== all.length) return null;
    const pts = new Set(parsed.points.map((p) => p.id));
    const items = new Set([...pts, ...parsed.curves.map((c) => c.id)]);
    for (const c of parsed.curves) {
      if (!curvePoints(c).every((p) => pts.has(p))) return null;
      if (c.type === "spline" && [...Object.keys(c.tangents ?? {}), ...Object.keys(c.tangentsIn ?? {})].some((k) => !pts.has(k))) return null;
      if (c.type === "circle" && !(c.radius > 0)) return null;
    }
    if (!parsed.constraints.every((c) => c.refs.length > 0 && c.refs.every((r) => items.has(r)))) return null;
    if (!texts.every((t) => pts.has(t.anchor))) return null;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    const middle: P2 = Array.isArray(v.middle) && ok(v.middle[0]) && ok(v.middle[1]) ? [v.middle[0], v.middle[1]] : [0, 0];
    const sizes: Record<string, number> = {};
    if (v.sizes && typeof v.sizes === "object") for (const [k, n] of Object.entries(v.sizes)) if (ok(n) && parsed.constraints.some((c) => c.id === k)) sizes[k] = n;
    return { kind: "juracad-sketch", version: 1, points: parsed.points, curves: parsed.curves, constraints: parsed.constraints, texts, middle, ...(Object.keys(sizes).length ? { sizes } : {}) };
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
  // (Points following a part's edge or another sketch stay in: they can't move, so the drag is refused rather than stretching.)
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
  if (!r.ok) return start;
  // Something holds part of the selection (a Fix, a dimension to what isn't picked): moving the rest would
  // stretch the shapes, so nothing moves (the controller says why).
  const rigid = pointIds.every((id) => {
    const [x0, y0] = pointPos(start, id);
    const [x1, y1] = pointPos(r.sketch, id);
    return Math.hypot(x1 - x0 - dx, y1 - y0 - dy) < 1e-3;
  });
  return rigid ? r.sketch : start;
}
