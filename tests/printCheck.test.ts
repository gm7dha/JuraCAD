import { describe, expect, it } from "vitest";
import { arrangeOnBed, bedExtents, bedRotation, findOverhangs, printHeadline, printPartReport, rotate, type PrintPartResult } from "../src/model/printCheck";
import {
  DEFAULT_PRINT_SETTINGS,
  fitExpression,
  minWallOf,
  parseFitExpression,
  parsePrintSettings,
  withFitVariables,
} from "../src/model/printSettings";
import { evaluate } from "../src/model/expr";
import { resolveVariables } from "../src/model/variables";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe("turning a part onto the bed", () => {
  it("takes the chosen direction to straight down, and leaves -Z alone", () => {
    for (const d of [[1, 0, 0], [0, -1, 0], [0, 0, 1], [1, 1, 1], [0.3, -0.2, -0.9]]) {
      const l = Math.hypot(...d);
      close(rotate(bedRotation(d), d.map((v) => v / l)), [0, 0, -1]);
    }
    expect(bedRotation([0, 0, -1])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("is a proper turn (never a mirror image)", () => {
    for (const d of [[1, 0, 0], [0, 0, 1], [1, 2, 3]]) {
      const R = bedRotation(d);
      const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
      expect(det).toBeCloseTo(1, 9);
    }
  });

  it("measures the size as it sits on the bed", () => {
    // A 10 × 20 × 60 box's corners, laid on its +X face: 60 × 20 footprint (or 20 × 60), 10 high.
    const v: number[] = [];
    for (const x of [0, 10]) for (const y of [0, 20]) for (const z of [0, 60]) v.push(x, y, z);
    const { size } = bedExtents(v, [1, 0, 0]);
    expect(size[2]).toBeCloseTo(10, 9);
    expect([size[0], size[1]].sort((a, b) => a - b).map((n) => Math.round(n * 1e6) / 1e6)).toEqual([20, 60]);
  });
});

describe("overhangs", () => {
  // One square (2 triangles) at height h facing down, and a sloped one.
  const square = (z: number, down: boolean, x0 = 0): { v: number[]; t: number[] } => ({
    v: [x0, 0, z, x0 + 10, 0, z, x0 + 10, 10, z, x0, 10, z],
    t: down ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3],
  });
  const join = (...parts: { v: number[]; t: number[] }[]) => {
    const v: number[] = [];
    const t: number[] = [];
    for (const p of parts) {
      const base = v.length / 3;
      v.push(...p.v);
      t.push(...p.t.map((i) => i + base));
    }
    return { v, t };
  };

  it("counts a downward face above the bed, not one on it or facing up", () => {
    const m = join(square(0, true), square(5, true, 20), square(8, false, 40));
    const r = findOverhangs(m.v, m.t, [0, 0, -1], 45);
    expect(r.bedArea).toBeCloseTo(100, 9);
    expect(r.area).toBeCloseTo(100, 9);
    expect(r.triangles).toEqual([2, 3]);
    expect(r.onBed).toEqual([0, 1]);
  });

  it("uses the angle from upright", () => {
    // A face leaning 60° from upright (normal 30° from straight down).
    const a = (60 * Math.PI) / 180;
    const n = [0, Math.cos(a), -Math.sin(a)];
    // Two corners along X, the third off along the face's slope (perpendicular to n and X).
    const s = [0, Math.sin(a), Math.cos(a)];
    const v = [0, 0, 5, 10, 0, 5, 0, s[1] * 10, 5 + s[2] * 10];
    // Wind so the normal is n.
    const e1 = [10, 0, 0];
    const e2 = [0, s[1] * 10, s[2] * 10];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const t = c[0] * n[0] + c[1] * n[1] + c[2] * n[2] > 0 ? [0, 1, 2] : [0, 2, 1];
    const withBed = join({ v, t }, square(0, true, 50));
    expect(findOverhangs(withBed.v, withBed.t, [0, 0, -1], 45).area).toBeCloseTo(50, 9);
    expect(findOverhangs(withBed.v, withBed.t, [0, 0, -1], 65).area).toBeCloseTo(0, 9);
  });
});

describe("laying parts out on the bed", () => {
  const overlap = (a: { x: number; y: number; w: number; d: number }, b: { x: number; y: number; w: number; d: number }) =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-9 && Math.abs(a.y - b.y) < (a.d + b.d) / 2 - 1e-9;

  it("puts several parts on the bed, apart and inside it", () => {
    const items = [
      { id: "a", size: [100, 50] as [number, number] },
      { id: "b", size: [60, 60] as [number, number] },
      { id: "c", size: [80, 30] as [number, number] },
      { id: "d", size: [120, 40] as [number, number] },
    ];
    const r = arrangeOnBed(items, [256, 256], 5);
    expect(r.tooBig).toEqual([]);
    expect(r.noRoom).toEqual([]);
    const boxes = r.places.map((p, i) => {
      const [w, d] = p.turned ? [items[i].size[1], items[i].size[0]] : items[i].size;
      return { x: p.x, y: p.y, w, d };
    });
    for (const b of boxes) {
      expect(b.x - b.w / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(b.x + b.w / 2).toBeLessThanOrEqual(256 + 1e-9);
      expect(b.y - b.d / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(b.y + b.d / 2).toBeLessThanOrEqual(256 + 1e-9);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
  });

  it("centres one part on the bed", () => {
    const r = arrangeOnBed([{ id: "a", size: [40, 20] }], [250, 210], 5);
    expect(r.places[0]).toEqual({ id: "a", x: 125, y: 105, turned: false, onBed: true });
  });

  it("turns a part a quarter turn when that's the only way it fits", () => {
    const r = arrangeOnBed([{ id: "long", size: [200, 240] }], [250, 210], 5);
    expect(r.places[0].turned).toBe(true);
    expect(r.places[0].onBed).toBe(true);
  });

  it("puts what doesn't fit beside the bed and says why", () => {
    const r = arrangeOnBed(
      [
        { id: "huge", size: [300, 300] },
        { id: "big1", size: [200, 200] },
        { id: "big2", size: [200, 200] },
      ],
      [256, 256],
      5,
    );
    expect(r.tooBig).toEqual(["huge"]);
    expect(r.noRoom).toEqual(["big2"]);
    expect(r.places.filter((p) => !p.onBed).every((p) => p.x > 256)).toBe(true);
  });
});

describe("the print report", () => {
  const empty = new Float32Array(0);
  const base: PrintPartResult = {
    partId: "p",
    name: "Bracket",
    size: [40, 20, 10],
    overhangArea: 0,
    bedArea: 800,
    thinnest: 2,
    thinnestAt: [0, 0, 0],
    thinArea: 0,
    smallHoles: [],
    thinPins: [],
    marks: { overhang: empty, bed: empty, thin: empty, small: empty },
  };
  const len = (v: number) => `${Math.round(v * 100) / 100} mm`;
  const area = (v: number) => `${Math.round(v)} mm²`;
  const bed: [number, number, number] = [256, 256, 256];

  it("says a good part is ready", () => {
    const r = printPartReport(base, DEFAULT_PRINT_SETTINGS, bed, len, area);
    expect(r.level).toBe("ok");
    expect(printHeadline([r]).text).toBe("Ready to print.");
  });

  it("names overhangs, thin walls, holes and pins in plain words", () => {
    const r = printPartReport({ ...base, overhangArea: 123.4, thinnest: 0.6, thinArea: 50, smallHoles: [1.5, 1.5], thinPins: [1.2] }, DEFAULT_PRINT_SETTINGS, bed, len, area);
    expect(r.level).toBe("warn");
    const text = r.findings.map((f) => f.text).join("\n");
    expect(text).toContain("About 123 mm² hangs over steeper than 45°");
    expect(text).toContain("Walls thinner than 0.8 mm");
    expect(text).toContain("the thinnest is about 0.6 mm");
    expect(text).toContain("2 holes narrower than 2 mm (1.5 mm");
    expect(text).toContain("A pin or post thinner than 2 mm (1.2 mm");
  });

  it("calls a wall narrower than the nozzle a problem", () => {
    const r = printPartReport({ ...base, thinnest: 0.3 }, DEFAULT_PRINT_SETTINGS, bed, len, area);
    expect(r.level).toBe("error");
  });

  it("says how much too big a part is, and when a quarter turn fixes it", () => {
    const big = printPartReport({ ...base, size: [300, 20, 10] }, DEFAULT_PRINT_SETTINGS, bed, len, area);
    expect(big.level).toBe("error");
    expect(big.findings[0].text).toContain("44 mm too wide");
    const turn = printPartReport({ ...base, size: [200, 240, 10] }, DEFAULT_PRINT_SETTINGS, [250, 210, 220], len, area);
    expect(turn.findings[0].level).toBe("ok");
    expect(turn.findings[0].text).toContain("quarter turn");
  });

  it("warns when nothing flat rests on the bed", () => {
    const r = printPartReport({ ...base, bedArea: 0 }, DEFAULT_PRINT_SETTINGS, bed, len, area);
    expect(r.findings.find((f) => f.kind === "bed")!.level).toBe("warn");
  });

  it("refuses a surface", () => {
    expect(printPartReport({ ...base, surface: true }, DEFAULT_PRINT_SETTINGS, bed, len, area).level).toBe("error");
  });
});

describe("printer settings and printed fits", () => {
  it("fills in what's missing or odd", () => {
    expect(parsePrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
    const s = parsePrintSettings({ nozzle: 0.6, overhangAngle: 500, fits: { sliding: 0.25, loose: "x" } });
    expect(s.nozzle).toBe(0.6);
    expect(s.overhangAngle).toBe(45);
    expect(s.fits).toEqual({ press: 0.1, snug: 0.2, sliding: 0.25, loose: 0.5 });
    expect(minWallOf(s)).toBeCloseTo(1.2, 9);
    expect(minWallOf({ ...s, minWall: 1 })).toBe(1);
  });

  it("adds the fit variables once, at the top, and can update them", () => {
    let n = 0;
    const id = () => `v${++n}`;
    const first = withFitVariables([{ id: "w", name: "wall", value: "2" }], DEFAULT_PRINT_SETTINGS.fits, id);
    expect(first.added).toEqual(["fit_press", "fit_snug", "fit_sliding", "fit_loose"]);
    expect(first.variables.map((v) => v.name)).toEqual(["fit_press", "fit_snug", "fit_sliding", "fit_loose", "wall"]);
    expect(resolveVariables(first.variables).values.fit_sliding).toBeCloseTo(0.3, 9);
    const again = withFitVariables(first.variables, { ...DEFAULT_PRINT_SETTINGS.fits, sliding: 0.35 }, id);
    expect(again.added).toEqual([]);
    expect(again.variables).toEqual(first.variables);
    const updated = withFitVariables(first.variables, { ...DEFAULT_PRINT_SETTINGS.fits, sliding: 0.35 }, id, true);
    expect(updated.changed).toEqual(["fit_sliding"]);
    expect(resolveVariables(updated.variables).values.fit_sliding).toBeCloseTo(0.35, 9);
  });

  it("writes a hole size that follows the fit, and reads it back", () => {
    const expr = fitExpression("5 mm", "sliding");
    expect(expr).toBe("5 mm + fit_sliding");
    expect(parseFitExpression(expr)).toEqual({ nominal: "5 mm", fit: "sliding" });
    expect(parseFitExpression("5.3")).toBeNull();
    const r = evaluate(expr, { fit_sliding: 0.3 });
    expect(r.ok && r.value).toBeCloseTo(5.3, 9);
  });
});

describe("sending to a slicer", () => {
  it("says plainly to open the saved file, and how", async () => {
    const { sentMessage, slicerById, SLICERS } = await import("../src/model/slicers");
    expect(SLICERS.map((s) => s.name)).toEqual(["Bambu Studio", "PrusaSlicer", "OrcaSlicer", "Another slicer"]);
    const lines = sentMessage(slicerById("prusa"), "Bracket.3mf", 2, 1);
    expect(lines[0]).toContain("Saved Bracket.3mf to your Downloads folder");
    expect(lines[0]).toContain("open it in PrusaSlicer yourself");
    expect(lines.some((l) => /^1\. Open PrusaSlicer\./.test(l))).toBe(true);
    expect(lines.join(" ")).toContain("One part doesn't fit on the plate");
    expect(slicerById("nonsense").id).toBe("bambu");
  });
});
