/**
 * Engine tests, part 3: importing files, Part Studios, assemblies and drawings (the big STL import is in engineStl.test.ts).
 * Runs the real OpenCascade engine (in Node) against reference models and
 * checks volumes, positions and soundness. Shared set-up: tests/support/engineHelpers.ts.
 */
import { DEFAULT_CLASH_OPTIONS, judgeContacts } from "../src/assembly/assemblyCheck";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { readBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, relativeError, rectSketch, importFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("importing STEP and STL files", () => {
  it("brings back a STEP file as the same solid, one part per solid", async () => {
    const a = feature("box", { width: 40, depth: 30, height: 20 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 100 });
    build([a, b]);
    const step = new TextDecoder().decode((await engine.exportStep([])).step);
    engine.dispose();

    const imp = importFeature({ fileName: "two.step", format: "step", data: step, units: "mm" });
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([imp.id, `${imp.id}~2`]);
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(24000, 0);
    expect(analyzeMesh(r.parts[1].vertices, r.parts[1].triangles).volume).toBeCloseTo(1000, 0);
    expect(r.parts[0].faceGroups).toHaveLength(6);

    // Rebuilding again uses the remembered copy and gives the same result.
    const again = engine.rebuild([imp]);
    expect(again.parts).toHaveLength(2);
  });

  it("brings in an STL as a closed solid that can be cut from another part", () => {
    build([feature("box", { width: 20, depth: 20, height: 20 })]);
    const stl = new Uint8Array(engine.exportStl([], "normal").stl);
    engine.dispose();
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const file = { fileName: "cube.stl", format: "stl" as const, data: btoa(b64), units: "mm" as const };

    const r = build([importFeature(file)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    // Flat triangles are joined back into the cube's 6 faces.
    expect(r.parts[0].faceGroups).toHaveLength(6);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(8000, 0);
    engine.dispose();

    // Cut the cube out of a bigger block.
    const r2 = build([feature("box", { width: 40, depth: 40, height: 10, x: -10, y: -10 }), importFeature(file, "remove")]);
    expect(r2.featureErrors).toEqual({});
    expect(analyzeMesh(r2.parts[0].vertices, r2.parts[0].triangles).volume).toBeCloseTo(16000 - 4000, 0);
    engine.dispose();

    // In inches, 20 units become 508 mm.
    const r3 = build([importFeature({ ...file, units: "in" })]);
    expect(analyzeMesh(r3.parts[0].vertices, r3.parts[0].triangles).volume).toBeCloseTo(8000 * 25.4 ** 3, -3);
  });

  it("brings separate bodies in an STL in as separate parts, and an open mesh as a surface", () => {
    // A 10 mm cube and a ball 30 mm away, in one STL file.
    build([feature("box", { width: 10, depth: 10, height: 10 }), feature("sphere", { diameter: 8, x: 30 })]);
    const stl = new Uint8Array(engine.exportStl([], "normal").stl);
    engine.dispose();
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const file = { fileName: "two.stl", format: "stl" as const, data: btoa(b64), units: "mm" as const };
    const r = build([importFeature(file)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(engine.check("normal").parts.every((p) => p.mesh.watertight && p.geometryValid)).toBe(true);
    engine.dispose();
    // Both cut cleanly out of a block (it used to leave a broken, leaky part).
    const block = feature("box", { width: 50, depth: 20, height: 20, x: -5, y: -5, z: -5 });
    const cut = build([block, importFeature(file, "remove")]);
    expect(cut.featureErrors).toEqual({});
    const c = engine.check("normal").parts[0];
    expect(c.mesh.watertight).toBe(true);
    expect(c.exactVolume!).toBeLessThan(20000 - 1000 - 200);
    engine.dispose();
    // A single triangle: an open mesh, so a surface rather than a solid with no inside.
    const tri = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n";
    const open = build([importFeature({ fileName: "tri.stl", format: "stl", data: btoa(tri), units: "mm" })]);
    expect(open.featureErrors).toEqual({});
    expect(open.parts.map((p) => [p.name, !!p.surface])).toEqual([["Surface 1", true]]);
  });

  it("reads text STL files, and finely curved ones in reasonable time", () => {
    const P = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    const tris = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
    const text = `solid tet\n${tris.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${P[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid tet\n`;
    let r = build([importFeature({ fileName: "tet.stl", format: "stl", data: btoa(text), units: "mm" })]);
    expect(r.featureErrors).toEqual({});
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(1000 / 6, 1);
    engine.dispose();

    build([feature("sphere", { diameter: 40 })]);
    const stl = new Uint8Array(engine.exportStl([], "coarse").stl);
    engine.dispose();
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const started = performance.now();
    r = build([importFeature({ fileName: "ball.stl", format: "stl", data: btoa(b64), units: "mm" })]);
    const ms = performance.now() - started;
    expect(r.featureErrors).toEqual({});
    // Very generous: shared CI machines vary a lot in speed (it takes well under a second here).
    expect(ms).toBeLessThan(30_000);
    expect(relativeError(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume, (4 / 3) * Math.PI * 8000)).toBeLessThan(0.05);
  });

  it("explains a damaged file", () => {
    const r = build([importFeature({ fileName: "bad.step", format: "step", data: "ISO-10303-21;\nnonsense", units: "mm" })]);
    expect(Object.values(r.featureErrors)[0]).toMatch(/STEP file/);
    expect(r.parts).toHaveLength(0);
  });
});

describe("part names", () => {
  it("uses names given to parts, in the parts and in STEP files", async () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    engine = new GeometryEngine();
    const r = engine.rebuild([box], {}, { [box.id]: "Bracket" });
    expect(r.parts[0].name).toBe("Bracket");
    const step = new TextDecoder().decode((await engine.exportStep([])).step);
    expect(step).toContain("PRODUCT('Bracket'");
  });
});

describe("several Part Studios", () => {
  it("builds each, and rebuilds only the ones that changed", () => {
    engine = new GeometryEngine();
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("cylinder", { diameter: 10, height: 5 });
    const first = engine.rebuildStudios([
      { id: "main", features: [a] },
      { id: "s2", features: [b] },
    ]);
    expect(first.rebuilt).toEqual(["main", "s2"]);
    expect(first.parts.map((p) => [p.studioId, p.name])).toEqual([
      ["main", "Part 1"],
      ["s2", "Part 1"],
    ]);
    const same = engine.rebuildStudios([
      { id: "main", features: [a] },
      { id: "s2", features: [b] },
    ]);
    expect(same.rebuilt).toEqual([]);
    expect(same.parts).toEqual([]);
    const b2 = { ...b, params: { ...b.params, height: "8" } };
    const changed = engine.rebuildStudios([
      { id: "main", features: [a] },
      { id: "s2", features: [b2] },
    ]);
    expect(changed.rebuilt).toEqual(["s2"]);
    // Checks and exports still see every part.
    expect(engine.check("coarse").parts).toHaveLength(2);
    expect(engine.check("coarse", [b2.id]).parts.map((p) => p.partId)).toEqual([b2.id]);
    // A removed Part Studio's parts go.
    engine.rebuildStudios([{ id: "main", features: [a] }]);
    expect(engine.partCount).toBe(1);
  });

  it("brings a part in from another Part Studio (Derived), and follows changes to it", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    // The studio using the part comes first in the list: it's still built after the one it uses.
    const derived: Feature = { ...feature("derived", { x: 0, y: 0, z: 20 }), derived: { studioId: "s2", partId: box.id } };
    const hole = feature("cylinder", { diameter: 4, height: 40, x: 5, y: 5, z: 0 }, "remove");
    const zs = (m: { vertices: Float32Array | number[] }) => Array.from(m.vertices).filter((_, k) => k % 3 === 2);
    const r = engine.rebuildStudios([
      { id: "main", features: [derived, hole] },
      { id: "s2", features: [box] },
    ]);
    expect(r.featureErrors).toEqual({});
    const mine = r.parts.find((p) => p.studioId === "main")!;
    expect(mine.name).toBe("Part 1");
    expect(Math.min(...zs(mine))).toBeCloseTo(20, 4);
    // Cut in its new home; the original is untouched.
    expect(analyzeMesh(mine.vertices, mine.triangles).volume).toBeCloseTo(1000 - Math.PI * 4 * 10, 0);
    // The original gets taller: the derived part follows.
    const taller = { ...box, params: { ...box.params, height: "15" } };
    const r2 = engine.rebuildStudios([
      { id: "main", features: [derived, hole] },
      { id: "s2", features: [taller] },
    ]);
    expect(r2.rebuilt.sort()).toEqual(["main", "s2"]);
    const mine2 = r2.parts.find((p) => p.studioId === "main")!;
    expect(Math.max(...zs(mine2))).toBeCloseTo(35, 4);
    // Gone, or using each other: said plainly.
    const lost: Feature = { ...derived, derived: { studioId: "s2", partId: "nope" } };
    expect(engine.rebuildStudios([{ id: "main", features: [lost] }, { id: "s2", features: [taller] }]).featureErrors[lost.id]).toMatch(/isn't in its Part Studio/);
    const back: Feature = { ...feature("derived", {}), derived: { studioId: "main", partId: derived.id } };
    const loop = engine.rebuildStudios([{ id: "main", features: [derived] }, { id: "s2", features: [taller, back] }]);
    expect(Object.values(loop.featureErrors).join(" ")).toMatch(/uses parts from this one/);
    // The same on a fresh start (a file just opened), not "deleted".
    engine.dispose();
    engine = new GeometryEngine();
    const fresh = engine.rebuildStudios([{ id: "main", features: [derived] }, { id: "s2", features: [taller, back] }]);
    expect(Object.values(fresh.featureErrors).join(" ")).toMatch(/uses parts from this one/);
    expect(Object.values(fresh.featureErrors).join(" ")).not.toMatch(/deleted/);
  });
});

describe("assembly exports and clashes", () => {
  it("places copies for export, and finds where they overlap", async () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    engine.rebuild([box]);
    const turn90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const instances = [
      { id: "i1", partId: box.id, name: "Box <1>", position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] },
      // Turned a quarter about Z (now spans x −10…0) and moved 5 along X: overlaps the first by half.
      { id: "i2", partId: box.id, name: "Box <2>", position: [15, 0, 0] as [number, number, number], rotation: turn90z },
      { id: "i3", partId: box.id, name: "Box <3>", position: [100, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] },
    ];
    const clashes = judgeContacts(engine.clashes(instances), DEFAULT_CLASH_OPTIONS) as { a: string; b: string; volume: number }[];
    expect(clashes).toHaveLength(1);
    expect(clashes[0].a).toBe("Box <1>");
    expect(clashes[0].b).toBe("Box <2>");
    expect(clashes[0].volume).toBeCloseTo(500, 3);

    const stl = engine.exportStl([], "coarse", instances);
    const { vertices } = readBinaryStl(stl.stl);
    const xs = Array.from(vertices).filter((_, k) => k % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(110, 3);
    const step = new TextDecoder().decode((await engine.exportStep([], {}, instances)).step);
    expect(step).toContain("PRODUCT('Box <3>'");
    // The part itself hasn't moved.
    expect(engine.check("coarse").parts).toHaveLength(1);
  });

  it("shows mirrored copies as the part's mirror image", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    engine.rebuild([box]);
    const id: [number, number, number, number] = [0, 0, 0, 1];
    // Mirrored, the box spans x −10…0 instead of 0…10: next to the original, not on it.
    const mirrored = [
      { id: "i1", partId: box.id, name: "Box <1>", position: [0, 0, 0] as [number, number, number], rotation: id },
      { id: "i2", partId: box.id, name: "Box <2>", position: [0, 0, 0] as [number, number, number], rotation: id, mirrored: true },
    ];
    // Side by side, touching: not a clash.
    expect(judgeContacts(engine.clashes(mirrored), DEFAULT_CLASH_OPTIONS)).toHaveLength(0);
    const { vertices } = readBinaryStl(engine.exportStl([], "coarse", mirrored).stl);
    const xs = Array.from(vertices).filter((_, k) => k % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-10, 3);
  });
});

describe("drawing views", () => {
  it("projects a part from each side, with hidden lines", () => {
    engine = new GeometryEngine();
    // A 40 × 30 × 20 block with a 10 mm blind hole from the top, at x = 10, y = 15.
    const block = feature("box", { width: 40, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 15, x: 10, y: 15, z: 10 }, "remove");
    engine.rebuild([block, hole]);
    const [front, top, right, iso] = engine.project([], undefined, ["front", "top", "right", "iso"], true);
    const near = (b: number[] | null, want: number[]) => b!.forEach((v, i) => expect(v).toBeCloseTo(want[i], 3));
    near(front.bounds, [0, 0, 40, 20]);
    near(top.bounds, [0, 0, 40, 30]);
    near(right.bounds, [0, 0, 30, 20]);
    expect(iso.bounds).not.toBeNull();
    // Seen from the top, the hole is a visible circle on the left.
    const c = top.circles.find((x) => !x.hidden && x.full);
    expect(c).toBeDefined();
    expect([c!.cx, c!.cy, c!.r].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 15, 5]);
    // From the front it's hidden inside: dashed lines between x = 5 and 15, from z = 10 up.
    expect(front.hidden.length).toBeGreaterThan(0);
    const hx = front.hidden.flatMap((l) => l.filter((_, i) => i % 2 === 0));
    expect(Math.min(...hx)).toBeCloseTo(5, 3);
    expect(Math.max(...hx)).toBeCloseTo(15, 3);
    const hy = front.hidden.flatMap((l) => l.filter((_, i) => i % 2 === 1));
    expect(Math.min(...hy)).toBeCloseTo(10, 3);
    // Without hidden lines there are none.
    expect(engine.project([], undefined, ["front"], false)[0].hidden).toEqual([]);
    // The hole's centre line shows from the front (it's upright), not from the top.
    expect(front.axes).toHaveLength(1);
    const [x0, y0, x1, y1] = front.axes![0];
    expect([x0, x1].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10]);
    expect([Math.min(y0, y1), Math.max(y0, y1)].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 20]);
    expect(top.axes).toBeUndefined();
  });

  it("cuts section views through the part along lines drawn on other views", () => {
    const block = feature("box", { width: 40, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 15, x: 10, y: 15, z: 10 }, "remove");
    engine.rebuild([block, hole]);
    const area = (t: number[]) => {
      let sum = 0;
      for (let i = 0; i < t.length; i += 6) sum += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
      return sum;
    };
    const near = (b: number[] | null, want: number[]) => b!.forEach((v, i) => expect(v).toBeCloseTo(want[i], 3));
    // A: across the top view, through the middle (y = 15) — seen like the front view.
    // B: up and down the front view at x = 10 (through the hole's axis) — seen like the right view.
    // C: like A but near the back (y = 27), missing the hole.
    const [top, a, b, c] = engine.project([], undefined, ["top"], true, [
      { key: "section:A", host: "top", a: [0, 0.5], b: [1, 0.5], flip: false },
      { key: "section:B", host: "front", a: [0.25, 0], b: [0.25, 1], flip: false },
      { key: "section:C", host: "top", a: [0, 0.9], b: [1, 0.9], flip: false },
    ]);
    expect([top.kind, a.kind, b.kind, c.kind]).toEqual(["top", "section:A", "section:B", "section:C"]);
    expect(a.hidden).toEqual([]);
    near(a.bounds, [0, 0, 40, 20]);
    // The cut face is the 40 × 20 block less the 10 × 10 slice through the hole.
    expect(area(a.cutFaces!)).toBeCloseTo(700, 1);
    // The cut-open hole still has its centre line.
    expect(a.axes?.length).toBe(1);
    near(b.bounds, [0, 0, 30, 20]);
    expect(area(b.cutFaces!)).toBeCloseTo(600 - 100, 1);
    expect(area(c.cutFaces!)).toBeCloseTo(800, 1);
  });

  it("cuts a broken-out view away to a depth inside a rectangle, hatching the floor of the cut", () => {
    engine.rebuild([feature("box", { width: 40, depth: 30, height: 20 })]);
    // On the front view (40 × 20), the middle half each way, 10 mm deep (the block is 30 deep).
    const [plain] = engine.project([], undefined, ["front"], true);
    expect(plain.depth).toBeCloseTo(30, 6);
    const [cut] = engine.project([], undefined, ["front"], true, [], [{ host: "front", a: [0.25, 0.25], b: [0.75, 0.75], depth: 10 }]);
    expect(cut.bounds).toEqual(plain.bounds);
    expect(cut.breakLines).toHaveLength(1);
    const area = (t: number[]) => {
      let sum = 0;
      for (let i = 0; i < t.length; i += 6) sum += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
      return sum;
    };
    // The floor of the pocket: 20 × 10.
    expect(area(cut.cutFaces!)).toBeCloseTo(200, 1);
    // The pocket's walls show as more lines.
    expect(cut.visible.length).toBeGreaterThan(plain.visible.length);
  });

  it("can leave out tangent edges, where faces meet smoothly", () => {
    // A slot: a 40 × 20 × 10 block with a round end (a Ø20 cylinder centred on its right end).
    const box = feature("box", { width: 40, depth: 20, height: 10 });
    const end = feature("cylinder", { diameter: 20, height: 10, x: 40, y: 10, z: 0 }, "add");
    engine = new GeometryEngine();
    expect(engine.rebuild([box, end]).parts).toHaveLength(1);
    // From the front, where the flat side meets the round end (x = 40) is a tangent edge: an upright line.
    const upright = (p: { visible: number[][] }) => p.visible.filter((l) => l.length === 4 && Math.abs(l[0] - 40) < 1e-6 && Math.abs(l[2] - 40) < 1e-6).length;
    const [withTangents] = engine.project([], undefined, ["front"], true);
    const [without] = engine.project([], undefined, ["front"], true, [], [], false);
    expect(upright(withTangents)).toBeGreaterThan(0);
    expect(upright(without)).toBe(0);
    // The outline stays the same.
    expect(without.bounds).toEqual(withTangents.bounds);
    expect(without.bounds![2]).toBeCloseTo(50, 6);
  });

  it("draws auxiliary views square-on to a sloping line, without cutting", () => {
    engine.rebuild([feature("box", { width: 40, depth: 30, height: 20 })]);
    // Corner to corner across the front view (40 × 20): the view looks square-on to that diagonal.
    const [aux] = engine.project([], undefined, [], true, [{ key: "section:A", host: "front", a: [0, 0], b: [1, 1], flip: false, aux: true }]);
    expect(aux.kind).toBe("section:A");
    expect(aux.cutFaces).toBeUndefined();
    const [x0, y0, x1, y1] = aux.bounds!;
    // Across: the block's 30 mm depth. Up: the block's outline along the diagonal, 40·cos + 20·sin.
    const t = Math.atan2(20, 40);
    expect(x1 - x0).toBeCloseTo(30, 3);
    expect(y1 - y0).toBeCloseTo(40 * Math.cos(t) + 20 * Math.sin(t), 3);
  });

});

describe("extrude up to a face, and with draft", () => {
  it("extrudes from the sketch up to a parallel face of another part", () => {
    // A 10 mm high slab sits 30 mm up; a 10 × 10 square on Top goes up to its underside (z = 30).
    const slab = feature("box", { width: 40, depth: 40, height: 10, x: -10, y: -10, z: 30 });
    engine = new GeometryEngine();
    const first = engine.rebuild([slab]);
    const p = first.parts[0];
    const under = p.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] < -0.99);
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const ex = { ...extrudeFeature(sk.id, 5), extrude: { end: "upToFace" as const, flip: false, upTo: { partId: p.id, ref: p.faceRefs[under] } } };
    const r = engine.rebuild([slab, sk, ex]);
    expect(r.featureErrors).toEqual({});
    const peg = r.parts.find((x) => x.id === ex.id)!;
    const a = analyzeMesh(peg.vertices, peg.triangles);
    expect(a.volume).toBeCloseTo(10 * 10 * 30, 1);
    expect(a.bounds?.max[2]).toBeCloseTo(30, 3);
    // A side face isn't parallel to the sketch: explained.
    const side = p.faceRefs.findIndex((f) => f.surface === "PLANE" && Math.abs(f.normal[0]) > 0.99);
    const bad = { ...ex, extrude: { ...ex.extrude, upTo: { partId: p.id, ref: p.faceRefs[side] } } };
    expect(engine.rebuild([slab, sk, bad]).featureErrors[ex.id]).toMatch(/parallel/);
  });

  it("tapers the sides with a draft angle", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 20, 20));
    const ex = { ...extrudeFeature(sk.id, 10), params: { depth: "10", draft: "10" } };
    const r = build([sk, ex]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    // Each side moves in by 10·tan 10° ≈ 1.763 mm by the top: a frustum of a square pyramid.
    const t = 10 * Math.tan((10 * Math.PI) / 180);
    const top = 20 - 2 * t;
    const expected = (10 / 3) * (400 + top * top + 20 * top);
    expect(relativeError(a.volume, expected)).toBeLessThan(0.002);
    expect(a.bounds?.min[0]).toBeCloseTo(0, 3);
    expect(build([sk, { ...ex, params: { depth: "10", draft: "60" } }]).featureErrors[ex.id]).toMatch(/less than 45/);
  });
});
