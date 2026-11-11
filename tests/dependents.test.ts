import { describe, expect, it } from "vitest";

import { addAssembly, insertInstance } from "../src/assembly/assembly";
import { addDrawing } from "../src/drawing/drawing";
import { deleteFeatures, deletePlan, deleteQuestion, findDependents, listNames, outsideLines, partMaker, withoutGone } from "../src/model/dependents";
import { emptyDocument } from "../src/model/document";
import { addStudio, studioFeatures } from "../src/model/studios";
import type { Feature, JuraCADDocument } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { emptySketch } from "../src/sketch/types";

function feat(id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature {
  return { id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra };
}
const sketch = (id: string, extra: Partial<Feature> = {}) => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() }, ...extra });
const edge = (partId: string): TopoPick => ({ partId, ref: { kind: "edge" } as unknown as TopoPick["ref"] });
const face = (partId: string): TopoPick => ({ partId, ref: { kind: "face" } as unknown as TopoPick["ref"] });
const onFace = (id: string, partId: string) =>
  sketch(id, { sketch: { plane: { kind: "face", origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], label: "Top face of Part 1", face: face(partId) }, data: emptySketch() } });

/** Sketch 1 → Extrude 1 → Fillet 1 → Sketch 2 (on its face) → Extrude 2 (Add), and a separate Box. */
function chain(): Feature[] {
  return [
    sketch("s1"),
    feat("e1", "extrude", { sketchRef: "s1", apart: true }),
    feat("box", "box"),
    feat("f1", "fillet", { operation: "add", picks: [edge("e1"), edge("e1")] }),
    onFace("s2", "e1"),
    feat("e2", "extrude", { operation: "add", sketchRef: "s2", apart: true }),
    feat("f2", "fillet", { operation: "add", picks: [edge("box")] }),
  ];
}

describe("finding what uses a feature", () => {
  it("follows a sketch → extrude → fillet → sketch on its face → extrude chain", () => {
    const d = findDependents(chain(), ["s1"]);
    expect(d.picked).toEqual(["s1"]);
    expect(d.dependents).toEqual(["e1", "f1", "s2", "e2"]);
    expect(d.partial).toEqual([]);
  });

  it("starts from the middle of the list and leaves earlier features alone", () => {
    expect(findDependents(chain(), ["f1"]).dependents).toEqual([]);
    expect(findDependents(chain(), ["e1"]).dependents).toEqual(["f1", "s2", "e2"]);
    expect(findDependents(chain(), ["box"]).dependents).toEqual(["f2"]);
  });

  it("knows parts by the feature that made them (pieces and configured copies too)", () => {
    expect(partMaker("e1~3")).toBe("e1");
    expect(partMaker("e1@c2")).toBe("e1");
    const list = [sketch("s1"), feat("e1", "extrude", { sketchRef: "s1" }), feat("c1", "chamfer", { picks: [edge("e1~2")] })];
    expect(findDependents(list, ["s1"]).dependents).toEqual(["e1", "c1"]);
  });

  it("keeps a fillet that loses only some of its edges, and says so", () => {
    const list = [...chain(), feat("f3", "fillet", { picks: [edge("e1"), edge("box")] })];
    const d = findDependents(list, ["e1"]);
    expect(d.dependents).not.toContain("f3");
    expect(d.partial).toEqual([{ id: "f3", name: "f3", loses: ["1 of its 2 picked edges and faces"] }]);
  });

  it("goes through patterns and mirrors: the features they repeat, their axes and planes", () => {
    const list = [
      sketch("s1"),
      feat("e1", "extrude", { sketchRef: "s1" }),
      feat("h1", "hole", { hole: { sketchRef: "s1" } as Feature["hole"] }),
      feat("lp", "linearPattern", { pattern: { sources: ["e1", "h1"], axis: "x", flip: false } }),
      feat("lp2", "linearPattern", { pattern: { sources: ["box"], axis: "x", flip: false, along: edge("e1") } }),
      feat("mp", "mirror", { mirror: { sources: ["box"], plane: { kind: "default", name: "Top" }, planePick: face("e1") } }),
      feat("ml", "mirror", { mirror: { sources: ["box"], plane: { kind: "default", name: "Top" }, line: { sketch: "s1", line: "l1" } } }),
      feat("cp", "circularPattern", { pattern: { sources: ["box"], axis: "z", flip: false, line: { sketch: "s1", line: "l1" } } }),
      feat("half", "mirror", { mirror: { sources: [], plane: { kind: "default", name: "Right" }, part: "e1" } }),
    ];
    expect(findDependents(list, ["s1"]).dependents).toEqual(["e1", "h1", "lp", "lp2", "mp", "ml", "cp", "half"]);
    // A pattern of two features where only one goes keeps the other.
    const d = findDependents(list, ["h1"]);
    expect(d.dependents).toEqual([]);
    expect(d.partial.map((p) => p.id)).toEqual(["lp"]);
    // A mirror not yet given a plane doesn't use the old one.
    const unset = [sketch("s1"), feat("m", "mirror", { mirror: { sources: ["x"], plane: { kind: "default", name: "Top" }, line: { sketch: "s1", line: "l" }, unset: true } })];
    expect(findDependents(unset, ["s1"]).dependents).toEqual([]);
  });

  it("goes through Plane features made from faces, and what's drawn on them", () => {
    const plane = { kind: "face" as const, origin: [0, 0, 5] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Plane 1", planeRef: "p1" };
    const list = [
      sketch("s1"),
      feat("e1", "extrude", { sketchRef: "s1" }),
      feat("p1", "plane", { planeDef: { mode: "offset", axis: "u", ref: { kind: "face", origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], label: "face", face: face("e1") } } }),
      sketch("s2", { sketch: { plane, data: emptySketch() } }),
      feat("split", "split", { splitDef: { plane, keep: "both" } }),
      feat("t1", "text", { text: { value: "Hi", plane, bold: false, flip: false } }),
    ];
    expect(findDependents(list, ["e1"]).dependents).toEqual(["p1", "s2", "split", "t1"]);
  });

  it("deletes a loft left with one section, keeps one left with two", () => {
    const list = [sketch("a"), sketch("b"), sketch("c"), feat("l2", "loft", { sections: ["a", "b"] }), feat("l3", "loft", { sections: ["a", "b", "c"] })];
    const d = findDependents(list, ["a"]);
    expect(d.dependents).toEqual(["l2"]);
    expect(d.partial).toEqual([{ id: "l3", name: "l3", loses: ["1 of its 3 loft sections"] }]);
  });

  it("keeps an extrude that also takes areas of a deleted sketch, and a sketch with references brought in", () => {
    const data = emptySketch();
    data.points.push({ id: "p", x: 0, y: 0, link: { sketch: "s1", item: "q" } } as (typeof data.points)[number]);
    data.points.push({ id: "p2", x: 0, y: 0, link: { partId: "e1", ref: { kind: "edge" } as never, end: "a" } } as (typeof data.points)[number]);
    const list = [
      sketch("s1"),
      sketch("s0"),
      feat("e1", "extrude", { sketchRef: "s0", moreAreas: [{ sketch: "s1", areas: [] }] }),
      sketch("s3", { sketch: { plane: { kind: "default", name: "Front" }, data } }),
    ];
    const d = findDependents(list, ["s1"]);
    expect(d.dependents).toEqual([]);
    expect(d.partial).toEqual([
      { id: "e1", name: "e1", loses: ["1 extra sketch it takes areas from"] },
      { id: "s3", name: "s3", loses: ["1 reference brought in from elsewhere"] },
    ]);
    expect(findDependents(list, ["s0"]).partial).toEqual([{ id: "s3", name: "s3", loses: ["1 reference brought in from elsewhere"] }]);
  });

  it("follows parts named by Boolean, Delete part, Transform, Up to face and sheet metal flanges", () => {
    const list = [
      sketch("s1"),
      feat("e1", "extrude", { sketchRef: "s1" }),
      feat("box", "box"),
      feat("u", "boolean", { booleanDef: { op: "union", targets: ["e1", "box"], tools: [], keepTools: false } }),
      feat("cut", "boolean", { booleanDef: { op: "subtract", targets: ["box"], tools: ["e1"], keepTools: false } }),
      feat("del", "deletePart", { deleteParts: ["e1"] }),
      feat("mv", "transform", { transform: { partId: "e1", axis: "z", about: "origin", copy: false } }),
      feat("up", "extrude", { sketchRef: "s9", extrude: { end: "upToFace", flip: false, upTo: face("e1") } }),
      feat("fl", "flange", { picks: [edge("e1")] }),
    ];
    const d = findDependents(list, ["e1"]);
    // A union left with one part to join has nothing to do, so it goes too.
    expect(d.dependents).toEqual(["u", "cut", "del", "mv", "up", "fl"]);
    // "Up to" only counts when the extrude really ends there; a Split by a surface ignores its plane.
    const loose = [
      sketch("s1"),
      feat("e1", "extrude", { sketchRef: "s1", apart: true }),
      feat("blind", "extrude", { sketchRef: "s9", apart: true, extrude: { end: "blind", flip: false, upTo: face("e1") } }),
      feat("sp", "split", { splitDef: { plane: { kind: "face", origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], label: "f", face: face("e1") }, toolPartId: "box", keep: "both" } }),
    ];
    expect(findDependents(loose, ["s1"]).dependents).toEqual(["e1"]);
  });

  it("takes old-style Add/Remove features whose latest part goes (they'd change an earlier part instead)", () => {
    // The user's block, then a stencil-like design: its sheet, letters cut from it (not apart), bridges added back.
    const list = [
      feat("block", "box"),
      sketch("sheetSk"),
      feat("sheet", "extrude", { sketchRef: "sheetSk", apart: true }),
      sketch("lettersSk"),
      feat("letters", "extrude", { operation: "remove", sketchRef: "lettersSk", extrude: { end: "throughAll", flip: false } }),
      sketch("bridgesSk"),
      feat("bridges", "extrude", { operation: "add", sketchRef: "bridgesSk" }),
      // Onshape-style ones keep their own rules (cutting whatever they reach), and a later New starts afresh.
      feat("apartCut", "extrude", { operation: "remove", sketchRef: "lettersSk", apart: true }),
      feat("later", "box"),
      feat("laterCut", "extrude", { operation: "remove", sketchRef: "lettersSk" }),
    ];
    expect(findDependents(list, ["sheetSk"]).dependents).toEqual(["sheet", "letters", "bridges"]);
    // A suppressed maker isn't the latest part.
    const off = list.map((f) => (f.id === "sheet" ? { ...f, suppressed: true } : f));
    expect(findDependents(off, ["sheetSk"]).dependents).toEqual(["sheet"]);
    // A Split keeping both pieces, or an Enclose, makes the latest part: deleting the earlier maker keeps the cut, deleting them takes it.
    for (const maker of [feat("split", "split", { splitDef: { partId: "block", plane: { kind: "default", name: "Right" }, keep: "both" } }), feat("split", "enclose")]) {
      const after = [...list.slice(0, 7), maker, feat("cyl", "cylinder", { operation: "remove" })];
      expect(findDependents(after, ["sheetSk"]).dependents).toEqual(["sheet", "letters", "bridges"]);
      expect(findDependents(after, ["split"]).dependents).toEqual(["cyl"]);
    }
    // Keeping one side adds no part.
    const oneSide = [...list.slice(0, 7), feat("split", "split", { splitDef: { partId: "block", plane: { kind: "default", name: "Right" }, keep: "front" } }), feat("cyl", "cylinder", { operation: "remove" })];
    expect(findDependents(oneSide, ["split"]).dependents).toEqual([]);
    // A pattern of a New feature makes parts too.
    const pat = [feat("block", "box"), sketch("k"), feat("peg", "extrude", { sketchRef: "k" }), feat("row", "linearPattern", { pattern: { sources: ["peg"], axis: "x", flip: false } }), feat("cut", "extrude", { operation: "remove", sketchRef: "k2" })];
    expect(findDependents(pat, ["row"]).dependents).toEqual(["cut"]);
  });

  it("rewrites the features left without what they used, so they still build", () => {
    const data = emptySketch();
    data.points.push({ id: "p", x: 0, y: 0, link: { sketch: "a", item: "q" } } as (typeof data.points)[number]);
    data.points.push({ id: "p2", x: 1, y: 0 } as (typeof data.points)[number]);
    data.curves.push({ id: "c", kind: "line", a: "p", b: "p2", link: { partId: "e1~2", ref: { kind: "edge" } } } as unknown as (typeof data.curves)[number]);
    const f = feat("x", "sketch", {
      sketch: { plane: { kind: "default", name: "Top" }, data },
      picks: [edge("e1"), edge("box")],
      pattern: { sources: ["a", "b"], axis: "x", flip: false },
      sections: ["a", "b", "c"],
      moreAreas: [{ sketch: "a", areas: [] }],
      booleanDef: { op: "subtract", targets: ["box"], tools: ["e1", "box2"], keepTools: false },
      deleteParts: ["e1", "box"],
    });
    const out = withoutGone(f, new Set(["a", "e1"]));
    expect(out.picks!.map((p) => p.partId)).toEqual(["box"]);
    expect(out.pattern!.sources).toEqual(["b"]);
    expect(out.sections).toEqual(["b", "c"]);
    expect(out.moreAreas).toBeUndefined();
    expect(out.booleanDef!.tools).toEqual(["box2"]);
    expect(out.deleteParts).toEqual(["box"]);
    expect(out.sketch!.data.points[0].link).toBeUndefined();
    expect((out.sketch!.data.curves[0] as { link?: unknown }).link).toBeUndefined();
    expect(withoutGone(f, new Set(["zzz"]))).toBe(f);
  });

  it("asks in plain English", () => {
    const list = chain().map((f) => ({ ...f, name: { s1: "Sketch 1", e1: "Extrude 1", f1: "Fillet 1", s2: "Sketch 2", e2: "Extrude 2" }[f.id] ?? f.name }));
    expect(deleteQuestion(list, findDependents(list, ["s2"]))).toBe("Delete Sketch 2 and the feature that uses it: Extrude 2?");
    expect(deleteQuestion(list, findDependents(list, ["s1"]))).toBe("Delete Sketch 1 and the 4 features that use it: Extrude 1, Fillet 1, Sketch 2 and Extrude 2?");
    expect(deleteQuestion(list, findDependents(list, ["f1", "e2"]))).toBe("Delete Fillet 1 and Extrude 2? Nothing else uses them.");
    expect(listNames(["A", "B"])).toBe("A and B");
  });
});

describe("deleting with dependents", () => {
  it("removes them all in one change and forgets them in configurations", () => {
    let doc: JuraCADDocument = { ...emptyDocument(), features: chain() };
    doc = { ...doc, configurations: [{ id: "c1", name: "A", values: {}, suppressed: ["f1", "box"] }, { id: "c2", name: "B", values: {}, suppressed: [] }] };
    const plan = deletePlan(doc, "main", ["s1"]);
    const out = deleteFeatures(doc, [...plan.picked, ...plan.dependents]);
    expect(out.features.map((f) => f.id)).toEqual(["box", "f2"]);
    expect(out.configurations![0].suppressed).toEqual(["box"]);
    expect(out.configurations![1]).toBe(doc.configurations![1]);
    expect(deleteFeatures(doc, ["nothing"])).toBe(doc);
    // Tidied: the fillet over two parts keeps only the box's edge.
    const two = { ...doc, features: [...chain(), feat("f3", "fillet", { picks: [edge("e1"), edge("box")] })] };
    expect(deleteFeatures(two, ["s1", "e1", "f1", "s2", "e2"], true).features.find((f) => f.id === "f3")!.picks!.map((p) => p.partId)).toEqual(["box"]);
    expect(deleteFeatures(two, ["s1", "e1", "f1", "s2", "e2"]).features.find((f) => f.id === "f3")!.picks).toHaveLength(2);
  });

  it("forgets a library design whose features have all gone, and its variables nothing else uses", () => {
    const doc: JuraCADDocument = {
      ...emptyDocument(),
      features: [feat("mine", "box", { params: { x: "keep_me * 2" } }), sketch("lib_a"), feat("lib_b", "extrude", { sketchRef: "lib_a", params: { depth: "box_t + box_w" } })],
      variables: [
        { id: "v1", name: "box_t", value: "3" },
        { id: "v2", name: "box_w", value: "box_t * 4" },
        { id: "v3", name: "keep_me", value: "box_t" },
      ],
      libraryInserts: [{ id: "lib", design: "finger-box", name: "Box 1", prefix: "box", values: {}, features: ["lib_a", "lib_b"], variables: { t: "v1", w: "v2" } }],
      configurations: [{ id: "c", name: "A", values: { v1: "4", v2: "9", v3: "1" }, suppressed: [] }],
    };
    const out = deleteFeatures(doc, ["lib_a", "lib_b"], true);
    expect(out.libraryInserts).toBeUndefined();
    // box_t is still used by keep_me, so it stays; box_w goes.
    expect(out.variables!.map((v) => v.name)).toEqual(["box_t", "keep_me"]);
    expect(out.configurations![0].values).toEqual({ v1: "4", v3: "1" });
    // Only some of its features gone: the design stays.
    expect(deleteFeatures(doc, ["lib_b"], true).libraryInserts).toHaveLength(1);
  });

  it("names assemblies, drawings and other Part Studios' Derived features using parts that go", () => {
    let doc: JuraCADDocument = { ...emptyDocument(), features: chain() };
    doc = addStudio(doc, "s2studio");
    doc = { ...doc, partStudios: doc.partStudios!.map((s) => ({ ...s, features: [feat("d1", "derived", { name: "Derived 1", derived: { studioId: "main", partId: "e1" } })] })) };
    doc = addAssembly(doc, "a1");
    doc = insertInstance(insertInstance(doc, "a1", { id: "e1", name: "Part 1" }), "a1", { id: "box", name: "Part 2" });
    doc = addDrawing(doc, "dr1", { kind: "part", id: "e1" });
    const plan = deletePlan(doc, "main", ["s1"]);
    expect(plan.outside.assemblies.map((a) => a.copies)).toEqual([1]);
    expect(plan.outside.drawings.map((d) => d.id)).toEqual(["dr1"]);
    expect(plan.outside.derived).toEqual([{ studioName: studioNameOf(doc), featureName: "Derived 1" }]);
    expect(outsideLines(plan.outside)).toHaveLength(3);
    // Deleting just the box's fillet touches nothing outside.
    expect(outsideLines(deletePlan(doc, "main", ["f2"]).outside)).toEqual([]);
    // Just the picked feature: its own parts only.
    expect(deletePlan(doc, "main", ["e2"], true).outside.assemblies).toEqual([]);
    expect(studioFeatures(doc, "s2studio")).toHaveLength(1);
  });
});

const studioNameOf = (doc: JuraCADDocument) => doc.partStudios![0].name;
