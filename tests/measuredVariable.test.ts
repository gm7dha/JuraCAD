/** Measured variables (pure): picking, what's missing, too-early uses, renames, Delete with dependents, files. */
import { describe, expect, it } from "vitest";
import { measuredAngle, measuredScopeFor, measuredProblem, newMeasuredDef, parseMeasuredDef, toggleTarget, usedTooEarly, withKind, measuredText, type MeasuredDef } from "../src/model/measuredVariable";
import { renameInFeatures } from "../src/model/variables";
import { findDependents } from "../src/model/dependents";
import { acceptBlocker, missingPick } from "../src/model/draftReady";
import { evaluate, getCurrentScope, setCurrentScope, setMeasuredScope } from "../src/model/expr";
import { copyFeatures, pasteFeatures } from "../src/model/featureClipboard";
import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

const face = (partId: string, x: number): TopoPick => ({ partId, ref: { kind: "face", surface: "PLANE", center: [x, 0, 0], normal: [x > 0 ? 1 : -1, 0, 0] } });
const round: TopoPick = { partId: "p", ref: { kind: "face", surface: "CYLINDRE", center: [0, 0, 0], normal: [0, 0, 1] } };
const plain = (id: string, type: Feature["type"], params: Record<string, string> = {}, extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params, ...extra });
const variable = (id: string, def: MeasuredDef): Feature => plain(id, "variable", {}, { measured: def });

describe("picking what to measure", () => {
  it("a distance takes two things (a third replaces the oldest); a click again takes it out", () => {
    let def = newMeasuredDef(["measured_1"]);
    expect(def.name).toBe("measured_2");
    expect(measuredProblem(def)).toMatch(/Click two things/);
    def = toggleTarget(def, face("p", 0)).def;
    expect(measuredProblem(def)).toMatch(/one more/);
    def = toggleTarget(def, face("p", 40)).def;
    expect(measuredProblem(def)).toBeNull();
    def = toggleTarget(def, { plane: "Top" }).def;
    expect(def.targets).toEqual([face("p", 40), { plane: "Top" }]);
    def = toggleTarget(def, { plane: "Top" }).def;
    expect(def.targets).toEqual([face("p", 40)]);
  });

  it("a diameter takes only something round, and switching kind keeps what still fits", () => {
    const def = withKind(newMeasuredDef([]), "diameter");
    expect(toggleTarget(def, face("p", 0)).error).toMatch(/isn't round/);
    const picked = toggleTarget(def, round).def;
    expect(measuredProblem(picked)).toBeNull();
    expect(withKind(picked, "angle").targets).toEqual([]);
    expect(withKind({ ...picked, kind: "distance", along: "x" }, "distance").along).toBe("x");
    expect(withKind({ ...picked, kind: "distance", along: "x" }, "length").along).toBeUndefined();
    expect(missingPick(variable("v", def))).toMatch(/round/);
    expect(measuredText({ value: 12.00004 })).toBe("12 mm");
    expect(measuredText({ value: 30, angle: true })).toBe("30°");
  });
});

describe("where it can be used", () => {
  const v = variable("v1", { name: "width", kind: "distance", targets: [face("box", 0), face("box", 40)] });
  it("only after it in the list", () => {
    const before = plain("b", "box", { width: "width * 2" });
    const after = plain("a", "box", { width: "width / 2" });
    const early = usedTooEarly([plain("box", "box"), before, v, after]);
    expect([...early.keys()]).toEqual(["b"]);
    expect(early.get("b")).toMatch(/further down the list/);
    // A variable of the same name in the Variables table isn't this one.
    expect(usedTooEarly([before, v], new Set(["width"])).size).toBe(0);
  });

  it("a rename reaches the boxes and sketch dimensions that use it", () => {
    const after = plain("a", "box", { width: "width / 2", depth: "widths" });
    const out = renameInFeatures([v, after], "width", "span");
    expect(out[1].params).toEqual({ width: "span / 2", depth: "widths" });
    expect(renameInFeatures([after], "nothing", "x")).toEqual([after]);
  });

  it("Delete with dependents: the part it measures, and the features using its name", () => {
    const box = plain("box", "box");
    const user = plain("u", "box", { width: "width / 2" });
    const other = plain("o", "box", { width: "10" });
    expect(findDependents([box, v, user, other], ["box"]).dependents).toEqual(["v1", "u"]);
    expect(findDependents([box, v, user, other], ["v1"]).dependents).toEqual(["u"]);
  });
});

describe("files", () => {
  it("a measured variable saves and opens again; reading drops what doesn't make sense", () => {
    const doc = emptyDocument();
    const f = createFeature(doc, "variable");
    expect(f.measured).toEqual({ name: "measured_1", kind: "distance", targets: [] });
    const def: MeasuredDef = { name: "gap", kind: "distance", along: "z", targets: [face("box", 0), { plane: "Top" }, { partId: "box", ref: { kind: "vertex", p: [1, 2, 3] } }] };
    const back = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [{ ...f, measured: def }] })))!;
    expect(back.features[0].measured).toEqual(def);
    expect(parseMeasuredDef({ name: "x", kind: "length", along: "x", targets: [{ nonsense: 1 }] })).toEqual({ name: "x", kind: "length", targets: [] });
    expect(parseMeasuredDef({ kind: "length" })).toBeNull();
  });
});

describe("review fixes", () => {
  const v = variable("v1", { name: "wide", kind: "distance", targets: [face("box", 0), face("box", 40)] });

  it("Accept waits for a usable name of its own, and uses are never renamed to a bad one", () => {
    const table = { table: ["w"], features: [v, variable("v2", { name: "gap", kind: "distance", targets: [face("box", 0), face("box", 40)] })] };
    expect(acceptBlocker({ ...v, measured: { ...v.measured!, name: "2x" } }, null, table)).toMatch(/Variable name/);
    expect(acceptBlocker({ ...v, measured: { ...v.measured!, name: "w" } }, null, table)).toMatch(/Variables table/);
    expect(acceptBlocker({ ...v, measured: { ...v.measured!, name: "gap" } }, null, table)).toMatch(/Another measured/);
    expect(acceptBlocker(v, null, table)).toBeNull();
    const user = plain("u", "box", { width: "wide / 2" });
    expect(renameInFeatures([user], "wide", "2x")).toEqual([user]);
  });

  it("only the measured variables above a feature, switched on, are in its scope", () => {
    const later = variable("v3", { name: "late", kind: "length", targets: [] });
    const off = { ...variable("v4", { name: "off", kind: "length", targets: [] }), suppressed: true };
    const values = { v1: { name: "wide", value: 40 }, v3: { name: "late", value: 7 }, v4: { name: "off", value: 1 }, v9: { name: "elsewhere", value: 3 } };
    const list = [plain("box", "box"), v, plain("u", "box"), later, off];
    expect(measuredScopeFor(list, values, "u")).toEqual({ wide: 40 });
    expect(measuredScopeFor(list, values, "new-one")).toEqual({ wide: 40, late: 7 });
    expect(measuredScopeFor(list, { v1: { name: "tilt", value: 30, angle: true } })).toEqual({ tilt: 30, "°tilt": 1 });
  });

  it("saving and putting the scope back never bakes old measured values in", () => {
    setCurrentScope({ w: 1 });
    setMeasuredScope({ wide: 40 });
    const saved = getCurrentScope();
    setCurrentScope({ w: 2 });
    setCurrentScope(saved);
    setMeasuredScope({ wide: 60 });
    expect(evaluate("wide")).toEqual({ ok: true, value: 60 });
    expect(evaluate("w")).toEqual({ ok: true, value: 1 });
    setMeasuredScope({});
    setCurrentScope({});
  });

  it("angles as Onshape: between edges at a corner 0–180, otherwise 0–90", () => {
    expect(measuredAngle({ dir: [1, 0, 0], kind: "line" }, { dir: [-1, 1, 0], kind: "line" }, true)).toBeCloseTo(135, 9);
    expect(measuredAngle({ dir: [1, 0, 0], kind: "line" }, { dir: [-1, 1, 0], kind: "line" })).toBeCloseTo(45, 9);
    expect(measuredAngle({ dir: [0, 0, 1], kind: "plane" }, { dir: [0, 0, -1], kind: "plane" })).toBeCloseTo(0, 9);
    expect(measuredAngle({ dir: [0, 0, 1], kind: "plane" }, { dir: [1, 0, 1], kind: "line" })).toBeCloseTo(45, 9);
  });

  it("Delete with dependents leaves features using a table variable of the same name; a pasted one gets a free name", () => {
    const user = plain("u", "box", { width: "wide / 2" });
    expect(findDependents([v, user], ["v1"], new Set(["wide"])).dependents).toEqual([]);
    const clip = copyFeatures([v, user], ["v1", "u"], [])!.clip;
    let n = 0;
    const r = pasteFeatures([v, user], clip, { allIds: ["v1", "u"], makeId: () => `p${++n}` });
    expect(r.pasted[0].measured!.name).toBe("wide_2");
    expect(r.pasted[1].params.width).toBe("wide_2 / 2");
  });
});
