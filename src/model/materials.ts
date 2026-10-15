/**
 * Materials, for working out what a part weighs. Densities in g/cm³
 * (typical values; filaments vary a little by brand and infill).
 */
export interface Material {
  key: string;
  label: string;
  density: number;
}

export const MATERIALS: Material[] = [
  { key: "pla", label: "PLA", density: 1.24 },
  { key: "petg", label: "PETG", density: 1.27 },
  { key: "abs", label: "ABS", density: 1.04 },
  { key: "asa", label: "ASA", density: 1.07 },
  { key: "tpu", label: "TPU (flexible)", density: 1.21 },
  { key: "nylon", label: "Nylon", density: 1.14 },
  { key: "resin", label: "Resin (SLA)", density: 1.15 },
  { key: "aluminium", label: "Aluminium", density: 2.7 },
  { key: "steel", label: "Steel", density: 7.85 },
  { key: "stainless", label: "Stainless steel", density: 8.0 },
  { key: "brass", label: "Brass", density: 8.5 },
  { key: "copper", label: "Copper", density: 8.96 },
  { key: "oak", label: "Wood (oak)", density: 0.75 },
];

/** Parts with no material set count as PLA (the usual 3D printing filament). */
export const DEFAULT_MATERIAL = "pla";

export const materialOf = (key: string | undefined): Material => MATERIALS.find((m) => m.key === key) ?? MATERIALS[0];

/** Mass in grams of `volumeMm3` of a material (solid — a print with less infill weighs less). */
export const massGrams = (volumeMm3: number, key: string | undefined) => (volumeMm3 / 1000) * materialOf(key).density;

/** "12.3 g", "1.24 kg". */
export function formatMass(grams: number): string {
  if (grams >= 1000) return `${Math.round(grams / 10) / 100} kg`;
  if (grams >= 100) return `${Math.round(grams)} g`;
  return `${Math.round(grams * 10) / 10} g`;
}

/** Part materials from a saved file (unknown materials are dropped). */
export function parseMaterials(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && MATERIALS.some((m) => m.key === key)) out[id] = key;
  }
  return out;
}
