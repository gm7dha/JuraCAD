/**
 * Frames with the real OpenCascade engine: mitred and butted rectangles, a cube frame of 12 members, Ts (a split post,
 * a cross, rails each side of a post, angled rails), copes against the outside only, profiles kept the same way round
 * (lines drawn either way, an L between two sketches), stable member ids, gussets (at a corner and at a T) and trims.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { measureVolume, type Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import type { FrameDef } from "../src/model/frameTypes";
import type { SketchData } from "../src/sketch/types";
import { builtInProfile, profileArea, type ProfileShape } from "../src/model/frameProfiles";
import { gussetVolume } from "../src/model/frame";
import { loadOpenCascade, feature, sketchFeature } from "./support/engineHelpers";
import { polySketch } from "./support/frameSketch";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
type Built = ReturnType<typeof build>;
const checked = () => engine.check("normal").parts;
const frame = (def: Partial<FrameDef> & Pick<FrameDef, "paths">, params: Record<string, string | number> = {}): Feature => ({
  ...feature("frame", params),
  frame: { profile: { kind: "extrusion", size: "2020" }, ...def },
});
const area = (kind: Parameters<typeof builtInProfile>[0], size: string) => profileArea(builtInProfile(kind, size) as ProfileShape);
const shapes = () => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.map((p) => p.shape);
/** A member's part id: the frame's id and its first curve. */
const memberId = (f: Feature, sketch: Feature, curve: string) => `${f.id}~${sketch.id}_${curve}`;
const lens = (r: Built) => r.parts.filter((p) => p.frame).map((p) => p.frame!.length);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

function lines(pts: [number, number][], segs: [number, number][]): SketchData {
  return { points: pts.map(([x, y], i) => ({ id: `p${i}`, x, y })), curves: segs.map(([a, b], i) => ({ id: `l${i}`, type: "line" as const, p1: `p${a}`, p2: `p${b}`, construction: false })), constraints: [] };
}

function overlap(a: Shape3D, b: Shape3D): number {
  const i = a.clone().intersect(b.clone()) as Shape3D;
  try {
    return measureVolume(i);
  } catch {
    return 0;
  } finally {
    i.delete();
  }
}
function worstOverlap(): number {
  const s = shapes();
  let w = 0;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) w = Math.max(w, overlap(s[i], s[j]));
  return w;
}

describe("frames (real OCCT)", () => {
  it("a rectangle of 2020 makes 4 mitred members of the right length and volume", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]]));
    const f = frame({ paths: [{ sketch: sk.id }] });
    const r = build([sk, f]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(4);
    expect(r.parts.map((p) => p.name)).toEqual([`${f.name} member 1`, `${f.name} member 2`, `${f.name} member 3`, `${f.name} member 4`]);
    expect(r.parts.map((p) => p.id)).toEqual(["l0", "l1", "l2", "l3"].map((l) => memberId(f, sk, l)));
    const A = area("extrusion", "2020");
    const parts = checked();
    // A centred profile cut by mitres through the path's corners: volume = area × the path's length.
    const vols = parts.map((p) => p.exactVolume!);
    expect(vols[0] / (A * 400)).toBeCloseTo(1, 5);
    expect(vols[1] / (A * 300)).toBeCloseTo(1, 5);
    expect(parts.every((p) => p.geometryValid)).toBe(true);
    expect(r.parts[0].frame?.length).toBeCloseTo(420, 2);
    expect(r.parts[0].frame?.ends).toEqual([45, 45]);
    expect(worstOverlap()).toBeLessThan(1e-3);
    // (The overlap measure does see an overlap.)
    const s = shapes();
    expect(overlap(s[0], s[0])).toBeGreaterThan(1000);
  });

  it("butt corners: the longer members run through, two pairs", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]]));
    const keys = [`${sk.id}/l0+${sk.id}/l3`, `${sk.id}/l0+${sk.id}/l1`, `${sk.id}/l1+${sk.id}/l2`, `${sk.id}/l2+${sk.id}/l3`];
    const r = build([sk, frame({ paths: [{ sketch: sk.id }], profile: { kind: "box", size: "40x40x2" }, corners: keys.map((key) => ({ key, type: "butt" as const })) })]);
    expect(r.featureErrors).toEqual({});
    const A = area("box", "40x40x2");
    expect(checked().map((p) => Math.round((p.exactVolume! / A) * 100) / 100)).toEqual([440, 260, 440, 260]);
    expect(lens(r)).toEqual([440, 260, 440, 260]);
    expect(worstOverlap()).toBeLessThan(1e-3);
  });

  it("a cube frame of 12 lengths of 2040: front and back rails run through, side rails and uprights stop", () => {
    const L = 300;
    const bottom = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [L, 0], [L, L], [0, L]]));
    const top = sketchFeature({ kind: "face", origin: [0, 0, L], u: [1, 0, 0], v: [0, 1, 0], label: "top" }, polySketch([[0, 0], [L, 0], [L, L], [0, L]]));
    const ups = lines([[0, 0], [0, L], [L, 0], [L, L]], [[0, 1], [2, 3]]);
    const front = sketchFeature({ kind: "default", name: "Front" }, ups);
    const back = sketchFeature({ kind: "face", origin: [0, L, 0], u: [1, 0, 0], v: [0, 0, 1], label: "back" }, ups);
    const f = frame({ paths: [bottom, top, front, back].map((s) => ({ sketch: s.id })), profile: { kind: "extrusion", size: "2040" } });
    const r = build([bottom, top, front, back, f]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(12);
    expect(sorted(lens(r))).toEqual([260, 260, 260, 260, 280, 280, 280, 280, 340, 340, 340, 340]);
    expect(worstOverlap()).toBeLessThan(1e-3);
    expect(checked().every((p) => p.geometryValid)).toBe(true);
  });

  it("a T drawn as a post split where the rail meets it: one post, the rail stops at its side (either order)", () => {
    for (const order of [
      [[0, 1], [1, 2], [1, 3]],
      [[1, 3], [0, 1], [1, 2]],
    ] as [number, number][][]) {
      const sk = sketchFeature({ kind: "default", name: "Top" }, lines([[0, 0], [200, 0], [400, 0], [200, 300]], order));
      const r = build([sk, frame({ paths: [{ sketch: sk.id }] })]);
      expect(r.featureErrors).toEqual({});
      expect(sorted(lens(r))).toEqual([290, 400]);
      expect(worstOverlap()).toBeLessThan(1e-3);
    }
    // Kept as separate lengths: two post halves meeting square, the rail stopping at their side.
    const sk = sketchFeature({ kind: "default", name: "Top" }, lines([[0, 0], [200, 0], [400, 0], [200, 300]], [[0, 1], [1, 2], [1, 3]]));
    const r = build([sk, frame({ paths: [{ sketch: sk.id }], noMerge: true })]);
    expect(sorted(lens(r))).toEqual([200, 200, 290]);
    expect(worstOverlap()).toBeLessThan(1e-3);
  });

  it("a + crossing: one long member, two ending on its sides", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, lines([[0, 0], [200, 0], [-200, 0], [0, 200], [0, -200]], [[0, 1], [0, 2], [0, 3], [0, 4]]));
    const r = build([sk, frame({ paths: [{ sketch: sk.id }] })]);
    expect(r.featureErrors).toEqual({});
    expect(sorted(lens(r))).toEqual([190, 190, 400]);
    expect(worstOverlap()).toBeLessThan(1e-3);
  });

  it("rails each side of a post, square or at an angle, stop at its sides", () => {
    const sk = sketchFeature({ kind: "default", name: "Front" }, lines([[0, 0], [0, 400], [-200, 200], [0, 200], [200, 200]], [[0, 1], [2, 3], [3, 4]]));
    const r = build([sk, frame({ paths: [{ sketch: sk.id }] })]);
    expect(r.featureErrors).toEqual({});
    expect(sorted(lens(r))).toEqual([190, 190, 400]);
    expect(worstOverlap()).toBeLessThan(1e-3);
    const sk2 = sketchFeature({ kind: "default", name: "Front" }, lines([[0, 0], [0, 400], [-200, 200], [0, 200], [0, 200], [200, 300]], [[0, 1], [2, 3], [4, 5]]));
    const r2 = build([sk2, frame({ paths: [{ sketch: sk2.id }] })]);
    expect(r2.featureErrors).toEqual({});
    expect(worstOverlap()).toBeLessThan(1e-3);
  });

  it("lines drawn either way round: the profile stays on one side all round", () => {
    const pts: [number, number][] = [[0, 0], [400, 0], [400, 300], [0, 300]];
    const results: number[][] = [];
    for (const segs of [
      [[0, 1], [1, 2], [2, 3], [3, 0]],
      [[0, 1], [1, 2], [3, 2], [0, 3]],
    ] as [number, number][][]) {
      const sk = sketchFeature({ kind: "default", name: "Top" }, lines(pts, segs));
      const r = build([sk, frame({ paths: [{ sketch: sk.id }], profile: { kind: "timber", size: "44x94" }, anchor: "bottomLeft" })]);
      expect(r.featureErrors).toEqual({});
      expect(r.featureWarnings ?? {}).toEqual({});
      expect(worstOverlap()).toBeLessThan(1e-3);
      const total = checked().reduce((t, p) => t + p.exactVolume!, 0) / 94;
      // A picture frame 44 wide, inside or outside the drawn rectangle.
      const inside = 400 * 300 - (400 - 88) * (300 - 88);
      const outside = (400 + 88) * (300 + 88) - 400 * 300;
      expect(Math.min(Math.abs(total - inside), Math.abs(total - outside))).toBeLessThan(0.01);
      results.push(sorted(lens(r)));
    }
    expect(results[1]).toEqual(results[0]);
  });

  it("an L between a line on Top and an upright on Front or Right mitres with matching sections", () => {
    for (const nm of ["Front", "Right"] as const) {
      const top = sketchFeature({ kind: "default", name: "Top" }, lines([[0, 0], [400, 0]], [[0, 1]]));
      const up = sketchFeature({ kind: "default", name: nm }, lines([[0, 0], [0, 400]], [[0, 1]]));
      const r = build([top, up, frame({ paths: [{ sketch: top.id }, { sketch: up.id }], profile: { kind: "extrusion", size: "2040" } })]);
      expect(r.featureErrors).toEqual({});
      const [a, b] = lens(r);
      expect(a).toBeCloseTo(b, 2);
      expect(worstOverlap()).toBeLessThan(1e-3);
      // The same profile edge-on across the corner: both reach as far across (y).
      const [sa, sb] = shapes().map((x) => x.boundingBox.bounds as [number[], number[]]);
      expect(sa[0][1]).toBeCloseTo(sb[0][1], 3);
      expect(sa[1][1]).toBeCloseTo(sb[1][1], 3);
    }
  });

  it("copes meet the outside of the member running through (no tongues in its slots)", () => {
    for (const [prof, want] of [
      [{ kind: "extrusion", size: "2020" }, 290],
      [{ kind: "box", size: "40x40x2" }, 280],
    ] as const) {
      const sk = sketchFeature({ kind: "default", name: "Top" }, lines([[0, 0], [400, 0], [200, 0], [200, 300]], [[0, 1], [2, 3]]));
      const key = `${sk.id}/l1|on:${sk.id}/l0`;
      const r = build([sk, frame({ paths: [{ sketch: sk.id }], profile: prof, corners: [{ key, type: "coped" }] })]);
      expect(r.featureErrors).toEqual({});
      expect(lens(r)[1]).toBeCloseTo(want, 2);
      const bb = shapes()[1].boundingBox.bounds as [number[], number[]];
      expect(bb[1][1] - bb[0][1]).toBeCloseTo(want, 2);
      expect(worstOverlap()).toBeLessThan(1e-3);
      expect(checked().every((p) => p.geometryValid)).toBe(true);
    }
  });

  it("members keep their ids when another line is deleted", () => {
    const sq = polySketch([[0, 0], [400, 0], [400, 300], [0, 300]], false);
    const sk = sketchFeature({ kind: "default", name: "Top" }, sq);
    const f = frame({ paths: [{ sketch: sk.id }] });
    const before = build([sk, f]).parts.map((p) => p.id);
    const fewer: Feature = { ...sk, sketch: { ...sk.sketch!, data: { ...sq, curves: sq.curves.filter((c) => c.id !== "l1") } } };
    const after = build([fewer, f]).parts.map((p) => p.id);
    expect(after).toEqual(before.filter((id) => !id.endsWith("_l1")));
  });

  it("gussets at a corner and at a T, and trims to a plane", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]]));
    const f = frame({ paths: [{ sketch: sk.id }], profile: { kind: "box", size: "40x40x2" } });
    const g: Feature = { ...feature("gusset", { size: 80, thickness: 5, chamfer: 10 }), gusset: { parts: [memberId(f, sk, "l0"), memberId(f, sk, "l3")], chamfer: true } };
    const trim: Feature = { ...feature("trimFrame", {}), trimFrame: { parts: [memberId(f, sk, "l0")], plane: { kind: "face", origin: [380, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 380" } } };
    const r = build([sk, f, g, trim]);
    expect(r.featureErrors).toEqual({});
    const gp = checked().find((p) => p.partId === g.id)!;
    expect(gp.exactVolume! / gussetVolume(80, 10, 90, 5)).toBeCloseTo(1, 5);
    const m1 = r.parts.find((p) => p.id === memberId(f, sk, "l0"))!;
    expect(m1.frame!.length).toBeCloseTo(400, 2);
    expect(m1.frame!.ends).toEqual([45, 0]);
    // A rail ending on a leg's side.
    const tee = sketchFeature({ kind: "default", name: "Front" }, lines([[0, 0], [0, 400], [0, 200], [300, 200]], [[0, 1], [2, 3]]));
    const tf = frame({ paths: [{ sketch: tee.id }], profile: { kind: "box", size: "40x40x2" } });
    const tg: Feature = { ...feature("gusset", { size: 60, thickness: 4 }), gusset: { parts: [memberId(tf, tee, "l0"), memberId(tf, tee, "l1")] } };
    const r2 = build([tee, tf, tg]);
    expect(r2.featureErrors).toEqual({});
    expect(checked().find((p) => p.partId === tg.id)!.exactVolume! / gussetVolume(60, 0, 90, 4)).toBeCloseTo(1, 5);
    expect(worstOverlap()).toBeLessThan(1e-3);
  });

  it("trims to another member mark the right end; a curved member trimmed is measured again", () => {
    const post = sketchFeature({ kind: "default", name: "Top" }, lines([[0, 0], [400, 0]], [[0, 1]]));
    const rail = sketchFeature({ kind: "default", name: "Top" }, lines([[200, -100], [200, 300]], [[0, 1]]));
    const f1 = frame({ paths: [{ sketch: post.id }] });
    const f2 = frame({ paths: [{ sketch: rail.id }] });
    const trim: Feature = { ...feature("trimFrame", {}), trimFrame: { parts: [memberId(f2, rail, "l0")], to: memberId(f1, post, "l0") } };
    const r = build([post, rail, f1, f2, trim]);
    expect(r.featureErrors).toEqual({});
    const m = r.parts.find((p) => p.id === memberId(f2, rail, "l0"))!;
    expect(m.frame!.ends).toEqual(["coped", 0]);
    expect(m.frame!.length).toBeCloseTo(290, 2);
    expect(worstOverlap()).toBeLessThan(1e-3);
    const arc: SketchData = {
      points: [
        { id: "c", x: 0, y: 0 },
        { id: "a", x: 200, y: 0 },
        { id: "b", x: -200, y: 0 },
      ],
      curves: [{ id: "k", type: "arc", center: "c", start: "a", end: "b", construction: false }],
      constraints: [],
    };
    const ask = sketchFeature({ kind: "default", name: "Top" }, arc);
    const f3 = frame({ paths: [{ sketch: ask.id }], profile: { kind: "tube", size: "20x2" } });
    const t2: Feature = { ...feature("trimFrame", {}), trimFrame: { parts: [memberId(f3, ask, "k")], plane: { kind: "face", origin: [100, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 100" } } };
    const r2 = build([ask, f3, t2]);
    expect(r2.featureErrors).toEqual({});
    const c = r2.parts[0].frame!;
    expect(c.length).toBeCloseTo((2 * Math.PI * 200) / 3, 0);
    expect(c.ends[0]).not.toBe(0);
  });

  it("coped round tubes and a trim to another member leave sound parts that don't overlap", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [300, 0], [300, 200], [0, 200]]));
    const keys = [`${sk.id}/l0+${sk.id}/l3`, `${sk.id}/l0+${sk.id}/l1`, `${sk.id}/l1+${sk.id}/l2`, `${sk.id}/l2+${sk.id}/l3`];
    const f = frame({ paths: [{ sketch: sk.id }], profile: { kind: "tube", size: "25x2" }, corners: keys.map((key) => ({ key, type: "coped" as const })) });
    const cross = sketchFeature({ kind: "default", name: "Top" }, polySketch([[150, -50], [150, 250]], false));
    const g = frame({ paths: [{ sketch: cross.id }], profile: { kind: "tube", size: "20x2" } });
    const trim: Feature = { ...feature("trimFrame", {}), trimFrame: { parts: [memberId(g, cross, "l0")], to: memberId(f, sk, "l0") } };
    const r = build([sk, f, cross, g, trim]);
    expect(r.featureErrors).toEqual({});
    expect(checked().every((p) => p.geometryValid)).toBe(true);
    const s = shapes();
    for (let i = 0; i < 4; i++) expect(overlap(s[i], s[(i + 1) % 4])).toBeLessThan(1e-3);
    expect(overlap(s[4], s[0])).toBeLessThan(1e-3);
    const trimmed = r.parts.find((p) => p.id === memberId(g, cross, "l0"))!;
    expect(trimmed.frame!.ends[0]).toBe("coped");
    expect(trimmed.frame!.length).toBeLessThan(300);
  });
});
