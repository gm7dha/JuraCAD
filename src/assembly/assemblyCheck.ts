/**
 * The assembly check: do the parts clash (overlap) anywhere, are all the
 * mates working, and are all the parts still there? Written as a check
 * report, so it shows in the same window as the Part Studio's check.
 */
import type { CheckReport, Finding, Level, PartReport } from "../model/checkReport";
import type { Assembly } from "../model/types";
import type { ContactMeasure } from "../kernel/protocol";
import { formatArea, formatLength, formatVolume, lengthUnit } from "../model/units";
import type { SolveResult } from "./mates";
import { mateInactive } from "./suppress";
import { partInstances } from "./assembly";

const worst = (levels: Level[]): Level => (levels.includes("error") ? "error" : levels.includes("warn") ? "warn" : "ok");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function volumeText(v: number): string {
  if (lengthUnit() === "in") return formatVolume(v, "in");
  if (v >= 1000) return `${Math.round(v / 100) / 10} cm³`;
  return `${Math.round(v * 10) / 10} mm³`;
}

/** What the clash check looks at (chosen in the Check window). */
export interface ClashOptions {
  /** Parts that only touch aren't listed. Overlaps (and gaps) up to `tolerance` count as touching either way. */
  ignoreTouching: boolean;
  /** mm: overlaps thinner than this, and gaps smaller than it, count as touching rather than clashing. */
  tolerance: number;
  /** Leave out parts hidden in the 3D view. (Suppressed parts are always left out.) */
  skipHidden: boolean;
}

export const DEFAULT_CLASH_OPTIONS: ClashOptions = { ignoreTouching: true, tolerance: 0.01, skipHidden: false };

/** Clash options read back from browser storage or typed in: anything odd falls back to the defaults. */
export function parseClashOptions(raw: unknown): ClashOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const t = typeof r.tolerance === "number" && Number.isFinite(r.tolerance) && r.tolerance >= 0 ? Math.min(r.tolerance, 10) : DEFAULT_CLASH_OPTIONS.tolerance;
  return {
    ignoreTouching: typeof r.ignoreTouching === "boolean" ? r.ignoreTouching : DEFAULT_CLASH_OPTIONS.ignoreTouching,
    tolerance: t,
    skipHidden: typeof r.skipHidden === "boolean" ? r.skipHidden : DEFAULT_CLASH_OPTIONS.skipHidden,
  };
}

/** How two parts meet, once judged: a real clash of some kind, or just touching. */
export type Contact =
  /** Two solids share some space. */
  | { kind: "overlap"; a: string; b: string; volume: number }
  /** A surface goes through a solid (a is the surface). */
  | { kind: "through"; a: string; b: string; area: number }
  /** Two surfaces cross. */
  | { kind: "cross"; a: string; b: string; length: number }
  /** They meet, but only within the tolerance. */
  | { kind: "touch"; a: string; b: string };

/**
 * Decide what a measured pair is. Two solids clash when they share more than a
 * sliver: their overlap is thicker than `tolerance` (its thickness is estimated
 * from the shared piece as 2 × volume ÷ area — exact for a thin flat slab or
 * sleeve — or, for a compact chunk at a corner or edge, the smallest side of the box round it). A
 * surface clashes with a solid when it goes further inside than the tolerance;
 * two surfaces when they cross along more than the tolerance. Anything less, or
 * a gap up to the tolerance, is touching. Null: they don't meet.
 */
export function judgeContact(m: ContactMeasure, tolerance: number): Contact | null {
  const tol = Math.max(0, tolerance);
  const touch: Contact = { kind: "touch", a: m.a, b: m.b };
  if (!m.surfaceA && !m.surfaceB) {
    const v = m.volume ?? 0;
    if (v > 1e-6) {
      // 2V/A is exact for a flat sliver (or a thin sleeve round a pin), but gives too little for a
      // chunk at a corner or along an edge (a cube's is a third of its side). For a chunk like that
      // the box round it is no more than 3 × 2V/A across, and its smallest side is the thickness;
      // a thin curved sleeve's box is far bigger than its thickness, so there 2V/A stands.
      const slab = m.area && m.area > 0 ? (2 * v) / m.area : Infinity;
      const box = m.boxMin ?? 0;
      const thickness = box > slab && box <= 3 * slab * (1 + 1e-6) ? box : slab;
      return thickness > tol ? { kind: "overlap", a: m.a, b: m.b, volume: v } : touch;
    }
  } else if (m.surfaceA && !m.surfaceB) {
    const area = m.area ?? 0;
    if (area > 1e-6) return (m.depth ?? Infinity) > tol ? { kind: "through", a: m.a, b: m.b, area } : touch;
  } else {
    const length = m.crossLength ?? 0;
    if (length > tol && length > 1e-6) return { kind: "cross", a: m.a, b: m.b, length };
  }
  return m.gap !== undefined && m.gap <= tol + 1e-9 ? touch : null;
}

/** The clashes (and, unless ignored, the touching pairs) the check reports. */
export function judgeContacts(measured: ContactMeasure[], options: ClashOptions): Contact[] {
  return measured.map((m) => judgeContact(m, options.tolerance)).filter((c): c is Contact => !!c && (c.kind !== "touch" || !options.ignoreTouching));
}

function contactText(c: Contact | { a: string; b: string; volume: number; kind?: undefined }): string {
  switch (c.kind) {
    case "through":
      return `The surface ${c.a} goes through ${c.b} (${formatArea(c.area)} of it is inside) — they'd be in each other's way.`;
    case "cross":
      return `The surfaces ${c.a} and ${c.b} cross each other (along ${formatLength(c.length, undefined, 1)}).`;
    case "touch":
      return `${c.a} and ${c.b} touch.`;
    default:
      return `${c.a} and ${c.b} overlap by ${volumeText(c.volume)} — they'd be in each other's way.`;
  }
}

/** What the clash check left out, to say so in the report. */
export interface LeftOut {
  hidden?: number;
  suppressed?: number;
}

export function assemblyReport(
  assembly: Assembly,
  solved: SolveResult,
  /** Part names by part id, for parts that still exist. */
  partNames: Record<string, string>,
  /** Judged contacts (see judgeContacts). Plain { a, b, volume } entries are overlaps. */
  contacts: (Contact | { a: string; b: string; volume: number; kind?: undefined })[],
  options: ClashOptions = DEFAULT_CLASH_OPTIONS,
  leftOut: LeftOut = {},
  /** Every assembly in the document, so the parts inside sub-assemblies are counted (and checked for missing parts). */
  assemblies: readonly Assembly[] = [],
): CheckReport {
  const sections: PartReport[] = [];
  const section = (partId: string, name: string, findings: Finding[]) =>
    sections.push({ partId, name, level: worst(findings.map((f) => f.level)), findings, size: "", volume: "", volumeMm3: 0 });

  // Every part, however deep inside sub-assemblies.
  const active = partInstances(assembly, assemblies);
  const missing = active.filter((p) => partNames[p.instance.partId] === undefined);
  if (missing.length) {
    section(
      "missing",
      "Missing parts",
      missing.map((p) => ({
        level: "error" as const,
        text: !assembly.instances.includes(p.instance)
          ? `${p.name}: its part no longer exists in the Part Studio. Open the sub-assembly and delete it, or undo the change that removed the part.`
          : `${p.name}: its part no longer exists in the Part Studio. Delete it, or undo the change that removed the part.`,
      })),
    );
  }

  // Mates that are switched off, or on a suppressed part, aren't problems.
  const inUse = (assembly.mates ?? []).filter((m) => !mateInactive(assembly, m));
  const mateProblems = inUse.filter((m) => solved.mateErrors[m.id]);
  section(
    "mates",
    "Mates",
    mateProblems.length
      ? mateProblems.map((m) => ({ level: "error" as const, text: `${m.name}: ${solved.mateErrors[m.id]}` }))
      : [{ level: "ok", text: inUse.length ? "All mates are working" : (assembly.mates ?? []).length ? "No mates in use" : "No mates yet" }],
  );

  const clashes = contacts.filter((c) => c.kind !== "touch");
  const touching = contacts.filter((c) => c.kind === "touch");
  const notes: Finding[] = [];
  const out = [leftOut.hidden ? `${plural(leftOut.hidden, "hidden part")}` : "", leftOut.suppressed ? `${plural(leftOut.suppressed, "suppressed part")}` : ""].filter(Boolean);
  if (out.length) notes.push({ level: "ok", text: `Not checked: ${out.join(" and ")}.` });
  if (options.ignoreTouching) notes.push({ level: "ok", text: `Parts that only touch aren't listed (gaps and overlaps up to ${formatLength(options.tolerance)} count as touching).` });
  section("clashes", "Clashes", [
    ...(clashes.length ? clashes.map((c) => ({ level: "warn" as const, text: contactText(c) })) : [{ level: "ok" as const, text: "No parts overlap" }]),
    ...touching.map((c) => ({ level: "ok" as const, text: contactText(c) })),
    ...notes,
  ]);

  const level = worst(sections.map((s) => s.level));
  const problems = missing.length + mateProblems.length;
  const headline =
    level === "ok"
      ? `Everything fits: ${plural(active.length, "part")}, no clashes.`
      : problems
        ? `${plural(problems, "problem")} to fix${clashes.length ? `, and ${plural(clashes.length, "clash", "clashes")}` : ""}.`
        : `${plural(clashes.length, "clash", "clashes")} found — some parts overlap.`;
  return { level, headline, parts: sections };
}
