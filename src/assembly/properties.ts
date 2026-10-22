/**
 * Part properties for parts lists (like Onshape's): a part number, a
 * description and properties of your own (Supplier, Finish…). They belong to
 * the part, so every assembly's parts list (and drawings of it) shows them.
 */
import type { JuraCADDocument, PartProperties } from "../model/types";

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Properties with blanks left out (null when nothing's left). */
export function tidyProperties(p: PartProperties): PartProperties | null {
  const number = clean(p.number, 60);
  const description = clean(p.description, 200);
  const seen = new Set<string>();
  const custom: { name: string; value: string }[] = [];
  for (const c of p.custom ?? []) {
    const name = clean(c?.name, 40);
    const value = clean(c?.value, 200);
    // One of each name (the first), and only ones with a name and a value.
    if (!name || !value || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    custom.push({ name, value });
  }
  const out: PartProperties = { ...(number ? { number } : {}), ...(description ? { description } : {}), ...(custom.length ? { custom } : {}) };
  return Object.keys(out).length ? out : null;
}

/** Set (or, when empty, clear) a part's properties. */
export function setPartProperties(doc: JuraCADDocument, partId: string, props: PartProperties): JuraCADDocument {
  const all = { ...(doc.partProperties ?? {}) };
  const tidy = tidyProperties(props);
  if (tidy) all[partId] = tidy;
  else delete all[partId];
  const { partProperties: _old, ...rest } = doc;
  return Object.keys(all).length ? { ...rest, partProperties: all } : rest;
}

/** Part properties from a file: anything odd is dropped. */
export function parsePartProperties(raw: unknown): Record<string, PartProperties> {
  const out: Record<string, PartProperties> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const custom = Array.isArray(r.custom) ? r.custom.filter((c): c is { name: string; value: string } => !!c && typeof c === "object") : [];
    const tidy = tidyProperties({ number: r.number as string, description: r.description as string, custom });
    if (tidy) out[id] = tidy;
  }
  return out;
}

/** The names of the custom properties used by any of these, in the order first met (for parts list columns). */
export function customColumns(list: (PartProperties | undefined)[]): string[] {
  const names: string[] = [];
  for (const p of list) for (const c of p?.custom ?? []) if (!names.some((n) => n.toLowerCase() === c.name.toLowerCase())) names.push(c.name);
  return names;
}

/** A custom property's value (names match whatever their capitals). */
export function customValue(p: PartProperties | undefined, name: string): string {
  return p?.custom?.find((c) => c.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
