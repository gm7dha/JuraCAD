import { describe, expect, it } from "vitest";

import { allows, boxPicks, filterSummary, NO_FILTER, partHitAs, toggleFilter } from "../src/viewport/selectionFilter";
import { choiceLabel, MOST_CHOICES, orderChoices, shapeWord, type OtherHit } from "../src/viewport/selectOther";
import { cleanCamera, nextViewName, parseNamedViews, removeNamedView, removeViewsOf, renameNamedView, saveNamedView, viewNameProblem, viewsOf } from "../src/model/namedViews";
import { emptyDocument, parseDocument } from "../src/model/document";

const face = (partId: string, index: number, distance: number): OtherHit => ({ kind: "face", partId, index, distance, point: [0, 0, 0], local: [0, 0, 0] });
const edge = (partId: string, index: number, distance: number): OtherHit => ({ kind: "edge", partId, index, distance, point: [0, 0, 0], local: [0, 0, 0] });

describe("selection filter", () => {
  it("lets everything through with nothing chosen", () => {
    expect(allows(NO_FILTER, "face")).toBe(true);
    expect(allows(NO_FILTER, "plane")).toBe(true);
    expect(partHitAs(NO_FILTER, "edge")).toBe("self");
    expect(filterSummary(NO_FILTER)).toBe("Everything");
  });

  it("limits picks to the kinds chosen, and turns faces and edges into whole parts", () => {
    const edges = toggleFilter(NO_FILTER, "edge");
    expect(edges).toEqual(["edge"]);
    expect(partHitAs(edges, "face")).toBeNull();
    expect(partHitAs(edges, "edge")).toBe("self");
    expect(allows(edges, "plane")).toBe(false);
    const parts = toggleFilter(NO_FILTER, "part");
    expect(partHitAs(parts, "face")).toBe("whole");
    // While a tool is open, "parts" means its faces and edges (so the tool still gets what it needs).
    expect(partHitAs(parts, "face", false)).toBe("self");
    const both = toggleFilter(parts, "face");
    expect(partHitAs(both, "face")).toBe("self");
    expect(partHitAs(both, "edge")).toBe("whole");
    expect(filterSummary(both)).toBe("Faces and parts");
  });

  it("ticking every kind is the same as no filter, and the order is fixed", () => {
    let f = NO_FILTER;
    for (const k of ["sketch", "plane", "part", "edge", "face"] as const) f = toggleFilter(f, k);
    expect(f).toEqual(NO_FILTER);
    expect(toggleFilter(toggleFilter(NO_FILTER, "sketch"), "face")).toEqual(["face", "sketch"]);
    expect(toggleFilter(["face"], "face")).toEqual(NO_FILTER);
  });

  it("box selection picks parts, or faces/edges when only those are chosen", () => {
    expect(boxPicks(NO_FILTER)).toEqual({ parts: true, faces: false, edges: false });
    expect(boxPicks(["face"])).toEqual({ parts: false, faces: true, edges: false });
    expect(boxPicks(["face", "part"])).toEqual({ parts: true, faces: false, edges: false });
    expect(boxPicks(["plane"])).toEqual({ parts: false, faces: false, edges: false });
  });
});

describe("select other", () => {
  it("lists front to back, edges before the face they're on, each once, then whole parts", () => {
    const hits: OtherHit[] = [face("b", 0, 20), face("a", 2, 10), edge("a", 5, 10), face("a", 2, 10), { kind: "plane", plane: "Top", distance: 15 }, face("a", 4, 30)];
    const list = orderChoices(hits, NO_FILTER);
    expect(list.map((c) => (c.kind === "part" ? `part ${c.partId}` : c.kind === "plane" ? c.plane : c.kind === "face" || c.kind === "edge" ? `${c.kind} ${c.partId}${c.index}` : c.kind))).toEqual([
      "edge a5",
      "face a2",
      "Top",
      "face b0",
      "face a4",
      "part a",
      "part b",
    ]);
  });

  it("follows the filter", () => {
    const hits: OtherHit[] = [edge("a", 1, 5), face("a", 0, 5), { kind: "plane", plane: "Top", distance: 8 }, { kind: "sketchArea", sketch: "s1", index: 0, distance: 4 }];
    expect(orderChoices(hits, ["face"]).map((c) => c.kind)).toEqual(["face"]);
    expect(orderChoices(hits, ["part"]).map((c) => c.kind)).toEqual(["part"]);
    expect(orderChoices(hits, ["plane", "sketch"]).map((c) => c.kind)).toEqual(["sketchArea", "plane"]);
    // No whole parts while a tool is open.
    expect(orderChoices(hits, NO_FILTER, false).some((c) => c.kind === "part")).toBe(false);
  });

  it("lists mate connectors and sketch lines too", () => {
    const hits: OtherHit[] = [face("a", 0, 5), { kind: "connector", key: "mc1", distance: 5 }, { kind: "sketchLine", sketch: "s1", line: "l2", distance: 3 }];
    const list = orderChoices(hits, NO_FILTER);
    expect(list.slice(0, 3).map((c) => c.kind)).toEqual(["sketchLine", "connector", "face"]);
    expect(orderChoices(hits, ["sketch"]).map((c) => c.kind)).toEqual(["sketchLine"]);
    expect(orderChoices(hits, ["plane"]).map((c) => c.kind)).toEqual(["connector"]);
    const names = { part: () => "P", feature: (id: string) => (id === "s1" ? "Sketch 1" : id), connector: () => "Mate connector 1" };
    expect(list.map((c) => choiceLabel(c, names)).slice(0, 2)).toEqual(["Line in Sketch 1", "Mate connector 1"]);
  });

  it("keeps the list short", () => {
    const hits = Array.from({ length: 40 }, (_, i) => face("p" + i, 0, i));
    expect(orderChoices(hits, NO_FILTER)).toHaveLength(MOST_CHOICES);
  });

  it("names each row in plain words", () => {
    const names = { part: (id: string) => (id === "a" ? "Bracket" : id), feature: (id: string) => (id === "s1" ? "Sketch 1" : id), shape: (k: "face" | "edge") => (k === "face" ? "PLANE" : "LINE") };
    const [e, f, p] = orderChoices([edge("a", 1, 1), face("a", 0, 1)], NO_FILTER);
    expect(choiceLabel(e, names)).toBe("Straight edge of Bracket");
    expect(choiceLabel(f, names)).toBe("Flat face of Bracket");
    expect(choiceLabel(p, names)).toBe("Bracket (whole part)");
    expect(choiceLabel({ kind: "sketchArea", sketch: "s1", index: 0, distance: 1 }, names)).toBe("Area of Sketch 1");
    expect(choiceLabel({ kind: "plane", plane: "Front", distance: 1 }, names)).toBe("Front plane");
    expect(shapeWord("face", "CYLINDRE")).toBe("round");
    expect(shapeWord("edge", "BSPLINE")).toBe("curved");
  });
});

describe("named views", () => {
  const cam = { dir: [0, 0, 2] as [number, number, number], target: [1, 2, 3] as [number, number, number], zoom: 2, up: [0, 1, 0] as [number, number, number] };

  it("saves, renames and deletes views per Part Studio or assembly", () => {
    let doc = emptyDocument();
    expect(nextViewName(doc, "main")).toBe("View 1");
    doc = saveNamedView(doc, "main", "", cam, "v1");
    doc = saveNamedView(doc, "main", "  Side   on ", cam, "v2");
    doc = saveNamedView(doc, "asm", "Side on", cam, "v3");
    expect(viewsOf(doc, "main").map((v) => v.name)).toEqual(["View 1", "Side on"]);
    expect(viewsOf(doc, "main")[0].dir).toEqual([0, 0, 1]);
    expect(viewsOf(doc, "asm")).toHaveLength(1);
    // Saving under a name already there replaces that view.
    doc = saveNamedView(doc, "main", "side on", { ...cam, zoom: 5 }, "v9");
    expect(viewsOf(doc, "main").map((v) => [v.id, v.zoom])).toEqual([["v1", 2], ["v2", 5]]);
    expect(viewNameProblem(doc, "v1", "Side on")).toMatch(/already/);
    expect(renameNamedView(doc, "v1", "Side on")).toBe(doc);
    doc = renameNamedView(doc, "v1", "Top down");
    expect(viewsOf(doc, "main")[0].name).toBe("Top down");
    doc = removeNamedView(doc, "v1");
    doc = removeViewsOf(doc, "asm");
    expect(doc.namedViews?.map((v) => v.id)).toEqual(["v2"]);
    expect("namedViews" in removeNamedView(doc, "v2")).toBe(false);
  });

  it("refuses broken cameras", () => {
    expect(cleanCamera({ ...cam, zoom: 0 })).toBeNull();
    expect(cleanCamera({ ...cam, dir: [0, 0, 0] })).toBeNull();
    expect(cleanCamera({ ...cam, up: [1, Number.NaN, 0] })).toBeNull();
  });

  it("is kept in files, and older files are unchanged", () => {
    const plain = emptyDocument();
    expect("namedViews" in (parseDocument(JSON.parse(JSON.stringify(plain))) ?? {})).toBe(false);
    const doc = saveNamedView(plain, "main", "Close up", cam, "v1");
    const back = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(back?.namedViews).toEqual(doc.namedViews);
    expect(parseNamedViews([{ id: "x", owner: "main", name: "Bad", dir: [0, 0, 1], target: [0, 0], zoom: 1, up: [0, 1, 0] }, "junk"])).toEqual([]);
  });
});
