/** Checks sketch data loaded from storage, keeping only what's well-formed. */
import type { SketchPlane, Vec3 } from "./planes";
import { DIMENSION_TYPES, type ConstraintType, type SketchConstraint, type SketchCurve, type SketchData, type SketchPoint } from "./types";

const RELATIONS = new Set<string>([
  "coincident",
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "concentric",
  "midpoint",
  "symmetric",
  "pointOnLine",
  "pointOnCircle",
  "pointOnCurve",
  "fix",
]);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(num);

export function parsePlane(raw: unknown): SketchPlane | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.kind === "default" && (p.name === "Top" || p.name === "Front" || p.name === "Right")) return { kind: "default", name: p.name };
  if (p.kind === "face" && vec3(p.origin) && vec3(p.u) && vec3(p.v)) {
    return {
      kind: "face",
      origin: p.origin,
      u: p.u,
      v: p.v,
      label: typeof p.label === "string" ? p.label : "Face",
      ...(typeof p.planeRef === "string" ? { planeRef: p.planeRef } : {}),
    };
  }
  return null;
}

export function parseSketchData(raw: unknown): SketchData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.points) || !Array.isArray(d.curves) || !Array.isArray(d.constraints)) return null;

  const points: SketchPoint[] = [];
  for (const p of d.points as Record<string, unknown>[]) {
    if (!p || !str(p.id) || !num(p.x) || !num(p.y)) return null;
    points.push({ id: p.id, x: p.x, y: p.y, ...(p.standalone === true ? { standalone: true } : {}) });
  }
  const curves: SketchCurve[] = [];
  for (const c of d.curves as Record<string, unknown>[]) {
    if (!c || !str(c.id)) return null;
    const construction = c.construction === true;
    if (c.type === "line" && str(c.p1) && str(c.p2)) curves.push({ id: c.id, type: "line", p1: c.p1, p2: c.p2, construction });
    else if (c.type === "circle" && str(c.center) && num(c.radius)) curves.push({ id: c.id, type: "circle", center: c.center, radius: c.radius, construction });
    else if (c.type === "arc" && str(c.center) && str(c.start) && str(c.end))
      curves.push({ id: c.id, type: "arc", center: c.center, start: c.start, end: c.end, construction });
    else if (c.type === "spline" && Array.isArray(c.points) && c.points.length >= 2 && c.points.every(str))
      curves.push({
        id: c.id,
        type: "spline",
        points: c.points as string[],
        closed: c.closed === true && c.points.length >= 3 && typeof c.conic !== "number",
        construction,
        ...(typeof c.conic === "number" && c.conic > 0 && c.conic < 1 && c.points.length === 3 ? { conic: c.conic } : {}),
        ...splineHandlesOf(c.tangents, c.points as string[]),
      });
    else if (c.type === "ellipse" && str(c.center) && str(c.major) && str(c.minor))
      curves.push({ id: c.id, type: "ellipse", center: c.center, major: c.major, minor: c.minor, construction });
    else return null;
  }
  const constraints: SketchConstraint[] = [];
  for (const c of d.constraints as Record<string, unknown>[]) {
    if (!c || !str(c.id) || typeof c.type !== "string") return null;
    if (!RELATIONS.has(c.type) && !DIMENSION_TYPES.has(c.type as ConstraintType)) return null;
    if (!Array.isArray(c.refs) || !c.refs.every(str)) return null;
    const out: SketchConstraint = { id: c.id, type: c.type as ConstraintType, refs: c.refs as string[] };
    if (typeof c.value === "string") out.value = c.value;
    if (Array.isArray(c.extra) && c.extra.every(num)) out.extra = c.extra as number[];
    const lo = c.labelOffset as Record<string, unknown> | undefined;
    if (lo && num(lo.x) && num(lo.y)) out.labelOffset = { x: lo.x, y: lo.y };
    if (c.driven === true && DIMENSION_TYPES.has(out.type)) out.driven = true;
    constraints.push(out);
  }
  return { points, curves, constraints };
}

/** A spline's saved handles, keeping only those for its own points and with two finite numbers. */
function splineHandlesOf(raw: unknown, points: string[]): { tangents?: Record<string, [number, number]> } {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, [number, number]> = {};
  for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
    if (points.includes(id) && Array.isArray(t) && t.length === 2 && t.every((v) => typeof v === "number" && Number.isFinite(v))) out[id] = [t[0], t[1]];
  }
  return Object.keys(out).length ? { tangents: out } : {};
}
