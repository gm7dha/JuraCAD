import { describe, expect, it } from "vitest";

import { drawingBom } from "../src/assembly/drawingBom";
import { addDrawing, parseDrawings } from "../src/drawing/drawing";
import { layoutSheet } from "../src/drawing/sheet";
import type { PartMesh, ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Drawing, JuraCADDocument } from "../src/model/types";

/** A part as the engine hands it over: just what the parts list needs (a 10 mm cube, 1000 mm³). */
const part = (id: string, name: string): PartMesh =>
  ({ id, name, featureIds: [id], vertices: new Float32Array(), normals: new Float32Array(), triangles: new Uint32Array(), faceGroups: [], lines: new Float32Array(), edgeGroups: [], faceRefs: [], edgeRefs: [], volume: 1000 }) as PartMesh;
const parts = [part("p1", "Base"), part("p2", "Bolt")];
const asm: Assembly = {
  id: "a1",
  name: "Assembly 1",
  instances: [
    { id: "i1", partId: "p1", name: "Base <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
    { id: "i2", partId: "p2", name: "Bolt <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false },
    { id: "i3", partId: "p2", name: "Bolt <2>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false },
  ],
};
const doc: JuraCADDocument = { ...emptyDocument(), assemblies: [asm], materials: { p2: "steel" } };
const drawing = (): Drawing => addDrawing(doc, "d1", { kind: "assembly", id: "a1" }).drawings![0];
const view = (kind: "front" | "top" | "right" | "iso"): ViewProjection => ({ kind, visible: [[0, 0, 40, 0, 40, 20, 0, 20, 0, 0]], hidden: [], circles: [], points: [], bounds: [0, 0, 40, 20] });
const block = { front: view("front"), top: view("top"), right: view("right"), iso: view("iso") };
const info = { designName: "D", subject: "S", date: "1/1/2026" };

describe("an assembly drawing's parts list", () => {
  it("is just as before (item, part, quantity) unless weights are asked for", () => {
    const old = drawing();
    expect(old.bomWeights).toBe(undefined);
    const lines = drawingBom(old, doc, parts)!;
    expect(lines).toEqual([
      { item: 1, name: "Base", quantity: 1, partId: "p1" },
      { item: 2, name: "Bolt", quantity: 2, partId: "p2" },
    ]);
    // So the sheet is drawn exactly as a plain item/part/quantity list.
    const plain = [
      { item: 1, name: "Base", quantity: 1, partId: "p1" },
      { item: 2, name: "Bolt", quantity: 2, partId: "p2" },
    ];
    expect(JSON.stringify(layoutSheet(old, block, { ...info, bom: lines }).prims)).toBe(JSON.stringify(layoutSheet(old, block, { ...info, bom: plain }).prims));
  });

  it("shows each part's weight when the drawing asks, kept when saved", () => {
    const d = { ...drawing(), bomWeights: true };
    const lines = drawingBom(d, doc, parts)!;
    // 1 cm³: PLA 1.24 g, steel 7.85 g.
    expect(lines.map((l) => l.weight)).toEqual(["1.2 g", "7.9 g"]);
    const texts = layoutSheet(d, block, { ...info, bom: lines }).prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts).toContain("WEIGHT EACH");
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0].bomWeights).toBe(true);
    expect(parseDrawings(JSON.parse(JSON.stringify([drawing()])))[0].bomWeights).toBe(undefined);
  });

  it("shows part numbers and descriptions whenever parts have them", () => {
    const withProps = { ...doc, partProperties: { p1: { number: "BR-1", description: "Base plate" } } };
    const lines = drawingBom(drawing(), withProps, parts)!;
    expect(lines[0]).toEqual({ item: 1, name: "Base", quantity: 1, partId: "p1", number: "BR-1", description: "Base plate" });
    expect(drawingBom({ source: { kind: "part", id: "p1" } }, doc, parts)).toBe(undefined);
  });
});
