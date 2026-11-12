/**
 * Frames with the real OpenCascade engine: a rectangle of 2020 makes 4 mitred members, butt corners, a cube frame of
 * 12 members with no overlaps, a gusset's volume and trimming to a plane.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import type { FrameDef } from "../src/model/frameTypes";
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
const checked = () => engine.check("normal").parts;
const frame = (def: Partial<FrameDef> & Pick<FrameDef, "paths">, params: Record<string, string | number> = {}): Feature => ({
  ...feature("frame", params),
  frame: { profile: { kind: "extrusion", size: "2020" }, ...def },
});
const area = (kind: Parameters<typeof builtInProfile>[0], size: string) => profileArea(builtInProfile(kind, size) as ProfileShape);
const shapes = () => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.map((p) => p.shape);

function overlap(a: Shape3D, b: Shape3D): number {
  const i = a.clone().intersect(b.clone()) as Shape3D;
  try {
    return i.volume ?? 0;
  } catch {
    return 0;
  } finally {
    i.delete();
  }
}

describe("frames (real OCCT)", () => {
  it("a rectangle of 2020 makes 4 mitred members of the right length and volume", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]]));
    const f = frame({ paths: [{ sketch: sk.id }] });
    const r = build([sk, f]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(4);
    expect(r.parts.map((p) => p.name)).toEqual([`${f.name} member 1`, `${f.name} member 2`, `${f.name} member 3`, `${f.name} member 4`]);
    const A = area("extrusion", "2020");
    const parts = checked();
    // A centred profile cut by mitres through the path's corners: volume = area × the path's length.
    const vols = parts.map((p) => p.exactVolume!);
    expect(vols[0] / (A * 400)).toBeCloseTo(1, 5);
    expect(vols[1] / (A * 300)).toBeCloseTo(1, 5);
    expect(parts.every((p) => p.geometryValid)).toBe(true);
    expect(r.parts[0].frame?.length).toBeCloseTo(420, 2);
    expect(r.parts[0].frame?.ends).toEqual([45, 45]);
    const s = shapes();
    expect(overlap(s[0], s[1])).toBeLessThan(1e-3);
  });

  it("butt corners: through members 440 long, the others 260", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]]));
    const keys = ["s/l0+s/l3", "s/l0+s/l1", "s/l1+s/l2", "s/l2+s/l3"].map((k) => k.replace(/s\//g, `${sk.id}/`));
    const corners = keys.map((key, i) => ({ key, type: "butt" as const, through: `${sk.id}/l${i < 2 ? 0 : 2}` }));
    const r = build([sk, frame({ paths: [{ sketch: sk.id }], profile: { kind: "box", size: "40x40x2" }, corners })]);
    expect(r.featureErrors).toEqual({});
    const A = area("box", "40x40x2");
    const vols = checked().map((p) => p.exactVolume! / A);
    expect(vols.map((v) => Math.round(v * 100) / 100)).toEqual([440, 260, 440, 260]);
    expect(r.parts.map((p) => p.frame?.length)).toEqual([440, 260, 440, 260]);
    const s = shapes();
    for (let i = 0; i < 4; i++) expect(overlap(s[i], s[(i + 1) % 4])).toBeLessThan(1e-3);
  });

  it("a cube frame of 12 members builds quickly with nothing overlapping", () => {
    const L = 300;
    const bottom = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [L, 0], [L, L], [0, L]]));
    const top = sketchFeature({ kind: "face", origin: [0, 0, L], u: [1, 0, 0], v: [0, 1, 0], label: "top" }, polySketch([[0, 0], [L, 0], [L, L], [0, L]]));
    // Front plane: x across, z up. Upright lines at x = 0 and x = L, on y = 0 and on y = L.
    const front = sketchFeature({ kind: "default", name: "Front" }, { ...polySketch([[0, 0], [0, L]], false) });
    const frontData = polySketch([[0, 0], [0, L]], false);
    frontData.points.push({ id: "q0", x: L, y: 0 }, { id: "q1", x: L, y: L });
    frontData.curves.push({ id: "m0", type: "line", p1: "q0", p2: "q1", construction: false });
    front.sketch!.data = frontData;
    const back = sketchFeature({ kind: "face", origin: [0, L, 0], u: [1, 0, 0], v: [0, 0, 1], label: "back" }, frontData);
    const f = frame({ paths: [bottom, top, front, back].map((s) => ({ sketch: s.id })) });
    const t0 = Date.now();
    const r = build([bottom, top, front, back, f]);
    const took = Date.now() - t0;
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(12);
    expect(took).toBeLessThan(60000);
    const s = shapes();
    let worst = 0;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) worst = Math.max(worst, overlap(s[i], s[j]));
    expect(worst).toBeLessThan(1e-3);
    expect(checked().every((p) => p.geometryValid)).toBe(true);
    // The frame fills the cube's outline: 320 across.
    const lens = r.parts.map((p) => p.frame!.length).sort((a, b) => a - b);
    expect(lens[lens.length - 1]).toBeCloseTo(320, 2);
  });

  it("a gusset in a corner has the plate's volume, and trimming to a plane shortens a member", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]]));
    const f = frame({ paths: [{ sketch: sk.id }], profile: { kind: "box", size: "40x40x2" } });
    const g: Feature = { ...feature("gusset", { size: 80, thickness: 5, chamfer: 10 }), gusset: { parts: [f.id, `${f.id}~4`], chamfer: true } };
    const trim: Feature = { ...feature("trimFrame", {}), trimFrame: { parts: [f.id], plane: { kind: "face", origin: [380, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x = 380" } } };
    const r = build([sk, f, g, trim]);
    expect(r.featureErrors).toEqual({});
    const parts = checked();
    const gp = parts.find((p) => p.partId === g.id)!;
    expect(gp.exactVolume! / gussetVolume(80, 10, 90, 5)).toBeCloseTo(1, 5);
    const member1 = r.parts.find((p) => p.id === f.id)!;
    expect(member1.frame!.length).toBeCloseTo(400, 2);
    expect(member1.frame!.ends).toEqual([45, 0]);
  });
});
