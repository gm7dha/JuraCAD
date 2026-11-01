import { describe, expect, it } from "vitest";
import { addFeature, createFeature, emptyDocument, parseDocument, replaceFeature } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import type { DesignVersion, JuraCADDocument } from "../src/model/types";
import {
  addVersion,
  designFromVersion,
  designOf,
  editVersion,
  newestFirst,
  nextVersionName,
  packDesign,
  parseVersions,
  removeVersions,
  restoredDesign,
  sizeText,
  storageNote,
  unpackDesign,
  versionNameProblem,
  versionsSize,
  versionsToTidy,
  VERSIONS_LARGE,
} from "../src/model/versions";
import { compareDesigns, featureSettingChanges, MAX_SETTINGS } from "../src/model/versionCompare";
import { addStudio } from "../src/model/studios";
import { addDrawing } from "../src/drawing/drawing";

function bracket(): JuraCADDocument {
  let doc = emptyDocument("Bracket");
  const box = createFeature(doc, "box");
  box.id = "box1";
  doc = addFeature(doc, box);
  return { ...doc, variables: [{ id: "v1", name: "wall", value: "2" }] };
}

/** The list holds an item equal to this one. */
function expectHas<T>(list: readonly T[], item: T) {
  expect(list.some((x) => JSON.stringify(x) === JSON.stringify(item))).toBe(true);
}

const version = (id: string, packed: string, extra: Partial<DesignVersion> = {}): DesignVersion => ({ id, name: id.toUpperCase(), createdAt: "2026-11-01T10:00:00.000Z", packed, ...extra });

describe("packing a design", () => {
  it("compresses it and reads it back exactly", async () => {
    const doc = bracket();
    const packed = await packDesign(doc);
    expect(packed.startsWith("gz:")).toBe(true);
    const back = await unpackDesign(packed);
    if (!back.ok) throw new Error(back.error);
    expect(back.doc).toEqual(doc);
  });

  it("is much smaller than the design for a typical design", async () => {
    let doc = bracket();
    for (let i = 0; i < 40; i++) doc = addFeature(doc, createFeature(doc, i % 2 ? "cylinder" : "box"));
    const json = JSON.stringify(doc);
    const packed = await packDesign(doc);
    expect(packed.length).toBeLessThan(json.length / 4);
  });

  it("leaves the design's own versions out of the snapshot", async () => {
    const doc = addVersion(bracket(), version("v1", "json:{}"));
    const back = await unpackDesign(await packDesign(doc));
    if (!back.ok) throw new Error(back.error);
    expect(back.doc.versions).toBeUndefined();
    expect(back.doc.features).toEqual(doc.features);
  });

  it("keeps plain JSON where the browser can't compress, and still reads it", async () => {
    const packed = await packDesign(bracket(), false);
    expect(packed.startsWith("json:")).toBe(true);
    const back = await unpackDesign(packed);
    expect(back.ok).toBe(true);
  });

  it("says plainly when a version is damaged", async () => {
    for (const bad of ["gz:not base64!", "gz:AAAA", "json:{", "json:{}", "zip:abc"]) {
      const r = await unpackDesign(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/damaged/);
    }
  });
});

describe("the list of versions", () => {
  it("names versions V1, V2… skipping names in use and automatic versions", () => {
    let doc = bracket();
    expect(nextVersionName(doc)).toBe("V1");
    doc = addVersion(doc, version("a", "json:{}", { name: "V1" }));
    doc = addVersion(doc, version("b", "json:{}", { name: "Before restoring V1", auto: true }));
    expect(nextVersionName(doc)).toBe("V2");
    doc = addVersion(doc, version("c", "json:{}", { name: "v2" }));
    expect(nextVersionName(doc)).toBe("V3");
  });

  it("checks names: needed, not too long, not used twice", () => {
    const doc = addVersion(bracket(), version("a", "json:{}", { name: "First print" }));
    expect(versionNameProblem(doc, "  ")).toMatch(/name/);
    expect(versionNameProblem(doc, "first PRINT")).toMatch(/already/);
    expect(versionNameProblem(doc, "First print", "a")).toBeNull();
    expect(versionNameProblem(doc, "x".repeat(81))).toMatch(/too long/);
    expect(versionNameProblem(doc, "Second")).toBeNull();
  });

  it("adds, renames, re-notes and removes; the field goes with the last one", () => {
    let doc = addVersion(bracket(), version("a", "json:{}", { name: " V1 ", note: "  " }));
    expect(doc.versions![0].name).toBe("V1");
    expect(doc.versions![0].note).toBeUndefined();
    doc = editVersion(doc, "a", { name: "Prototype", note: "printed in PETG" });
    expect(doc.versions![0]).toMatchObject({ name: "Prototype", note: "printed in PETG" });
    doc = editVersion(doc, "a", { name: "  ", note: "" });
    expect(doc.versions![0].name).toBe("Prototype");
    expect(doc.versions![0].note).toBeUndefined();
    expect(editVersion(doc, "nope", { name: "x" })).toBe(doc);
    doc = removeVersions(doc, ["a"]);
    expect("versions" in doc).toBe(false);
  });

  it("lists newest first", () => {
    const list = [version("a", "json:{}", { createdAt: "2026-01-01T00:00:00Z" }), version("b", "json:{}", { createdAt: "2026-03-01T00:00:00Z" }), version("c", "json:{}", { createdAt: "2026-02-01T00:00:00Z" })];
    expect(newestFirst(list).map((v) => v.id)).toEqual(["b", "c", "a"]);
  });

  it("restoring copies the version's design, keeping the name and every version", () => {
    let now = addVersion(bracket(), version("a", "json:{}"));
    now = { ...now, name: "Bracket mk2" };
    const old = { ...emptyDocument("Old name"), variables: [{ id: "v1", name: "wall", value: "5" }] };
    const r = restoredDesign(now, old);
    expect(r.name).toBe("Bracket mk2");
    expect(r.features).toEqual([]);
    expect(r.variables![0].value).toBe("5");
    expect(r.versions).toEqual(now.versions);
  });

  it("a new design from a version has its design and no versions", () => {
    const d = designFromVersion(addVersion(bracket(), version("a", "json:{}")), "V1");
    expect(d.name).toBe("Bracket (from V1)");
    expect(d.versions).toBeUndefined();
    expect(d.features).toHaveLength(1);
  });
});

describe("storage", () => {
  it("versions travel in the .juracad file and old files open unchanged", async () => {
    const doc = addVersion(bracket(), { ...version("a", await packDesign(bracket())), note: "first" });
    const text = serializeDocument(doc);
    const back = readDocumentFile(text);
    if (!back.ok) throw new Error(back.error);
    expect(back.doc.versions).toEqual(doc.versions);
    const plain = readDocumentFile(serializeDocument(bracket()));
    if (!plain.ok) throw new Error(plain.error);
    expect("versions" in plain.doc).toBe(false);
    expect(serializeDocument(bracket())).not.toMatch(/versions/);
  });

  it("drops versions that don't make sense when reading", () => {
    const ok = version("a", "json:{}");
    const list = parseVersions([ok, { ...ok }, { ...ok, id: "b", packed: "zip:1" }, { ...ok, id: "c", name: " " }, { ...ok, id: "d", createdAt: "soon" }, null, 7, { ...ok, id: "e", auto: "yes", note: 3 }]);
    expect(list.map((v) => v.id)).toEqual(["a", "e"]);
    expect(list[1].auto).toBeUndefined();
    expect(list[1].note).toBeUndefined();
    expect(parseVersions("nope")).toEqual([]);
    const doc = parseDocument({ ...bracket(), versions: [ok] });
    expect(doc?.versions).toHaveLength(1);
  });

  it("warns when versions are large and suggests automatic, then oldest ones to remove", () => {
    let doc = bracket();
    expect(storageNote(doc)).toBeNull();
    const big = "gz:" + "A".repeat(Math.ceil(VERSIONS_LARGE / 4));
    doc = addVersion(doc, version("v1", big, { createdAt: "2026-01-01T00:00:00Z" }));
    doc = addVersion(doc, version("auto", big, { createdAt: "2026-01-02T00:00:00Z", auto: true }));
    doc = addVersion(doc, version("v2", big, { createdAt: "2026-01-03T00:00:00Z" }));
    doc = addVersion(doc, version("v3", big, { createdAt: "2026-01-04T00:00:00Z" }));
    doc = addVersion(doc, version("v4", big, { createdAt: "2026-01-05T00:00:00Z" }));
    expect(versionsSize(doc)).toBeGreaterThan(VERSIONS_LARGE);
    expect(storageNote(doc)).toMatch(/MB/);
    const tidy = versionsToTidy(doc);
    expect(tidy[0]).toBe("auto");
    expect(tidy).toContain("v1");
    // The newest three the user saved are kept.
    expect(tidy).not.toContain("v4");
    expect(tidy).not.toContain("v3");
    expect(tidy).not.toContain("v2");
    expect(storageNote(removeVersions(doc, tidy))).toBeNull();
  });

  it("writes sizes in plain units", () => {
    expect(sizeText(340_000)).toBe("340 KB");
    expect(sizeText(2_100_000)).toBe("2.1 MB");
  });

  it("the design without versions is the same object when there are none", () => {
    const d = bracket();
    expect(designOf(d)).toBe(d);
  });
});

describe("comparing two designs", () => {
  it("finds features added, removed and changed, with old → new values", () => {
    const older = bracket();
    let newer = replaceFeature(older, { ...older.features[0], name: "Base", params: { ...older.features[0].params, width: "60" } });
    const cyl = createFeature(newer, "cylinder");
    cyl.id = "cyl1";
    newer = addFeature(newer, cyl);
    const c = compareDesigns(older, newer);
    expect(c.same).toBe(false);
    const changed = c.features.find((f) => f.id === "box1")!;
    expect(changed.change).toBe("changed");
    expectHas(changed.settings, { what: "Name", from: "Box 1", to: "Base" });
    expectHas(changed.settings, { what: "Width (X)", from: "40", to: "60" });
    expect(c.features.find((f) => f.id === "cyl1")!.change).toBe("added");
    const back = compareDesigns(newer, older);
    expect(back.features.find((f) => f.id === "cyl1")!.change).toBe("removed");
  });

  it("finds variables added, removed and changed", () => {
    const older = bracket();
    const newer = { ...older, variables: [{ id: "v1", name: "wall", value: "3" }, { id: "v2", name: "gap", value: "0.2" }] };
    const c = compareDesigns(older, newer);
    expectHas(c.variables, { name: "wall", change: "changed", from: "2", to: "3" });
    expectHas(c.variables, { name: "gap", change: "added", to: "0.2" });
    expectHas(compareDesigns(newer, older).variables, { name: "gap", change: "removed", from: "0.2" });
  });

  it("finds parts added and removed once both sides are built", () => {
    const d = bracket();
    expect(compareDesigns(d, d).parts).toBeNull();
    const c = compareDesigns(d, d, [{ id: "box1", name: "Part 1" }], [{ id: "box1", name: "Part 1" }, { id: "cyl1", name: "Part 2" }]);
    expect(c.parts).toEqual([{ id: "cyl1", name: "Part 2", change: "added" }]);
  });

  it("says nothing changed for identical designs, ignoring versions", () => {
    const d = bracket();
    const c = compareDesigns(d, addVersion(d, version("a", "json:{}")));
    expect(c.same).toBe(true);
    expect(c.features).toEqual([]);
    expect(c.other).toEqual([]);
  });

  it("lists other tabs and settings that changed", () => {
    const older = bracket();
    let newer = addStudio(older, "ps2");
    newer = addDrawing(newer, "d1", { kind: "part", id: "box1" });
    newer = { ...newer, units: "in", appearance: { box1: "#3366cc" } };
    const c = compareDesigns(older, newer);
    expect(c.other.some((x) => /^Part Studio ".*" added$/.test(x))).toBe(true);
    expect(c.other.some((x) => /^Drawing ".*" added$/.test(x))).toBe(true);
    expect(c.other).toContain("Units changed to inches");
    expect(c.other).toContain("Part colours changed");
  });

  it("describes sketch changes: dimension values and the shapes drawn", () => {
    const doc = emptyDocument();
    const s = createFeature(doc, "sketch");
    const a = { ...s, sketch: { plane: s.sketch!.plane, data: { points: [], curves: [], constraints: [{ id: "d1", type: "length" as const, refs: [], value: "20" }] } } };
    const b = { ...s, sketch: { plane: s.sketch!.plane, data: { points: [], curves: [{ id: "c1", type: "circle" as const, center: "p", radius: 3 } as never], constraints: [{ id: "d1", type: "length" as const, refs: [], value: "25" }] } } };
    const out = featureSettingChanges(a, b);
    expectHas(out, { what: "Sketch length dimension", from: "20", to: "25" });
    expect(out.find((x) => x.what === "Sketch")?.to).toMatch(/1 circle/);
  });

  it("caps a long list of settings with '…and N more'", () => {
    const doc = emptyDocument();
    const f = createFeature(doc, "box");
    const params: Record<string, string> = {};
    for (let i = 0; i < 30; i++) params[`p${i}`] = String(i);
    const out = featureSettingChanges(f, { ...f, params: { ...f.params, ...params } });
    expect(out).toHaveLength(MAX_SETTINGS);
    expect(out[MAX_SETTINGS - 1].what).toMatch(/^…and \d+ more$/);
  });

  it("doesn't list a feature whose only difference is its folder or eye", () => {
    const older = bracket();
    const newer = replaceFeature(older, { ...older.features[0], folder: "Base" });
    expect(compareDesigns(older, newer).features).toEqual([]);
  });
});
