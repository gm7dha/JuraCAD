import { describe, expect, it } from "vitest";

import { moveFeature } from "../src/model/reorder";
import type { Feature } from "../src/model/types";

const f = (id: string, extra: Partial<Feature> = {}): Feature => ({ id, name: id, type: "box", operation: "new", suppressed: false, params: {}, ...extra });

describe("reordering features", () => {
  const box = f("b1");
  const cyl = f("cyl");
  const sketch = f("sk", { type: "sketch" });
  const ext = f("ext", { type: "extrude", sketchRef: "sk" });
  const fillet = f("fil", { type: "fillet", picks: [{ partId: "b1", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } }] });
  const list = [box, cyl, sketch, ext, fillet];
  const ids = (r: Feature[] | string) => (typeof r === "string" ? r : r.map((x) => x.id));

  it("moves a feature that nothing depends on", () => {
    expect(ids(moveFeature(list, "cyl", null))).toEqual(["b1", "sk", "ext", "fil", "cyl"]);
    expect(ids(moveFeature(list, "cyl", "b1"))).toEqual(["cyl", "b1", "sk", "ext", "fil"]);
  });

  it("keeps a feature after what it uses, and before what uses it", () => {
    expect(moveFeature(list, "ext", "sk")).toMatch(/uses it/);
    expect(moveFeature(list, "sk", null)).toMatch(/ext.*uses it/);
    expect(moveFeature(list, "fil", "b1")).toMatch(/uses it/);
    // The fillet can move up as far as just below the box it rounds.
    expect(ids(moveFeature(list, "fil", "cyl"))).toEqual(["b1", "fil", "cyl", "sk", "ext"]);
  });
});
