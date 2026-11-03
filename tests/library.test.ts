import { describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { studioFeatures, studiosOf, MAIN_STUDIO } from "../src/model/studios";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { evaluate } from "../src/model/expr";
import { bracketHoleSpots } from "../src/library/designs/bracket";
import { lensArea } from "../src/library/designs/knob";
import { roundedRectArea } from "../src/library/designs/common";
import { completeValues, currentValues, defaultValues, editInsert, findDesign, freePrefix, insertDesign, inputProblem, LIBRARY, liveInserts, valueProblems } from "../src/library/insert";
import { freedomOf } from "../src/library/sketchKit";
import { analyzeSketch } from "../src/sketch/solver";
import type { JuraCADDocument } from "../src/model/types";

const design = (id: string) => findDesign(id)!;

describe("the library", () => {
  it("has each design described, with an icon, inputs and working defaults", () => {
    expect(LIBRARY.map((d) => d.id)).toEqual(["finger-box", "tray", "bracket", "spacer", "knob"]);
    for (const d of LIBRARY) {
      expect(d.name.length).toBeGreaterThan(3);
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.icon).toMatch(/^</);
      expect(new Set(d.inputs.map((i) => i.key)).size).toBe(d.inputs.length);
      expect(valueProblems(d, defaultValues(d))).toEqual([]);
      expect(d.preview(defaultValues(d)).length).toBeGreaterThan(0);
      for (const i of d.inputs) if (i.kind === "length" || i.kind === "count") expect(i.min).toBeDefined();
    }
  });

  it("checks values in plain words", () => {
    const box = design("finger-box");
    const width = box.inputs.find((i) => i.key === "width")!;
    expect(inputProblem(width, 5)).toMatch(/at least 10 mm/);
    expect(inputProblem(width, "abc")).toMatch(/type a number/);
    expect(valueProblems(box, { ...defaultValues(box), thickness: 20, width: 50 })[0]).toMatch(/too small/);
    expect(valueProblems(design("tray"), { ...defaultValues(design("tray")), floor: 40 })[0]).toMatch(/floor/);
    expect(valueProblems(design("knob"), { ...defaultValues(design("knob")), grips: 40, grip: 8 })[0]).toMatch(/don't fit/);
    expect(completeValues(box, { width: "150", lid: false })).toMatchObject({ width: 150, lid: false, depth: 80 });
  });
});

describe("inserting a design", () => {
  it("adds prefixed variables and features in a new Part Studio named after it, all fully defined", () => {
    const box = design("finger-box");
    const r = insertDesign(emptyDocument(), box, defaultValues(box), { into: "new", studioId: "s1" });
    expect(r.studioId).toBe("s1");
    expect(studiosOf(r.doc).map((s) => s.name)).toEqual(["Part Studio 1", "Finger-joint box"]);
    expect(r.doc.variables!.map((v) => v.name)).toEqual(["box_width", "box_depth", "box_height", "box_thickness", "box_kerf"]);
    const features = studioFeatures(r.doc, "s1");
    expect(features.map((f) => f.name)).toEqual(["Bottom sketch", "Bottom", "Lid", "Front sketch", "Front", "Back", "Left side sketch", "Left side", "Right side"]);
    expect(features.every((f) => f.folder === "Finger-joint box")).toBe(true);
    expect(r.insert.features).toEqual(features.map((f) => f.id));
    for (const f of features.filter((x) => x.type === "sketch")) {
      expect(freedomOf(f.sketch!.data)).toBe(0);
      expect(f.sketch!.data.constraints.some((c) => c.value?.includes("box_width") || c.value?.includes("box_depth"))).toBe(true);
    }
    expect(Object.values(r.doc.partNames!)).toEqual(["Finger-joint box bottom", "Finger-joint box lid", "Finger-joint box front", "Finger-joint box back", "Finger-joint box left side", "Finger-joint box right side"]);
    expect(studioFeatures(r.doc, MAIN_STUDIO)).toEqual([]);
  });

  it("gives a second insert its own variables, so the two don't clash", () => {
    const box = design("finger-box");
    const one = insertDesign(emptyDocument(), box, defaultValues(box), { into: MAIN_STUDIO }).doc;
    expect(freePrefix(one, "box")).toBe("box2");
    const two = insertDesign(one, box, { ...defaultValues(box), width: 200 }, { into: MAIN_STUDIO });
    expect(two.insert.prefix).toBe("box2");
    expect(two.insert.name).toBe("Finger-joint box 2");
    const names = two.doc.variables!.map((v) => v.name);
    expect(names).toContain("box2_width");
    expect(new Set(names).size).toBe(names.length);
    const features = two.doc.features;
    expect(new Set(features.map((f) => f.id)).size).toBe(features.length);
    expect(new Set(features.map((f) => f.name)).size).toBe(features.length);
    expect(resolveVariables(two.doc.variables).values.box2_width).toBe(200);
    expect(liveInserts(two.doc)).toHaveLength(2);
  });

  it("follows a changed variable: the sketches are solved again", () => {
    const box = design("finger-box");
    const r = insertDesign(emptyDocument(), box, defaultValues(box), { into: MAIN_STUDIO });
    const vars = r.doc.variables!.map((v) => (v.name === "box_width" ? { ...v, value: "150" } : v));
    const next = applyVariables(r.doc, vars);
    const bottom = next.features.find((f) => f.name === "Bottom sketch")!.sketch!.data;
    expect(Math.max(...bottom.points.map((p) => p.x))).toBeCloseTo(150, 6);
    expect(analyzeSketch(bottom).freedom).toBe(0);
    expect(currentValues(next, r.insert).width).toBe(150);
  });

  it("can be changed again (Edit design sizes): same ids, new fingers and no lid", () => {
    const box = design("finger-box");
    const r = insertDesign(emptyDocument(), box, defaultValues(box), { into: MAIN_STUDIO });
    const bottomId = r.doc.features.find((f) => f.name === "Bottom")!.id;
    const renamed: JuraCADDocument = { ...r.doc, features: r.doc.features.map((f) => (f.id === bottomId ? { ...f, name: "Floor" } : f)) };
    const edited = editInsert(renamed, r.insert.id, { ...currentValues(renamed, r.insert), lid: false, finger: 20, width: 140 });
    expect(edited.features.map((f) => f.name)).toEqual(["Bottom sketch", "Floor", "Front sketch", "Front", "Back", "Left side sketch", "Left side", "Right side"]);
    expect(edited.features.find((f) => f.name === "Floor")!.id).toBe(bottomId);
    expect(edited.variables!.find((v) => v.name === "box_width")!.value).toBe("140");
    expect(edited.libraryInserts![0].values.lid).toBe(false);
    expect(edited.libraryInserts![0].features).toHaveLength(8);
    // Fewer, wider fingers: fewer corners in the bottom's outline.
    const corners = (d: JuraCADDocument) => d.features.find((f) => f.name === "Bottom sketch")!.sketch!.data.points.length;
    expect(corners(edited)).toBeLessThan(corners(r.doc));
    expect(() => editInsert(edited, r.insert.id, { ...currentValues(edited, r.insert), thickness: 40 })).toThrow(/at most 25 mm/);
  });

  it("is saved in the file, and older files open as before", () => {
    const box = design("tray");
    const r = insertDesign(emptyDocument(), box, defaultValues(box), { into: "new" });
    const back = readDocumentFile(serializeDocument(r.doc));
    if (!back.ok) throw new Error(back.error);
    expect(back.doc.libraryInserts).toEqual(r.doc.libraryInserts);
    const old = readDocumentFile(serializeDocument(emptyDocument()));
    if (!old.ok) throw new Error(old.error);
    expect(old.doc.libraryInserts).toBeUndefined();
  });

  for (const d of LIBRARY) {
    it(`${d.name}: every sketch is fully defined by the variables`, () => {
      const r = insertDesign(emptyDocument(), d, defaultValues(d), { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      for (const f of r.doc.features) {
        if (f.sketch) expect(freedomOf(f.sketch.data)).toBe(0);
        for (const v of Object.values(f.params)) expect(evaluate(v, scope).ok).toBe(true);
      }
    });
  }
});

describe("design maths", () => {
  it("places bracket holes in the middle of each arm's free part", () => {
    expect(bracketHoleSpots(60, 4, 25, 2)).toEqual([19.5, 44.5]);
    expect(bracketHoleSpots(60, 4, 25, 1)).toEqual([32]);
    expect(bracketHoleSpots(60, 4, 25, 0)).toEqual([]);
  });
  it("works out the areas used to check volumes", () => {
    expect(roundedRectArea(10, 10, 5)).toBeCloseTo(Math.PI * 25, 9);
    expect(lensArea(10, 2, 30)).toBe(0);
    expect(lensArea(10, 2, 0)).toBeCloseTo(Math.PI * 4, 9);
    // Half a small circle sits inside when its centre is on a big one's edge (nearly, for a big radius).
    expect(lensArea(1000, 2, 1000)).toBeCloseTo(Math.PI * 2, 2);
  });
});
