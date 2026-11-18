/**
 * More of Onshape's Loft on the real OpenCascade engine: Add/Remove on every part it reaches, shapes on one plane
 * refused, end conditions between slanted shapes, curve features as guide or path, curved faces and part edges as
 * sections, "Tangent to profile" and picked-direction ends, and Thin.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOC, measureVolume, type Face, type Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import { buildLoft, type LoftContext } from "../src/kernel/loft";
import { createFeature, emptyDocument } from "../src/model/document";
import type { CurveDef, Feature, LoftDef } from "../src/model/types";
import { addArc, addCircle, addLine } from "../src/sketch/ops";
import { planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchLine } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, rectSketch, relativeError, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const shapeOf = (id: string): Shape3D | undefined => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)?.shape;
const volumeOf = (id: string) => measureVolume(shapeOf(id)!);
function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const TOP: SketchPlane = { kind: "default", name: "Top" };
const at = (z: number): SketchPlane => planeOnFace([0, 0, 1], [0, 0, z], `${z} up`);
const box = (x: number, y: number, z: number, w: number, d: number, h: number): Feature => feature("box", { x, y, z, width: w, depth: d, height: h });
/** A loft as the app makes a new one now (Onshape's: every part it reaches). */
const newLoft = (sections: string[], patch: Partial<Feature> = {}): Feature => ({ ...feature("loft", {}), apart: true, intersectAll: true, sections, ...patch });
const loftOf = (sections: string[], loft: LoftDef, extra: Partial<Feature> = {}): Feature => ({ ...feature("loft", {}), sections, loft, ...extra });

function sketchContext(sketches: Feature[]): LoftContext {
  return {
    sketch: (id) => {
      const f = sketches.find((s) => s.id === id);
      return f?.sketch?.plane ? { plane: f.sketch.plane, data: f.sketch.data, name: f.name } : null;
    },
    part: () => null,
    face: () => {
      throw new Error("no faces");
    },
    edges: () => [],
    name: (id) => sketches.find((s) => s.id === id)?.name,
  };
}

function sound(shape: Shape3D): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const check = new (getOC() as any).BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try {
    return check.IsValid();
  } finally {
    check.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The steepest a loft's curved side gets right at height z (|normal z|: 0 = upright, 1 = lying flat). */
function slopeAt(shape: Shape3D, z: number): { least: number; most: number } {
  const oc = getOC();
  let least = 1;
  let most = 0;
  for (const f of shape.faces as Face[]) {
    if (f.geomType === "PLANE") continue;
    const ad = new oc.BRepAdaptor_Surface(f.wrapped, false);
    const [u0, u1, v0, v1] = [ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter()];
    for (const v of [v0, v1])
      for (const k of [0.2, 0.5, 0.8]) {
        const p = ad.Value(u0 + (u1 - u0) * k, v);
        if (Math.abs(p.Z() - z) > 1e-3) continue;
        const n = f.normalAt([p.X(), p.Y(), p.Z()]).toTuple();
        const s = Math.abs(n[2]) / Math.hypot(...n);
        least = Math.min(least, s);
        most = Math.max(most, s);
      }
    ad.delete();
  }
  return { least, most };
}

describe("Add and Remove reach every part (as Onshape)", () => {
  it("gives new lofts the flags", () => {
    const doc = emptyDocument();
    const f = createFeature(doc, "loft");
    expect(f.apart).toBe(true);
    expect(f.intersectAll).toBe(true);
  });

  it("cuts and joins both boxes", () => {
    const a = box(0, 0, 0, 40, 40, 10);
    const b = box(50, 0, 0, 40, 40, 10);
    // A straight-sided loft (the same rectangle twice) across both boxes: exact volumes.
    const low = sketchFeature(at(-1), rectSketch(-5, 10, 100, 20));
    const high = sketchFeature(at(11), rectSketch(-5, 10, 100, 20));
    const cut = newLoft([low.id, high.id], { operation: "remove" });
    const r = build([a, b, low, high, cut]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(2);
    for (const p of r.parts) expect(relativeError(volumeOf(p.id), 16000 - 8000)).toBeLessThan(1e-6);
    // The same cut as an old loft (no flags): only the latest box, as before.
    const old = build([a, b, low, high, { ...cut, apart: undefined, intersectAll: undefined }]);
    const vols = old.parts.map((p) => volumeOf(p.id)).sort((x, y) => x - y);
    expect(relativeError(vols[0], 8000)).toBeLessThan(1e-6);
    expect(relativeError(vols[1], 16000)).toBeLessThan(1e-6);
    // Add: one bridge joining both boxes into one part.
    const mid = sketchFeature(at(0), rectSketch(20, 10, 50, 20));
    const midTop = sketchFeature(at(10), rectSketch(20, 10, 50, 20));
    const join = newLoft([mid.id, midTop.id], { operation: "add" });
    const j = build([a, b, mid, midTop, join]);
    expect(j.featureErrors).toEqual({});
    expect(j.parts).toHaveLength(1);
    expect(relativeError(volumeOf(j.parts[0].id), 32000 + 10 * 20 * 10)).toBeLessThan(1e-6);
    // The reviewer's case: a 90 × 20 rectangle on Top to a 70 × 10 one at z 10 cuts both boxes.
    const s1 = sketchFeature(TOP, rectSketch(0, 10, 90, 20));
    const s2 = sketchFeature(at(10), rectSketch(10, 15, 70, 10));
    const r2 = build([a, b, s1, s2, newLoft([s1.id, s2.id], { operation: "remove" })]);
    expect(r2.featureErrors).toEqual({});
    for (const p of r2.parts) expect(volumeOf(p.id)).toBeLessThan(16000 - 1);
  });
});

describe("shapes it can't loft between", () => {
  it("refuses two shapes on the same plane", () => {
    const big = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const small = sketchFeature(TOP, rectSketch(-5, -5, 10, 10));
    // A plain loft and one with further choices both say so.
    const plain = { ...feature("loft", {}), sections: [big.id, small.id] };
    expect(build([big, small, plain]).featureErrors[plain.id]).toMatch(/same plane/);
    const more = loftOf([big.id, small.id], { start: { kind: "normal" } });
    expect(build([big, small, more]).featureErrors[more.id]).toMatch(/same plane/);
    // On parallel planes it's fine.
    const up = sketchFeature(at(10), rectSketch(-5, -5, 10, 10));
    expect(build([big, up, { ...plain, sections: [big.id, up.id] }]).featureErrors).toEqual({});
    // Only some of them on one plane (a step at the top, as older files may have) still builds, as it always did.
    const step = sketchFeature(at(10), rectSketch(-2, -2, 4, 4));
    expect(build([big, up, step, { ...plain, sections: [big.id, up.id, step.id] }]).featureErrors).toEqual({});
  });

  it("refuses straight sides with a shaped end", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(20), rectSketch(-5, -5, 10, 10));
    const lo = loftOf([base.id, top.id], { start: { kind: "normal" } }, { loftRuled: true });
    expect(build([base, top, lo]).featureErrors[lo.id]).toMatch(/Straight between shapes/);
  });
});

describe("end conditions between slanted shapes", () => {
  it("leaves a square square to it when the circle is on a slanted plane", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const c = Math.SQRT1_2;
    for (const n of [
      [c, 0, c],
      [-c, 0, c],
    ] as [number, number, number][]) {
      const v: [number, number, number] = [-n[2], 0, n[0]];
      const plane: SketchPlane = { kind: "face", origin: [30, 0, 30], u: [0, 1, 0], v, label: "slanted" };
      const top = sketchFeature(plane, addCircle(emptySketch(), { x: 0, y: 0 }, 6).sketch);
      const ctx = sketchContext([base, top]);
      for (const loft of [{ start: { kind: "normal" } }, { end: { kind: "normal" } }, { start: { kind: "normal" }, end: { kind: "normal" } }] as LoftDef[]) {
        const shape = buildLoft({ sections: [base.id, top.id], loft }, ctx);
        expect(sound(shape)).toBe(true);
        expect(measureVolume(shape)).toBeGreaterThan(3000);
        shape.delete();
      }
    }
    // Square to the square at its start: its sides upright there.
    const plane: SketchPlane = { kind: "face", origin: [30, 0, 30], u: [0, 1, 0], v: [-c, 0, c], label: "slanted" };
    const top = sketchFeature(plane, addCircle(emptySketch(), { x: 0, y: 0 }, 6).sketch);
    const shape = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "normal" } } }, sketchContext([base, top]));
    expect(slopeAt(shape, 0).most).toBeLessThan(0.01);
    shape.delete();
  });
});

describe("curve features as the guide or path", () => {
  it("follows a fit spline and a helix-free curve as the path", () => {
    const base = sketchFeature(TOP, addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    const endPlane = planeOnFace([1, 0, 0], [20, 0, 20], "end");
    const top = sketchFeature(endPlane, addCircle(emptySketch(), { x: 0, y: 20 }, 2).sketch);
    // A quarter circle from (0,0,0) up and over to (20,0,20), as a fit spline through points on it.
    const pts: [number, number, number][] = Array.from({ length: 9 }, (_, i) => {
      const t = (i / 8) * (Math.PI / 2);
      return [20 - 20 * Math.cos(t), 0, 20 * Math.sin(t)];
    });
    const curve: Feature = { ...feature("curve", {}), curve: { kind: "fitSpline", points: pts.map((p) => ({ p })) } as CurveDef };
    const lo = loftOf([base.id, top.id], { path: { curve: curve.id } });
    const r = build([base, top, curve, lo]);
    expect(r.featureErrors).toEqual({});
    expect(relativeError(volumeOf(r.parts[0].id), (Math.PI * Math.PI * 10 * (9 + 6 + 4)) / 3)).toBeLessThan(0.02);
    // Drawn from the far end: walked from the end nearest the first shape all the same.
    const back: Feature = { ...curve, curve: { kind: "fitSpline", points: [...pts].reverse().map((p) => ({ p })) } as CurveDef };
    const rb = build([base, top, back, lo]);
    expect(rb.featureErrors).toEqual({});
    expect(relativeError(volumeOf(rb.parts[0].id), volumeOf(r.parts[0].id))).toBeLessThan(0.01);
    // A curve later in the list, or suppressed, is said plainly.
    expect(build([base, top, lo, curve]).featureErrors[lo.id]).toMatch(/comes after this/);
    expect(build([base, top, { ...curve, suppressed: true }, lo]).featureErrors[lo.id]).toMatch(/suppressed/);
  });

  it("bulges out to a fit spline guide", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const curve: Feature = { ...feature("curve", {}), curve: { kind: "fitSpline", points: [{ p: [10, 0, 0] }, { p: [15, 0, 15] }, { p: [10, 0, 30] }] } as CurveDef };
    const lo = loftOf([base.id, top.id], { guide: { curve: curve.id } });
    const r = build([base, top, curve, lo]);
    expect(r.featureErrors).toEqual({});
    expect(volumeOf(r.parts[0].id)).toBeGreaterThan(20 * 20 * 30 * 1.05);
  });
});

describe("curved faces and part edges as sections", () => {
  it("lofts from a curved face's outline", () => {
    // A half cylinder lying along Y (its round top a curved face with one outline), lofted up to a rectangle.
    const l = addLine(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 });
    const line = l.sketch.curves.find((c) => c.id === l.lineId) as SketchLine;
    const half = sketchFeature({ kind: "default", name: "Front" }, addArc(l.sketch, { x: 10, y: 0, snap: { kind: "point", id: line.p2 } } as never, { x: -10, y: 0, snap: { kind: "point", id: line.p1 } } as never, { x: 0, y: 10 }).sketch);
    const ex = extrudeFeature(half.id, 20, { flip: true });
    const top = sketchFeature(at(30), rectSketch(-5, 0, 10, 20));
    const r0 = build([half, ex]);
    expect(r0.featureErrors).toEqual({});
    const part = r0.parts[0];
    const round = part.faceRefs!.find((f) => f.surface !== "PLANE")!;
    expect(round).toBeTruthy();
    const profiles = [{ face: { partId: part.id, ref: round } }, { sketch: top.id }];
    // A new part (its end the face itself), sound; its end can't be shaped (no plane): said, not refused.
    const lo = loftOf([top.id], { profiles, start: { kind: "normal" } });
    const r = build([half, ex, top, lo]);
    expect(r.featureErrors).toEqual({});
    expect(r.featureWarnings?.[lo.id] ?? r.featureNotes?.[lo.id] ?? "").toMatch(/isn't flat/);
    expect(r.parts).toHaveLength(2);
    const made = shapeOf(lo.id)!;
    expect(sound(made)).toBe(true);
    expect(measureVolume(made)).toBeGreaterThan(20 * 10 * 20);
    // A surface through the face's outline.
    const skin = loftOf([top.id], { profiles }, { surface: true });
    const rs = build([half, ex, top, skin]);
    expect(rs.featureErrors).toEqual({});
    expect(rs.parts.some((p) => p.surface)).toBe(true);
    // Joining it to the part along that face isn't possible yet: said plainly.
    const add = loftOf([top.id], { profiles }, { operation: "add" });
    expect(build([half, ex, top, add]).featureErrors[add.id]).toMatch(/only be a new part/);
  });

  it("lofts a surface (and a solid) from a box's top edges", () => {
    const b = box(-10, -10, 0, 20, 20, 10);
    const r0 = build([b]);
    const part = r0.parts[0];
    const topEdges = part.edgeRefs!.filter((e) => e.kind === "edge" && e.a[2] === 10 && e.b[2] === 10).map((ref) => ({ partId: part.id, ref }));
    expect(topEdges).toHaveLength(4);
    const disc = sketchFeature(at(30), addCircle(emptySketch(), { x: 0, y: 0 }, 8).sketch);
    const skin = loftOf([disc.id], { profiles: [{ edges: topEdges }, { sketch: disc.id }] }, { surface: true });
    const rs = build([b, disc, skin]);
    expect(rs.featureErrors).toEqual({});
    expect(rs.parts.some((p) => p.surface)).toBe(true);
    const solid = loftOf([disc.id], { profiles: [{ edges: topEdges }, { sketch: disc.id }] }, { operation: "add" });
    const rsol = build([b, disc, solid]);
    expect(rsol.featureErrors).toEqual({});
    expect(volumeOf(rsol.parts[0].id)).toBeGreaterThan(4000 + 20 * Math.PI * 64);
    // Open edges make only a surface.
    const open = loftOf([disc.id], { profiles: [{ edges: topEdges.slice(0, 3) }, { sketch: disc.id }] });
    expect(build([b, disc, open]).featureErrors[open.id]).toMatch(/all the way round/);
  });
});


describe("more end conditions", () => {
  it("flares along the shape's own plane", () => {
    const base = sketchFeature(TOP, addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch);
    const top = sketchFeature(at(20), addCircle(emptySketch(), { x: 0, y: 0 }, 15).sketch);
    const ctx = sketchContext([base, top]);
    const flared = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "profileTangent" } } }, ctx);
    expect(sound(flared)).toBe(true);
    // Lying nearly flat at its start (a plain loft leans at about 45° there).
    expect(slopeAt(flared, 0).least).toBeGreaterThan(0.8);
    const plain = buildLoft({ sections: [base.id, top.id], loft: { profiles: [{ sketch: base.id }, { sketch: top.id }] } }, ctx);
    expect(slopeAt(plain, 0).most).toBeLessThan(0.8);
    [flared, plain].forEach((s) => s.delete());
  });

  it("leaves along a picked direction", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const ctx = sketchContext([base, top]);
    const lean: [number, number, number] = [1, 0, 1];
    const shape = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "direction", towards: { p: [0, 0, 0], dir: lean } } } }, ctx);
    expect(sound(shape)).toBe(true);
    // It leans out towards +x near the start, so it reaches past the squares there.
    const [lo, hi] = shape.boundingBox.bounds;
    expect(hi[0]).toBeGreaterThan(10.2);
    expect(lo[0]).toBeGreaterThan(-10.01);
    shape.delete();
    // Along the shape's own plane: refused plainly.
    expect(() => buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "direction", towards: { p: [0, 0, 0], axis: "x" } } } }, ctx)).toThrow(/own plane/);
    // Along Z, as square to it.
    const up = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "direction", towards: { p: [0, 0, 0], axis: "z" } } } }, ctx);
    expect(relativeError(measureVolume(up), 12000)).toBeLessThan(1e-3);
    up.delete();
  });
});

describe("thin loft", () => {
  it("makes a hollow wall with exact volumes", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const thinLoft = (thin: Feature["thin"], params: Record<string, string>): Feature => ({ ...feature("loft", {}), sections: [base.id, top.id], thin, params });
    // 2 mm in: 20² − 16² over 30.
    const a = thinLoft({}, { thickness: "2" });
    const r = build([base, top, a]);
    expect(r.featureErrors).toEqual({});
    expect(relativeError(volumeOf(r.parts[0].id), (400 - 256) * 30)).toBeLessThan(1e-6);
    // Centred: 22² − 18²; both sides: 1 in and 2 out (24² − 18²); flipped: 2 out (24² − 20²).
    const c = build([base, top, thinLoft({ midPlane: true }, { thickness: "2" })]);
    expect(relativeError(volumeOf(c.parts[0].id), (484 - 324) * 30)).toBeLessThan(1e-6);
    const two = build([base, top, thinLoft({}, { thickness: "1", thickness2: "2" })]);
    expect(relativeError(volumeOf(two.parts[0].id), (576 - 324) * 30)).toBeLessThan(1e-6);
    const flip = build([base, top, thinLoft({ flip: true }, { thickness: "2" })]);
    expect(relativeError(volumeOf(flip.parts[0].id), (576 - 400) * 30)).toBeLessThan(1e-6);
    // A square to a circle: the outer loft less the inner one.
    const disc = sketchFeature(at(30), addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const sc = build([base, disc, { ...a, sections: [base.id, disc.id] }]);
    expect(sc.featureErrors).toEqual({});
    const outer = buildLoft({ sections: [base.id, disc.id] }, sketchContext([base, disc]));
    const inner = sketchFeature(TOP, rectSketch(-8, -8, 16, 16));
    const innerTop = sketchFeature(at(30), addCircle(emptySketch(), { x: 0, y: 0 }, 8).sketch);
    const hole = buildLoft({ sections: [inner.id, innerTop.id], loft: { profiles: [{ sketch: inner.id }, { sketch: innerTop.id }] } }, sketchContext([inner, innerTop]));
    expect(relativeError(volumeOf(sc.parts[0].id), measureVolume(outer) - measureVolume(hole))).toBeLessThan(1e-3);
    [outer, hole].forEach((s) => s.delete());
    // Too thick, a point or a guide: refused plainly.
    const thick = thinLoft({}, { thickness: "11" });
    expect(build([base, top, thick]).featureErrors[thick.id]).toMatch(/thick/i);
    const pointy = { ...thinLoft({}, { thickness: "2" }), loft: { profiles: [{ sketch: base.id }, { point: { p: [0, 0, 30] } }] } } as Feature;
    expect(build([base, top, pointy]).featureErrors[pointy.id]).toMatch(/point/);
  });
});
