/**
 * Corners used beyond Part Studio points (pure): when clicks may pick corners (assemblies, sketches' Use, a loft's end
 * point), a loft's start/end point on a corner, mate ends on corners read from files, Width mates refusing them,
 * two corners mated pointing the same way, and a sketch point following a corner read back from a file.
 */
import { describe, expect, it } from "vitest";
import { cornerWanted, type GeomClick } from "../src/model/geomClicks";
import { loftClick, loftUses, loftWithoutGone, profileLabel } from "../src/model/loft";
import { parseConnector } from "../src/assembly/assembly";
import { vertexConnectorPick } from "../src/assembly/connectors";
import { cornerFlip, pickConnector } from "../src/assembly/mates";
import type { Feature, MateConnector } from "../src/model/types";
import type { VertexRef } from "../src/geometry/vertexRef";
import { parseSketchData } from "../src/sketch/validate";
import { emptySketch } from "../src/sketch/types";
import { linkCorner } from "../src/sketch/links";
import { planeFrame } from "../src/sketch/planes";

const ref: VertexRef = { kind: "vertex", p: [10, 20, 5], rel: [1, 1, 1], dirs: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]] };
const draft = (d: Partial<Feature>) => ({ editing: { draft: { id: "d", name: "d", type: "sketch", operation: "new", suppressed: false, params: {}, ...d } as Feature }, sketch: null });

describe("when corners can be clicked", () => {
  it("in an assembly only while a mate is made or a mirror's connector placed", () => {
    expect(cornerWanted({ editing: null, sketch: null }, true)).toBe(true); // corners of copies, for Measure
    expect(cornerWanted({ editing: null, sketch: null, mateDraft: { mode: "create" } }, true)).toBe(true);
    expect(cornerWanted({ editing: null, sketch: null, mirrorFacePick: true }, true)).toBe(false);
    expect(cornerWanted({ editing: null, sketch: null, mirrorFacePick: "connector" }, true)).toBe(true);
  });
  it("in a sketch only with the Use tool", () => {
    expect(cornerWanted({ editing: null, sketch: { tool: "line" } }, false)).toBe(false);
    expect(cornerWanted({ editing: null, sketch: { tool: "useEdge" } }, false)).toBe(true);
  });
  it("in a Loft only while its start or end point is picked", () => {
    expect(cornerWanted(draft({ type: "loft", loft: {} }), false)).toBe(false);
    expect(cornerWanted(draft({ type: "loft", loft: { picking: "start" } }), false)).toBe(true);
    expect(cornerWanted(draft({ type: "loft", loft: { picking: "guide" } }), false)).toBe(false);
  });
});

describe("a loft to a corner", () => {
  it("takes a clicked corner as its end point, named and known to Delete with dependents", () => {
    const f: Pick<Feature, "sections" | "loft"> = { sections: ["s1"], loft: { picking: "end" } };
    const c: GeomClick = { kind: "corner", pick: { partId: "box", ref } };
    const next = loftClick(f, c);
    if (typeof next === "string") throw new Error(next);
    expect(next.loft?.picking).toBeUndefined();
    expect(next.loft?.profiles).toEqual([{ sketch: "s1" }, { point: { p: [10, 20, 5], vertex: { partId: "box", ref } } }]);
    const last = next.loft!.profiles!.at(-1)!;
    expect(profileLabel(last, (id) => (id === "box" ? "Box" : undefined))).toBe("A corner of Box");
    expect(loftUses(next).sectionParts).toEqual(["box"]);
    const without = loftWithoutGone({ ...next }, () => false, (id) => id === "box");
    expect(without.loft?.profiles).toBeUndefined();
    expect(without.sections).toEqual(["s1"]);
  });
});

describe("mate ends on corners", () => {
  const end = (instanceId: string): MateConnector => ({ instanceId, ...vertexConnectorPick("p1", ref) });
  it("read back from a file as they were; old ends unchanged", () => {
    const c = end("i1");
    expect(parseConnector(JSON.parse(JSON.stringify(c)))).toEqual(c);
    const plain: MateConnector = { instanceId: "i1", pick: c.pick };
    expect(parseConnector(JSON.parse(JSON.stringify(plain)))).toEqual(plain);
    // A broken corner is dropped (the end is then the stand-in face, as a face pick).
    expect(parseConnector({ ...c, vertex: { kind: "vertex", p: [1, 2] } })).toEqual(plain);
  });
  it("a Width mate can't take a corner", () => {
    expect(pickConnector({ type: "width" }, end("i1"))).toEqual({ a: undefined, b: undefined });
  });
  it("two corners mated point the same way (the parts keep their way up)", () => {
    const a = end("i1");
    const b = end("i2");
    const ends = pickConnector({ type: "fastened", a }, b);
    expect(cornerFlip({ a }, ends, false)).toBe(true);
    const face: MateConnector = { instanceId: "i2", pick: a.pick };
    expect(cornerFlip({ a }, pickConnector({ type: "fastened", a }, face), false)).toBe(false);
  });
});

describe("a sketch point from a corner", () => {
  it("is kept with its corner when the sketch is read back", () => {
    const frame = planeFrame({ kind: "default", name: "Top" });
    const r = linkCorner(emptySketch(), frame, { partId: "p1", ref });
    const read = parseSketchData(JSON.parse(JSON.stringify(r.sketch)));
    expect(read?.points.find((p) => p.id === r.pointId)).toEqual(r.sketch.points.find((p) => p.id === r.pointId));
    expect(r.sketch.points.find((p) => p.id === r.pointId)?.link).toEqual({ partId: "p1", ref, end: "corner" });
  });
});
