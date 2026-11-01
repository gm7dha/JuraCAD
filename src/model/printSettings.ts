/**
 * Settings for 3D printing: the nozzle, how steep an overhang can print without
 * support, the smallest wall, hole and pin that print well, and the clearances
 * ("fits") for printed parts that go together. They're kept with the chosen
 * printer in this browser (see PrintBedPanel); the fits can be copied into a
 * design as variables (fit_press, fit_snug, fit_sliding, fit_loose) so holes
 * typed as "5 + fit_sliding" follow them.
 */
import type { Variable } from "./variables";

export type FitName = "press" | "snug" | "sliding" | "loose";

export const FIT_NAMES: FitName[] = ["press", "snug", "sliding", "loose"];

export const FIT_LABELS: Record<FitName, { label: string; hint: string }> = {
  press: { label: "Press fit", hint: "Pushed in hard and stays put — a pin, bearing or magnet that mustn't fall out" },
  snug: { label: "Snug", hint: "Goes in by hand with a little push, with no wobble" },
  sliding: { label: "Sliding", hint: "Slides and turns freely without rattling — a hinge pin or a sliding lid" },
  loose: { label: "Loose", hint: "Drops in easily, with some play — for parts that must never stick" },
};

/** How much bigger than the thing that goes in to make a hole (on its diameter), mm. */
export type PrintFits = Record<FitName, number>;

/** Usual starting points for an FDM printer with a 0.4 mm nozzle (printed holes come out a little small). */
export const DEFAULT_FITS: PrintFits = { press: 0.1, snug: 0.2, sliding: 0.3, loose: 0.5 };

export interface PrintSettings {
  /** Nozzle width, mm. */
  nozzle: number;
  /** Faces leaning further than this from upright (degrees) need support. */
  overhangAngle: number;
  /** Thinnest wall that prints well, mm; null = two nozzle widths. */
  minWall: number | null;
  /** Narrowest hole that prints open, mm. */
  minHole: number;
  /** Thinnest pin or post that prints well, mm. */
  minPin: number;
  /** Space between parts when they're laid out on the bed, mm. */
  gap: number;
  fits: PrintFits;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  nozzle: 0.4,
  overhangAngle: 45,
  minWall: null,
  minHole: 2,
  minPin: 2,
  gap: 5,
  fits: DEFAULT_FITS,
};

/** The thinnest wall to allow: as set, or two nozzle widths. */
export function minWallOf(s: PrintSettings): number {
  return s.minWall ?? 2 * s.nozzle;
}

function numberIn(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** Settings read back from storage (anything missing or odd takes its usual value). */
export function parsePrintSettings(raw: unknown): PrintSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PRINT_SETTINGS;
  const f = (r.fits && typeof r.fits === "object" ? r.fits : {}) as Record<string, unknown>;
  const fits = Object.fromEntries(FIT_NAMES.map((n) => [n, numberIn(f[n], -2, 5, DEFAULT_FITS[n])])) as PrintFits;
  return {
    nozzle: numberIn(r.nozzle, 0.05, 3, d.nozzle),
    overhangAngle: numberIn(r.overhangAngle, 5, 85, d.overhangAngle),
    minWall: r.minWall === null || r.minWall === undefined ? null : numberIn(r.minWall, 0.01, 50, 2 * numberIn(r.nozzle, 0.05, 3, d.nozzle)),
    minHole: numberIn(r.minHole, 0, 50, d.minHole),
    minPin: numberIn(r.minPin, 0, 50, d.minPin),
    gap: numberIn(r.gap, 0, 100, d.gap),
    fits,
  };
}

/** The design variable that holds a fit's clearance. */
export function fitVariableName(fit: FitName): string {
  return `fit_${fit}`;
}

const mm = (v: number) => `${Math.round(v * 1000) / 1000} mm`;

/**
 * The design's variables with the four fit variables in place: missing ones
 * are added at the top (so anything can use them) with the clearances given;
 * with `update`, existing ones are set to those clearances too.
 */
export function withFitVariables(
  variables: readonly Variable[] = [],
  fits: PrintFits,
  newId: () => string,
  update = false,
): { variables: Variable[]; added: string[]; changed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const top: Variable[] = [];
  let list = [...variables];
  for (const fit of FIT_NAMES) {
    const name = fitVariableName(fit);
    const value = mm(fits[fit]);
    const existing = list.find((v) => v.name === name);
    if (!existing) {
      top.push({ id: newId(), name, value });
      added.push(name);
    } else if (update && existing.value !== value) {
      list = list.map((v) => (v === existing ? { ...v, value } : v));
      changed.push(name);
    }
  }
  return { variables: [...top, ...list], added, changed };
}

/** A hole size for something `nominal` across with a printed fit, e.g. "5 mm + fit_sliding". */
export function fitExpression(nominal: string, fit: FitName): string {
  return `${nominal.trim()} + ${fitVariableName(fit)}`;
}

/** The size and fit a hole was given by `fitExpression`, or null if it was typed some other way. */
export function parseFitExpression(expr: string): { nominal: string; fit: FitName } | null {
  const m = /^\s*(.+?)\s*\+\s*fit_(press|snug|sliding|loose)\s*$/.exec(expr ?? "");
  return m ? { nominal: m[1], fit: m[2] as FitName } : null;
}

/**
 * On Accept: a hole whose printed fit was chosen while the design had no fit
 * variables gets them now (with the clearances chosen then), and its size
 * becomes "<nominal> + fit_<fit>". Anything else is returned unchanged.
 */
export function settlePrintedFit<D extends { params: Record<string, string>; hole?: { printedFit?: { fit: FitName; nominal: string; fits: PrintFits } } }>(
  variables: readonly Variable[] | undefined,
  draft: D,
  newId: () => string,
): { variables: Variable[] | undefined; draft: D } {
  const pf = draft.hole?.printedFit;
  if (!draft.hole || !pf) return { variables: variables as Variable[] | undefined, draft };
  const { printedFit: _, ...hole } = draft.hole;
  void _;
  const added = withFitVariables(variables, pf.fits, newId);
  return {
    variables: added.added.length ? added.variables : (variables as Variable[] | undefined),
    draft: { ...draft, params: { ...draft.params, diameter: fitExpression(pf.nominal, pf.fit) }, hole },
  };
}
