/** The six-piece burr's surface patterns (pure): which faces show, where the patterns go, depths, and plain = unchanged. */
import { describe, expect, it } from "vitest";
import { AXIS, LENGTH, fullStick, makeBurr, type V3 } from "../src/library/burr";
import {
  BURR_PATTERNS,
  CUT_START,
  DEPTH_SHARE,
  FACE_NORMAL,
  MOST_DEPTH,
  badgesFree,
  cubeOnBed,
  facePlace,
  inset,
  isPlain,
  marginFor,
  markArea,
  markPoints,
  outsideCells,
  outsideRects,
  patternMarks,
  rectInSketch,
  surfaceOf,
  withEndCubes,
  type FaceName,
  type Mark,
  type Rect,
} from "../src/library/burrSurface";
import { burrLayout, burrWork, pieceY, sixPieceBurr } from "../src/library/designs/sixPieceBurr";
import { defaultValues, insertDesign } from "../src/library/insert";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import { insidePolygon } from "../src/library/textKit";
import type { DesignValues, MakeContext } from "../src/library/types";

const base = { size: 20, difficulty: "medium", pattern: 3, fit: 0.2 };
const key = (v: V3) => v.join(",");

function make(values: DesignValues) {
  const ctx: MakeContext = { values, vars: {}, id: (r) => `b_${r}`, name: "Burr", scope: {} };
  return sixPieceBurr.make(ctx);
}

/** Is a point inside a mark? */
const inMark = (m: Mark, p: [number, number]) => ("pts" in m ? insidePolygon(p, m.pts) : Math.hypot(p[0] - m.c[0], p[1] - m.c[1]) < m.d / 2);

describe("Six-piece burr surface patterns", () => {
  it("reads old inserts (no pattern values) as plain sticks, and caps the depth for thin sticks", () => {
    const s = surfaceOf(base, 10);
    expect(s).toMatchObject({ pattern: "none", ends: "plain", depth: 0.6, repeats: 3, seed: 1 });
    expect(isPlain(s)).toBe(true);
    expect(surfaceOf({ surfaceDepth: 1.5 }, 10).depth).toBe(MOST_DEPTH);
    expect(surfaceOf({ surfaceDepth: 1.5 }, 4).depth).toBeCloseTo(DEPTH_SHARE * 4, 6);
    expect(surfaceOf({ surface: "nonsense", ends: "x" }, 10)).toMatchObject({ pattern: "none", ends: "plain" });
    expect(BURR_PATTERNS.map((p) => p.value)).toEqual(["none", "ribs", "spiral", "rings", "lattice", "honeycomb", "waves", "chevron", "basket", "dots", "lowpoly"]);
  });

  it("makes exactly the old features with no pattern, whether or not the new values are there", () => {
    // Inserted (so sketch items get their stable ids), with the insert's own id taken out.
    const inserted = (v: DesignValues) => {
      const r = insertDesign(emptyDocument(), sixPieceBurr, v, { into: MAIN_STUDIO });
      return JSON.stringify(r.doc.features).split(r.insert.id).join("X");
    };
    const before = inserted({ ...defaultValues(sixPieceBurr), ...base });
    // An insert saved before there were patterns has none of the new values.
    expect(JSON.stringify(sixPieceBurr.make({ values: base, vars: {}, id: (r) => `b_${r}`, name: "Burr", scope: {} }).features.map((f) => f.id))).toBe(
      JSON.stringify(make({ ...defaultValues(sixPieceBurr), ...base }).features.map((f) => f.id)),
    );
    expect(inserted({ ...defaultValues(sixPieceBurr), ...base, surfaceDepth: 1, surfaceRepeats: 5, surfaceSeed: 9 })).toBe(before);
    const old = make(base);
    expect(old.features.every((f) => /piece-\d(-sketch|-(through|top|bottom)-\d+(-sketch)?)?$/.test(f.id))).toBe(true);
    expect(sixPieceBurr.summary!(base)).not.toMatch(/Pattern|number/);
    expect(sixPieceBurr.problems(base)).toEqual([]);
  });

  it("finds the faces that show from outside: never next to a place another stick can be", () => {
    for (const [seed, d] of [[1, "easy"], [3, "medium"], [2, "hard"]] as const) {
      const b = makeBurr(seed, d);
      const L = burrLayout({ ...base, pattern: seed, difficulty: d });
      const envelope = new Set([0, 1, 2, 3, 4, 5].flatMap((i) => fullStick(i).map(key)));
      b.pieces.forEach((p, i) => {
        const cells = outsideCells(p, AXIS[i], L.turns[i], L.mins[i]);
        const laid = new Set(L.laid[i].map(key));
        // Every outside cube is one the piece has as laid, and what's beyond it is outside every stick.
        for (const [face, list] of Object.entries(cells) as [FaceName, V3[]][])
          for (const c of list) {
            expect(laid.has(key(c))).toBe(true);
            const n = FACE_NORMAL[face];
            // Back to the assembled puzzle: the cube beyond is in no full stick.
            const beyond = p.map((v) => [v, cubeOnBed(v, AXIS[i], L.turns[i], L.mins[i])] as const).find(([, w]) => key(w) === key(c))![0];
            const across = DIRSOF(beyond).find((u) => key(cubeOnBed(u, AXIS[i], L.turns[i], L.mins[i])) === key([c[0] + n[0], c[1] + n[1], c[2] + n[2]]))!;
            expect(envelope.has(key(across))).toBe(false);
          }
        // Each stick shows 32 cube faces along its length and 8 on its ends, whatever its notches; the face it shares
        // with its partner never shows.
        const long = (["top", "bed", "front", "back"] as FaceName[]).reduce((n, f) => n + cells[f].length, 0);
        expect([long, cells.left.length, cells.right.length]).toEqual([32, 4, 4]);
        expect((["top", "bed", "front", "back"] as FaceName[]).filter((f) => cells[f].length === 0)).toHaveLength(1);
      });
    }
  });

  it("keeps every pattern inside its face, clear of the edges, without overlapping", () => {
    for (const [size, repeats] of [[8, 1], [20, 3], [30, 5], [40, 2]] as const)
        for (const p of BURR_PATTERNS) {
          const v = { ...base, size, surface: p.value, surfaceRepeats: repeats, ends: "pattern", surfaceSeed: 7 };
          const L = burrLayout(v);
          const s = surfaceOf(v, L.unit);
          const margin = marginFor(s.depth, L.fit);
          burrWork(v, L).forEach((work, i) => {
            for (const w of work) {
              expect(w.face).not.toBe("bed");
              expect(w.kind).toBe("engrave");
              expect(w.depth).toBe(s.depth);
              // The sketch sits CUT_START out from the face, facing out.
              const n = FACE_NORMAL[w.face];
              expect(n[0] * w.origin[0] + n[1] * w.origin[1] + n[2] * w.origin[2]).toBeCloseTo(w.at + CUT_START, 5);
              // The face's outside part, in the sketch's coordinates: each mark lies in one of them, `margin` inside.
              const cells = outsideCells(L.pieces[i], AXIS[i], L.turns[i], L.mins[i])[w.face];
              const rects = outsideRects(cells, w.face, L.unit, pieceY(i, L.unit), L.fit).map((r) => rectInSketch(w.face, r));
              for (const m of w.marks) {
                const pts = markPoints(m);
                const home = rects.find((r) => pts.every(([x, y]) => x >= r[0] + margin - 1e-6 && x <= r[2] - margin + 1e-6 && y >= r[1] + margin - 1e-6 && y <= r[3] - margin + 1e-6));
                expect(home, `${p.value} ${size}/${repeats} piece ${i + 1} ${w.face}`).toBeDefined();
                expect(markArea(m)).toBeGreaterThan(0);
              }
              // No two marks overlap: probe a grid over where their boxes cross (on the first piece; the rest are alike).
              if (i > 0) continue;
              let overlaps = 0;
              for (let a = 0; a < w.marks.length; a++)
                for (let b = a + 1; b < w.marks.length; b++) {
                  const [A, B] = [w.marks[a], w.marks[b]].map((m) => {
                    const pts = markPoints(m);
                    return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
                  });
                  const box: Rect = [Math.max(A[0], B[0]), Math.max(A[1], B[1]), Math.min(A[2], B[2]), Math.min(A[3], B[3])];
                  if (box[2] <= box[0] || box[3] <= box[1]) continue;
                  for (let x = box[0]; x <= box[2]; x += 0.15) for (let y = box[1]; y <= box[3]; y += 0.15) if (inMark(w.marks[a], [x, y]) && inMark(w.marks[b], [x, y])) overlaps++;
                }
              expect(overlaps, `${p.value} ${size}/${repeats} ${w.face}: marks overlap`).toBe(0);
            }
          });
        }
  });

  it("keeps the side faces' and the top's engraving apart, and stays on the face's own plane", () => {
    const L = burrLayout(base);
    expect(facePlace("top", L.unit, 0, L.fit)).toBeCloseTo(2 * L.unit - 2 * L.fit, 9);
    expect(facePlace("right", L.unit, 0, L.fit)).toBeCloseTo(LENGTH * L.unit - L.fit, 9);
    expect(inset([0, 0, 4, 4], 2)).toBeNull();
    expect(inset([0, 0, 10, 6], 2)).toEqual([2, 2, 8, 4]);
    // Rings on a long rectangle: whole grooves across, `cell` apart, inside.
    const marks = patternMarks("rings", [0, 0, 30, 10], 6, 1);
    expect(marks).toHaveLength(5);
    expect(marks.every((m) => "pts" in m && m.pts.every(([x, y]) => x >= 0 && x <= 30 && y >= 0 && y <= 10))).toBe(true);
    expect(patternMarks("none", [0, 0, 30, 10], 6, 1)).toEqual([]);
    // The facets' pattern number changes the facets; the same number gives the same ones.
    expect(patternMarks("lowpoly", [0, 0, 30, 20], 6, 4)).toEqual(patternMarks("lowpoly", [0, 0, 30, 20], 6, 4));
    expect(patternMarks("lowpoly", [0, 0, 30, 20], 6, 4)).not.toEqual(patternMarks("lowpoly", [0, 0, 30, 20], 6, 5));
  });

  it("numbers the ends 1–6, cut in or on a raised badge, and makes the features for them", () => {
    for (const ends of ["number", "badge"] as const) {
      const v = { ...base, ends };
      const work = burrWork(v);
      work.forEach((w, i) => {
        const numbers = w.filter((f) => f.kind === "number");
        expect(numbers.map((f) => f.face).sort()).toEqual(["left", "right"]);
        expect(numbers.every((f) => f.number!.text === String(i + 1))).toBe(true);
        expect(w.filter((f) => f.kind === "badge")).toHaveLength(ends === "badge" ? 2 : 0);
      });
      const made = make(v);
      const cuts = made.features.filter((f) => /-(number|badge)$/.test(f.id));
      expect(cuts).toHaveLength(ends === "badge" ? 24 : 12);
      for (const f of cuts) expect([f.operation, !!f.extrude?.flip]).toEqual(f.id.endsWith("badge") ? ["add", false] : ["remove", true]);
      expect(sixPieceBurr.summary!(v)).toMatch(/number \(1–6\)/);
    }
    const sk = make({ ...base, ends: "number" }).features.find((f) => f.id === "b_piece-2-right-number-sketch")!;
    expect(sk.sketch!.data.texts?.[0]?.value).toBe("3");
  });

  it("adds sketches and cuts for each decorated face, after that piece's notches", () => {
    const made = make({ ...base, surface: "honeycomb" });
    const ids = made.features.map((f) => f.id);
    for (let i = 0; i < 6; i++) {
      const cuts = ids.filter((id) => id.startsWith(`b_piece-${i}-`) && id.endsWith("-engrave"));
      expect(cuts.length).toBeGreaterThanOrEqual(2);
      // Before the next piece is made, so each cut works on its own piece (the latest part).
      if (i < 5) for (const c of cuts) expect(ids.indexOf(c)).toBeLessThan(ids.indexOf(`b_piece-${i + 1}`));
    }
    expect(sixPieceBurr.summary!({ ...base, surface: "honeycomb" })).toMatch(/Pattern cut 0\.6 mm deep/);
    expect(sixPieceBurr.summary!({ ...base, size: 8, surface: "ribs", surfaceDepth: 1.5 })).toMatch(/the most for sticks this thin/);
  });

  it("only offers raised badges when something on every end can't get in the way of the moves", () => {
    const b = makeBurr(3, "medium");
    const ext = withEndCubes(b.pieces);
    ext.forEach((p, i) => expect(p.length).toBe(b.pieces[i].length + 8));
    expect(badgesFree(b.pieces, b.level, "test:3")).toBe(true);
    expect(sixPieceBurr.problems({ ...base, ends: "badge" })).toEqual([]);
  });

  it("refuses more detail than builds quickly, and patterns too fine to show", () => {
    expect(sixPieceBurr.problems({ ...base, size: 60, surface: "lattice", surfaceRepeats: 6 })).toEqual(["That's too much pattern detail to build quickly — choose fewer pattern repeats across."]);
    expect(sixPieceBurr.problems({ ...base, size: 8, surface: "basket", surfaceRepeats: 6 })[0]).toMatch(/too thin for this pattern/);
    expect(sixPieceBurr.problems({ ...base, surface: "lattice", surfaceRepeats: 3 })).toEqual([]);
  });
});

/** The six cubes next to a cube. */
function DIRSOF(v: V3): V3[] {
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => [v[0] + d[0], v[1] + d[1], v[2] + d[2]] as V3);
}
