/**
 * Configurations: different versions of the same design kept side by side —
 * a small and a large bracket, a version with or without the mounting holes.
 * Each one remembers the variables' values and which features are suppressed;
 * choosing one puts those back (Onshape's configurations, kept simple).
 *
 * The configuration on show is always what the variables and features say
 * now: switching first saves the current state into the one being left.
 */
import { newId } from "./document";
import { allFeatures, mapAllFeatures } from "./studios";
import type { PartSmithDocument } from "./types";
import { applyVariables } from "./variables";

export interface Configuration {
  id: string;
  name: string;
  /** Variable values as typed, by variable id. */
  values: Record<string, string>;
  /** Features suppressed in this configuration (ids). */
  suppressed: string[];
}

/** The document's state now, as a configuration's contents. */
export function snapshot(doc: PartSmithDocument): Pick<Configuration, "values" | "suppressed"> {
  return {
    values: Object.fromEntries((doc.variables ?? []).map((v) => [v.id, v.value])),
    suppressed: allFeatures(doc)
      .filter((f) => f.suppressed)
      .map((f) => f.id),
  };
}

/** The configuration on show (null when there are none). */
export function activeConfiguration(doc: PartSmithDocument): Configuration | null {
  const list = doc.configurations ?? [];
  return list.find((c) => c.id === doc.activeConfiguration) ?? list[0] ?? null;
}

/** Save the current state into the configuration on show. */
function remember(doc: PartSmithDocument): PartSmithDocument {
  const active = activeConfiguration(doc);
  if (!active) return doc;
  const now = snapshot(doc);
  return { ...doc, configurations: (doc.configurations ?? []).map((c) => (c.id === active.id ? { ...c, ...now } : c)) };
}

/** "Configuration 2", "Configuration 3"… */
export function nextConfigurationName(doc: PartSmithDocument): string {
  const used = new Set((doc.configurations ?? []).map((c) => c.name));
  let n = (doc.configurations?.length ?? 0) + 1;
  while (used.has(`Configuration ${n}`)) n++;
  return `Configuration ${n}`;
}

/**
 * Add a configuration that starts as a copy of the current state, and show it.
 * The very first time, the current state is kept as "Default" too.
 */
export function addConfiguration(doc: PartSmithDocument, name: string, id = newId("cfg")): PartSmithDocument {
  let next = remember(doc);
  const list = [...(next.configurations ?? [])];
  if (!list.length) list.push({ id: newId("cfg"), name: "Default", ...snapshot(next) });
  list.push({ id, name: name.trim() || nextConfigurationName(next), ...snapshot(next) });
  next = { ...next, configurations: list, activeConfiguration: id };
  return next;
}

/** Show another configuration: its variable values and suppressed features come back. */
export function switchConfiguration(doc: PartSmithDocument, id: string): PartSmithDocument {
  const target = doc.configurations?.find((c) => c.id === id);
  if (!target || activeConfiguration(doc)?.id === id) return doc;
  const saved = remember(doc);
  const off = new Set(target.suppressed);
  let next = mapAllFeatures(saved, (f) => (!!f.suppressed === off.has(f.id) ? f : { ...f, suppressed: off.has(f.id) }));
  const variables = (next.variables ?? []).map((v) => (target.values[v.id] !== undefined ? { ...v, value: target.values[v.id] } : v));
  next = { ...next, activeConfiguration: id };
  return variables.length ? applyVariables(next, variables) : next;
}

export function renameConfiguration(doc: PartSmithDocument, id: string, name: string): PartSmithDocument {
  const n = name.trim();
  if (!n) return doc;
  return { ...doc, configurations: (doc.configurations ?? []).map((c) => (c.id === id ? { ...c, name: n.slice(0, 60) } : c)) };
}

/** Forget a configuration (the one on show stays as it is; with one left, the list goes). */
export function removeConfiguration(doc: PartSmithDocument, id: string): PartSmithDocument {
  const left = (doc.configurations ?? []).filter((c) => c.id !== id);
  const { configurations: _c, activeConfiguration: _a, ...rest } = doc;
  if (left.length < 2) return rest;
  const active = activeConfiguration(doc)?.id === id ? left[0].id : doc.activeConfiguration;
  // Leaving the one on show: the document carries on as it is, now counted as the first remaining one.
  if (activeConfiguration(doc)?.id === id) left[0] = { ...left[0], ...snapshot(doc) };
  return { ...rest, configurations: left, ...(active ? { activeConfiguration: active } : {}) };
}

/** Read saved configurations (only usable ones). */
export function parseConfigurations(raw: unknown): Configuration[] {
  if (!Array.isArray(raw)) return [];
  const out: Configuration[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || out.some((c) => c.id === r.id)) continue;
    const values = Object.fromEntries(
      Object.entries((r.values ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    const suppressed = (Array.isArray(r.suppressed) ? r.suppressed : []).filter((x): x is string => typeof x === "string");
    out.push({ id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 60) : "Configuration", values, suppressed });
  }
  return out.length >= 2 ? out : [];
}
