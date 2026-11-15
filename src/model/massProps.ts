/**
 * Mass properties (Onshape's Mass properties tool), pure: the engine measures each part exactly (volume, surface
 * area, centre of mass, box — src/kernel/massProps.ts); this adds them up with each part's density, works out the
 * weight and a printed-weight guess, and lays the numbers out as rows to show or copy.
 */
import { materialOf } from "./materials";

type Vec3 = [number, number, number];

/** One part as the engine measured it (mm, mm², mm³). */
export interface PartMassProps {
  partId: string;
  name: string;
  volume: number;
  area: number;
  /** Centre of mass of the solid (of its skin for a surface). */
  centre: Vec3;
  /** Its box: [lowest corner, highest corner]. */
  box: [Vec3, Vec3];
  surface?: true;
}

export interface MassSummary {
  count: number;
  volume: number;
  area: number;
  /** Grams. */
  mass: number;
  /** Mass-weighted centre (volume-weighted when nothing weighs anything; area-weighted for surfaces only). */
  centre: Vec3 | null;
  box: [Vec3, Vec3] | null;
  /** Grams if 3D printed with the usual settings (walls + 15% infill), solids only; 0 unless every solid is a printable plastic. */
  printed: number;
  /** Every part made of the same density: that density (g/cm³), else null. */
  density: number | null;
}

/** What "density" means for the summary: each part's own material, or one density for all. */
export type DensityChoice = { kind: "own"; materials: Record<string, string> } | { kind: "all"; density: number };

export function densityFor(choice: DensityChoice, partId: string): number {
  return choice.kind === "all" ? choice.density : materialOf(choice.materials[partId]).density;
}

/** The material key a part is weighed as (undefined for a typed density). */
export function materialKeyFor(choice: DensityChoice | { kind: "material"; key: string }, partId: string): string | undefined {
  if (choice.kind === "material") return choice.key;
  return choice.kind === "own" ? materialOf(choice.materials[partId]).key : undefined;
}

/** Bambu Studio's usual profile: 2 walls of 0.42 mm and 15% sparse infill. Tops/bottoms count as walls. */
export const PRINT_SHELL = 0.84;
export const PRINT_INFILL = 0.15;
/** Only materials at most this dense (g/cm³) count as printed plastic: filaments and resin, not metal or wood. */
export const PRINTABLE_DENSITY = 2;
const NOT_PRINTED = new Set(["aluminium", "steel", "stainless", "brass", "copper", "oak"]);

/** Whether a part of this material (key, or just a density) gets a printed-weight guess. */
export function printable(density: number, key?: string): boolean {
  return density <= PRINTABLE_DENSITY && !(key && NOT_PRINTED.has(key));
}

/**
 * About what a solid weighs printed (grams): its skin `shell` mm thick is solid, the rest `infill` full. The skin's
 * volume is taken as area × shell (a little over at corners), never more than the whole part.
 */
export function printedGrams(volume: number, area: number, density: number, shell = PRINT_SHELL, infill = PRINT_INFILL): number {
  if (!(volume > 0)) return 0;
  const skin = Math.min(volume, Math.max(0, area) * shell);
  return ((skin + infill * (volume - skin)) / 1000) * density;
}

/** All the chosen parts added up. */
export function massSummary(parts: PartMassProps[], density: (partId: string) => number, materialKey: (partId: string) => string | undefined = () => undefined): MassSummary {
  let volume = 0;
  let area = 0;
  let mass = 0;
  let printed = 0;
  const sum = (w: number, c: Vec3, acc: [number, number, number, number]) => {
    acc[0] += w * c[0];
    acc[1] += w * c[1];
    acc[2] += w * c[2];
    acc[3] += w;
  };
  const byMass: [number, number, number, number] = [0, 0, 0, 0];
  const byVolume: [number, number, number, number] = [0, 0, 0, 0];
  const byArea: [number, number, number, number] = [0, 0, 0, 0];
  let lo: Vec3 | null = null;
  let hi: Vec3 | null = null;
  const densities = new Set<number>();
  let allPrintable = true;
  for (const p of parts) {
    const d = density(p.partId);
    const v = p.surface ? 0 : p.volume;
    volume += v;
    area += p.area;
    const m = (v / 1000) * d;
    mass += m;
    if (!p.surface) {
      densities.add(d);
      printed += printedGrams(v, p.area, d);
      if (!printable(d, materialKey(p.partId))) allPrintable = false;
    }
    sum(m, p.centre, byMass);
    sum(v, p.centre, byVolume);
    sum(p.area, p.centre, byArea);
    lo = lo ? [Math.min(lo[0], p.box[0][0]), Math.min(lo[1], p.box[0][1]), Math.min(lo[2], p.box[0][2])] : [...p.box[0]];
    hi = hi ? [Math.max(hi[0], p.box[1][0]), Math.max(hi[1], p.box[1][1]), Math.max(hi[2], p.box[1][2])] : [...p.box[1]];
  }
  const pick = [byMass, byVolume, byArea].find((a) => a[3] > 1e-12);
  const centre: Vec3 | null = pick ? [pick[0] / pick[3], pick[1] / pick[3], pick[2] / pick[3]] : null;
  return {
    count: parts.length,
    volume,
    area,
    mass,
    centre,
    box: lo && hi ? [lo, hi] : null,
    printed: allPrintable ? printed : 0,
    density: densities.size === 1 ? [...densities][0] : null,
  };
}

/** How numbers are written (the app passes its unit-aware formatters). */
export interface MassFormat {
  length: (mm: number) => string;
  area: (mm2: number) => string;
  volume: (mm3: number) => string;
  mass: (g: number) => string;
}

/** Onshape-style rows: [label, value]. */
export function massRows(s: MassSummary, f: MassFormat): [string, string][] {
  const rows: [string, string][] = [];
  const solid = s.volume > 0;
  if (solid) rows.push(["Mass", f.mass(s.mass)]);
  if (solid && s.printed > 0) rows.push(["  printed (about)", f.mass(s.printed)]);
  if (solid) rows.push(["Volume", f.volume(s.volume)]);
  rows.push(["Surface area", f.area(s.area)]);
  if (s.density !== null && solid) rows.push(["Density", `${round(s.density, 3)} g/cm³`]);
  if (s.centre) {
    const [x, y, z] = s.centre;
    rows.push(["Centre of mass", `${f.length(x)}, ${f.length(y)}, ${f.length(z)}`]);
  }
  if (s.box) {
    const [a, b] = s.box;
    rows.push(["Size (X × Y × Z)", `${f.length(b[0] - a[0])} × ${f.length(b[1] - a[1])} × ${f.length(b[2] - a[2])}`]);
  }
  return rows;
}

/** Rows as plain text, one "Label: value" per line, for the clipboard. */
export function rowsText(title: string, rows: [string, string][]): string {
  return [title, ...rows.map(([k, v]) => `${k.trim()}: ${v}`)].join("\n");
}

/** Pounds for inch designs ("0.27 lb"), grams otherwise. */
export function massIn(grams: number, inches: boolean, grammes: (g: number) => string): string {
  if (!inches) return grammes(grams);
  const lb = grams / 453.59237;
  return lb >= 10 ? `${round(lb, 1)} lb` : lb >= 0.1 ? `${round(lb, 2)} lb` : `${round(lb * 16, 2)} oz`;
}

function round(v: number, places: number): number {
  const k = 10 ** places;
  return Math.round(v * k) / k;
}
