import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { visibleParamKeys } from "../src/model/features";
import type { Feature, PartSmithDocument } from "../src/model/types";

const roundTrip = (doc: PartSmithDocument) => parseDocument(JSON.parse(JSON.stringify(doc)));

describe("saving part modelling options", () => {
  it("opens designs with an Intersect feature (they used to fail to open)", () => {
    let doc = emptyDocument();
    doc = addFeature(doc, createFeature(doc, "box"));
    doc = addFeature(doc, createFeature(doc, "cylinder", "intersect"));
    const saved = roundTrip(doc);
    expect(saved).not.toBeNull();
    expect(saved?.features[1].operation).toBe("intersect");
  });

  it("keeps the new extrude, revolve, chamfer, shell, pattern and mirror options", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = addFeature(doc, box);
    const ex: Feature = { ...createFeature(doc, "extrude"), extrude: { end: "blind", flip: true, second: true } };
    const rev: Feature = { ...createFeature(doc, "revolve"), revolve: { axis: "vertical", flip: false, symmetric: true } };
    const ch: Feature = { ...createFeature(doc, "chamfer"), chamferType: "distanceAngle", flipSide: true };
    const sh: Feature = { ...createFeature(doc, "shell"), flipSide: true };
    const lp: Feature = { ...createFeature(doc, "linearPattern"), pattern: { sources: [box.id], axis: "x", flip: false, axis2: "z", flip2: true } };
    const mi: Feature = { ...createFeature(doc, "mirror"), mirror: { sources: [], plane: { kind: "default", name: "Front" }, part: box.id, join: true } };
    for (const f of [ex, rev, ch, sh, lp, mi]) doc = addFeature(doc, f);
    const saved = roundTrip(doc)!;
    const byId = (id: string) => saved.features.find((f) => f.id === id)!;
    expect(byId(ex.id).extrude).toEqual(ex.extrude);
    expect(byId(rev.id).revolve).toEqual(rev.revolve);
    expect(byId(ch.id).chamferType).toBe("distanceAngle");
    expect(byId(ch.id).flipSide).toBe(true);
    expect(byId(sh.id).flipSide).toBe(true);
    expect(byId(lp.id).pattern).toEqual(lp.pattern);
    expect(byId(mi.id).mirror).toEqual(mi.mirror);
  });

  it("opens older designs without the new options, with the new sizes at their defaults", () => {
    let doc = emptyDocument();
    doc = addFeature(doc, createFeature(doc, "box"));
    const lp = createFeature(doc, "linearPattern");
    const old = JSON.parse(JSON.stringify(addFeature(doc, { ...lp, params: { count: "3", spacing: "20" } })));
    const saved = parseDocument(old)!;
    expect(saved.features[1].params.count2).toBe("1");
    expect(saved.features[1].pattern).toEqual({ sources: [doc.features[0].id], axis: "x", flip: false });
  });
});

describe("which size boxes show", () => {
  const f = (over: Partial<Feature> & Pick<Feature, "type">): Feature => ({ id: "x", name: "x", operation: "add", suppressed: false, params: {}, ...over });

  it("shows the second depth only when extruding both ways", () => {
    expect(visibleParamKeys(f({ type: "extrude", extrude: { end: "blind", flip: false } })).has("depth2")).toBe(false);
    expect(visibleParamKeys(f({ type: "extrude", extrude: { end: "blind", flip: false, second: true } })).has("depth2")).toBe(true);
    expect(visibleParamKeys(f({ type: "extrude", extrude: { end: "symmetric", flip: false, second: true } })).has("depth2")).toBe(false);
  });

  it("shows the chamfer's second distance or angle only for those kinds", () => {
    const equal = visibleParamKeys(f({ type: "chamfer" }));
    expect([equal.has("distance"), equal.has("distance2"), equal.has("angle")]).toEqual([true, false, false]);
    const two = visibleParamKeys(f({ type: "chamfer", chamferType: "twoDistances" }));
    expect([two.has("distance2"), two.has("angle")]).toEqual([true, false]);
    const da = visibleParamKeys(f({ type: "chamfer", chamferType: "distanceAngle" }));
    expect([da.has("distance2"), da.has("angle")]).toEqual([false, true]);
  });

  it("hides the circular pattern's centre along its own axis", () => {
    const keys = visibleParamKeys(f({ type: "circularPattern", pattern: { sources: [], axis: "x", flip: false } }));
    expect([keys.has("cx"), keys.has("cy"), keys.has("cz")]).toEqual([false, true, true]);
  });
});
