/**
 * Deleting a Part Studio whose parts are used elsewhere (pure): what uses
 * them, the plain-English warning shown before deleting, and the delete
 * itself — the studio goes (see removeStudio in studios.ts), and so do the
 * assembly copies of its parts, the way deleting an assembly takes its copies
 * out of other assemblies. Drawings of its parts then say their part no
 * longer exists, and Derived features using them say their Part Studio was
 * deleted; Undo brings it all back as one step.
 */
import { removePartCopies } from "../assembly/assembly";
import { removeStudio, studiosOf } from "./studios";
import type { Drawing, JuraCADDocument } from "./types";

export interface StudioUse {
  /** Assemblies holding copies of its parts, and how many. */
  assemblies: { id: string; name: string; copies: number }[];
  /** Drawings (or one of their sheets or views) drawing one of its parts. */
  drawings: { id: string; name: string }[];
  /** Derived features in other Part Studios bringing in one of its parts. */
  derived: { studioId: string; studioName: string; featureId: string; featureName: string }[];
}

/** Whether a part id ("<feature>" or "<feature>~2") is one of this Part Studio's parts. */
export function partOfStudio(doc: JuraCADDocument, studioId: string): (partId: string) => boolean {
  const ids = new Set(studiosOf(doc).find((s) => s.id === studioId)?.features.map((f) => f.id) ?? []);
  return (partId) => ids.has(partId.split("~")[0]);
}

function drawsPart(d: Drawing, mine: (partId: string) => boolean): boolean {
  const sources = [d.source, ...d.views.map((v) => v.source), ...(d.pages ?? []).flatMap((p) => [p.source, ...p.views.map((v) => v.source)])];
  return sources.some((s) => s?.kind === "part" && mine(s.id));
}

/** What else in the document uses a Part Studio's parts. */
export function studioUsers(doc: JuraCADDocument, studioId: string): StudioUse {
  const mine = partOfStudio(doc, studioId);
  const assemblies = (doc.assemblies ?? [])
    .map((a) => ({ id: a.id, name: a.name, copies: a.instances.filter((i) => !i.subAssembly && mine(i.partId)).length }))
    .filter((a) => a.copies > 0);
  const drawings = (doc.drawings ?? []).filter((d) => drawsPart(d, mine)).map((d) => ({ id: d.id, name: d.name }));
  const derived = studiosOf(doc)
    .filter((s) => s.id !== studioId)
    .flatMap((s) => s.features.filter((f) => f.type === "derived" && f.derived?.studioId === studioId).map((f) => ({ studioId: s.id, studioName: s.name, featureId: f.id, featureName: f.name })));
  return { assemblies, drawings, derived };
}

export const studioInUse = (u: StudioUse): boolean => u.assemblies.length + u.drawings.length + u.derived.length > 0;

/** The question asked before deleting a Part Studio: plain, and saying what will lose its part. */
export function deleteStudioQuestion(doc: JuraCADDocument, studioId: string): string {
  const name = studiosOf(doc).find((s) => s.id === studioId)?.name ?? "this Part Studio";
  const u = studioUsers(doc, studioId);
  if (!studioInUse(u)) return `Delete ${name}? (Undo brings it back.)`;
  const lines = [
    ...u.assemblies.map((a) => `• ${a.name}: ${a.copies === 1 ? "its copy" : `its ${a.copies} copies`} of ${name}'s parts will be taken out (with their mates).`),
    ...u.drawings.map((d) => `• ${d.name} will have no part to draw where it shows one of ${name}'s parts.`),
    ...u.derived.map((f) => `• "${f.featureName}" in ${f.studioName} will lose the part it brings in.`),
  ];
  return `Delete ${name}? Its parts are used elsewhere:\n\n${lines.join("\n")}\n\nUndo brings it all back.`;
}

/** Delete a Part Studio (any of them, while another is left), and the assembly copies of its parts. */
export function deleteStudio(doc: JuraCADDocument, studioId: string): JuraCADDocument {
  const out = removeStudio(doc, studioId);
  if (out === doc) return doc;
  return removePartCopies(out, partOfStudio(doc, studioId));
}
