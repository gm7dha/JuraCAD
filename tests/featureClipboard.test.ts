import { describe, expect, it } from "vitest";

import { clipText, copyFeatures, freeName, idsMentioned, missingVariables, pasteFeatures, pasteMessage, readClip, remapIds, variablesUsed } from "../src/model/featureClipboard";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";
import type { TopoPick } from "../src/geometry/topoRef";

const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const edge = (partId: string): TopoPick => ({ partId, ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [1, 0, 0], mid: [0.5, 0, 0], length: 1 } as unknown as TopoPick["ref"] });

const studio = (): Feature[] => [
  feat("f_s1", "sketch", { name: "Sketch 1", sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } }),
  feat("f_e1", "extrude", { name: "Extrude 1", sketchRef: "f_s1", apart: true, params: { depth: "wall * 2" } }),
  feat("f_e12", "extrude", { name: "Extrude 2", sketchRef: "f_s1", apart: true }),
  feat("f_fi", "fillet", { name: "Fillet 1", operation: "add", picks: [edge("f_e1"), edge("f_e12~2")], params: { radius: "r" } }),
];
let n = 0;
const makeId = (p: string) => `${p}_new${++n}`;

describe("finding and changing ids", () => {
  it("finds whole ids only, and ids of a feature's parts and points", () => {
    expect([...idsMentioned({ a: "f_e1" }, ["f_e1", "f_e"])]).toEqual(["f_e1"]);
    expect(idsMentioned({ a: "f_e12" }, ["f_e1"]).size).toBe(0);
    expect(idsMentioned({ a: "f_e1~2", b: "f_e1@cfg" }, ["f_e1"]).size).toBe(1);
    const map = new Map([["f_e1", "f_X"]]);
    expect(remapIds({ a: "f_e1", b: "f_e1~2", c: "f_e12", d: "f_e1_p3", k: { f_e1: 1 } }, map)).toEqual({ a: "f_X", b: "f_X~2", c: "f_e12", d: "f_X_p3", k: { f_X: 1 } });
  });

  it("names copies like Onshape", () => {
    expect(freeName("Extrude 1", new Set(["Extrude 1", "Extrude 2"]))).toBe("Extrude 3");
    expect(freeName("Lid", new Set(["Lid"]))).toBe("Lid (2)");
    expect(freeName("New", new Set())).toBe("New");
  });

  it("finds the variables used, and what they use", () => {
    const vars = [
      { id: "v1", name: "wall", value: "2" },
      { id: "v2", name: "r", value: "wall / 2" },
      { id: "v3", name: "unused", value: "9" },
    ];
    expect(variablesUsed([studio()[3]], vars).map((v) => v.name)).toEqual(["wall", "r"]);
  });
});

describe("copy", () => {
  it("brings an extrude's sketch along and notes what's outside", () => {
    const c = copyFeatures(studio(), ["f_e1"], [{ id: "v1", name: "wall", value: "2" }])!;
    expect(c.clip.features.map((f) => f.id)).toEqual(["f_s1", "f_e1"]);
    expect(c.added).toEqual(["Sketch 1"]);
    expect(c.clip.variables.map((v) => v.name)).toEqual(["wall"]);
    expect(c.clip.outside).toEqual([]);
    const fillet = copyFeatures(studio(), ["f_fi"])!;
    expect(fillet.clip.features.map((f) => f.id)).toEqual(["f_fi"]);
    expect(fillet.clip.outside.sort()).toEqual(["f_e1", "f_e12"]);
    expect(copyFeatures(studio(), ["nope"])).toBeNull();
  });

  it("goes through text and back", () => {
    const c = copyFeatures(studio(), ["f_e1"])!;
    const back = readClip(clipText(c.clip));
    expect(back?.features.map((f) => f.sketchRef ?? f.id)).toEqual(["f_s1", "f_s1"]);
    expect(readClip("hello")).toBeNull();
    expect(readClip('{"format":"juracad-features","version":1,"features":[{"id":1}]}')).toBeNull();
  });
});

describe("paste", () => {
  it("gives new ids and points the copy at its own sketch", () => {
    const list = studio();
    const c = copyFeatures(list, ["f_e1"])!;
    const r = pasteFeatures(list, c.clip, { allIds: list.map((f) => f.id), makeId });
    expect(r.features).toHaveLength(6);
    const [sk, ex] = r.pasted;
    expect(sk.id).not.toBe("f_s1");
    expect(ex.sketchRef).toBe(sk.id);
    expect(r.pasted.map((f) => f.name)).toEqual(["Sketch 2", "Extrude 3"]);
    expect(r.needsPick).toEqual([]);
    // The originals are untouched.
    expect(list[1].sketchRef).toBe("f_s1");
  });

  it("goes after the rollback bar", () => {
    const list = studio();
    const c = copyFeatures(list, ["f_s1"])!;
    const r = pasteFeatures(list, c.clip, { after: "f_s1", allIds: list.map((f) => f.id), makeId });
    expect(r.features.map((f) => f.type)).toEqual(["sketch", "sketch", "extrude", "extrude", "fillet"]);
  });

  it("keeps references the Part Studio has, and drops or reports those it hasn't", () => {
    const list = studio();
    const c = copyFeatures(list, ["f_fi"])!;
    // The same Part Studio: the fillet still rounds the same parts' edges.
    const same = pasteFeatures(list, c.clip, { allIds: list.map((f) => f.id), makeId });
    expect(same.pasted[0].picks?.map((p) => p.partId)).toEqual(["f_e1", "f_e12~2"]);
    // Another Part Studio: its picks are gone, so it needs them picked again.
    const other = pasteFeatures([feat("f_box", "box")], c.clip, { allIds: [...list.map((f) => f.id), "f_box"], makeId });
    expect(other.pasted[0].picks).toEqual([]);
    expect(other.needsPick).toEqual(["Fillet 1"]);
    const ex = copyFeatures(list, ["f_e1"])!;
    // An extrude whose sketch wasn't copied (taken out by hand) needs its sketch picked.
    const lone = { ...ex.clip, features: [ex.clip.features[1]], outside: ["f_s1"] };
    const r = pasteFeatures([], lone, { allIds: [], makeId });
    expect(r.needsPick).toEqual(["Extrude 1"]);
    expect(pasteMessage(r)).toMatch(/pick it again/);
  });

  it("offers the variables the design lacks", () => {
    const list = studio();
    const c = copyFeatures(list, ["f_e1"], [{ id: "v1", name: "wall", value: "2" }])!;
    expect(missingVariables(c.clip, [{ id: "x", name: "wall", value: "5" }])).toEqual([]);
    const r = pasteFeatures([], c.clip, { allIds: [], makeId, variables: [], addVariables: true });
    expect(r.addVariables.map((v) => [v.name, v.value])).toEqual([["wall", "2"]]);
    expect(r.addVariables[0].id).not.toBe("v1");
    expect(pasteMessage(r)).toMatch(/Added the variable wall/);
    const skip = pasteFeatures([], c.clip, { allIds: [], makeId });
    expect(skip.addVariables).toEqual([]);
    expect(pasteMessage(skip, ["wall"])).toMatch(/add it in Variables/);
  });
});
