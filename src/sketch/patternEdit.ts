/**
 * Changing a sketch pattern after it's made (Onshape's editable sketch patterns): its count, spacing or angle, and a
 * linear pattern's second direction. Copies already there keep their ids (so dimensions and relations to them stay);
 * a smaller count takes the last copies away, a bigger one adds new ones after them. The spacing (or angle) is kept
 * as typed on the copies' constraints (`SketchConstraint.value`), so it can be a variable or a sum. Pure.
 */
import { evaluate } from "../model/expr";
import { curveById, curvePoints, deleteItems, pointPos, sketchId, type EditResult } from "./ops";
import { solveSketch } from "./solver";
import { copyCurvesWith, fullTurn } from "./tools";
import { ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData, type SketchPatternDef, type SketchPoint } from "./types";

type P2 = [number, number];

const isCopyRule = (k: SketchConstraint) => k.type === "patternMove" || k.type === "patternCopy";

/** The pattern's copy constraints (first direction, then second). */
function rulesOf(s: SketchData, id: string): SketchConstraint[] {
  return s.constraints.filter((k) => isCopyRule(k) && k.pattern?.id === id);
}

/** Patterns of the sketch that still have copies. */
export function livePatterns(s: SketchData): SketchPatternDef[] {
  const ids = new Set(s.constraints.flatMap((k) => (isCopyRule(k) && k.pattern ? [k.pattern.id] : [])));
  return (s.patterns ?? []).filter((p) => ids.has(p.id));
}

/** The pattern a picked item belongs to: one of its copies (a curve or point), its originals, or a copy's constraint. Null if none. */
export function patternIdOf(s: SketchData, ids: readonly string[]): string | null {
  const live = livePatterns(s);
  if (!live.length) return null;
  const known = new Set(live.map((p) => p.id));
  const byPoint = new Map<string, string>();
  for (const k of s.constraints) if (isCopyRule(k) && k.pattern && known.has(k.pattern.id)) byPoint.set(k.refs[0], k.pattern.id);
  for (const id of ids) {
    const k = s.constraints.find((c) => c.id === id);
    if (k?.pattern && known.has(k.pattern.id)) return k.pattern.id;
    if (byPoint.has(id)) return byPoint.get(id)!;
    const c = curveById(s, id);
    if (!c) continue;
    for (const p of curvePoints(c)) if (byPoint.has(p)) return byPoint.get(p)!;
    const source = live.find((p) => p.sources.includes(id));
    if (source) return source.id;
  }
  return null;
}

/** A pattern's settings as they are now (for the sketch panel). */
export interface PatternNow {
  id: string;
  kind: "linear" | "circular";
  count: number;
  /** Spacing (in a row) or the angle spread over (round a centre), as typed. */
  value: string;
  /** In a row: its direction, degrees from X (missing when it runs along a line of the sketch). */
  angle?: number;
  /** Runs along a line of the sketch (its direction follows the line). */
  alongLine: boolean;
  second?: { count: number; value: string; angle: number };
}

const tidyAngle = (a: number) => Math.round(a * 1e6) / 1e6;

export function readPattern(s: SketchData, id: string): PatternNow | null {
  const def = livePatterns(s).find((p) => p.id === id);
  if (!def) return null;
  const rules = rulesOf(s, id);
  const first = rules.filter((k) => !k.pattern!.second).sort((a, b) => Math.abs(a.pattern!.n) - Math.abs(b.pattern!.n))[0];
  const second = rules.filter((k) => k.pattern!.second).sort((a, b) => a.pattern!.n - b.pattern!.n)[0];
  const alongLine = def.kind === "linear" && !!first && first.refs.length >= 3;
  return {
    id,
    kind: def.kind,
    count: def.count,
    value: first?.value ?? def.value,
    ...(def.kind === "linear" && !alongLine ? { angle: tidyAngle(first?.extra?.[1] ?? def.angle) } : {}),
    alongLine,
    ...(def.second ? { second: { count: def.second.count, value: second?.value ?? def.second.value, angle: tidyAngle(second?.extra?.[1] ?? def.second.angle) } } : {}),
  };
}

/** What to change a pattern to. `second`: null takes a grid's second direction away; missing leaves it as it is. */
export interface PatternChange {
  count: number;
  value: string;
  /** In a row: direction (ignored when it runs along a line). */
  angle?: number;
  second?: { count: number; value: string; angle: number } | null;
}

const key = (c: SketchCurve, map?: (p: string) => string) => `${c.type}:${curvePoints(c).map((p) => (map ? map(p) : p)).join(",")}`;

/** Change a pattern's count, spacing/angle and second direction. Copies that stay keep their ids. */
export function editPattern(s: SketchData, id: string, change: PatternChange): EditResult {
  const fail = (error: string): EditResult => ({ sketch: s, error });
  const def = livePatterns(s).find((p) => p.id === id);
  if (!def) return fail("That pattern isn't there any more.");
  const count = Math.round(change.count);
  if (!(count >= 2 && count <= 200)) return fail("The number of copies must be between 2 and 200.");
  const v = evaluate(change.value);
  if (!v.ok) return fail(`${def.kind === "linear" ? "Spacing" : "Angle"}: ${v.error}`);
  if (def.kind === "linear" && !(Math.abs(v.value) > 1e-9)) return fail("Give the copies some spacing.");
  if (def.kind === "circular" && !(Math.abs(v.value) > 1e-9)) return fail("Give the pattern an angle to spread over.");
  const wantSecond = change.second === undefined ? (def.second ?? null) : change.second;
  if (wantSecond && def.kind !== "linear") return fail("A second direction is for patterns in a row.");
  let v2 = 0;
  const count2 = wantSecond ? Math.round(wantSecond.count) : 1;
  if (wantSecond) {
    if (!(count2 >= 2 && count2 <= 200)) return fail("The second direction's number of copies must be between 2 and 200.");
    const r = evaluate(wantSecond.value);
    if (!r.ok) return fail(`Second direction's spacing: ${r.error}`);
    if (!(Math.abs(r.value) > 1e-9)) return fail("Give the second direction some spacing.");
    v2 = r.value;
  }
  const oldCount = def.count;
  const oldCount2 = def.second?.count ?? 1;

  // Which copy each copy point is: first direction (index along) and second (the point it's a copy of, and how far).
  const rules = rulesOf(s, id);
  const firstOf = new Map<string, number>();
  const rowOfSource = new Map<number, Map<string, string>>();
  for (const k of rules) {
    if (k.pattern!.second) continue;
    const i = Math.abs(k.pattern!.n);
    firstOf.set(k.refs[0], i);
    if (!rowOfSource.has(i)) rowOfSource.set(i, new Map());
    rowOfSource.get(i)!.set(k.refs[1], k.refs[0]);
  }
  const gone = new Set<string>();
  for (const [p, i] of firstOf) if (i >= count) gone.add(p);
  const secondRules = rules.filter((k) => k.pattern!.second);
  const existing2 = new Set<string>();
  for (const k of secondRules) {
    const j = k.pattern!.n;
    if (j >= count2 || gone.has(k.refs[1])) gone.add(k.refs[0]);
    else existing2.add(`${firstOf.get(k.refs[1]) ?? 0}|${j}`);
  }

  // The copies that stay: their spacing / angle as typed now.
  const full = def.kind === "circular" && fullTurn(v.value);
  const of = def.kind === "circular" ? (full ? count : count - 1) : 1;
  const value = change.value.trim();
  const angle = def.kind === "linear" ? (change.angle ?? def.angle) : v.value;
  const constraints = s.constraints.map((k): SketchConstraint => {
    if (!isCopyRule(k) || k.pattern?.id !== id || gone.has(k.refs[0])) return k;
    const t = k.pattern;
    if (t.second && wantSecond) {
      return { ...k, value: wantSecond.value.trim(), extra: [v2 * t.n, wantSecond.angle, ...(k.extra?.slice(2) ?? [])] };
    }
    if (t.second) return k;
    if (def.kind === "circular") {
      const { of: _of, ...tag } = t;
      void _of;
      return { ...k, value, pattern: { ...tag, ...(of !== 1 ? { of } : {}) }, extra: [(v.value * t.n) / of, ...(k.extra?.slice(1) ?? [])] };
    }
    // Along a line its direction follows the line; else the direction may have changed.
    const dir = k.refs.length >= 3 ? (k.extra?.[1] ?? 0) : angle;
    return { ...k, value, extra: [v.value * t.n, dir, ...(k.extra?.slice(2) ?? [])] };
  });
  let w: SketchData = { ...s, constraints };
  if (gone.size) w = deleteItems(w, [...gone]);

  const sources = def.sources.map((c) => curveById(w, c)).filter((c): c is SketchCurve => !!c);
  const points: SketchPoint[] = [];
  const curves: SketchCurve[] = [];
  const added: SketchConstraint[] = [];
  const con = (type: SketchConstraint["type"], refs: string[], val?: string, extra?: number[]): SketchConstraint => ({
    id: sketchId("c"),
    type,
    refs,
    ...(val !== undefined ? { value: val } : {}),
    ...(extra ? { extra } : {}),
  });
  const sizes = (from: SketchCurve[], before: number) =>
    from.forEach((c, k) => {
      const copy = curves[before + k];
      if (c.type === "circle" && copy?.type === "circle") added.push(con("equal", [copy.id, c.id], undefined, [1]));
    });

  // New copies in the first direction, after the last one there was.
  if (count > oldCount && sources.length) {
    const firstRule = rules.find((k) => !k.pattern!.second);
    const line = def.kind === "linear" && firstRule && firstRule.refs.length >= 3 ? curveById(w, firstRule.refs[2]) : undefined;
    const sign = def.kind === "linear" && line && def.reverse ? -1 : 1;
    let dir: P2 = [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)];
    if (line?.type === "line") {
      const [a, b] = [pointPos(w, line.p1), pointPos(w, line.p2)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      dir = [((b[0] - a[0]) / l) * sign, ((b[1] - a[1]) / l) * sign];
    }
    const centre = def.kind === "circular" ? (firstRule?.refs[2] ?? def.centre ?? ORIGIN_ID) : null;
    const C = centre ? pointPos(w, centre) : ([0, 0] as P2);
    for (let i = oldCount; i < count; i++) {
      const before = curves.length;
      let move: (p: P2) => P2;
      if (def.kind === "linear") {
        const d = v.value * i;
        move = (p) => [p[0] + dir[0] * d, p[1] + dir[1] * d];
      } else {
        const t = ((v.value * i) / of) * (Math.PI / 180);
        const c = Math.cos(t), sn = Math.sin(t);
        move = (p) => [C[0] + (p[0] - C[0]) * c - (p[1] - C[1]) * sn, C[1] + (p[0] - C[0]) * sn + (p[1] - C[1]) * c];
      }
      const copies = copyCurvesWith(w, sources, move, points, curves);
      const row = new Map<string, string>();
      for (const [from, to] of copies) {
        row.set(from, to);
        if (def.kind === "linear") {
          const n = i * sign;
          added.push({ ...con("patternMove", line ? [to, from, line.id] : [to, from], value, [v.value * n, line ? (firstRule?.extra?.[1] ?? angle) : angle]), pattern: { id, n } });
        } else added.push({ ...con("patternCopy", [to, from, centre!], value, [(v.value * i) / of]), pattern: { id, n: i, ...(of !== 1 ? { of } : {}) } });
      }
      rowOfSource.set(i, row);
      sizes(sources, before);
    }
  }
  w = { ...w, points: [...w.points, ...points], curves: [...w.curves, ...curves], constraints: [...w.constraints, ...added] };

  // The second direction: every row's copies along it that aren't there yet.
  if (wantSecond && sources.length) {
    const points2: SketchPoint[] = [];
    const curves2: SketchCurve[] = [];
    const before2 = curves.length;
    void before2;
    const byKey = new Map(w.curves.map((c) => [key(c), c]));
    const a2 = (wantSecond.angle * Math.PI) / 180;
    const dir2: P2 = [Math.cos(a2), Math.sin(a2)];
    const more: SketchConstraint[] = [];
    for (let i = 0; i < count; i++) {
      const row = i === 0 ? null : rowOfSource.get(i);
      if (i > 0 && !row) continue;
      const rowCurves = i === 0 ? sources : sources.map((c) => byKey.get(key(c, (p) => row!.get(p) ?? p))).filter((c): c is SketchCurve => !!c);
      if (!rowCurves.length) continue;
      for (let j = 1; j < count2; j++) {
        if (existing2.has(`${i}|${j}`) || (i < oldCount && j < oldCount2)) continue;
        const d = v2 * j;
        const start = curves2.length;
        const copies = copyCurvesWith(w, rowCurves, (p) => [p[0] + dir2[0] * d, p[1] + dir2[1] * d], points2, curves2);
        for (const [from, to] of copies) more.push({ ...con("patternMove", [to, from], wantSecond.value.trim(), [d, wantSecond.angle]), pattern: { id, n: j, second: true } });
        rowCurves.forEach((c, k) => {
          const copy = curves2[start + k];
          if (c.type === "circle" && copy?.type === "circle") more.push(con("equal", [copy.id, c.id], undefined, [1]));
        });
      }
    }
    w = { ...w, points: [...w.points, ...points2], curves: [...w.curves, ...curves2], constraints: [...w.constraints, ...more] };
  }

  const nextDef: SketchPatternDef = {
    ...def,
    count,
    value,
    angle,
    ...(def.kind === "circular" ? { full } : {}),
  };
  if (def.kind === "circular" && !full) delete nextDef.full;
  if (wantSecond) nextDef.second = { count: count2, value: wantSecond.value.trim(), angle: wantSecond.angle };
  else delete nextDef.second;
  w = { ...w, patterns: (w.patterns ?? []).map((p) => (p.id === id ? nextDef : p)) };
  const solved = solveSketch(w);
  if (!solved.ok) return fail("Changing the pattern that way would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch };
}
