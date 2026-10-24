/**
 * Engine tests, part 2: threads, fasteners, measuring, moving and colouring parts.
 * Runs the real OpenCascade engine (in Node) against reference models and
 * checks volumes, positions and soundness. Shared set-up: tests/support/engineHelpers.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument, parseDocument } from "../src/model/document";
import { analyzeMesh } from "../src/geometry/meshCheck";
import type { TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import type { FastenerKind } from "../src/model/fasteners";
import { loadOpenCascade, feature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("threads", () => {
  const sideOf = (r: ReturnType<typeof build>, partId: string) => ({
    partId,
    ref: r.parts.find((p) => p.id === partId)!.faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!,
  });

  it("doesn't show the seam down a cylinder's side (so clicking there picks the round face)", () => {
    const rod = build([feature("cylinder", { diameter: 8, height: 12, x: 0, y: 0, z: 0 })]);
    const edges = rod.parts[0].edgeRefs;
    // Just the round edges at the top and bottom.
    expect(edges.map((e) => e.curve)).toEqual(["CIRCLE", "CIRCLE"]);
    expect(rod.parts[0].edgeGroups).toHaveLength(2);
    expect(rod.parts[0].lines.length / 3).toBe(rod.parts[0].edgeGroups.reduce((n, g) => n + g.count, 0));
    // A box keeps all twelve.
    expect(build([feature("box", { width: 5, depth: 5, height: 5 })]).parts[0].edgeRefs).toHaveLength(12);
  });

  it("cuts a bolt thread round a rod", () => {
    const rod = feature("cylinder", { diameter: 8, height: 12, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const before = engine.check("normal").parts[0].exactVolume!;
    const thread: Feature = { ...feature("thread", { pitch: 1.25, length: 0 }), picks: [sideOf(first, rod.id)] };
    const r = build([rod, thread]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // The groove takes away roughly its cross-section (½ × 0.88 × 0.77 mm²) times its length round the rod.
    expect(check.exactVolume!).toBeLessThan(before - 20);
    expect(check.exactVolume!).toBeGreaterThan(before - 200);
  });

  it("cuts a nut thread inside a hole, part of the way down", () => {
    const block = feature("box", { width: 20, depth: 20, height: 10 });
    const hole = feature("cylinder", { diameter: 6.75, height: 10, x: 10, y: 10 }, "remove");
    const first = build([block, hole]);
    const before = engine.check("normal").parts[0].exactVolume!;
    const thread: Feature = { ...feature("thread", { pitch: 1.25, length: 6 }), picks: [sideOf(first, block.id)] };
    const r = build([block, hole, thread]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeLessThan(before - 5);
    // The hole only gets bigger, so the outside doesn't change.
    const b = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).bounds!;
    expect(b.max[0]).toBeCloseTo(20, 3);
  });

  it("explains what it needs", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const first = build([box]);
    const flat = { partId: box.id, ref: first.parts[0].faceRefs[0] };
    const thread: Feature = { ...feature("thread", { pitch: 1, length: 0 }), picks: [] };
    expect(build([box, thread]).featureErrors[thread.id]).toMatch(/round face/);
    expect(build([box, { ...thread, picks: [flat] }]).featureErrors[thread.id]).toMatch(/round/);
  });
});

describe("measuring between parts", () => {
  it("measures between faces of two different parts, apart or overlapping", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 25, y: 0, z: 0 });
    const r = build([a, b]);
    const side = (id: string, nx: number) => ({ partId: id, ref: r.parts.find((p) => p.id === id)!.faceRefs.find((f) => f.kind === "face" && f.normal[0] === nx)! });
    const m = engine.measure([side(a.id, 1), side(b.id, -1)]);
    expect(m.items).toHaveLength(2);
    expect(m.distance).toBeCloseTo(15, 6);
    const c = feature("box", { width: 10, depth: 10, height: 10, x: 5, y: 0, z: 0 });
    const r2 = build([a, c]);
    const tops = r2.parts.map((p) => ({ partId: p.id, ref: p.faceRefs.find((f) => f.kind === "face" && f.normal[2] === 1)! }));
    const m2 = engine.measure(tops);
    expect(m2.items).toHaveLength(2);
    expect(m2.distance).toBeCloseTo(0, 6);
  });

  it("measures whole parts: their volumes, the gap, and how much they overlap", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const apart = feature("box", { width: 10, depth: 10, height: 10, x: 25, y: 0, z: 0 });
    const r = build([a, apart]);
    const m = engine.measureParts(r.parts.map((p) => p.id));
    expect(m.items.map((i) => Math.round(i.volume!))).toEqual([1000, 1000]);
    expect(m.distance).toBeCloseTo(15, 6);
    expect(m.overlap).toBe(undefined);
    expect(m.centreDistance!.total).toBeCloseTo(25, 6);
    const over = feature("box", { width: 10, depth: 10, height: 10, x: 5, y: 0, z: 0 });
    const r2 = build([a, over]);
    const m2 = engine.measureParts(r2.parts.map((p) => p.id));
    expect(m2.distance).toBeCloseTo(0, 6);
    expect(m2.overlap).toBeCloseTo(500, 3);
  });
});

describe("delete part", () => {
  it("removes whole parts from that point on", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const rod = feature("cylinder", { diameter: 4, height: 20, x: 30, y: 0, z: 0 });
    expect(build([box, rod]).parts).toHaveLength(2);
    const del: Feature = { ...feature("deletePart", {}), deleteParts: [rod.id] };
    const r = build([box, rod, del]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([box.id]);
    expect(build([box, rod, { ...del, deleteParts: [] }]).featureErrors[del.id]).toMatch(/Click the parts/);
  });
});

describe("coil", () => {
  it("winds round wire into a spring", () => {
    const coil = feature("coil", { diameter: 20, wire: 2, pitch: 5, turns: 3, x: 0, y: 0, z: 0 });
    const r = build([coil]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // Wire volume ≈ π r² × length of the helix (3 turns of √((π·20)² + 5²)).
    const length = 3 * Math.hypot(Math.PI * 20, 5);
    expect(check.exactVolume!).toBeCloseTo(Math.PI * 1 * length, -1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.bounds!.max[0]).toBeCloseTo(11, 0);
    expect(build([{ ...coil, params: { ...coil.params, pitch: "1.5" } }]).featureErrors[coil.id]).toMatch(/pitch/i);
  });
});

describe("fasteners", () => {
  const fastener = (kind: FastenerKind, threaded = false, length = 12): Feature => ({
    ...feature("fastener", { length, x: 0, y: 0, z: 0 }),
    fastener: { kind, size: "M6", threaded },
  });
  const volumeOf = (r: ReturnType<typeof build>) => analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume;
  const hexArea = (flats: number) => (Math.sqrt(3) / 2) * flats * flats;

  it("makes a hex bolt, nut and washer, named for what they are", () => {
    const bolt = build([fastener("bolt")]);
    expect(bolt.featureErrors).toEqual({});
    expect(bolt.parts[0].name).toBe("M6 × 12 hex bolt");
    expect(volumeOf(bolt)).toBeCloseTo(hexArea(10) * 4 + Math.PI * 9 * 12, -1);
    const nut = build([fastener("nut")]);
    expect(nut.parts[0].name).toBe("M6 hex nut");
    expect(volumeOf(nut)).toBeCloseTo((hexArea(10) - Math.PI * 9) * 5.2, -1);
    const washer = build([fastener("washer")]);
    expect(volumeOf(washer)).toBeCloseTo(Math.PI * (36 - 3.2 * 3.2) * 1.6, -1);
  });

  it("makes Allen key, countersunk, pan head and grub screws", () => {
    const cap = build([fastener("socketCap")]);
    expect(cap.featureErrors).toEqual({});
    expect(cap.parts[0].name).toBe("M6 × 12 socket cap screw");
    // Ø10 × 6 head less a 5 mm hex socket 3 deep, on a Ø6 × 12 shank.
    expect(volumeOf(cap)).toBeCloseTo(Math.PI * 25 * 6 - hexArea(5) * 3 + Math.PI * 9 * 12, -1);
    // Countersunk: overall length 12, a 3 mm 90° cone head (Ø12 to Ø6), 4 mm socket 2.2 deep; its top is flush at z = 0.
    const csk = build([fastener("countersunk")]);
    expect(csk.featureErrors).toEqual({});
    expect(volumeOf(csk)).toBeCloseTo((Math.PI * 3 * (9 + 18 + 36)) / 3 + Math.PI * 9 * 9 - hexArea(4) * 2.2, -1);
    const grub = build([fastener("grub", false, 10)]);
    expect(grub.parts[0].name).toBe("M6 × 10 grub screw");
    expect(volumeOf(grub)).toBeCloseTo(Math.PI * 9 * 10 - hexArea(3) * 2.4, -1);
    // Button head: a dome Ø10.5 × 3.3 (about 162 mm³) less its socket, on the shank.
    const button = volumeOf(build([fastener("buttonHead")]));
    expect(button).toBeGreaterThan(Math.PI * 9 * 12 + 100);
    expect(button).toBeLessThan(Math.PI * 9 * 12 + 170);
    // Pan head: Ø12 × 4.6 with a rounded top and a cross recess.
    const pan = build([fastener("panHead")]);
    expect(pan.featureErrors).toEqual({});
    const v = volumeOf(pan);
    expect(v).toBeGreaterThan(Math.PI * 9 * 12 + 350);
    expect(v).toBeLessThan(Math.PI * 9 * 12 + Math.PI * 36 * 4.6);
    // Too short for its head.
    expect(build([fastener("countersunk", false, 3)]).featureErrors).not.toEqual({});
  });

  it("threads screws below the head, and grub screws all along", () => {
    for (const kind of ["socketCap", "grub"] as const) {
      const plain = volumeOf(build([fastener(kind, false, 8)]));
      const threaded = build([fastener(kind, true, 8)]);
      expect(threaded.featureErrors).toEqual({});
      const v = volumeOf(threaded);
      expect(v).toBeLessThan(plain - 10);
      expect(v).toBeGreaterThan(plain - 90);
    }
  }, 120_000);

  it("cuts the thread when asked", () => {
    const plain = volumeOf(build([fastener("bolt", false, 8)]));
    const threaded = build([fastener("bolt", true, 8)]);
    expect(threaded.featureErrors).toEqual({});
    const v = volumeOf(threaded);
    expect(v).toBeLessThan(plain - 10);
    expect(v).toBeGreaterThan(plain - 80);
  }, 60_000);
});

describe("thread symbols on drawings", () => {
  it("marks a bolt's and a nut's thread on their views, and a Thread feature's on a rod", () => {
    // An M6 × 20 bolt at the origin: shank down to z = −20; root diameter 6 − 1.0825 = 4.9175.
    const bolt: Feature = { ...feature("fastener", { length: 20, x: 0, y: 0, z: 0 }), fastener: { kind: "socketCap", size: "M6", threaded: false } };
    build([bolt]);
    const [front, top] = engine.project([], undefined, ["front", "top"], true);
    expect(front.threadMarks).toHaveLength(2);
    const xs = front.threadMarks!.map((m) => Math.abs(m.line[0]));
    xs.forEach((x) => expect(x).toBeCloseTo(4.9175 / 2, 4));
    expect(front.threadMarks!.every((m) => !m.hidden)).toBe(true);
    const ys = front.threadMarks![0].line.filter((_, i) => i % 2 === 1).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-20, 4);
    expect(ys[1]).toBeCloseTo(0, 4);
    // From above: a three-quarter circle at the root diameter.
    expect(top.threadMarks).toHaveLength(1);
    const arc = top.threadMarks![0].line;
    expect(Math.hypot(arc[0], arc[1])).toBeCloseTo(4.9175 / 2, 4);
    // A nut: dashed (inside the part) at the outside diameter, from the side.
    build([{ ...bolt, fastener: { kind: "nut", size: "M6", threaded: false } }]);
    const [nutFront] = engine.project([], undefined, ["front"], true);
    expect(nutFront.threadMarks!.every((m) => m.hidden)).toBe(true);
    expect(Math.abs(nutFront.threadMarks![0].line[0])).toBeCloseTo(3, 4);
    // A Thread feature on a 10 mm rod (pitch 1.5): root 10 − 1.62375.
    const rod = feature("cylinder", { diameter: 10, height: 30, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const side = first.parts[0].faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const thread: Feature = { ...feature("thread", { pitch: 1.5, length: 10 }), picks: [{ partId: rod.id, ref: side }] };
    const r = build([rod, thread]);
    expect(r.featureErrors).toEqual({});
    const [rodFront] = engine.project([], undefined, ["front"], true);
    expect(rodFront.threadMarks).toHaveLength(2);
    expect(Math.abs(rodFront.threadMarks![0].line[0])).toBeCloseTo((10 - 1.62375) / 2, 3);
    // A broken-out cut on the view keeps the thread marks.
    const [cutFront] = engine.project([], undefined, ["front"], true, [], [{ host: "front", a: [0, 0.6], b: [1, 1], depth: 2 }]);
    expect(cutFront.breakLines).toHaveLength(1);
    expect(cutFront.threadMarks).toEqual(rodFront.threadMarks);
  }, 120_000);
});

describe("plane features", () => {
  it("build nothing, but say when they can't be placed", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const plane: Feature = { ...feature("plane", { distance: 30, angle: 0 }), planeDef: { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" } };
    const ok = build([box, plane]);
    expect(ok.featureErrors).toEqual({});
    expect(ok.parts).toHaveLength(1);
    const half: Feature = { ...plane, planeDef: { ...plane.planeDef!, mode: "midplane" } };
    expect(build([box, half]).featureErrors[plane.id]).toMatch(/second/);
  });
});

describe("move, turn and copy parts", () => {
  const transformFeature = (partId: string, t: Partial<NonNullable<Feature["transform"]>>, params: Record<string, number>): Feature => ({
    ...feature("transform", params, "add"),
    transform: { partId, axis: "z", about: "centre", copy: false, ...t },
  });
  const boundsOfPart = (r: ReturnType<typeof build>, i = 0) => analyzeMesh(r.parts[i].vertices, r.parts[i].triangles).bounds!;

  it("moves a part", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const r = build([box, transformFeature(box.id, {}, { dx: 30, dy: -5, dz: 2 })]);
    expect(r.featureErrors).toEqual({});
    expect(boundsOfPart(r).min.map((v) => Math.round(v * 1000) / 1000)).toEqual([30, -5, 2]);
  });

  it("turns a part a quarter turn about its centre", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const r = build([box, transformFeature(box.id, {}, { rz: 90 })]);
    const b = boundsOfPart(r);
    // 10 wide × 20 deep becomes 20 wide × 10 deep, still centred on (5, 10).
    expect(b.max[0] - b.min[0]).toBeCloseTo(20, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(10, 4);
    expect((b.max[0] + b.min[0]) / 2).toBeCloseTo(5, 4);
  });

  it("turns about two axes at once (X first, then Y), and reads old designs that turned about one chosen axis", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    // 90° about X stands the 20 mm depth up (and lays the height along Y); then 90° about Y swings that depth along X and the width along Z.
    const r = build([box, transformFeature(box.id, { about: "origin" }, { rx: 90, ry: 90 })]);
    expect(r.featureErrors).toEqual({});
    const b = boundsOfPart(r);
    expect(b.max[0] - b.min[0]).toBeCloseTo(20, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(5, 4);
    expect(b.max[2] - b.min[2]).toBeCloseTo(10, 4);
    const old = parseDocument({ ...emptyDocument(), features: [box, { ...transformFeature(box.id, { axis: "y" }, {}), params: { angle: "90", dx: "0", dy: "0", dz: "0" } }] })!;
    const t = old.features[1];
    expect([t.params.rx, t.params.ry, t.params.rz, "angle" in t.params]).toEqual(["0", "90", "0", false]);
  });

  it("patterns a moved part from where it is now", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pattern: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [box.id], axis: "x", flip: false } };
    const r = build([box, transformFeature(box.id, {}, { dx: 50, dy: 5 }), pattern]);
    expect(r.featureErrors).toEqual({});
    const b = boundsOfPart(r);
    expect([b.min[0], b.max[0], b.min[1]].map((v) => Math.round(v * 1000) / 1000)).toEqual([50, 100, 5]);
  });

  it("copies a part, keeping the original", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const copy = transformFeature(box.id, { copy: true }, { dx: 20 });
    const r = build([box, copy]);
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(boundsOfPart(r, 0).min[0]).toBeCloseTo(0, 4);
    expect(boundsOfPart(r, 1).min[0]).toBeCloseTo(20, 4);
    // Later features on the copy work as on any part.
    const hole = feature("cylinder", { diameter: 4, height: 10, x: 25, y: 5 }, "remove");
    expect(build([box, copy, hole]).featureErrors).toEqual({});
  });

  it("explains problems in plain words", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const nothing = transformFeature(box.id, {}, {});
    expect(build([box, nothing]).featureErrors[nothing.id]).toMatch(/Nothing to do yet/);
    const gone = transformFeature("nope", {}, { dx: 5 });
    expect(build([box, gone]).featureErrors[gone.id]).toMatch(/no longer exists/);
  });
});

describe("measure", () => {
  const pickNear = (r: ReturnType<typeof build>, kind: "edge" | "face", at: [number, number, number], part = 0): TopoPick => {
    const p = r.parts[part];
    const refs = kind === "edge" ? p.edgeRefs : p.faceRefs;
    const pos = (x: (typeof refs)[number]) => (x.kind === "edge" ? x.mid : x.center);
    const best = [...refs].sort((a, b) => Math.hypot(...pos(a).map((v, i) => v - at[i])) - Math.hypot(...pos(b).map((v, i) => v - at[i])))[0];
    return { partId: p.id, ref: best };
  };

  it("measures an edge's length and a face's area", () => {
    const r = build([feature("box", { width: 40, depth: 30, height: 20 })]);
    const m = engine.measure([pickNear(r, "edge", [20, 0, 20])]);
    expect(m.items[0].label).toBe("Straight edge");
    expect(m.items[0].length).toBeCloseTo(40, 6);
    expect(engine.measure([pickNear(r, "face", [20, 15, 20])]).items[0].area).toBeCloseTo(1200, 4);
  });

  it("measures the gap and angle between two faces", () => {
    const r = build([feature("box", { width: 40, depth: 30, height: 20 })]);
    const m = engine.measure([pickNear(r, "face", [20, 15, 20]), pickNear(r, "face", [20, 15, 0])]);
    expect(m.distance).toBeCloseTo(20, 6);
    expect(m.angle).toBe(0);
    const side = engine.measure([pickNear(r, "face", [20, 15, 20]), pickNear(r, "face", [0, 15, 10])]);
    expect(side.angle).toBe(90);
  });

  it("measures hole sizes and the spacing between holes", () => {
    const block = feature("box", { width: 50, depth: 20, height: 10 });
    const h1 = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const h2 = feature("cylinder", { diameter: 6, height: 10, x: 40, y: 10 }, "remove");
    const r = build([block, h1, h2]);
    const rimAt = (x: number): TopoPick => {
      const p = r.parts[0];
      const rim = p.edgeRefs.find((e) => e.curve === "CIRCLE" && e.mid[2] > 9.99 && Math.abs(e.mid[0] - x) < 4)!;
      return { partId: p.id, ref: rim };
    };
    const m = engine.measure([rimAt(10), rimAt(40)]);
    expect(m.items[0].radius).toBeCloseTo(3, 6);
    expect(m.centreDistance?.total).toBeCloseTo(30, 6);
    expect(m.centreDistance?.dx).toBeCloseTo(30, 6);
    expect(m.centreDistance?.dy).toBeCloseTo(0, 6);
    expect(m.distance).toBeCloseTo(24, 6);
  });
});

describe("part colours in exports", () => {
  it("writes colours into STEP and 3MF files", async () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    build([box]);
    const step = new TextDecoder().decode((await engine.exportStep([], { [box.id]: "#ff8000" })).step);
    // STEP wraps long lines, so join them before looking for the colour.
    const flat = step.replace(/\s+/g, "");
    const colours = [...flat.matchAll(/COLOUR_RGB\('[^']*',([-\d.Ee+]+),([-\d.Ee+]+),([-\d.Ee+]+)\)/g)].map((m) =>
      m.slice(1, 4).map(Number),
    );
    const orange = colours.some(([r, g, b]) => Math.abs(r - 1) < 0.01 && Math.abs(g - 128 / 255) < 0.01 && Math.abs(b) < 0.01);
    expect(orange ? "found" : `colours: ${JSON.stringify(colours)} ${flat.match(/.{0,80}COLOUR.{0,120}/g)?.slice(0, 4).join(" | ")}`).toBe("found");
    const mf = new TextDecoder().decode(engine.export3mf([], "coarse", "T", { [box.id]: "#ff8000" }).data);
    expect(mf).toMatch(/displaycolor="#FF8000"/);
  });
});
