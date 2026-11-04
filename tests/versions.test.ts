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
  STORAGE_LARGE,
  designSize,
  withVersionsOf,
} from "../src/model/versions";
import { compareDesigns, featureSettingChanges, MAX_SETTINGS, same } from "../src/model/versionCompare";
import { keepInBrowser, keepProblem, newKeepId, readKept, STORAGE_KEY, VERSIONS_KEY, type KeepStorage } from "../src/model/browserKeep";
import { compareStudioInputs } from "../src/kernel/buildInput";
import { addStudio, moveStudio } from "../src/model/studios";
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
    const big = "gz:" + "A".repeat(Math.ceil(STORAGE_LARGE / 4));
    doc = addVersion(doc, version("v1", big, { createdAt: "2026-01-01T00:00:00Z" }));
    doc = addVersion(doc, version("auto", big, { createdAt: "2026-01-02T00:00:00Z", auto: true }));
    doc = addVersion(doc, version("v2", big, { createdAt: "2026-01-03T00:00:00Z" }));
    doc = addVersion(doc, version("v3", big, { createdAt: "2026-01-04T00:00:00Z" }));
    doc = addVersion(doc, version("v4", big, { createdAt: "2026-01-05T00:00:00Z" }));
    expect(versionsSize(doc)).toBeGreaterThan(STORAGE_LARGE);
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

describe("the design and its sizes, together", () => {
  it("counts the design itself in the warning", () => {
    const doc = bracket();
    const huge = { ...doc, name: "x".repeat(STORAGE_LARGE) };
    expect(storageNote(doc)).toBeNull();
    // No versions at all, but the design alone is big: still worth saying.
    expect(storageNote(huge)).toMatch(/The design takes/);
    expect(designSize(huge)).toBeGreaterThan(STORAGE_LARGE);
    // Versions are counted with the design: removing them brings the total down.
    const half = "gz:" + "A".repeat(Math.ceil(STORAGE_LARGE / 2));
    const both = addVersion(addVersion({ ...doc, name: "y".repeat(STORAGE_LARGE / 2) }, version("a", half, { auto: true })), version("b", "json:{}"));
    expect(storageNote(both)).toMatch(/versions/);
    expect(versionsToTidy(both)).toEqual(["a"]);
  });
});

describe("versions stay with the design", () => {
  it("withVersionsOf carries one design's versions onto another copy of it", () => {
    const a = addVersion(bracket(), version("v1", "json:{}"));
    const b = bracket();
    expect(withVersionsOf(b, a).versions).toBe(a.versions);
    expect(withVersionsOf(a, b).versions).toBeUndefined();
    expect(withVersionsOf(a, a)).toBe(a);
    expect(withVersionsOf(b, bracket())).toBe(b);
  });
});

/** A browser storage (shared by "tabs") that holds up to `limit` characters in all. */
function storage(limit = Infinity) {
  const items = new Map<string, string>();
  const s: KeepStorage & { items: Map<string, string>; getItem(k: string): string | null } = {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem(k, v) {
      const used = [...items].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0);
      if (used + v.length > limit) throw new Error("QuotaExceededError");
      items.set(k, v);
    },
    removeItem(k) {
      items.delete(k);
    },
  };
  return s;
}

describe("keeping the design in the browser", () => {
  it("keeps a design with moved Part Studio tabs as format version 2, others as version 1", () => {
    const st = storage();
    const plain = addStudio(bracket(), "s2");
    keepInBrowser(st, plain, "A", null);
    expect(JSON.parse(st.items.get(STORAGE_KEY)!).version).toBe(1);
    const moved = moveStudio(plain, "s2", 0);
    expect(moved.studioId).toBe("s2");
    keepInBrowser(st, moved, "A", null);
    const kept = JSON.parse(st.items.get(STORAGE_KEY)!);
    expect(kept.version).toBe(2);
    expect(kept.keep).toBe("A");
    const back = readKept(st)!;
    expect(back.doc.studioId).toBe("s2");
    expect(back.doc.partStudios?.map((p) => p.id)).toEqual(["main"]);
  });

  it("keeps the design and its versions under separate keys, tied by the keep id", () => {
    const st = storage();
    const doc = addVersion(bracket(), version("v1", "json:{}"));
    const r = keepInBrowser(st, doc, "A", null);
    expect(r).toMatchObject({ design: true, versions: true });
    const kept = JSON.parse(st.items.get(STORAGE_KEY)!);
    expect(kept.versions).toBeUndefined();
    expect(kept.keep).toBe("A");
    expect(JSON.parse(st.items.get(VERSIONS_KEY)!)).toEqual({ keep: "A", list: doc.versions });
    const back = readKept(st)!;
    expect(back.keep).toBe("A");
    expect(back.doc).toEqual(doc);
    // No versions: the key goes.
    expect(keepInBrowser(st, bracket(), "A", r.kept)).toMatchObject({ design: true, versions: true });
    expect(st.items.has(VERSIONS_KEY)).toBe(false);
  });

  it("always keeps the design first, even when its versions don't fit", () => {
    const st = storage(3000);
    const doc = addVersion(bracket(), version("v1", "gz:" + "A".repeat(5000)));
    const r = keepInBrowser(st, doc, "A", null);
    expect(r).toMatchObject({ design: true, versions: false, kept: null });
    expect(st.items.has(STORAGE_KEY)).toBe(true);
    // Old versions aren't left behind to be put on the wrong design.
    expect(st.items.has(VERSIONS_KEY)).toBe(false);
    expect(keepProblem(r, true)).toMatch(/versions are too big/);
    // Later changes to the design are still kept.
    expect(keepInBrowser(st, { ...doc, name: "Bracket 2" }, "A", r.kept).design).toBe(true);
    expect(JSON.parse(st.items.get(STORAGE_KEY)!).name).toBe("Bracket 2");
  });

  it("drops the saved versions to make room when the design grows and no longer fits beside them", () => {
    const st = storage(20_000);
    const small = addVersion(bracket(), version("v1", "gz:" + "A".repeat(15_000)));
    const first = keepInBrowser(st, small, "A", null);
    expect(first).toMatchObject({ design: true, versions: true });
    // The design grows to 8,000 characters: with 15,000 of versions it no longer fits.
    const grown = { ...small, name: "x".repeat(8_000) };
    const r = keepInBrowser(st, grown, "A", first.kept);
    expect(r).toMatchObject({ design: true, versions: false });
    expect(JSON.parse(st.items.get(STORAGE_KEY)!).name).toBe(grown.name);
    expect(st.items.has(VERSIONS_KEY)).toBe(false);
    expect(keepProblem(r, true)).toMatch(/versions are too big/);
    // After a reload: the latest design, without versions (they're still in the design on screen and in a saved file).
    expect(readKept(st)!.doc.name).toBe(grown.name);
    expect(readKept(st)!.doc.versions).toBeUndefined();
  });

  it("says plainly when the design itself can't be kept", () => {
    const st = storage(100);
    const r = keepInBrowser(st, bracket(), "A", null);
    expect(r.design).toBe(false);
    expect(keepProblem(r, false)).toMatch(/would be lost if the page is closed or reloaded/);
    expect(keepProblem({ design: true, versions: true, kept: null }, true)).toBeNull();
  });

  it("only writes the versions when they (or the keep id) changed", () => {
    const st = storage();
    const doc = addVersion(bracket(), version("v1", "json:{}"));
    const r = keepInBrowser(st, doc, "A", null);
    st.items.set(VERSIONS_KEY, "untouched");
    keepInBrowser(st, { ...doc, name: "Renamed" }, "A", r.kept);
    expect(st.items.get(VERSIONS_KEY)).toBe("untouched");
    // Nothing relied on (after another tab wrote): written again.
    keepInBrowser(st, { ...doc, name: "Renamed" }, "A", null);
    expect(JSON.parse(st.items.get(VERSIONS_KEY)!).keep).toBe("A");
  });

  it("two tabs: versions written by one never land on the other's design", () => {
    const st = storage();
    const a = addVersion(bracket(), version("va", "json:{}"));
    const b = addVersion({ ...bracket(), name: "Other" }, version("vb", "json:{}"));
    // Tab X keeps A with its versions; then tab Y opens B and keeps it.
    const x = keepInBrowser(st, a, "A", null);
    keepInBrowser(st, b, "B", null);
    // X edits A without having heard from Y: only the design is written (its versions list didn't change)…
    keepInBrowser(st, { ...a, name: "A edited" }, "A", x.kept);
    // …and on a reload B's versions are NOT put on A.
    const back = readKept(st)!;
    expect(back.doc.name).toBe("A edited");
    expect(back.doc.versions).toBeUndefined();
    // Once X has heard (kept reset), its next change writes A's versions again, matched.
    keepInBrowser(st, { ...a, name: "A edited again" }, "A", null);
    expect(readKept(st)!.doc.versions!.map((v) => v.id)).toEqual(["va"]);
  });

  it("two tabs: New in the other tab removes the versions; this tab writes its own again on its next change", () => {
    const st = storage();
    const a = addVersion(bracket(), version("va", "json:{}"));
    keepInBrowser(st, a, "A", null);
    // Tab Y: New (an empty design, no versions).
    keepInBrowser(st, emptyDocument(), "N", null);
    expect(st.items.has(VERSIONS_KEY)).toBe(false);
    // Tab X heard about it (kept = null) and changes A: both are written again.
    keepInBrowser(st, { ...a, name: "A edited" }, "A", null);
    const back = readKept(st)!;
    expect(back.doc.name).toBe("A edited");
    expect(back.doc.versions!.map((v) => v.id)).toEqual(["va"]);
  });

  it("one tab: versions are never put on a design they weren't kept with", () => {
    const st = storage();
    keepInBrowser(st, addVersion(bracket(), version("va", "json:{}")), "A", null);
    // The design key is lost or damaged: nothing comes back (a new design starts, with a new id).
    st.items.delete(STORAGE_KEY);
    expect(readKept(st)).toBeNull();
    st.items.set(STORAGE_KEY, "{ not json");
    expect(readKept(st)).toBeNull();
    // A new design (another id) kept beside the old versions doesn't pick them up.
    st.items.set(STORAGE_KEY, JSON.stringify({ ...emptyDocument("New one"), keep: "N" }));
    expect(readKept(st)!.doc.versions).toBeUndefined();
    // A design kept before keep ids existed doesn't either.
    st.items.set(STORAGE_KEY, JSON.stringify(emptyDocument("Old browser copy")));
    expect(readKept(st)!).toEqual({ doc: emptyDocument("Old browser copy"), keep: null });
    // Damaged versions are ignored.
    st.items.set(STORAGE_KEY, JSON.stringify({ ...bracket(), keep: "A" }));
    st.items.set(VERSIONS_KEY, "{ nope");
    expect(readKept(st)!.doc.versions).toBeUndefined();
  });

  it("makes different random keep ids", () => {
    const ids = new Set(Array.from({ length: 50 }, newKeepId));
    expect(ids.size).toBe(50);
    expect([...ids][0]).toMatch(/^[0-9a-f]{18}$/);
  });
});

describe("comparing ignores the order settings were written in", () => {
  it("treats the same feature with reordered fields as unchanged", () => {
    const older = bracket();
    const f = older.features[0];
    const reordered = JSON.parse(JSON.stringify({ params: f.params, type: f.type, suppressed: f.suppressed, operation: f.operation, name: f.name, id: f.id, extra: undefined }));
    const newer = { ...older, features: [{ ...reordered, params: Object.fromEntries(Object.entries(f.params).reverse()) }] };
    const c = compareDesigns(older, newer);
    expect(c.features).toEqual([]);
    expect(c.same).toBe(true);
    expect(same({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(true);
    expect(same({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(same([1, 2], [2, 1])).toBe(false);
    expect(same({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it("finds a real change in a nested setting whatever the order", () => {
    const older = bracket();
    const f = { ...older.features[0], hole: { kind: "simple", diameter: "5" } } as never;
    const g = { ...older.features[0], hole: { diameter: "6", kind: "simple" } } as never;
    const out = featureSettingChanges(f, g);
    expect(out).toHaveLength(1);
    expect(out[0].from).toBe("5");
    expect(out[0].to).toBe("6");
  });
});

describe("an old version's Part Studios for comparing", () => {
  it("brings Derived parts from the version's own copy, and names parts as the version did", () => {
    let doc = addStudio(bracket(), "ps2");
    const derived = { id: "d1", name: "Derived 1", type: "derived" as const, operation: "new" as const, suppressed: false, params: {}, derived: { studioId: "main", partId: "box1" } };
    doc = { ...doc, partStudios: doc.partStudios!.map((s) => ({ ...s, features: [derived] })), partNames: { box1: "Old base" } };
    const inputs = compareStudioInputs("v9", doc);
    expect(inputs.map((s) => s.id)).toEqual(["main@version:v9", "ps2@version:v9"]);
    expect(inputs[1].features[0].derived).toEqual({ studioId: "main@version:v9", partId: "box1@version:v9" });
    expect(inputs[0].partNames).toEqual({ box1: "Old base" });
    // A Derived from a Part Studio the version doesn't have is left as it is (the engine says it's missing).
    const elsewhere = { ...doc, partStudios: doc.partStudios!.map((s) => ({ ...s, features: [{ ...derived, derived: { studioId: "gone", partId: "x" } }] })) };
    expect(compareStudioInputs("v9", elsewhere)[1].features[0].derived).toEqual({ studioId: "gone", partId: "x" });
  });
});
