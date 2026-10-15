import { formatVolume, lengthNumber, lengthUnit } from "./units";
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
  /** Volume in mm³ (for working out the mass). */
  volumeMm3: number;
}

export interface CheckReport {
  level: Level;
  headline: string;
  parts: PartReport[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const worst = (levels: Level[]): Level => (levels.includes("error") ? "error" : levels.includes("warn") ? "warn" : "ok");

/** A wall thickness in the design's units: "1.25 mm" or "0.049 in". */
const about = (mm: number) => (lengthUnit() === "in" ? `${lengthNumber(mm, "in", 3)} in` : `${round(mm, 2)} mm`);

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
    findings.push({ level: "warn", text: "OpenCascade reported a geometry problem — check the exported file carefully" });

  if (m.pieces > 1) {
    findings.push({ level: "warn", text: `Is in ${m.pieces} separate pieces — they'll be made as separate objects` });
  } else if (m.pieces === 1) {
    findings.push({ level: "ok", text: "One solid piece" });
  }

  let size = "—";
  if (m.bounds) {
    const d = m.bounds.max.map((v, i) => v - m.bounds!.min[i]);
    const inch = lengthUnit() === "in";
    size = inch ? `${d.map((v) => lengthNumber(v, "in", 2)).join(" × ")} in` : `${round(d[0])} × ${round(d[1])} × ${round(d[2])} mm`;
    if (!p.thinnest && Math.min(...d) < 0.4) findings.push({ level: "warn", text: "Is less than 0.4 mm thick overall — very thin parts are hard to make" });
  }
  if (p.thinnest) {
    const t = p.thinnest.thickness;
    const where = p.thinnest.at.map((v) => (lengthUnit() === "in" ? lengthNumber(v, "in", 2) : round(v))).join(", ");
    if (t < THIN_WALL_MM) {
      findings.push({
        level: "warn",
        text: `Has a wall only about ${about(t)} thick (near ${where}) — very thin walls are fragile and hard to make`,
      });
    } else {
      findings.push({ level: "ok", text: `Thinnest wall is about ${about(t)}` });
    }
  }
  const volumeMm3 = p.exactVolume ?? m.volume;
  const volume = lengthUnit() === "in" ? formatVolume(volumeMm3, "in") : `${round(volumeMm3 / 1000, 2)} cm³`;

  return { partId: p.partId, name: p.name, level: worst(findings.map((f) => f.level)), findings, size, volume, volumeMm3 };
}

/** Walls thinner than this get a warning (most processes struggle below about half a millimetre). */
export const THIN_WALL_MM = 0.5;

/** Turn raw check numbers into a plain-English report. */
export function buildCheckReport(result: CheckResult, failedFeatureCount: number): CheckReport {
  const parts = result.parts.map(reportPart);
  for (const o of result.overlaps ?? []) {
    for (const [self, other] of [
      [o.a, o.b],
      [o.b, o.a],
    ]) {
      const part = parts.find((p) => p.name === self);
      if (!part) continue;
      part.findings.push({
        level: "warn",
        text: `Overlaps ${other} by about ${round(o.volume / 1000, 2)} cm³ — separate parts can't share space. To join them into one part, use Add instead of New`,
      });
      part.level = worst(part.findings.map((f) => f.level));
    }
  }
  const levels = parts.map((p) => p.level);
  if (failedFeatureCount > 0) levels.push("warn");
  const level = parts.length === 0 ? "error" : worst(levels);

  let headline: string;
  if (parts.length === 0) headline = "There's nothing to check yet.";
  else if (level === "ok") headline = parts.length === 1 ? "Ready to export." : "All parts are ready to export.";
  else if (level === "warn") headline = "Usable, but have a look at the notes below.";
  else headline = "Problems found — a manufacturer's or printer's software may reject this or make it wrongly.";

  if (failedFeatureCount > 0) {
    headline += ` ${plural(failedFeatureCount, "feature")} couldn't be built, so the model may not be what you expect.`;
  }
  return { level, headline, parts };
}
