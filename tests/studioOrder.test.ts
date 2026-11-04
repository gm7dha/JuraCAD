import { describe, expect, it } from "vitest";

import { addAssembly, insertInstance, putMate } from "../src/assembly/assembly";
import { addDrawing } from "../src/drawing/drawing";
import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { packDesign, unpackDesign } from "../src/model/versions";
import { compareDesigns } from "../src/model/versionCompare";
import {
  addStudio,
  firstStudioId,
  inStudio,
  MAIN_STUDIO,
  moveStudio,
  removeStudio,
  renameStudio,
  studioExists,
  studioFeatures,
  studioName,
  studioOfFeature,
  studiosOf,
  studioView,
  withStudios,
} from "../src/model/studios";
import { deleteStudio, deleteStudioQuestion, studioUsers } from "../src/model/studioUse";
import { hiddenDatumsOf, setDatumHidden } from "../src/model/visibility";
import type { Feature, JuraCADDocument, Mate } from "../src/model/types";
import { placePopup } from "../src/app/popupPlace";
import { dropIndex } from "../src/app/tabDrag";

const AT = new Date("2026-01-02T03:04:05Z");

/** Three Part Studios with a box each (ids main, s2, s3), the first named "Body" with its Origin hidden. */
function threeStudios(): { doc: JuraCADDocument; boxes: Record<string, Feature> } {
  let doc = addStudio(addStudio(emptyDocument(), "s2"), "s3");
  doc = renameStudio(doc, MAIN_STUDIO, "Body");
  doc = setDatumHidden(doc, MAIN_STUDIO, "Origin", true);
  const boxes: Record<string, Feature> = {};
  for (const id of [MAIN_STUDIO, "s2", "s3"]) {
    const box = createFeature(studioView(doc, id), "box");
    boxes[id] = box;
    doc = inStudio(doc, id, (d) => addFeature(d, box));
  }
  return { doc, boxes };
}

describe("moving Part Studio tabs", () => {
  it("moves the first studio along: ids, names, features and hidden planes go with each studio", () => {
    const { doc, boxes } = threeStudios();
    const moved = moveStudio(doc, MAIN_STUDIO, 2);
    expect(studiosOf(moved).map((s) => [s.id, s.name])).toEqual([
      ["s2", "Part Studio 2"],
      ["s3", "Part Studio 3"],
      [MAIN_STUDIO, "Body"],
    ]);
    // The new first studio is in the document's own fields.
    expect(firstStudioId(moved)).toBe("s2");
    expect(moved.studioId).toBe("s2");
    expect(moved.studioName).toBe("Part Studio 2");
    expect(moved.hiddenDatums).toBeUndefined();
    expect(moved.features).toEqual([boxes.s2]);
    // The old first is an ordinary studio now, still called "main", with its planes as they were.
    expect(studioFeatures(moved, MAIN_STUDIO)).toEqual([boxes[MAIN_STUDIO]]);
    expect(hiddenDatumsOf(moved, MAIN_STUDIO)).toEqual(["Origin"]);
    expect(hiddenDatumsOf(moved, "s2")).toEqual([]);
    expect(studioName(moved, MAIN_STUDIO)).toBe("Body");
    expect(studioOfFeature(moved, boxes[MAIN_STUDIO].id)).toBe(MAIN_STUDIO);
    expect(studioOfFeature(moved, boxes.s2.id)).toBe("s2");
    // Changes still reach the right studio.
    const sphere = createFeature(studioView(moved, MAIN_STUDIO), "sphere");
    const added = inStudio(moved, MAIN_STUDIO, (d) => addFeature(d, sphere));
    expect(studioFeatures(added, MAIN_STUDIO).map((f) => f.id)).toEqual([boxes[MAIN_STUDIO].id, sphere.id]);
    expect(added.features).toBe(moved.features);
    const renamed = renameStudio(moved, "s2", "Lid");
    expect(renamed.studioName).toBe("Lid");
    expect(studioName(renamed, MAIN_STUDIO)).toBe("Body");
  });

  it("moves a later studio to the front and back again; the same document and the same file", () => {
    const { doc } = threeStudios();
    const front = moveStudio(doc, "s3", 0);
    expect(studiosOf(front).map((s) => s.id)).toEqual(["s3", MAIN_STUDIO, "s2"]);
    expect(moveStudio(front, "s3", 0)).toBe(front);
    const back = moveStudio(front, "s3", 2);
    expect(back).toEqual(doc);
    expect(serializeDocument(back, AT)).toBe(serializeDocument(doc, AT));
    expect(moveStudio(doc, "s2", 1)).toBe(doc);
    expect(moveStudio(doc, "gone", 0)).toBe(doc);
    // Clamped.
    expect(studiosOf(moveStudio(doc, MAIN_STUDIO, 99)).map((s) => s.id)).toEqual(["s2", "s3", MAIN_STUDIO]);
  });

  it("says when the tabs were reordered, comparing versions", () => {
    const { doc } = threeStudios();
    expect(compareDesigns(doc, moveStudio(doc, "s3", 0)).other).toContain("Part Studio tabs reordered");
    expect(compareDesigns(doc, doc).other).not.toContain("Part Studio tabs reordered");
    // Deleting one isn't a reorder.
    expect(compareDesigns(doc, removeStudio(doc, "s2")).other).toEqual(['Part Studio "Part Studio 2" removed']);
  });

  it("leaves a document that was never reordered exactly as it was (and its file byte for byte)", () => {
    const { doc } = threeStudios();
    expect(withStudios(doc, studiosOf(doc))).toEqual(doc);
    const text = serializeDocument(doc, AT);
    expect(text).not.toContain('"studioId"');
    const read = readDocumentFile(text);
    expect(read.ok).toBe(true);
    if (read.ok) expect(serializeDocument(read.doc, AT)).toBe(text);
    // A single-studio document too.
    const one = emptyDocument();
    expect(withStudios(one, studiosOf(one))).toEqual(one);
  });

  it("saves and reopens a reordered document", () => {
    const { doc } = threeStudios();
    const moved = moveStudio(doc, "s3", 0);
    const text = serializeDocument(moved, AT);
    expect(text).toContain('"studioId": "s3"');
    const read = readDocumentFile(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc).toEqual(moved);
    expect(studiosOf(read.doc).map((s) => s.id)).toEqual(["s3", MAIN_STUDIO, "s2"]);
    // No other studio may share the first one's id.
    const f = { ...createFeature(emptyDocument(), "box"), id: "x1" };
    const clash = parseDocument({ format: "partsmith", version: 1, name: "x", studioId: "s3", features: [], partStudios: [{ id: "s3", name: "B", features: [f] }, { id: MAIN_STUDIO, name: "A", features: [] }] });
    expect(clash?.partStudios?.map((s) => s.id)).toEqual([MAIN_STUDIO]);
  });
});

describe("older JuraCADs and a reordered file", () => {
  it("saves a reordered design as format version 2, which a version-1-only reader refuses (rather than losing a studio)", () => {
    const { doc } = threeStudios();
    expect(JSON.parse(serializeDocument(doc, AT)).version).toBe(1);
    const moved = moveStudio(doc, "s3", 0);
    const text = serializeDocument(moved, AT);
    expect(JSON.parse(text).version).toBe(2);
    // What JuraCAD and the extension did before this: refuse anything above version 1.
    const oldReader = (t: string) => {
      const d = JSON.parse(t);
      if (typeof d.version === "number" && d.version > 1) return "newer version";
      return parseDocument(d) ? "opened" : "damaged";
    };
    expect(oldReader(text)).toBe("newer version");
    expect(oldReader(serializeDocument(doc, AT))).toBe("opened");
    // Moved back: version 1 again, byte for byte.
    expect(serializeDocument(moveStudio(moved, "s3", 2), AT)).toBe(serializeDocument(doc, AT));
    // This version reads both, and refuses anything newer still.
    expect(readDocumentFile(text).ok).toBe(true);
    expect(readDocumentFile(text.replace('"version": 2', '"version": 3')).ok).toBe(false);
  });

  it("keeps a reordered design's saved version as format version 2 too", async () => {
    const { doc } = threeStudios();
    const moved = moveStudio(doc, "s3", 0);
    const packed = await packDesign(moved, false);
    expect(JSON.parse(packed.slice(5)).version).toBe(2);
    expect(JSON.parse((await packDesign(doc, false)).slice(5)).version).toBe(1);
    const back = await unpackDesign(packed);
    expect(back.ok && studiosOf(back.doc).map((s) => s.id)).toEqual(["s3", MAIN_STUDIO, "s2"]);
  });
});

describe("deleting Part Studios", () => {
  it("deletes any studio, the first too (the next takes its place), but never the last one", () => {
    const { doc, boxes } = threeStudios();
    const gone = removeStudio(doc, MAIN_STUDIO);
    expect(studiosOf(gone).map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(gone.features).toEqual([boxes.s2]);
    expect(gone.studioName).toBe("Part Studio 2");
    expect(gone.hiddenDatums).toBeUndefined();
    expect(studioExists(gone, MAIN_STUDIO)).toBe(false);
    expect(studioFeatures(gone, MAIN_STUDIO)).toEqual([]);
    expect(studioOfFeature(gone, boxes[MAIN_STUDIO].id)).toBeNull();
    const middle = removeStudio(doc, "s2");
    expect(studiosOf(middle).map((s) => s.id)).toEqual([MAIN_STUDIO, "s3"]);
    expect(middle.features).toBe(doc.features);
    const last = removeStudio(removeStudio(gone, "s3"), "s2");
    expect(studiosOf(last).map((s) => s.id)).toEqual(["s2"]);
    expect(last.partStudios).toBeUndefined();
    expect(removeStudio(emptyDocument(), MAIN_STUDIO)).toEqual(emptyDocument());
    expect(removeStudio(doc, "nope")).toBe(doc);
  });

  it("forgets library designs and configuration entries that only lived in it", () => {
    const { doc, boxes } = threeStudios();
    const withRefs: JuraCADDocument = {
      ...doc,
      libraryInserts: [
        { id: "lib1", design: "tray", name: "Tray", prefix: "tray", values: {}, features: [boxes.s2.id] },
        { id: "lib2", design: "tray", name: "Tray 2", prefix: "tray2", values: {}, features: [boxes.s3.id] },
      ],
      configurations: [
        { id: "c1", name: "A", values: {}, suppressed: [boxes.s2.id, boxes.s3.id] },
        { id: "c2", name: "B", values: {}, suppressed: [] },
      ],
      activeConfiguration: "c1",
    };
    const out = removeStudio(withRefs, "s2");
    expect(out.libraryInserts?.map((i) => i.id)).toEqual(["lib2"]);
    expect(out.configurations?.[0].suppressed).toEqual([boxes.s3.id]);
    expect(out.configurations?.[1]).toBe(withRefs.configurations![1]);
  });

  it("names what uses its parts, and takes their assembly copies out with their mates", () => {
    const { doc, boxes } = threeStudios();
    let d = addAssembly(doc, "a1");
    d = insertInstance(d, "a1", { id: boxes.s2.id, name: "Part 2" }, undefined, "i1");
    d = insertInstance(d, "a1", { id: boxes[MAIN_STUDIO].id, name: "Part 1" }, undefined, "i2");
    d = insertInstance(d, "a1", { id: `${boxes.s2.id}~2`, name: "Part 2b" }, undefined, "i3");
    const mate = { id: "m1", name: "Fasten 1", type: "fasten", a: { instanceId: "i2", pick: {} }, b: { instanceId: "i1", pick: {} }, flip: false, values: {} } as unknown as Mate;
    d = putMate(d, "a1", mate);
    // An assembly using a1 as a sub-assembly, mated to the deleted part inside it.
    d = addAssembly(d, "a2");
    d = { ...d, assemblies: d.assemblies!.map((a) => (a.id === "a2" ? { ...a, instances: [{ id: "j1", partId: "", subAssembly: "a1", name: "Assembly 1 <1>", placement: d.assemblies![0].instances[0].placement, fixed: true }, { id: "j2", partId: boxes.s3.id, name: "Part 3 <1>", placement: d.assemblies![0].instances[0].placement, fixed: false }], mates: [{ ...mate, id: "m2", a: { instanceId: "j1", path: ["i1"], pick: {} }, b: { instanceId: "j2", pick: {} } } as unknown as Mate, { ...mate, id: "m3", a: { instanceId: "j1", path: ["i2"], pick: {} }, b: { instanceId: "j2", pick: {} } } as unknown as Mate] } : a)) };
    d = addDrawing(d, "d1", { kind: "part", id: boxes.s2.id });
    d = addDrawing(d, "d2", { kind: "part", id: boxes.s3.id });
    const derived: Feature = { ...createFeature(studioView(d, "s3"), "derived"), derived: { studioId: "s2", partId: boxes.s2.id } };
    d = inStudio(d, "s3", (v) => addFeature(v, derived));

    const users = studioUsers(d, "s2");
    expect(users.assemblies).toEqual([
      { id: "a1", name: d.assemblies![0].name, copies: 2, mates: 0 },
      { id: "a2", name: d.assemblies![1].name, copies: 0, mates: 1 },
    ]);
    expect(users.drawings.map((x) => x.id)).toEqual(["d1"]);
    expect(users.derived).toEqual([{ studioId: "s3", studioName: "Part Studio 3", featureId: derived.id, featureName: derived.name }]);
    const question = deleteStudioQuestion(d, "s2");
    expect(question).toContain("Delete Part Studio 2?");
    expect(question).toContain("its 2 copies");
    expect(question).toContain(`${d.assemblies![1].name}: a mate to Part Studio 2's parts inside a sub-assembly`);
    expect(question).toContain(d.drawings![0].name);
    expect(question).toContain(`"${derived.name}" in Part Studio 3`);
    expect(question).toContain("Undo brings it all back");
    expect(deleteStudioQuestion(d, MAIN_STUDIO)).toContain("Delete Body?");

    const out = deleteStudio(d, "s2");
    const a1 = out.assemblies!.find((a) => a.id === "a1")!;
    expect(a1.instances.map((i) => i.id)).toEqual(["i2"]);
    expect(a1.mates).toBeUndefined();
    const a2 = out.assemblies!.find((a) => a.id === "a2")!;
    expect(a2.instances.map((i) => i.id)).toEqual(["j1", "j2"]);
    // Only the mate reaching the deleted part inside the copy of Assembly 1 goes.
    expect(a2.mates?.map((m) => m.id)).toEqual(["m3"]);
    // Drawings and Derived features stay (they say their part is gone; Undo brings it back).
    expect(out.drawings).toEqual(d.drawings);
    expect(studioFeatures(out, "s3").map((f) => f.id)).toContain(derived.id);
    expect(deleteStudio(removeStudio(removeStudio(d, "s2"), "s3"), MAIN_STUDIO)).toEqual(removeStudio(removeStudio(d, "s2"), "s3"));
  });

  it("keeps every reference working after a reorder (ids never change)", () => {
    const { doc, boxes } = threeStudios();
    let d = addAssembly(doc, "a1");
    d = insertInstance(d, "a1", { id: boxes[MAIN_STUDIO].id, name: "Part 1" }, undefined, "i1");
    const derived: Feature = { ...createFeature(studioView(d, "s3"), "derived"), derived: { studioId: MAIN_STUDIO, partId: boxes[MAIN_STUDIO].id } };
    d = inStudio(d, "s3", (v) => addFeature(v, derived));
    const moved = moveStudio(moveStudio(d, "s3", 0), MAIN_STUDIO, 2);
    expect(moved.assemblies).toBe(d.assemblies);
    expect(studioOfFeature(moved, boxes[MAIN_STUDIO].id)).toBe(MAIN_STUDIO);
    expect(studioFeatures(moved, "s3").find((f) => f.id === derived.id)?.derived?.studioId).toBe(MAIN_STUDIO);
    expect(studioExists(moved, MAIN_STUDIO)).toBe(true);
    expect(studioUsers(moved, MAIN_STUDIO).assemblies[0].copies).toBe(1);
  });
});

describe("placing small popups inside the window", () => {
  const view = { width: 800, height: 600 };
  const size = { width: 260, height: 300 };
  it("goes below its button when there's room, else above, else beside it", () => {
    expect(placePopup({ left: 20, top: 100, right: 36, bottom: 116 }, size, view)).toEqual({ left: 20, top: 120, side: "below" });
    // A swatch near the bottom of the window (the Parts list low down): above it.
    expect(placePopup({ left: 20, top: 560, right: 36, bottom: 576 }, size, view)).toEqual({ left: 20, top: 256, side: "above" });
    // A short window: beside it, as high as fits.
    const short = placePopup({ left: 20, top: 200, right: 36, bottom: 216 }, size, { width: 800, height: 380 });
    expect(short).toEqual({ left: 40, top: 72, side: "right" });
    // Near the right edge: pulled back inside.
    expect(placePopup({ left: 700, top: 100, right: 716, bottom: 116 }, size, view).left).toBe(800 - 8 - 260);
    // Taller than the window: it scrolls inside, from the top margin.
    const tiny = placePopup({ left: 20, top: 100, right: 36, bottom: 116 }, size, { width: 800, height: 200 });
    expect(tiny).toEqual({ left: 40, top: 8, maxHeight: 184, side: "right" });
  });
  it("stays inside when what opened it is partly off the window", () => {
    expect(placePopup({ left: 20, top: -30, right: 36, bottom: -10 }, size, view).top).toBe(8);
    expect(placePopup({ left: 20, top: 900, right: 36, bottom: 920 }, size, view).top).toBe(600 - 8 - 300);
  });
  it("stays inside a narrow window", () => {
    const p = placePopup({ left: 300, top: 400, right: 316, bottom: 416 }, { width: 300, height: 300 }, { width: 320, height: 640 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 300).toBeLessThanOrEqual(320 - 8 + 0.001);
    expect(p.top).toBe(96);
  });
  it("drops a dragged tab after every tab whose middle it has passed", () => {
    expect(dropIndex([50, 150], 10)).toBe(0);
    expect(dropIndex([50, 150], 100)).toBe(1);
    expect(dropIndex([50, 150], 400)).toBe(2);
  });
});
