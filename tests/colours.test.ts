import { describe, expect, it } from "vitest";

import { colourToRgb, normaliseColour, parseAppearance } from "../src/model/colours";
import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";

describe("part colours", () => {
  it("accepts proper colours only", () => {
    expect(normaliseColour("#ABC")).toBe("#aabbcc");
    expect(normaliseColour("3d7fd9")).toBe("#3d7fd9");
    expect(normaliseColour("red")).toBeNull();
    expect(parseAppearance({ a: "#fff", b: "nope", c: 3 })).toEqual({ a: "#ffffff" });
    expect(colourToRgb("#ff8000").map((v) => Math.round(v * 255))).toEqual([255, 128, 0]);
  });

  it("are saved in design files", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = { ...addFeature(doc, box), appearance: { [box.id]: "#d64545" } };
    const back = readDocumentFile(serializeDocument(doc));
    expect(back.ok && back.doc.appearance).toEqual({ [box.id]: "#d64545" });
    expect(parseDocument({ ...doc, appearance: { x: "not a colour" } })?.appearance).toBeUndefined();
  });
});
