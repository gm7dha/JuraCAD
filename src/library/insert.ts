/**
 * Putting a library design into a document — as ordinary features and
 * variables, one undo step — and changing its sizes afterwards.
 *
 * Its variables are named <prefix>_<input> (box_width, box_thickness…); a
 * second box gets box2_…, so inserts never clash. Its features go in a folder
 * named after it ("Finger box", "Finger box 2"), with ids made from the
 * insert's id and their role, so "Edit design sizes" can make them again in
 * place with the same ids (parts keep their names, colours and assembly
 * copies).
 */
import { newId } from "../model/document";
import { setCurrentScope } from "../model/expr";
import { addStudio, inStudio, renameStudio, studioOfFeature, studiosOf } from "../model/studios";
import type { Feature, JuraCADDocument } from "../model/types";
import { applyVariables, resolveVariables, type Variable } from "../model/variables";
import { named, tidy } from "./ex";
import { bracket } from "./designs/bracket";
import { fingerBox } from "./designs/fingerBox";
import { knob } from "./designs/knob";
import { spacer } from "./designs/spacer";
import { tray } from "./designs/tray";
import type { DesignInput, DesignValues, LibraryDesign, LibraryInsert } from "./types";

/** Every design in the library, in the order they're shown. */
export const LIBRARY: readonly LibraryDesign[] = [fingerBox, tray, bracket, spacer, knob];

export function findDesign(id: string): LibraryDesign | undefined {
  return LIBRARY.find((d) => d.id === id);
}

export function defaultValues(design: LibraryDesign): DesignValues {
  return Object.fromEntries(design.inputs.map((i) => [i.key, i.default]));
}

const unitOf = (i: DesignInput) => (i.kind === "length" ? " mm" : "");

/** What's wrong with one input's value (plain English), or null. */
export function inputProblem(i: DesignInput, v: unknown): string | null {
  switch (i.kind) {
    case "toggle":
      return typeof v === "boolean" ? null : `${i.label}: choose on or off.`;
    case "choice":
      return i.choices?.some((c) => c.value === v) ? null : `${i.label}: choose one of ${i.choices?.map((c) => c.label).join(", ")}.`;
    default: {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${i.label}: type a number${i.kind === "length" ? " (millimetres)" : ""}.`;
      if (i.kind === "count" && !Number.isInteger(v)) return `${i.label}: must be a whole number.`;
      if (i.min !== undefined && v < i.min) return `${i.label}: at least ${tidy(i.min)}${unitOf(i)}.`;
      if (i.max !== undefined && v > i.max) return `${i.label}: at most ${tidy(i.max)}${unitOf(i)}.`;
      return null;
    }
  }
}

/** Every problem with a set of values: each input's own, then the design's (sizes that don't work together). */
export function valueProblems(design: LibraryDesign, values: DesignValues): string[] {
  const own = design.inputs.map((i) => inputProblem(i, values[i.key])).filter((p): p is string => p !== null);
  return own.length ? own : design.problems(values);
}

/** The values with any missing ones filled in from the defaults, and numbers typed as text turned into numbers. */
export function completeValues(design: LibraryDesign, given: Record<string, unknown>): DesignValues {
  const out = defaultValues(design);
  for (const i of design.inputs) {
    const v = given[i.key];
    if (v === undefined || v === null) continue;
    if ((i.kind === "length" || i.kind === "count") && typeof v === "string" && v.trim() && Number.isFinite(Number(v))) out[i.key] = Number(v);
    else if (i.kind === "choice" && typeof v === "number") out[i.key] = String(v);
    else out[i.key] = v as number | string | boolean;
  }
  return out;
}

const variableInputs = (design: LibraryDesign) => design.inputs.filter((i) => i.variable);

/** A variable-name start not used yet: box, box2, box3… */
export function freePrefix(doc: JuraCADDocument, prefix: string): string {
  const names = (doc.variables ?? []).map((v) => v.name);
  const taken = (p: string) => names.some((n) => n.startsWith(`${p}_`)) || (doc.libraryInserts ?? []).some((x) => x.prefix === p);
  if (!taken(prefix)) return prefix;
  let n = 2;
  while (taken(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A name for a new insert: the design's, or "… 2", "… 3" when it's taken. */
export function freeInsertName(doc: JuraCADDocument, design: LibraryDesign): string {
  const used = new Set([...(doc.libraryInserts ?? []).map((x) => x.name), ...studiosOf(doc).map((s) => s.name)]);
  if (!used.has(design.name)) return design.name;
  let n = 2;
  while (used.has(`${design.name} ${n}`)) n++;
  return `${design.name} ${n}`;
}

/** Make the design's features (and part names) for an insert, with the variables as they are in `doc`. */
function makeFeatures(doc: JuraCADDocument, design: LibraryDesign, insert: LibraryInsert): { features: Feature[]; partNames: Record<string, string> } {
  const scope = resolveVariables(doc.variables).values;
  setCurrentScope(scope);
  const vars = Object.fromEntries(variableInputs(design).map((i) => [i.key, named(`${insert.prefix}_${i.key}`, scope)]));
  const made = design.make({ values: insert.values, vars, id: (role) => `${insert.id}_${role}`, name: insert.name, scope });
  const folder = insert.name.slice(0, 60);
  return { features: made.features.map((f) => ({ ...f, folder })), partNames: made.partNames };
}

/** Feature names not already used in the Part Studio ("Bottom", else "Bottom 2"…). */
function uniqueNames(features: Feature[], existing: readonly Feature[]): Feature[] {
  const used = new Set(existing.map((f) => f.name));
  return features.map((f) => {
    let name = f.name;
    for (let n = 2; used.has(name); n++) name = `${f.name} ${n}`;
    used.add(name);
    return name === f.name ? f : { ...f, name };
  });
}

function withPartNames(doc: JuraCADDocument, names: Record<string, string>, overwrite: boolean): JuraCADDocument {
  const partNames = { ...(doc.partNames ?? {}) };
  for (const [id, name] of Object.entries(names)) if (overwrite || !partNames[id]) partNames[id] = name;
  return Object.keys(partNames).length ? { ...doc, partNames } : doc;
}

export interface InsertOptions {
  /** "new": a new Part Studio named after the design (the usual); else the id of the Part Studio to add it to. */
  into: "new" | string;
  /** Id for the new Part Studio (made up if not given). */
  studioId?: string;
}

export interface InsertResult {
  doc: JuraCADDocument;
  insert: LibraryInsert;
  /** The Part Studio it went into. */
  studioId: string;
}

/**
 * Insert a design: its variables, its features (in a folder), names for its
 * parts, and a record of it. Throws an Error with a plain message when the
 * values don't work (check `valueProblems` first to show them).
 */
export function insertDesign(doc: JuraCADDocument, design: LibraryDesign, values: DesignValues, opts: InsertOptions): InsertResult {
  const problems = valueProblems(design, values);
  if (problems.length) throw new Error(problems.join(" "));
  const prefix = freePrefix(doc, design.prefix);
  const name = freeInsertName(doc, design);
  const variables: Variable[] = [...(doc.variables ?? []), ...variableInputs(design).map((i) => ({ id: newId("v"), name: `${prefix}_${i.key}`, value: tidy(Number(values[i.key])) }))];
  const insert: LibraryInsert = { id: newId("lib"), design: design.id, name, prefix, values: { ...values }, features: [] };
  let next: JuraCADDocument = { ...doc, variables };
  let studioId = opts.into;
  if (opts.into === "new") {
    studioId = opts.studioId ?? newId("s");
    next = renameStudio(addStudio(next, studioId), studioId, name);
  }
  const made = makeFeatures(next, design, insert);
  next = inStudio(next, studioId, (view) => ({ ...view, features: [...view.features, ...uniqueNames(made.features, view.features)] }));
  insert.features = made.features.map((f) => f.id);
  next = withPartNames(next, made.partNames, true);
  next = { ...next, libraryInserts: [...(doc.libraryInserts ?? []), insert] };
  return { doc: next, insert, studioId };
}

export function findInsert(doc: JuraCADDocument, id: string): LibraryInsert | undefined {
  return doc.libraryInserts?.find((x) => x.id === id);
}

/** The insert that made this feature, if any. */
export function insertOfFeature(doc: JuraCADDocument, featureId: string): LibraryInsert | undefined {
  return doc.libraryInserts?.find((x) => x.features.includes(featureId));
}

/** Inserts whose features are (some of them) still in the document. */
export function liveInserts(doc: JuraCADDocument): LibraryInsert[] {
  return (doc.libraryInserts ?? []).filter((x) => findDesign(x.design) && x.features.some((id) => studioOfFeature(doc, id) !== null));
}

/** An insert's values as they are now: its variable-backed sizes read back from the variables (if they still work out). */
export function currentValues(doc: JuraCADDocument, insert: LibraryInsert): DesignValues {
  const design = findDesign(insert.design);
  if (!design) return insert.values;
  const { values } = resolveVariables(doc.variables);
  const out = completeValues(design, insert.values);
  for (const i of variableInputs(design)) {
    const v = values[`${insert.prefix}_${i.key}`];
    if (v !== undefined) out[i.key] = Math.round(v * 1e6) / 1e6;
  }
  return out;
}

/**
 * Change an insert's sizes and choices ("Edit design sizes"): its variables
 * get the new values and its features are made again in place, with the same
 * ids. Changes made by hand to those features are replaced.
 */
export function editInsert(doc: JuraCADDocument, insertId: string, values: DesignValues): JuraCADDocument {
  const insert = findInsert(doc, insertId);
  const design = insert && findDesign(insert.design);
  if (!insert || !design) throw new Error("That design isn't in this document any more.");
  const problems = valueProblems(design, values);
  if (problems.length) throw new Error(problems.join(" "));
  const studioId = insert.features.map((id) => studioOfFeature(doc, id)).find((s) => s !== null);
  if (!studioId) throw new Error(`${insert.name}'s features have all been deleted, so there's nothing to change. Insert it again from the Design library.`);
  const vars = [...(doc.variables ?? [])];
  for (const i of variableInputs(design)) {
    const name = `${insert.prefix}_${i.key}`;
    const value = tidy(Number(values[i.key]));
    const at = vars.findIndex((v) => v.name === name);
    if (at >= 0) vars[at] = { ...vars[at], value };
    else vars.push({ id: newId("v"), name, value });
  }
  // The variables first (so every sketch using them is solved again), then the design's own features.
  let next = applyVariables(doc, vars);
  const updated: LibraryInsert = { ...insert, values: { ...values } };
  const made = makeFeatures(next, design, updated);
  const old = new Set(insert.features);
  next = inStudio(next, studioId, (view) => {
    const at = view.features.findIndex((f) => old.has(f.id));
    const kept = view.features.filter((f) => !old.has(f.id));
    const where = at < 0 ? kept.length : view.features.slice(0, at).filter((f) => !old.has(f.id)).length;
    // Keep each feature's name (it may have been renamed) and folder.
    const before = new Map(view.features.filter((f) => old.has(f.id)).map((f) => [f.id, f]));
    const fresh = made.features.map((f) => {
      const was = before.get(f.id);
      return was ? { ...f, name: was.name, ...(was.folder ? { folder: was.folder } : {}) } : f;
    });
    const named = [...fresh.filter((f) => before.has(f.id)), ...uniqueNames(fresh.filter((f) => !before.has(f.id)), kept)];
    const ordered = fresh.map((f) => named.find((g) => g.id === f.id)!);
    return { ...view, features: [...kept.slice(0, where), ...ordered, ...kept.slice(where)] };
  });
  updated.features = made.features.map((f) => f.id);
  next = withPartNames(next, made.partNames, false);
  return { ...next, libraryInserts: (next.libraryInserts ?? []).map((x) => (x.id === insertId ? updated : x)) };
}
