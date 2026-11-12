/** Loft's further choices (pure): sections, clicks, end conditions, what a loft uses, reading files. */
import { describe, expect, it } from "vitest";
import { endChoices, loftClick, loftProfiles, loftSketches, profilesProblem, tidyEnds, toggleFace, withEndPoint, withProfiles } from "../src/model/loft";
import { findDependents, withoutGone } from "../src/model/dependents";
import { emptyDocument, withoutPicking } from "../src/model/document";
import { featureForEngine } from "../src/kernel/buildInput";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { usedSketches } from "../src/model/visibility";
import type { Feature, JuraCADDocument } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import type { GeomClick } from "../src/model/geomClicks";

const face: TopoPick = { partId: "box", ref: { kind: "face", surface: "PLANE", center: [0, 0, 10], normal: [0, 0, 1], area: 400 } as never };
const edge: TopoPick = { partId: "box", ref: { kind: "edge", curve: "LINE", a: [0, 0, 10], b: [20, 0, 10], mid: [10, 0, 10], length: 20 } as never };
const loft = (patch: Partial<Feature>): Feature => ({ id: "L", name: "Loft 1", type: "loft", operation: "new", suppressed: false, params: {}, ...patch });
const sketch = (id: string): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: { points: [], curves: [], constraints: [] } as never } });

describe("loft sections", () => {
  it("keeps plain lofts in the old shape", () => {
    expect(loftProfiles({ sections: ["a", "b"] })).toEqual([{ sketch: "a" }, { sketch: "b" }]);
    expect(withProfiles({}, [{ sketch: "a" }, { sketch: "b" }])).toEqual({ sections: ["a", "b"], loft: undefined });
    const p = withProfiles({}, [{ face }, { sketch: "b" }]);
    expect(p.sections).toEqual(["b"]);
    expect(p.loft?.profiles).toHaveLength(2);
  });

  it("allows points only at the ends", () => {
    expect(profilesProblem([{ sketch: "a" }])).toMatch(/at least two/);
    expect(profilesProblem([{ sketch: "a" }, { point: { p: [0, 0, 1] } }])).toBeNull();
    expect(profilesProblem([{ sketch: "a" }, { point: { p: [0, 0, 1] } }, { sketch: "b" }])).toMatch(/first or the last/);
    expect(profilesProblem([{ point: { p: [0, 0, 0] } }, { point: { p: [0, 0, 1] } }])).toMatch(/besides the points/);
    expect(withEndPoint([{ sketch: "a" }, { point: { p: [0, 0, 1] } }], "end", null)).toEqual([{ sketch: "a" }]);
    // A face added goes before an end point; clicked again, it's taken out.
    const withFace = toggleFace([{ sketch: "a" }, { point: { p: [0, 0, 1] } }], face);
    expect(withFace.map((x) => Object.keys(x)[0])).toEqual(["sketch", "face", "point"]);
    expect(toggleFace(withFace, face)).toHaveLength(2);
  });

  it("offers end conditions that fit the section", () => {
    expect(endChoices({ point: { p: [0, 0, 0] } })).toEqual(["tangent"]);
    expect(endChoices({ face })).toContain("matchTangent");
    expect(endChoices({ sketch: "a" })).toEqual(["normal"]);
    expect(tidyEnds({ start: { kind: "matchTangent" } }, [{ sketch: "a" }, { sketch: "b" }])).toEqual({ start: undefined });
  });

  it("takes clicks: faces as sections, corners as points, edges as a guide", () => {
    const f = loft({ sections: ["a"] });
    const c: GeomClick = { kind: "part", pick: face };
    const added = loftClick(f, c);
    expect(typeof added).not.toBe("string");
    expect(loftProfiles(added as Feature)).toHaveLength(2);
    expect(loftClick(f, { kind: "part", pick: { ...face, ref: { ...face.ref, surface: "CYLINDRE" } as never } })).toMatch(/curved/);
    const corner = loftClick({ ...f, loft: { picking: "end" } }, { kind: "part", pick: edge, at: [19.9, 0, 10] });
    expect(typeof corner).not.toBe("string");
    const pt = loftProfiles(corner as Feature)[1];
    expect("point" in pt && pt.point.end).toBe("b");
    expect((corner as Feature).loft?.picking).toBeUndefined();
    const guided = loftClick({ ...f, loft: { picking: "guide" } }, { kind: "part", pick: edge });
    expect((guided as Feature).loft?.guide).toEqual({ edges: [{ partId: "box", ref: edge.ref }] });
  });
});

describe("what a click picks", () => {
  it("is never saved or sent to the engine", () => {
    const f = loft({ sections: ["a", "b"], loft: { picking: "guide" } });
    expect(withoutPicking(f).loft).toBeUndefined();
    expect("loft" in withoutPicking(f)).toBe(false);
    expect(featureForEngine(f).loft).toBeUndefined();
    const g = loft({ sections: ["a", "b"], loft: { picking: "end", periodic: true } });
    expect(withoutPicking(g).loft).toEqual({ periodic: true });
    expect(featureForEngine(g).loft).toEqual({ periodic: true });
    // Switching what a click picks doesn't change what the engine is given (so nothing is rebuilt).
    expect(JSON.stringify(featureForEngine(loft({ sections: ["a", "b"], loft: { picking: "path", periodic: true } })))).toBe(JSON.stringify(featureForEngine(g)));
  });
});

describe("what a loft uses", () => {
  it("knows faces, points, guides and paths for Delete with dependents and the eyes", () => {
    const f = loft({ sections: ["a"], loft: { profiles: [{ sketch: "a" }, { point: { p: [0, 0, 5], sketchPoint: { sketch: "t", point: "p1" } } }], guide: { sketch: "g" } } });
    expect(loftSketches(f).sort()).toEqual(["a", "g", "t"]);
    expect(usedSketches([sketch("a"), sketch("t"), sketch("g"), f]).has("g")).toBe(true);
    // The guide's sketch gone: the loft goes too. The tip's sketch gone: too few sections.
    expect(findDependents([sketch("a"), sketch("t"), sketch("g"), f], ["g"]).dependents).toEqual(["L"]);
    expect(findDependents([sketch("a"), sketch("t"), sketch("g"), f], ["t"]).dependents).toEqual(["L"]);
    // A face on a part that goes, with two other sections left: the loft just loses it.
    const box: Feature = { id: "box", name: "Box 1", type: "box", operation: "new", suppressed: false, params: {} };
    const three = loft({ sections: ["a", "b"], loft: { profiles: [{ face }, { sketch: "a" }, { sketch: "b" }] } });
    const d = findDependents([box, sketch("a"), sketch("b"), three], ["box"]);
    expect(d.dependents).toEqual([]);
    expect(d.partial[0].loses[0]).toMatch(/1 of its 3 loft sections/);
    const tidied = withoutGone(three, new Set(["box"]));
    expect(tidied.loft?.profiles).toBeUndefined();
    expect(tidied.sections).toEqual(["a", "b"]);
    // A face's "carry on" end left on a sketch section is dropped too.
    const carried = withoutGone({ ...three, loft: { ...three.loft, start: { kind: "matchTangent" } } }, new Set(["box"]));
    expect(carried.loft).toBeUndefined();
  });

  it("saves and reads the choices, and old lofts are unchanged", () => {
    const when = new Date(0);
    const docOf = (features: Feature[]): JuraCADDocument => ({ ...emptyDocument(), features });
    const read = (d: JuraCADDocument) => {
      const r = readDocumentFile(serializeDocument(d, when));
      if (!r.ok) throw new Error(r.error);
      return r.doc;
    };
    const old = docOf([sketch("a"), sketch("b"), loft({ sections: ["a", "b"] })]);
    const text = serializeDocument(old, when);
    expect(serializeDocument(read(old), when)).toBe(text);
    const f = loft({ sections: ["a"], loft: { profiles: [{ sketch: "a", turn: 1 }, { face, turn: 2 }, { point: { p: [0, 0, 9] } }], start: { kind: "normal", magnitude: 2 }, end: { kind: "tangent" }, guide: { edges: [edge] }, matchCorners: true, periodic: true } });
    const back = read(docOf([sketch("a"), f]));
    const g = back.features.find((x) => x.id === "L")!;
    expect(g.loft?.profiles).toHaveLength(3);
    expect(g.loft?.start).toEqual({ kind: "normal", magnitude: 2 });
    expect(g.loft?.end).toEqual({ kind: "tangent" });
    expect(g.loft?.guide).toBeTruthy();
    expect(g.loft?.matchCorners).toBe(true);
    // Odd values fall back.
    const odd = read(docOf([sketch("a"), loft({ sections: ["a"], loft: { start: { kind: "wobbly" } } as never })]));
    expect(odd.features.find((x) => x.id === "L")!.loft).toBeUndefined();
  });
});
