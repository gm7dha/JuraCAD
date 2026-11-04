/**
 * The sketch check (how many ways a sketch can still move, which points and curves are pinned down) works block by
 * block — unknowns joined through the equations that read them — instead of one dense reduction of the whole
 * Jacobian. It must answer exactly as the dense one did, and a sketch of thousands of loose points (a big jigsaw) is
 * then quick.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { setCurrentScope } from "../src/model/expr";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, insertDesign, LIBRARY } from "../src/library/insert";
import { puzzleSketch } from "../src/library/designs/jigsaw";
import { analyzeSketch, analyzeWholeDense, solveSketch, type SketchAnalysis } from "../src/sketch/solver";
import { addCircle, addLine, addRectangle } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";

const same = (a: SketchAnalysis) => ({ freedom: a.freedom, points: [...a.definedPoints].sort(), curves: [...a.definedCurves].sort() });

describe("the sketch check, block by block", () => {
  it("answers exactly as the whole-matrix check for every library design's sketches", () => {
    let sketches = 0;
    for (const d of LIBRARY) {
      if (d.id === "jigsaw") continue;
      const r = insertDesign(emptyDocument(), d, defaultValues(d), { into: MAIN_STUDIO });
      setCurrentScope(resolveVariables(r.doc.variables).values);
      for (const f of r.doc.features) {
        if (!f.sketch) continue;
        sketches++;
        expect(same(analyzeSketch(f.sketch.data)), `${d.id} ${f.name}`).toEqual(same(analyzeWholeDense(f.sketch.data)));
      }
    }
    expect(sketches).toBeGreaterThan(80);
  });

  it("and for hand-drawn sketches, defined and not", () => {
    let s: SketchData = emptySketch();
    s = addRectangle(s, { x: 0, y: 0 }, { x: 40, y: 20 }).sketch;
    s = addCircle(s, { x: 60, y: 10 }, 5).sketch;
    s = addLine(s, { x: 70, y: 0 }, { x: 90, y: 30 }).sketch;
    const loose = s;
    const r = solveSketch(loose);
    expect(r.ok).toBe(true);
    for (const sk of [loose, r.sketch, puzzleSketch({ width: 60, height: 40, rows: 2, columns: 3, tab: 0.25, seed: 4 })]) expect(same(analyzeSketch(sk))).toEqual(same(analyzeWholeDense(sk)));
  });

  it("a 400-piece puzzle's sketch: every loose point free but for each arc's equal-radius rule", () => {
    const sk = puzzleSketch({ width: 400, height: 290, rows: 20, columns: 20, tab: 0.25, seed: 1 });
    const arcs = sk.curves.filter((c) => c.type === "arc").length;
    const a = analyzeSketch(sk);
    expect(a.freedom).toBe(2 * sk.points.length - arcs);
    expect(a.definedCurves.size).toBe(0);
  });
});
