import { describe, expect, it } from "vitest";

import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import type { JuraCADDocument } from "../src/model/types";

describe("replace face", () => {
  it("starts with nothing picked, and keeps the face it moves onto when saved", () => {
    const f = createFeature(emptyDocument(), "replaceFace");
    expect([f.name, f.picks, f.replaceDef, f.params.offset]).toEqual(["Replace face 1", [], { target: null, picking: "faces" }, "0"]);
    const target = { kind: "face" as const, origin: [0, 0, 15] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Face of Part 2" };
    const doc: JuraCADDocument = { ...emptyDocument(), features: [{ ...f, replaceDef: { target, picking: "target" } }] };
    const back = parseDocument(JSON.parse(JSON.stringify(doc)))!.features[0];
    expect(back.replaceDef).toEqual({ target, picking: "target" });
  });
});
