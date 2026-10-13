import { describe, expect, it } from "vitest";

import { countStlTriangles, detectFormat, fromBase64, importedSize, importName, readImport, toBase64, MAX_STL_TRIANGLES } from "../src/model/importFile";
import { parseDocument } from "../src/model/document";

const enc = (s: string) => new TextEncoder().encode(s);

function binaryStl(triangles: number): Uint8Array {
  const b = new Uint8Array(84 + triangles * 50);
  new DataView(b.buffer).setUint32(80, triangles, true);
  return b;
}

describe("importing files", () => {
  it("round-trips base64, including large files", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("recognises STEP and STL files by content and name", () => {
    expect(detectFormat("x.txt", enc("ISO-10303-21;\nHEADER;"))).toBe("step");
    expect(detectFormat("Part.STP", enc("whatever"))).toBe("step");
    expect(detectFormat("x", enc("solid cube\nfacet normal 0 0 1"))).toBe("stl");
    expect(detectFormat("noname", binaryStl(2))).toBe("stl");
    expect(detectFormat("photo.jpg", enc("\xff\xd8 not a model"))).toBeNull();
  });

  it("counts STL triangles", () => {
    expect(countStlTriangles(binaryStl(12))).toBe(12);
    expect(countStlTriangles(enc("solid a\nfacet normal 0 0 1\nendfacet\nfacet normal 0 0 1\nendfacet\nendsolid"))).toBe(2);
  });

  it("packages files, or explains why not", () => {
    const step = readImport("Bracket.step", enc("ISO-10303-21;\nHEADER;"));
    expect(step.ok && step.file.format).toBe("step");
    expect(step.ok && step.file.data).toMatch(/^ISO-10303-21/);
    const stl = readImport("cube.stl", binaryStl(12));
    expect(stl.ok && stl.file.format).toBe("stl");
    expect(stl.ok && fromBase64(stl.file.data).length).toBe(84 + 600);

    const empty = readImport("a.stl", new Uint8Array(0));
    expect(!empty.ok && empty.error).toMatch(/empty/);
    const notModel = readImport("photo.jpg", enc("hello there"));
    expect(!notModel.ok && notModel.error).toMatch(/isn't a STEP or STL/);
    const huge = readImport("big.stl", binaryStl(MAX_STL_TRIANGLES + 1));
    expect(!huge.ok && huge.error).toMatch(/too detailed/);
  });

  it("names and sizes", () => {
    expect(importName("Bracket v2.step")).toBe("Bracket v2");
    expect(importName("cube.STL")).toBe("cube");
    expect(importName(".stl")).toBe("Imported part");
    expect(importedSize({ fileName: "a", format: "step", data: "x".repeat(3000), units: "mm" })).toBe("3 KB");
    expect(importedSize({ fileName: "a", format: "stl", data: "A".repeat(4 * 1024 * 1024), units: "mm" })).toBe("3.0 MB");
  });

  it("keeps imports in saved designs, and rejects broken ones", () => {
    const doc = {
      format: "partsmith",
      version: 1,
      name: "x",
      features: [{ id: "a", name: "Cube", type: "import", operation: "new", params: {}, import: { fileName: "cube.stl", format: "stl", data: "AAAA", units: "in" } }],
    };
    expect(parseDocument(doc)?.features[0].import).toEqual({ fileName: "cube.stl", format: "stl", data: "AAAA", units: "in" });
    expect(parseDocument({ ...doc, features: [{ ...doc.features[0], import: { format: "obj", data: "x" } }] })).toBeNull();
  });
});
