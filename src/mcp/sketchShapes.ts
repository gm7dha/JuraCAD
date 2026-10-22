/**
 * Turning a list of shapes Claude describes ("a 60 × 40 rectangle with its
 * corner at the origin, a 4.5 mm circle at (5, 5)…") into a real JuraCAD
 * sketch: the same lines, arcs, constraints and dimensions the app's own
 * tools make, so the sketch can be edited in the app afterwards.
 *
 * Each shape gets its sizes and position as dimensions (from the origin), so
 * the sketch comes out fully defined wherever that makes sense. A dimension
 * is only kept when it pins down something not already fixed (so shapes that
 * share corners don't end up over-defined).
 */
import { setCurrentScope, type Scope } from "../model/expr";
import { addArc, addCircle, addLine, addPoint, addRectangle, settle, sketchId, type Placed } from "../sketch/ops";
import { analyzeSketch, solveSketch } from "../sketch/solver";
import { addCentreRectangle, addPolygon, addSlot, mergeCoincident } from "../sketch/tools";
import { emptySketch, ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData, type SketchLine } from "../sketch/types";
import { amount, bool, InputError, noExtras, object, oneOf, tidy, xy, type Amount, type Obj } from "./args";

export const SHAPE_TYPES = ["rectangle", "circle", "line", "arc", "slot", "polygon", "outline", "point"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

export interface BuiltSketch {
  data: SketchData;
  /** How many ways the sketch could still move or change size (0 = fully defined). */
  freedom: number;
  /** For each shape, the ids of the curves (and standalone points) it made. */
  shapes: { type: ShapeType; ids: string[] }[];
}

const SHAPE_KEYS: Record<ShapeType, string[]> = {
  rectangle: ["type", "corner", "center", "width", "height", "construction"],
  circle: ["type", "center", "diameter", "construction"],
  line: ["type", "from", "to", "construction"],
  arc: ["type", "center", "radius", "start_angle", "end_angle", "construction"],
  slot: ["type", "from", "to", "width", "construction"],
  polygon: ["type", "center", "sides", "diameter", "across", "angle", "construction"],
  outline: ["type", "points", "closed", "construction"],
  point: ["type", "at"],
};

/** What the shapes mean, for the tool description. */
export const SHAPE_HELP = [
  'rectangle: {"type":"rectangle","corner":[x,y],"width":w,"height":h} (corner = bottom-left) or {"type":"rectangle","center":[x,y],"width":w,"height":h}',
  'circle: {"type":"circle","center":[x,y],"diameter":d}',
  'line: {"type":"line","from":[x,y],"to":[x,y]} (add "construction":true for a revolve axis or helper line)',
  'arc: {"type":"arc","center":[x,y],"radius":r,"start_angle":a,"end_angle":b} (degrees, anticlockwise from the sketch x axis)',
  'slot: {"type":"slot","from":[x,y],"to":[x,y],"width":w} (from/to are the centres of the round ends)',
  'polygon: {"type":"polygon","center":[x,y],"sides":6,"diameter":d,"across":"corners"|"flats","angle":0} (regular; angle turns it, degrees)',
  'outline: {"type":"outline","points":[[x,y],…],"closed":true} (straight-sided shape through the points)',
  'point: {"type":"point","at":[x,y]} (marks where a Hole goes)',
];

type Candidate = Omit<SketchConstraint, "id">;

const near = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** The text for a distance that's `a` in the opposite direction ("-(w/2)" → "w/2"). */
function negated(a: Amount): string {
  const n = Number(a.text);
  if (Number.isFinite(n)) return tidy(-n);
  return `-(${a.text})`;
}

/**
 * Dimensions putting a point at (x, y) measured from the sketch origin — or,
 * where a coordinate is 0, lining it up with the origin instead.
 */
function positionOf(pointId: string, x: Amount, y: Amount): Candidate[] {
  const out: Candidate[] = [];
  for (const [k, a] of [[0, x], [1, y]] as const) {
    if (Math.abs(a.value) < 1e-9) {
      // Same x as the origin = straight above it ("vertical"); same y = level with it.
      out.push({ type: k === 0 ? "vertical" : "horizontal", refs: [pointId, ORIGIN_ID] });
      continue;
    }
    const sign = a.value > 0 ? 1 : -1;
    out.push({ type: k === 0 ? "horizontalDistance" : "verticalDistance", refs: [ORIGIN_ID, pointId], value: sign > 0 ? a.text : negated(a), extra: [sign] });
  }
  return out;
}

const placed = (p: [Amount, Amount]): Placed => {
  const [x, y] = [p[0].value, p[1].value];
  return { x, y, snap: Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 ? { kind: "origin" } : null };
};
const pt = (p: [Amount, Amount]): [number, number] => [p[0].value, p[1].value];
const fixed = (v: number): Amount => ({ value: v, text: tidy(v) });

function check<T extends { error?: string }>(r: T, where: string): T {
  if (r.error) throw new InputError(`${where}: ${r.error}`);
  return r;
}

/** Join points that sit in the same place (shapes drawn to meet, like a person snapping to a corner). */
function joinTouching(s: SketchData): SketchData {
  let sketch = s;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < sketch.points.length && !changed; i++) {
      for (let j = i + 1; j < sketch.points.length; j++) {
        const a = sketch.points[i];
        const b = sketch.points[j];
        if (!near([a.x, a.y], [b.x, b.y])) continue;
        const joined = { ...sketch, constraints: [...sketch.constraints, { id: sketchId("c"), type: "coincident" as const, refs: [a.id, b.id] }] };
        const merged = mergeCoincident(joined, a.id);
        sketch = { ...merged, points: merged.points.map((p) => (p.id === a.id ? { ...p, standalone: a.standalone || b.standalone || undefined } : p)) };
        changed = true;
        break;
      }
    }
  }
  // The same constraint twice (two points both joined to the origin, say) adds nothing.
  const seen = new Set<string>();
  const constraints = sketch.constraints.filter((c) => {
    const key = `${c.type}|${c.refs.join(",")}|${c.value ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...sketch, points: sketch.points.map((p) => (p.standalone ? p : (({ standalone: _s, ...rest }) => (void _s, rest))(p))), constraints };
}

const lineOf = (s: SketchData, id: string) => s.curves.find((c) => c.id === id) as SketchLine;

/** Build the sketch. Throws InputError (plain English) when a shape doesn't make sense. */
export function buildSketch(shapesIn: unknown, scope: Scope): BuiltSketch {
  if (!Array.isArray(shapesIn) || shapesIn.length === 0) {
    throw new InputError('shapes is missing: give a list of shapes, e.g. [{"type":"rectangle","corner":[0,0],"width":60,"height":40}].');
  }
  // Dimensions may use the design's variables: the solver reads them from the current scope.
  setCurrentScope(scope);
  let s = emptySketch();
  const made: { type: ShapeType; ids: string[]; dims: (s: SketchData) => Candidate[] }[] = [];

  shapesIn.forEach((raw, i) => {
    const where = `shapes[${i}]`;
    const o: Obj = object(raw, where);
    const type = oneOf(o.type, SHAPE_TYPES, `${where}.type`);
    noExtras(o, SHAPE_KEYS[type], `${where} (${type})`);
    const construction = bool(o.construction, `${where}.construction`);
    const at = (key: string) => xy(o[key], `${where}.${key}`, scope);
    const size = (key: string, opts: { positive?: boolean; integer?: boolean; unit?: string } = { positive: true }) => amount(o[key], `${where}.${key}`, scope, opts);

    switch (type) {
      case "rectangle": {
        const w = size("width");
        const h = size("height");
        if ((o.corner === undefined) === (o.center === undefined)) throw new InputError(`${where}: give either "corner" (its bottom-left corner) or "center", not both.`);
        if (o.corner !== undefined) {
          const c = at("corner");
          const r = check(addRectangle(s, placed(c), { x: c[0].value + w.value, y: c[1].value + h.value }, construction), where);
          s = r.sketch;
          const [bottom, right] = r.lineIds;
          made.push({
            type,
            ids: r.lineIds,
            dims: (k) => [{ type: "length", refs: [bottom], value: w.text }, { type: "length", refs: [right], value: h.text }, ...positionOf(lineOf(k, bottom).p1, c[0], c[1])],
          });
        } else {
          const c = at("center");
          const corner = { x: c[0].value + w.value / 2, y: c[1].value + h.value / 2, snap: null };
          const r = check(addCentreRectangle(s, placed(c), corner, construction), where);
          s = r.sketch;
          const [bottom, right] = r.lineIds;
          made.push({
            type,
            ids: r.lineIds,
            dims: (k) => {
              // The centre is the point held halfway along the construction diagonal.
              const diag = k.curves.find((x): x is SketchLine => x.type === "line" && x.construction && x.p1 === lineOf(k, bottom).p1 && x.p2 === lineOf(k, right).p2);
              const mid = diag && k.constraints.find((x) => x.type === "midpoint" && x.refs[1] === diag.id)?.refs[0];
              return [{ type: "length", refs: [bottom], value: w.text }, { type: "length", refs: [right], value: h.text }, ...(mid ? positionOf(mid, c[0], c[1]) : [])];
            },
          });
        }
        break;
      }
      case "circle": {
        const c = at("center");
        const d = size("diameter");
        const r = check(addCircle(s, placed(c), d.value / 2, construction), where);
        s = r.sketch;
        made.push({
          type,
          ids: [r.circleId],
          dims: (k) => {
            const circle = k.curves.find((x) => x.id === r.circleId) as Extract<SketchCurve, { type: "circle" }>;
            return [{ type: "diameter", refs: [r.circleId], value: d.text }, ...positionOf(circle.center, c[0], c[1])];
          },
        });
        break;
      }
      case "line": {
        const a = at("from");
        const b = at("to");
        if (near(pt(a), pt(b))) throw new InputError(`${where}: "from" and "to" are the same point; a line needs two different ends.`);
        const orientation = Math.abs(a[1].value - b[1].value) < 1e-9 ? "horizontal" : Math.abs(a[0].value - b[0].value) < 1e-9 ? "vertical" : null;
        const r = check(addLine(s, placed(a), placed(b), { construction, orientation }), where);
        s = r.sketch;
        made.push({
          type,
          ids: [r.lineId],
          dims: (k) => {
            const l = lineOf(k, r.lineId);
            return [...positionOf(l.p1, a[0], a[1]), ...positionOf(l.p2, b[0], b[1])];
          },
        });
        break;
      }
      case "arc": {
        const c = at("center");
        const rad = size("radius");
        const a0 = amount(o.start_angle, `${where}.start_angle`, scope, { unit: "°" }).value;
        const a1 = amount(o.end_angle, `${where}.end_angle`, scope, { unit: "°" }).value;
        const sweep = (((a1 - a0) % 360) + 360) % 360;
        if (sweep < 1e-6) throw new InputError(`${where}: start_angle and end_angle are the same, so there's no arc. For a whole circle use a circle.`);
        const rad0 = (a0 * Math.PI) / 180;
        const at2 = (ang: number): [number, number] => [c[0].value + rad.value * Math.cos(ang), c[1].value + rad.value * Math.sin(ang)];
        const start = at2(rad0);
        const end = at2(rad0 + (sweep * Math.PI) / 180);
        const through = at2(rad0 + (sweep * Math.PI) / 360);
        const snapTo = (p: [number, number]): Placed => ({ x: p[0], y: p[1], snap: near(p, [0, 0]) ? { kind: "origin" } : null });
        const r = check(addArc(s, snapTo(start), snapTo(end), { x: through[0], y: through[1] }, construction), where);
        s = r.sketch;
        made.push({
          type,
          ids: [r.arcId],
          dims: (k) => {
            const arc = k.curves.find((x) => x.id === r.arcId) as Extract<SketchCurve, { type: "arc" }>;
            const posOf = (id: string): Candidate[] => {
              const p = k.points.find((q) => q.id === id);
              return p ? positionOf(id, fixed(p.x), fixed(p.y)) : [];
            };
            return [{ type: "radius", refs: [r.arcId], value: rad.text }, ...positionOf(arc.center, c[0], c[1]), ...posOf(arc.start), ...posOf(arc.end)];
          },
        });
        break;
      }
      case "slot": {
        const a = at("from");
        const b = at("to");
        const w = size("width");
        if (near(pt(a), pt(b))) throw new InputError(`${where}: "from" and "to" are the same point. They're the centres of the slot's two round ends, so they must differ (for a round hole use a circle).`);
        const r = check(addSlot(s, placed(a), placed(b), w.value / 2, construction), where);
        s = r.sketch;
        const half = Number.isFinite(Number(w.text)) ? tidy(w.value / 2) : `(${w.text}) / 2`;
        made.push({
          type,
          ids: r.curveIds,
          dims: (k) => {
            const axis = lineOf(k, r.axisId!);
            return [{ type: "radius", refs: [r.curveIds[2]], value: half }, ...positionOf(axis.p1, a[0], a[1]), ...positionOf(axis.p2, b[0], b[1])];
          },
        });
        break;
      }
      case "polygon": {
        const c = at("center");
        const sides = size("sides", { positive: true, integer: true, unit: "" });
        if (sides.value < 3 || sides.value > 64) throw new InputError(`${where}.sides must be between 3 and 64 (got ${sides.value}).`);
        const d = size("diameter");
        const across = oneOf(o.across, ["corners", "flats"] as const, `${where}.across`, "corners");
        const turn = o.angle === undefined ? 0 : amount(o.angle, `${where}.angle`, scope, { unit: "°" }).value;
        const ang = (turn * Math.PI) / 180;
        const pointer = { x: c[0].value + (d.value / 2) * Math.cos(ang), y: c[1].value + (d.value / 2) * Math.sin(ang) };
        const r = check(addPolygon(s, placed(c), pointer, sides.value, construction, across), where);
        s = r.sketch;
        made.push({
          type,
          ids: r.lineIds,
          dims: (k) => {
            const circle = k.curves.find((x) => x.id === r.sizeCircleId) as Extract<SketchCurve, { type: "circle" }>;
            const first = lineOf(k, r.lineIds[0]);
            const p = k.points.find((q) => q.id === first.p1)!;
            // Its turn: a side level or upright where there is one, otherwise a corner's position.
            const turnHeld: Candidate[] = r.lineIds.flatMap((id): Candidate[] => {
              const l = lineOf(k, id);
              const [a1, b1] = [k.points.find((x) => x.id === l.p1)!, k.points.find((x) => x.id === l.p2)!];
              if (Math.abs(a1.y - b1.y) < 1e-9) return [{ type: "horizontal", refs: [id] }];
              if (Math.abs(a1.x - b1.x) < 1e-9) return [{ type: "vertical", refs: [id] }];
              return [];
            });
            return [{ type: "diameter", refs: [circle.id], value: d.text }, ...positionOf(circle.center, c[0], c[1]), ...turnHeld, ...positionOf(p.id, fixed(p.x), fixed(p.y))];
          },
        });
        break;
      }
      case "outline": {
        if (!Array.isArray(o.points) || o.points.length < 2) throw new InputError(`${where}.points should be a list of at least 2 points [[x,y], [x,y], …].`);
        const pts = (o.points as unknown[]).map((p, j) => xy(p, `${where}.points[${j}]`, scope));
        const closed = bool(o.closed, `${where}.closed`, true);
        if (closed && pts.length < 3) throw new InputError(`${where}: a closed outline needs at least 3 points.`);
        const ids: string[] = [];
        const n = closed ? pts.length : pts.length - 1;
        for (let j = 0; j < n; j++) {
          const a = pts[j];
          const b = pts[(j + 1) % pts.length];
          if (near(pt(a), pt(b))) throw new InputError(`${where}.points[${j}] and the next point are the same; remove one.`);
          const orientation = Math.abs(a[1].value - b[1].value) < 1e-9 ? "horizontal" : Math.abs(a[0].value - b[0].value) < 1e-9 ? "vertical" : null;
          const r = check(addLine(s, placed(a), placed(b), { construction, orientation }), `${where}.points[${j}]`);
          s = joinTouching(r.sketch);
          ids.push(r.lineId);
        }
        made.push({
          type,
          ids,
          dims: (k) =>
            ids.flatMap((id, j) => {
              const l = lineOf(k, id);
              return j === 0 ? [...positionOf(l.p1, pts[0][0], pts[0][1]), ...positionOf(l.p2, pts[1][0], pts[1][1])] : positionOf(l.p2, pts[(j + 1) % pts.length][0], pts[(j + 1) % pts.length][1]);
            }),
        });
        break;
      }
      case "point": {
        const p = at("at");
        const r = check(addPoint(s, placed(p)), where);
        s = r.sketch;
        made.push({ type, ids: [r.pointId], dims: () => positionOf(r.pointId, p[0], p[1]) });
        break;
      }
    }
    s = joinTouching(s);
  });

  // Dimension everything, keeping each dimension only if it pins something down that wasn't already.
  let freedom = analyzeSketch(s).freedom;
  const curveIds = new Set(s.curves.map((c) => c.id));
  for (const shape of made) {
    // Points made by a shape keep their ids unless joined to another, so look them up again now.
    let candidates: Candidate[];
    try {
      candidates = shape.dims(s);
    } catch {
      continue;
    }
    for (const c of candidates) {
      if (freedom === 0) break;
      if (c.refs.some((r) => r !== ORIGIN_ID && !curveIds.has(r) && !s.points.some((p) => p.id === r))) continue;
      const next = { ...s, constraints: [...s.constraints, { id: sketchId(c.value !== undefined ? "d" : "c"), ...c }] };
      const solved = solveSketch(next);
      if (!solved.ok) continue;
      const f = analyzeSketch(solved.sketch).freedom;
      if (f < freedom) {
        s = solved.sketch;
        freedom = f;
      }
    }
  }
  s = settle(s).sketch;
  return { data: s, freedom, shapes: made.map((m) => ({ type: m.type, ids: m.ids })) };
}

