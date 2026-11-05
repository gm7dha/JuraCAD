/** A design sent from JuraCUT (DXF) becomes a new sketch on the Top plane (src/link/receive.ts). */
import { describe, expect, it } from "vitest";

import { sketchFromDxf } from "../src/link/receive";
import { emptyDocument } from "../src/model/document";
import { firstStudioId, studioFeatures, studiosOf } from "../src/model/studios";

const ent = (...rows: (string | number)[]) => rows.join("\n");
/** A 40 × 30 mm rectangle (a closed polyline) with a 8 mm hole, as JuraCUT writes them (R12, millimetres). */
const DXF = [
  ent(0, "SECTION", 2, "HEADER", 9, "$INSUNITS", 70, 4, 0, "ENDSEC"),
  ent(0, "SECTION", 2, "ENTITIES"),
  ent(0, "POLYLINE", 8, "CUT_OUTER", 66, 1, 70, 1),
  ...[[0, 0], [40, 0], [40, 30], [0, 30]].map(([x, y]) => ent(0, "VERTEX", 8, "CUT_OUTER", 10, x, 20, y)),
  ent(0, "SEQEND"),
  ent(0, "CIRCLE", 8, "CUT_INNER", 10, 20, 20, 15, 40, 4),
  ent(0, "ENDSEC", 0, "EOF"),
].join("\n");

describe("a design from JuraCUT", () => {
  it("becomes a sketch on Top at the end of the Part Studio on show, its shapes at full size", () => {
    const doc = emptyDocument();
    const studio = firstStudioId(doc);
    const r = sketchFromDxf(doc, studio, "Tag", DXF);
    const added = studioFeatures(r.doc, studio).find((f) => f.id === r.featureId)!;
    expect(added.type).toBe("sketch");
    expect(added.name).toBe("From JuraCUT: Tag");
    expect(added.sketch?.plane).toEqual({ kind: "default", name: "Top" });
    const curves = added.sketch!.data.curves;
    expect(curves.filter((c) => c.type === "line")).toHaveLength(4);
    expect(curves.filter((c) => c.type === "circle")).toHaveLength(1);
    const xs = added.sketch!.data.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 6);
    // A second one gets its own name.
    const again = sketchFromDxf(r.doc, studio, "Tag", DXF);
    expect(studioFeatures(again.doc, studio).find((f) => f.id === again.featureId)!.name).toBe("From JuraCUT: Tag (2)");
  });

  it("goes into a new Part Studio when asked (an assembly or drawing was on show)", () => {
    const doc = emptyDocument();
    const r = sketchFromDxf(doc, "new", "Coaster", DXF);
    expect(studiosOf(r.doc)).toHaveLength(studiosOf(doc).length + 1);
    expect(studioFeatures(r.doc, r.studioId).map((f) => f.id)).toEqual([r.featureId]);
  });

  it("says plainly when there's nothing to bring in", () => {
    expect(() => sketchFromDxf(emptyDocument(), "new", "Empty", ent(0, "SECTION", 2, "ENTITIES", 0, "ENDSEC", 0, "EOF"))).toThrow(/no drawing in it|no lines or shapes/);
  });
});
