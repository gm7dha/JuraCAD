import { describe, expect, it } from "vitest";

import { addAssembly, insertInstance } from "../src/assembly/assembly";
import { emptyDocument, parseDocument, renamePart } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";

describe("renaming parts", () => {
  const withCopies = () => {
    let doc = addAssembly(emptyDocument(), "a1");
    doc = insertInstance(doc, "a1", { id: "f1", name: "Part 1" }, undefined, "i1");
    doc = insertInstance(doc, "a1", { id: "f1", name: "Part 1" }, undefined, "i2");
    doc = insertInstance(doc, "a1", { id: "f2", name: "Part 2" }, undefined, "i3");
    return doc;
  };

  it("names a part and its copies in assemblies", () => {
    const doc = renamePart(withCopies(), "f1", "Part 1", "  Bracket ");
    expect(doc.partNames).toEqual({ f1: "Bracket" });
    expect(doc.assemblies![0].instances.map((i) => i.name)).toEqual(["Bracket <1>", "Bracket <2>", "Part 2 <1>"]);
  });

  it("leaves copies the user renamed themselves alone", () => {
    let doc = withCopies();
    doc = { ...doc, assemblies: doc.assemblies!.map((a) => ({ ...a, instances: a.instances.map((i) => (i.id === "i2" ? { ...i, name: "Left bracket" } : i)) })) };
    doc = renamePart(doc, "f1", "Part 1", "Bracket");
    expect(doc.assemblies![0].instances.map((i) => i.name)).toEqual(["Bracket <1>", "Left bracket", "Part 2 <1>"]);
  });

  it("a blank name goes back to the automatic one", () => {
    const named = renamePart(emptyDocument(), "f1", "Part 1", "Bracket");
    expect(renamePart(named, "f1", "Bracket", "   ").partNames).toBeUndefined();
  });

  it("saves and reopens names, ignoring junk", () => {
    const doc = renamePart(emptyDocument(), "f1", "Part 1", "Bracket");
    const read = readDocumentFile(serializeDocument(doc));
    expect(read.ok && read.doc.partNames).toEqual({ f1: "Bracket" });
    const parsed = parseDocument({ format: "partsmith", version: 1, name: "x", features: [], partNames: { a: "  ", b: 5, c: " Lid " } });
    expect(parsed?.partNames).toEqual({ c: "Lid" });
  });
});
