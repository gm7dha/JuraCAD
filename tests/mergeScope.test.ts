import { describe, expect, it } from "vitest";

import { findDependents, withoutGone } from "../src/model/dependents";
import { parseFeatures, picksPartsBefore, withoutPicking } from "../src/model/document";
import { copyFeatures, pasteFeatures } from "../src/model/featureClipboard";
import { featureForEngine } from "../src/kernel/buildInput";
import { resolveScope, scopeHeading, scopeMessage, setMergeWithAll, takesMergeScope, toggleScopePart } from "../src/model/mergeScope";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";

const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const sketch = (id: string) => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } });

describe("merge scope: which features take it", () => {
  it("is offered for Add/Remove/Intersect solids, holes, ribs and patterns of features", () => {
    expect(takesMergeScope(feat("e", "extrude", { operation: "add" }))).toBe(true);
    expect(takesMergeScope(feat("e", "extrude", { operation: "remove" }))).toBe(true);
    expect(takesMergeScope(feat("e", "loft", { operation: "intersect" }))).toBe(true);
    expect(takesMergeScope(feat("e", "extrude", { operation: "new" }))).toBe(false);
    expect(takesMergeScope(feat("e", "extrude", { operation: "add", surface: true }))).toBe(false);
    expect(takesMergeScope(feat("h", "hole", { operation: "remove" }))).toBe(true);
    expect(takesMergeScope(feat("r", "rib", { operation: "add" }))).toBe(true);
    expect(takesMergeScope(feat("p", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false } }))).toBe(true);
    expect(takesMergeScope(feat("p", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "part" } }))).toBe(false);
    expect(takesMergeScope(feat("f", "fillet", { operation: "add" }))).toBe(false);
  });

  it("names the box by what it does", () => {
    expect(scopeHeading(feat("e", "extrude", { operation: "add" }))).toBe("Parts to merge with");
    expect(scopeHeading(feat("e", "extrude", { operation: "remove" }))).toBe("Parts to cut");
    expect(scopeHeading(feat("h", "hole", { operation: "remove" }))).toBe("Parts to cut");
    expect(scopeHeading(feat("e", "extrude", { operation: "intersect" }))).toBe("Parts to intersect with");
  });
});

describe("merge scope: ticking and picking", () => {
  it("unticking starts an empty list taking clicks; ticking takes it away (the feature as it was)", () => {
    const f = feat("e", "extrude", { operation: "add" });
    const off = setMergeWithAll(f, false);
    expect(off.mergeScope).toEqual([]);
    expect(off.mergeScopePicking).toBe(true);
    const picked = toggleScopePart(toggleScopePart(off, "a"), "b");
    expect(picked.mergeScope).toEqual(["a", "b"]);
    expect(toggleScopePart(picked, "a").mergeScope).toEqual(["b"]);
    expect(setMergeWithAll(picked, true)).toEqual(f);
    expect(setMergeWithAll(f, true)).toBe(f);
  });

  it("picking shows the parts before the feature, and is never saved or sent to the engine", () => {
    const f = { ...feat("e", "extrude", { operation: "add" }), mergeScope: ["a"], mergeScopePicking: true };
    expect(picksPartsBefore(f)).toBe(true);
    expect(withoutPicking(f).mergeScopePicking).toBeUndefined();
    expect(withoutPicking(f).mergeScope).toEqual(["a"]);
    expect(featureForEngine(f).mergeScopePicking).toBeUndefined();
    expect(featureForEngine(f).mergeScope).toEqual(["a"]);
    const plain = feat("e", "extrude", { operation: "add" });
    expect(featureForEngine(plain)).toBe(plain);
  });
});

describe("merge scope: following parts", () => {
  it("follows a part merged into another, and says which are gone", () => {
    const exists = (id: string) => ["p1", "p3"].includes(id);
    const merged = new Map([["p2", "p1"], ["p4", "gone"]]);
    expect(resolveScope(["p2", "p3", "p1", "p4"], exists, merged)).toEqual({ ids: ["p1", "p3"], lost: ["p4"] });
  });

  it("all gone or none picked is an error; some gone a warning", () => {
    const f = feat("e", "extrude", { operation: "remove" });
    expect(scopeMessage(f, 0, 0).error).toMatch(/Click the parts to cut/);
    expect(scopeMessage(f, 2, 2).error).toMatch(/no longer exist/);
    expect(scopeMessage(f, 3, 1).warning).toMatch(/1 of the 3 parts it was to cut/);
    expect(scopeMessage(f, 2, 0)).toEqual({});
  });
});

describe("merge scope in files, Delete with dependents and copy / paste", () => {
  it("is read back from a file; a feature without it reads exactly as before", () => {
    const f = feat("e", "extrude", { operation: "remove", sketchRef: "s", apart: true, mergeScope: ["box1", 7 as unknown as string] });
    const [back] = parseFeatures([JSON.parse(JSON.stringify(f))], new Set())!;
    expect(back.mergeScope).toEqual(["box1"]);
    const old = feat("e", "extrude", { operation: "remove", sketchRef: "s", apart: true });
    const [again] = parseFeatures([JSON.parse(JSON.stringify(old))], new Set())!;
    expect("mergeScope" in again).toBe(false);
  });

  it("losing some scope parts keeps the feature (partial, without them); losing all takes it too", () => {
    const list = [
      feat("b1", "box"),
      feat("b2", "box"),
      sketch("s"),
      feat("cut", "extrude", { operation: "remove", sketchRef: "s", apart: true, mergeScope: ["b1", "b2~2"] }),
    ];
    const one = findDependents(list, ["b2"]);
    expect(one.dependents).toEqual([]);
    expect(one.partial[0].loses[0]).toMatch(/1 of its 2 parts it merges with or cuts/);
    expect(withoutGone(list[3], new Set(["b2"])).mergeScope).toEqual(["b1"]);
    expect(findDependents(list, ["b1", "b2"]).dependents).toEqual(["cut"]);
    // An old-style cut (no apart) with a scope doesn't follow "the latest part".
    const old = [feat("b1", "box"), feat("b2", "box"), sketch("s"), feat("cut", "extrude", { operation: "remove", sketchRef: "s", mergeScope: ["b1"] })];
    expect(findDependents(old, ["b2"]).dependents).toEqual([]);
  });

  it("pasted copies keep scope parts that are there, and drop those that aren't", () => {
    const list = [feat("b1", "box"), sketch("s"), feat("cut", "extrude", { operation: "remove", sketchRef: "s", apart: true, mergeScope: ["b1"] })];
    const c = copyFeatures(list, ["cut"])!;
    expect(c.clip.outside).toContain("b1");
    let n = 0;
    const here = pasteFeatures(list, c.clip, { allIds: list.map((f) => f.id), makeId: (p) => `${p}_${++n}` });
    expect(here.pasted.find((f) => f.type === "extrude")!.mergeScope).toEqual(["b1"]);
    const elsewhere = pasteFeatures([], c.clip, { allIds: [], makeId: (p) => `${p}_${++n}` });
    expect(elsewhere.pasted.find((f) => f.type === "extrude")!.mergeScope).toEqual([]);
  });
});
