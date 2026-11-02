import { describe, expect, it } from "vitest";

import { colourFromWords, colourOpacity, colourToRgb } from "../src/model/colours";
import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import {
  chooseFinish,
  exportColours,
  finishesByKey,
  finishFromWords,
  finishOf,
  FINISHES,
  parseFinishes,
  setColourIn,
  setFinishIn,
  withAlpha,
} from "../src/model/finishes";
import { pictureSize, showGround } from "../src/viewport/pictureSize";

describe("part finishes", () => {
  it("are a sensible set of three.js settings", () => {
    expect(FINISHES.map((f) => f.id)).toEqual(["matte", "glossy", "silk", "brushed", "polished", "rubber", "clear", "wood"]);
    for (const f of FINISHES) {
      for (const v of [f.roughness, f.metalness, f.opacity, f.clearcoat, f.clearcoatRoughness, f.sheen, f.specular]) {
        expect(v >= 0 && v <= 1, `${f.id}`).toBe(true);
      }
    }
    expect(finishOf("polished").metalness).toBe(1);
    expect(finishOf("clear").opacity).toBeLessThan(1);
    expect(finishOf("nonsense").id).toBe("matte");
    expect(finishOf(undefined).id).toBe("matte");
  });

  it("are read from files carefully, and old files open unchanged", () => {
    expect(parseFinishes({ a: "glossy", b: "sparkly", c: 3, d: "matte" })).toEqual({ a: "glossy" });
    expect(parseFinishes(["glossy"])).toEqual({});
    expect(parseFinishes(null)).toEqual({});
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = addFeature(doc, box);
    expect(parseDocument(JSON.parse(serializeDocument(doc)))?.finishes).toBeUndefined();
    expect(serializeDocument(doc)).not.toMatch(/finishes/);
    doc = setFinishIn(doc, box.id, "brushed");
    const back = readDocumentFile(serializeDocument(doc));
    expect(back.ok && back.doc.finishes).toEqual({ [box.id]: "brushed" });
  });

  it("are set and cleared without leaving empty fields", () => {
    let doc = emptyDocument();
    doc = setFinishIn(doc, "p1", "rubber");
    expect(doc.finishes).toEqual({ p1: "rubber" });
    doc = setFinishIn(doc, "p1", "matte");
    expect("finishes" in doc).toBe(false);
    doc = setFinishIn(setFinishIn(doc, "p1", "glossy"), "p1", null);
    expect("finishes" in doc).toBe(false);
    expect(setColourIn(setColourIn(doc, "p1", "#123456"), "p1", null)).toEqual(doc);
  });

  it("give grey parts a colour that suits wood or metal, and keep a part's own colour", () => {
    let doc = setColourIn(emptyDocument(), "red", "#d64545");
    doc = chooseFinish(doc, ["grey", "red"], "wood");
    expect(doc.finishes).toEqual({ grey: "wood", red: "wood" });
    expect(doc.appearance).toEqual({ red: "#d64545", grey: "#b07a4a" });
    doc = chooseFinish(doc, ["grey"], "glossy");
    expect(doc.appearance?.grey).toBe("#b07a4a");
    expect(chooseFinish(emptyDocument(), ["x"], "glossy").appearance).toBeUndefined();
  });

  it("put see-through colours into exports", () => {
    expect(withAlpha("#D64545", 1)).toBe("#d64545");
    expect(withAlpha("#d64545", 0.35)).toBe("#d6454559");
    expect(exportColours({})).toEqual({});
    expect(exportColours({ appearance: { a: "#d64545", b: "#3d7fd9" }, finishes: { a: "clear", b: "glossy", c: "clear" } })).toEqual({
      a: "#d6454559",
      b: "#3d7fd9",
      c: "#a8b4c059",
    });
    expect(colourToRgb("#ff800059").map((v) => Math.round(v * 255))).toEqual([255, 128, 0]);
    expect(colourOpacity("#ff800059")).toBeCloseTo(89 / 255, 6);
    expect(colourOpacity("#ff8000")).toBe(1);
  });

  it("go to every copy of a part in an assembly", () => {
    expect(finishesByKey({ a: "glossy" }, [{ key: "i1", partId: "a" }, { key: "i2/x/a", partId: "a" }, { key: "i3", partId: "b" }])).toEqual({ i1: "glossy", "i2/x/a": "glossy" });
  });

  it("understand finishes and colours typed in words", () => {
    expect(finishFromWords("Brushed metal")).toBe("brushed");
    expect(finishFromWords("brushed")).toBe("brushed");
    expect(finishFromWords("Clear (see-through)")).toBe("clear");
    expect(finishFromWords("PLA silk")).toBeUndefined();
    expect(finishFromWords("silk")).toBe("silk");
    expect(colourFromWords("Red")).toBe("#d64545");
    expect(colourFromWords("#fff")).toBe("#ffffff");
    expect(colourFromWords("default")).toBeNull();
    expect(colourFromWords("grey")).toBeNull();
    expect(colourFromWords("gray")).toBeNull();
    expect(colourFromWords("chartreuse")).toBeUndefined();
  });
});

describe("picture size", () => {
  it("scales the view, keeping its shape and within what graphics cards draw", () => {
    expect(pictureSize(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(pictureSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
    const big = pictureSize(3000, 1000, 4, 8192);
    expect(big.width).toBe(8192);
    expect(big.height).toBe(Math.round((8192 * 1000) / 3000));
    const many = pictureSize(4000, 4000, 4, 16384);
    expect(many.width * many.height).toBeLessThanOrEqual(40_000_000);
    expect(pictureSize(0, 0, 2)).toEqual({ width: 2, height: 2 });
  });

  it("puts the shadow's ground under the parts only when looking down on them", () => {
    expect(showGround([0.5, -0.5, 0.7])).toBe(true);
    expect(showGround([0, -1, 0])).toBe(false);
    expect(showGround([0, 0, -1])).toBe(false);
  });
});
