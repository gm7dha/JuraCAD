/**
 * Every part of a design must survive Save then Open (and Live with Claude,
 * which sends the design as file text). The sample below is typed as
 * `Required<JuraCADDocument>`, so a field added to the document later won't
 * compile here until it's filled in — and then this test checks the file keeps it.
 */
import { describe, expect, it } from "vitest";
import { addAssembly } from "../src/assembly/assembly";
import { addDrawing } from "../src/drawing/drawing";
import { addConfiguration } from "../src/model/configurations";
import { addFeature, createFeature, emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { addStudio } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";

function everyField(): Required<JuraCADDocument> {
  let doc = emptyDocument("Everything");
  const box = createFeature(doc, "box");
  box.params.width = "wall * 10";
  doc = addFeature(doc, box);
  doc = { ...doc, variables: [{ id: "v1", name: "wall", value: "2" }] };
  doc = addStudio(doc, "ps2");
  doc = addAssembly(doc, "a1");
  doc = addDrawing(doc, "d1", { kind: "part", id: box.id });
  doc = addConfiguration(doc, "Long");
  const full: Required<JuraCADDocument> = {
    format: doc.format,
    version: doc.version,
    name: doc.name,
    features: doc.features,
    variables: doc.variables!,
    units: "in",
    appearance: { [box.id]: "#3366cc" },
    materials: { [box.id]: "petg" },
    studioName: "Brackets",
    hiddenDatums: ["Top"],
    partStudios: doc.partStudios!,
    partNames: { [box.id]: "Base plate" },
    partProperties: { [box.id]: { number: "BR-001", description: "Base", custom: [{ name: "Supplier", value: "Screwfix" }] } },
    assemblies: doc.assemblies!,
    drawings: doc.drawings!,
    configurations: doc.configurations!,
    // The second configuration, so a reader that just picks the first would be caught.
    activeConfiguration: doc.configurations![1].id,
  };
  return full;
}

describe("saving keeps every part of the design", () => {
  it("writes and reads back every field of the document", () => {
    const doc = everyField();
    // Each field is really filled in (an empty list or map would be left out of the file on purpose).
    for (const [key, value] of Object.entries(doc)) {
      expect(value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)).toBe(false);
      expect(key.length).toBeGreaterThan(0);
    }
    const back = readDocumentFile(serializeDocument(doc));
    if (!back.ok) throw new Error(back.error);
    for (const key of Object.keys(doc) as (keyof JuraCADDocument)[]) {
      // Named, so a failure says which field went missing.
      expect({ [key]: back.doc[key] }).toEqual({ [key]: doc[key] });
    }
    expect(back.doc).toEqual(doc);
  });
});
