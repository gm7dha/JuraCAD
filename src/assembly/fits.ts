/**
 * The fit check: how tightly parts that sit together fit, as Onshape's and
 * SolidWorks' interference detection report it, plus the gaps (clearance) of
 * parts that nearly touch — for printed parts that must press in or slide.
 *
 *  - An overlap (interference) is measured as how far one part goes into the
 *    other, square to where they meet: exactly for a pin in a hole (round faces
 *    on one axis, `ContactMeasure.ring`), otherwise estimated from the shared
 *    piece (see `overlapThickness`).
 *  - A gap is the smallest distance between them, or for a pin in a hole the
 *    gap all round it.
 *  - For a pin in a hole the amount is given on the diameter (as hole fits
 *    and the printed fits in printSettings are), with the amount a side too.
 *
 * Pairs can be marked as meant to fit (`Assembly.fits`): a press fit wants an
 * overlap in its range, a clearance fit a gap in its range. Marked overlaps
 * are judged here instead of being listed as clashes. All pure (no engine).
 */
import type { ContactMeasure } from "../kernel/protocol";
import type { Finding } from "../model/checkReport";
import { DEFAULT_FITS, FIT_LABELS, FIT_NAMES, fitVariableName, type FitName, type PrintFits } from "../model/printSettings";
import type { Assembly, Instance, IntendedFit, Mate } from "../model/types";
import { formatLength } from "../model/units";

/** mm: parts up to this far apart have their gap measured (and listed). */
export const FIT_RANGE = 1;

/** The most a fit's wanted amount can be, mm. */
export const MAX_FIT = 10;

/** mm: the furthest apart the fit check ever measures (a marked clearance fit can stretch FIT_RANGE up to this). */
export const MAX_FIT_RANGE = 3;

/** How far apart parts are measured for these marked fits: FIT_RANGE, more for a looser marked clearance, at most MAX_FIT_RANGE. */
export function fitRangeFor(fits: readonly IntendedFit[] = []): number {
  const wanted = fits.filter((f) => f.kind !== "press").map((f) => f.max + 0.5);
  return Math.min(MAX_FIT_RANGE, Math.max(FIT_RANGE, ...wanted));
}

/** What each kind of fit is called. */
export const FIT_KIND_LABELS: Record<IntendedFit["kind"], string> = {
  press: "press fit",
  printed: "printed press fit",
  clearance: "clearance fit",
};

/** One line saying what the fits are, for the top of the Fits section. */
export const FIT_EXPLAINED =
  "A press (interference) fit is made a little too big on purpose, so it has to be pushed in and then grips; a clearance fit leaves a small gap so it slides or turns. For printing, a press fit is drawn with a small gap (a printed press fit), as printed holes come out a little small.";

/** How two parts that sit together fit, as measured. */
export interface MeasuredFit {
  a: string;
  b: string;
  ids?: [string, string];
  /** They share some space (interference), or there's a gap between them (clearance). */
  kind: "overlap" | "gap";
  /** How deep the overlap goes, or how wide the gap is, square to where they meet (a side), mm. */
  side: number;
  /** A pin in a hole (on one axis): `amount` is then on the diameter. */
  round: boolean;
  /** The pin's diameter (round only). */
  diameter?: number;
  /** The amount compared with a marked fit's range: on the diameter when round (2 × side), else `side`. */
  amount: number;
  /** The overlap's volume (mm³). */
  volume?: number;
  /** A pin beside a hole of about its size but not lined up with it: how far off (mm). Its amount then means little. */
  offAxis?: number;
}

/**
 * How thick a shared piece of two solids is, about: 2 × volume ÷ area (exact
 * for a thin flat slab or sleeve) or, for a compact chunk at a corner or edge,
 * the smallest side of the box round it (see judgeContact).
 */
export function overlapThickness(m: ContactMeasure): number {
  const v = m.volume ?? 0;
  const slab = m.area && m.area > 0 ? (2 * v) / m.area : Infinity;
  const box = m.boxMin ?? 0;
  return box > slab && box <= 3 * slab * (1 + 1e-6) ? box : slab;
}

/** A measured pair as a fit, or null (surfaces, or nothing measured close enough). */
export function measuredFit(m: ContactMeasure): MeasuredFit | null {
  if (m.surfaceA || m.surfaceB) return null;
  const base = { a: m.a, b: m.b, ...(m.ids ? { ids: m.ids } : {}), ...(m.offAxis ? { offAxis: m.offAxis.off } : {}) };
  const v = m.volume ?? 0;
  if (v > 1e-6) {
    // A pin bigger than its hole: exactly how much. Otherwise (or when the overlap is elsewhere) the estimate.
    if (m.ring && m.ring.radial < 0) {
      const side = -m.ring.radial;
      return { ...base, kind: "overlap", side, round: true, diameter: m.ring.diameter, amount: 2 * side, volume: v };
    }
    const side = overlapThickness(m);
    if (!Number.isFinite(side)) return null;
    return { ...base, kind: "overlap", side, round: false, amount: side, volume: v };
  }
  if (m.ring && m.ring.radial >= 0) return { ...base, kind: "gap", side: m.ring.radial, round: true, diameter: m.ring.diameter, amount: 2 * m.ring.radial };
  if (m.gap !== undefined) return { ...base, kind: "gap", side: m.gap, round: false, amount: m.gap };
  // Only an off-centre pin was found (further apart than measured): still worth saying.
  if (m.offAxis) return { ...base, kind: "gap", side: Math.max(0, m.offAxis.radial - m.offAxis.off), round: false, amount: Math.max(0, m.offAxis.radial - m.offAxis.off) };
  return null;
}

/** Same pair either way round. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const mm = (v: number) => formatLength(v, undefined, 3);

/** "0.1 mm on the diameter (0.05 mm a side)" or "0.1 mm". */
export function amountText(f: Pick<MeasuredFit, "side" | "round">): string {
  return f.round ? `${mm(2 * f.side)} on the diameter (${mm(f.side)} a side)` : mm(f.side);
}

/**
 * Which of the printer's fits a gap (on the diameter, mm) is closest to: "about
 * a sliding fit for your printer (0.3 mm)", or tighter/looser than any of them.
 * Fits are told apart half-way between their clearances.
 */
export function printFitHint(diametral: number, fits: PrintFits): string {
  const order = [...FIT_NAMES].sort((x, y) => fits[x] - fits[y]);
  const val = (n: FitName) => fits[n];
  const label = (n: FitName) => FIT_LABELS[n].label.toLowerCase().replace(/ fit$/, "");
  const first = order[0];
  const last = order[order.length - 1];
  const step0 = order.length > 1 ? val(order[1]) - val(first) : 0.1;
  const stepN = order.length > 1 ? val(last) - val(order[order.length - 2]) : 0.1;
  if (diametral < val(first) - step0 / 2) return `tighter than your printer's ${label(first)} fit (${mm(val(first))}) — printed holes come out a little small, so it may not go in`;
  if (diametral > val(last) + stepN / 2) return `looser than your printer's ${label(last)} fit (${mm(val(last))}) — it will rattle`;
  let best = first;
  for (const n of order) if (Math.abs(diametral - val(n)) < Math.abs(diametral - val(best))) best = n;
  return `about a ${label(best)} fit for your printer (${mm(val(best))})`;
}

/**
 * The printed fits to compare gaps with: the design's own fit_press/fit_snug/
 * fit_sliding/fit_loose variables where it has them (so the check uses what its
 * holes were made with), else `fallback` (the app: the printer settings; the
 * extension: the usual values). `valueOf` reads a variable's mm value (null if
 * it isn't a plain length).
 */
export function printFitsFrom(variables: readonly { name: string; value: string }[] | undefined, valueOf: (text: string) => number | null, fallback: PrintFits): PrintFits {
  const out = { ...fallback };
  for (const n of FIT_NAMES) {
    const v = (variables ?? []).find((x) => x.name === fitVariableName(n));
    if (!v) continue;
    const mmValue = valueOf(v.value);
    if (mmValue !== null && Number.isFinite(mmValue)) out[n] = mmValue;
  }
  return out;
}

/** The two parts a mate joins, as keys like IntendedFit's (null for a mate to the assembly's origin). */
export function matePair(m: Mate): [string, string] | null {
  const key = (c: Mate["a"]) => [c.instanceId, ...(c.path ?? [])].join("/");
  if (m.a.instanceId === "@origin" || m.b.instanceId === "@origin") return null;
  const a = key(m.a);
  const b = key(m.b);
  return a === b ? null : [a, b];
}

export interface FitsInput {
  /** What the engine measured (with `fitRange`), every pair. */
  measured: readonly ContactMeasure[];
  /** The pairs marked as meant to fit. */
  intended: readonly IntendedFit[];
  /** Touching tolerance, mm: smaller gaps (not on a pin) aren't listed as clearances. */
  tolerance: number;
  /** The printer's fits, to say which a gap is like (none: not said). */
  printFits?: PrintFits;
  /** A part's name by its key, for marked pairs that weren't measured (undefined: not in the check). */
  nameOf: (key: string) => string | undefined;
}

/** A finding in the Fits section, with the pair it's about so the app can offer to mark or change it. */
export interface FitFinding extends Finding {
  pair?: { a: string; b: string; names: [string, string]; fit?: IntendedFit; measured?: MeasuredFit };
}

export interface FitsResult {
  findings: FitFinding[];
  /** Pairs (pairKey of the two parts' keys) judged here, so they aren't listed as clashes too. */
  handled: Set<string>;
  /** How many fits need a look (warnings). */
  warnings: number;
}

const range = (f: IntendedFit) => (f.min === f.max ? mm(f.min) : `${mm(f.min)}–${mm(f.max)}`.replace(/ mm–/, "–"));

/** Judge one marked fit against what was measured (null: they're further apart than the check measures). */
export function judgeIntended(fit: IntendedFit, names: [string, string], got: MeasuredFit | null, tolerance: number, printFits?: PrintFits): Finding {
  const who = `${names[0]} and ${names[1]}`;
  const wanted = `wanted ${range(fit)}${got?.round ? " on the diameter" : ""}`;
  const tol = Math.max(0, tolerance);
  const inRange = (v: number) => v >= fit.min - 1e-6 && v <= fit.max + 1e-6;
  const far = `more than ${mm(fitRangeFor([fit]))} apart`;
  // A pin beside its hole but not lined up: whatever amount comes out is meaningless.
  if (got?.offAxis !== undefined)
    return {
      level: "warn",
      text: `${who}: the pin isn't lined up with the hole (off by ${mm(got.offAxis)}), so the ${FIT_KIND_LABELS[fit.kind]} can't be measured. Line them up (a Cylindrical or Revolute mate does it), then check again.`,
    };
  if (fit.kind === "press") {
    if (!got) return { level: "warn", text: `${who}: meant to be a press fit, but they don't touch (${far}).` };
    if (got.kind === "gap") {
      if (got.round && got.side <= tol + 1e-9 && inRange(0)) return { level: "ok", text: `${who}: press fit OK — they just touch (${wanted}).` };
      const printed = printFits
        ? ` If it's for printing, that may be right: printed holes come out a little small, so a printed press fit is drawn with a small gap (yours is ${mm(printFits.press)} on the diameter) — mark it as a printed press fit instead.`
        : "";
      return { level: "warn", text: `${who}: meant to be a press fit, but there's a gap of ${amountText(got)} instead of an overlap — it won't grip (${wanted}).${printed}` };
    }
    if (!got.round)
      return {
        level: "warn",
        text: `${who}: press fit not checked exactly — about ${mm(got.side)} of interference, only an estimate as they don't meet as a pin in a hole (${wanted}). Measure it to be sure.`,
      };
    if (inRange(got.amount)) return { level: "ok", text: `${who}: press fit OK — ${amountText(got)} of interference (${wanted}).` };
    return got.amount > fit.max
      ? { level: "warn", text: `${who}: press fit too tight — ${amountText(got)} of interference (${wanted}). Make the hole a little bigger or the pin a little smaller.` }
      : { level: "warn", text: `${who}: press fit too loose — only ${amountText(got)} of interference (${wanted}). It may not grip.` };
  }
  const printed = fit.kind === "printed";
  const what = printed ? "printed press fit" : "clearance";
  if (!got) return { level: "warn", text: `${who}: meant to be a ${printed ? "printed press fit" : "clearance fit"}, but they're ${far}.` };
  if (got.kind === "overlap")
    return {
      level: "warn",
      text: printed
        ? `${who}: meant to be a printed press fit (a small gap in the design), but they overlap by ${amountText(got)} — printed, it would be far too tight (${wanted}).`
        : `${who}: meant to have a gap, but they overlap by ${amountText(got)} — it won't go in (${wanted}).`,
    };
  if (inRange(got.amount)) return { level: "ok", text: `${who}: ${what} OK — a gap of ${amountText(got)} (${wanted}).` };
  if (printed)
    return got.amount < fit.min
      ? { level: "warn", text: `${who}: printed press fit too tight — a gap of only ${amountText(got)} (${wanted}). Printed, it may not go in.` }
      : { level: "warn", text: `${who}: printed press fit too loose — a gap of ${amountText(got)} (${wanted}). Printed, it may not grip.` };
  return got.amount < fit.min
    ? { level: "warn", text: `${who}: clearance too tight — a gap of only ${amountText(got)} (${wanted}). It may stick.` }
    : { level: "warn", text: `${who}: clearance too loose — a gap of ${amountText(got)} (${wanted}). It may wobble.` };
}

/**
 * The Fits section: every marked fit judged, then the gaps of other pairs that
 * nearly touch (a pin in a hole always; flat faces only when the gap is more
 * than the touching tolerance), each with which printed fit it's like.
 */
export function judgeFits(input: FitsInput): FitsResult {
  const tol = Math.max(0, input.tolerance);
  const fits = input.measured.map(measuredFit).filter((f): f is MeasuredFit => !!f);
  const byIds = new Map<string, MeasuredFit>();
  for (const f of fits) if (f.ids) byIds.set(pairKey(f.ids[0], f.ids[1]), f);
  const findings: FitFinding[] = [{ level: "ok", text: FIT_EXPLAINED }];
  const handled = new Set<string>();
  const marked = new Set<string>();
  let warnings = 0;
  for (const fit of input.intended) {
    const key = pairKey(fit.a, fit.b);
    marked.add(key);
    const got = byIds.get(key) ?? null;
    const na = got ? (got.ids![0] === fit.a ? got.a : got.b) : input.nameOf(fit.a);
    const nb = got ? (got.ids![0] === fit.a ? got.b : got.a) : input.nameOf(fit.b);
    if (na === undefined || nb === undefined) {
      // A part that's gone, suppressed or left out of the check: nothing to judge, but the mark can still be changed or taken away.
      const names: [string, string] = [na ?? "a part that's not in the check", nb ?? "a part that's not in the check"];
      findings.push({ level: "ok", text: `A ${FIT_KIND_LABELS[fit.kind]} wasn't checked: one of its parts is missing, suppressed or left out.`, pair: { a: fit.a, b: fit.b, names, fit } });
      continue;
    }
    if (got) handled.add(key);
    const f = judgeIntended(fit, [na, nb], got, tol, input.printFits);
    if (f.level !== "ok") warnings++;
    findings.push({ ...f, pair: { a: fit.a, b: fit.b, names: [na, nb], fit, ...(got ? { measured: got } : {}) } });
  }
  // Pairs not marked: clearances listed with the printer's fit they're like; overlaps stay clashes.
  const clear = fits
    .filter((f) => !(f.ids && marked.has(pairKey(f.ids[0], f.ids[1]))))
    .filter((f) => f.kind === "gap" && f.side <= FIT_RANGE + 1e-9 && (f.round || f.offAxis !== undefined || f.side > tol + 1e-9))
    .sort((x, y) => x.side - y.side);
  for (const f of clear) {
    if (f.offAxis !== undefined) {
      findings.push({ level: "ok", text: `${f.a} and ${f.b}: a pin sits ${mm(f.offAxis)} off the middle of its hole.`, ...(f.ids ? { pair: { a: f.ids[0], b: f.ids[1], names: [f.a, f.b], measured: f } } : {}) });
      continue;
    }
    const hint = input.printFits && f.round ? ` — ${printFitHint(f.amount, input.printFits)}` : "";
    const text = f.round ? `${f.a} and ${f.b}: a gap of ${amountText(f)} round the pin${hint}.` : `${f.a} and ${f.b}: ${mm(f.side)} apart at the closest.`;
    findings.push({ level: "ok", text, ...(f.ids ? { pair: { a: f.ids[0], b: f.ids[1], names: [f.a, f.b], measured: f } } : {}) });
  }
  const overlaps = fits.filter((f) => f.kind === "overlap" && !(f.ids && marked.has(pairKey(f.ids[0], f.ids[1]))));
  for (const f of overlaps.filter((x) => x.offAxis !== undefined)) findings.push({ level: "ok", text: `${f.a} and ${f.b}: a pin sits ${mm(f.offAxis!)} off the middle of its hole, so it's pushed into one side.` });
  if (overlaps.length) findings.push({ level: "ok", text: "Parts that overlap are listed under Clashes — mark one as a press fit if it's meant to be tight." });
  if (findings.length === 1) findings.push({ level: "ok", text: `No parts sit close together (within ${mm(FIT_RANGE)}), and no fits are marked.` });
  return { findings, handled, warnings };
}

// ---------------------------------------------------------------------------
// Document edits and reading files

/** The assembly with this fit added, or put in place of one for the same pair (or with the same id). */
export function putFit(a: Assembly, fit: IntendedFit): Assembly {
  const key = pairKey(fit.a, fit.b);
  const rest = (a.fits ?? []).filter((f) => f.id !== fit.id && pairKey(f.a, f.b) !== key);
  return { ...a, fits: [...rest, fit] };
}

/** The assembly without this fit (no `fits` at all when none are left). */
export function removeFit(a: Assembly, id: string): Assembly {
  const left = (a.fits ?? []).filter((f) => f.id !== id);
  if (left.length === (a.fits ?? []).length) return a;
  const { fits: _, ...rest } = a;
  void _;
  return left.length ? { ...rest, fits: left } : rest;
}

/** The fit marked for a pair, if any. */
/**
 * A part's name as the user sees it, with every sub-assembly copy it sits in: "Sub <1> / Pin <1>" for key "s1/p".
 * Walks the copies down from the top (a sub-assembly copy on the way is fine); "A part" if the key leads nowhere.
 */
export function copyPathName(asm: Assembly, assemblies: readonly Assembly[], key: string): string {
  const names: string[] = [];
  let here: Assembly | undefined = asm;
  for (const id of key.split("/")) {
    const inst: Instance | undefined = here?.instances.find((i) => i.id === id);
    if (!inst) return "A part";
    names.push(inst.name);
    here = inst.subAssembly ? assemblies.find((a) => a.id === inst.subAssembly) : undefined;
  }
  return names.join(" / ");
}

export function fitFor(a: Assembly, x: string, y: string): IntendedFit | undefined {
  const key = pairKey(x, y);
  return (a.fits ?? []).find((f) => pairKey(f.a, f.b) === key);
}

/** Usual starting range for a new fit, on the diameter (mm); a printed press fit's is round the printer's own press fit. */
export function defaultFitRange(kind: IntendedFit["kind"], printFits?: PrintFits): [number, number] {
  if (kind === "printed") {
    const p = printFits?.press ?? DEFAULT_FITS.press;
    return [Math.max(0, Math.round((p - 0.05) * 1000) / 1000), Math.round((p + 0.05) * 1000) / 1000];
  }
  return kind === "press" ? [0.05, 0.15] : [0.2, 0.4];
}

/** Marks whose parts' copies are no longer in the assembly are dropped (after copies are removed or patterns change). */
export function tidyFits(a: Assembly): Assembly {
  if (!a.fits?.length) return a;
  const present = new Set(a.instances.map((i) => i.id));
  const left = a.fits.filter((f) => present.has(f.a.split("/")[0]) && present.has(f.b.split("/")[0]));
  if (left.length === a.fits.length) return a;
  const { fits: _, ...rest } = a;
  void _;
  return left.length ? { ...rest, fits: left } : rest;
}

/** Marked fits read from a file: odd entries dropped; parts must be copies in this assembly (by their first key part). */
export function parseFits(raw: unknown, instanceIds: ReadonlySet<string>): IntendedFit[] {
  if (!Array.isArray(raw)) return [];
  const out: IntendedFit[] = [];
  const seen = new Set<string>();
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_FIT ? v : null);
  for (const x of raw) {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.a !== "string" || typeof r.b !== "string" || r.a === r.b) continue;
    if (r.kind !== "press" && r.kind !== "clearance" && r.kind !== "printed") continue;
    if (!instanceIds.has(r.a.split("/")[0]) || !instanceIds.has(r.b.split("/")[0])) continue;
    const min = num(r.min);
    const max = num(r.max);
    if (min === null || max === null || min > max) continue;
    const key = pairKey(r.a, r.b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, a: r.a, b: r.b, kind: r.kind, min, max });
  }
  return out;
}
