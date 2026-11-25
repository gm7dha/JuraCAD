import { describe, expect, it } from "vitest";

import { composeTransforms, IDENTITY_3MF, mainModelPath, read3mf, readObj, slicerSkips, zipEntries } from "../src/geometry/meshFiles";
import { fileUnitOf, importScaleFactor } from "../src/model/importScale";
import type { ImportedFile } from "../src/model/types";
import { readStlCorners } from "../src/geometry/stl";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { weldCorners } from "../src/geometry/decimate";
import { meshExtras, meshFileToStl, meshFormatOf } from "../src/model/meshImport";
import { importKind, importName, readImport, IMPORT_ACCEPT } from "../src/model/importFile";
import { parseDocument } from "../src/model/document";
import { bambuProject, cubeObject, modelXml, objCube, prusaProject, threeMf } from "./support/meshFixtures";

const enc = (s: string) => new TextEncoder().encode(s);

/** Volume and box of a corner soup, welded. */
function measure(corners: ArrayLike<number>) {
  const w = weldCorners(Float32Array.from(corners));
  const m = analyzeMesh(w.vertices, w.triangles);
  const xs = Array.from(corners).filter((_, i) => i % 3 === 0);
  const zs = Array.from(corners).filter((_, i) => i % 3 === 2);
  return { volume: m.volume, closed: m.watertight, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

describe("OBJ files", () => {
  it("reads quads as two triangles each, with every v/vt/vn form", () => {
    const soup = readObj(objCube(10));
    expect(soup.corners.length / 9).toBe(12);
    expect(soup.objects).toBe(1);
    const m = measure(soup.corners);
    expect(m.volume).toBeCloseTo(1000, 6);
    expect(m.closed).toBe(true);
  });

  it("reads negative (counted back) corners", () => {
    expect(measure(readObj(objCube(10, { negative: true })).corners).volume).toBeCloseTo(1000, 6);
  });

  it("counts separate objects and fans bigger faces", () => {
    const two = objCube(10) + objCube(5, { negative: true, at: [20, 0, 0] }).replace("o Cube", "o Second");
    const soup = readObj(two);
    expect(soup.objects).toBe(2);
    expect(measure(soup.corners).volume).toBeCloseTo(1125, 6);
    const hex = readObj("v 0 0 0\nv 2 0 0\nv 3 1 0\nv 2 2 0\nv 0 2 0\nv -1 1 0\nf 1 2 3 4 5 6\n");
    expect(hex.corners.length / 9).toBe(4);
  });

  it("joins lines ending in a backslash and ignores other lines", () => {
    const soup = readObj("mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\ns off\nf 1 2 \\\n 3\n");
    expect(soup.corners.length).toBe(9);
  });

  it("explains broken files", () => {
    expect(() => readObj("v 0 0 0\nv 1 0 0\nf 1 2 3\n")).toThrow(/line 3 .*corner that isn't there/);
    expect(() => readObj("v 0 0 0\nv 1 0 0\nv 0 1 0\n")).toThrow(/no faces/);
    expect(() => readObj("hello")).toThrow(/no shapes/);
    expect(() => readObj("v 0 zero 0\n")).toThrow(/line 1/);
  });
});

describe("3MF files", () => {
  it("reads a stored and a deflated zip the same", async () => {
    const model = modelXml(cubeObject(1, 10), `<item objectid="1"/>`);
    for (const deflate of [false, true]) {
      const zip = await threeMf(model, [], deflate);
      if (deflate) expect([...zipEntries(zip).values()].some((e) => e.method === 8)).toBe(true);
      const soup = await read3mf(zip);
      expect(soup.corners.length / 9).toBe(12);
      expect(measure(soup.corners).volume).toBeCloseTo(1000, 4);
    }
  });

  it("turns the model's unit into millimetres", async () => {
    const cases: [string, number][] = [["inch", 25.4], ["centimeter", 10], ["micron", 0.001], ["meter", 1000], ["foot", 304.8]];
    for (const [unit, k] of cases) {
      const soup = await read3mf(await threeMf(modelXml(cubeObject(1, 1), `<item objectid="1"/>`, unit)));
      expect(measure(soup.corners).volume / (k * k * k)).toBeCloseTo(1, 5);
    }
    await expect(read3mf(await threeMf(modelXml(cubeObject(1, 1), `<item objectid="1"/>`, "furlong")))).rejects.toThrow(/unit/);
  });

  it("places build items and components by their transforms, mirrors turned the right way out", async () => {
    // Item 1: the cube moved +100 in x; item 2: a component (the cube moved +5 z) of an object placed −50 in x.
    const body = cubeObject(1, 10) + `<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></components></object>`;
    const soup = await read3mf(await threeMf(modelXml(body, `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 -50 0 0"/>`)));
    expect(soup.objects).toBe(2);
    const m = measure(soup.corners);
    expect(m.volume).toBeCloseTo(2000, 4);
    expect([m.minX, m.maxX, m.minZ, m.maxZ]).toEqual([-50, 110, 0, 15]);
    // Mirrored in x and scaled 2: still a positive volume (8000).
    const mirrored = await read3mf(await threeMf(modelXml(cubeObject(1, 10), `<item objectid="1" transform="-2 0 0 0 2 0 0 0 2 0 0 0"/>`)));
    expect(measure(mirrored.corners).volume).toBeCloseTo(8000, 3);
  });

  it("follows components into other model files (as Bambu Studio saves them)", async () => {
    const main = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="5" type="model"><components><p:component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources><build><item objectid="5" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`;
    const sub = modelXml(cubeObject(1, 20), "");
    const soup = await read3mf(await threeMf(main, [{ name: "3D/Objects/object_1.model", data: sub }], true));
    const m = measure(soup.corners);
    expect(m.volume).toBeCloseTo(8000, 3);
    expect(m.minX).toBe(128);
  });

  it("composes transforms first-then-second", () => {
    const move = [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 2, 3];
    const turn = [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0]; // x → y
    expect(composeTransforms(IDENTITY_3MF, move)).toEqual(move);
    expect(composeTransforms(move, turn)).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1, -2, 1, 3]);
  });

  it("finds the model through _rels/.rels", () => {
    expect(mainModelPath(undefined)).toBe("3D/3dmodel.model");
    expect(mainModelPath(`<Relationships><Relationship Target="/3D/other.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`)).toBe("3D/other.model");
  });

  it("explains broken files", async () => {
    await expect(read3mf(enc("not a zip at all, just words"))).rejects.toThrow(/zip/);
    await expect(read3mf(await threeMf(modelXml(cubeObject(1, 1), "")))).rejects.toThrow(/nothing to print/);
    await expect(read3mf(await threeMf(modelXml(cubeObject(1, 1), `<item objectid="9"/>`)))).rejects.toThrow(/object 9/);
    const zip = await threeMf(modelXml(cubeObject(1, 1), `<item objectid="1"/>`));
    await expect(read3mf(zip.subarray(0, zip.length - 30))).rejects.toThrow();
  });
});

describe("importing 3MF and OBJ files", () => {
  it("knows them by name, and the picker offers them", () => {
    expect(meshFormatOf("Bracket.3MF")).toBe("3mf");
    expect(meshFormatOf("teapot.obj")).toBe("obj");
    expect(meshFormatOf("part.stl")).toBeNull();
    expect(IMPORT_ACCEPT).toContain(".3mf");
    expect(IMPORT_ACCEPT).toContain(".obj");
    expect(importName("Phone stand.3mf")).toBe("Phone stand");
    expect(importName("teapot.obj")).toBe("teapot");
  });

  it("packages them as an STL that keeps the original name and kind, and saves/opens", async () => {
    const mesh = await meshFileToStl("cube.obj", enc(objCube(10)), "obj");
    expect(mesh.ok).toBe(true);
    if (!mesh.ok) return;
    expect(measure(readStlCorners(mesh.stl)).volume).toBeCloseTo(1000, 3);
    const r = readImport("cube.obj", mesh.stl, mesh.from);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.file).toMatchObject({ fileName: "cube.obj", format: "stl", units: "mm", from: "obj" });
    expect(importKind(r.file)).toBe("OBJ");
    const doc = {
      format: "partsmith",
      version: 1,
      name: "x",
      features: [{ id: "a", name: "Cube", type: "import", operation: "new", params: {}, import: r.file }],
    };
    expect(parseDocument(doc)?.features[0].import).toEqual(r.file);
    // Only STL-kept files can say they came from a 3MF/OBJ; anything else is dropped.
    const odd = { ...doc, features: [{ ...doc.features[0], import: { ...r.file, from: "dwg" } }] };
    expect(parseDocument(odd)?.features[0].import?.from).toBeUndefined();
  });

  it("leaves a plain STL import exactly as it was", () => {
    const stl = new Uint8Array(84 + 50);
    new DataView(stl.buffer).setUint32(80, 1, true);
    const r = readImport("a.stl", stl);
    expect(r.ok === true && Object.keys(r.file)).toEqual(["fileName", "format", "data", "units"]);
    expect(r.ok === true && importKind(r.file)).toBe("STL");
  });

  it("says plainly why a file can't be imported", async () => {
    const bad = await meshFileToStl("x.3mf", enc("hello"), "3mf");
    expect(bad.ok === false && bad.error).toMatch(/^x\.3mf can't be imported: .*zip/);
    const empty = await meshFileToStl("x.obj", new Uint8Array(), "obj");
    expect(empty.ok === false && empty.error).toBe("x.obj is empty.");
    const noFaces = await meshFileToStl("x.obj", enc("v 1 2 3\n"), "obj");
    expect(noFaces.ok === false && noFaces.error).toMatch(/no faces/);
  });
});

describe("slicer project files", () => {
  it("reads a Bambu Studio project: parts in object files, every plate's items, modifiers left out", async () => {
    const soup = await read3mf(await bambuProject());
    // Plate 1: a 20 mm cube at the plate's middle (128, 128); plate 2: a 10 mm cube further along. The 30 mm modifier
    // part and the negative part are slicer settings, not shape.
    expect(soup.skipped).toBe(2);
    expect(soup.objects).toBe(2);
    const m = measure(soup.corners);
    expect(m.volume).toBeCloseTo(8000 + 1000, 3);
    expect(m.minX).toBe(118);
    expect(m.maxX).toBe(128 + 307.2 + 5);
  });

  it("reads a PrusaSlicer project, leaving out its modifier volumes' triangles", async () => {
    const soup = await read3mf(await prusaProject());
    expect(soup.skipped).toBe(1);
    expect(measure(soup.corners).volume).toBeCloseTo(1000, 4);
    expect(soup.corners.length / 9).toBe(12);
  });

  it("reads which parts are slicer settings", () => {
    const s = slicerSkips(
      `<config><object id="4"><part id="1" subtype="normal_part"/><part id="2" subtype="modifier_part"><metadata key="name" value="m"/></part><part id="3" subtype="support_blocker"/></object></config>`,
      `<config><object id="1"><volume firstid="0" lastid="11"><metadata type="volume" key="volume_type" value="ModelPart"/></volume><volume firstid="12" lastid="23"><metadata type="volume" key="modifier" value="1"/></volume></object></config>`,
    );
    expect([...(s.parts.get("4") ?? [])]).toEqual(["2", "3"]);
    expect(s.ranges.get("1")).toEqual([[12, 23]]);
  });

  it("refuses a file with only modifiers in it, plainly", async () => {
    await expect(read3mf(await bambuProject({ onlyModifiers: true }))).rejects.toThrow(/only has slicer settings parts/);
  });
});

describe("File units for 3MF and OBJ files", () => {
  const file = (unitMm?: number, from: "3mf" | "obj" = "3mf"): ImportedFile => ({ fileName: "a", format: "stl", data: "", units: "mm", from, ...(unitMm ? { unitMm } : {}) });

  it("measures them against the unit the 3MF says, its numbers already in millimetres", () => {
    const inch = file(25.4);
    expect(fileUnitOf(inch)).toBe("in");
    expect(importScaleFactor(inch, undefined)).toBe(1);
    expect(importScaleFactor(inch, "in")).toBe(1); // already inches: not 25.4 times again
    expect(importScaleFactor(inch, "mm")).toBeCloseTo(1 / 25.4, 12); // "its numbers are really millimetres"
    expect(importScaleFactor(file(10), "mm")).toBeCloseTo(0.1, 12);
    expect(importScaleFactor(file(), "in")).toBeCloseTo(25.4, 12);
    expect(fileUnitOf(file(0.001))).toBeNull();
  });

  it("takes an OBJ as millimetres", () => {
    expect(fileUnitOf(file(undefined, "obj"))).toBe("mm");
    expect(importScaleFactor(file(undefined, "obj"), "in")).toBeCloseTo(25.4, 12);
    expect(importScaleFactor(file(undefined, "obj"), "mm")).toBe(1);
  });

  it("keeps the 3MF's unit on the import, and in saved designs", async () => {
    const mesh = await meshFileToStl("inch.3mf", await threeMf(modelXml(cubeObject(1, 1), `<item objectid="1"/>`, "inch")), "3mf");
    expect(mesh.ok).toBe(true);
    if (!mesh.ok) return;
    expect(meshExtras(mesh)).toEqual({ from: "3mf", unitMm: 25.4 });
    const r = readImport("inch.3mf", mesh.stl, mesh.from, mesh.unitMm);
    if (r.ok !== true) throw new Error("not packaged");
    expect(r.file.unitMm).toBe(25.4);
    const doc = { format: "partsmith", version: 1, name: "x", features: [{ id: "a", name: "C", type: "import", operation: "new", params: {}, import: r.file }] };
    expect(parseDocument(doc)?.features[0].import).toEqual(r.file);
    // A millimetre 3MF and an OBJ carry nothing extra.
    const mm = await meshFileToStl("mm.3mf", await threeMf(modelXml(cubeObject(1, 1), `<item objectid="1"/>`)), "3mf");
    expect(mm.ok && meshExtras(mm)).toEqual({ from: "3mf" });
    const obj = { ...r.file, from: "obj" as const };
    expect(parseDocument({ ...doc, features: [{ ...doc.features[0], import: obj }] })?.features[0].import?.unitMm).toBeUndefined();
  });
});

describe("OBJ files as download sites save them", () => {
  it("reads Windows line endings, materials, normals, texture corners, smoothing groups and 5-sided faces", () => {
    const text = objCube(10).replace(/\n/g, "\r\n").replace("o Cube", "mtllib cube.mtl\r\no Cube\r\nusemtl Mat\r\ns 1");
    const soup = readObj(text + "l 1 2\r\np 3\r\n");
    expect(measure(soup.corners).volume).toBeCloseTo(1000, 6);
  });
});
