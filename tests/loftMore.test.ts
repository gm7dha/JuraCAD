/** More of Loft's choices (pure): parts it reaches, edge sections, curve guides, new ends, thin — saved and read back. */
import { describe, expect, it } from "vitest";
import { endChoices, loftClick, loftProfiles, loftUses, toggleSectionEdge } from "../src/model/loft";
import { findDependents, withoutGone } from "../src/model/dependents";
import { createFeature, emptyDocument } from "../src/model/document";
import { defaultParams, visibleParamKeys } from "../src/model/features";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { connectorWanted } from "../src/model/geomClicks";
import type { Feature, JuraCADDocument } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

const edge = (x: number): TopoPick => ({ partId: "box", ref: { kind: "edge", curve: "LINE", a: [x, 0, 10], b: [x + 20, 0, 10], mid: [x + 10, 0, 10], length: 20 } as never });
const face: TopoPick = { partId: "box", ref: { kind: "face", surface: "PLANE", center: [0, 0, 10], normal: [0, 0, 1], area: 400 } as never };
const loft = (patch: Partial<Feature>): Feature => ({ id: "L", name: "Loft 1", type: "loft", operation: "new", suppressed: false, params: {}, ...patch });
const sketch = (id: string): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: { points: [], curves: [], constraints: [] } as never } });
const when = new Date(0);
const read = (features: Feature[]): Feature[] => {
  const d: JuraCADDocument = { ...emptyDocument(), features };
  const r = readDocumentFile(serializeDocument(d, when));
  if (!r.ok) throw new Error(r.error);
  return r.doc.features;
};

describe("new lofts", () => {
  it("reach every part, and keep that when saved", () => {
    const doc = { ...emptyDocument(), features: [sketch("a"), sketch("b")] };
    const f = createFeature(doc, "loft");
    expect(f.apart).toBe(true);
    expect(f.intersectAll).toBe(true);
    // No thin sizes saved until asked for (old lofts stay byte for byte).
    expect(defaultParams("loft")).toEqual({});
    const back = read([sketch("a"), sketch("b"), { ...f, sections: ["a", "b"] }]).find((x) => x.type === "loft")!;
    expect(back.apart).toBe(true);
    expect(back.intersectAll).toBe(true);
    const old = read([sketch("a"), sketch("b"), loft({ sections: ["a", "b"] })]).find((x) => x.type === "loft")!;
    expect(old.apart).toBeUndefined();
    expect(old.params).toEqual({});
  });

  it("reads thin, edge sections, curve guides and the new ends", () => {
    const f = loft({
      sections: ["a"],
      thin: { midPlane: true },
      params: { thickness: "3" },
      loft: {
        profiles: [{ sketch: "a" }, { edges: [edge(0), edge(20)] }],
        start: { kind: "profileTangent", magnitude: 2 },
        end: { kind: "direction", towards: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } },
        path: { curve: "c1" },
      },
    });
    const g = read([sketch("a"), f]).find((x) => x.id === "L")!;
    expect(g.thin).toEqual({ midPlane: true });
    expect(g.params.thickness).toBe("3");
    const sec = loftProfiles(g)[1];
    expect("edges" in sec && sec.edges.map((e) => e.ref.kind === "edge" && e.ref.a)).toEqual([[0, 0, 10], [20, 0, 10]]);
    expect(g.loft?.start).toEqual({ kind: "profileTangent", magnitude: 2 });
    expect(g.loft?.end?.towards?.axis).toBe("z");
    expect(g.loft?.path).toEqual({ curve: "c1" });
    // A direction end with nothing to go by is dropped.
    const odd = read([sketch("a"), loft({ sections: ["a"], loft: { end: { kind: "direction" } } })]).find((x) => x.id === "L")!;
    expect(odd.loft).toBeUndefined();
    // The thin boxes show only when Thin is on.
    expect(visibleParamKeys({ type: "loft" }).has("thickness")).toBe(false);
    expect(visibleParamKeys({ type: "loft", thin: {} }).has("thickness2")).toBe(true);
  });
});

describe("clicks and choices", () => {
  it("puts part edges into a section", () => {
    let list = toggleSectionEdge([{ sketch: "a" }, { point: { p: [0, 0, 9] } }], edge(0), true);
    expect(list.map((x) => Object.keys(x)[0])).toEqual(["sketch", "edges", "point"]);
    list = toggleSectionEdge(list, edge(20), false);
    expect((list[1] as { edges: TopoPick[] }).edges).toHaveLength(2);
    // A fresh one, then taking the only edge out of it takes the section out.
    list = toggleSectionEdge(list, edge(40), true);
    expect(list).toHaveLength(4);
    expect(toggleSectionEdge(list, edge(40), false)).toHaveLength(3);
    // Through a click: the first starts a section, the next goes in it.
    const f = loft({ sections: ["a", "b"], loft: { picking: "newSectionEdges" } });
    const one = loftClick(f, { kind: "part", pick: edge(0) }) as Feature;
    expect(one.loft?.picking).toBe("sectionEdges");
    const two = loftClick(one, { kind: "part", pick: edge(20) }) as Feature;
    expect(loftProfiles(two).filter((p) => "edges" in p)).toHaveLength(1);
    expect(typeof loftClick(one, { kind: "part", pick: face })).toBe("string");
  });

  it("picks an end's direction", () => {
    const f = loft({ sections: ["a", "b"], loft: { start: { kind: "direction", magnitude: 2 }, picking: "startDir" } });
    const g = loftClick(f, { kind: "part", pick: edge(0) }) as Feature;
    expect(g.loft?.start?.kind).toBe("direction");
    expect(g.loft?.start?.magnitude).toBe(2);
    expect(g.loft?.start?.towards?.dir).toEqual([20, 0, 0]);
    expect(g.loft?.picking).toBeUndefined();
    // A plane clicked: its normal.
    const p = loftClick(f, { kind: "plane", plane: { kind: "default", name: "Top" }, frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] } }) as Feature;
    expect(p.loft?.start?.towards?.dir).toEqual([0, 0, 1]);
    expect(connectorWanted({ editing: { draft: f }, sketch: null, mateDraft: null }, false)).toBe(true);
    expect(endChoices({ edges: [edge(0)] })).toContain("direction");
  });
});

describe("what it uses", () => {
  it("knows curve guides, edge sections and direction parts", () => {
    const c: Feature = { id: "c1", name: "Fit spline 1", type: "curve", operation: "new", suppressed: false, params: {} };
    const f = loft({ sections: ["a", "b"], loft: { guide: { curve: "c1" } } });
    expect(loftUses(f).features).toContain("c1");
    expect(findDependents([sketch("a"), sketch("b"), c, f], ["c1"]).dependents).toEqual(["L"]);
    const box: Feature = { id: "box", name: "Box 1", type: "box", operation: "new", suppressed: false, params: {} };
    const withEdges = loft({ sections: ["a", "b"], loft: { profiles: [{ sketch: "a" }, { edges: [edge(0)] }, { sketch: "b" }] } });
    expect(findDependents([box, sketch("a"), sketch("b"), withEdges], ["box"]).partial).toHaveLength(1);
    expect(withoutGone(withEdges, new Set(["box"])).loft).toBeUndefined();
    // The part a direction was picked on goes: that end is left free (the loft stays).
    const dir = loft({ sections: ["a", "b"], loft: { end: { kind: "direction", towards: { p: [0, 0, 0], dir: [1, 0, 0], pick: edge(0) } }, periodic: undefined } });
    expect(findDependents([box, sketch("a"), sketch("b"), dir], ["box"]).dependents).toEqual([]);
    expect(withoutGone(dir, new Set(["box"])).loft).toBeUndefined();
  });
});
