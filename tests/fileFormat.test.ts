import { beforeEach, describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, historyOf } from "../src/model/document";
import { nameFromFileName, readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { fingerprint, useStore } from "../src/model/store";

function sampleDoc() {
  let doc = emptyDocument("Bracket");
  const box = createFeature(doc, "box");
  box.params.width = "wall * 10";
  doc = addFeature(doc, box);
  return { ...doc, variables: [{ id: "v1", name: "wall", value: "2" }] };
}

describe(".juracad files", () => {
  it("save and open back exactly", () => {
    const doc = sampleDoc();
    const text = serializeDocument(doc, new Date("2026-01-02T03:04:05Z"));
    expect(text).toMatch(/"savedAt": "2026-01-02T03:04:05.000Z"/);
    const back = readDocumentFile(text);
    expect(back.ok && back.doc).toEqual(doc);
  });

  it("explain files that can't be opened", () => {
    const bad = (text: string) => {
      const r = readDocumentFile(text, "thing.juracad");
      return r.ok ? "" : r.error;
    };
    expect(bad("ISO-10303-21;\nHEADER;")).toMatch(/STEP file/);
    expect(bad("solid part\nfacet normal 0 0 1")).toMatch(/STL/);
    expect(bad("hello")).toMatch(/isn't a JuraCAD design file/);
    expect(bad('{"format":"other"}')).toMatch(/isn't a JuraCAD design file/);
    expect(bad('{"format":"partsmith","version":2,"features":[]}')).toMatch(/newer version/);
    expect(bad('{"format":"partsmith","version":1,"features":[{"id":5}]}')).toMatch(/damaged/);
  });

  it("names designs after their file", () => {
    expect(nameFromFileName("Bracket v2.partsmith")).toBe("Bracket v2");
    expect(nameFromFileName("old.json")).toBe("old");
  });

  it("fingerprints change when the design does", () => {
    const a = sampleDoc();
    expect(fingerprint(a)).toBe(fingerprint(JSON.parse(JSON.stringify(a))));
    expect(fingerprint({ ...a, name: "Other" })).not.toBe(fingerprint(a));
  });
});

describe("opening and saving in the app", () => {
  beforeEach(() => useStore.setState({ history: historyOf(emptyDocument()), editing: null, savedDoc: null, fileName: null }));

  it("tracks unsaved changes, and opening can be undone", () => {
    const s = () => useStore.getState();
    s().startCreate("box");
    s().commitDraft();
    const before = s().history.present;
    expect(s().savedDoc).toBeNull();

    s().openDocument(sampleDoc(), "Bracket.juracad");
    expect(s().history.present.name).toBe("Bracket");
    expect(s().savedDoc).toBe(s().history.present);
    expect(s().fileName).toBe("Bracket.juracad");

    s().renameDocument("Bracket v2");
    expect(s().savedDoc).not.toBe(s().history.present);
    s().markSaved("Bracket v2.juracad");
    expect(s().savedDoc).toBe(s().history.present);

    s().undo();
    s().undo();
    expect(s().history.present).toBe(before);
  });
});
