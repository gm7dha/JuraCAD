import { describe, expect, it } from "vitest";

import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { evaluate, namesIn, setCurrentScope } from "../src/model/expr";
import { applyVariables, checkName, renameInExpression, resolveVariables, usageCount, type Variable } from "../src/model/variables";
import { addDimension, addRectangle } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";

const v = (name: string, value: string, id = name): Variable => ({ id, name, value });

describe("variables in typed values", () => {
  it("uses variable values, pi and units together", () => {
    expect(evaluate("wall * 2 + 1", { wall: 2 })).toEqual({ ok: true, value: 5 });
    expect(evaluate("d / 2", { d: 25.4 })).toEqual({ ok: true, value: 12.7 });
    expect(evaluate("2 * pi", {})).toEqual({ ok: true, value: Math.round(2 * Math.PI * 1e9) / 1e9 });
    expect(evaluate("1/4 in", {})).toEqual({ ok: true, value: 6.35 });
    expect(evaluate("10 + 1/2 in", {})).toEqual({ ok: true, value: 22.7 });
    expect(evaluate("1 in / 4", {})).toEqual({ ok: true, value: 6.35 });
    expect(evaluate("1 in + gap", { gap: 0.6 })).toEqual({ ok: true, value: 26 });
  });

  it("explains unknown names and bare units", () => {
    expect(evaluate("wal * 2", { wall: 2 })).toEqual({ ok: false, error: 'There\'s no variable called "wal"' });
    expect(evaluate("mm", {}).ok).toBe(false);
  });

  it("doesn't mistake longer names for units", () => {
    expect(evaluate("2 * inner", { inner: 3 })).toEqual({ ok: true, value: 6 });
    expect(evaluate("m2 + 1", { m2: 4 })).toEqual({ ok: true, value: 5 });
    expect(namesIn("wall * 2 in + pi")).toEqual(["wall"]);
  });

  it("uses the document's current variables by default", () => {
    setCurrentScope({ thickness: 3 });
    expect(evaluate("thickness * 2")).toEqual({ ok: true, value: 6 });
    setCurrentScope({});
  });
});

describe("the variable list", () => {
  it("works values out top to bottom", () => {
    const r = resolveVariables([v("wall", "2"), v("outer", "wall * 2 + 20"), v("bolt", "1/4 in")]);
    expect(r.values).toEqual({ wall: 2, outer: 24, bolt: 6.35 });
    expect(r.errors).toEqual({});
  });

  it("explains bad names and order problems", () => {
    expect(checkName("2wall", [])).toMatch(/starting with a letter/);
    expect(checkName("in", [])).toMatch(/unit or constant/);
    expect(checkName("wall", ["wall"])).toMatch(/already/);
    const r = resolveVariables([v("a", "b + 1"), v("b", "2"), v("c", "c + 1"), v("d", "nope")]);
    expect(r.errors.a).toMatch(/further down/);
    expect(r.errors.c).toMatch(/itself/);
    expect(r.errors.d).toMatch(/no variable called "nope"/);
    expect(r.values).toEqual({ b: 2 });
  });

  it("renames whole words only", () => {
    expect(renameInExpression("wall * 2 + wall_b + 1 in", "wall", "thickness")).toBe("thickness * 2 + wall_b + 1 in");
    expect(renameInExpression("2 in + in2", "in2", "gap")).toBe("2 in + gap");
  });
});

describe("variables in a document", () => {
  it("renames everywhere, counts uses, and survives saving", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    box.params.width = "wall * 10";
    box.params.height = "wall";
    doc = addFeature(doc, box);
    doc = applyVariables(doc, [v("wall", "2", "v1")]);
    expect(usageCount(doc, "wall")).toBe(2);

    doc = applyVariables(doc, [v("thickness", "2", "v1")]);
    expect(doc.features[0].params.width).toBe("thickness * 10");
    expect(doc.features[0].params.height).toBe("thickness");

    const saved = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(saved?.variables).toEqual([v("thickness", "2", "v1")]);
    setCurrentScope({});
  });

  it("re-solves sketches when a variable changes", () => {
    const rect = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 10 });
    const bottom = rect.lineIds[0];
    let data = rect.sketch;
    setCurrentScope({ w: 10 });
    const added = addDimension(data, [bottom], { x: 0, y: -5 });
    expect(added.error).toBeUndefined();
    data = added.sketch;
    const id = added.dimensionId;
    data = { ...data, constraints: data.constraints.map((c) => (c.id === id ? { ...c, value: "w" } : c)) };

    let doc = emptyDocument();
    const sk = createFeature(doc, "sketch");
    sk.sketch = { plane: { kind: "default", name: "Top" }, data };
    doc = addFeature(doc, sk);
    doc = applyVariables(doc, [v("w", "35")]);

    const solved = doc.features[0].sketch!.data;
    const line = solved.curves.find((c) => c.id === bottom)!;
    const [p1, p2] = line.type === "line" ? [line.p1, line.p2] : [];
    const pos = (pid: string) => solved.points.find((p) => p.id === pid)!;
    expect(Math.hypot(pos(p1!).x - pos(p2!).x, pos(p1!).y - pos(p2!).y)).toBeCloseTo(35, 4);
    setCurrentScope({});
  });
});
