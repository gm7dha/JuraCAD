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
  "pointOnLine",
  "pointOnCircle",
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
    return { kind: "face", origin: p.origin, u: p.u, v: p.v, label: typeof p.label === "string" ? p.label : "Face" };
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
    constraints.push(out);
  }
  return { points, curves, constraints };
}
