import { defaultValues, findDesign, valueProblems } from "./src/library/insert";
import { OUTSIDE_SHAPES, SURFACE_PATTERNS } from "./src/library/designs/mouldSurface";
const d = findDesign("pillar-candle-mould")!;
let ok = 0, bad: string[] = [];
for (const s of OUTSIDE_SHAPES) for (const p of SURFACE_PATTERNS) for (const extra of [{}, { width: 40, height: 60 }, { width: 100, height: 150, patternCount: 5 }, { draft: 4, patternDepth: 2 }, { height: 25 }, { sides: 5 }, { sides: 12 }]) {
  const v = { ...defaultValues(d), shape: s.value, pattern: p.value, ...extra };
  const pr = valueProblems(d, v); if (!pr.length) { ok++; if (s.value === "twisted") bad.push(JSON.stringify(extra)+p.value); }
}
console.log("allowed", ok, "twisted allowed", bad.length);
