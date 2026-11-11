/**
 * Setting up a feature from what Claude asks for: the same Feature records
 * the app's feature dialogs make, so the design opens and edits in the app
 * exactly as if it had been made there.
 *
 * Used for new features (starting from the app's defaults) and for edits
 * (changing only what's given).
 */
import { setMirrorReference, setPatternDirection } from "../model/patternRefs";
import type { Feature, FeatureType, JuraCADDocument, Operation } from "../model/types";
import type { PartMesh } from "../kernel/protocol";
import { SCREW_SIZES, standardParams } from "../model/holes";
import { planeFrame, planeOnFace, type SketchPlane, type Vec3 } from "../sketch/planes";
import { evaluate } from "../model/expr";
import { amount, bool, InputError, list, MAX_LENGTH, noExtras, oneOf, text, tidy, xy, xyz, type Obj } from "./args";
import { FEATURE_DEFS } from "../model/features";
import { isAngleDimension } from "../sketch/types";
import { pickEdges, pickFace, pickFaces, facing } from "./picks";
import type { Session } from "./session";
import { buildSketch } from "./sketchShapes";
import type { SketchData, SketchLine } from "../sketch/types";

/** The feature kinds Claude can add, by the name used in the tools. */
export const FEATURE_KINDS = {
  extrude: "extrude",
  revolve: "revolve",
  sweep: "sweep",
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
} as const satisfies Record<string, FeatureType>;
export type FeatureKind = keyof typeof FEATURE_KINDS;
export const KIND_OF: Partial<Record<FeatureType, FeatureKind>> = Object.fromEntries(Object.entries(FEATURE_KINDS).map(([k, v]) => [v, k as FeatureKind]));

const OPERATIONS = ["new", "add", "remove", "intersect"] as const;

/** The settings each kind takes (besides type, name and operation). */
export const KIND_KEYS: Record<FeatureKind, string[]> = {
  extrude: ["sketch", "depth", "end", "up_to_face", "up_to_part", "flip", "second_depth", "draft", "areas", "more_sketches"],
  revolve: ["sketch", "axis", "angle", "symmetric", "flip", "areas", "more_sketches"],
  sweep: ["sketch", "path", "twist", "keep_orientation", "areas", "more_sketches"],
  hole: ["sketch", "size", "fit", "style", "end", "depth", "diameter", "counterbore_diameter", "counterbore_depth", "countersink_diameter", "countersink_angle", "flip"],
  fillet: ["part", "edges", "radius", "end_radius"],
  chamfer: ["part", "edges", "distance", "second_distance", "angle", "flip_side"],
  shell: ["part", "faces", "thickness", "outside"],
  linear_pattern: ["features", "parts", "faces", "part", "direction", "count", "spacing", "flip", "direction2", "count2", "spacing2", "flip2", "skip"],
  circular_pattern: ["features", "parts", "faces", "part", "axis", "count", "angle", "center", "skip"],
  mirror: ["features", "part", "faces", "plane", "offset", "join"],
  boolean: ["op", "parts", "tools", "keep_tools"],
  composite_part: ["parts"],
  box: ["width", "depth", "height", "x", "y", "z"],
  cylinder: ["diameter", "height", "x", "y", "z"],
  sphere: ["diameter", "x", "y", "z"],
};

/** Most copies in one direction of a pattern, and in all (bigger takes minutes to build). */
export const MAX_PATTERN = 100;
export const MAX_PATTERN_TOTAL = 400;

/** Which kinds have New / Add / Remove / Intersect. */
const HAS_OPERATION: FeatureKind[] = ["extrude", "revolve", "sweep", "box", "cylinder", "sphere"];

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
      f.revolve = rv;
      param(f, a, "angle", "angle", ctx, { positive: true, unit: "°" });
      if (f.params.angle && Number(f.params.angle) > 360) throw new InputError("angle can be at most 360 (all the way round).");
      areas(f, a, ctx);
      moreSketches(f, a, ctx);
      break;
    }

    case "sweep": {
      const oldSketch = f.sketchRef;
      if (!ctx.editing && (!has(a, "sketch") || !has(a, "path"))) {
        throw new InputError('A sweep needs "sketch" (the one with the closed shape to carry) and "path" (another sketch with the lines and arcs to follow). Draw the shape on a plane across the start of the path.');
      }
      if (has(a, "sketch")) f.sketchRef = ctx.session.feature(a.sketch, "sketch", ["sketch"], ctx.doc).id;
      if (has(a, "path")) f.pathRef = ctx.session.feature(a.path, "path", ["sketch"], ctx.doc).id;
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
      break;
    }

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
      if (has(a, "edges") || !ctx.editing) {
        const part = ctx.session.part(ctx.parts, has(a, "part") ? a.part : (f.picks?.[0]?.partId ?? undefined), "part");
        f.picks = pickEdges(part, list(a.edges, "edges"), "edges");
      }
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
