import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument, previewFeatures, previewOf } from "../src/model/document";
import { visibleParamKeys } from "../src/model/features";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { HOLE_LEAD_IN, holeProfile, holeVolume, type HoleSize } from "../src/model/holes";
import { copyNumber, formatSkip, parseSkip, totalCopies } from "../src/model/patterns";

const roundTrip = (doc: JuraCADDocument) => parseDocument(JSON.parse(JSON.stringify(doc)));

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

describe("problems in boxes that aren't shown", () => {
  const f = (over: Partial<Feature> & Pick<Feature, "type">): Feature => ({ id: "x", name: "x", operation: "add", suppressed: false, params: {}, ...over });

  it("are ignored (the default is used), so the feature can still be accepted", async () => {
    const { resolveParams } = await import("../src/model/features");
    // Chamfer: the angle box was cleared, then the type set back to Equal.
    const equal = resolveParams(f({ type: "chamfer", params: { distance: "1", distance2: "2", angle: "" } }));
    expect(equal.errors).toEqual({});
    expect(equal.values.angle).toBe(30);
    expect(Object.keys(resolveParams(f({ type: "chamfer", chamferType: "distanceAngle", params: { distance: "1", angle: "" } })).errors)).toEqual(["angle"]);
    // Extrude: a second depth of 0, then the tick taken off.
    expect(resolveParams(f({ type: "extrude", extrude: { end: "blind", flip: false }, params: { depth: "5", depth2: "0" } })).errors).toEqual({});
    expect(Object.keys(resolveParams(f({ type: "extrude", extrude: { end: "blind", flip: false, second: true }, params: { depth: "5", depth2: "0" } })).errors)).toEqual(["depth2"]);
    // Circular pattern round Z: the hidden Z position uses a deleted variable.
    const round = resolveParams(f({ type: "circularPattern", pattern: { sources: [], axis: "z", flip: false }, params: { count: "4", angle: "360", cz: "gone * 2" } }));
    expect(round.errors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Round 2: holes, extrude ends, picked directions, skipped copies

describe("round 2 options are saved and opened again", () => {
  const face = { partId: "p1", ref: { kind: "face" as const, surface: "CYLINDRE", center: [1, 2, 3] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }, at: [0, -20, 10] as [number, number, number] };
  const edge = { partId: "p1", ref: { kind: "edge" as const, curve: "LINE", a: [0, 0, 0] as [number, number, number], b: [0, 10, 0] as [number, number, number], mid: [0, 5, 0] as [number, number, number] } };

  it("keeps the new extrude ends, the corner picked and the hole's thread options", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = addFeature(doc, box);
    const ends = ["upToNext", "upToVertex", "upToPart", "upToFace"] as const;
    const exs: Feature[] = ends.map((end) => ({ ...createFeature(doc, "extrude"), id: `ex-${end}`, extrude: { end, flip: false, upTo: end === "upToVertex" ? edge : face, ...(end === "upToVertex" ? { upToEnd: "b" as const } : {}) } }));
    const hole: Feature = { ...createFeature(doc, "hole"), hole: { kind: "simple", standard: "M4", fit: "tapped", end: "throughAll", flip: false, modelThread: true, bothWays: true }, params: { ...createFeature(doc, "hole").params, threadDepth: "6" } };
    for (const f of [...exs, hole]) doc = addFeature(doc, f);
    const saved = roundTrip(doc)!;
    const byId = (id: string) => saved.features.find((f) => f.id === id)!;
    for (const ex of exs) expect(byId(ex.id).extrude).toEqual(ex.extrude);
    expect(byId(hole.id).hole).toEqual(hole.hole);
    expect(byId(hole.id).params.threadDepth).toBe("6");
  });

  it("keeps a pattern's picked direction, second direction and skipped copies", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = addFeature(doc, box);
    const lp: Feature = { ...createFeature(doc, "linearPattern"), pattern: { sources: [box.id], axis: "x", flip: false, along: edge, along2: { ...edge, ref: { ...edge.ref, b: [10, 0, 0] } }, skip: [2, 5] } };
    const cp: Feature = { ...createFeature(doc, "circularPattern"), pattern: { sources: [box.id], axis: "z", flip: false, along: face, skip: [3] } };
    doc = addFeature(addFeature(doc, lp), cp);
    const saved = roundTrip(doc)!;
    expect(saved.features.find((f) => f.id === lp.id)!.pattern).toEqual(lp.pattern);
    expect(saved.features.find((f) => f.id === cp.id)!.pattern).toEqual(cp.pattern);
  });

  it("opens older holes and extrudes unchanged (nothing new switched on)", () => {
    let doc = emptyDocument();
    doc = addFeature(doc, createFeature(doc, "box"));
    const hole = createFeature(doc, "hole");
    const ex = createFeature(doc, "extrude");
    const raw = JSON.parse(JSON.stringify(addFeature(addFeature(doc, hole), ex)));
    // As saved before: no thread options, no offset or thread depth boxes.
    delete raw.features[1].params.threadDepth;
    delete raw.features[2].params.offset;
    const saved = parseDocument(raw)!;
    expect(saved.features[1].hole).toEqual({ ...(hole.hole?.sketchRef ? { sketchRef: hole.hole.sketchRef } : {}), kind: "simple", standard: "M3", fit: "clearance", end: "throughAll", flip: false });
    expect(saved.features[1].params.threadDepth).toBe("0");
    expect(saved.features[2].extrude).toEqual({ end: "blind", flip: false });
    expect(saved.features[2].params.offset).toBe("0");
  });

  it("drops nonsense skip numbers from a file", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = addFeature(doc, box);
    const raw = JSON.parse(JSON.stringify(addFeature(doc, { ...createFeature(doc, "linearPattern"), pattern: { sources: [box.id], axis: "x", flip: false } })));
    raw.features[1].pattern.skip = [5, 1, 0, 2.5, "3", 5, 2];
    expect(parseDocument(raw)!.features[1].pattern!.skip).toEqual([2, 5]);
  });
});

describe("round 2 size boxes", () => {
  const f = (over: Partial<Feature> & Pick<Feature, "type">): Feature => ({ id: "x", name: "x", operation: "add", suppressed: false, params: {}, ...over });
  const shows = (feature: Feature, key: string) => visibleParamKeys(feature).has(key);

  it("shows the offset only up to a face or corner, and the depth only for set depths", () => {
    for (const end of ["upToFace", "upToVertex"] as const) {
      expect(shows(f({ type: "extrude", extrude: { end, flip: false } }), "offset")).toBe(true);
      expect(shows(f({ type: "extrude", extrude: { end, flip: false } }), "depth")).toBe(false);
    }
    for (const end of ["blind", "symmetric", "throughAll", "upToNext", "upToPart"] as const) expect(shows(f({ type: "extrude", extrude: { end, flip: false } }), "offset")).toBe(false);
    for (const end of ["upToNext", "upToPart"] as const) {
      expect(shows(f({ type: "extrude", extrude: { end, flip: false } }), "depth")).toBe(false);
      expect(shows(f({ type: "extrude", extrude: { end, flip: false } }), "draft")).toBe(false);
    }
    expect(shows(f({ type: "extrude", extrude: { end: "upToVertex", flip: false } }), "draft")).toBe(true);
  });

  it("shows the thread depth only for tapped holes of a standard size, and no depth for up to next", () => {
    const hole = (h: Partial<NonNullable<Feature["hole"]>>) => f({ type: "hole", hole: { kind: "simple", standard: "M4", fit: "tapped", end: "blind", flip: false, ...h } });
    expect(shows(hole({}), "threadDepth")).toBe(true);
    expect(shows(hole({ fit: "clearance" }), "threadDepth")).toBe(false);
    expect(shows(hole({ standard: "Custom" }), "threadDepth")).toBe(false);
    expect(shows(hole({ end: "upToNext" }), "depth")).toBe(false);
    expect(shows(hole({ end: "blind" }), "depth")).toBe(true);
  });

  it("hides all of a circular pattern's centre boxes once the axis is clicked", () => {
    const along = { partId: "p", ref: { kind: "face" as const, surface: "CYLINDRE", center: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number] } };
    const keys = visibleParamKeys(f({ type: "circularPattern", pattern: { sources: [], axis: "z", flip: false, along } }));
    expect([keys.has("cx"), keys.has("cy"), keys.has("cz"), keys.has("count")]).toEqual([false, false, false, true]);
  });
});

describe("skipping pattern copies", () => {
  it("numbers copies from the original, row by row", () => {
    expect(copyNumber(0, 0, 4)).toBe(1);
    expect(copyNumber(3, 0, 4)).toBe(4);
    expect(copyNumber(0, 1, 4)).toBe(5);
    expect(copyNumber(2, 2, 4)).toBe(11);
    expect(totalCopies(4, 3)).toBe(12);
    expect(totalCopies(6)).toBe(6);
  });

  it("reads numbers and ranges, in any order", () => {
    expect(parseSkip("5, 2", 6)).toEqual({ skip: [2, 5] });
    expect(parseSkip("3-5 7", 8)).toEqual({ skip: [3, 4, 5, 7] });
    expect(parseSkip("6–4", 8)).toEqual({ skip: [4, 5, 6] });
    expect(parseSkip("  ", 8)).toEqual({ skip: [] });
  });

  it("explains numbers it can't use", () => {
    expect(parseSkip("1, 3", 6)).toEqual({ error: "Copy 1 is the original, so it can't be skipped. Start from 2." });
    expect(parseSkip("9", 6)).toEqual({ error: "There are only 6 copies (counting the original). Use numbers from 2 to 6." });
    expect(parseSkip("two", 6)).toEqual({ error: `"two" isn't a copy number. Type numbers like 2, 5 or a range like 3-6.` });
    expect(parseSkip("2-6", 6)).toEqual({ error: "That skips every copy, so the pattern would do nothing. Leave at least one out of the list." });
  });

  it("writes the list back out tidily", () => {
    expect(formatSkip([5, 2, 3, 4, 9, 10])).toBe("2–5, 9, 10");
    expect(formatSkip([])).toBe("");
    expect(formatSkip(undefined)).toBe("");
    expect(parseSkip(formatSkip([2, 3, 4, 7]), 8)).toEqual({ skip: [2, 3, 4, 7] });
  });
});

describe("hole shapes, round 2", () => {
  const size: HoleSize = { kind: "simple", diameter: 4, depth: 10, throughAll: false, throughLength: 0, cboreDiameter: 8, cboreDepth: 3, cskDiameter: 8, cskAngle: 90 };

  it("runs a through-all hole back the other way from the sketch too", () => {
    const pts = holeProfile({ ...size, throughAll: true, throughLength: 30, backLength: 30 });
    expect(pts).toEqual([[0, -30], [2, -30], [2, 30], [0, 30]]);
    // Only what's past the sketch counts as drilled below it.
    expect(holeVolume({ ...size, throughAll: true, throughLength: 30, backLength: 30 })).toBeCloseTo(Math.PI * 4 * 30, 9);
    const cb = holeProfile({ ...size, kind: "counterbore", throughAll: true, throughLength: 30, backLength: 30 });
    expect(cb).toEqual([[0, -30], [2, -30], [2, -HOLE_LEAD_IN], [4, -HOLE_LEAD_IN], [4, 3], [2, 3], [2, 30], [0, 30]]);
  });

  it("ends flat (no drill point) when asked, for up to next", () => {
    expect(holeProfile({ ...size, flatBottom: true })).toEqual([[0, -HOLE_LEAD_IN], [2, -HOLE_LEAD_IN], [2, 10], [0, 10]]);
    expect(holeVolume({ ...size, flatBottom: true })).toBeCloseTo(Math.PI * 4 * 10, 9);
  });
});

describe("previewing a hole with a modelled thread", () => {
  it("shows the plain hole while the dialog is open (the thread is cut on Accept)", () => {
    const doc = emptyDocument();
    const hole: Feature = { ...createFeature(doc, "hole"), hole: { kind: "simple", standard: "M4", fit: "tapped", end: "blind", flip: false, modelThread: true } };
    expect(previewOf(hole)?.hole).toEqual({ kind: "simple", standard: "M4", fit: "tapped", end: "blind", flip: false });
    const plain = createFeature(doc, "box");
    expect(previewOf(plain)).toBe(plain);
    expect(previewOf(null)).toBeNull();
    // Every hole in the list, while something is being edited; a list with none is passed straight through.
    const list = [plain, hole];
    expect(previewFeatures(list).map((f) => !!f.hole?.modelThread)).toEqual([false, false]);
    expect(previewFeatures([plain])).toEqual([plain]);
  });
});
