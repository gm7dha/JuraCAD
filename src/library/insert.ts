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
import { getCurrentScope, setCurrentScope } from "../model/expr";
import { addStudio, inStudio, renameStudio, studioOfFeature, studiosOf } from "../model/studios";
import type { Feature, JuraCADDocument } from "../model/types";
import { applyVariables, resolveVariables, type Variable } from "../model/variables";
import { named, tidy } from "./ex";
import { stableIds } from "./stableIds";
import { boxLid } from "./designs/boxLid";
import { bracket } from "./designs/bracket";
import { cableClip } from "./designs/cableClip";
import { flatStand } from "./designs/flatStand";
import { hinge } from "./designs/hinge";
import { hook } from "./designs/hook";
import { phoneStand } from "./designs/phoneStand";
import { fingerBox } from "./designs/fingerBox";
import { knob } from "./designs/knob";
import { spacer } from "./designs/spacer";
import { tray } from "./designs/tray";
import { PRINT_DESIGNS } from "./printDesigns";
import { LASER_DESIGNS, printedStamp } from "./designs/laserSet";
import { LASER_DESIGNS_3 } from "./designs/laserSet3";
import { LASER_DESIGNS_4 } from "./designs/laserSet4";
import { LASER_DESIGNS_5 } from "./designs/laserSet5";
import type { DesignCategory, DesignInput, DesignValues, LibraryDesign, LibraryInsert } from "./types";

/** Every design in the library, in the order they're shown (laser cutting first, then 3D printing). */
export const LIBRARY: readonly LibraryDesign[] = [fingerBox, flatStand, ...LASER_DESIGNS, ...LASER_DESIGNS_3, ...LASER_DESIGNS_4, ...LASER_DESIGNS_5, tray, boxLid, bracket, hook, cableClip, phoneStand, hinge, spacer, knob, printedStamp, ...PRINT_DESIGNS];

/** The library's sections, in the order they're shown. */
export const LIBRARY_CATEGORIES: readonly { id: DesignCategory; label: string; blurb: string }[] = [
  { id: "laser", label: "Laser cutting", blurb: "Flat panels cut from sheet (plywood, acrylic, card), ready for Export for laser." },
  { id: "print", label: "3D printing", blurb: "Parts that sit flat on the print bed, ready for the 3D print check." },
];

/** The designs in one section, in the library's order. */
export function designsIn(category: DesignCategory): LibraryDesign[] {
  return LIBRARY.filter((d) => d.category === category);
}

/** Designs under one heading (`group` null = those without a group, listed first without a heading). */
export interface DesignGroup {
  group: string | null;
  designs: LibraryDesign[];
}

/** Per section, headings that come first, in this order; any others follow in the order they're first used. */
export const GROUP_ORDER: Record<DesignCategory, readonly string[]> = {
  laser: [],
  print: ["Puzzles", "Fixings", "Hinges", "Storage", "Gridfinity", "Household", "Moulds and casting", "Desk", "Garden", "Workshop", "Electronics", "Test prints"],
};

/** Designs under their headings (`LibraryDesign.group`): ungrouped ones first, then the groups (`order`'s first), each in the library's order. */
export function groupDesigns(designs: readonly LibraryDesign[], order: readonly string[] = []): DesignGroup[] {
  const out: DesignGroup[] = [];
  for (const d of [...designs.filter((x) => !x.group), ...designs.filter((x) => x.group)]) {
    const g = d.group ?? null;
    const at = out.find((x) => x.group === g);
    if (at) at.designs.push(d);
    else out.push({ group: g, designs: [d] });
  }
  const rank = (g: string | null) => (g === null ? -1 : order.includes(g) ? order.indexOf(g) : order.length);
  // A stable sort: groups of equal rank keep the order they first come in.
  return out.sort((a, b) => rank(a.group) - rank(b.group));
}

/** A section's designs under their headings. */
export const designGroups = (category: DesignCategory): DesignGroup[] => groupDesigns(designsIn(category), GROUP_ORDER[category]);

/** A section's id from text (a remembered tab, a tool's input), or null if it isn't one. */
export function categoryFrom(raw: unknown): DesignCategory | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return LIBRARY_CATEGORIES.find((c) => c.id === t || c.label.toLowerCase() === t)?.id ?? (t === "3d" || t === "3d print" || t === "printing" ? "print" : t === "laser cut" ? "laser" : null);
}

/** What a section's called ("Laser cutting"). */
export const categoryLabel = (c: DesignCategory) => LIBRARY_CATEGORIES.find((x) => x.id === c)!.label;

export function findDesign(id: string): LibraryDesign | undefined {
  return LIBRARY.find((d) => d.id === id);
}

export function defaultValues(design: LibraryDesign): DesignValues {
  return Object.fromEntries(design.inputs.map((i) => [i.key, i.default]));
}

/** The most lines a text input may have. */
export const MAX_TEXT_LINES = 6;

const unitOf = (i: DesignInput) => (i.kind === "length" ? " mm" : "");

/** What's wrong with one input's value (plain English), or null. */
export function inputProblem(i: DesignInput, v: unknown): string | null {
  switch (i.kind) {
    case "toggle":
      return typeof v === "boolean" ? null : `${i.label}: choose on or off.`;
    case "choice":
      return i.choices?.some((c) => c.value === v) ? null : `${i.label}: choose one of ${i.choices?.map((c) => c.label).join(", ")}.`;
    case "text": {
      if (typeof v !== "string") return `${i.label}: type some words.`;
      if (!v.trim() && !i.optional) return `${i.label}: type some words.`;
      const most = i.maxLength ?? 60;
      if (v.length > most) return `${i.label}: at most ${most} letters.`;
      if (!i.multiline && /[\r\n]/.test(v)) return `${i.label}: one line only.`;
      if (i.multiline && v.split("\n").length > MAX_TEXT_LINES) return `${i.label}: at most ${MAX_TEXT_LINES} lines.`;
      return null;
    }
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
    else if (i.kind === "text" && typeof v === "number") out[i.key] = String(v);
    else if (i.kind === "text" && typeof v === "string") out[i.key] = v.replace(/\r\n?/g, "\n");
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

/** The name of an insert's variable for an input: the one it made (followed by id, so a rename is kept), else <prefix>_<key>. */
function variableName(doc: JuraCADDocument, insert: LibraryInsert, key: string): string {
  const id = insert.variables?.[key];
  const v = id ? doc.variables?.find((x) => x.id === id) : undefined;
  return v?.name ?? `${insert.prefix}_${key}`;
}

/** Make the design's features (and part names) for an insert, with the variables as they are in `doc`. */
function makeFeatures(doc: JuraCADDocument, design: LibraryDesign, insert: LibraryInsert): { features: Feature[]; partNames: Record<string, string> } {
  const scope = resolveVariables(doc.variables).values;
  setCurrentScope(scope);
  const vars = Object.fromEntries(variableInputs(design).map((i) => [i.key, named(variableName(doc, insert, i.key), scope)]));
  const made = design.make({ values: insert.values, vars, id: (role) => `${insert.id}_${role}`, name: insert.name, scope });
  const folder = insert.name.slice(0, 60);
  return {
    features: made.features.map((f) => ({ ...f, folder, ...(f.sketch ? { sketch: { ...f.sketch, data: stableIds(f.sketch.data, f.id) } } : {}) })),
    partNames: made.partNames,
  };
}

/** Run `fn` and put the expression scope back afterwards, so a failed insert leaves no trace (the app and the extension set it themselves). */
function keepingScope<T>(fn: () => T): T {
  const before = getCurrentScope();
  try {
    return fn();
  } finally {
    setCurrentScope(before);
  }
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
  return keepingScope(() => insertNow(doc, design, values, opts));
}

function insertNow(doc: JuraCADDocument, design: LibraryDesign, values: DesignValues, opts: InsertOptions): InsertResult {
  const problems = valueProblems(design, values);
  if (problems.length) throw new Error(problems.join(" "));
  const prefix = freePrefix(doc, design.prefix);
  const name = freeInsertName(doc, design);
  const added = variableInputs(design).map((i) => ({ key: i.key, v: { id: newId("v"), name: `${prefix}_${i.key}`, value: tidy(Number(values[i.key])) } }));
  const variables: Variable[] = [...(doc.variables ?? []), ...added.map((a) => a.v)];
  const insert: LibraryInsert = { id: newId("lib"), design: design.id, name, prefix, values: { ...values }, features: [], variables: Object.fromEntries(added.map((a) => [a.key, a.v.id])) };
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

/**
 * Export for laser's settings for a sketch made by a library design (a stamp's sketch engraves its background), or
 * null for any other sketch.
 */
export function laserDefaultsFor(doc: JuraCADDocument, sketchId: string): NonNullable<LibraryDesign["laser"]>[string] | null {
  const insert = insertOfFeature(doc, sketchId);
  const design = insert && findDesign(insert.design);
  if (!insert || !design?.laser) return null;
  const role = sketchId.startsWith(`${insert.id}_`) ? sketchId.slice(insert.id.length + 1) : null;
  return (role && design.laser[role]) || null;
}

/** Parts library designs make that aren't cut as shown (see `LibraryDesign.notCut`): left out of "every part" for laser. */
export function notCutParts(doc: JuraCADDocument): string[] {
  return (doc.libraryInserts ?? []).flatMap((x) => findDesign(x.design)?.notCut?.map((role) => `${x.id}_${role}`) ?? []);
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
    const v = values[variableName(doc, insert, i.key)];
    if (v !== undefined) out[i.key] = Math.round(v * 1e6) / 1e6;
  }
  return out;
}

export interface EditResult {
  doc: JuraCADDocument;
  /** Names of the design's features the user had deleted, which were made again. */
  remade: string[];
}

/**
 * Change an insert's sizes and choices ("Edit design sizes"): its variables
 * get the new values and its features are made again with the same ids, each
 * where it was in the list (the user's own features stay where they are), and
 * keeping its name, folder, suppression and eye. Changes made by hand to the
 * design's features are replaced; ones the user deleted come back (`remade`).
 */
export function editInsert(doc: JuraCADDocument, insertId: string, values: DesignValues): EditResult {
  return keepingScope(() => editNow(doc, insertId, values));
}

function editNow(doc: JuraCADDocument, insertId: string, values: DesignValues): EditResult {
  const insert = findInsert(doc, insertId);
  const design = insert && findDesign(insert.design);
  if (!insert || !design) throw new Error("That design isn't in this document any more.");
  const problems = valueProblems(design, values);
  if (problems.length) throw new Error(problems.join(" "));
  const studioId = insert.features.map((id) => studioOfFeature(doc, id)).find((s) => s !== null);
  if (!studioId) throw new Error(`${insert.name}'s features have all been deleted, so there's nothing to change. Insert it again from the Design library.`);
  const vars = [...(doc.variables ?? [])];
  const varIds: Record<string, string> = { ...(insert.variables ?? {}) };
  for (const i of variableInputs(design)) {
    const name = variableName(doc, insert, i.key);
    const value = tidy(Number(values[i.key]));
    const at = vars.findIndex((v) => v.name === name);
    if (at >= 0) {
      vars[at] = { ...vars[at], value };
      varIds[i.key] = vars[at].id;
    } else {
      // Deleted since: made again (under a free name, if the old one is now someone else's).
      let fresh = `${insert.prefix}_${i.key}`;
      for (let n = 2; vars.some((v) => v.name === fresh); n++) fresh = `${insert.prefix}_${i.key}${n}`;
      const v = { id: newId("v"), name: fresh, value };
      vars.push(v);
      varIds[i.key] = v.id;
    }
  }
  // The variables first (so every sketch using them is solved again), then the design's own features.
  let next = applyVariables(doc, vars);
  const updated: LibraryInsert = { ...insert, values: { ...values }, variables: varIds };
  const made = makeFeatures(next, design, updated);
  const old = new Set(insert.features);
  const remade: string[] = [];
  next = inStudio(next, studioId, (view) => {
    const fresh = new Map(made.features.map((f) => [f.id, f]));
    const there = new Set(view.features.map((f) => f.id));
    // Each of the design's features that's still there, remade in its own place (dropped if the design no longer makes it).
    const out: Feature[] = view.features.flatMap((f) => {
      if (!old.has(f.id)) return [f];
      const g = fresh.get(f.id);
      if (!g) return [];
      return [{ ...g, name: f.name, suppressed: f.suppressed, ...(f.folder ? { folder: f.folder } : {}), ...(f.visible !== undefined ? { visible: f.visible } : {}) }];
    });
    // The rest (new, or deleted by the user) go just before the design feature made after them (else after the one before).
    const missing = made.features.filter((f) => !there.has(f.id));
    const named = uniqueNames(missing, out);
    made.features.forEach((f, i) => {
      if (there.has(f.id)) return;
      const g = named[missing.indexOf(f)];
      if (old.has(f.id)) remade.push(g.name);
      const before = made.features.slice(0, i).reverse().find((x) => out.some((y) => y.id === x.id));
      const after = made.features.slice(i + 1).find((x) => out.some((y) => y.id === x.id));
      const at = after ? out.findIndex((y) => y.id === after.id) : before ? out.findIndex((y) => y.id === before.id) + 1 : out.length;
      out.splice(at, 0, g);
    });
    return { ...view, features: out };
  });
  updated.features = made.features.map((f) => f.id);
  next = withPartNames(next, made.partNames, false);
  return { doc: { ...next, libraryInserts: (next.libraryInserts ?? []).map((x) => (x.id === insertId ? updated : x)) }, remade };
}
