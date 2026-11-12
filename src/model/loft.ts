/**
 * Loft's further choices (pure), as Onshape's Loft: sections that are sketches,
 * picked areas of sketches, flat faces of parts or (first/last) a point; how it
 * meets its ends; a guide curve or a path; lining up corners; a closed ring.
 * What a click in the 3D view changes while the Loft dialog is open, and what a
 * loft uses (for Delete with dependents and the sketches' eyes).
 */
import type { TopoPick } from "../geometry/topoRef";
import type { SketchData } from "../sketch/types";
import { nearEnd, type GeomClick } from "./geomClicks";
import { tidyVec } from "./transformPicks";
import type { Feature, GeomPick, LoftCurve, LoftDef, LoftEnd, LoftProfile } from "./types";

/** The loft's sections in order: its `profiles`, else each of `sections` as a whole sketch. */
export function loftProfiles(f: Pick<Feature, "sections" | "loft">): LoftProfile[] {
  return f.loft?.profiles ?? (f.sections ?? []).map((sketch) => ({ sketch }));
}

const isPlainSketch = (p: LoftProfile) => "sketch" in p && !p.areas?.length && p.turn === undefined;

/** A loft's def with empty or missing parts left out (null when nothing is left). */
function tidyDef(def: LoftDef): LoftDef | null {
  const out: LoftDef = {};
  for (const [k, v] of Object.entries(def) as [keyof LoftDef, unknown][]) {
    if (v === undefined || v === false) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The change that gives a loft these settings (`loft` dropped when nothing is set, so plain lofts stay as before). */
export function withLoftDef(f: Pick<Feature, "loft">, patch: Partial<LoftDef>): Pick<Feature, "loft"> {
  const def = tidyDef({ ...(f.loft ?? {}), ...patch });
  return { loft: def ?? undefined };
}

/**
 * The change that gives a loft these sections: `sections` = the sketches among them, and `loft.profiles` only when
 * any isn't a whole sketch (so a loft of whole sketches is saved exactly as before).
 */
export function withProfiles(f: Pick<Feature, "loft">, profiles: LoftProfile[]): Pick<Feature, "sections" | "loft"> {
  const sections = profiles.flatMap((p) => ("sketch" in p ? [p.sketch] : []));
  const plain = profiles.every(isPlainSketch);
  return { sections, ...withLoftDef(f, { profiles: plain ? undefined : profiles }) };
}

/** A plain description of a section, for the dialog's list. */
export function profileLabel(p: LoftProfile, name: (id: string) => string | undefined): string {
  if ("sketch" in p) return `${name(p.sketch) ?? "A deleted sketch"}${p.areas?.length ? " (one area)" : ""}`;
  if ("face" in p) return `A flat face of ${name(p.face.partId.split(/[~@]/)[0]) ?? "a part"}`;
  const g = p.point;
  if (g.sketchPoint) return `A point of ${name(g.sketchPoint.sketch) ?? "a deleted sketch"}`;
  if (g.pick) return `A corner of ${name(g.pick.partId.split(/[~@]/)[0]) ?? "a part"}`;
  return `The point (${g.p.map((v) => Math.round(v * 100) / 100).join(", ")})`;
}

/** What's wrong with the sections as listed (null when they're fine). */
export function profilesProblem(profiles: LoftProfile[]): string | null {
  if (profiles.length < 2) return "Pick at least two shapes to loft between.";
  const points = profiles.map((p, i) => ("point" in p ? i : -1)).filter((i) => i >= 0);
  if (points.some((i) => i !== 0 && i !== profiles.length - 1)) return "A point can only be the first or the last section of a loft.";
  if (points.length === profiles.length) return "A loft needs at least one shape besides the points.";
  return null;
}

/** Which end conditions a section can have: a point a rounded tip, a face carrying on from its neighbours too. */
export function endChoices(p: LoftProfile | undefined): LoftEnd["kind"][] {
  if (!p) return [];
  if ("point" in p) return ["tangent"];
  if ("face" in p) return ["normal", "matchTangent", "matchCurvature"];
  return ["normal"];
}

export const END_LABELS: Record<LoftEnd["kind"], string> = {
  normal: "Square to the shape",
  tangent: "Rounded tip",
  matchTangent: "Carry on from the faces round it",
  matchCurvature: "Carry on very smoothly from the faces",
};

/** End conditions that no longer fit their section (it was changed) are dropped. */
export function tidyEnds(def: LoftDef | undefined, profiles: LoftProfile[]): Partial<LoftDef> {
  const out: Partial<LoftDef> = {};
  if (def?.start && !endChoices(profiles[0]).includes(def.start.kind)) out.start = undefined;
  if (def?.end && !endChoices(profiles[profiles.length - 1]).includes(def.end.kind)) out.end = undefined;
  return out;
}

/** The standalone points of a sketch (placed on their own, not just curve ends), which a loft may start or end at. */
export function lonePoints(data: SketchData): { id: string; x: number; y: number }[] {
  return data.points.filter((p) => p.standalone && !p.link).map((p) => ({ id: p.id, x: p.x, y: p.y }));
}

const samePick = (a: TopoPick, b: TopoPick) => a.partId === b.partId && JSON.stringify(a.ref) === JSON.stringify(b.ref);
const stripAt = (p: TopoPick): TopoPick => ({ partId: p.partId, ref: p.ref });

/** The sections with the first (or last) set to a point, or with an end point taken off (`point` null). */
export function withEndPoint(profiles: LoftProfile[], which: "start" | "end", point: GeomPick | null): LoftProfile[] {
  const list = [...profiles];
  const i = which === "start" ? 0 : list.length - 1;
  if (list.length && "point" in list[i]) list.splice(i, 1);
  if (point) {
    if (which === "start") list.unshift({ point });
    else list.push({ point });
  }
  return list;
}

/** The sections with a flat face added (before an end point), or taken out when it's already there. */
export function toggleFace(profiles: LoftProfile[], face: TopoPick): LoftProfile[] {
  const at = profiles.findIndex((p) => "face" in p && samePick(p.face, face));
  if (at >= 0) return profiles.filter((_, i) => i !== at);
  const list = [...profiles];
  const endPoint = list.length > 1 && "point" in list[list.length - 1];
  list.splice(endPoint ? list.length - 1 : list.length, 0, { face: stripAt(face) });
  return list;
}

/** A section moved up or down the order (an end point stays where it is). */
export function moveProfile(profiles: LoftProfile[], i: number, by: -1 | 1): LoftProfile[] {
  const j = i + by;
  if (j < 0 || j >= profiles.length || "point" in profiles[i] || "point" in profiles[j]) return profiles;
  const list = [...profiles];
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

/** A guide or path with a part's edge added, or taken out when it's already in it. */
export function toggleEdge(curve: LoftCurve | undefined, edge: TopoPick): LoftCurve | undefined {
  const edges = curve && "edges" in curve ? curve.edges : [];
  const has = edges.some((e) => samePick(e, edge));
  const next = has ? edges.filter((e) => !samePick(e, edge)) : [...edges, stripAt(edge)];
  return next.length ? { edges: next } : undefined;
}

/**
 * A click in the 3D view while the Loft dialog is open: what it changes (a patch for the feature), or a message.
 * Faces are sections; a corner the start/end point; edges the guide or path.
 */
export function loftClick(f: Pick<Feature, "sections" | "loft">, c: GeomClick): Pick<Feature, "sections" | "loft"> | string {
  const picking = f.loft?.picking ?? "profile";
  const profiles = loftProfiles(f);
  if (picking === "guide" || picking === "path") {
    if (c.kind !== "part" || c.pick.ref.kind !== "edge") return `Click edges of a part for the ${picking}, or choose a sketch for it.`;
    return withLoftDef(f, { [picking]: toggleEdge(f.loft?.[picking], c.pick) });
  }
  if (picking === "start" || picking === "end") {
    if (c.kind !== "part" || c.pick.ref.kind !== "edge") return "Click a corner of a part (near the end of an edge).";
    const end = nearEnd(c.pick.ref, c.at);
    if (!end) return "Click nearer the end of the edge, at the corner you want.";
    const point: GeomPick = { p: tidyVec(c.pick.ref[end]), pick: stripAt(c.pick), end };
    const next = withEndPoint(profiles, picking, point);
    return { ...withProfiles({ loft: { ...f.loft, picking: undefined } }, next), ...{} };
  }
  if (c.kind !== "part" || c.pick.ref.kind !== "face") return "Click a flat face of a part to use it as a section, or tick sketches in the list.";
  if (c.pick.ref.surface !== "PLANE") return "That face is curved. A loft section must be a flat face.";
  const next = toggleFace(profiles, c.pick);
  const patch = withProfiles(f, next);
  return { ...patch, ...withLoftDef(patch, tidyEnds(patch.loft ?? undefined, next)) };
}

/** Every sketch a loft uses: its sections, points, guide and path. */
export function loftSketches(f: Pick<Feature, "sections" | "loft">): string[] {
  const out = new Set<string>(f.sections ?? []);
  for (const p of loftProfiles(f)) {
    if ("sketch" in p) out.add(p.sketch);
    if ("point" in p && p.point.sketchPoint) out.add(p.point.sketchPoint.sketch);
  }
  for (const c of [f.loft?.guide, f.loft?.path]) if (c && "sketch" in c) out.add(c.sketch);
  return [...out];
}

/** What a loft with further choices uses: its sections (sketches and parts), and the guide's and path's sketch or parts. */
export function loftUses(f: Pick<Feature, "sections" | "loft">): { sectionFeatures: string[]; sectionParts: string[]; features: string[]; parts: string[] } {
  const sectionFeatures: string[] = [];
  const sectionParts: string[] = [];
  for (const p of loftProfiles(f)) {
    if ("sketch" in p) sectionFeatures.push(p.sketch);
    else if ("face" in p) sectionParts.push(p.face.partId);
    else {
      if (p.point.sketchPoint) sectionFeatures.push(p.point.sketchPoint.sketch);
      else if (p.point.pick) sectionParts.push(p.point.pick.partId);
    }
  }
  const features: string[] = [];
  const parts: string[] = [];
  for (const c of [f.loft?.guide, f.loft?.path]) {
    if (!c) continue;
    if ("sketch" in c) features.push(c.sketch);
    else parts.push(...c.edges.map((e) => e.partId));
  }
  return { sectionFeatures, sectionParts, features, parts };
}

/** A loft with the sections that used deleted features or parts taken out (the same object when nothing changes). */
export function loftWithoutGone<F extends Pick<Feature, "sections" | "loft">>(f: F, featureGone: (id: string) => boolean, partGone: (id: string) => boolean): F {
  if (!f.loft?.profiles) return f;
  const gone = (p: LoftProfile) =>
    "sketch" in p ? featureGone(p.sketch) : "face" in p ? partGone(p.face.partId) : p.point.sketchPoint ? featureGone(p.point.sketchPoint.sketch) : p.point.pick ? partGone(p.point.pick.partId) : false;
  if (!f.loft.profiles.some(gone)) return f;
  return { ...f, ...withProfiles(f, f.loft.profiles.filter((p) => !gone(p))) };
}
