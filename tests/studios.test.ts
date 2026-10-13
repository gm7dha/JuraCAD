import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import {
  addStudio,
  allFeatures,
  inStudio,
  MAIN_STUDIO,
  nextStudioName,
  removeStudio,
  renameStudio,
  studioFeatures,
  studioName,
  studioOfFeature,
  studiosOf,
  studioView,
} from "../src/model/studios";
import { applyVariables } from "../src/model/variables";

describe("Part Studios", () => {
  it("starts with one, and adds more with the next free name", () => {
    let doc = emptyDocument();
    expect(studiosOf(doc).map((s) => s.name)).toEqual(["Part Studio 1"]);
    doc = addStudio(doc, "s2");
    doc = addStudio(doc, "s3");
    expect(studiosOf(doc).map((s) => [s.id, s.name])).toEqual([
      [MAIN_STUDIO, "Part Studio 1"],
      ["s2", "Part Studio 2"],
      ["s3", "Part Studio 3"],
    ]);
    doc = removeStudio(doc, "s2");
    expect(nextStudioName(doc)).toBe("Part Studio 2");
    expect(removeStudio(doc, MAIN_STUDIO)).toBe(doc);
  });

  it("renames studios, including the first", () => {
    let doc = renameStudio(addStudio(emptyDocument(), "s2"), MAIN_STUDIO, "Body");
    doc = renameStudio(doc, "s2", " Lid ");
    expect(studiosOf(doc).map((s) => s.name)).toEqual(["Body", "Lid"]);
    expect(studioName(doc, "s2")).toBe("Lid");
    expect(renameStudio(doc, MAIN_STUDIO, "Part Studio 1").studioName).toBeUndefined();
    expect(renameStudio(doc, "s2", "  ")).toBe(doc);
  });

  it("changes only the Part Studio it's aimed at", () => {
    let doc = addStudio(emptyDocument(), "s2");
    const box = createFeature(studioView(doc, "s2"), "box");
    doc = inStudio(doc, "s2", (d) => addFeature(d, box));
    expect(doc.features).toEqual([]);
    expect(studioFeatures(doc, "s2")).toEqual([box]);
    expect(studioOfFeature(doc, box.id)).toBe("s2");
    expect(allFeatures(doc)).toEqual([box]);
    // The first studio's features stay the same array (safe for screen updates).
    const before = doc.features;
    doc = inStudio(doc, "s2", (d) => addFeature(d, createFeature(studioView(doc, "s2"), "box")));
    expect(doc.features).toBe(before);
    expect(studioFeatures(doc, "s2").map((f) => f.name)).toEqual(["Box 1", "Box 2"]);
    expect(studioFeatures(doc, "gone")).toEqual([]);
    expect(inStudio(doc, "gone", (d) => addFeature(d, box))).toBe(doc);
  });

  it("variables reach every Part Studio", () => {
    let doc = addStudio(emptyDocument(), "s2");
    doc = applyVariables(doc, [{ id: "v1", name: "w", value: "10" }]);
    const box = { ...createFeature(studioView(doc, "s2"), "box"), params: { width: "w", depth: "5", height: "5", x: "0", y: "0", z: "0" } };
    doc = inStudio(doc, "s2", (d) => addFeature(d, box));
    doc = applyVariables(doc, [{ id: "v1", name: "width", value: "10" }]);
    expect(studioFeatures(doc, "s2")[0].params.width).toBe("width");
  });

  it("saves and reopens Part Studios; feature ids must be unique across them", () => {
    let doc = renameStudio(addStudio(emptyDocument(), "s2"), MAIN_STUDIO, "Body");
    doc = inStudio(doc, "s2", (d) => addFeature(d, createFeature(d, "sphere")));
    const read = readDocumentFile(serializeDocument(doc));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.partStudios).toEqual(doc.partStudios);
    expect(read.doc.studioName).toBe("Body");
    const f = studioFeatures(doc, "s2")[0];
    expect(parseDocument({ format: "partsmith", version: 1, name: "x", features: [f], partStudios: [{ id: "s2", name: "B", features: [f] }] })).toBeNull();
    // Junk studios are skipped.
    const ok = parseDocument({ format: "partsmith", version: 1, name: "x", features: [], partStudios: [{ id: "main", features: [] }, { name: "no id" }, 7] });
    expect(ok?.partStudios).toBeUndefined();
  });
});
