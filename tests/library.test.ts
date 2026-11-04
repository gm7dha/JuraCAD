import { describe, expect, it } from "vitest";
import { createFeature, emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { studioFeatures, studiosOf, MAIN_STUDIO } from "../src/model/studios";
import { applyVariables, resolveVariables } from "../src/model/variables";
import { evaluate, getCurrentScope, setCurrentScope } from "../src/model/expr";
import { bracketHoleSpots } from "../src/library/designs/bracket";
import { lensArea } from "../src/library/designs/knob";
import { roundedRectArea } from "../src/library/designs/common";
import { categoryFrom, categoryLabel, completeValues, currentValues, defaultValues, designsIn, editInsert, findDesign, freePrefix, insertDesign, inputProblem, LIBRARY, LIBRARY_CATEGORIES, liveInserts, valueProblems } from "../src/library/insert";
import { LIBRARY_TAB_KEY, rememberedTab, rememberTab } from "../src/library/tabMemory";
import { agrees, lit, minus, neg, plus, signed, wholeNegation } from "../src/library/ex";
import { boxLidSizes, boxLidVolumes } from "../src/library/designs/boxLid";
import { clipSizes } from "../src/library/designs/cableClip";
import { circleBand, circleSegment, countersunkHoleVolume, polygonArea, varsOf } from "../src/library/designs/common";
import { flatStandAreas, flatStandShapes } from "../src/library/designs/flatStand";
import { hingeSizes, hingeVolumes } from "../src/library/designs/hinge";
import { hookHoleHeights, hookOutline } from "../src/library/designs/hook";
import { standFootprint, standProfileArea } from "../src/library/designs/phoneStand";
import { standProfile, trigOf } from "../src/library/designs/standProfile";
import { DEFAULT_FITS } from "../src/model/printSettings";
import { freedomOf } from "../src/library/sketchKit";
import { previewPicture } from "../src/library/preview";
import { analyzeSketch } from "../src/sketch/solver";
import type { JuraCADDocument } from "../src/model/types";
import type { DesignValues } from "../src/library/types";

const design = (id: string) => findDesign(id)!;

describe("the library", () => {
  it("has each design described, with an icon, inputs and working defaults", () => {
    expect(LIBRARY.map((d) => d.id)).toEqual(["finger-box", "flat-stand", "tray", "box-lid", "bracket", "hook", "cable-clip", "phone-stand", "hinge", "spacer", "knob", "bolt-set", "standoff", "piano-hinge", "jar", "bit-holder", "pegboard-hook", "drawer-pull", "grommet", "corner-guard"]);
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
    setCurrentScope(resolveVariables(r.doc.variables).values);
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
    const edited = editInsert(renamed, r.insert.id, { ...currentValues(renamed, r.insert), lid: false, finger: 20, width: 140 }).doc;
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

  it("Edit design sizes leaves the user's own features where they were, and keeps suppressed and hidden", () => {
    const box = design("finger-box");
    const r = insertDesign(emptyDocument(), box, defaultValues(box), { into: MAIN_STUDIO });
    const mine = { ...createFeature(r.doc, "box"), id: "mine", name: "My block", operation: "new" as const };
    // My block goes after the bottom; the front sketch is hidden, the back suppressed.
    const at = r.doc.features.findIndex((f) => f.name === "Bottom") + 1;
    let doc: JuraCADDocument = { ...r.doc, features: [...r.doc.features.slice(0, at), mine, ...r.doc.features.slice(at)] };
    doc = { ...doc, features: doc.features.map((f) => (f.name === "Front sketch" ? { ...f, visible: false } : f.name === "Back" ? { ...f, suppressed: true } : f)) };
    const before = doc.features.map((f) => f.id);
    const e = editInsert(doc, r.insert.id, { ...currentValues(doc, r.insert), finger: 15 });
    expect(e.doc.features.map((f) => f.id)).toEqual(before);
    expect(e.remade).toEqual([]);
    expect(e.doc.features.find((f) => f.name === "Front sketch")!.visible).toBe(false);
    expect(e.doc.features.find((f) => f.name === "Back")!.suppressed).toBe(true);
    expect(e.doc.features.find((f) => f.id === "mine")).toBe(mine);
    // A feature the user deleted comes back where it was, and is named.
    const lidId = doc.features.find((f) => f.name === "Lid")!.id;
    const without = { ...doc, features: doc.features.filter((f) => f.id !== lidId) };
    const back = editInsert(without, r.insert.id, currentValues(without, r.insert));
    expect(back.remade).toEqual(["Lid"]);
    expect(back.doc.features.map((f) => f.id)).toEqual(before);
    // Turning the lid off and on again puts it back after the bottom too.
    const off = editInsert(doc, r.insert.id, { ...currentValues(doc, r.insert), lid: false }).doc;
    const on = editInsert(off, r.insert.id, { ...currentValues(off, r.insert), lid: true });
    expect(on.remade).toEqual([]);
    expect(on.doc.features.map((f) => f.id)).toEqual(before);
  });

  it("Edit design sizes keeps sketch ids, and follows a renamed variable", () => {
    const box = design("finger-box");
    const r = insertDesign(emptyDocument(), box, defaultValues(box), { into: MAIN_STUDIO });
    const ids = (d: JuraCADDocument) => d.features.filter((f) => f.sketch).map((f) => [...f.sketch!.data.points.map((p) => p.id), ...f.sketch!.data.curves.map((c) => c.id)].join(","));
    const vars = r.doc.variables!.map((v) => (v.name === "box_width" ? { ...v, name: "shelf_width" } : v));
    const renamed = applyVariables(r.doc, vars);
    expect(currentValues(renamed, r.insert).width).toBe(120);
    const e = editInsert(renamed, r.insert.id, { ...currentValues(renamed, r.insert), width: 130 }).doc;
    expect(ids(e)).toEqual(ids(r.doc));
    expect(e.variables!.map((v) => v.name)).toEqual(["shelf_width", "box_depth", "box_height", "box_thickness", "box_kerf"]);
    expect(e.variables![0].value).toBe("130");
    expect(e.features.some((f) => f.sketch?.data.constraints.some((c) => c.value?.includes("box_width")))).toBe(false);
  });

  it("leaves the expression scope as it was when an insert fails", () => {
    setCurrentScope({ wall: 2 });
    const box = design("finger-box");
    expect(() => insertDesign(emptyDocument(), box, { ...defaultValues(box), finger: -1 }, { into: MAIN_STUDIO })).toThrow();
    insertDesign(emptyDocument(), box, defaultValues(box), { into: MAIN_STUDIO });
    expect(getCurrentScope()).toEqual({ wall: 2 });
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

  // Each design with its defaults, and with its other choices (the ones Edit design sizes changes).
  const variants: [string, DesignValues][] = [
    ...LIBRARY.map((d): [string, DesignValues] => [d.id, {}]),
    ["box-lid", { placement: "on" }],
    ["hook", { holes: "1" }],
    ["cable-clip", { fixing: "tape" }],
    ["phone-stand", { angle: 45 }],
    ["phone-stand", { angle: 85 }],
    ["flat-stand", { angle: 50 }],
    ["hinge", { knuckles: 3 }],
    ["hinge", { knuckles: 9 }],
  ];
  for (const [id, extra] of variants) {
    const d = findDesign(id)!;
    it(`${d.name}${Object.keys(extra).length ? ` (${JSON.stringify(extra)})` : ""}: every sketch is fully defined by the variables`, () => {
      const values = { ...defaultValues(d), ...extra } as DesignValues;
      expect(valueProblems(d, values)).toEqual([]);
      const r = insertDesign(emptyDocument(), d, values, { into: MAIN_STUDIO });
      const scope = resolveVariables(r.doc.variables).values;
      setCurrentScope(scope);
      for (const f of r.doc.features) {
        if (f.sketch) expect(freedomOf(f.sketch.data)).toBe(0);
        for (const v of Object.values(f.params)) expect(evaluate(v, scope).ok).toBe(true);
      }
    });
  }
});

describe("previews", () => {
  it("fit each design's drawing into a picture, y up", () => {
    for (const d of LIBRARY) {
      const pic = previewPicture(d.preview(defaultValues(d)))!;
      expect(pic.viewBox.split(" ").map(Number).every(Number.isFinite)).toBe(true);
      expect(pic.stroke).toBeGreaterThan(0);
    }
    const pic = previewPicture([{ kind: "poly", closed: true, points: [[0, 0], [10, 0], [10, 20]] }])!;
    expect(pic.shapes[0]).toEqual({ kind: "poly", closed: true, points: [[0, -0], [10, -0], [10, -20]] });
    expect(previewPicture([])).toBeNull();
  });
  it("show the finger box's panels laid flat, ready to cut", () => {
    const box = design("finger-box");
    const shapes = box.preview(defaultValues(box));
    expect(shapes.filter((s) => s.kind === "poly")).toHaveLength(6);
    expect(box.preview({ ...defaultValues(box), lid: false }).filter((s) => s.kind === "poly")).toHaveLength(5);
    expect(box.summary!(defaultValues(box))).toMatch(/6 panels; 13 fingers along the width/);
  });
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

describe("library sections", () => {
  it("puts every design in Laser cutting or 3D printing, laser first", () => {
    expect(LIBRARY_CATEGORIES.map((c) => [c.id, c.label])).toEqual([
      ["laser", "Laser cutting"],
      ["print", "3D printing"],
    ]);
    expect(designsIn("laser").map((d) => d.id)).toEqual(["finger-box", "flat-stand"]);
    expect(designsIn("print").map((d) => d.id)).toEqual(["tray", "box-lid", "bracket", "hook", "cable-clip", "phone-stand", "hinge", "spacer", "knob", "bolt-set", "standoff", "piano-hinge", "jar", "bit-holder", "pegboard-hook", "drawer-pull", "grommet", "corner-guard"]);
    expect(designsIn("laser").length + designsIn("print").length).toBe(LIBRARY.length);
    expect(categoryLabel("print")).toBe("3D printing");
    expect(categoryFrom("Laser cutting")).toBe("laser");
    expect(categoryFrom(" PRINT ")).toBe("print");
    expect(categoryFrom("3d")).toBe("print");
    expect(categoryFrom("wood")).toBeNull();
    expect(categoryFrom(3)).toBeNull();
  });

  it("remembers the last tab per browser, and copes without storage", () => {
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(rememberedTab(store)).toBe("print");
    rememberTab("laser", store);
    expect(rememberedTab(store)).toBe("laser");
    rememberTab("print", store);
    expect(kept.get(LIBRARY_TAB_KEY)).toBe("print");
    expect(rememberedTab(store)).toBe("print");
    kept.set(LIBRARY_TAB_KEY, "nonsense");
    expect(rememberedTab(store)).toBe("print");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(rememberedTab(broken)).toBe("print");
    rememberTab("laser", broken);
    expect(rememberedTab(null)).toBe("print");
  });

  it("older files' inserts don't need a section", () => {
    const tray = findDesign("tray")!;
    const r = insertDesign(emptyDocument(), tray, defaultValues(tray), { into: MAIN_STUDIO });
    expect(Object.keys(r.insert)).not.toContain("category");
  });
});

describe("sizes as expressions", () => {
  it("only takes off brackets that wrap the whole thing", () => {
    expect(wholeNegation("-(a + b)")).toBe("a + b");
    expect(wholeNegation("-(a) - (b)")).toBeNull();
    expect(wholeNegation("-(a + (b - c))")).toBe("a + (b - c)");
    expect(wholeNegation("a")).toBeNull();
    const scope = { a: 2, b: 3 };
    const e = minus(neg({ t: "a", v: 2 }), { t: "b", v: 3 });
    expect(e.t).toBe("-(a) - b");
    const both = minus(neg(plus({ t: "a", v: 2 }, lit(1))), plus({ t: "b", v: 3 }, lit(1)));
    const s = signed(both);
    expect(s.sign).toBe(-1);
    expect(agrees({ t: s.text, v: -both.v }, scope)).toBe(true);
  });
});

describe("new designs' maths", () => {
  it("box with lid: the lid's inside is the box's outside + 2 × clearance (the snug printed fit)", () => {
    const d = findDesign("box-lid")!;
    expect(d.inputs.find((i) => i.key === "clearance")!.default).toBe(DEFAULT_FITS.snug);
    const v = defaultValues(d);
    const s = boxLidSizes(varsOf(v, ["width", "depth", "height", "wall", "lid", "clearance", "radius"]));
    expect(s.lidInner.w.v).toBeCloseTo(80 + 2 * DEFAULT_FITS.snug, 9);
    expect(s.lidInner.d.v).toBeCloseTo(60 + 2 * DEFAULT_FITS.snug, 9);
    expect(s.lidInner.r.v).toBeCloseTo(5 + DEFAULT_FITS.snug, 9);
    expect(s.lidOuter.w.v).toBeCloseTo(84.4, 9);
    const r = insertDesign(emptyDocument(), d, v, { into: MAIN_STUDIO });
    const lidSides = r.doc.features.find((f) => f.name === "Lid sides sketch")!;
    expect(lidSides.sketch!.data.constraints.some((c) => c.value === "lidbox_width + 2 * lidbox_clearance")).toBe(true);
    const vol = boxLidVolumes(v);
    expect(vol.box).toBeGreaterThan(0);
    expect(valueProblems(d, { ...v, lid: 45 })[0]).toMatch(/lid's sides/);
    expect(valueProblems(d, { ...v, lid: 2 })[0]).toMatch(/taller than its top/);
    expect(d.summary!(v)).toMatch(/2 parts/);
  });

  it("hook: a J outline and holes spread up the back plate", () => {
    const v = varsOf(defaultValues(findDesign("hook")!), ["depth", "height", "width", "thickness", "tip", "hole"]);
    const pts = hookOutline(v).map(([x, y]) => [x.v, y.v]);
    expect(pts).toEqual([[-5, 0], [35, 0], [35, 15], [30, 15], [30, 5], [0, 5], [0, 60], [-5, 60]]);
    expect(polygonArea(pts as [number, number][])).toBeCloseTo(40 * 5 + 5 * 10 + 5 * 55, 9);
    expect(hookHoleHeights(v, 2).map((e) => e.v)).toEqual([5 + 55 / 3, 5 + 110 / 3]);
    expect(hookHoleHeights(v, 1).map((e) => e.v)).toEqual([32.5]);
    const hook = findDesign("hook")!;
    expect(valueProblems(hook, { ...defaultValues(hook), width: 8 })[0]).toMatch(/countersinks/);
    expect(valueProblems(hook, { ...defaultValues(hook), depth: 12 })[0]).toMatch(/three times/);
  });

  it("countersinks, circle bands and segments", () => {
    // A 90° countersink twice the hole's size: the cone is as deep as the hole's radius.
    expect(countersunkHoleVolume(4, 8, 5)).toBeCloseTo(Math.PI * 4 * 5 + (Math.PI * 2 * (16 + 8 + 4)) / 3 - Math.PI * 4 * 2, 9);
    expect(circleBand(5, 5)).toBeCloseTo((Math.PI * 25) / 2, 9);
    expect(circleSegment(5, 0)).toBeCloseTo((Math.PI * 25) / 2, 9);
    expect(circleSegment(5, 5)).toBeCloseTo(0, 9);
  });

  it("cable clip: the ring grips the cable and sinks half its wall into the base", () => {
    const d = findDesign("cable-clip")!;
    const s = clipSizes(varsOf(defaultValues(d), ["cable", "opening", "ring", "width", "base", "hole"]));
    expect(s.inner.v).toBe(3);
    expect(s.outer.v).toBe(5);
    expect(s.cx.v).toBe(4);
    expect(s.baseHigh(true).v).toBe(5 + 11);
    expect(s.baseHigh(false).v).toBe(5);
    expect(valueProblems(d, { ...defaultValues(d), opening: 7 })[0]).toMatch(/smaller than the cable/);
    expect(valueProblems(d, { ...defaultValues(d), fixing: "tape", width: 4 })).toEqual([]);
    expect(valueProblems(d, { ...defaultValues(d), width: 4 })[0]).toMatch(/countersink/);
  });

  it("stands: the profile leans at the angle and the slot is the device's thickness square to it", () => {
    const { sin, cos } = trigOf(65);
    expect(sin).toBe(0.906308);
    expect(cos).toBe(0.422618);
    const p = standProfile({ angle: 65, slot: lit(12), lip: lit(12), back: lit(90), bar: lit(5) });
    const [x, y] = p.outline.map(([a, b]) => [a.v, b.v]);
    expect(x).toEqual([-(90 * cos + 5 * sin), 0]);
    // The back rest's front face runs from the slot's back corner at the angle.
    const top = p.outline[6].map((e) => e.v);
    expect(Math.atan2(top[1] - 5, -top[0]) * (180 / Math.PI)).toBeCloseTo(65, 4);
    // The slot is 12 mm square to the device: 12 / sin(65°) along the table.
    expect(p.slotFront.v).toBeCloseTo(12 / sin, 5);
    expect(y).toEqual([p.lipFront.v, 0]);
    const v = defaultValues(findDesign("phone-stand")!);
    expect(standFootprint(v)).toBeCloseTo(p.lipFront.v - p.rear.v, 9);
    expect(standProfileArea(v)).toBeGreaterThan(0);
    const stand = findDesign("phone-stand")!;
    expect(valueProblems(stand, { ...v, angle: 85, back: 30 })[0]).toMatch(/too short/);
    expect(inputProblem(stand.inputs[0], 40)).toMatch(/at least 45/);
  });

  it("flat-pack stand: the front foot is right under the slot, so the phone stands on it", () => {
    const v = defaultValues(findDesign("flat-stand")!);
    const s = flatStandShapes(v);
    const pts = s.profile.map(([a, b]) => [a.v, b.v]);
    // The slot's floor runs from its back corner (the origin, x = 0) to slotFront, one bar (15 mm) up: the front notch
    // (x 0…3) is under it, so the foot's top (15 mm) is level with the floor across its whole length.
    expect(s.slotFront.v).toBeGreaterThan(3);
    const has = (x: number, y: number) => pts.some(([a, b]) => Math.abs(a - x) < 1e-9 && Math.abs(b - y) < 1e-9);
    expect(has(0, 15)).toBe(true);
    expect(has(s.slotFront.v, 15)).toBe(true);
    expect(s.foot.map(([, z]) => z.v).every((z) => z <= 15)).toBe(true);
    const fs = findDesign("flat-stand")!;
    expect(valueProblems(fs, { ...v, slot: 3, thickness: 6, bar: 16 })[0]).toMatch(/slot is too narrow/);
  });

  it("flat-pack stand: the slots are drawn the kerf narrower", () => {
    const v = { ...defaultValues(findDesign("flat-stand")!), kerf: 0.2 };
    const s = flatStandShapes(v);
    const pts = s.profile.map(([a, b]) => [a.v, b.v]);
    expect(pts.slice(5, 9).map(([a, b]) => [Math.round(a * 1000) / 1000, b])).toEqual([[0.1, 0], [0.1, 7.5], [2.9, 7.5], [2.9, 0]]);
    const foot = s.foot.map(([a, b]) => [Math.round(a.v * 1000) / 1000, b.v]);
    expect(foot.slice(3, 7)).toEqual([[2.9, 15], [2.9, 7.5], [0.1, 7.5], [0.1, 15]]);
    const r = insertDesign(emptyDocument(), findDesign("flat-stand")!, v, { into: MAIN_STUDIO });
    expect(r.doc.variables!.find((x) => x.name === "fstand_kerf")!.value).toBe("0.2");
  });

  it("flat-pack stand: the feet's notches and the side's line up, each half the bar deep", () => {
    const v = defaultValues(findDesign("flat-stand")!);
    const s = flatStandShapes(v);
    const pts = s.profile.map(([a, b]) => [a.v, b.v]);
    // The front notch is at the origin, the sheet's thickness wide and half the bar high.
    expect(pts.slice(5, 9)).toEqual([[0, 0], [0, 7.5], [3, 7.5], [3, 0]]);
    expect(pts[2][1]).toBe(7.5);
    expect(pts[3][0] - pts[2][0]).toBeCloseTo(3, 9);
    expect(s.backAt.v).toBeCloseTo(pts[1][0], 9);
    const foot = s.foot.map(([a, b]) => [a.v, b.v]);
    expect(foot).toEqual([[-38.5, 0], [41.5, 0], [41.5, 15], [3, 15], [3, 7.5], [0, 7.5], [0, 15], [-38.5, 15]]);
    expect(flatStandAreas(v).foot).toBeCloseTo(80 * 15 - 3 * 7.5, 9);
    const fs = findDesign("flat-stand")!;
    expect(valueProblems(fs, { ...v, bar: 6 })[0]).toMatch(/at least 8 mm/);
  });

  it("hinge: equal knuckles with a clearance between, odd counts only", () => {
    const d = findDesign("hinge")!;
    const v = defaultValues(d);
    const s = hingeSizes(varsOf(v, ["length", "leaf", "thickness", "pin", "clearance"]), 5);
    expect(s.k.v).toBeCloseTo((50 - 4 * 0.4) / 5, 9);
    expect(s.start(4).v + s.k.v).toBeCloseTo(50, 9);
    expect(s.start(1).v - (s.start(0).v + s.k.v)).toBeCloseTo(0.4, 9);
    expect(s.slotLength.v).toBeCloseTo(s.k.v + 0.8, 9);
    expect(valueProblems(d, { ...v, knuckles: 4 })[0]).toMatch(/odd/);
    expect(valueProblems(d, { ...v, pin: 6 })[0]).toMatch(/walls/);
    expect(valueProblems(d, { ...v, knuckles: 15, length: 20 })[0]).toMatch(/only/);
    expect(d.summary!(v)).toMatch(/leaf 1 has 3 knuckles and leaf 2 has 2/);
    const vol = hingeVolumes(v);
    expect(vol.pin).toBeCloseTo(Math.PI * 1.5 * 1.5 * 50, 9);
    expect(vol.leaf1).toBeGreaterThan(vol.leaf2);
  });
});
