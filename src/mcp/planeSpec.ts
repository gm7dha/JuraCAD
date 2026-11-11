/**
 * Plane features (all of Onshape's types JuraCAD has) and Part Studio mate
 * connectors from Claude's settings: the same records the app's dialogs make.
 * Points and lines are given as things on parts (a corner, an edge, a face),
 * sketch points, mate connectors or the X/Y/Z axes, so they follow the model.
 */
import type { Feature, GeomPick, MateConnectorDef, PlaneOptions } from "../model/types";
import { planeFrame, type SketchPlane, type Vec3 } from "../sketch/planes";
import { framesOf, planeAsSketchPlane, planeFeatureFrame } from "../sketch/planeFeature";
import { amount, bool, InputError, list, noExtras, oneOf, text, xyz, type Obj } from "./args";
import { pickEdges, pickFace } from "./picks";
import { connectorFrame } from "../assembly/connectors";
import type { SpecContext } from "./featureSpec";
import { geomPickLabel } from "../sketch/planeTypes";

const has = (a: Obj, k: string) => a[k] !== undefined && a[k] !== null;

/** What the tools call each type, and the app's name for it. */
export const PLANE_TYPES = {
  offset: "offset",
  angle: "angle",
  point: "point",
  point_normal: "pointNormal",
  line_angle: "lineAngle",
  three_point: "threePoint",
  curve_point: "curvePoint",
  fit: "fit",
} as const;
const TYPE_NAME = Object.fromEntries(Object.entries(PLANE_TYPES).map(([k, v]) => [v, k])) as Record<string, string>;

export const POINT_HELP =
  'A point is [x, y, z] (fixed), {"corner": "E3", "end": "start"|"end"|"middle", "part": name} (an edge\'s end or middle: follows the part), {"face": "F2" or "top"…, "part": name} (a flat face\'s centre), {"sketch": name, "point": [x, y] (the nearest of its points) or "origin"}, or {"connector": name} (a mate connector\'s origin).';
export const LINE_HELP =
  'A line is "x", "y" or "z" (an axis through the origin), {"edge": "E3", "part": name} (a straight or round edge — a round one gives its axis), {"face": "F2", "part": name} (a flat face\'s normal, or a round face\'s axis), {"sketch": name, "line": [x, y] (the line nearest that point)} or {"connector": name} (its Z axis).';

/** A part's corner, edge or face, a sketch point/line, a connector or an axis, as Claude names it. */
function geomFrom(v: unknown, where: string, ctx: SpecContext, as: "point" | "line"): GeomPick {
  if (Array.isArray(v)) {
    if (as === "line") throw new InputError(`${where}: ${LINE_HELP}`);
    const [x, y, z] = xyz(v, where, ctx.scope);
    return { p: [x.value, y.value, z.value] };
  }
  if (typeof v === "string") {
    const axis = v.trim().toLowerCase();
    if (as === "line" && (axis === "x" || axis === "y" || axis === "z")) return { p: [0, 0, 0], dir: axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1], axis };
    throw new InputError(`${where}: ${as === "point" ? POINT_HELP : LINE_HELP}`);
  }
  if (!v || typeof v !== "object") throw new InputError(`${where}: ${as === "point" ? POINT_HELP : LINE_HELP}`);
  const o = v as Obj;
  if (has(o, "connector")) {
    noExtras(o, ["connector"], where);
    const c = ctx.session.feature(o.connector, `${where}.connector`, ["mateConnector"], ctx.doc);
    const frame = framesOf(ctx.doc.features, ctx.scope, ctx.session.build().followed).get(c.id);
    return { p: frame?.origin ?? [0, 0, 0], ...(frame ? { dir: frame.n } : {}), connector: c.id };
  }
  if (has(o, "sketch")) {
    noExtras(o, ["sketch", "point", "line"], where);
    const sk = ctx.session.feature(o.sketch, `${where}.sketch`, ["sketch"], ctx.doc);
    if (!sk.sketch?.plane) throw new InputError(`${where}: ${sk.name} isn't on a plane yet.`);
    const frame = planeFrame(sk.sketch.plane);
    const world = (x: number, y: number): Vec3 => [frame.origin[0] + x * frame.u[0] + y * frame.v[0], frame.origin[1] + x * frame.u[1] + y * frame.v[1], frame.origin[2] + x * frame.u[2] + y * frame.v[2]];
    const near = (key: string): [number, number] => {
      const q = o[key];
      if (!Array.isArray(q) || q.length !== 2) throw new InputError(`${where}.${key} should be [x, y] in ${sk.name}'s own coordinates.`);
      return [amount(q[0], `${where}.${key}[0]`, ctx.scope).value, amount(q[1], `${where}.${key}[1]`, ctx.scope).value];
    };
    const d = sk.sketch.data;
    if (as === "line" || has(o, "line")) {
      const [x, y] = near("line");
      const lines = d.curves.filter((c) => c.type === "line");
      const pos = (id: string) => (id === "origin" ? { x: 0, y: 0 } : d.points.find((p) => p.id === id));
      let best: { id: string; a: { x: number; y: number }; b: { x: number; y: number }; gap: number } | null = null;
      for (const c of lines) {
        if (c.type !== "line") continue;
        const a = pos(c.p1);
        const b = pos(c.p2);
        if (!a || !b) continue;
        const gap = Math.hypot((a.x + b.x) / 2 - x, (a.y + b.y) / 2 - y);
        if (!best || gap < best.gap) best = { id: c.id, a, b, gap };
      }
      if (!best) throw new InputError(`${where}: ${sk.name} has no straight lines.`);
      const pa = world(best.a.x, best.a.y);
      const pb = world(best.b.x, best.b.y);
      return { p: pa, dir: [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], sketchLine: { sketch: sk.id, line: best.id } };
    }
    if (o.point === "origin") return { p: frame.origin, sketchPoint: { sketch: sk.id, point: "origin" } };
    const [x, y] = near("point");
    const pts = [{ id: "origin", x: 0, y: 0 }, ...d.points];
    const best = pts.reduce((m, p) => (Math.hypot(p.x - x, p.y - y) < Math.hypot(m.x - x, m.y - y) ? p : m));
    return { p: world(best.x, best.y), sketchPoint: { sketch: sk.id, point: best.id } };
  }
  const part = ctx.session.part(ctx.parts, o.part, `${where}.part`);
  if (has(o, "face")) {
    noExtras(o, ["face", "part"], where);
    const face = pickFace(part, o.face, `${where}.face`);
    const pick = { partId: part.id, ref: face.ref };
    return { p: face.ref.center, dir: face.ref.normal, pick };
  }
  const key = has(o, "corner") ? "corner" : has(o, "edge") ? "edge" : null;
  if (!key) throw new InputError(`${where}: ${as === "point" ? POINT_HELP : LINE_HELP}`);
  noExtras(o, [key, "end", "part"], where);
  const picks = pickEdges(part, [o[key]], `${where}.${key}`);
  if (picks.length !== 1 || picks[0].ref.kind !== "edge") throw new InputError(`${where}.${key}: give one edge (E-number from list_edges), not a face.`);
  const pick = picks[0];
  const ref = pick.ref as Extract<typeof pick.ref, { kind: "edge" }>;
  if (as === "line") {
    if (ref.curve === "LINE") return { p: ref.a, dir: [ref.b[0] - ref.a[0], ref.b[1] - ref.a[1], ref.b[2] - ref.a[2]], pick };
    // A round edge: its axis (through its centre, square to it), as in the app.
    const index = part.edgeRefs.indexOf(ref);
    const axis = index >= 0 && ref.curve === "CIRCLE" ? connectorFrame(part, "edge", index) : null;
    if (!axis) throw new InputError(`${where}.${key}: that edge is neither straight nor round, so it gives no line. Choose a straight or round edge, a face, or an axis.`);
    return { p: axis.origin, dir: axis.z, pick };
  }
  const end = oneOf(o.end, ["start", "end", "middle"] as const, `${where}.end`, "middle");
  return { p: end === "start" ? ref.a : end === "end" ? ref.b : ref.mid, pick, end: end === "start" ? "a" : end === "end" ? "b" : "mid" };
}

/** The plane a "point" plane is parallel to, or an offset/angle plane starts from: Top/Front/Right or a Plane feature / mate connector. */
export function basePlane(v: unknown, where: string, ctx: Pick<SpecContext, "session" | "doc" | "scope">): SketchPlane {
  if (typeof v === "string" && ["top", "front", "right"].includes(v.trim().toLowerCase())) {
    const n = v.trim().toLowerCase();
    return { kind: "default", name: n === "top" ? "Top" : n === "front" ? "Front" : "Right" };
  }
  const f = ctx.session.feature(v, where, ["plane", "mateConnector"], ctx.doc);
  const frame = framesOf(ctx.doc.features, ctx.scope, ctx.session.build().followed).get(f.id);
  if (!frame) throw new InputError(`${where}: ${f.name} can't be placed as things are, so it can't be used.`);
  return planeAsSketchPlane(f, frame);
}

export const PLANE_KEYS = ["plane_type", "from", "points", "point", "line", "angle", "distance", "tilt_about", "position", "flip"];

/** Set up (or change) a Plane feature. */
export function applyPlane(f: Feature, a: Obj, ctx: SpecContext): void {
  const pd: PlaneOptions = { ...(f.planeDef ?? { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" }) };
  if (has(a, "plane_type")) {
    const mode = PLANE_TYPES[oneOf(a.plane_type, Object.keys(PLANE_TYPES) as (keyof typeof PLANE_TYPES)[], "plane_type")];
    if (mode !== pd.mode) {
      delete pd.points;
      delete pd.line;
      delete pd.position;
      delete pd.ref2;
    }
    pd.mode = mode;
  }
  if (has(a, "from")) pd.ref = basePlane(a.from, "from", ctx);
  if (has(a, "point")) pd.points = [geomFrom(a.point, "point", ctx, "point")];
  if (has(a, "points")) pd.points = list(a.points, "points").map((p, i) => geomFrom(p, `points[${i}]`, ctx, "point"));
  if (has(a, "line")) {
    if (pd.mode === "curvePoint") pd.points = [geomFrom(a.line, "line", ctx, "point")];
    else pd.line = geomFrom(a.line, "line", ctx, "line");
  }
  if (has(a, "tilt_about")) pd.axis = oneOf(a.tilt_about, ["across", "up"] as const, "tilt_about") === "up" ? "v" : "u";
  if (has(a, "position")) pd.position = Math.min(1, Math.max(0, amount(a.position, "position", ctx.scope, { unit: "" }).value));
  if (has(a, "flip")) pd.flip = bool(a.flip, "flip") || undefined;
  if (!pd.flip) delete pd.flip;
  if (has(a, "distance")) f.params = { ...f.params, distance: amount(a.distance, "distance", ctx.scope).text };
  if (has(a, "angle")) f.params = { ...f.params, angle: amount(a.angle, "angle", ctx.scope, { unit: "°" }).text };
  if (pd.mode === "curvePoint" && pd.points?.[0] && !pd.points[0].pick) throw new InputError('A curve point plane needs "line": {"edge": "E3", "part": name} — the edge it stands square to.');
  if (pd.mode === "fit" && (pd.points?.length ?? 0) < 3) throw new InputError('A fit plane needs "points": at least three.');
  // Checked with the numbers as given (the build checks them again on the model).
  const frame = planeFeatureFrame(pd, { angle: Number(f.params.angle ?? 30) || 0, distance: Number(f.params.distance ?? 0) || 0 });
  if (typeof frame === "string" && pd.mode !== "offset" && pd.mode !== "angle") throw new InputError(frame);
  f.planeDef = pd;
}

export const CONNECTOR_KEYS = ["at", "on_plane", "spot", "owner", "flip_z", "move", "turn"];

/** Set up (or change) a Part Studio mate connector. */
export function applyConnector(f: Feature, a: Obj, ctx: SpecContext): void {
  const c: MateConnectorDef = { ...(f.connector ?? { at: { p: [0, 0, 0] }, plane: { kind: "default", name: "Top" }, base: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } }) };
  if (has(a, "at") && has(a, "on_plane")) throw new InputError('Give "at" (a corner, edge, face or sketch point) or "on_plane", not both.');
  if (has(a, "at")) {
    const v = a.at;
    // An edge (not a corner) for a connector: Z along it, or a round edge's centre.
    const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
    const g = o && has(o, "edge") ? geomFrom({ corner: o.edge, part: o.part, end: "middle" }, "at", ctx, "point") : geomFrom(v, "at", ctx, "point");
    const spot = has(a, "spot") ? oneOf(a.spot, ["start", "end", "middle"] as const, "spot") : g.end === "a" ? "start" : g.end === "b" ? "end" : o && has(o, "edge") ? undefined : g.end === "mid" ? "middle" : undefined;
    delete g.end;
    c.at = { ...g, ...(spot && g.pick?.ref.kind === "edge" ? { spot } : {}) };
    delete c.plane;
  } else if (has(a, "on_plane")) {
    c.plane = basePlane(a.on_plane, "on_plane", ctx);
    c.at = { p: planeFrame(c.plane).origin };
  }
  if (has(a, "owner")) c.owner = ctx.session.part(ctx.parts, text(a.owner, "owner"), "owner").id;
  if (has(a, "flip_z")) c.flipZ = bool(a.flip_z, "flip_z") || undefined;
  if (!c.flipZ) delete c.flipZ;
  const three = (key: string, keys: [string, string, string], unit?: string) => {
    if (!has(a, key)) return;
    const v = list(a[key], key);
    if (v.length !== 3) throw new InputError(`"${key}" should be [x, y, z]${unit ? " in degrees" : " in millimetres"}, along/about the connector's own axes.`);
    v.forEach((x, i) => (f.params = { ...f.params, [keys[i]]: amount(x, `${key}[${i}]`, ctx.scope, unit ? { unit } : {}).text }));
  };
  three("move", ["dx", "dy", "dz"]);
  three("turn", ["rx", "ry", "rz"], "°");
  f.connector = c;
}

/** Plain words for a plane or connector, for describe_design. */
export function describeMore(f: Feature, nameOf: (id: string) => string | undefined, built?: { origin: Vec3; n: Vec3 }): string {
  const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  if (f.type === "mateConnector" && f.connector) {
    const c = f.connector;
    // Where it is as built (its moves and turns included), else where it was clicked.
    const o = (built?.origin ?? c.base.origin).map((v) => Math.round(v * 100) / 100 + 0).join(", ");
    const z = (built?.n ?? c.base.z).map((v) => Math.round(v * 1000) / 1000 + 0).join(", ");
    const p = f.params;
    const moved = ["dx", "dy", "dz", "rx", "ry", "rz"].filter((k) => p[k] && p[k] !== "0").map((k) => `${k} ${p[k]}`);
    const where = c.plane && !c.at.pick && !c.at.sketchPoint && !c.at.connector ? `on ${c.plane.kind === "default" ? `the ${c.plane.name} plane` : c.plane.label}` : `at ${lc(geomPickLabel(c.at, nameOf))}${c.at.spot ? ` (${c.at.spot})` : ""}`;
    return `mate connector ${where}, origin (${o}), Z (${z})${c.flipZ ? ", Z turned over" : ""}${moved.length ? `, ${moved.join(", ")}` : ""}${c.owner ? `, owned by ${nameOf(c.owner) ?? c.owner}` : ""}`;
  }
  const pd = f.planeDef!;
  const type = TYPE_NAME[pd.mode] ?? pd.mode;
  const pts = (pd.points ?? []).map((g) => lc(geomPickLabel(g, nameOf)));
  const line = pd.line ? lc(geomPickLabel(pd.line, nameOf)) : null;
  const p = f.params;
  switch (pd.mode) {
    case "offset":
      return `plane ${p.distance ?? 20} mm from ${pd.ref.kind === "default" ? pd.ref.name : pd.ref.label}`;
    case "angle":
      return `plane tilted ${p.angle ?? 30}° from ${pd.ref.kind === "default" ? pd.ref.name : pd.ref.label}`;
    case "midplane":
      return "plane halfway between two faces (made in the app)";
    case "point":
      return `plane (point) through ${pts[0] ?? "?"}, parallel to ${pd.ref.kind === "default" ? pd.ref.name : pd.ref.label}`;
    case "pointNormal":
      return `plane (point_normal) through ${pts[0] ?? "?"}, square to ${line ?? "?"}`;
    case "lineAngle":
      return `plane (line_angle) through ${line ?? "?"}, turned ${p.angle ?? 30}°`;
    case "curvePoint":
      return `plane (curve_point) square to ${pts[0] ?? "?"}, ${Math.round((pd.position ?? 0.5) * 100)}% along it`;
    default:
      return `plane (${type}) through ${pts.length} points: ${pts.join(", ")}`;
  }
}
