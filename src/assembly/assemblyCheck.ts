/**
 * The assembly check: do the parts clash (overlap) anywhere, are all the
 * mates working, and are all the parts still there? Written as a check
 * report, so it shows in the same window as the Part Studio's check.
 */
import type { CheckReport, Finding, Level, PartReport } from "../model/checkReport";
import type { Assembly } from "../model/types";
import type { SolveResult } from "./mates";

const worst = (levels: Level[]): Level => (levels.includes("error") ? "error" : levels.includes("warn") ? "warn" : "ok");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function volumeText(v: number): string {
  if (v >= 1000) return `${Math.round(v / 100) / 10} cm³`;
  return `${Math.round(v * 10) / 10} mm³`;
}

export function assemblyReport(
  assembly: Assembly,
  solved: SolveResult,
  /** Part names by part id, for parts that still exist. */
  partNames: Record<string, string>,
  clashes: { a: string; b: string; volume: number }[],
): CheckReport {
  const sections: PartReport[] = [];
  const section = (partId: string, name: string, findings: Finding[]) =>
    sections.push({ partId, name, level: worst(findings.map((f) => f.level)), findings, size: "", volume: "" });

  const missing = assembly.instances.filter((i) => partNames[i.partId] === undefined);
  if (missing.length) {
    section(
      "missing",
      "Missing parts",
      missing.map((i) => ({ level: "error" as const, text: `${i.name}: its part no longer exists in the Part Studio. Delete it, or undo the change that removed the part.` })),
    );
  }

  const mateProblems = (assembly.mates ?? []).filter((m) => !m.suppressed && solved.mateErrors[m.id]);
  section(
    "mates",
    "Mates",
    mateProblems.length
      ? mateProblems.map((m) => ({ level: "error" as const, text: `${m.name}: ${solved.mateErrors[m.id]}` }))
      : [{ level: "ok", text: (assembly.mates ?? []).length ? "All mates are working" : "No mates yet" }],
  );

  section(
    "clashes",
    "Clashes",
    clashes.length
      ? clashes.map((c) => ({ level: "warn" as const, text: `${c.a} and ${c.b} overlap by ${volumeText(c.volume)} — they'd be in each other's way.` }))
      : [{ level: "ok", text: "No parts overlap" }],
  );

  const level = worst(sections.map((s) => s.level));
  const problems = missing.length + mateProblems.length;
  const headline =
    level === "ok"
      ? `Everything fits: ${plural(assembly.instances.length, "part")}, no clashes.`
      : problems
        ? `${plural(problems, "problem")} to fix${clashes.length ? `, and ${plural(clashes.length, "clash", "clashes")}` : ""}.`
        : `${plural(clashes.length, "clash", "clashes")} found — some parts overlap.`;
  return { level, headline, parts: sections };
}
