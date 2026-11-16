/**
 * Engine tests: Sweep's further choices, as Onshape's — thin and extra-area sweeps along curve features, Keep profile
 * orientation refusing a leg in the profile's plane, a twist with the profile part way along a cornered path, twists
 * given as turns or a pitch, Scale (exact frustums), Lock profile direction, surface sweeps along curves, and a part's
 * flat face as the profile. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { CurveDef, Feature, SweepOptions } from "../src/model/types";
import { addCircle, addLine } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, relativeError, rectSketch, lineSketch, meshOf } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const vol = (i = 0) => engine.check("normal").parts[i].exactVolume!;
const valid = (i = 0) => engine.check("normal").parts[i].geometryValid;
const curve = (def: CurveDef, params: Record<string, number> = {}): Feature => ({ ...feature("curve", params), curve: def });
const sweep = (sketchRef: string | undefined, pathRef: string | undefined, params: Record<string, number> = {}, extra: Partial<Feature> = {}): Feature => ({
  ...feature("sweep", params),
  ...(sketchRef ? { sketchRef } : {}),
  ...(pathRef ? { pathRef } : {}),
  apart: true,
  ...extra,
});
const control = (c: SweepOptions): Partial<Feature> => ({ sweepControl: c });
/** Where a part's mesh reaches across Y and Z at the slice x ≥ `x` (its end face there). */
const endSpan = (r: { parts: { vertices: Float32Array }[] }, x: number, i = 0) => {
  const v = r.parts[i].vertices;
  const span = { y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  for (let k = 0; k < v.length; k += 3) {
    if (v[k] < x - 1e-3) continue;
    span.y = [Math.min(span.y[0], v[k + 1]), Math.max(span.y[1], v[k + 1])];
    span.z = [Math.min(span.z[0], v[k + 2]), Math.max(span.z[1], v[k + 2])];
  }
  return span;
};

describe("sweeps along curve features", () => {
  const helix = () => curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 20, height: 30, turns: 5 });

  it("a thin sweep along a helix builds (it used to say the helix comes after it)", () => {
    const h = helix();
    const sq = sketchFeature({ kind: "default", name: "Front" }, rectSketch(9, -1, 2, 2));
    const solid = build([h, sq, sweep(sq.id, h.id)]);
    expect(solid.featureErrors).toEqual({});
    const full = vol();
    const thin = build([h, sq, sweep(sq.id, h.id, { thickness: 0.3 }, { thin: {} })]);
    expect(thin.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    // A wall 0.3 thick round the square's inside: (4 − 1.4²) of the full 4 mm² section.
    expect(relativeError(vol(), (full * (4 - 1.4 * 1.4)) / 4)).toBeLessThan(0.02);
  });

  it("a sweep along a helix using areas of another sketch too builds", () => {
    const h = helix();
    const sq = sketchFeature({ kind: "default", name: "Front" }, rectSketch(9, -1, 2, 2));
    const other = sketchFeature({ kind: "default", name: "Front" }, rectSketch(9, 2, 2, 1));
    const one = build([h, sq, other, sweep(sq.id, h.id)]);
    expect(one.featureErrors).toEqual({});
    const v1 = vol();
    const r = build([h, sq, other, sweep(sq.id, h.id, {}, { moreAreas: [{ sketch: other.id, areas: [[10, 2.5]] }] })]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    // The second square (2 × 1, between the turns) adds half as much again, as a coil of its own.
    const total = engine.check("normal").parts.reduce((t, p) => t + p.exactVolume!, 0);
    expect(relativeError(total, v1 * 1.5)).toBeLessThan(0.02);
  });

  it("a surface sweep follows a helix", () => {
    const h = helix();
    const ln = sketchFeature({ kind: "default", name: "Front" }, lineSketch(9, 0, 11, 0));
    const r = build([h, ln, sweep(ln.id, h.id, {}, { surface: true })]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].surface).toBe(true);
  });
});

describe("Keep profile orientation", () => {
  it("refuses a path with a straight leg lying in the profile's plane (it used to make a flat fin)", () => {
    const circle = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const path = sketchFeature({ kind: "default", name: "Top" }, addLine(lineSketch(0, 0, 0, 50), { x: 0, y: 50 }, { x: 40, y: 50 }).sketch);
    const r = build([path, circle, sweep(circle.id, path.id, {}, control({ lockOrientation: true }))]);
    expect(Object.values(r.featureErrors)[0]).toMatch(/Kept facing one way, the profile would turn edge-on/);
    // A first leg alone is fine.
    const leg = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 0, 0, 50));
    const ok = build([leg, circle, sweep(circle.id, leg.id, {}, control({ lockOrientation: true }))]);
    expect(ok.featureErrors).toEqual({});
    expect(relativeError(vol(), Math.PI * 4 * 50)).toBeLessThan(1e-6);
  });
});

describe("twist with the profile part way along", () => {
  it("twists round a sharp corner with the profile in the middle of the first leg", () => {
    const sq = sketchFeature({ kind: "default", name: "Front" }, rectSketch(-2, -2, 4, 4));
    const path = sketchFeature({ kind: "default", name: "Top" }, addLine(lineSketch(0, -25, 0, 25), { x: 0, y: 25 }, { x: 40, y: 25 }).sketch);
    const plain = build([path, sq, sweep(sq.id, path.id)]);
    expect(plain.featureErrors).toEqual({});
    const v0 = vol();
    const r = build([path, sq, sweep(sq.id, path.id, { twist: 90 })]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    expect(r.parts).toHaveLength(1);
    // Twisting doesn't change how much is swept, nor do the corners (rounded the same way).
    expect(relativeError(vol(), v0)).toBeLessThan(2e-3);
  });

  it("shares the twist by length either side of the profile, the start turned the other way", () => {
    // 50 mm behind the profile, 70 ahead (round a corner): a twist of 216° turns the start a quarter turn back.
    const path = sketchFeature({ kind: "default", name: "Top" }, addLine(lineSketch(0, 0, 100, 0), { x: 100, y: 0 }, { x: 100, y: 20 }).sketch);
    // A 2 × 2 square off the path at y 4…6 (the profile on a plane x = 50, square to the path).
    const off = sketchFeature({ kind: "face", origin: [50, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 50" }, rectSketch(4, -1, 2, 2));
    const r = build([path, off, sweep(off.id, path.id, { twist: 216 })]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    // The start (x = 0): +Y turned back round to −Z.
    const v = r.parts[0].vertices;
    const span = { y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    for (let k = 0; k < v.length; k += 3) {
      if (v[k] > 1e-3) continue;
      span.y = [Math.min(span.y[0], v[k + 1]), Math.max(span.y[1], v[k + 1])];
      span.z = [Math.min(span.z[0], v[k + 2]), Math.max(span.z[1], v[k + 2])];
    }
    expect(span.z[0]).toBeCloseTo(-6, 2);
    expect(span.z[1]).toBeCloseTo(-4, 2);
    expect(span.y[0]).toBeCloseTo(-1, 2);
    expect(span.y[1]).toBeCloseTo(1, 2);
  });
});

describe("twist as turns or a pitch", () => {
  it("turns and pitch give the same as the angle they stand for", () => {
    const path = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 0, 100, 0));
    const off = sketchFeature({ kind: "default", name: "Right" }, rectSketch(4, -1, 2, 2));
    const angle = build([path, off, sweep(off.id, path.id, { twist: 90 })]);
    const a = endSpan(angle, 100);
    const turns = build([path, off, sweep(off.id, path.id, { turns: 0.25 }, control({ twistBy: "turns" }))]);
    expect(turns.featureErrors).toEqual({});
    const t = endSpan(turns, 100);
    // A pitch of 400 mm per turn over a 100 mm path: a quarter turn.
    const pitch = build([path, off, sweep(off.id, path.id, { pitch: 400 }, control({ twistBy: "pitch" }))]);
    expect(pitch.featureErrors).toEqual({});
    const p = endSpan(pitch, 100);
    for (const s of [t, p]) {
      expect(s.z[0]).toBeCloseTo(a.z[0], 2);
      expect(s.z[1]).toBeCloseTo(a.z[1], 2);
      expect(s.y[0]).toBeCloseTo(a.y[0], 2);
    }
    // Opposite direction: the other way round (−Z).
    const back = build([path, off, sweep(off.id, path.id, { turns: 0.25 }, control({ twistBy: "turns", opposite: true }))]);
    const b = endSpan(back, 100);
    expect(b.z[0]).toBeCloseTo(-6, 2);
    expect(b.z[1]).toBeCloseTo(-4, 2);
  });
});

describe("Scale", () => {
  const line = () => sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 0, 100, 0));
  const disc = () => sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
  const frustum = (h: number, r0: number, r1: number) => (Math.PI * h * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;

  it("makes an exact frustum, the same twisted", () => {
    const path = line();
    const d = disc();
    const r = build([path, d, sweep(d.id, path.id, { scale: 0.5 }, control({ scaled: true }))]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    expect(relativeError(vol(), frustum(100, 2, 1))).toBeLessThan(1e-5);
    // Bigger at the end too.
    build([path, d, sweep(d.id, path.id, { scale: 2 }, control({ scaled: true }))]);
    expect(relativeError(vol(), frustum(100, 2, 4))).toBeLessThan(1e-5);
    // A square twisted as it shrinks: the volume of the untwisted taper (a square frustum).
    const sq = sketchFeature({ kind: "default", name: "Right" }, rectSketch(-2, -2, 4, 4));
    const tw = build([path, sq, sweep(sq.id, path.id, { scale: 0.5, twist: 90 }, control({ scaled: true }))]);
    expect(tw.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    expect(relativeError(vol(), (100 * (16 + 8 + 4)) / 3)).toBeLessThan(1e-3);
    // Scale 1 (ticked or not) is just the plain sweep.
    build([path, d, sweep(d.id, path.id, { scale: 1 }, control({ scaled: true }))]);
    expect(relativeError(vol(), Math.PI * 4 * 100)).toBeLessThan(1e-9);
  });

  it("is 1 at a profile part way along: bigger behind it, smaller ahead", () => {
    const path = line();
    const mid = sketchFeature({ kind: "face", origin: [50, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 50" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const r = build([path, mid, sweep(mid.id, path.id, { scale: 0.5 }, control({ scaled: true }))]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    // r 2 → 1 ahead (50 mm) and, in step with the length, 3 at the start.
    expect(relativeError(vol(), frustum(50, 2, 1) + frustum(50, 3, 2))).toBeLessThan(1e-4);
    // Too much to reach the start: said plainly (40 mm behind, 60 ahead: 1 − 3 × 40 / 60 < 0).
    const near = sketchFeature({ kind: "face", origin: [40, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 40" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const bad = build([path, near, sweep(near.id, path.id, { scale: 4 }, control({ scaled: true }))]);
    expect(Object.values(bad.featureErrors)[0]).toMatch(/shrink it to nothing/);
  });

  it("goes round sharp corners (each corner keeps its size), and is refused round a closed loop", () => {
    const d = disc();
    const L = sketchFeature({ kind: "default", name: "Top" }, addLine(lineSketch(0, 0, 50, 0), { x: 50, y: 0 }, { x: 50, y: 50 }).sketch);
    const plain = build([L, d, sweep(d.id, L.id)]);
    const v0 = vol();
    expect(plain.featureErrors).toEqual({});
    const r = build([L, d, sweep(d.id, L.id, { scale: 0.5 }, control({ scaled: true }))]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    const scaledVol = vol();
    expect(scaledVol).toBeLessThan(v0 * 0.7);
    expect(scaledVol).toBeGreaterThan(v0 * 0.25);
    // Twisted as well (a round profile: twisting changes nothing), and kept facing one way (an L across the profile).
    const tw = build([L, d, sweep(d.id, L.id, { scale: 0.5, twist: 180 }, control({ scaled: true }))]);
    expect(tw.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    expect(relativeError(vol(), scaledVol)).toBeLessThan(2e-3);
    const slant = sketchFeature({ kind: "face", origin: [0, 0, 0], u: [0, 0, 1], v: [-Math.SQRT1_2, Math.SQRT1_2, 0], label: "slant" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const kept = build([L, slant, sweep(slant.id, L.id, { scale: 0.5 }, control({ scaled: true, lockOrientation: true }))]);
    expect(kept.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 20, y: 0 }, 20).sketch);
    const across = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const loop = build([ring, across, sweep(across.id, ring.id, { scale: 0.5 }, control({ scaled: true }))]);
    expect(Object.values(loop.featureErrors)[0]).toMatch(/needs a path with two ends/);
  });

  it("scales along a curve feature, with the profile at its start", () => {
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" } }, { diameter: 20, height: 30, turns: 5 });
    const c = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 10, y: 0 }, 1).sketch);
    const r = build([h, c, sweep(c.id, h.id, { scale: 0.5 }, control({ scaled: true }))]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    // Held in the plane through the axis (the helix's own bending): a tapering coil, area × length shrinking as a frustum.
    const length = Math.hypot(2 * Math.PI * 10 * 5, 30);
    expect(relativeError(vol(), (Math.PI * length * (1 + 0.5 + 0.25)) / 3)).toBeLessThan(0.01);
  });
});

describe("Lock profile direction", () => {
  it("keeps the profile at the same angle to a direction, and refuses a path running along it", () => {
    // A path rising at 45° in the XZ plane, then level: locked to Y (square to the path's plane) the profile follows it.
    const path = sketchFeature({ kind: "default", name: "Front" }, addLine(lineSketch(0, 0, 30, 30), { x: 30, y: 30 }, { x: 60, y: 30 }).sketch);
    const sq = sketchFeature({ kind: "face", origin: [0, 0, 0], u: [0, 1, 0], v: [-Math.SQRT1_2, 0, Math.SQRT1_2], label: "across" }, rectSketch(-2, -1, 4, 2));
    const r = build([path, sq, sweep(sq.id, path.id, {}, control({ lockDirection: { p: [0, 0, 0], axis: "y" } }))]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    const plain = build([path, sq, sweep(sq.id, path.id)]);
    expect(plain.featureErrors).toEqual({});
    const b = meshOf(r).bounds!;
    // The 4 mm side stays along Y all the way.
    expect(b.min[1]).toBeCloseTo(-2, 3);
    expect(b.max[1]).toBeCloseTo(2, 3);
    // Locked to X, the level leg runs along it: said plainly.
    const bad = build([path, sq, sweep(sq.id, path.id, {}, control({ lockDirection: { p: [0, 0, 0], axis: "x" } }))]);
    expect(Object.values(bad.featureErrors)[0]).toMatch(/runs along the direction the profile is locked to/);
  });
});

describe("a part's face as the profile", () => {
  it("sweeps a box's top face up a path, holes and all", () => {
    const base = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const box = { ...extrudeFeature(base.id, 10), apart: true };
    const built = build([base, box]);
    const top = built.parts[0].faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.normal![2] - 1) < 1e-6 && f.center[2] > 9.99)!;
    expect(top).toBeTruthy();
    const path = sketchFeature({ kind: "default", name: "Front" }, lineSketch(5, 10, 5, 40));
    const s = sweep(undefined, path.id, {}, control({ face: { partId: box.id, ref: top } }));
    const r = build([base, box, path, s]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(2);
    expect(relativeError(vol(1), 10 * 10 * 30)).toBeLessThan(1e-6);
    // With a hole through the box, the top face has one too.
    const hole = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 5, y: 5 }, 2).sketch);
    const cut = { ...extrudeFeature(hole.id, 10, { operation: "remove" }), apart: true };
    const holed = build([base, box, hole, cut]);
    const top2 = holed.parts[0].faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.normal![2] - 1) < 1e-6 && f.center[2] > 9.99)!;
    const r2 = build([base, box, hole, cut, path, { ...s, sweepControl: { face: { partId: box.id, ref: top2 } } }]);
    expect(r2.featureErrors).toEqual({});
    expect(relativeError(vol(1), (100 - Math.PI * 4) * 30)).toBeLessThan(1e-5);
  });
});
