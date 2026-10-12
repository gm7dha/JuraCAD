import type { CheckResult, PartCheck } from "../kernel/protocol";

export type Level = "ok" | "warn" | "error";

export interface Finding {
  level: Level;
  text: string;
}

export interface PartReport {
  partId: string;
  name: string;
  level: Level;
  findings: Finding[];
  size: string;
  volume: string;
}

export interface CheckReport {
  level: Level;
  headline: string;
  parts: PartReport[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const worst = (levels: Level[]): Level => (levels.includes("error") ? "error" : levels.includes("warn") ? "warn" : "ok");

function round(n: number, dp = 1): string {
  const f = 10 ** dp;
  return String(Math.round(n * f) / f);
}

export function reportPart(p: PartCheck): PartReport {
  const m = p.mesh;
  const findings: Finding[] = [];

  if (m.watertight) {
    findings.push({ level: "ok", text: "Closed and watertight" });
  } else {
    if (m.triangleCount === 0) findings.push({ level: "error", text: "Has no surface at all" });
    if (m.openEdges > 0) findings.push({ level: "error", text: `Has ${plural(m.openEdges, "gap")} in its surface` });
    if (m.nonManifoldEdges > 0)
      findings.push({ level: "error", text: `Has ${plural(m.nonManifoldEdges, "place")} where surfaces meet badly` });
    if (m.flippedEdges > 0)
      findings.push({ level: "error", text: `Has ${plural(m.flippedEdges, "place")} where the surface faces the wrong way` });
    if (m.triangleCount > 0 && m.openEdges + m.nonManifoldEdges + m.flippedEdges === 0 && m.volume <= 0)
      findings.push({ level: "error", text: "Is inside out (encloses no volume)" });
  }

  if (p.geometryValid === true) findings.push({ level: "ok", text: "Geometry is valid" });
  else if (p.geometryValid === false)
    findings.push({ level: "warn", text: "OpenCascade reported a geometry problem — check the printed result" });

  if (m.pieces > 1) {
    findings.push({ level: "warn", text: `Is in ${m.pieces} separate pieces — they'll print as separate objects` });
  } else if (m.pieces === 1) {
    findings.push({ level: "ok", text: "One solid piece" });
  }

  let size = "—";
  if (m.bounds) {
    const d = m.bounds.max.map((v, i) => v - m.bounds!.min[i]);
    size = `${round(d[0])} × ${round(d[1])} × ${round(d[2])} mm`;
    if (Math.min(...d) < 0.4) findings.push({ level: "warn", text: "Is thinner than 0.4 mm somewhere — likely too thin to print" });
  }
  const volumeMm3 = p.exactVolume ?? m.volume;
  const volume = `${round(volumeMm3 / 1000, 2)} cm³`;

  return { partId: p.partId, name: p.name, level: worst(findings.map((f) => f.level)), findings, size, volume };
}

/** Turn raw check numbers into a plain-English report. */
export function buildCheckReport(result: CheckResult, failedFeatureCount: number): CheckReport {
  const parts = result.parts.map(reportPart);
  const levels = parts.map((p) => p.level);
  if (failedFeatureCount > 0) levels.push("warn");
  const level = parts.length === 0 ? "error" : worst(levels);

  let headline: string;
  if (parts.length === 0) headline = "There's nothing to check yet.";
  else if (level === "ok") headline = parts.length === 1 ? "Ready to print." : "All parts are ready to print.";
  else if (level === "warn") headline = "Printable, but have a look at the notes below.";
  else headline = "Problems found — the slicer may refuse this or print it wrongly.";

  if (failedFeatureCount > 0) {
    headline += ` ${plural(failedFeatureCount, "feature")} couldn't be built, so the model may not be what you expect.`;
  }
  return { level, headline, parts };
}
