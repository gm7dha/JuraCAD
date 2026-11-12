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
import { isPatternFeature, isSolidFeature } from "./features";
import type { Drawing, Feature, JuraCADDocument } from "./types";

/** The feature that made a part, from the part's id. */
export const partMaker = (partId: string): string => partId.split(/[~@]/)[0];

/** A feature that stays but loses some of what it uses, and what. */
export interface PartialUse {
  id: string;
  name: string;
  /** Plain English, e.g. "1 of its 2 picked edges and faces" (shown as "Fillet 3 will lose …"). */
  loses: string[];
}

export interface Dependents {
  /** The features picked (that exist), in list order. */
  picked: string[];
  /** Later features that go too, in list order (not including the picked ones). */
  dependents: string[];
  /** Everything that goes: the picked features and their dependents. */
  going: string[];
  /** Features that stay but lose some references (deleteFeatures takes those references out, so they still build). */
  partial: PartialUse[];
}

/** Every SketchPlane a feature is placed on or measured from. */
function planesOf(f: Feature): SketchPlane[] {
  const out: (SketchPlane | null | undefined)[] = [
    f.sketch?.plane,
    f.text?.plane,
    f.planeDef?.ref,
    f.planeDef?.ref2,
    // Split by a surface part ignores the plane.
    // (Split face along a sketch or edges ignores it too.)
    f.splitDef && !f.splitDef.toolPartId && !(f.splitDef.mode === "face" && (f.splitDef.tool ?? "plane") !== "plane") ? f.splitDef.plane : undefined,
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
  /** Lists: it goes when fewer than `least` (1) items are left; it loses some when some go. */
  lists: { what: string; many: string; features?: string[]; parts?: string[]; least?: number }[];
  /** References it can lose without going (a sketch's brought-in edges, extra sketches). */
  optional: { what: string; many: string; features?: string[]; parts?: string[] }[];
}

type Link = { sketch?: unknown; partId?: unknown } | undefined;

function linkGone(l: unknown, featureGone: (id: string) => boolean, partGone: (id: string) => boolean): boolean {
  if (!l || typeof l !== "object") return false;
  const link = l as NonNullable<Link>;
  if (typeof link.partId === "string") return partGone(link.partId);
  return typeof link.sketch === "string" && featureGone(link.sketch);
}

function sketchLinks(data: SketchData): { features: string[]; parts: string[] } {
  const features: string[] = [];
  const parts: string[] = [];
  const add = (l: unknown) => {
    if (!l || typeof l !== "object") return;
    const link = l as NonNullable<Link>;
    if (typeof link.partId === "string") parts.push(link.partId);
    else if (typeof link.sketch === "string") features.push(link.sketch);
  };
  for (const p of data.points) add(p.link);
  for (const c of data.curves) add((c as { link?: unknown }).link);
  return { features, parts };
}

/** Extrude ends that stop at a picked face, corner or part. */
const UP_TO_PICK = new Set(["upToFace", "upToVertex", "upToPart"]);

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
  // Newer Plane types' points and line, and a mate connector's spot: the part, sketch or connector each is on.
  for (const g of [...(f.planeDef?.points ?? []), ...(f.planeDef?.line ? [f.planeDef.line] : []), ...(f.connector ? [f.connector.at] : [])]) {
    needPart(g.pick?.partId);
    need(g.sketchPoint?.sketch);
    need(g.sketchLine?.sketch);
    need(g.connector);
  }
  if (f.connector?.plane?.kind === "face") need(f.connector.plane.planeRef);
  needPart(f.connector?.owner);
  need(f.transform?.fromConnector);
  need(f.transform?.toConnector);
  if (UP_TO_PICK.has(f.extrude?.end ?? "")) needPart(f.extrude?.upTo?.partId);
  needPart(f.extendTo?.target?.partId);
  needPart(f.transform?.partId);
  // Split face's parts are its picks' (a list below).
  if (f.splitDef?.mode !== "face") {
    needPart(f.splitDef?.partId);
    needPart(f.splitDef?.toolPartId);
  }
  if (f.mirror) {
    needPart(f.mirror.part);
    if (!f.mirror.unset) {
      needPart(f.mirror.planePick?.partId);
      need(f.mirror.line?.sketch);
    }
    if (!f.mirror.of && f.mirror.part === undefined && f.mirror.sources.length) lists.push({ what: "feature it mirrors", many: "features it mirrors", features: f.mirror.sources });
  }
  if (f.pattern) {
    if (!f.pattern.unset) {
      needPart(f.pattern.along?.partId);
      need(f.pattern.line?.sketch);
    }
    needPart(f.pattern.along2?.partId);
    need(f.pattern.line2?.sketch);
    if (f.pattern.of === "part") {
      if (f.pattern.parts?.length) lists.push({ what: "part it repeats", many: "parts it repeats", parts: f.pattern.parts });
    } else if (!f.pattern.of && f.pattern.sources.length) lists.push({ what: "feature it repeats", many: "features it repeats", features: f.pattern.sources });
  }
  if (f.sections?.length) lists.push({ what: "loft section", many: "loft sections", features: f.sections, least: 2 });
  if (f.picks?.length) lists.push({ what: "picked edge or face", many: "picked edges and faces", parts: f.picks.map((p) => p.partId) });
  if (f.booleanDef) {
    const sub = f.booleanDef.op === "subtract";
    if (f.booleanDef.targets.length)
      lists.push({ what: sub ? "part it cuts" : "part it joins", many: sub ? "parts it cuts" : "parts it joins", parts: f.booleanDef.targets, least: sub ? 1 : 2 });
    if (sub && f.booleanDef.tools.length) lists.push({ what: "part it cuts with", many: "parts it cuts with", parts: f.booleanDef.tools });
  }
  if (f.deleteParts?.length) lists.push({ what: "part it deletes", many: "parts it deletes", parts: f.deleteParts });
  if (f.simplifyParts?.length) lists.push({ what: "part it tidies", many: "parts it tidies", parts: f.simplifyParts });
  if (f.compositeParts?.length) lists.push({ what: "part it groups", many: "parts it groups", parts: f.compositeParts, least: 2 });
  if (f.moreAreas?.length) optional.push({ what: "extra sketch it takes areas from", many: "extra sketches it takes areas from", features: f.moreAreas.map((m) => m.sketch) });
  if (f.sketch) {
    const links = sketchLinks(f.sketch.data);
    if (links.features.length + links.parts.length) optional.push({ what: "reference brought in from elsewhere", many: "references brought in from elsewhere", ...links });
  }
  return { features, parts, lists, optional };
}

/** Types whose New makes a solid part of its own (so it becomes "the latest part" older features act on). */
const SOLID_MAKERS = new Set<Feature["type"]>(["fastener", "derived", "coil", "thicken", "sheetMetal"]);
/** Types that, without `apart`, add to / cut from the latest solid part. */
const LATEST_USERS = new Set<Feature["type"]>(["box", "cylinder", "sphere", "extrude", "revolve", "hole", "import", "sweep", "loft", "text", "coil", "rib", "fastener"]);

const isSurfaceFeature = (f: Feature) => !!f.surface || f.type === "fill" || f.type === "offsetSurface" || f.type === "enclose" || f.type === "ruled";

/**
 * Does this feature (built) make a new solid part, so it becomes the part old-style Add/Remove features act on?
 * An approximation from the list alone: Delete part or a Boolean union can also change which part is last, and a
 * Split is assumed to split a solid (not a surface).
 */
function makesSolidPart(f: Feature, makers: Set<string>): boolean {
  if (f.suppressed) return false;
  // Enclose closes surfaces into a solid part of its own.
  if (f.type === "enclose") return true;
  if (isSurfaceFeature(f)) return false;
  // Keeping both pieces adds the front one as a part under the split's id.
  if (f.type === "split") return f.splitDef?.mode !== "face" && f.splitDef?.keep === "both";
  if (f.type === "mirror" && f.mirror?.part !== undefined) return !f.mirror.join;
  if (f.type === "transform") return !!f.transform?.copy;
  // A part pattern's copies are new parts; a face pattern or mirror changes the part its faces are on.
  if (f.pattern?.of === "part") return !!f.pattern.parts?.length;
  if (f.pattern?.of === "face" || f.mirror?.of === "face") return false;
  // A composite part is the latest part once made (it's put at the end of the parts).
  if (f.type === "composite") return !!f.compositeParts?.length;
  if (isPatternFeature(f.type)) return (f.pattern?.sources ?? f.mirror?.sources ?? []).some((id) => makers.has(id));
  if (f.type === "sheetMetal" && f.sheetConvert) return false;
  return f.operation === "new" && (isSolidFeature(f.type) || SOLID_MAKERS.has(f.type));
}

/**
 * Old-style (not `apart`) Add/Remove/Intersect: it changes whichever solid part
 * was made last. When that part's maker goes, it would silently change an
 * earlier part (the user's own), so it goes too.
 */
function usesLatestPart(f: Feature): boolean {
  if (f.suppressed || isSurfaceFeature(f) || f.operation === "new" || !LATEST_USERS.has(f.type)) return false;
  if (f.apart && (f.operation === "add" || f.operation === "remove")) return false;
  if (f.intersectAll && f.operation === "intersect") return false;
  return true;
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
  const makers = new Set<string>();
  let latest: string | null = null;
  const made = (f: Feature) => {
    if (!makesSolidPart(f, makers)) return;
    makers.add(f.id);
    latest = f.id;
  };
  for (const f of features) {
    if (wanted.has(f.id)) {
      gone.add(f.id);
      picked.push(f.id);
      made(f);
      continue;
    }
    if (!gone.size) {
      made(f);
      continue;
    }
    const u = usesOf(f);
    let goes = u.features.some(featureGone) || u.parts.some(partGone) || (latest !== null && gone.has(latest) && usesLatestPart(f));
    const loses: string[] = [];
    if (!goes) {
      for (const list of u.lists) {
        const all = [...(list.features ?? []), ...(list.parts ?? [])];
        const lost = (list.features ?? []).filter(featureGone).length + (list.parts ?? []).filter(partGone).length;
        if (!lost) continue;
        if (all.length - lost < (list.least ?? 1)) {
          goes = true;
          break;
        }
        loses.push(`${lost} of its ${count(all.length, list.what, list.many)}`);
      }
    }
    made(f);
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
  return { picked, dependents, going: [...picked, ...dependents], partial };
}

/**
 * A feature that stays, with what it used from deleted features taken out: picks
 * on their parts, them as pattern/mirror/loft/extra sketches, Boolean/Delete
 * part/Simplify parts, and sketch references brought in from them. The engine
 * fails a feature whose references are missing, so this keeps it building.
 * The same object when nothing changes.
 */
export function withoutGone(f: Feature, gone: Set<string>): Feature {
  const featureGone = (id: string) => gone.has(id);
  const partGone = (id: string) => gone.has(partMaker(id));
  let out = f;
  const set = (patch: Partial<Feature>) => {
    out = { ...out, ...patch };
  };
  if (f.picks?.some((p) => partGone(p.partId))) set({ picks: f.picks.filter((p) => !partGone(p.partId)) });
  if (f.pattern?.sources.some(featureGone)) set({ pattern: { ...f.pattern, sources: f.pattern.sources.filter((id) => !featureGone(id)) } });
  if (f.mirror?.sources.some(featureGone)) set({ mirror: { ...f.mirror, sources: f.mirror.sources.filter((id) => !featureGone(id)) } });
  if (f.sections?.some(featureGone)) set({ sections: f.sections.filter((id) => !featureGone(id)) });
  if (f.moreAreas?.some((m) => featureGone(m.sketch))) {
    const more = f.moreAreas.filter((m) => !featureGone(m.sketch));
    if (more.length) set({ moreAreas: more });
    else {
      const { moreAreas: _gone, ...rest } = out;
      out = rest;
    }
  }
  if (f.booleanDef && (f.booleanDef.targets.some(partGone) || f.booleanDef.tools.some(partGone)))
    set({ booleanDef: { ...f.booleanDef, targets: f.booleanDef.targets.filter((p) => !partGone(p)), tools: f.booleanDef.tools.filter((p) => !partGone(p)) } });
  if (f.deleteParts?.some(partGone)) set({ deleteParts: f.deleteParts.filter((p) => !partGone(p)) });
  if (f.simplifyParts?.some(partGone)) set({ simplifyParts: f.simplifyParts.filter((p) => !partGone(p)) });
  if (f.pattern?.parts?.some(partGone)) set({ pattern: { ...out.pattern!, parts: f.pattern.parts.filter((p) => !partGone(p)) } });
  if (f.compositeParts?.some(partGone)) set({ compositeParts: f.compositeParts.filter((p) => !partGone(p)) });
  if (f.sketch) {
    const lost = (l: unknown) => linkGone(l, featureGone, partGone);
    const data = f.sketch.data;
    if (data.points.some((p) => lost(p.link)) || data.curves.some((c) => lost((c as { link?: unknown }).link))) {
      const unlink = <T extends { link?: unknown }>(x: T): T => {
        if (!lost(x.link)) return x;
        const { link: _gone, ...rest } = x;
        return rest as T;
      };
      set({ sketch: { ...f.sketch, data: { ...data, points: data.points.map(unlink), curves: data.curves.map(unlink) } } });
    }
  }
  return out;
}

/** What outside the Part Studio uses parts the deleted features made. */
export interface OutsideUse {
  assemblies: { id: string; name: string; copies: number }[];
  drawings: { id: string; name: string }[];
  derived: { studioName: string; featureName: string }[];
  /** Assembly mates on a Part Studio mate connector that goes (missing when none). */
  connectorMates?: { name: string; mates: string[] }[];
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
  // Mates (and mirror planes) on one of its mate connectors.
  const onConnector = (c: { connector?: string } | undefined) => !!c?.connector && ids.has(c.connector);
  const connectorMates = (doc.assemblies ?? [])
    .map((a) => ({
      name: a.name,
      mates: [...(a.mates ?? []).filter((m) => onConnector(m.a) || onConnector(m.b)).map((m) => m.name), ...(a.patterns ?? []).filter((p) => onConnector(p.plane)).map((p) => p.name)],
    }))
    .filter((a) => a.mates.length);
  return { assemblies, drawings, derived, ...(connectorMates.length ? { connectorMates } : {}) };
}

/** Everything the Delete question needs. */
export interface DeletePlan extends Dependents {
  outside: OutsideUse;
}

/** The plan for deleting features of the Part Studio `studioId` (with their dependents, or `justThese`). */
export function deletePlan(doc: JuraCADDocument, studioId: string, ids: string[], justThese = false): DeletePlan {
  const features = studiosOf(doc).find((s) => s.id === studioId)?.features ?? [];
  const deps = findDependents(features, ids);
  return { ...deps, outside: outsideUsers(doc, studioId, justThese ? deps.picked : deps.going) };
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
    ...(o.connectorMates ?? []).map((a) => `In ${a.name}, ${listNames(a.mates)} ${a.mates.length === 1 ? "uses a mate connector that will go — it'll" : "use mate connectors that will go — they'll"} stop working.`),
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

/** Does any text of the document (features of every studio, variables, assemblies, drawings) use this variable name? */
function nameUsed(doc: JuraCADDocument, name: string, skip: Set<string>): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[^A-Za-z0-9_]/g, "")}($|[^A-Za-z0-9_])`);
  const text = JSON.stringify([doc.features, (doc.partStudios ?? []).map((s) => s.features), (doc.variables ?? []).filter((v) => !skip.has(v.id)).map((v) => v.value), doc.assemblies ?? [], doc.drawings ?? []]);
  return re.test(text);
}

/**
 * Delete features from a document view (its `features` = one Part Studio's),
 * and forget them in configurations (their suppressed lists). With `tidy`
 * (Delete with dependents), the features left are rewritten without what they
 * used from the deleted ones (`withoutGone`), so they still build; and a
 * library design all of whose features have gone is forgotten, with its
 * variables when nothing else uses them. One change, so one undo step.
 */
export function deleteFeatures(doc: JuraCADDocument, ids: Iterable<string>, tidy = false): JuraCADDocument {
  const gone = new Set(ids);
  if (!doc.features.some((f) => gone.has(f.id))) return doc;
  const left = doc.features.filter((f) => !gone.has(f.id));
  let out: JuraCADDocument = { ...doc, features: tidy ? left.map((f) => withoutGone(f, gone)) : left };
  if (doc.configurations?.some((c) => c.suppressed.some((f) => gone.has(f)))) {
    out = { ...out, configurations: doc.configurations.map((c) => (c.suppressed.some((f) => gone.has(f)) ? { ...c, suppressed: c.suppressed.filter((f) => !gone.has(f)) } : c)) };
  }
  if (tidy && doc.libraryInserts?.length) {
    const there = new Set(out.features.map((f) => f.id));
    const over = doc.libraryInserts.filter((i) => i.features.some((id) => gone.has(id)) && i.features.every((id) => !there.has(id)));
    if (over.length) {
      const inserts = doc.libraryInserts.filter((i) => !over.includes(i));
      const { libraryInserts: _old, ...rest } = out;
      out = inserts.length ? { ...rest, libraryInserts: inserts } : rest;
      const candidates = new Set(over.flatMap((i) => Object.values(i.variables ?? {})));
      // Drop them all at once, then put back any still named by what's left.
      const unused = new Set([...candidates].filter((id) => {
        const v = out.variables?.find((x) => x.id === id);
        return v && !nameUsed(out, v.name, candidates);
      }));
      if (unused.size) {
        out = {
          ...out,
          variables: (out.variables ?? []).filter((v) => !unused.has(v.id)),
          ...(out.configurations
            ? { configurations: out.configurations.map((c) => (Object.keys(c.values).some((k) => unused.has(k)) ? { ...c, values: Object.fromEntries(Object.entries(c.values).filter(([k]) => !unused.has(k))) } : c)) }
            : {}),
        };
      }
    }
  }
  return out;
}
