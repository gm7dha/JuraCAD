/**
 * Import's Scale and File units (Onshape's), as plain numbers (pure: no OpenCascade).
 *
 * A file is read as it always was (STEP files in the units they say, STL files in the units chosen when they came in —
 * `ImportedFile.units`), and the part is then made bigger or smaller about the origin by `importScaleFactor`: the
 * Scale box times how much bigger the chosen File units are than the ones the file was read in. Missing (Scale 1,
 * units as in the file) = a factor of exactly 1, so older imports build exactly as before.
 */
import type { Feature, ImportedFile, ImportUnit } from "./types";

/** Millimetres in one of each unit. */
export const UNIT_MM: Record<ImportUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

/** The File units choices, in the order the dialog lists them. */
export const IMPORT_UNITS: { unit: ImportUnit; label: string }[] = [
  { unit: "mm", label: "Millimetres" },
  { unit: "cm", label: "Centimetres" },
  { unit: "m", label: "Metres" },
  { unit: "in", label: "Inches" },
  { unit: "ft", label: "Feet" },
];

export const isImportUnit = (u: unknown): u is ImportUnit => typeof u === "string" && Object.prototype.hasOwnProperty.call(UNIT_MM, u);

const SI_PREFIX: Record<string, number> = { "": 1000, $: 1000, MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6, MICRO: 1e-3, NANO: 1e-6 };
const CONVERSION: Record<string, number> = { INCH: 25.4, INCHES: 25.4, IN: 25.4, FOOT: 304.8, FEET: 304.8, FT: 304.8, MILLIMETRE: 1, MILLIMETER: 1, MM: 1, CENTIMETRE: 10, CENTIMETER: 10, CM: 10, METRE: 1000, METER: 1000, M: 1000 };

/**
 * The length unit a STEP file says it's in, as millimetres per unit (null when it doesn't say, or says something odd;
 * OpenCascade then reads it as millimetres). Looks at the first entity naming a LENGTH_UNIT:
 * `SI_UNIT(.MILLI.,.METRE.)` → 1, `SI_UNIT($,.METRE.)` → 1000, `CONVERSION_BASED_UNIT('INCH',…)` → 25.4.
 */
export function stepLengthUnit(text: string): number | null {
  // The unit the geometry uses is the one its GLOBAL_UNIT_ASSIGNED_CONTEXT names: other length units may come first
  // (an inch is defined from a millimetre unit, which some programs write before it).
  const ctx = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/i.exec(text);
  if (ctx) {
    for (const ref of ctx[1].split(",").map((r) => r.trim())) {
      const id = /^#(\d+)$/.exec(ref)?.[1];
      if (!id) continue;
      const at = new RegExp(`(^|[;\\s])#${id}\\s*=`).exec(text);
      if (!at) continue;
      const end = text.indexOf(";", at.index + at[0].length);
      if (end < 0) continue;
      const mm = lengthUnitOf(text.slice(at.index + at[0].length, end).toUpperCase());
      if (mm !== undefined) return mm;
    }
  }
  const re = /LENGTH_UNIT/gi;
  let m: RegExpExecArray | null;
  let tries = 0;
  while ((m = re.exec(text)) && tries++ < 50) {
    // The entity holding it: from the ";" before to the ";" after.
    const start = text.lastIndexOf(";", m.index) + 1;
    const end = text.indexOf(";", m.index);
    if (end < 0) continue;
    const entity = text.slice(start, end).trim().toUpperCase();
    // (A unit's dimensions, not a length unit itself.)
    if (/^#\d+\s*=\s*DIMENSIONAL_EXPONENTS/.test(entity)) continue;
    const mm = lengthUnitOf(entity);
    if (mm) return mm;
  }
  return null;
}

/** An entity's length unit in mm (null: a length unit not understood; undefined: not a length unit). */
function lengthUnitOf(entity: string): number | null | undefined {
  if (!/LENGTH_UNIT/.test(entity)) return undefined;
  const conv = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/.exec(entity);
  if (conv) return CONVERSION[conv[1].trim().toUpperCase().replace(/\s+/g, "")] ?? null;
  const si = /SI_UNIT\s*\(\s*(\$|\.([A-Z]+)\.)\s*,\s*\.METRE\.\s*\)/.exec(entity);
  if (si) return SI_PREFIX[si[2] ?? "$"] ?? null;
  return null;
}

/** Millimetres per unit the file was read in: an STL's chosen units, a STEP file's own (millimetres if it doesn't say). */
export function fileUnitMm(file: ImportedFile): number {
  if (file.format === "stl") return file.units === "in" ? 25.4 : 1;
  // (Every rebuild asks: the last few files' answers are kept, as a big file's text takes a moment to look through.)
  let mm = stepUnits.get(file.data);
  if (mm === undefined) {
    mm = stepLengthUnit(file.data) ?? 1;
    stepUnits.set(file.data, mm);
    if (stepUnits.size > 8) stepUnits.delete(stepUnits.keys().next().value as string);
  }
  return mm;
}
const stepUnits = new Map<string, number>();

/** The unit the file was read in, when it's one of the File units choices (for "As in the file (inches)"). */
export function fileUnitOf(file: ImportedFile): ImportUnit | null {
  const mm = fileUnitMm(file);
  return IMPORT_UNITS.find((u) => Math.abs(UNIT_MM[u.unit] - mm) < 1e-9)?.unit ?? null;
}

/**
 * How much bigger the imported part is made than the file as read: `scale` × (chosen units ÷ the file's own).
 * Exactly 1 for Scale 1 with units as in the file, or the same units the file says.
 */
export function importScaleFactor(file: ImportedFile, units: ImportUnit | undefined, scale = 1): number {
  if (!units) return scale;
  const own = fileUnitMm(file);
  const ratio = UNIT_MM[units] / own;
  return Math.abs(ratio - 1) < 1e-12 ? scale : scale * ratio;
}

/** An import feature's factor, from its Scale value (resolveParams) and File units. */
export function featureImportFactor(feature: Pick<Feature, "import" | "importUnits">, scale: number | undefined): number {
  const s = typeof scale === "number" && Number.isFinite(scale) ? scale : 1;
  return feature.import ? importScaleFactor(feature.import, feature.importUnits, s) : s;
}

/** A box's size as "120 × 40 × 10 mm" (in the design's units: lengths given in mm, shown by `show`). */
export function sizeText(lo: readonly number[], hi: readonly number[], show: (mm: number) => string): string {
  return [0, 1, 2].map((i) => show(Math.max(0, hi[i] - lo[i]))).join(" × ");
}
