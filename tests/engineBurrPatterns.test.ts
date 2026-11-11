/**
 * The six-piece burr with surface patterns, built with the real OpenCascade engine (in its own file: several whole
 * burrs are built). Each piece loses exactly what its engraving takes out (and gains its badge); the pieces still go
 * together without overlapping, the first few moves that are free with plain cubes are still free all the way along —
 * badges and all — and a decorated piece reaches past its plain self only beyond its two ends (the badges). The whole
 * way apart is walked with a cube on every end in libraryBurrPatterns.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { assembledToBed, burrLayout, burrWork } from "../src/library/designs/sixPieceBurr";
import { LENGTH, type Piece, type V3 } from "../src/library/burr";
import { BADGE_NUMBER_EXTRA, markArea, markedVolume, surfaceOf } from "../src/library/burrSurface";
import { blockContours, inkArea } from "../src/library/textKit";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

const design = findDesign("six-piece-burr")!;

function build(values: DesignValues) {
  const doc = insertDesign(emptyDocument(), design, { ...defaultValues(design), ...values }, { into: MAIN_STUDIO }).doc;
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid, p.partId).toBe(true);
  const byPiece: Record<number, { id: string; volume: number; name: string; box: [V3, V3] }> = {};
  for (const p of r.parts) {
    const i = Number(p.id.match(/piece-(\d)$/)?.[1]);
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.vertices.length; k += 3)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p.vertices[k + a]);
        hi[a] = Math.max(hi[a], p.vertices[k + a]);
      }
    byPiece[i] = { id: p.id, name: p.name, volume: check.parts.find((c) => c.partId === p.id)!.exactVolume ?? 0, box: [lo, hi] };
  }
  expect(Object.keys(byPiece)).toHaveLength(6);
  return byPiece;
}

/** Piece i's place in the assembled puzzle as a move + turn for the clash check (bed → assembled). */
function assembled(L: ReturnType<typeof burrLayout>, i: number) {
  const o = assembledToBed(L, i, [0, 0, 0]);
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => assembledToBed(L, i, e as V3).map((v, k) => v - o[k]));
  const M = [0, 1, 2].map((r) => [0, 1, 2].map((c) => cols[r][c]));
  const position = [0, 1, 2].map((r) => -(M[r][0] * o[0] + M[r][1] * o[1] + M[r][2] * o[2])) as V3;
  const tr = M[0][0] + M[1][1] + M[2][2];
  let q: [number, number, number, number];
  if (tr > 0) {
    const s4 = Math.sqrt(tr + 1) * 2;
    q = [(M[2][1] - M[1][2]) / s4, (M[0][2] - M[2][0]) / s4, (M[1][0] - M[0][1]) / s4, s4 / 4];
  } else if (M[0][0] > M[1][1] && M[0][0] > M[2][2]) {
    const s4 = Math.sqrt(1 + M[0][0] - M[1][1] - M[2][2]) * 2;
    q = [s4 / 4, (M[0][1] + M[1][0]) / s4, (M[0][2] + M[2][0]) / s4, (M[2][1] - M[1][2]) / s4];
  } else if (M[1][1] > M[2][2]) {
    const s4 = Math.sqrt(1 + M[1][1] - M[0][0] - M[2][2]) * 2;
    q = [(M[0][1] + M[1][0]) / s4, s4 / 4, (M[1][2] + M[2][1]) / s4, (M[0][2] - M[2][0]) / s4];
  } else {
    const s4 = Math.sqrt(1 + M[2][2] - M[0][0] - M[1][1]) * 2;
    q = [(M[0][2] + M[2][0]) / s4, (M[1][2] + M[2][1]) / s4, s4 / 4, (M[1][0] - M[0][1]) / s4];
  }
  return { position, rotation: q };
}

const key = (v: V3) => v.join(",");
const DIRS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The moves that are free straight away with plain cubes: a group (never piece 0) slid `steps` cubes along d. */
function firstMoves(pieces: Piece[]): { group: number[]; d: V3; steps: number }[] {
  const owner = new Map<string, number>();
  pieces.forEach((p, i) => p.forEach((v) => owner.set(key(v), i)));
  const out: { group: number[]; d: V3; steps: number }[] = [];
  for (let mask = 2; mask < 64; mask += 2) {
    const group = [0, 1, 2, 3, 4, 5].filter((i) => mask & (1 << i));
    for (const d of DIRS) {
      const free = (s: number) => group.every((i) => pieces[i].every((v) => {
        const o = owner.get(key([v[0] + d[0] * s, v[1] + d[1] * s, v[2] + d[2] * s]));
        return o === undefined || group.includes(o);
      }));
      let steps = 0;
      while (steps < LENGTH + 2 && free(steps + 1)) steps++;
      if (steps) out.push({ group, d, steps });
    }
  }
  return out;
}

describe("Six-piece burr with surface patterns", () => {
  for (const [label, extra] of [
    ["honeycomb, the pattern on the ends", { surface: "honeycomb", ends: "pattern", difficulty: "medium", pattern: 3 }],
    ["waves and numbers", { surface: "waves", ends: "number", difficulty: "easy", pattern: 2 }],
    ["lattice and raised badges", { surface: "lattice", ends: "badge", difficulty: "hard", pattern: 3, fit: 0 }],
  ] as const)
    it(`loses exactly the engraving, fits together and slides as before (${label})`, () => {
      const values = { ...defaultValues(design), ...extra } as DesignValues;
      const plainValues = { ...values, surface: "none", ends: "plain" };
      const L = burrLayout(values);
      const U = L.unit;
      const plain = build(plainValues);
      const fancy = build(values);
      const s = surfaceOf(values, U);
      const work = burrWork(values, L);
      for (let i = 0; i < 6; i++) {
        // What's cut away (patterns exactly; numbers by their letters' outlines) less what a badge adds.
        let removed = 0;
        let letters = 0;
        for (const w of work[i]) {
          if (w.kind === "engrave") removed += markedVolume(w);
          else if (w.kind === "badge") removed -= w.marks.reduce((a, m) => a + markArea(m), 0) * s.depth;
          else {
            const ink = inkArea(blockContours({ font: "bold", capHeight: w.number!.cap, lines: [w.number!.text], centre: w.number!.centre }));
            const into = s.ends === "badge" ? s.depth + BADGE_NUMBER_EXTRA : s.depth;
            letters += ink * into;
          }
        }
        expect(removed + letters, `piece ${i + 1}`).not.toBe(0);
        // Nothing stands out of the plain piece's box, but a badge beyond each end (the pieces lie along x).
        const [[plo, phi], [flo, fhi]] = [plain[i].box, fancy[i].box];
        const out = s.ends === "badge" ? s.depth : 0;
        for (const a of [1, 2]) expect([flo[a] >= plo[a] - 1e-3, fhi[a] <= phi[a] + 1e-3], `piece ${i + 1} axis ${a}`).toEqual([true, true]);
        expect(Math.abs(plo[0] - flo[0] - out), `piece ${i + 1} start`).toBeLessThan(1e-3);
        expect(Math.abs(fhi[0] - phi[0] - out), `piece ${i + 1} end`).toBeLessThan(1e-3);
        const lost = plain[i].volume - fancy[i].volume;
        expect(Math.abs(lost - removed - letters), `piece ${i + 1}: lost ${lost}, expected ${removed + letters}`).toBeLessThan(1e-3 * Math.abs(removed) + 0.02 * letters + 1e-3);
      }
      // Put together: no overlaps (and the check works: nudged, they do).
      const placed = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `i${i}`, partId: fancy[i].id, name: fancy[i].name, ...assembled(L, i) }));
      const overlap = (list: typeof placed) => engine.clashes(list, 0.001, false).reduce((n, c) => n + (c.volume ?? 0), 0);
      expect(overlap(placed)).toBeLessThan(1e-3);
      expect(overlap(placed.map((p, k) => (k === 1 ? { ...p, position: [p.position[0], p.position[1], p.position[2] + U / 4] as V3 } : p)))).toBeGreaterThan(1);
      // Every move free at the start with plain cubes is free with the decorated pieces, all the way along.
      const moves = firstMoves(L.pieces);
      expect(moves.length).toBeGreaterThan(0);
      for (const m of moves.slice(0, 4))
        for (let k = 1; k <= 2 * m.steps; k++) {
          const t = (k / 2) * U;
          const moved = placed.map((p, i) => (m.group.includes(i) ? { ...p, position: [0, 1, 2].map((a) => p.position[a] + m.d[a] * t) as V3 } : p));
          expect(overlap(moved), `group ${m.group.map((g) => g + 1)} moved ${k / 2} cubes along ${m.d}`).toBeLessThan(1e-3);
        }
    });
});

