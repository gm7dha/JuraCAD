/** Reading the Design library's records from a saved file (untrusted JSON). */
import type { DesignValues, LibraryInsert } from "./types";

const PREFIX = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;

export function parseLibraryInserts(raw: unknown): LibraryInsert[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryInsert[] = [];
  for (const r of raw.slice(0, 1000)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || out.some((x) => x.id === o.id)) continue;
    if (typeof o.design !== "string" || typeof o.prefix !== "string" || !PREFIX.test(o.prefix)) continue;
    const values: DesignValues = {};
    if (o.values && typeof o.values === "object") {
      for (const [k, v] of Object.entries(o.values as Record<string, unknown>).slice(0, 100)) {
        if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && v.length <= 100)) values[k] = v;
      }
    }
    const features = Array.isArray(o.features) ? o.features.filter((x): x is string => typeof x === "string").slice(0, 1000) : [];
    const variables: Record<string, string> = {};
    if (o.variables && typeof o.variables === "object" && !Array.isArray(o.variables)) {
      for (const [k, v] of Object.entries(o.variables as Record<string, unknown>).slice(0, 100)) if (typeof v === "string" && v) variables[k] = v;
    }
    out.push({
      id: o.id,
      design: o.design,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : "Design",
      prefix: o.prefix,
      values,
      features,
      ...(Object.keys(variables).length ? { variables } : {}),
    });
  }
  return out;
}
