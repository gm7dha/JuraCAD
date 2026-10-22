import { describe, expect, it } from "vitest";

import { billOfMaterials, bomCsv } from "../src/assembly/assembly";
import { customColumns, parsePartProperties, setPartProperties, tidyProperties } from "../src/assembly/properties";
import { emptyDocument, parseDocument } from "../src/model/document";
import type { Assembly, Instance } from "../src/model/types";

const inst = (id: string, partId: string): Instance => ({ id, partId, name: `${partId} <1>`, placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false });

describe("part properties", () => {
  it("tidy away blanks and repeated names", () => {
    expect(tidyProperties({ number: "  BR-1 ", description: " ", custom: [{ name: "Supplier", value: "Acme" }, { name: "supplier", value: "Other" }, { name: "", value: "x" }, { name: "Finish", value: "" }] })).toEqual({
      number: "BR-1",
      custom: [{ name: "Supplier", value: "Acme" }],
    });
    expect(tidyProperties({ number: "", custom: [] })).toBe(null);
  });

  it("are set on the document and cleared when emptied", () => {
    let doc = setPartProperties(emptyDocument(), "p1", { number: "BR-1", description: "Bracket" });
    expect(doc.partProperties).toEqual({ p1: { number: "BR-1", description: "Bracket" } });
    doc = setPartProperties(doc, "p1", { number: "" });
    expect("partProperties" in doc).toBe(false);
  });

  it("are saved and opened again; odd entries are dropped", () => {
    const doc = setPartProperties(emptyDocument(), "p1", { number: "BR-1", custom: [{ name: "Supplier", value: "Acme" }] });
    const back = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(back?.partProperties).toEqual({ p1: { number: "BR-1", custom: [{ name: "Supplier", value: "Acme" }] } });
    expect(parsePartProperties({ p1: "x", p2: { number: 5, custom: [null, { name: "A", value: "b" }] }, p3: [] })).toEqual({ p2: { custom: [{ name: "A", value: "b" }] } });
    // Files from before have none.
    expect("partProperties" in parseDocument(JSON.parse(JSON.stringify(emptyDocument())))!).toBe(false);
  });

  it("show in the parts list and its CSV, with a column for each custom property", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("i1", "bolt"), inst("i2", "bolt"), inst("i3", "plate")] };
    const props = { bolt: { number: "B-4", custom: [{ name: "Supplier", value: "Acme, Ltd" }] }, plate: { description: "Top plate", custom: [{ name: "Finish", value: "Black" }] } };
    const rows = billOfMaterials(asm, { bolt: "Bolt", plate: "Plate" }, {}, undefined, props);
    expect(rows.map((r) => r.properties)).toEqual([props.bolt, props.plate]);
    expect(customColumns(rows.map((r) => r.properties))).toEqual(["Supplier", "Finish"]);
    expect(bomCsv(rows)).toBe('Item,Part number,Part,Description,Quantity,Supplier,Finish\n1,B-4,Bolt,,2,"Acme, Ltd",\n2,,Plate,Top plate,1,,Black\n');
    // Without any properties, the CSV is as it always was.
    expect(bomCsv(billOfMaterials(asm, { bolt: "Bolt", plate: "Plate" }))).toBe("Item,Part,Quantity\n1,Bolt,2\n2,Plate,1\n");
  });
});
