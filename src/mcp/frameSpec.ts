/**
 * Frames from Claude's settings (Frame, Trim frame, Gusset) — the same records the app's dialogs make — and the
 * describe_cut_list tool.
 */
import type { Feature } from "../model/types";
import type { FrameCornerChoice, FrameDef, FrameProfileKind } from "../model/frameTypes";
import { PROFILE_KINDS, ANCHORS } from "../model/frameProfiles";
import { frameLayout, frameCutList, cutListCsv, cutListLines, sketchPathSegments, type PathSeg } from "../model/frame";
import { amount, bool, InputError, list, noExtras, oneOf, text, xyz, type Obj } from "./args";
import { basePlane } from "./planeSpec";
import type { SpecContext } from "./featureSpec";
import { say, type ToolDef } from "./toolKit";

const has = (a: Obj, k: string) => a[k] !== undefined && a[k] !== null;

export const FRAME_KEYS = ["sketches", "profile", "size", "width", "height", "wall", "profile_sketch", "anchor", "mirror", "angle", "gap", "merge_tangent", "corners"];
export const TRIM_KEYS = ["members", "plane", "to_part", "flip"];
export const GUSSET_KEYS = ["members", "size", "thickness", "chamfer", "other_side"];

const KINDS = PROFILE_KINDS.map((k) => k.kind);

export const FRAME_HELP = `frame (Onshape's Frame: a profile along sketch lines and arcs, each length its own part, corners mitred where two meet and butted where three meet or one ends on another's side): sketches (the sketches whose lines/arcs/circles make the path; construction lines left out), profile (${KINDS.map((k) => `"${k}"`).join(" | ")}, or "sketch" with profile_sketch: a sketch with the closed cross-section), size (${PROFILE_KINDS.map((k) => `${k.kind}: ${k.sizes.map((s) => s.key).join(", ")}${k.custom ? ', or "custom" with width/height/wall' : ""}`).join("; ")}), anchor (which point of the profile sits on the path: ${ANCHORS.map((a) => a.key).join(", ")}), mirror, angle (° turned about the path), gap (mm left at mitres and butt joints), merge_tangent (default true: lines and arcs carrying on smoothly are one member), corners ([{"at":[x,y,z], "type":"mitre"|"butt"|"coped"|"none", "through": member number that runs through for butt/coped}]). Profiles stand with their height along the sketch's normal. describe_cut_list lists the lengths to cut`;
export const TRIM_HELP = 'trim_frame (Onshape\'s Trim frame): members (frame member part names), and plane ("Top"|"Front"|"Right", a Plane name, or {"point":[x,y,z],"normal":[x,y,z]}) — keeps the side with more of each member, or the other with flip — or to_part (cut where each member meets that part, keeping the biggest piece)';
export const GUSSET_HELP = "gusset (Onshape's Gusset): members (two frame member parts meeting at a corner), size (mm along each, default 60), thickness (default 5), chamfer (mm: cut the inside corner off; 0 = none), other_side (where one member ends on the other's side: the plate goes the other way along it)";

/** The path's segments, as the dialog sees them (sketch planes as saved). */
function pathSegments(def: FrameDef, ctx: SpecContext): PathSeg[] {
  const segs: PathSeg[] = [];
  for (const p of def.paths) {
    const sk = ctx.doc.features.find((f) => f.id === p.sketch);
    if (sk?.sketch?.plane) segs.push(...sketchPathSegments(sk.id, sk.sketch.plane, sk.sketch.data, p.items).segs);
  }
  return segs;
}

export function applyFrame(f: Feature, a: Obj, ctx: SpecContext): void {
  const def: FrameDef = { ...(f.frame ?? { paths: [], profile: { kind: "extrusion", size: "2020" } }) };
  if (has(a, "sketches")) def.paths = list(a.sketches, "sketches").map((r, i) => ({ sketch: ctx.session.feature(r, `sketches[${i}]`, ["sketch"], ctx.doc).id }));
  else if (!ctx.editing) throw new InputError('A frame needs "sketches": the sketches whose lines and arcs it follows.');
  if (!def.paths.length) throw new InputError('"sketches" needs at least one sketch.');
  if (has(a, "profile")) {
    const kind = oneOf(a.profile, [...KINDS, "sketch"] as const, "profile");
    if (kind === "sketch") {
      if (!has(a, "profile_sketch")) throw new InputError('profile "sketch" needs "profile_sketch": the sketch with the closed cross-section.');
      def.profile = { kind: "sketch", sketch: ctx.session.feature(a.profile_sketch, "profile_sketch", ["sketch"], ctx.doc).id };
    } else {
      const info = PROFILE_KINDS.find((k) => k.kind === kind)!;
      const size = has(a, "size") ? text(a.size, "size") : info.sizes[0].key;
      if (size !== "custom" && !info.sizes.some((s) => s.key === size)) throw new InputError(`size: ${kind} comes in ${info.sizes.map((s) => s.key).join(", ")}${info.custom ? ', or "custom" (with width, height, wall)' : ""}.`);
      if (size === "custom" && !info.custom) throw new InputError(`size: ${kind} only comes in the listed sizes.`);
      def.profile = { kind: kind as FrameProfileKind, size };
    }
  } else if (has(a, "size") && def.profile.kind !== "sketch") def.profile = { ...def.profile, size: text(a.size, "size") };
  if (def.paths.some((p) => def.profile.kind === "sketch" && p.sketch === def.profile.sketch)) throw new InputError("The profile's sketch can't also be the path.");
  const params: Record<string, string> = {};
  for (const k of ["width", "height", "wall"]) if (has(a, k)) params[k] = amount(a[k], k, ctx.scope, { positive: true }).text;
  if (has(a, "angle")) params.angle = amount(a.angle, "angle", ctx.scope, { unit: "°" }).text;
  if (has(a, "gap")) params.gap = amount(a.gap, "gap", ctx.scope, { min: 0 }).text;
  f.params = { ...f.params, ...params };
  if (has(a, "anchor")) {
    const an = oneOf(a.anchor, ANCHORS.map((x) => x.key), "anchor");
    if (an === "centre") delete def.anchor;
    else def.anchor = an as FrameDef["anchor"];
  }
  if (has(a, "mirror")) {
    if (bool(a.mirror, "mirror")) def.mirror = true;
    else delete def.mirror;
  }
  if (has(a, "merge_tangent")) {
    if (bool(a.merge_tangent, "merge_tangent")) delete def.noMerge;
    else def.noMerge = true;
  }
  if (has(a, "corners")) {
    const segs = pathSegments(def, ctx);
    const { members, corners } = frameLayout(segs, { noMerge: def.noMerge });
    const chosen: FrameCornerChoice[] = list(a.corners, "corners", { allowEmpty: true }).map((raw, i) => {
      if (!raw || typeof raw !== "object") throw new InputError(`corners[${i}] should be {"at":[x,y,z],"type":…}.`);
      const c = raw as Obj;
      const [x, y, z] = xyz(c.at, `corners[${i}].at`, ctx.scope).map((v) => v.value);
      const near = corners.map((k) => ({ k, d: Math.hypot(k.at[0] - x, k.at[1] - y, k.at[2] - z) })).sort((p, q) => p.d - q.d)[0];
      if (!near || near.d > 1) throw new InputError(`corners[${i}]: there's no corner of the frame at (${x}, ${y}, ${z}). Its corners are at ${corners.map((k) => `(${k.at.map((v) => Math.round(v * 100) / 100).join(", ")})`).join(", ") || "nowhere (no members meet)"}.`);
      const type = oneOf(c.type, ["mitre", "butt", "coped", "none"] as const, `corners[${i}].type`);
      if (!near.k.choices.includes(type)) throw new InputError(`corners[${i}]: a mitre needs exactly two members meeting; use "butt", "coped" or "none" there.`);
      let through: string | undefined;
      if (has(c, "through")) {
        const n = amount(c.through, `corners[${i}].through`, ctx.scope, { integer: true, unit: "" }).value - 1;
        const end = near.k.ends.find((e) => e.member === n);
        if (!end) throw new InputError(`corners[${i}].through: member ${n + 1} doesn't end at that corner (members ${near.k.ends.map((e) => e.member + 1).join(", ")} do).`);
        const m = members[n];
        through = end.end === 0 ? m.segs[0].id : m.segs[m.segs.length - 1].id;
      }
      return { key: near.k.key, type, ...(through ? { through } : {}) };
    });
    if (chosen.length) def.corners = chosen;
    else delete def.corners;
  }
  f.frame = def;
  f.operation = "new";
}

export function applyTrimFrame(f: Feature, a: Obj, ctx: SpecContext): void {
  const def = { ...(f.trimFrame ?? { parts: [] }) };
  delete def.picking;
  if (has(a, "members")) def.parts = [...new Set(list(a.members, "members").map((r, i) => ctx.session.part(ctx.parts, r, `members[${i}]`).id))];
  else if (!ctx.editing) throw new InputError('trim_frame needs "members": the frame members to trim.');
  if (has(a, "plane")) {
    const v = a.plane;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const p = v as Obj;
      const o = xyz(p.point, "plane.point", ctx.scope).map((x) => x.value) as [number, number, number];
      const n = xyz(p.normal, "plane.normal", ctx.scope).map((x) => x.value) as [number, number, number];
      const l = Math.hypot(...n);
      if (l < 1e-9) throw new InputError("plane.normal can't be [0, 0, 0].");
      const nn = n.map((x) => x / l) as [number, number, number];
      const helper: [number, number, number] = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u0 = [helper[1] * nn[2] - helper[2] * nn[1], helper[2] * nn[0] - helper[0] * nn[2], helper[0] * nn[1] - helper[1] * nn[0]];
      const ul = Math.hypot(...u0);
      const u = u0.map((x) => x / ul) as [number, number, number];
      const w: [number, number, number] = [nn[1] * u[2] - nn[2] * u[1], nn[2] * u[0] - nn[0] * u[2], nn[0] * u[1] - nn[1] * u[0]];
      def.plane = { kind: "face", origin: o, u, v: w, label: "Trim plane" };
    } else def.plane = basePlane(v, "plane", ctx);
    delete def.to;
  }
  if (has(a, "to_part")) {
    def.to = ctx.session.part(ctx.parts, a.to_part, "to_part").id;
    delete def.plane;
  }
  if (!def.plane && !def.to) throw new InputError('trim_frame needs "plane" or "to_part": what to trim the members to.');
  if (has(a, "flip")) {
    if (bool(a.flip, "flip")) def.flip = true;
    else delete def.flip;
  }
  f.trimFrame = def;
}

export function applyGusset(f: Feature, a: Obj, ctx: SpecContext): void {
  const def = { ...(f.gusset ?? { parts: [] }) };
  if (has(a, "members")) {
    const ids = [...new Set(list(a.members, "members").map((r, i) => ctx.session.part(ctx.parts, r, `members[${i}]`).id))];
    if (ids.length !== 2) throw new InputError('"members" needs exactly two different frame members meeting at a corner.');
    def.parts = ids;
  } else if (!ctx.editing) throw new InputError('A gusset needs "members": the two frame members meeting at the corner.');
  for (const k of ["size", "thickness"]) if (has(a, k)) f.params = { ...f.params, [k]: amount(a[k], k, ctx.scope, { positive: true }).text };
  if (has(a, "chamfer")) {
    const c = amount(a.chamfer, "chamfer", ctx.scope, { min: 0 });
    if (c.value > 0) {
      def.chamfer = true;
      f.params = { ...f.params, chamfer: c.text };
    } else delete def.chamfer;
  }
  if (has(a, "other_side")) {
    if (bool(a.other_side, "other_side")) def.flip = true;
    else delete def.flip;
  }
  f.gusset = def;
  f.operation = "new";
}

export const FRAME_TOOLS: ToolDef[] = [
  {
    name: "describe_cut_list",
    title: "Frame cut list",
    description:
      "The cut list of the frame members in the Part Studio on show (Onshape's Cut list): identical members grouped, with profile, cut length (longest point to longest point), end cuts (degrees from square, or coped), quantity and weight (from each part's material, else aluminium for extrusion, steel for box/angle/tube/flat bar, oak for timber), then the total length and weight per profile. With csv: true the same as CSV text.",
    inputSchema: { type: "object", properties: { csv: { type: "boolean" } } },
    readOnly: true,
    run: (s, a) => {
      noExtras(a, ["csv"], "describe_cut_list");
      const parts = s.build().parts;
      const list = frameCutList(parts, s.doc.materials);
      if (bool(a.csv, "csv")) return say(list.rows.length ? cutListCsv(list) : "There are no frame members.");
      return say(...cutListLines(list));
    },
  },
];
