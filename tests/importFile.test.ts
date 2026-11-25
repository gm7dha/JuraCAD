import { describe, expect, it } from "vitest";

import { countStlTriangles, detectFormat, fromBase64, importedSize, importName, readImport, reducedNote, reduceStl, storedTriangles, toBase64, MAX_STL_TRIANGLES, SOLID_STL_TRIANGLES } from "../src/model/importFile";
import { writeBinaryStl } from "../src/geometry/stl";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { lumpyBall } from "./support/meshShapes";
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
    expect(step.ok === true && step.file.format).toBe("step");
    expect(step.ok === true && step.file.data).toMatch(/^ISO-10303-21/);
    const stl = readImport("cube.stl", binaryStl(12));
    expect(stl.ok === true && stl.file.format).toBe("stl");
    expect(stl.ok === true && fromBase64(stl.file.data).length).toBe(84 + 600);

    const empty = readImport("a.stl", new Uint8Array(0));
    expect(!empty.ok && empty.error).toMatch(/empty/);
    const notModel = readImport("photo.jpg", enc("hello there"));
    expect(!notModel.ok && notModel.error).toMatch(/isn't a STEP, STL, 3MF or OBJ file/);
    const huge = readImport("big.stl", binaryStl(MAX_STL_TRIANGLES + 1));
    expect(!huge.ok && huge.error).toMatch(/too detailed even to reduce/);
    // Up to the old limit, exactly as before.
    const most = readImport("most.stl", binaryStl(SOLID_STL_TRIANGLES));
    expect(most.ok === true && fromBase64(most.file.data).length).toBe(84 + SOLID_STL_TRIANGLES * 50);
    expect(most.ok === true && "reducedFrom" in most.file).toBe(false);
    // Past it: reduced first.
    expect(readImport("more.stl", binaryStl(SOLID_STL_TRIANGLES + 1))).toEqual({ ok: "reduce", fileName: "more.stl", triangles: SOLID_STL_TRIANGLES + 1 });
    const bigStep = readImport("big.step", enc("ISO-10303-21;" + " ".repeat(26 * 1024 * 1024)));
    expect(!bigStep.ok && bigStep.error).toMatch(/up to 25 MB/);
  });

  it("reduces a detailed STL to a closed mesh of about the triangles asked for", () => {
    const ball = lumpyBall(130, 260);
    const bytes = new Uint8Array(writeBinaryStl([ball]));
    const n = ball.triangles.length / 3;
    expect(readImport("ball.stl", bytes)).toEqual({ ok: "reduce", fileName: "ball.stl", triangles: n });
    const file = reduceStl("ball.stl", bytes, 25_000);
    expect(file).toMatchObject({ fileName: "ball.stl", format: "stl", units: "mm", reducedFrom: n });
    const kept = storedTriangles(file);
    expect(kept).toBeLessThanOrEqual(25_000);
    expect(kept).toBeGreaterThan(24_000);
    expect(reducedNote(file)).toBe(`Reduced from ${n.toLocaleString("en-GB")} triangles to ${kept.toLocaleString("en-GB")}, so it can be worked with as a solid. Only the reduced shape is kept in your design.`);
    // It reads back as a closed body.
    const view = new DataView(fromBase64(file.data).buffer);
    const corners: number[] = [];
    for (let t = 0; t < kept; t++) for (let k = 0; k < 9; k++) corners.push(view.getFloat32(84 + t * 50 + 12 + k * 4, true));
    const a = analyzeMesh(corners, Array.from({ length: corners.length / 3 }, (_, i) => i));
    expect(a.openEdges).toBe(0);
    expect(a.nonManifoldEdges).toBe(0);
    expect(Math.abs(a.volume - analyzeMesh(ball.vertices, ball.triangles).volume) / a.volume).toBeLessThan(0.02);
    // Never more than a solid can have.
    expect(storedTriangles(reduceStl("ball.stl", bytes, 10 * SOLID_STL_TRIANGLES))).toBeLessThanOrEqual(SOLID_STL_TRIANGLES);
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
    const reduced = { ...doc, features: [{ ...doc.features[0], import: { fileName: "big.stl", format: "stl", data: "AAAA", units: "mm", reducedFrom: 312456 } }] };
    expect(parseDocument(reduced)?.features[0].import).toEqual({ fileName: "big.stl", format: "stl", data: "AAAA", units: "mm", reducedFrom: 312456 });
  });
});
