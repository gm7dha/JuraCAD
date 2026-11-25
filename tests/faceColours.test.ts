import { describe, expect, it } from "vitest";
import type { FaceRef } from "../src/geometry/topoRef";
import { filamentFiles, planFilaments, type PaintedPart } from "../src/geometry/filament3mf";
import { paintCode } from "../src/geometry/paintCode";
import { clearFaceColoursIn, faceColoursByKey, parseFaceAppearance, parsePartSpools, resolveFaceColours, setFaceColoursIn, setPartSpoolIn, shownFaceColours } from "../src/model/faceColours";
import { parseDocument } from "../src/model/document";
import { serializeDocument } from "../src/model/fileFormat";
import type { JuraCADDocument } from "../src/model/types";
import { BAMBU_COLOURS, BAMBU_MATERIALS, coloursOfMaterial, materialOfLine, spoolFor, spoolLabel } from "../src/terrain/bambuColours";

/** A w × 30 × 20 box's faces (a mesh's faceRefs, with two corners to give its size), with where they sit in its box (`rel`). */
const boxFaces = (w = 40): FaceRef[] => {
  const plane = (center: [number, number, number], normal: [number, number, number]): FaceRef => ({ kind: "face", surface: "PLANE", center, normal, rel: [center[0] / w, center[1] / 30, center[2] / 20] });
  return [
  plane([w / 2, 15, 0], [0, 0, -1]),
  plane([w / 2, 15, 20], [0, 0, 1]),
  plane([0, 15, 10], [-1, 0, 0]),
  plane([w, 15, 10], [1, 0, 0]),
  plane([w / 2, 0, 10], [0, -1, 0]),
  plane([w / 2, 30, 10], [0, 1, 0]),
  ];
};
const mesh = (w = 40) => ({ faceRefs: boxFaces(w), vertices: [0, 0, 0, w, 30, 20] });
const doc = (): JuraCADDocument => ({ format: "partsmith", version: 1, name: "t", features: [] });

describe("face colours", () => {
  it("colour faces, replace a face's colour, take one or all off", () => {
    let d = setFaceColoursIn(doc(), "p", [1, 3], "#FF0000", mesh(), "10200");
    expect(d.faceAppearance!.p.map((f) => [f.face.normal, f.colour, f.spool])).toEqual([
      [[0, 0, 1], "#ff0000", "10200"],
      [[1, 0, 0], "#ff0000", "10200"],
    ]);
    // The top again in blue: replaced, not kept beside it.
    d = setFaceColoursIn(d, "p", [1], "#0000ff", mesh());
    expect(d.faceAppearance!.p).toHaveLength(2);
    expect(resolveFaceColours(d.faceAppearance!.p, boxFaces(), 50).colours.get(1)?.colour).toBe("#0000ff");
    // Back to the part's colour.
    d = setFaceColoursIn(d, "p", [1], null, mesh());
    expect(d.faceAppearance!.p.map((f) => f.face.normal)).toEqual([[1, 0, 0]]);
    expect(clearFaceColoursIn(d, "p").faceAppearance).toBeUndefined();
    // A face that doesn't exist changes nothing.
    const same = doc();
    expect(setFaceColoursIn(same, "p", [99], "#ff0000", mesh())).toBe(same);
  });

  it("are found again when the part grows, and counted as lost when their face is gone", () => {
    const d = setFaceColoursIn(doc(), "p", [3], "#ff0000", mesh());
    const r = resolveFaceColours(d.faceAppearance!.p, boxFaces(80), 90);
    expect([...r.colours.keys()]).toEqual([3]);
    expect(r.lost).toBe(0);
    // Only faces facing other ways: the colour is lost, quietly.
    const gone = resolveFaceColours(d.faceAppearance!.p, boxFaces().filter((f) => f.normal[0] !== 1), 50);
    expect(gone.colours.size).toBe(0);
    expect(gone.lost).toBe(1);
  });

  it("show on an assembly's copies as on their part", () => {
    const d = setFaceColoursIn(doc(), "p", [1], "#ff0000", mesh());
    const byKey = faceColoursByKey(d.faceAppearance!, [{ key: "i1", partId: "p" }]);
    expect(Object.keys(byKey)).toEqual(["i1"]);
    const shown = shownFaceColours([{ id: "i1", ...mesh() }, { id: "i2", ...mesh() }], d.faceAppearance, (k) => (k === "i1" ? "p" : "q"));
    expect(shown).toEqual({ i1: { 1: "#ff0000" } });
  });

  it("are saved in the file and read back; odd entries dropped; old files unchanged", () => {
    const plain = doc();
    expect(serializeDocument(plain, new Date(0))).not.toContain("faceAppearance");
    const d = setPartSpoolIn(setFaceColoursIn(doc(), "p", [1], "#ff0000", mesh(), "10200"), "p", "10100");
    const back = parseDocument(JSON.parse(serializeDocument(d, new Date(0))))!;
    expect(back.faceAppearance).toEqual(d.faceAppearance);
    expect(back.partSpools).toEqual({ p: "10100" });
    expect(parseFaceAppearance({ p: [{ face: { kind: "edge" }, colour: "#fff" }, { colour: "red" }, "x"], q: "nope" })).toEqual({});
    expect(parsePartSpools({ a: "10100", b: 5, c: "<script>" })).toEqual({ a: "10100" });
    expect(setPartSpoolIn(doc(), "p", null)).toEqual(doc());
  });
});

describe("filaments for a multi-colour 3MF", () => {
  const part = (own: string, faces: string[], paint: number[]): PaintedPart => ({
    name: "P",
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    triangles: [0, 1, 2, 1, 3, 2],
    own: { colour: own },
    faceFilaments: faces.map((colour) => ({ colour })),
    paint,
  });
  it("number every distinct colour once: parts' own colours first, then faces'", () => {
    const plan = planFilaments([part("#ffffff", ["#ff0000"], [1, 0]), part("#000000", ["#ffffff", "#00ff00"], [1, 2])]);
    expect(plan.filaments.map((f) => f.colour)).toEqual(["#ffffff", "#000000", "#ff0000", "#00ff00"]);
    expect(plan.own).toEqual([1, 2]);
    expect(plan.faces).toEqual([[3], [1, 4]]);
    // A face colour no triangle has isn't a filament.
    expect(planFilaments([part("#ffffff", ["#ff0000"], [0, 0])]).filaments).toHaveLength(1);
  });
  it("paint triangles of other colours with Bambu's codes and the core colours", () => {
    const { model, config } = filamentFiles([part("#ffffff", ["#ff0000"], [1, 0])], "t");
    expect(paintCode(2)).toBe("8");
    expect(paintCode(3)).toBe("0C");
    expect(model).toContain(`<triangle v1="0" v2="1" v3="2" pid="1" p1="1" paint_color="8"/>`);
    expect(model).toContain(`<triangle v1="1" v2="3" v3="2"/>`);
    expect(model).toContain('pid="1" pindex="0"');
    expect(config).toContain('<metadata key="extruder" value="1"/>');
  });
});

describe("Bambu filaments by material", () => {
  it("has PETG, ABS, ASA, TPU and more, every line in one material, codes unique", () => {
    const materials = BAMBU_MATERIALS.map((m) => m.material);
    for (const m of ["PLA", "PETG", "ABS", "ASA", "TPU", "PC"]) expect(materials).toContain(m);
    const lines = new Set(BAMBU_COLOURS.map((c) => c.line));
    for (const l of lines) expect(BAMBU_MATERIALS.some((m) => m.lines.includes(l)), l).toBe(true);
    expect(new Set(BAMBU_COLOURS.map((c) => c.code)).size).toBe(BAMBU_COLOURS.length);
    expect(coloursOfMaterial("PETG").map((g) => g.line)).toContain("PETG HF");
    expect(coloursOfMaterial("ABS")[0].colours.length).toBeGreaterThan(5);
    expect(materialOfLine("PETG HF")).toBe("PETG");
    const black = BAMBU_COLOURS.find((c) => c.line === "PETG HF" && c.name === "Black")!;
    expect(spoolLabel(spoolFor(black.hex, black.code)!)).toBe("Black (PETG HF)");
    // Without a chosen spool, black is still PLA Basic's.
    expect(spoolLabel(spoolFor("#000000")!)).toBe("Black (PLA Basic)");
  });
});

describe("the Export dialog's filament words", () => {
  it("counts filaments and names the spools in order", async () => {
    const { filamentsFor, filamentsNote } = await import("../src/model/faceColours");
    const d = setFaceColoursIn({ ...doc(), appearance: { p: "#ffffff" } }, "p", [1, 3], "#c12e1f", mesh());
    expect(filamentsFor(d, ["p"])).toBe(2);
    // Parts of different colours but no face colours: the plain file, so no filament count (the dialog says nothing).
    expect(filamentsFor({ ...d, appearance: { p: "#ffffff", q: "#000000" } }, ["q"])).toBe(0);
    expect(filamentsFor({ ...d, appearance: { p: "#ffffff", q: "#000000" } }, ["p", "q"])).toBe(3);
    const { lostFacesNote } = await import("../src/model/faceColours");
    expect(lostFacesNote(0)).toBe("");
    expect(lostFacesNote(2)).toMatch(/^2 face colours couldn't be found/);
    expect(filamentsNote([{ colour: "#ffffff" }, { colour: "#000000", spool: "11101" }, { colour: "#123456" }])).toBe(
      "3 filaments, load them in this order: 1 Jade White (PLA Basic), 2 Charcoal (PLA Matte), 3 your own colour #123456.",
    );
  });
});
