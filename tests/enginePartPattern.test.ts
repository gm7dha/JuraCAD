/**
 * Pattern types (Onshape's Part / Feature / Face) and Composite part, with the
 * real OpenCascade engine: part patterns make new parts (counts, ids, names,
 * volumes, skipped copies); face patterns and face mirrors repeat a boss (added)
 * or a hole (cut) from its faces; a composite part acts as one part (one mesh,
 * its members listed, exported together) and moves as one in an assembly.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readBinaryStl } from "../src/geometry/stl";
import { analyzeMesh } from "../src/geometry/meshCheck";
import type { TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { Feature } from "../src/model/types";
import { loadOpenCascade, feature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const linear = (params: Record<string, number>, pattern: Partial<NonNullable<Feature["pattern"]>>): Feature => ({
  ...feature("linearPattern", params, "add"),
  pattern: { sources: [], axis: "x", flip: false, ...pattern },
});

const volumes = () => Object.fromEntries(engine.check("normal").parts.map((p) => [p.partId, p.exactVolume!]));

/** Faces of a part matching a test, as picks. */
function facePicks(part: PartMesh, test: (f: PartMesh["faceRefs"][number]) => boolean): TopoPick[] {
  return part.faceRefs.filter((f) => f.kind === "face" && test(f)).map((ref) => ({ partId: part.id, ref }));
}

describe("part pattern", () => {
  it("copies whole parts, each copy a new part numbered on", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("cylinder", { diameter: 6, height: 4, x: 0, y: 30 });
    const pat = linear({ count: 3, spacing: 20 }, { of: "part", parts: [a.id, b.id] });
    const r = build([a, b, pat]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([a.id, b.id, pat.id, `${pat.id}~2`, `${pat.id}~3`, `${pat.id}~4`]);
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2", "Part 3", "Part 4", "Part 5", "Part 6"]);
    const v = volumes();
    expect(v[pat.id]).toBeCloseTo(1000, 3);
    expect(v[`${pat.id}~3`]).toBeCloseTo(Math.PI * 9 * 4, 3);
    // The first copy of the box is 20 mm along X.
    const box = r.parts.find((p) => p.id === pat.id)!;
    const xs = Array.from(box.vertices).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(20, 4);
  });

  it("leaves out skipped copies, and later parts are numbered after the copies", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const pat = linear({ count: 4, spacing: 20 }, { of: "part", parts: [a.id], skip: [3] });
    const after = feature("sphere", { diameter: 5, x: 0, y: 50 });
    const r = build([a, pat, after]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(4);
    expect(r.parts.at(-1)!.name).toBe("Part 4");
  });

  it("goes round an axis", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10, x: 20 });
    const pat: Feature = { ...feature("circularPattern", { count: 4, angle: 360 }, "add"), pattern: { sources: [], axis: "z", flip: false, of: "part", parts: [a.id] } };
    const r = build([a, pat]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(4);
  });

  it("says plainly what's missing", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const none = linear({ count: 2, spacing: 20 }, { of: "part", parts: [] });
    expect(build([a, none]).featureErrors[none.id]).toMatch(/Click the parts/);
    const gone = linear({ count: 2, spacing: 20 }, { of: "part", parts: ["nope"] });
    expect(build([a, gone]).featureErrors[gone.id]).toMatch(/no longer exists/);
  });
});

describe("face pattern and face mirror", () => {
  const base = () => feature("box", { width: 60, depth: 20, height: 10 });

  it("repeats a boss from its faces (added onto the part)", () => {
    const plate = base();
    const boss = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10, z: 10 }, "add");
    const r0 = build([plate, boss]);
    const part = r0.parts[0];
    const picks = facePicks(part, (f) => (f.surface === "CYLINDRE") || (f.surface === "PLANE" && Math.abs(f.center[2] - 15) < 1e-6));
    expect(picks).toHaveLength(2);
    const pat: Feature = { ...linear({ count: 3, spacing: 20 }, { of: "face" }), picks };
    const r = build([plate, boss, pat]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(volumes()[plate.id]).toBeCloseTo(12000 + 3 * Math.PI * 9 * 5, 2);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.mesh.pieces).toBe(1);
  });

  it("repeats a hole from its inside face (cut from the part)", () => {
    const plate = base();
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const part = build([plate, hole]).parts[0];
    const picks = facePicks(part, (f) => f.surface === "CYLINDRE");
    const pat: Feature = { ...linear({ count: 3, spacing: 20 }, { of: "face" }), picks };
    const r = build([plate, hole, pat]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[plate.id]).toBeCloseTo(12000 - 3 * Math.PI * 9 * 10, 2);
  });

  it("repeats a pocket (walls and floor)", () => {
    const plate = base();
    const pocket = feature("box", { width: 8, depth: 8, height: 4, x: 6, y: 6, z: 6 }, "remove");
    const part = build([plate, pocket]).parts[0];
    const inPocket = (c: [number, number, number]) => c[0] > 5.9 && c[0] < 14.1 && c[1] > 5.9 && c[1] < 14.1 && c[2] > 5.9 && c[2] < 10 - 1e-6;
    const picks = facePicks(part, (f) => inPocket(f.center as [number, number, number]));
    expect(picks).toHaveLength(5);
    const pat: Feature = { ...linear({ count: 2, spacing: 30 }, { of: "face" }), picks };
    const r = build([plate, pocket, pat]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[plate.id]).toBeCloseTo(12000 - 2 * 256, 2);
  });

  it("mirrors a boss's faces across a plane", () => {
    const plate = feature("box", { width: 40, depth: 20, height: 10, x: -20 });
    const boss = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10, z: 10 }, "add");
    const part = build([plate, boss]).parts[0];
    const picks = facePicks(part, (f) => f.surface === "CYLINDRE" || (f.surface === "PLANE" && Math.abs(f.center[2] - 15) < 1e-6));
    const mirror: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [], plane: { kind: "default", name: "Right" }, of: "face" }, picks };
    const r = build([plate, boss, mirror]);
    expect(r.featureErrors).toEqual({});
    expect(volumes()[plate.id]).toBeCloseTo(8000 + 2 * Math.PI * 9 * 5, 2);
  });

  it("notes copies that change nothing", () => {
    const plate = base();
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const part = build([plate, hole]).parts[0];
    const picks = facePicks(part, (f) => f.surface === "CYLINDRE");
    // Copy 3 is past the end of the plate (60 mm long): it cuts nothing.
    const pat: Feature = { ...linear({ count: 3, spacing: 30 }, { of: "face" }), picks };
    const r = build([plate, hole, pat]);
    expect(r.featureErrors).toEqual({});
    expect(r.featureWarnings?.[pat.id]).toMatch(/Copy 3 doesn't reach/);
  });

  it("refuses a copy that would float off the part, and faces that don't close up", () => {
    const plate = base();
    const boss = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10, z: 10 }, "add");
    const part = build([plate, boss]).parts[0];
    const picks = facePicks(part, (f) => f.surface === "CYLINDRE" || (f.surface === "PLANE" && Math.abs(f.center[2] - 15) < 1e-6));
    const far = { ...linear({ count: 2, spacing: 100 }, { of: "face" }), picks };
    expect(build([plate, boss, far]).featureErrors[far.id]).toMatch(/loose piece/);
    const none = { ...linear({ count: 2, spacing: 20 }, { of: "face" }), picks: [] };
    expect(build([plate, boss, none]).featureErrors[none.id]).toMatch(/Click the faces/);
    // Only the boss's top: it bounds nothing.
    const top = { ...linear({ count: 2, spacing: 20 }, { of: "face" }), picks: picks.filter((p) => p.ref.kind === "face" && p.ref.surface === "PLANE") };
    expect(build([plate, boss, top]).featureErrors[top.id]).toBeTruthy();
  });
});

describe("composite part", () => {
  it("groups parts into one part that keeps them as separate solids", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 20 });
    const c = feature("sphere", { diameter: 4, x: 50 });
    const comp: Feature = { ...feature("composite", {}), compositeParts: [a.id, b.id] };
    const r = build([a, b, c, comp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([c.id, comp.id]);
    const cp = r.parts.find((p) => p.id === comp.id)!;
    expect(cp.name).toBe(comp.name);
    expect(cp.members).toEqual([
      { id: a.id, name: "Part 1" },
      { id: b.id, name: "Part 2" },
    ]);
    for (const id of [a.id, b.id, comp.id]) expect(cp.featureIds.includes(id)).toBe(true);
    expect(cp.volume).toBeCloseTo(2000, 3);
    // Exported together: two closed pieces.
    const stl = readBinaryStl(engine.exportStl([comp.id], "normal").stl);
    const m = analyzeMesh(stl.vertices, Array.from({ length: stl.triangleCount * 3 }, (_, i) => i));
    expect(m.pieces).toBe(2);
    expect(m.watertight).toBe(true);
  });

  it("moves as one in an assembly copy, and exports as STEP", async () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 20 });
    const comp: Feature = { ...feature("composite", {}), compositeParts: [a.id, b.id] };
    build([a, b, comp]);
    const placed = engine.exportStl([], "normal", [{ id: "i1", partId: comp.id, name: "Comp <1>", position: [100, 0, 0], rotation: [0, 0, 0, 1] }]);
    const stl = readBinaryStl(placed.stl);
    const xs = Array.from(stl.vertices).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(100, 3);
    expect(Math.max(...xs)).toBeCloseTo(130, 3);
    const { step } = await engine.exportStep([comp.id]);
    expect(new TextDecoder().decode(step)).toMatch(/MANIFOLD_SOLID_BREP[\s\S]*MANIFOLD_SOLID_BREP/);
  });

  it("is refused with fewer than two parts, or a missing one", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const one: Feature = { ...feature("composite", {}), compositeParts: [a.id] };
    expect(build([a, one]).featureErrors[one.id]).toMatch(/two or more/);
    const gone: Feature = { ...feature("composite", {}), compositeParts: [a.id, "nope"] };
    expect(build([a, gone]).featureErrors[gone.id]).toMatch(/no longer exists/);
  });

  it("can be patterned as a part", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 20 });
    const comp: Feature = { ...feature("composite", {}), compositeParts: [a.id, b.id] };
    const pat = linear({ count: 2, spacing: 0 + 50 }, { of: "part", parts: [comp.id] });
    const r = build([a, b, comp, pat]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(2);
    expect(r.parts[1].members).toHaveLength(2);
    // Copies' member ids never use "/" (assembly keys do).
    expect(r.parts[1].members!.every((m) => !m.id.includes("/") && m.id.includes("#"))).toBe(true);
  });

  it("lists its pieces again once a later feature joins its parts", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 20 });
    const comp: Feature = { ...feature("composite", {}), compositeParts: [a.id, b.id] };
    // An old-style Add goes onto the latest part — the composite — and bridges its two boxes.
    const bridge = feature("box", { width: 30, depth: 4, height: 4, x: 0, y: 3, z: 3 }, "add");
    const r = build([a, b, comp, bridge]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].members).toEqual([{ id: `${comp.id}#piece1`, name: `${comp.name} piece 1` }]);
  });

  it("is cut for laser as one panel per part", () => {
    const a = feature("box", { width: 40, depth: 30, height: 3 });
    const b = feature("box", { width: 20, depth: 20, height: 3, x: 50 });
    const comp: Feature = { ...feature("composite", {}), compositeParts: [a.id, b.id] };
    build([a, b, comp]);
    const outlines = engine.laserOutlines([{ kind: "part", partId: comp.id }]);
    expect(outlines.map((o) => (o.ok ? o.name : o.error))).toEqual(["Part 1", "Part 2"]);
    expect(outlines.every((o) => o.ok && o.wires.length === 1)).toBe(true);
  });
});
