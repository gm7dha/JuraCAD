/**
 * Delete with dependents (pure), as Onshape's Delete dialog: given features
 * picked in a Part Studio, the later features that use them — directly or
 * through another feature that goes — so they can all be deleted in one go.
 *
 * A feature "uses" another when it names it (an extrude's sketch, a sweep's
 * path, a loft's sections, a pattern's or mirror's features, a plane or sketch
 * line it's measured from), or when it picks faces or edges of a part that the
 * other made (a fillet on an extrude's edge, a sketch on its face, an extrude
 * "up to" its face, a pattern along its edge…). Parts are known by the id of
 * the feature that made them ("<feature>", "<feature>~2", "<feature>@<config>").
 *
 * Some features keep working when only some of what they use goes: a fillet
 * whose edges are on two parts, a loft with three sections, an extrude taking
 * areas of several sketches, a sketch with edges brought in from a part. Those
 * stay, listed as "will lose some of what it uses" — unless all of it goes (a
 * fillet with none of its edges left is deleted too).
 *
 * What can't be told without the geometry: an edge picked on a part that a
 * deleted *Add* feature changed (the part is older, so it stays). Those show
 * as errors afterwards, as a plain Delete leaves them.
 */
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import { partCopiesPlan } from "../assembly/assembly";
import { studiosOf } from "./studios";
import type { Drawing, Feature, JuraCADDocument } from "./types";

/** The feature that made a part, from the part's id. */
export const partMaker = (partId: string): string => partId.split(/[~@]/)[0];

/** A feature that stays but loses some of what it uses, and what. */
export interface PartialUse {
  id: string;
  name: string;
  /** Plain English, e.g. "2 of its 3 edges or faces". */
  loses: string[];
}

export interface Dependents {
  /** The features picked (that exist), in list order. */
  picked: string[];
  /** Later features that go too, in list order (not including the picked ones). */
  dependents: string[];
  /** Features that stay but lose some references. */
  partial: PartialUse[];
}

/** Every SketchPlane a feature is placed on or measured from. */
function planesOf(f: Feature): SketchPlane[] {
  const out: (SketchPlane | null | undefined)[] = [
    f.sketch?.plane,
    f.text?.plane,
    f.planeDef?.ref,
    f.planeDef?.ref2,
    f.splitDef?.plane,
    f.mirror && !f.mirror.unset && !f.mirror.planePick && !f.mirror.line ? f.mirror.plane : undefined,
    f.replaceDef?.target,
    f.neutral,
  ];
  return out.filter((p): p is SketchPlane => !!p);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How a feature uses others: what it can't do without, and lists of which it may lose some. */
interface Uses {
  /** Feature ids it can't do without. */
  features: string[];
  /** Part ids it can't do without. */
  parts: string[];
  /** Lists: it goes when every item of one goes (or fewer than `least` are left); it loses some when some go. */
  lists: { what: string; many: string; features?: string[]; parts?: string[]; least?: number }[];
  /** References it can lose without going (a sketch's brought-in edges, extra sketches). */
  optional: { what: string; many: string; features?: string[]; parts?: string[] }[];
}

function sketchLinks(data: SketchData): { features: string[]; parts: string[] } {
  const features: string[] = [];
  const parts: string[] = [];
  const add = (l: unknown) => {
    if (!l || typeof l !== "object") return;
    const link = l as { sketch?: unknown; partId?: unknown };
    if (typeof link.partId === "string") parts.push(link.partId);
    else if (typeof link.sketch === "string") features.push(link.sketch);
  };
  for (const p of data.points) add(p.link);
  for (const c of data.curves) add((c as { link?: unknown }).link);
  return { features, parts };
}

function usesOf(f: Feature): Uses {
  const features: string[] = [];
  const parts: string[] = [];
  const lists: Uses["lists"] = [];
  const optional: Uses["optional"] = [];
  const need = (id: string | undefined) => id && features.push(id);
  const needPart = (id: string | undefined) => id && parts.push(id);

  need(f.sketchRef);
  need(f.pathRef);
  need(f.hole?.sketchRef);
  for (const plane of planesOf(f)) {
    if (plane.kind !== "face") continue;
    need(plane.planeRef);
    needPart(plane.face?.partId);
  }
  needPart(f.text?.face?.partId);
  needPart(f.extrude?.upTo?.partId);
  needPart(f.extendTo?.target?.partId);
  needPart(f.transform?.partId);
  needPart(f.splitDef?.partId);
  needPart(f.splitDef?.toolPartId);
  if (f.mirror) {
    needPart(f.mirror.part);
    if (!f.mirror.unset) {
      needPart(f.mirror.planePick?.partId);
      need(f.mirror.line?.sketch);
    }
    if (f.mirror.sources.length) lists.push({ what: "feature it mirrors", many: "features it mirrors", features: f.mirror.sources });
  }
  if (f.pattern) {
    if (!f.pattern.unset) {
      needPart(f.pattern.along?.partId);
      need(f.pattern.line?.sketch);
    }
    needPart(f.pattern.along2?.partId);
    need(f.pattern.line2?.sketch);
    if (f.pattern.sources.length) lists.push({ what: "feature it repeats", many: "features it repeats", features: f.pattern.sources });
  }
  if (f.sections?.length) lists.push({ what: "loft section", many: "loft sections", features: f.sections, least: 2 });
  if (f.picks?.length) lists.push({ what: "picked edge or face", many: "picked edges and faces", parts: f.picks.map((p) => p.partId) });
  if (f.booleanDef) {
    if (f.booleanDef.targets.length) lists.push({ what: f.booleanDef.op === "subtract" ? "part it cuts" : "part it joins", many: f.booleanDef.op === "subtract" ? "parts it cuts" : "parts it joins", parts: f.booleanDef.targets });
    if (f.booleanDef.op === "subtract" && f.booleanDef.tools.length) lists.push({ what: "part it cuts with", many: "parts it cuts with", parts: f.booleanDef.tools });
  }
  if (f.deleteParts?.length) lists.push({ what: "part it deletes", many: "parts it deletes", parts: f.deleteParts });
  if (f.simplifyParts?.length) lists.push({ what: "part it tidies", many: "parts it tidies", parts: f.simplifyParts });
  if (f.moreAreas?.length) optional.push({ what: "extra sketch it takes areas from", many: "extra sketches it takes areas from", features: f.moreAreas.map((m) => m.sketch) });
  if (f.sketch) {
    const links = sketchLinks(f.sketch.data);
    if (links.features.length + links.parts.length) optional.push({ what: "reference brought in from elsewhere", many: "references brought in from elsewhere", ...links });
  }
  return { features, parts, lists, optional };
}

/**
 * The features that use the picked ones (in `features`, one Part Studio's list),
 * transitively: a feature that goes takes the features using it with it.
 */
export function findDependents(features: Feature[], ids: Iterable<string>): Dependents {
  const wanted = new Set(ids);
  const gone = new Set<string>();
  const picked: string[] = [];
  const dependents: string[] = [];
  const partial: PartialUse[] = [];
  const featureGone = (id: string) => gone.has(id);
  const partGone = (id: string) => gone.has(partMaker(id));
  for (const f of features) {
    if (wanted.has(f.id)) {
      gone.add(f.id);
      picked.push(f.id);
      continue;
    }
    if (!gone.size) continue;
    const u = usesOf(f);
    let goes = u.features.some(featureGone) || u.parts.some(partGone);
    const loses: string[] = [];
    if (!goes) {
      for (const list of u.lists) {
        const all = [...(list.features ?? []), ...(list.parts ?? [])];
        const lost = (list.features ?? []).filter(featureGone).length + (list.parts ?? []).filter(partGone).length;
        if (!lost) continue;
        if (lost === all.length || all.length - lost < (list.least ?? 1)) {
          goes = true;
          break;
        }
        loses.push(`${lost} of its ${count(all.length, list.what, list.many)}`);
      }
    }
    if (goes) {
      gone.add(f.id);
      dependents.push(f.id);
      continue;
    }
    for (const opt of u.optional) {
      const lost = (opt.features ?? []).filter(featureGone).length + (opt.parts ?? []).filter(partGone).length;
      if (lost) loses.push(count(lost, opt.what, opt.many));
    }
    if (loses.length) partial.push({ id: f.id, name: f.name, loses });
  }
  return { picked, dependents, partial };
}

/** What outside the Part Studio uses parts the deleted features made. */
export interface OutsideUse {
  assemblies: { id: string; name: string; copies: number }[];
  drawings: { id: string; name: string }[];
  derived: { studioName: string; featureName: string }[];
}

function drawsPart(d: Drawing, mine: (partId: string) => boolean): boolean {
  const sources = [d.source, ...d.views.map((v) => v.source), ...(d.pages ?? []).flatMap((p) => [p.source, ...p.views.map((v) => v.source)])];
  return sources.some((s) => s?.kind === "part" && mine(s.id));
}

/** Assemblies, drawings and Derived features (in other Part Studios) using parts made by these features. */
export function outsideUsers(doc: JuraCADDocument, studioId: string, goneIds: Iterable<string>): OutsideUse {
  const ids = new Set(goneIds);
  const mine = (partId: string) => ids.has(partMaker(partId));
  const plan = partCopiesPlan(doc, mine);
  const assemblies = (doc.assemblies ?? []).map((a) => ({ id: a.id, name: a.name, copies: plan.copies.get(a.id)?.length ?? 0 })).filter((a) => a.copies > 0);
  const drawings = (doc.drawings ?? []).filter((d) => drawsPart(d, mine)).map((d) => ({ id: d.id, name: d.name }));
  const derived = studiosOf(doc)
    .filter((s) => s.id !== studioId)
    .flatMap((s) => s.features.filter((f) => f.type === "derived" && f.derived?.studioId === studioId && mine(f.derived.partId)).map((f) => ({ studioName: s.name, featureName: f.name })));
  return { assemblies, drawings, derived };
}

/** Everything the Delete question needs. */
export interface DeletePlan extends Dependents {
  outside: OutsideUse;
}

/** The plan for deleting features of the Part Studio `studioId` (with their dependents, or `justThese`). */
export function deletePlan(doc: JuraCADDocument, studioId: string, ids: string[], justThese = false): DeletePlan {
  const features = studiosOf(doc).find((s) => s.id === studioId)?.features ?? [];
  const deps = findDependents(features, ids);
  const going = justThese ? deps.picked : [...deps.picked, ...deps.dependents];
  return { ...deps, outside: outsideUsers(doc, studioId, going) };
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Plain-English lines about parts used elsewhere (empty when none). */
export function outsideLines(o: OutsideUse): string[] {
  return [
    ...o.assemblies.map((a) => `${a.name} has ${a.copies === 1 ? "a copy" : `${a.copies} copies`} of a part that will go — ${a.copies === 1 ? "it" : "they"}'ll show as missing.`),
    ...o.drawings.map((d) => `${d.name} draws a part that will go — it'll say the part is missing.`),
    ...o.derived.map((d) => `"${d.featureName}" in ${d.studioName} brings in a part that will go.`),
  ];
}

/** The question asked before deleting with dependents, e.g. "Delete Sketch 2 and the 3 features that use it: Extrude 2, Fillet 1 and Hole 1?" */
export function deleteQuestion(features: Feature[], plan: Dependents): string {
  const name = (id: string) => features.find((f) => f.id === id)?.name ?? id;
  const picked = listNames(plan.picked.map(name));
  const it = plan.picked.length === 1 ? "it" : "them";
  const n = plan.dependents.length;
  if (!n) return `Delete ${picked}? Nothing else uses ${it}.`;
  return `Delete ${picked} and the ${n === 1 ? "feature" : `${n} features`} that ${n === 1 ? "uses" : "use"} ${it}: ${listNames(plan.dependents.map(name))}?`;
}

/**
 * Delete features from a document view (its `features` = one Part Studio's),
 * and forget them in configurations (their suppressed lists). One change, so
 * one undo step in the app.
 */
export function deleteFeatures(doc: JuraCADDocument, ids: Iterable<string>): JuraCADDocument {
  const gone = new Set(ids);
  if (!doc.features.some((f) => gone.has(f.id))) return doc;
  let out: JuraCADDocument = { ...doc, features: doc.features.filter((f) => !gone.has(f.id)) };
  if (doc.configurations?.some((c) => c.suppressed.some((f) => gone.has(f)))) {
    out = { ...out, configurations: doc.configurations.map((c) => (c.suppressed.some((f) => gone.has(f)) ? { ...c, suppressed: c.suppressed.filter((f) => !gone.has(f)) } : c)) };
  }
  return out;
}
