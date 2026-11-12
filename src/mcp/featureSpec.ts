/**
 * Setting up a feature from what Claude asks for: the same Feature records
 * the app's feature dialogs make, so the design opens and edits in the app
 * exactly as if it had been made there.
 *
 * Used for new features (starting from the app's defaults) and for edits
 * (changing only what's given).
 */
import { setMirrorReference, setPatternDirection } from "../model/patternRefs";
import type { BoundaryCurve, Feature, FeatureType, JuraCADDocument, LoftDef, LoftProfile, Operation } from "../model/types";
import { endChoices, loftProfiles, profilesProblem, tidyEnds, withEndPoint, withLoftDef, withProfiles } from "../model/loft";
import type { PartMesh } from "../kernel/protocol";
import { SCREW_SIZES, standardParams } from "../model/holes";
import { planeFrame, planeOnFace, type SketchPlane, type Vec3 } from "../sketch/planes";
import { evaluate } from "../model/expr";
import { amount, bool, InputError, list, MAX_LENGTH, noExtras, oneOf, text, tidy, xy, xyz, type Obj } from "./args";
import { FEATURE_DEFS, revolveWay } from "../model/features";
import { isAngleDimension } from "../sketch/types";
import { pickEdges, pickFace, pickFaces, facing } from "./picks";
import type { Session } from "./session";
import { buildSketch } from "./sketchShapes";
import { applyConnector, applyPlane, basePlane, CONNECTOR_KEYS, PLANE_KEYS } from "./planeSpec";
import { applyCurve, CURVE_KEYS } from "./curveSpec";
import type { SketchData, SketchLine } from "../sketch/types";

/** The feature kinds Claude can add, by the name used in the tools. */
export const FEATURE_KINDS = {
  extrude: "extrude",
  revolve: "revolve",
  sweep: "sweep",
  loft: "loft",
  hole: "hole",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
  linear_pattern: "linearPattern",
  circular_pattern: "circularPattern",
  mirror: "mirror",
  boolean: "boolean",
  composite_part: "composite",
  box: "box",
  cylinder: "cylinder",
  sphere: "sphere",
  plane: "plane",
  mate_connector: "mateConnector",
  curve: "curve",
  modify_fillet: "modifyFillet",
  split_face: "split",
  boundary_surface: "boundary",
  face_blend: "faceBlend",
} as const satisfies Record<string, FeatureType>;
export type FeatureKind = keyof typeof FEATURE_KINDS;
export const KIND_OF: Partial<Record<FeatureType, FeatureKind>> = Object.fromEntries(Object.entries(FEATURE_KINDS).map(([k, v]) => [v, k as FeatureKind]));

const OPERATIONS = ["new", "add", "remove", "intersect"] as const;

/** The settings each kind takes (besides type, name and operation). */
export const KIND_KEYS: Record<FeatureKind, string[]> = {
  extrude: ["sketch", "depth", "end", "up_to_face", "up_to_part", "flip", "second_depth", "draft", "areas", "more_sketches", "thin", "thin_other_side", "thin_centred", "thin_flip"],
  revolve: ["sketch", "axis", "angle", "symmetric", "second_angle", "flip", "areas", "more_sketches", "thin", "thin_other_side", "thin_centred", "thin_flip"],
  sweep: ["sketch", "path", "path_edges", "path_part", "twist", "keep_orientation", "areas", "more_sketches", "thin", "thin_other_side", "thin_centred", "thin_flip"],
  loft: ["sections", "start_point", "end_point", "start", "end", "start_magnitude", "end_magnitude", "guide", "path", "straight", "match_corners", "turns", "closed_loop"],
  hole: ["sketch", "size", "fit", "style", "end", "depth", "diameter", "counterbore_diameter", "counterbore_depth", "countersink_diameter", "countersink_angle", "flip"],
  fillet: ["part", "edges", "radius", "end_radius", "all_edges"],
  chamfer: ["part", "edges", "distance", "second_distance", "angle", "flip_side", "all_edges"],
  shell: ["part", "faces", "thickness", "outside"],
  linear_pattern: ["features", "parts", "faces", "part", "direction", "count", "spacing", "flip", "direction2", "count2", "spacing2", "flip2", "skip"],
  circular_pattern: ["features", "parts", "faces", "part", "axis", "count", "angle", "center", "skip"],
  mirror: ["features", "part", "faces", "plane", "offset", "join"],
  boolean: ["op", "parts", "tools", "keep_tools"],
  composite_part: ["parts"],
  box: ["width", "depth", "height", "x", "y", "z"],
  cylinder: ["diameter", "height", "x", "y", "z"],
  sphere: ["diameter", "x", "y", "z"],
  plane: PLANE_KEYS,
  mate_connector: CONNECTOR_KEYS,
  curve: CURVE_KEYS,
  modify_fillet: ["part", "faces", "radius", "remove", "propagate"],
  split_face: ["part", "faces", "plane", "offset", "sketch"],
  boundary_surface: ["u", "v"],
  face_blend: ["part", "faces", "part2", "faces2", "radius", "flip1", "flip2", "trim"],
};

/** Most copies in one direction of a pattern, and in all (bigger takes minutes to build). */
export const MAX_PATTERN = 100;
export const MAX_PATTERN_TOTAL = 400;

/** Which kinds have New / Add / Remove / Intersect. */
const HAS_OPERATION: FeatureKind[] = ["extrude", "revolve", "sweep", "loft", "box", "cylinder", "sphere"];

export interface SpecContext {
  session: Session;
  doc: JuraCADDocument;
  /** The parts as they are just before this feature (what its picks refer to). */
  parts: PartMesh[];
  scope: Record<string, number>;
  /** True when changing an existing feature (only what's given changes). */
  editing: boolean;
}

const has = (a: Obj, k: string) => a[k] !== undefined && a[k] !== null;

/** Set a size box (params[key]) from a number or maths, checked. */
function param(f: Feature, a: Obj, key: string, paramKey: string, ctx: SpecContext, opts: { positive?: boolean; min?: number; integer?: boolean; unit?: string; required?: boolean } = {}) {
  if (!has(a, key)) {
    if (opts.required && !ctx.editing) throw new InputError(`"${key}" is missing: give it as a number${opts.unit === "°" ? " of degrees" : opts.unit === "" ? "" : " in millimetres"}.`);
    return;
  }
  f.params = { ...f.params, [paramKey]: amount(a[key], key, ctx.scope, opts).text };
}

/** The sketch a feature uses: named, or (for a new feature) the latest one. */
function sketchRef(a: Obj, ctx: SpecContext, current: string | undefined): string {
  if (has(a, "sketch")) return ctx.session.feature(a.sketch, "sketch", ["sketch"], ctx.doc).id;
  if (current && ctx.editing) return current;
  const sketches = ctx.doc.features.filter((x) => x.type === "sketch" && !x.suppressed);
  const last = sketches[sketches.length - 1];
  if (!last) throw new InputError('There\'s no sketch to use yet. Draw one first with add_sketch, then give its name as "sketch".');
  return last.id;
}

/** Areas of a sketch to use: points inside them (sketch x, y). */
function areas(f: Feature, a: Obj, ctx: SpecContext) {
  if (!("areas" in a)) return;
  if (a.areas === null || (Array.isArray(a.areas) && a.areas.length === 0)) {
    delete f.areas;
    return;
  }
  f.areas = list(a.areas, "areas").map((p, i) => {
    const [x, y] = xy(p, `areas[${i}]`, ctx.scope);
    return [x.value, y.value] as [number, number];
  });
}

/**
 * Areas of other sketches the feature uses too (`moreAreas`, as clicked in the
 * app): [{ sketch, areas: [[x, y], …] }, …]; null or [] for none. Each sketch
 * once, not the feature's own sketch (nor a sweep's path), and above the
 * feature in the list.
 */
function moreSketches(f: Feature, a: Obj, ctx: SpecContext) {
  if (!("more_sketches" in a)) return;
  if (a.more_sketches === null || (Array.isArray(a.more_sketches) && a.more_sketches.length === 0)) {
    delete f.moreAreas;
    return;
  }
  if (f.surface) throw new InputError(`${f.name} makes a surface, which takes its shapes from one sketch; leave "more_sketches" out.`);
  const seen = new Set<string>();
  f.moreAreas = list(a.more_sketches, "more_sketches").map((m, i) => {
    const where = `more_sketches[${i}]`;
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new InputError(`${where} must be {"sketch": "<name>", "areas": [[x, y], …]}.`);
    const o = m as Obj;
    noExtras(o, ["sketch", "areas"], where);
    const sk = ctx.session.feature(o.sketch, `${where}.sketch`, ["sketch"], ctx.doc);
    if (sk.id === f.sketchRef) throw new InputError(`${where}: ${sk.name} is already the feature's own sketch; choose its areas with "areas" instead.`);
    if (f.type === "sweep" && sk.id === f.pathRef) throw new InputError(`${where}: ${sk.name} is the path, so it can't also be a shape swept along it.`);
    if (seen.has(sk.id)) throw new InputError(`${where}: ${sk.name} is listed twice; put all its areas in one entry.`);
    seen.add(sk.id);
    if (sk.suppressed) throw new InputError(`${where}: ${sk.name} is suppressed. Switch it back on first (edit_feature with "suppressed": false).`);
    if (ctx.editing && ctx.doc.features.indexOf(sk) > ctx.doc.features.findIndex((x) => x.id === f.id)) throw new InputError(`${where}: ${sk.name} comes after ${f.name} in the list, so it can't be used.`);
    const picks = list(o.areas, `${where}.areas`);
    return {
      sketch: sk.id,
      areas: picks.map((p, j) => {
        const [x, y] = xy(p, `${where}.areas[${j}]`, ctx.scope);
        return [x.value, y.value] as [number, number];
      }),
    };
  });
}

const LOFT_ENDS = { none: undefined, normal: "normal", rounded: "tangent", match_tangent: "matchTangent", match_curvature: "matchCurvature" } as const;

/**
 * Loft (Onshape's): "sections" in order — sketch names, or {"part", "face"} for a flat face — "start_point"/"end_point"
 * ([x, y, z] mm, a tip), "start"/"end" (none, normal, rounded — a point's tip —, match_tangent / match_curvature — a
 * face's neighbours), their magnitudes, a "guide" or "path" sketch, "straight", "match_corners" with "turns" (one whole
 * number per section), "closed_loop". The same records the dialog makes (src/model/loft.ts).
 */
function applyLoft(f: Feature, a: Obj, ctx: SpecContext) {
  let profiles = loftProfiles(f);
  if (has(a, "sections")) {
    const items = list(a.sections, "sections");
    profiles = items.map((x, i): LoftProfile => {
      const where = `sections[${i}]`;
      if (typeof x === "string") return { sketch: ctx.session.feature(x, where, ["sketch"], ctx.doc).id };
      if (!x || typeof x !== "object" || Array.isArray(x)) throw new InputError(`${where} must be a sketch's name, or {"part": "<name>", "face": "F3"} for a flat face.`);
      const o = x as Obj;
      noExtras(o, ["part", "face"], where);
      const part = ctx.session.part(ctx.parts, o.part, `${where}.part`);
      const face = pickFace(part, o.face, `${where}.face`);
      if (face.ref.surface !== "PLANE") throw new InputError(`${where}: ${face.id} isn't flat. A loft section must be a flat face.`);
      return { face: { partId: part.id, ref: face.ref } };
    });
  }
  for (const which of ["start", "end"] as const) {
    const key = `${which}_point`;
    if (!(key in a)) continue;
    const point = a[key] === null ? null : { p: xyz(a[key], key, ctx.scope).map((v) => v.value) as [number, number, number] };
    profiles = withEndPoint(profiles, which, point);
  }
  if (has(a, "turns")) {
    const turns = list(a.turns, "turns").map((t, i) => {
      if (typeof t !== "number" || !Number.isInteger(t)) throw new InputError(`turns[${i}] must be a whole number (how many corners to turn that section's start on).`);
      return t;
    });
    let k = 0;
    profiles = profiles.map((p) => ("point" in p ? p : { ...p, turn: turns[k++] ?? 0 }));
  }
  const problem = profilesProblem(profiles);
  if (problem) throw new InputError(problem);
  Object.assign(f, withProfiles(f, profiles));
  // Ends that no longer suit their section (it was changed) are dropped, as the app's dialog does.
  Object.assign(f, withLoftDef(f, tidyEnds(f.loft, profiles)));
  const def: Partial<LoftDef> = {};
  for (const which of ["start", "end"] as const) {
    if (has(a, which)) {
      const kind = LOFT_ENDS[oneOf(a[which], Object.keys(LOFT_ENDS) as (keyof typeof LOFT_ENDS)[], which)];
      const p = which === "start" ? profiles[0] : profiles[profiles.length - 1];
      if (kind && !endChoices(p).includes(kind)) throw new InputError(`"${which}": ${a[which]} doesn't suit that section. A point takes "rounded"; a sketch "normal"; a face "normal", "match_tangent" or "match_curvature".`);
      def[which] = kind ? { kind } : undefined;
    }
    const mk = `${which}_magnitude`;
    if (has(a, mk)) {
      const m = amount(a[mk], mk, ctx.scope, { positive: true, unit: "" }).value;
      if (m > 4) throw new InputError(`${mk} can be at most 4.`);
      const cur = def[which] ?? f.loft?.[which];
      if (!cur) throw new InputError(`"${mk}" needs "${which}" set too.`);
      def[which] = { ...cur, ...(m === 1 ? { magnitude: undefined } : { magnitude: m }) };
    }
  }
  for (const which of ["guide", "path"] as const) {
    if (!(which in a)) continue;
    def[which] = a[which] === null ? undefined : { sketch: ctx.session.feature(a[which], which, ["sketch"], ctx.doc).id };
  }
  if (has(a, "match_corners")) def.matchCorners = bool(a.match_corners, "match_corners") || undefined;
  if (has(a, "closed_loop")) def.periodic = bool(a.closed_loop, "closed_loop") || undefined;
  if (has(a, "straight")) f.loftRuled = bool(a.straight, "straight") || undefined;
  Object.assign(f, withLoftDef(f, def));
  if (!f.loft) delete f.loft;
  if (!f.loftRuled) delete f.loftRuled;
}

/** A default plane by name, optionally moved along its normal. */
export function namedPlane(name: unknown, offset: unknown, ctx: { scope: Record<string, number> }, where = "plane"): SketchPlane {
  const which = oneOf(name, ["Top", "Front", "Right"] as const, where);
  const base: SketchPlane = { kind: "default", name: which };
  if (offset === undefined || offset === null) return base;
  const d = amount(offset, "offset", ctx.scope);
  if (Math.abs(d.value) < 1e-12) return base;
  const fr = planeFrame(base);
  const origin: Vec3 = [fr.n[0] * d.value, fr.n[1] * d.value, fr.n[2] * d.value];
  return { kind: "face", origin, u: fr.u, v: fr.v, label: `${which} plane ${d.value > 0 ? "+" : "−"} ${Math.abs(d.value)} mm` };
}

/** A sketch plane on a flat face of a part. */
export function facePlane(ctx: SpecContext, partRef: unknown, faceSel: unknown): SketchPlane {
  const part = ctx.session.part(ctx.parts, partRef, "part");
  const face = pickFace(part, faceSel, "on_face");
  if (face.ref.surface !== "PLANE") throw new InputError(`on_face: ${face.id} of ${part.name} is ${face.kind}, not flat, so it can't be sketched on. Choose a flat face (see list_faces).`);
  const word = typeof faceSel === "string" && !/^f\d+$/i.test(faceSel.trim()) ? faceSel.trim().toLowerCase().replace(/ face$/, "") : face.id;
  return planeOnFace(face.ref.normal, face.ref.center, `${word[0].toUpperCase()}${word.slice(1)} face of ${part.name}`);
}

/** Plain words for where a sketch plane's axes point, so shapes can be placed on it. */
export function describePlane(plane: SketchPlane): string {
  const f = planeFrame(plane);
  const dir = (v: Vec3) => facing(v).replace(/ \(.*\)$/, "");
  const r = (x: number) => Math.round(x * 1000) / 1000 || 0;
  return `sketch x runs along world ${dir(f.u)}, sketch y along world ${dir(f.v)}, the sketch origin (0, 0) is at world (${f.origin.map(r).join(", ")}), and extrudes go towards ${dir(f.n)} (flip for ${dir([-f.n[0], -f.n[1], -f.n[2]])}); holes drill towards ${dir([-f.n[0], -f.n[1], -f.n[2]])}`;
}

/** Set up (or change) a sketch feature's plane and shapes. */
export function applySketch(f: Feature, a: Obj, ctx: SpecContext): { freedom: number; dimensioned: boolean } | null {
  noExtras(a, ["name", "plane", "offset", "on_face", "part", "shapes", ...(ctx.editing ? ["feature", "suppressed"] : [])], ctx.editing ? "edit_feature (sketch)" : "add_sketch");
  if (has(a, "on_face") && has(a, "plane")) throw new InputError('Give either "plane" (Top, Front or Right) or "on_face" (a face of a part), not both.');
  if (has(a, "offset") && has(a, "on_face")) throw new InputError('"offset" goes with "plane" (e.g. {"plane":"Top","offset":10}); to sketch on a face, leave it out.');
  let plane = f.sketch?.plane ?? null;
  if (has(a, "on_face")) plane = facePlane(ctx, a.part, a.on_face);
  // A Plane feature or mate connector by name (its plane, followed as it moves).
  else if (typeof a.plane === "string" && !["top", "front", "right"].includes(a.plane.trim().toLowerCase()) && !has(a, "offset")) plane = basePlane(a.plane, "plane", ctx);
  else if (has(a, "plane") || has(a, "offset")) plane = namedPlane(has(a, "plane") ? a.plane : plane?.kind === "default" ? plane.name : undefined, a.offset, ctx);
  else if (!ctx.editing) plane = { kind: "default", name: "Top" };
  let data = f.sketch?.data;
  let result: { freedom: number; dimensioned: boolean } | null = null;
  if (has(a, "shapes") || !ctx.editing) {
    const built = buildSketch(a.shapes, ctx.scope);
    // New shapes replace the drawing; text and pictures added in the app stay.
    data = data ? keepTextAndPictures(data, built.data) : built.data;
    result = { freedom: built.freedom, dimensioned: built.dimensioned };
  }
  f.sketch = { plane, data: data! };
  return result;
}

/**
 * Thin walls (Onshape's Thin): "thin" = the wall's thickness (0 or null: a plain solid again),
 * "thin_other_side" = a thickness on the other side too, "thin_centred" = the thickness shared both sides,
 * "thin_flip" = the other side first.
 */
function thinWall(f: Feature, a: Obj, ctx: SpecContext) {
  const keys = ["thin_other_side", "thin_centred", "thin_flip"];
  if ("thin" in a) {
    if (a.thin === null || a.thin === false || a.thin === 0) {
      delete f.thin;
      for (const k of keys) if (has(a, k)) throw new InputError(`"${k}" only goes with "thin" (the wall's thickness); leave it out when turning thin off.`);
      return;
    }
    if (f.surface) throw new InputError(`${f.name} makes a surface; a thin wall is a solid. Leave "thin" out.`);
    f.thin = { ...(f.thin ?? {}) };
    f.params = { ...f.params, thickness: amount(a.thin, "thin", ctx.scope, { positive: true }).text };
  } else if (keys.some((k) => has(a, k)) && !f.thin) throw new InputError('Give "thin" (the wall\'s thickness in mm) to make a thin wall; the other thin_ settings change it.');
  if (!f.thin) return;
  if (has(a, "thin_centred")) f.thin = { ...f.thin, midPlane: bool(a.thin_centred, "thin_centred") || undefined };
  if (has(a, "thin_flip")) f.thin = { ...f.thin, flip: bool(a.thin_flip, "thin_flip") || undefined };
  if (has(a, "thin_other_side")) {
    if (f.thin.midPlane) throw new InputError('"thin_other_side" isn\'t used with "thin_centred": true (the thickness is shared both sides); leave one out.');
    f.params = { ...f.params, thickness2: amount(a.thin_other_side, "thin_other_side", ctx.scope, { min: 0 }).text };
  }
  if (!f.thin.midPlane && !("thickness2" in f.params)) f.params = { ...f.params, thickness2: "0" };
  f.thin = { ...(f.thin.midPlane ? { midPlane: true } : {}), ...(f.thin.flip ? { flip: true } : {}) };
  // A thin wall goes round the picked areas (or along every curve); it takes no areas of other sketches, and doesn't taper.
  if (f.moreAreas) {
    if (has(a, "more_sketches")) throw new InputError('A thin wall follows the curves of its own sketch only; leave "more_sketches" out.');
    delete f.moreAreas;
  }
  // (A draft already set is left as it is: the engine leaves it out of a thin wall, with a note.)
  if (f.type === "extrude" && has(a, "draft") && amount(a.draft, "draft", ctx.scope).value !== 0) throw new InputError('A thin wall can\'t taper; leave "draft" out (or 0).');
}

const END_OF = { blind: "blind", symmetric: "symmetric", through_all: "throughAll", up_to_face: "upToFace" } as const;

/** Set up (or change) any other feature from Claude's settings. */
export function applyFeature(f: Feature, kind: FeatureKind, a: Obj, ctx: SpecContext): void {
  const common = ctx.editing ? ["feature", "name", "suppressed"] : ["type", "name"];
  noExtras(a, [...common, ...(HAS_OPERATION.includes(kind) ? ["operation"] : []), ...KIND_KEYS[kind]], `${kind}`);
  if (has(a, "operation")) f.operation = oneOf(a.operation, OPERATIONS, "operation") as Operation;

  switch (kind) {
    case "box":
      param(f, a, "width", "width", ctx, { positive: true, required: true });
      param(f, a, "depth", "depth", ctx, { positive: true, required: true });
      param(f, a, "height", "height", ctx, { positive: true, required: true });
      for (const k of ["x", "y", "z"]) param(f, a, k, k, ctx);
      break;
    case "cylinder":
      param(f, a, "diameter", "diameter", ctx, { positive: true, required: true });
      param(f, a, "height", "height", ctx, { positive: true, required: true });
      for (const k of ["x", "y", "z"]) param(f, a, k, k, ctx);
      break;
    case "sphere":
      param(f, a, "diameter", "diameter", ctx, { positive: true, required: true });
      for (const k of ["x", "y", "z"]) param(f, a, k, k, ctx);
      break;

    case "extrude": {
      const oldSketch = f.sketchRef;
      f.sketchRef = sketchRef(a, ctx, f.sketchRef);
      // A different sketch: the areas picked (in this sketch and any extra sketches) were the old one's.
      if (oldSketch && f.sketchRef !== oldSketch) {
        delete f.areas;
        delete f.moreAreas;
      }
      const ex = { ...(f.extrude ?? { end: "blind" as const, flip: false }) };
      if (has(a, "end")) ex.end = END_OF[oneOf(a.end, Object.keys(END_OF) as (keyof typeof END_OF)[], "end")];
      if (has(a, "flip")) ex.flip = bool(a.flip, "flip");
      else if (!ctx.editing && f.operation === "remove") {
        // A cut drawn on a face of the part goes into the part (the face's normal points out of it).
        const plane = ctx.doc.features.find((x) => x.id === f.sketchRef)?.sketch?.plane;
        if (plane?.kind === "face" && / face of /.test(plane.label)) ex.flip = true;
      }
      if (ex.end === "blind" || ex.end === "symmetric") param(f, a, "depth", "depth", ctx, { positive: true, required: !ctx.editing || !f.params.depth });
      else if (has(a, "depth")) throw new InputError(`"depth" isn't used when end is "${a.end ?? ex.end}"; leave it out.`);
      if (has(a, "second_depth")) {
        if (ex.end !== "blind") throw new InputError('"second_depth" (extruding the other way too) only goes with end "blind". For equal amounts both ways use end "symmetric".');
        const d = amount(a.second_depth, "second_depth", ctx.scope, { min: 0 });
        ex.second = d.value > 0;
        if (ex.second) f.params = { ...f.params, depth2: d.text };
      }
      if (ex.end !== "blind") delete ex.second;
      if (ex.end === "upToFace") {
        if (has(a, "up_to_face")) {
          const part = ctx.session.part(ctx.parts, a.up_to_part, "up_to_part");
          const face = pickFace(part, a.up_to_face, "up_to_face");
          if (face.ref.surface !== "PLANE") throw new InputError(`up_to_face: ${face.id} isn't flat. Extrude can go up to a flat face only.`);
          ex.upTo = { partId: part.id, ref: face.ref };
        } else if (!ex.upTo) throw new InputError('end "up_to_face" needs "up_to_face": the flat face to stop at, e.g. "top" or "F3" (and "up_to_part" if it isn\'t the latest part).');
      } else {
        if (has(a, "up_to_face")) throw new InputError('"up_to_face" only goes with end "up_to_face".');
        delete ex.upTo;
      }
      f.extrude = ex;
      param(f, a, "draft", "draft", ctx, { unit: "°" });
      areas(f, a, ctx);
      moreSketches(f, a, ctx);
      thinWall(f, a, ctx);
      break;
    }

    case "revolve": {
      const oldSketch = f.sketchRef;
      f.sketchRef = sketchRef(a, ctx, f.sketchRef);
      // A different sketch: the areas picked were the old one's (and the extra sketches' went round its axis).
      if (oldSketch && f.sketchRef !== oldSketch) {
        delete f.areas;
        delete f.moreAreas;
      }
      const rv = { ...(f.revolve ?? { axis: "vertical", flip: false }) };
      if (has(a, "axis")) {
        const sketch = ctx.doc.features.find((x) => x.id === f.sketchRef)?.sketch?.data;
        if (typeof a.axis === "string" && ["vertical", "horizontal"].includes(a.axis.toLowerCase())) rv.axis = a.axis.toLowerCase();
        else if (a.axis && typeof a.axis === "object" && !Array.isArray(a.axis)) {
          const o = a.axis as Obj;
          noExtras(o, ["from", "to"], "axis");
          const p = xy(o.from, "axis.from", ctx.scope).map((v) => v.value);
          const q = xy(o.to, "axis.to", ctx.scope).map((v) => v.value);
          const pos = (id: string): [number, number] => (id === "origin" ? [0, 0] : ((pt) => [pt?.x ?? NaN, pt?.y ?? NaN])(sketch?.points.find((x) => x.id === id)));
          const same = (u: [number, number], w: number[]) => Math.hypot(u[0] - w[0], u[1] - w[1]) < 1e-4;
          const line = sketch?.curves.find((c): c is SketchLine => c.type === "line" && ((same(pos(c.p1), p) && same(pos(c.p2), q)) || (same(pos(c.p1), q) && same(pos(c.p2), p))));
          if (!line) throw new InputError("axis: no line in the sketch runs between those two points. Add the axis to the sketch as a line (\"construction\": true keeps it out of the shape), or use \"vertical\" / \"horizontal\" (the sketch's own axes through its origin).");
          rv.axis = line.id;
        } else throw new InputError('axis must be "vertical" or "horizontal" (the sketch\'s axes through its origin), or {"from":[x,y],"to":[x,y]} naming a line in the sketch.');
      }
      if (has(a, "symmetric")) rv.symmetric = bool(a.symmetric, "symmetric") || undefined;
      if (has(a, "flip")) rv.flip = bool(a.flip, "flip");
      if (has(a, "second_angle")) {
        const d = amount(a.second_angle, "second_angle", ctx.scope, { min: 0, unit: "°" });
        if (d.value > 0 && rv.symmetric && !has(a, "symmetric")) delete rv.symmetric;
        if (d.value > 0 && rv.symmetric) throw new InputError('"second_angle" (spinning the other way too) doesn\'t go with "symmetric": true. Use one or the other.');
        if (d.value > 0) {
          rv.second = true;
          f.params = { ...f.params, angle2: d.text };
        } else delete rv.second;
      }
      if (rv.symmetric) delete rv.second;
      f.revolve = rv;
      param(f, a, "angle", "angle", ctx, { positive: true, unit: "°" });
      if (f.params.angle && Number(f.params.angle) > 360) throw new InputError("angle can be at most 360 (all the way round).");
      // Two ways with no angle given: kept to a full turn together, as the app's dialog does (360° → 180°).
      if (rv.second && !has(a, "angle")) {
        const kept = revolveWay({ ...f, revolve: rv }, "two").params.angle;
        if (kept !== undefined && amount(f.params.angle2 ?? "90", "second_angle", ctx.scope).value <= 180) f.params = { ...f.params, angle: kept };
      }
      if (rv.second) {
        const one = amount(f.params.angle ?? "360", "angle", ctx.scope).value;
        const two = amount(f.params.angle2 ?? "90", "second_angle", ctx.scope).value;
        if (one + two > 360 + 1e-9) throw new InputError(`angle + second_angle = ${one + two}°, more than a full turn (360). Make them smaller.`);
      }
      areas(f, a, ctx);
      moreSketches(f, a, ctx);
      thinWall(f, a, ctx);
      break;
    }

    case "sweep": {
      const oldSketch = f.sketchRef;
      if (!ctx.editing && (!has(a, "sketch") || (!has(a, "path") && !has(a, "path_edges")))) {
        throw new InputError('A sweep needs "sketch" (the one with the closed shape to carry) and "path" (another sketch, or a curve such as a helix) or "path_edges" (part edges joined end to end, on "path_part"). Draw the shape on a plane across the start of the path.');
      }
      if (has(a, "sketch")) f.sketchRef = ctx.session.feature(a.sketch, "sketch", ["sketch"], ctx.doc).id;
      if (has(a, "path")) {
        f.pathRef = ctx.session.feature(a.path, "path", ["sketch", "curve"], ctx.doc).id;
        delete f.pathEdges;
      }
      if (has(a, "path_edges")) {
        const part = ctx.session.part(ctx.parts, a.path_part, "path_part");
        f.pathEdges = pickEdges(part, list(a.path_edges, "path_edges"), "path_edges").filter((p) => p.ref.kind === "edge");
        if (!f.pathEdges.length) throw new InputError("path_edges: give edges (E-numbers from list_edges), not faces.");
        delete f.pathRef;
      }
      if (f.sketchRef === f.pathRef) throw new InputError("The shape and the path must be different sketches.");
      if (oldSketch && f.sketchRef !== oldSketch) {
        delete f.areas;
        delete f.moreAreas;
      }
      // The path chosen from one of the extra shapes: that sketch can't be both.
      if (f.moreAreas?.some((m) => m.sketch === f.pathRef)) {
        const rest = f.moreAreas.filter((m) => m.sketch !== f.pathRef);
        if (rest.length) f.moreAreas = rest;
        else delete f.moreAreas;
      }
      if (has(a, "keep_orientation")) {
        if (bool(a.keep_orientation, "keep_orientation")) f.sweepControl = { lockOrientation: true };
        else delete f.sweepControl;
      }
      if (has(a, "twist") && f.sweepControl?.lockOrientation) throw new InputError('"twist" isn\'t used with "keep_orientation": true (the shape keeps facing the same way); leave one out.');
      param(f, a, "twist", "twist", ctx, { unit: "°" });
      if (f.params.twist && Math.abs(Number(f.params.twist)) > 3600) throw new InputError("twist can be at most 3600° (10 turns) either way.");
      areas(f, a, ctx);
      moreSketches(f, a, ctx);
      thinWall(f, a, ctx);
      break;
    }

    case "loft":
      applyLoft(f, a, ctx);
      break;

    case "hole": {
      const h = { ...f.hole! };
      h.sketchRef = sketchRef(a, ctx, h.sketchRef);
      if (has(a, "style")) h.kind = oneOf(a.style, ["simple", "counterbore", "countersink"] as const, "style");
      if (has(a, "fit")) h.fit = oneOf(a.fit, ["clearance", "tapped"] as const, "fit");
      if (has(a, "end")) h.end = oneOf(a.end, ["through_all", "blind"] as const, "end") === "blind" ? "blind" : "throughAll";
      if (has(a, "flip")) h.flip = bool(a.flip, "flip");
      if (has(a, "size") && has(a, "diameter")) throw new InputError('Give either "size" (a screw size like "M4", which sets the hole sizes for you) or "diameter" (a custom hole), not both.');
      if (has(a, "size")) {
        const names = SCREW_SIZES.map((s) => s.name);
        const s = oneOf(a.size, [...names, "custom"] as const, "size");
        h.standard = s === "custom" ? "Custom" : s;
      } else if (has(a, "diameter")) h.standard = "Custom";
      else if (!ctx.editing) throw new InputError('Give "size" (a screw size: M2, M2.5, M3, M4, M5, M6, M8, M10 or M12) or "diameter" (in mm) for the hole.');
      if (h.standard !== "Custom") {
        // Standard sizes: the same numbers the app's Hole dialog fills in.
        f.params = { ...f.params, ...standardParams(h.standard, h.fit)! };
        for (const k of ["counterbore_diameter", "counterbore_depth", "countersink_diameter", "countersink_angle"]) {
          if (has(a, k)) throw new InputError(`"${k}" is set by the screw size ${h.standard}. Leave it out, or use "diameter" for a custom hole.`);
        }
      } else {
        param(f, a, "diameter", "diameter", ctx, { positive: true, required: !ctx.editing });
        param(f, a, "counterbore_diameter", "cboreDiameter", ctx, { positive: true });
        param(f, a, "counterbore_depth", "cboreDepth", ctx, { positive: true });
        param(f, a, "countersink_diameter", "cskDiameter", ctx, { positive: true });
        param(f, a, "countersink_angle", "cskAngle", ctx, { positive: true, unit: "°" });
      }
      if (h.end === "blind") param(f, a, "depth", "depth", ctx, { positive: true, required: !ctx.editing || !f.params.depth });
      else if (has(a, "depth")) throw new InputError('"depth" is for end "blind" holes; a "through_all" hole goes right through.');
      f.hole = h;
      break;
    }

    case "fillet":
    case "chamfer": {
      if (has(a, "all_edges")) f.allEdges = bool(a.all_edges, "all_edges") || undefined;
      if (f.allEdges && !has(a, "edges")) {
        // Every edge of the part: one pick says which part.
        if (!ctx.editing || has(a, "part")) {
          const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
          f.picks = pickFaces(part, ["F1"], "faces");
        }
      } else if (has(a, "edges") || !ctx.editing) {
        const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
        f.picks = pickEdges(part, list(a.edges, "edges"), "edges");
      }
      if (f.allEdges && f.chamferType) throw new InputError('"all_edges" works with an equal chamfer only (no second_distance or angle).');
      if (kind === "fillet") {
        param(f, a, "radius", "radius", ctx, { positive: true, required: true });
        param(f, a, "end_radius", "endRadius", ctx, { min: 0 });
      } else {
        param(f, a, "distance", "distance", ctx, { positive: true, required: true });
        if (has(a, "second_distance") && has(a, "angle")) throw new InputError('Give "second_distance" or "angle", not both (or neither, for an equal bevel).');
        if (has(a, "second_distance")) {
          param(f, a, "second_distance", "distance2", ctx, { positive: true });
          f.chamferType = "twoDistances";
        } else if (has(a, "angle")) {
          param(f, a, "angle", "angle", ctx, { positive: true, unit: "°" });
          f.chamferType = "distanceAngle";
        }
        if (has(a, "flip_side")) f.flipSide = bool(a.flip_side, "flip_side") || undefined;
      }
      break;
    }

    case "modify_fillet": {
      if (has(a, "faces") || !ctx.editing) {
        const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
        f.picks = pickFaces(part, list(a.faces, "faces"), "faces");
        const flat = f.picks.find((p) => p.ref.kind === "face" && p.ref.surface === "PLANE");
        if (flat) throw new InputError("faces: pick the rounded faces of fillets (list_faces shows them as cylinder or torus pieces), not flat ones.");
      }
      const mf = { ...(f.modifyFillet ?? {}) };
      if (has(a, "remove")) mf.remove = bool(a.remove, "remove") || undefined;
      if (has(a, "propagate")) mf.noPropagate = !bool(a.propagate, "propagate") || undefined;
      if (mf.remove && has(a, "radius")) throw new InputError('"radius" isn\'t used with "remove": true (the fillets are taken off); leave one out.');
      if (!mf.remove) param(f, a, "radius", "radius", ctx, { positive: true, required: !ctx.editing });
      const tidied = { ...(mf.remove ? { remove: true } : {}), ...(mf.noPropagate ? { noPropagate: true } : {}) };
      if (Object.keys(tidied).length) f.modifyFillet = tidied;
      else delete f.modifyFillet;
      break;
    }

    case "boundary_surface": {
      // Each curve: {"part", "edge", "match"?} (a part's edge), {"curve"} (a curve feature) or {"sketch"} (its curves).
      const curves = (v: unknown, where: string): BoundaryCurve[] =>
        list(v, where, { allowEmpty: true }).map((c, i) => {
          if (!c || typeof c !== "object") throw new InputError(`${where}[${i}]: give {"part": name, "edge": "E3"} for a part's edge, {"curve": name} or {"sketch": name}.`);
          const o = c as Obj;
          const match = has(o, "match") ? o.match : undefined;
          if (match !== undefined && match !== "tangent" && match !== "curvature" && match !== "none") throw new InputError(`${where}[${i}].match: "none", "tangent" or "curvature".`);
          if (has(o, "edge")) {
            const part = ctx.session.part(ctx.parts, has(o, "part") ? o.part : undefined, `${where}[${i}].part`);
            const [edge] = pickEdges(part, [o.edge], `${where}[${i}].edge`);
            if (!edge || edge.ref.kind !== "edge") throw new InputError(`${where}[${i}].edge: give one edge (an E-number from list_edges).`);
            return { edge, ...(match === "tangent" || match === "curvature" ? { match } : {}) };
          }
          if (match === "tangent" || match === "curvature") throw new InputError(`${where}[${i}]: "match" is only for part edges (it meets the face beside the edge).`);
          if (has(o, "curve")) return { curve: ctx.session.feature(o.curve, `${where}[${i}].curve`, ["curve"], ctx.doc).id };
          if (has(o, "sketch")) return { sketch: ctx.session.feature(o.sketch, `${where}[${i}].sketch`, ["sketch"], ctx.doc).id };
          throw new InputError(`${where}[${i}]: give {"part": name, "edge": "E3"}, {"curve": name} or {"sketch": name}.`);
        });
      const prev = f.boundary ?? { u: [], v: [] };
      const next = { u: has(a, "u") ? curves(a.u, "u") : prev.u, v: has(a, "v") ? curves(a.v, "v") : prev.v };
      if (next.u.length > 2 || next.v.length > 2) throw new InputError("u, v: at most two curves each way (the patch's opposite sides).");
      if (next.u.length + next.v.length < 2) throw new InputError('u: give at least two curves — two opposite sides (joined by straight lines), plus "v" for the other two sides if you like.');
      f.boundary = next;
      f.operation = "new";
      break;
    }

    case "face_blend": {
      if (has(a, "faces") || !ctx.editing) {
        const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
        f.picks = pickFaces(part, list(a.faces, "faces"), "faces");
      }
      const blend = { ...(f.blend ?? { side2: [] }) };
      if (has(a, "faces2") || !ctx.editing) {
        const part2 = ctx.session.part(ctx.parts, has(a, "part2") ? a.part2 : has(a, "part") ? a.part : (blend.side2[0]?.partId ?? undefined), "part2");
        blend.side2 = pickFaces(part2, list(a.faces2, "faces2"), "faces2");
      }
      if (has(a, "flip1")) blend.flip1 = bool(a.flip1, "flip1") || undefined;
      if (has(a, "flip2")) blend.flip2 = bool(a.flip2, "flip2") || undefined;
      if (has(a, "trim")) blend.noTrim = !bool(a.trim, "trim") || undefined;
      f.blend = Object.fromEntries(Object.entries(blend).filter(([, v]) => v !== undefined)) as typeof blend;
      param(f, a, "radius", "radius", ctx, { positive: true, required: !ctx.editing });
      f.operation = "new";
      break;
    }

    case "split_face": {
      if (ctx.editing && f.splitDef?.mode !== "face") throw new InputError("This Split cuts a part in two (it was made in the app); split_face can't change it. Edit it in the app instead.");
      if (has(a, "sketch") && (has(a, "plane") || has(a, "offset"))) throw new InputError('Split along either a "plane" (with "offset") or a "sketch" (its lines, pushed square to the sketch) — not both.');
      if (has(a, "faces") || !ctx.editing) {
        const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
        f.picks = pickFaces(part, list(a.faces, "faces"), "faces");
      }
      const sp = { ...(f.splitDef ?? { plane: { kind: "default", name: "Right" } as SketchPlane, keep: "both" as const }), mode: "face" as const, picking: "faces" as const };
      if (has(a, "sketch")) {
        f.sketchRef = sketchRef(a, ctx, f.sketchRef);
        sp.tool = "sketch";
      } else if (has(a, "plane") || has(a, "offset") || !ctx.editing) {
        if (!has(a, "plane") && !ctx.editing) throw new InputError('Give "plane": "Top", "Front" or "Right" (with "offset" to move it along its normal), or "sketch", to split the faces along.');
        sp.plane = namedPlane(has(a, "plane") ? a.plane : "Top", a.offset, ctx);
        delete sp.tool;
        delete f.sketchRef;
      }
      f.splitDef = sp;
      break;
    }

    case "shell": {
      if (has(a, "faces") || !ctx.editing) {
        const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
        f.picks = pickFaces(part, list(a.faces, "faces", { allowEmpty: true }), "faces");
      }
      param(f, a, "thickness", "thickness", ctx, { positive: true, required: true });
      if (has(a, "outside")) f.flipSide = bool(a.outside, "outside") || undefined;
      break;
    }

    case "linear_pattern":
    case "circular_pattern": {
      let p: NonNullable<Feature["pattern"]> = { ...(f.pattern ?? { sources: [], axis: "x" as const, flip: false }) };
      // Onshape's Pattern type: "features" (as before), whole "parts", or "faces" of one part (a boss, pocket or hole).
      const given = ["features", "parts", "faces"].filter((k) => has(a, k));
      if (given.length > 1) throw new InputError('Give one of "features" (features to repeat), "parts" (whole parts — each copy a new part) or "faces" (faces of one part: a boss, pocket or hole), not several.');
      if (has(a, "part") && !has(a, "faces")) throw new InputError('"part" goes with "faces" (the part the faces are on). To repeat whole parts, give "parts": ["Part 1", …].');
      if (has(a, "parts")) {
        const parts = list(a.parts, "parts").map((r, i) => ctx.session.part(ctx.parts, r, `parts[${i}]`).id);
        if (!parts.length) throw new InputError('"parts" needs at least one part.');
        p = { ...p, of: "part", parts, sources: [] };
        delete f.picks;
      } else if (has(a, "faces")) {
        const part = ctx.session.part(ctx.parts, a.part, "part");
        f.picks = pickFaces(part, list(a.faces, "faces"), "faces");
        const { parts: _parts, ...rest } = p;
        p = { ...rest, of: "face", sources: [] };
      } else if (has(a, "features") || !ctx.editing) {
        const { parts: _parts, of: _of, ...rest } = p;
        p = { ...rest, sources: list(a.features, "features").map((r, i) => ctx.session.feature(r, `features[${i}]`, undefined, ctx.doc).id) };
        delete f.picks;
      }
      if (has(a, "skip")) {
        const skip = [...new Set(list(a.skip, "skip", { allowEmpty: true }).map((n, i) => {
          if (typeof n !== "number" || !Number.isInteger(n) || n < 2) throw new InputError(`skip[${i}] must be a copy number, 2 or more (the original is 1).`);
          return n;
        }))].sort((x, y) => x - y);
        if (skip.length) p.skip = skip;
        else delete p.skip;
      }
      if (kind === "linear_pattern") {
        // A direction given here replaces anything clicked in the app (an edge, face or sketch line).
        if (has(a, "direction")) p = setPatternDirection(p, { kind: "axis", axis: oneOf(a.direction, ["x", "y", "z"] as const, "direction") });
        if (has(a, "flip")) p.flip = bool(a.flip, "flip");
        param(f, a, "count", "count", ctx, { positive: true, integer: true, min: 2, unit: "", required: true });
        param(f, a, "spacing", "spacing", ctx, { positive: true, required: true });
        if (has(a, "direction2")) p = setPatternDirection(p, { kind: "axis", axis: oneOf(a.direction2, ["x", "y", "z"] as const, "direction2") }, true);
        if (has(a, "flip2")) p.flip2 = bool(a.flip2, "flip2");
        param(f, a, "count2", "count2", ctx, { positive: true, integer: true, min: 1, unit: "" });
        param(f, a, "spacing2", "spacing2", ctx, { positive: true });
        if (Number(f.params.count2 ?? 1) > 1 && !p.axis2) throw new InputError('"count2" (rows) needs "direction2": "x", "y" or "z", different from "direction".');
      } else {
        if (has(a, "axis")) p = setPatternDirection(p, { kind: "axis", axis: oneOf(a.axis, ["x", "y", "z"] as const, "axis") });
        else if (!ctx.editing) p = setPatternDirection(p, { kind: "axis", axis: "z" });
        param(f, a, "count", "count", ctx, { positive: true, integer: true, min: 2, unit: "", required: true });
        param(f, a, "angle", "angle", ctx, { positive: true, unit: "°" });
        if (has(a, "center")) {
          const [x, y, z] = xyz(a.center, "center", ctx.scope);
          f.params = { ...f.params, cx: x.text, cy: y.text, cz: z.text };
        }
      }
      f.pattern = p;
      // Big patterns take minutes to build: keep them to a sensible size.
      const count = (key: string) => {
        const r = evaluate(f.params[key] ?? "1", ctx.scope);
        return r.ok ? r.value : 1;
      };
      const rows = kind === "linear_pattern" ? count("count2") : 1;
      if (count("count") > MAX_PATTERN || rows > MAX_PATTERN) throw new InputError(`A pattern can have at most ${MAX_PATTERN} copies in each direction (asked for ${Math.max(count("count"), rows)}).`);
      if (count("count") * rows > MAX_PATTERN_TOTAL) throw new InputError(`A pattern can have at most ${MAX_PATTERN_TOTAL} copies in all (asked for ${count("count")} × ${rows} = ${count("count") * rows}). Use fewer, or bigger spacing.`);
      break;
    }

    case "mirror": {
      let m: NonNullable<Feature["mirror"]> = { ...(f.mirror ?? { sources: [], plane: { kind: "default", name: "Right" } as SketchPlane }) };
      if (has(a, "features") && (has(a, "part") || has(a, "faces"))) throw new InputError('Mirror either "features" (copies of them across the plane), a whole "part", or "faces" of a part — not several.');
      if (has(a, "faces")) {
        // Faces of one part (a boss, pocket or hole): mirrored onto the same part. "part" names the part they're on.
        const part = ctx.session.part(ctx.parts, a.part, "part");
        f.picks = pickFaces(part, list(a.faces, "faces"), "faces");
        m.sources = [];
        m.of = "face";
        delete m.part;
        delete m.join;
        if (has(a, "join")) throw new InputError('"join" goes with mirroring a whole "part", not faces.');
      } else if (has(a, "features")) {
        m.sources = list(a.features, "features").map((r, i) => ctx.session.feature(r, `features[${i}]`, undefined, ctx.doc).id);
        delete m.part;
        delete m.join;
        delete m.of;
        delete f.picks;
      } else if (has(a, "part")) {
        delete m.of;
        delete f.picks;
        m.part = ctx.session.part(ctx.parts, a.part, "part").id;
        m.sources = [];
      } else if (!ctx.editing) throw new InputError('Give "features" (a list of features to mirror) or "part" (a whole part to mirror).');
      // A plane given here replaces anything clicked in the app (a face or sketch line), or "none chosen yet".
      if (has(a, "plane") || has(a, "offset")) m = setMirrorReference(m, { kind: "plane", plane: namedPlane(has(a, "plane") ? a.plane : "Right", a.offset, ctx) });
      else if (!ctx.editing) throw new InputError('Give "plane": "Top", "Front" or "Right" to mirror across (add "offset" to move it along its normal).');
      if (has(a, "join")) {
        if (!m.part) throw new InputError('"join" goes with mirroring a whole "part".');
        m.join = bool(a.join, "join") || undefined;
      }
      f.mirror = m;
      break;
    }

    case "plane":
      applyPlane(f, a, ctx);
      break;
    case "mate_connector":
      applyConnector(f, a, ctx);
      break;
    case "curve":
      applyCurve(f, a, ctx);
      break;
    case "composite_part": {
      if (has(a, "parts") || !ctx.editing) {
        const ids = [...new Set(list(a.parts, "parts").map((r, i) => ctx.session.part(ctx.parts, r, `parts[${i}]`).id))];
        if (ids.length < 2) throw new InputError('"parts" needs two or more different parts to group into a composite part.');
        f.compositeParts = ids;
      }
      break;
    }

    case "boolean": {
      const b = { ...f.booleanDef! };
      if (has(a, "op")) b.op = oneOf(a.op, ["union", "subtract", "intersect"] as const, "op");
      else if (!ctx.editing) throw new InputError('Give "op": "union" (join parts), "subtract" (cut "tools" from "parts") or "intersect" (keep where they overlap).');
      const parts = (k: string) => list(a[k], k).map((r, i) => ctx.session.part(ctx.parts, r, `${k}[${i}]`).id);
      if (has(a, "parts") || !ctx.editing) b.targets = parts("parts");
      if (has(a, "tools")) b.tools = parts("tools");
      if (b.op === "subtract" && !b.tools.length) throw new InputError('Subtract needs "tools": the parts that do the cutting.');
      if (has(a, "keep_tools")) b.keepTools = bool(a.keep_tools, "keep_tools");
      delete b.picking;
      f.booleanDef = b;
      break;
    }
  }
  if (has(a, "name")) f.name = text(a.name, "name").slice(0, 80);
  if (ctx.editing && has(a, "suppressed")) f.suppressed = bool(a.suppressed, "suppressed");
}

/**
 * Features whose sizes or pattern counts are past the limits with these
 * variable values (by feature id, with the reason). Checked on every change,
 * so changing a variable can't make a pattern of 5000 or a 1 km part.
 */
export function limitProblems(doc: JuraCADDocument, scope: Record<string, number>): Map<string, string> {
  const out = new Map<string, string>();
  const value = (src: string | undefined) => {
    if (src === undefined) return null;
    const r = evaluate(src, scope);
    return r.ok ? r.value : null;
  };
  for (const f of doc.features) {
    if (f.suppressed) continue;
    if (f.type === "linearPattern" || f.type === "circularPattern") {
      const count = value(f.params.count) ?? 1;
      const rows = f.type === "linearPattern" ? (value(f.params.count2) ?? 1) : 1;
      if (count > MAX_PATTERN || rows > MAX_PATTERN) {
        out.set(f.id, `a pattern can have at most ${MAX_PATTERN} copies in each direction (this would be ${Math.max(count, rows)})`);
        continue;
      }
      if (count * rows > MAX_PATTERN_TOTAL) {
        out.set(f.id, `a pattern can have at most ${MAX_PATTERN_TOTAL} copies in all (this would be ${count} × ${rows} = ${count * rows})`);
        continue;
      }
    }
    for (const p of FEATURE_DEFS[f.type].params) {
      if (p.unit !== undefined && p.unit !== "mm") continue;
      const v = value(f.params[p.key]);
      if (v !== null && Math.abs(v) > MAX_LENGTH) {
        out.set(f.id, `its ${p.label.toLowerCase()} would be ${tidy(v)} mm — sizes can be at most ${MAX_LENGTH} mm (10 m)`);
        break;
      }
    }
    if (out.has(f.id) || !f.sketch) continue;
    for (const c of f.sketch.data.constraints) {
      if (c.value === undefined || c.driven || isAngleDimension(c)) continue;
      const v = value(c.value);
      if (v !== null && Math.abs(v) > MAX_LENGTH) {
        out.set(f.id, `a dimension would be ${tidy(v)} mm — sizes can be at most ${MAX_LENGTH} mm (10 m)`);
        break;
      }
    }
  }
  return out;
}

/** The text (with the points it hangs from, as loose points) and pictures of `old`, added to `next`. */
export function keepTextAndPictures(old: SketchData, next: SketchData): SketchData {
  const texts = old.texts ?? [];
  const images = old.images ?? [];
  if (!texts.length && !images.length) return next;
  const have = new Set(next.points.map((p) => p.id));
  const anchors = old.points.filter((p) => texts.some((t) => t.anchor === p.id) && !have.has(p.id)).map((p) => ({ id: p.id, x: p.x, y: p.y, standalone: true }));
  return { ...next, points: [...next.points, ...anchors], ...(texts.length ? { texts } : {}), ...(images.length ? { images } : {}) };
}
