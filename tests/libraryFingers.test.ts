import { describe, expect, it } from "vitest";
import { agrees, lit, named, plus, times, type Ex } from "../src/library/ex";
import { areaOf, boxProblems, fingerCount, fingerCounts, nearestOdd, panelOutlines, panelSpecs, shellVolume, sideOf, type BoxSizes } from "../src/library/fingers";

const scope = { box_width: 120, box_depth: 80, box_height: 60, box_thickness: 3, box_kerf: 0 };
const sizes = (over: Partial<BoxSizes> = {}, s: Record<string, number> = scope): BoxSizes => ({
  W: named("box_width", s),
  D: named("box_depth", s),
  H: named("box_height", s),
  t: named("box_thickness", s),
  kerf: named("box_kerf", s),
  lid: true,
  finger: 10,
  ...over,
});

describe("finger counts", () => {
  it("are always odd, so the same panel has both ends of an edge", () => {
    for (let x = 0; x < 40; x += 0.37) expect(nearestOdd(x) % 2).toBe(1);
    expect(nearestOdd(7)).toBe(7);
    expect(nearestOdd(8)).toBe(9);
    expect(nearestOdd(5.9)).toBe(5);
    expect(fingerCount(120, 10, 4)).toBe(13);
    expect(fingerCount(100, 10, 4)).toBe(11);
  });
  it("get fewer (and wider) when the fingers would be too small", () => {
    // 30 mm with 3 mm fingers would be 9 (or 11), but each must be at least 8 mm.
    expect(fingerCount(30, 3, 8)).toBe(3);
    expect(fingerCount(10, 3, 8)).toBe(1);
    const n = fingerCounts(sizes());
    expect(n).toEqual({ width: 13, depth: 7, height: 7 });
    expect(n.width % 2 + n.depth % 2 + n.height % 2).toBe(3);
  });
});

describe("edges", () => {
  it("alternate finger and slot, and the two panels at an edge are opposites", () => {
    const b = sizes();
    const n = fingerCounts(b);
    const p = panelSpecs(b, n);
    const pairs: [keyof typeof p, "south" | "north" | "east" | "west", keyof typeof p, "south" | "north" | "east" | "west"][] = [
      ["bottom", "south", "front", "south"],
      ["bottom", "west", "left", "south"],
      ["front", "west", "left", "west"],
      ["front", "east", "left", "west"],
    ];
    for (const [a, sa, c, sc] of pairs) {
      const A = sideOf(p[a][sa]);
      const C = sideOf(p[c][sc]);
      expect(A.inset.length).toBe(C.inset.length);
      expect(A.inset.length % 2).toBe(1);
      A.inset.forEach((x, i) => {
        expect(x).toBe(!C.inset[i]);
        if (i > 0) expect(x).toBe(!A.inset[i - 1]);
      });
      A.breaks.forEach((x, i) => expect(x.v).toBeCloseTo(C.breaks[i].v, 9));
    }
    // The front and back have the corner fingers; the bottom's are slots there.
    expect(sideOf(p.front.south).inset[0]).toBe(false);
    expect(sideOf(p.bottom.south).inset[0]).toBe(true);
    // Between the front and back the bottom pokes its end fingers into the sides.
    expect(sideOf(p.bottom.west).inset[0]).toBe(false);
  });

  it("puts the depth fingers between the front and back panels", () => {
    const s = sideOf(panelSpecs(sizes(), fingerCounts(sizes())).bottom.west);
    expect(s.breaks[0].v).toBeCloseTo(3 + 74 / 7, 9);
    expect(s.breaks[s.breaks.length - 1].v).toBeCloseTo(80 - 3 - 74 / 7, 9);
  });
});

describe("panels", () => {
  for (const lid of [true, false]) {
    it(`add up to exactly the box's walls${lid ? " and lid" : " (no lid)"}`, () => {
      const b = sizes({ lid });
      const panels = panelOutlines(b);
      const area = Object.fromEntries(panels.map((p) => [p.name, areaOf(p.nominal)]));
      for (const p of panels) expect(areaOf(p.nominal)).toBeGreaterThan(0);
      const volume = 3 * ((lid ? 2 : 1) * area.bottom + 2 * area.front + 2 * area.left);
      expect(volume).toBeCloseTo(shellVolume(b), 6);
    });
  }

  it("are drawn kerf/2 bigger all round, and follow the variables", () => {
    const s = { ...scope, box_kerf: 0.2 };
    const b = sizes({}, s);
    const front = panelOutlines(b).find((p) => p.name === "front")!;
    const xs = front.outline.map((p) => p[0].v);
    expect(Math.min(...xs)).toBeCloseTo(-0.1, 9);
    expect(Math.max(...xs)).toBeCloseTo(120.1, 9);
    for (const p of panelOutlines(b)) {
      // Each finger and slot step grows the outline: more area than the true shape.
      expect(areaOf(p.outline)).toBeGreaterThan(areaOf(p.nominal));
      for (const pt of p.outline) for (const c of pt) expect(agrees(c, s)).toBe(true);
      // An anticlockwise outline with only square corners.
      p.outline.forEach((a, i) => {
        const c = p.outline[(i + 1) % p.outline.length];
        expect(Math.abs(a[0].v - c[0].v) < 1e-9 || Math.abs(a[1].v - c[1].v) < 1e-9).toBe(true);
      });
    }
    // Every corner of the true shape uses the variables, so changing them moves it.
    const wide = { ...s, box_width: 150 };
    const moved = front.outline.map((pt) => pt.map((c: Ex) => c.t));
    expect(moved.some((pt) => pt[0].includes("box_width"))).toBe(true);
    expect(agrees({ t: moved[2][0], v: 0 }, wide)).toBe(false);
  });

  it("can be measured inside", () => {
    // Inside 100 × 70 × 50 with a lid: outside = inside + 2t.
    const s = { box_width: 100, box_depth: 70, box_height: 50, box_thickness: 3, box_kerf: 0 };
    const t = named("box_thickness", s);
    const b: BoxSizes = { W: plus(named("box_width", s), times(t, 2)), D: plus(named("box_depth", s), times(t, 2)), H: plus(named("box_height", s), times(t, 2)), t, kerf: named("box_kerf", s), lid: true, finger: 12 };
    expect(b.W.v).toBe(106);
    const vol = panelOutlines(b).reduce((n, p) => n + areaOf(p.nominal) * (p.name === "bottom" ? 2 : 2) * 3, 0);
    expect(vol).toBeCloseTo(shellVolume(b), 6);
  });

  it("says plainly when the sizes can't work", () => {
    expect(boxProblems(sizes())).toEqual([]);
    expect(boxProblems(sizes({ W: lit(10) })).join(" ")).toMatch(/too small/);
    expect(boxProblems(sizes({ kerf: lit(2) })).join(" ")).toMatch(/kerf/);
  });
});
