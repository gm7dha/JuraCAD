/**
 * One sketch, several shapes, each used by its own feature (as in Onshape):
 * which areas other features use, what a new feature starts with, clicking
 * areas of any sketch (hidden ones too) while a feature is open, and selecting
 * areas before choosing Extrude.
 */
import { describe, expect, it } from "vitest";

import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { sketchVisible, usedSketches } from "../src/model/visibility";
import {
  areaClickChange,
  areaClickMode,
  areaShades,
  areasTaken,
  clickableAreaSketches,
  freeAreas,
  selectArea,
  selectedAreaShades,
} from "../src/sketch/areaClicks";
import { areasUsedByAll, pickedAreas, pickOf, sketchAreas } from "../src/sketch/areas";
import { addCircle, addRectangle } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
/** The owner's example: a small circle (r 5) at the origin and a big one (r 15) at x = 40. */
function twoCircles(): SketchData {
  const s = addCircle(emptySketch(), at(0, 0), 5).sketch;
  return addCircle(s, at(40, 0), 15).sketch;
}
const sketch = (id: string, data: SketchData, extra: Partial<Feature> = {}): Feature => ({
  id,
  name: `Sketch ${id}`,
  type: "sketch",
  operation: "new",
  suppressed: false,
  params: {},
  sketch: { plane: { kind: "default", name: "Top" }, data },
  ...extra,
});
const extrude = (id: string, sketchRef: string | undefined, areas?: Feature["areas"], extra: Partial<Feature> = {}): Feature => ({
  id,
  name: `Extrude ${id}`,
  type: "extrude",
  operation: "new",
  suppressed: false,
  params: { ...defaultParams("extrude"), depth: "10" },
  ...(sketchRef ? { sketchRef } : {}),
  extrude: { end: "blind", flip: false },
  ...(areas ? { areas } : {}),
  ...extra,
});
const indexAt = (data: SketchData, x: number, y: number) => sketchAreas(data).areaAt([x, y]);
const pickAt = (data: SketchData, x: number, y: number) => pickOf(sketchAreas(data).areas[indexAt(data, x, y)]);

describe("areas other features already use", () => {
  const data = twoCircles();
  const small = indexAt(data, 0, 0);
  const big = indexAt(data, 40, 0);

  it("'every closed shape' covers both circles (each is its own shape, not a hole)", () => {
    expect(sketchAreas(data).areas).toHaveLength(2);
    expect([...areasUsedByAll(data)].sort()).toEqual([0, 1]);
    // And with a circle inside a rectangle, only the plate (the circle is a hole).
    const plate = addCircle(addRectangle(emptySketch(), at(0, 0), at(40, 30)).sketch, at(20, 15), 5).sketch;
    expect([...areasUsedByAll(plate)]).toEqual([indexAt(plate, 2, 2)]);
  });

  it("Extrude 1 picked the small circle: it shows as used by another feature in Extrude 2", () => {
    const features = [sketch("s1", data), extrude("e1", "s1", [pickAt(data, 0, 0)])];
    const taken = areasTaken(features, "s1", data, "e2");
    expect([...taken]).toEqual([small]);
    // Extrude 2 with the big circle picked: big strong, small grey.
    const shades = areaShades(data, [pickAt(data, 40, 0)], taken);
    expect(shades[big]).toBe("picked");
    expect(shades[small]).toBe("taken");
    // Extrude 1 itself (being edited) doesn't count against itself.
    expect(areasTaken(features, "s1", data, "e1").size).toBe(0);
  });

  it("an extrude with nothing picked takes every closed shape; suppressed, surface and other sketches' features don't count", () => {
    const all = areasTaken([sketch("s1", data), extrude("e1", "s1")], "s1", data);
    expect([...all].sort()).toEqual([0, 1]);
    expect(areasTaken([sketch("s1", data), extrude("e1", "s1", undefined, { suppressed: true })], "s1", data).size).toBe(0);
    expect(areasTaken([sketch("s1", data), extrude("e1", "s1", undefined, { surface: true })], "s1", data).size).toBe(0);
    expect(areasTaken([sketch("s1", data), extrude("e1", "s2")], "s1", data).size).toBe(0);
    // With every closed shape in use by this feature, "used" wins over "taken".
    expect(areaShades(data, undefined, all)).toEqual(["used", "used"]);
  });

  it("a new extrude of a used sketch starts with the circle that's left", () => {
    const features = [sketch("s1", data), extrude("e1", "s1", [pickAt(data, 0, 0)])];
    const free = freeAreas(features, "s1", data)!;
    expect(free).toHaveLength(1);
    expect([...pickedAreas(sketchAreas(data), free).picked]).toEqual([big]);
    // Nothing used yet, or everything used: every closed shape, as before.
    expect(freeAreas([sketch("s1", data)], "s1", data)).toBeUndefined();
    expect(freeAreas([sketch("s1", data), extrude("e1", "s1")], "s1", data)).toBeUndefined();
  });
});

describe("clicking areas of any sketch while a feature is open", () => {
  const data = twoCircles();
  const other = addRectangle(emptySketch(), at(100, 0), at(120, 10)).sketch;

  it("offers every earlier sketch, hidden (used) ones too, the feature's own first; not a sweep's path", () => {
    const features = [sketch("s1", data), extrude("e1", "s1", [pickAt(data, 0, 0)]), sketch("s2", other), sketch("s3", other, { suppressed: true })];
    // Sketch 1 hid itself once Extrude 1 used it (as in Onshape)…
    expect(sketchVisible(features[0], usedSketches(features))).toBe(false);
    // …but while a new Extrude is open its areas can still be clicked.
    const draft = extrude("new", "s2");
    expect(clickableAreaSketches(features, draft).map((f) => f.id)).toEqual(["s2", "s1"]);
    // Editing Extrude 1: only sketches above it.
    expect(clickableAreaSketches(features, features[1]).map((f) => f.id)).toEqual(["s1"]);
    // A sweep's path sketch isn't offered for its profile.
    expect(clickableAreaSketches(features, { id: "w", sketchRef: "s2", pathRef: "s1" }).map((f) => f.id)).toEqual(["s2"]);
    // A sketch with no plane yet isn't either.
    expect(clickableAreaSketches([sketch("s1", data, { sketch: { plane: null, data } })], draft)).toEqual([]);
  });

  it("a click in the feature's own sketch toggles the area, as the 2D map does", () => {
    const draft = extrude("e2", "s1");
    const { patch, message } = areaClickChange(draft, { id: "s1", name: "Sketch 1" }, data, indexAt(data, 40, 0));
    expect(patch.sketchRef).toBeUndefined();
    expect(patch.areas).toEqual([pickAt(data, 40, 0)]);
    expect(message).toBeUndefined();
    // Again: back to every closed shape.
    expect(areaClickChange({ ...draft, areas: patch.areas }, { id: "s1", name: "Sketch 1" }, data, indexAt(data, 40, 0)).patch.areas).toBeUndefined();
  });

  it("a click in another sketch uses that sketch, with just that area, and says so", () => {
    const draft = extrude("e2", "s2", [pickAt(other, 110, 5)]);
    const { patch, message } = areaClickChange(draft, { id: "s1", name: "Sketch 1" }, data, indexAt(data, 40, 0));
    expect(patch).toEqual({ sketchRef: "s1", areas: [pickAt(data, 40, 0)] });
    expect(message).toBe("Extrude e2 now uses Sketch 1. A feature takes its areas from one sketch.");
    // With no sketch chosen yet: just chosen, nothing to say.
    expect(areaClickMode(extrude("e3", undefined))).toBe("first");
    const fresh = areaClickChange(extrude("e3", undefined), { id: "s1", name: "Sketch 1" }, data, indexAt(data, 0, 0));
    expect(fresh.patch.sketchRef).toBe("s1");
    expect(fresh.message).toBeUndefined();
  });

  it("a revolve switching sketch takes that sketch's usual axis", () => {
    const draft: Feature = { ...extrude("r1", "s2"), type: "revolve", extrude: undefined, revolve: { axis: "some-line", flip: true } };
    const { patch } = areaClickChange(draft, { id: "s1", name: "Sketch 1" }, data, indexAt(data, 0, 0));
    expect(patch.revolve).toEqual({ axis: "vertical", flip: true });
  });
});

describe("selecting areas before choosing Extrude", () => {
  const data = twoCircles();
  const other = addRectangle(emptySketch(), at(100, 0), at(120, 10)).sketch;

  it("clicks add and remove areas of one sketch; another sketch starts again", () => {
    let sel = selectArea(null, "s1", data, indexAt(data, 0, 0));
    expect(sel).toEqual({ sketch: "s1", areas: [pickAt(data, 0, 0)] });
    sel = selectArea(sel, "s1", data, indexAt(data, 40, 0));
    expect(sel!.areas).toHaveLength(2);
    expect(selectedAreaShades(sel, "s1", data)).toEqual(["picked", "picked"]);
    expect(selectedAreaShades(sel, "s2", other)).toEqual(["none"]);
    sel = selectArea(sel, "s1", data, indexAt(data, 0, 0));
    expect(sel).toEqual({ sketch: "s1", areas: [pickAt(data, 40, 0)] });
    expect(selectArea(sel, "s2", other, 0)).toEqual({ sketch: "s2", areas: [pickOf(sketchAreas(other).areas[0])] });
    expect(selectArea(sel, "s1", data, indexAt(data, 40, 0))).toBeNull();
  });
});

describe("separate pieces become separate parts (saved in the file)", () => {
  it("new extrudes, revolves and sweeps are marked; older features without the mark open unchanged", () => {
    const doc = emptyDocument("Test");
    for (const type of ["extrude", "revolve", "sweep"] as const) expect(createFeature(doc, type).apart).toBe(true);
    expect(createFeature(doc, "box").apart).toBeUndefined();
    const withMark = { ...doc, features: [sketch("s1", twoCircles()), extrude("e1", "s1", undefined, { apart: true }), extrude("e2", "s1")] };
    const back = parseDocument(JSON.parse(JSON.stringify(withMark)))!;
    expect(back.features[1].apart).toBe(true);
    expect(back.features[2].apart).toBeUndefined();
    expect("apart" in back.features[2]).toBe(false);
  });
});
