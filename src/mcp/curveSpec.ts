/**
 * Curve features from Claude's settings (Helix, Projected, Bridging, Composite, Fit spline, Intersection curves): the
 * same records the app's Curve dialogs make. Points and lines are given as for planes (see planeSpec.ts), plus
 * {"curve": name, "end": "start"|"end"|"middle"}.
 */
import { curveName, newCurveDef } from "../model/curves";
import type { BridgeMatch, CurveDef, CurveKind, Feature } from "../model/types";
import { bool, InputError, list, oneOf, type Obj } from "./args";
import { pickEdges, pickFaces } from "./picks";
import { basePlane, geomFrom, LINE_HELP, POINT_HELP } from "./planeSpec";
import type { SpecContext } from "./featureSpec";
import { amount } from "./args";

const has = (a: Obj, k: string) => a[k] !== undefined && a[k] !== null;

export const CURVE_TYPES = {
  helix: "helix",
  projected: "projected",
  bridging: "bridge",
  composite: "composite",
  fit_spline: "fitSpline",
  intersection: "intersection",
} as const satisfies Record<string, CurveKind>;

export const CURVE_KEYS = [
  "curve_type",
  "axis",
  "start",
  "around",
  "part",
  "height",
  "turns",
  "pitch",
  "diameter",
  "start_angle",
  "taper",
  "clockwise",
  "flip",
  "sketch",
  "faces",
  "second_sketch",
  "from",
  "to",
  "match_from",
  "match_to",
  "flip_from",
  "flip_to",
  "bulge",
  "edges",
  "curves",
  "points",
  "closed",
  "plane",
];

export const CURVE_HELP =
  `curve (a curve, not a part — a sweep's path (sweep "path": the curve's name) or a curve pattern's): curve_type "helix" | "projected" | "bridging" | "composite" | "fit_spline" | "intersection". ` +
  `helix: axis (a line, default "z") and start (a point: sets the radius) or diameter; or around {"face": "F2" or {"edge": "E3"}, "part": name} (a round face — its whole height — or a round edge); two of height / turns / pitch (default height + turns; on a face, turns or pitch); start_angle (°), taper (° wider as it rises), clockwise, flip. ` +
  `projected: sketch + faces (on part) — the sketch pressed onto the faces straight across from its plane; or sketch + second_sketch — where the two sketches' curves meet when each is pushed out from its own plane. ` +
  `bridging: from, to (points; an edge's or curve's end matches its direction), match_from / match_to ("position" | "tangent" default | "curvature"), flip_from, flip_to, bulge (default 1). ` +
  `composite: edges (on part) and/or curves (names) joined end to end. fit_spline: points (in order, at least 2), closed. intersection: faces (on part; the first against the others) or faces + plane ("Top"|"Front"|"Right" or a Plane name). ` +
  `${POINT_HELP} ${LINE_HELP}`;

/** Fill in a curve feature from Claude's settings. */
export function applyCurve(f: Feature, a: Obj, ctx: SpecContext): void {
  let def: CurveDef = f.curve ?? newCurveDef("helix");
  if (has(a, "curve_type") || !ctx.editing) {
    const t = oneOf(a.curve_type, Object.keys(CURVE_TYPES) as (keyof typeof CURVE_TYPES)[], "curve_type");
    const kind = CURVE_TYPES[t];
    if (kind !== def.kind || !ctx.editing) {
      def = newCurveDef(kind);
      if (!ctx.editing) f.name = curveName(ctx.doc.features, kind);
    }
  }
  delete def.picking;
  const param = (key: string, paramKey: string, opts: { positive?: boolean; unit?: string } = {}) => {
    if (has(a, key)) f.params = { ...f.params, [paramKey]: amount(a[key], key, ctx.scope, opts).text };
  };
  const flag = (key: string) => (has(a, key) ? bool(a[key], key) || undefined : undefined);
  const part = () => ctx.session.part(ctx.parts, a.part, "part");
  switch (def.kind) {
    case "helix": {
      if (has(a, "around")) {
        const o = a.around as Obj;
        if (!o || typeof o !== "object") throw new InputError('around: {"face": "F2", "part": name} or {"edge": "E3", "part": name}.');
        const p = ctx.session.part(ctx.parts, o.part, "around.part");
        const pick = has(o, "face") ? pickFaces(p, [o.face], "around.face")[0] : pickEdges(p, [o.edge], "around.edge")[0];
        if (!pick) throw new InputError("around: give one round face or round edge.");
        def = { ...def, around: "face", on: pick, axis: undefined, start: undefined };
      }
      if (has(a, "axis")) def = { ...def, around: "axis", on: undefined, axis: geomFrom(a.axis, "axis", ctx, "line") };
      if (has(a, "start")) def = { ...def, start: geomFrom(a.start, "start", ctx, "point") };
      const given = ["height", "turns", "pitch"].filter((k) => has(a, k));
      if (given.length === 3) throw new InputError("Give two of height, turns and pitch (the third follows).");
      if (given.length === 2) def.helixBy = given.includes("height") ? (given.includes("turns") ? undefined : "heightPitch") : "turnsPitch";
      else if (given.length === 1 && def.around === "face") def.helixBy = given[0] === "pitch" ? "heightPitch" : undefined;
      param("height", "height", { positive: true });
      param("turns", "turns", { positive: true, unit: "" });
      param("pitch", "pitch", { positive: true });
      param("diameter", "diameter", { positive: true });
      param("start_angle", "startAngle", { unit: "°" });
      param("taper", "taper", { unit: "°" });
      if (has(a, "clockwise")) def.clockwise = flag("clockwise");
      if (has(a, "flip")) def.flip = flag("flip");
      break;
    }
    case "projected": {
      if (has(a, "sketch")) f.sketchRef = ctx.session.feature(a.sketch, "sketch", ["sketch"], ctx.doc).id;
      if (!f.sketchRef) throw new InputError('A projected curve needs "sketch" (the one with the curves to project).');
      if (has(a, "second_sketch")) def = { ...def, project: "sketches", sketch2: ctx.session.feature(a.second_sketch, "second_sketch", ["sketch"], ctx.doc).id };
      else if (has(a, "faces")) {
        def = { ...def, project: "faces", sketch2: undefined };
        f.picks = pickFaces(part(), list(a.faces, "faces"), "faces");
      } else if (!ctx.editing) throw new InputError('Give "faces" (on "part") to project onto, or "second_sketch".');
      break;
    }
    case "bridge": {
      if (has(a, "from")) def.from = geomFrom(a.from, "from", ctx, "point");
      if (has(a, "to")) def.to = geomFrom(a.to, "to", ctx, "point");
      if (!def.from || !def.to) throw new InputError('A bridging curve needs "from" and "to".');
      const match = (k: string) => oneOf(a[k], ["position", "tangent", "curvature"] as const, k, "tangent") as BridgeMatch;
      if (has(a, "match_from")) def.matchFrom = match("match_from");
      if (has(a, "match_to")) def.matchTo = match("match_to");
      if (has(a, "flip_from")) def.flipFrom = flag("flip_from");
      if (has(a, "flip_to")) def.flipTo = flag("flip_to");
      param("bulge", "bulge", { positive: true, unit: "" });
      break;
    }
    case "composite": {
      if (has(a, "edges")) f.picks = pickEdges(part(), list(a.edges, "edges"), "edges");
      if (has(a, "curves")) def.curves = list(a.curves, "curves").map((c, i) => ctx.session.feature(c, `curves[${i}]`, ["curve"], ctx.doc).id);
      if (!f.picks?.length && !def.curves?.length) throw new InputError('A composite curve needs "edges" (on "part") and/or "curves" to join.');
      break;
    }
    case "fitSpline": {
      if (has(a, "points")) def.points = list(a.points, "points").map((p, i) => geomFrom(p, `points[${i}]`, ctx, "point"));
      if ((def.points ?? []).length < 2) throw new InputError('A fit spline needs "points": at least two, in order.');
      if (has(a, "closed")) def.closed = flag("closed");
      break;
    }
    case "intersection": {
      if (has(a, "faces")) f.picks = pickFaces(part(), list(a.faces, "faces"), "faces");
      if (has(a, "plane")) def.plane = basePlane(a.plane, "plane", ctx);
      if (!f.picks?.length) throw new InputError('An intersection curve needs "faces" (on "part").');
      break;
    }
  }
  f.curve = def;
}
