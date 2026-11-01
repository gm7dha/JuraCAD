/**
 * 3D-print check and the slicer 3MF on the real OpenCascade engine: overhang
 * areas, wall thickness measured on the exact shape, narrow holes and pins,
 * and parts turned onto the bed and laid out without overlapping.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { printCheckTransfers } from "../src/kernel/transfers";
import { DEFAULT_PRINT_SETTINGS } from "../src/model/printSettings";
import { printPartReport } from "../src/model/printCheck";
import { addLine } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, rectSketch, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  const r = engine.rebuild(features);
  expect(r.featureErrors).toEqual({});
  return r;
}

const LIMITS = { overhangAngle: 45, minWall: 0.8, minHole: 2, minPin: 2 };

describe("print check", () => {
  it("finds the area under a T's arms as overhang, and none upside down", () => {
    // A 10 mm cube with a 30 × 10 × 5 bar on top: 10 × 10 mm hangs out on each side.
    const r = build([feature("box", { width: 10, depth: 10, height: 10 }), feature("box", { width: 30, depth: 10, height: 5, x: -10, z: 10 }, "add")]);
    expect(r.parts).toHaveLength(1);
    const [up] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS);
    expect(up.overhangArea).toBeCloseTo(200, 6);
    expect(up.bedArea).toBeCloseTo(100, 6);
    expect(up.size[0]).toBeCloseTo(30, 6);
    expect(up.size[2]).toBeCloseTo(15, 6);
    expect(up.marks.overhang.length / 9).toBeGreaterThan(0);
    // Upside down, the bar's top is on the bed and nothing hangs over.
    const [flipped] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, 1] }], LIMITS);
    expect(flipped.overhangArea).toBeCloseTo(0, 6);
    expect(flipped.bedArea).toBeCloseTo(300, 6);
  });

  it("counts a slope steeper than the limit, but not a gentler one", () => {
    // A rod (modelled standing up) printed lying on its round side: down = +X.
    const rod = build([feature("cylinder", { diameter: 20, height: 40 })]);
    const [side] = engine.printCheck([{ partId: rod.parts[0].id, down: [1, 0, 0] }], LIMITS);
    // The lower half of the round side faces down; the part steeper than 45° from upright is a quarter of the
    // circumference (from -45° to +45° round the bottom): ¼ × π × 20 × 40 ≈ 628 mm². The view's mesh has a strip of
    // triangles every ~14° round, so the edge of the area falls on a whole strip: within one strip (≈ 100 mm²) of that.
    expect(side.overhangArea).toBeGreaterThan(528);
    expect(side.overhangArea).toBeLessThan(728);
    // Nothing flat rests on the bed when it lies on its round side.
    expect(side.bedArea).toBeLessThan(1);
    const [lenient] = engine.printCheck([{ partId: rod.parts[0].id, down: [1, 0, 0] }], { ...LIMITS, overhangAngle: 80 });
    expect(lenient.overhangArea).toBeLessThan(side.overhangArea / 2);
  });

  it("measures a thin floor exactly and lights up where it is", () => {
    // 20 × 20 × 10 box hollowed out from the top, leaving a 0.6 mm floor and 1 mm walls.
    const r = build([feature("box", { width: 20, depth: 20, height: 10 }), feature("box", { width: 18, depth: 18, height: 10, x: 1, y: 1, z: 0.6 }, "remove")]);
    const [p] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS);
    expect(p.thinnest!).toBeCloseTo(0.6, 6);
    expect(p.thinnestAt![2] === 0 || Math.abs(p.thinnestAt![2] - 0.6) < 1e-6).toBe(true);
    // Both sides of the floor are thin: about 2 × 18 × 18 = 648 mm² (sampled, so roughly).
    expect(p.thinArea).toBeGreaterThan(560);
    expect(p.thinArea).toBeLessThan(740);
    expect(p.marks.thin.length).toBeGreaterThan(0);
    // With a 0.5 mm minimum it's fine.
    const [ok] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], { ...LIMITS, minWall: 0.5 });
    expect(ok.thinArea).toBe(0);
  });

  it("measures a curved wall on the exact surface, not the triangles", () => {
    // A tube 20 mm across with a 18.8 mm bore: a 0.6 mm wall.
    const r = build([feature("cylinder", { diameter: 20, height: 10 }), feature("cylinder", { diameter: 18.8, height: 10 }, "remove")]);
    const [p] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS);
    expect(Math.abs(p.thinnest! - 0.6)).toBeLessThan(0.005);
    expect(p.thinArea).toBeGreaterThan(0.8 * Math.PI * (20 + 18.8) * 10);
  });

  it("finds a narrow hole and a thin pin, and leaves bigger ones alone", () => {
    const r = build([
      feature("box", { width: 30, depth: 20, height: 5 }),
      feature("cylinder", { diameter: 1.5, height: 5, x: 5, y: 10 }, "remove"),
      feature("cylinder", { diameter: 4, height: 5, x: 12, y: 10 }, "remove"),
      feature("cylinder", { diameter: 1.2, height: 6, x: 20, y: 10, z: 5 }, "add"),
      feature("cylinder", { diameter: 5, height: 6, x: 26, y: 10, z: 5 }, "add"),
    ]);
    const [p] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS);
    expect(p.smallHoles.map((d) => Math.round(d * 1000) / 1000)).toEqual([1.5]);
    expect(p.thinPins.map((d) => Math.round(d * 1000) / 1000)).toEqual([1.2]);
    expect(p.marks.small.length).toBeGreaterThan(0);
  });

  it("doesn't take a rounded edge for a hole or a pin", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const first = build([box]);
    const top = first.parts[0].edgeRefs.findIndex((e) => e.kind === "edge" && Math.abs(e.mid[2] - 10) < 1e-6);
    const fillet: Feature = { ...feature("fillet", { radius: 0.5 }, "add"), picks: [{ partId: first.parts[0].id, ref: first.parts[0].edgeRefs[top] }] };
    const r = build([box, fillet]);
    const [p] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS);
    expect(p.smallHoles).toEqual([]);
    expect(p.thinPins).toEqual([]);
  });
});

/** A closed outline through the points, on the Top plane. */
function polygon(points: [number, number][]): SketchData {
  let s = emptySketch();
  let end = "";
  let first = "";
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    const r = addLine(s, { x: p[0], y: p[1], ...(end ? { snap: { kind: "point" as const, id: end } } : {}) }, { x: q[0], y: q[1], ...(i === points.length - 1 ? { snap: { kind: "point" as const, id: first } } : {}) });
    s = r.sketch;
    if (!first) first = (s.curves[0] as { p1: string }).p1;
    end = r.endId;
  });
  return s;
}

describe("sharp edges and surfaces", () => {
  const prism = (points: [number, number][]) => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, polygon(points));
    const r = build([sk, extrudeFeature(sk.id, 20)]);
    expect(r.parts).toHaveLength(1);
    return engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS)[0];
  };
  const report = (p: ReturnType<typeof prism>) => printPartReport(p, DEFAULT_PRINT_SETTINGS, [256, 256, 256], (v) => `${v} mm`, (v) => `${v} mm²`);

  it("doesn't call the sharp edge of a 45° prism a thin wall", () => {
    const p = prism([[0, 0], [20, 0], [0, 20]]);
    expect(p.thinArea).toBe(0);
    expect(p.sharpEdges).toBe(true);
    expect(p.thinnest!).toBeGreaterThan(0.8);
    expect(report(p).level).toBe("ok");
  });

  it("doesn't call a 14° wedge (a doorstop) thin", () => {
    const p = prism([[0, 0], [40, -5], [40, 5]]);
    expect(p.thinArea).toBe(0);
    expect(p.sharpEdges).toBe(true);
    expect(report(p).level).toBe("ok");
  });

  it("doesn't call a 68° ramp's edge thin", () => {
    const p = prism([[0, 0], [10, 0], [0, 24.75]]);
    expect(p.thinArea).toBe(0);
    expect(report(p).level).toBe("ok");
  });

  it("still finds a thin fin standing on a block", () => {
    // A 0.5 mm fin: its sides are opposite faces, not a sharp edge.
    const r = build([feature("box", { width: 20, depth: 20, height: 5 }), feature("box", { width: 0.5, depth: 20, height: 10, x: 10, z: 5 }, "add")]);
    const [p] = engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS);
    expect(p.thinnest!).toBeCloseTo(0.5, 6);
    expect(p.thinArea).toBeGreaterThan(300);
  });

  it("checks a surface part alongside a solid one, and its reply can be handed over by the worker", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(20, 0, 10, 10));
    const r = build([box, sk, { ...extrudeFeature(sk.id, 5), surface: true }]);
    const surface = r.parts.find((p) => p.surface)!;
    const solid = r.parts.find((p) => !p.surface)!;
    const out = engine.printCheck(
      [
        { partId: surface.id, down: [0, 0, -1] },
        { partId: solid.id, down: [0, 0, -1] },
      ],
      LIMITS,
    );
    expect(out.map((o) => !!o.surface)).toEqual([true, false]);
    const marks = Object.values(out[0].marks);
    expect(new Set(marks.map((m) => m.buffer)).size).toBe(4);
    // As postMessage does: each buffer handed over once (the same one twice is a DataCloneError).
    const copy = structuredClone(out, { transfer: printCheckTransfers(out) as Transferable[] });
    expect(copy[1].marks.bed.length).toBe(9 * (copy[1].marks.bed.length / 9));
    expect(copy[1].bedArea).toBeCloseTo(100, 6);
  });
});

describe("slicer 3MF", () => {
  const parse = (xml: string) => {
    const objects = [...xml.matchAll(/<object id="(\d+)"[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/object>/g)].map((m) => {
      const v = [...m[3].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map((x) => [Number(x[1]), Number(x[2]), Number(x[3])]);
      return { id: m[1], name: m[2], v };
    });
    const items = [...xml.matchAll(/<item objectid="(\d+)" transform="([^"]+)"\/>/g)].map((m) => ({ id: m[1], t: m[2].split(" ").map(Number) }));
    return objects.map((o) => {
      const t = items.find((i) => i.id === o.id)!.t;
      const placed = o.v.map(([x, y, z]) => [x + t[9], y + t[10], z + t[11]]);
      const min = [0, 1, 2].map((k) => Math.min(...placed.map((p) => p[k])));
      const max = [0, 1, 2].map((k) => Math.max(...placed.map((p) => p[k])));
      return { name: o.name, min, max };
    });
  };
  const xmlOf = (data: ArrayBuffer) => {
    const text = new TextDecoder().decode(data);
    return text.slice(text.indexOf("<model"), text.indexOf("</model>") + 8);
  };

  it("turns each part onto its chosen face, stands it on the bed and lays them out apart", () => {
    const tall = feature("box", { width: 10, depth: 20, height: 60 });
    const flat = feature("box", { width: 40, depth: 30, height: 5, x: 100 });
    const r = build([tall, flat]);
    expect(r.parts).toHaveLength(2);
    // The tall one laid on its side (its +X face down), the flat one as modelled.
    const out = engine.exportPrint3mf(
      [
        { partId: r.parts[0].id, down: [1, 0, 0] },
        { partId: r.parts[1].id, down: [0, 0, -1] },
      ],
      [256, 256],
      5,
      "coarse",
      "Test",
      { [r.parts[1].id]: "#2f6fb0" },
    );
    expect(out.layout.tooBig).toEqual([]);
    const xml = xmlOf(out.data);
    expect(xml).toContain('displaycolor="#2F6FB0"');
    const placed = parse(xml);
    expect(placed.map((p) => p.name)).toEqual([r.parts[0].name, r.parts[1].name]);
    for (const p of placed) {
      expect(p.min[2]).toBeCloseTo(0, 6);
      expect(p.min[0]).toBeGreaterThanOrEqual(-1e-6);
      expect(p.min[1]).toBeGreaterThanOrEqual(-1e-6);
      expect(p.max[0]).toBeLessThanOrEqual(256 + 1e-6);
      expect(p.max[1]).toBeLessThanOrEqual(256 + 1e-6);
    }
    // Laid on its side the tall box is 10 mm high; the flat one stays 5 mm high.
    expect(placed[0].max[2]).toBeCloseTo(10, 6);
    expect(placed[1].max[2]).toBeCloseTo(5, 6);
    // Their footprints don't overlap.
    const [a, b] = placed;
    const apart = a.max[0] <= b.min[0] + 1e-6 || b.max[0] <= a.min[0] + 1e-6 || a.max[1] <= b.min[1] + 1e-6 || b.max[1] <= a.min[1] + 1e-6;
    expect(apart).toBe(true);
    // The model itself is unchanged.
    expect(engine.printCheck([{ partId: r.parts[0].id, down: [0, 0, -1] }], LIMITS)[0].size[2]).toBeCloseTo(60, 6);
  });

  it("puts a part too big for the bed beside it and says so", () => {
    const r = build([feature("box", { width: 300, depth: 20, height: 5 })]);
    const out = engine.exportPrint3mf([{ partId: r.parts[0].id, down: [0, 0, -1] }], [256, 256], 5, "coarse", "Big");
    expect(out.layout.tooBig).toEqual([r.parts[0].id]);
    expect(parse(xmlOf(out.data))[0].min[0]).toBeGreaterThan(256);
  });
});
