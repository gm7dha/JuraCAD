import { describe, expect, it } from "vitest";

import { emptyDocument } from "../src/model/document";
import {
  DESIGN_EXTENSIONS,
  FILE_EXTENSION,
  isDesignFileName,
  nameFromFileName,
  readDocumentFile,
  serializeDocument,
} from "../src/model/fileFormat";

// The app was renamed from PartSmith to JuraCAD: new saves are .juracad, and
// .partsmith files saved before the rename must still open.
describe("design file names", () => {
  it("saves new designs as .juracad", () => {
    expect(FILE_EXTENSION).toBe(".juracad");
  });

  it("recognises both .juracad and the older .partsmith", () => {
    expect(DESIGN_EXTENSIONS).toEqual([".juracad", ".partsmith"]);
    expect(isDesignFileName("Bracket.juracad")).toBe(true);
    expect(isDesignFileName("Bracket.partsmith")).toBe(true);
    expect(isDesignFileName("BRACKET.JURACAD")).toBe(true);
    expect(isDesignFileName("Bracket.PartSmith")).toBe(true);
    expect(isDesignFileName("Bracket.step")).toBe(false);
    expect(isDesignFileName("Bracket.stl")).toBe(false);
    expect(isDesignFileName("juracad.txt")).toBe(false);
  });

  it("names designs after either kind of file", () => {
    expect(nameFromFileName("Bracket v2.juracad")).toBe("Bracket v2");
    expect(nameFromFileName("Bracket v2.partsmith")).toBe("Bracket v2");
    expect(nameFromFileName("Bracket v2.JuraCAD")).toBe("Bracket v2");
  });

  it("keeps the saved-file format id, so files open in older and newer versions alike", () => {
    const doc = emptyDocument("Bracket");
    const text = serializeDocument(doc, new Date("2026-01-02T03:04:05Z"));
    expect(text).toMatch(/"format": "partsmith"/);
    expect(text).toMatch(/"savedWith": "JuraCAD/);
    const back = readDocumentFile(text, "Bracket.juracad");
    expect(back.ok && back.doc).toEqual(doc);
    // A file saved before the rename (same contents, older extension) opens the same way.
    const old = readDocumentFile('{"format":"partsmith","version":1,"name":"Old","savedWith":"PartSmith","features":[]}', "Old.partsmith");
    expect(old.ok && old.doc.name).toBe("Old");
  });
});
