import { describe, expect, it } from "vitest";

import type { TopoPick } from "../src/geometry/topoRef";
import { addFeature, createFeature, emptyDocument, parseDocument } from "../src/model/document";
import {
  linePlane,
  mirrorReferenceText,
  parseLineRef,
  patternReferenceText,
  pickableSketchLines,
  planeThroughLine,
  referenceShape,
  setMirrorReference,
  setPatternDirection,
  sketchLine3D,
} from "../src/model/patternRefs";
import type { Feature } from "../src/model/types";
import { visibleParamKeys } from "../src/model/features";
import { addLine } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";

const r = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

const face: TopoPick = { partId: "box1", ref: { kind: "face", surface: "PLANE", center: [20, 5, 7.5], normal: [1, 0, 0] } };
const round: TopoPick = { partId: "box1", ref: { kind: "face", surface: "CYLINDRE", center: [60, 40, 5], normal: [0, 0, 1] } };

/** A design with a box and a sketch on the Front plane holding one upright line at x = 30 (z 0…10). */
function design() {
  let doc = emptyDocument();
  const box = createFeature(doc, "box");
  doc = addFeature(doc, box);
  const drawn = addLine(emptySketch(), { x: 30, y: 0 }, { x: 30, y: 10 }, { construction: true });
  const sk = createFeature(doc, "sketch");
  sk.sketch = { plane: { kind: "default", name: "Front" }, data: drawn.sketch };
  doc = addFeature(doc, sk);
  return { doc, box, sk, line: { sketch: sk.id, line: drawn.lineId } };
}

describe("sketch lines as references", () => {
  it("finds a sketch line in 3D, and the mirror plane through it square to its sketch", () => {
    const { doc, sk, line } = design();
    const l = sketchLine3D(doc.features, line);
    if (typeof l === "string") throw new Error(l);
    expect(r(l.a)).toEqual([30, 0, 0]);
    expect(r(l.b)).toEqual([30, 0, 10]);
    expect(l.name).toBe(`Construction line 1 in ${sk.name}`);
    // Up the Front plane at x = 30: the plane through it facing across X.
    const p = planeThroughLine(l);
    expect(r(p.origin)).toEqual([30, 0, 0]);
    expect(Math.abs(p.n[0])).toBeCloseTo(1, 9);
    const sp = linePlane(l);
    expect(r(sp.origin)).toEqual([30, 0, 5]);
    expect(sp.label).toBe(`Plane through Construction line 1 in ${sk.name}`);
  });

  it("explains a missing sketch or line in plain English", () => {
    const { doc, line } = design();
    expect(sketchLine3D(doc.features, { ...line, sketch: "nope" })).toMatch(/sketch with the picked line has been deleted/);
    expect(sketchLine3D(doc.features, { ...line, line: "nope" })).toMatch(/line picked in .* has been deleted/);
    const suppressed = doc.features.map((f) => (f.type === "sketch" ? { ...f, suppressed: true } : f));
    expect(sketchLine3D(suppressed, line)).toMatch(/is suppressed/);
  });

  it("lists the lines that can be clicked: only in sketches before the feature", () => {
    const { doc, box, line } = design();
    expect(pickableSketchLines(doc.features, null).map((l) => l.line)).toEqual([line.line]);
    expect(pickableSketchLines(doc.features, box.id)).toEqual([]);
  });

  it("checks saved references", () => {
    expect(parseLineRef({ sketch: "s", line: "l" })).toEqual({ sketch: "s", line: "l" });
    expect(parseLineRef({ sketch: 3, line: "l" })).toBeNull();
    expect(parseLineRef(null)).toBeNull();
  });
});

describe("choosing a mirror plane", () => {
  const base = { sources: ["a"], plane: { kind: "default" as const, name: "Right" as const } };

  it("keeps one choice at a time, and names it", () => {
    const { doc, line, box } = design();
    const onBox = { ...face, partId: box.id };
    const byFace = setMirrorReference(base, { kind: "face", plane: { kind: "face", origin: [20, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "Face of Box 1" }, pick: onBox });
    expect(byFace.planePick).toEqual(onBox);
    expect(mirrorReferenceText(byFace, doc.features)).toBe("Flat face of Box 1");
    const byLine = setMirrorReference(byFace, { kind: "line", line, plane: { kind: "default", name: "Top" } });
    expect(byLine.planePick).toBeUndefined();
    expect(byLine.line).toEqual(line);
    expect(mirrorReferenceText(byLine, doc.features)).toMatch(/^Construction line 1 in Sketch/);
    const cleared = setMirrorReference(byLine, { kind: "none" });
    expect(cleared.unset).toBe(true);
    expect(cleared.line).toBeUndefined();
    expect(mirrorReferenceText(cleared, doc.features)).toBeNull();
    const top = setMirrorReference(cleared, { kind: "plane", plane: { kind: "default", name: "Top" } });
    expect(top).toEqual({ sources: ["a"], plane: { kind: "default", name: "Top" } });
    expect(mirrorReferenceText(top, doc.features)).toBe("Top plane");
  });

  it("shows the plane to mirror across in the 3D view (a clicked face is highlighted on the part instead)", () => {
    const { doc, line } = design();
    const f = (mirror: Feature["mirror"]): Feature => ({ id: "m", name: "Mirror 1", type: "mirror", operation: "add", suppressed: false, params: {}, mirror });
    expect(referenceShape(f(base), doc.features, {})).toEqual({ kind: "plane", origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1] });
    expect(referenceShape(f({ ...base, planePick: face }), doc.features, {})).toBeNull();
    expect(referenceShape(f({ ...base, unset: true }), doc.features, {})).toBeNull();
    const shown = referenceShape(f({ ...base, line }), doc.features, {});
    expect(shown?.kind).toBe("line");
  });
});

describe("choosing a pattern's direction or axis", () => {
  const base = { sources: ["a"], axis: "z" as const, flip: false };

  it("keeps one choice at a time, and names it", () => {
    const { doc, line, box } = design();
    const picked = setPatternDirection(base, { kind: "pick", pick: { ...round, partId: box.id } });
    expect(patternReferenceText(picked, doc.features)).toBe("Round face of Box 1");
    const byLine = setPatternDirection(picked, { kind: "line", line });
    expect(byLine.along).toBeUndefined();
    expect(patternReferenceText(byLine, doc.features)).toMatch(/^Construction line 1/);
    const cleared = setPatternDirection(byLine, { kind: "none" });
    expect(cleared).toEqual({ ...base, unset: true });
    expect(patternReferenceText(cleared, doc.features)).toBeNull();
    expect(setPatternDirection(cleared, { kind: "axis", axis: "x" })).toEqual({ ...base, axis: "x" });
  });

  it("swaps a grid's rows over when the copies are set to go their way, and clears the rows back to the default", () => {
    const grid = { ...base, axis: "x" as const, axis2: "y" as const };
    expect(setPatternDirection(grid, { kind: "axis", axis: "y" })).toEqual({ ...grid, axis: "y", axis2: "x" });
    const rows = setPatternDirection(grid, { kind: "pick", pick: face }, true);
    expect(rows.along2).toEqual(face);
    expect(patternReferenceText(rows, [], true)).toBe("Flat face of a part");
    expect(setPatternDirection(rows, { kind: "none" }, true)).toEqual(grid);
    expect(patternReferenceText(grid, [], true)).toBe("Y axis");
  });

  it("only asks where the axis goes through for X, Y or Z", () => {
    const keys = (pattern: NonNullable<Feature["pattern"]>) => [...visibleParamKeys({ type: "circularPattern", extrude: undefined, hole: undefined, planeDef: undefined, fastener: undefined, surface: undefined, pattern })].filter((k) => k.startsWith("c") && k.length === 2);
    expect(keys(base)).toEqual(["cx", "cy"]);
    expect(keys({ ...base, unset: true })).toEqual([]);
    expect(keys({ ...base, line: { sketch: "s", line: "l" } })).toEqual([]);
    expect(keys({ ...base, along: round })).toEqual([]);
  });

  it("draws a circular pattern's X, Y or Z axis through its typed point", () => {
    const f: Feature = { id: "c", name: "Circular pattern 1", type: "circularPattern", operation: "add", suppressed: false, params: {}, pattern: base };
    expect(referenceShape(f, [], { cx: 5, cy: 6, cz: 0 })).toEqual({ kind: "axis", through: [5, 6, 0], dir: [0, 0, 1] });
    expect(referenceShape({ ...f, pattern: { ...base, along: round } }, [], {})).toBeNull();
  });
});

describe("saving and opening", () => {
  it("keeps picked planes, faces, lines and 'not chosen yet' through a save", () => {
    const { doc, line } = design();
    let d = doc;
    const mirror = createFeature(d, "mirror");
    mirror.mirror = { ...mirror.mirror!, planePick: face, line, unset: true };
    d = addFeature(d, mirror);
    const circ = createFeature(d, "circularPattern");
    circ.pattern = { ...circ.pattern!, along: round, line, unset: true };
    d = addFeature(d, circ);
    const lin = createFeature(d, "linearPattern");
    lin.pattern = { ...lin.pattern!, line, line2: line };
    d = addFeature(d, lin);
    const saved = parseDocument(JSON.parse(JSON.stringify(d)));
    expect(saved?.features.find((f) => f.id === mirror.id)?.mirror).toEqual(mirror.mirror);
    expect(saved?.features.find((f) => f.id === circ.id)?.pattern).toEqual(circ.pattern);
    expect(saved?.features.find((f) => f.id === lin.id)?.pattern).toEqual(lin.pattern);
  });

  it("opens older files exactly as they were: nothing new is added", () => {
    // As saved before this change: a mirror across a clicked face (a fixed plane) and a circular pattern about Z.
    const old = {
      format: "partsmith",
      version: 1,
      features: [
        { id: "b", name: "Box 1", type: "box", operation: "new", suppressed: false, params: { width: "40", depth: "30", height: "20", x: "0", y: "0", z: "0" } },
        {
          id: "m",
          name: "Mirror 1",
          type: "mirror",
          operation: "add",
          suppressed: false,
          params: {},
          mirror: { sources: ["b"], plane: { kind: "face", origin: [40, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "Face of Part 1" } },
        },
        { id: "c", name: "Circular pattern 1", type: "circularPattern", operation: "add", suppressed: false, params: { count: "6", angle: "360", cx: "5", cy: "0", cz: "0" }, pattern: { sources: ["b"], axis: "z", flip: false } },
      ],
    };
    const doc = parseDocument(old);
    expect(doc?.features[1].mirror).toEqual(old.features[1].mirror);
    expect(doc?.features[2].pattern).toEqual(old.features[2].pattern);
    // A new mirror made outside the dialog (e.g. by Claude) still starts across the Right plane, as before.
    expect(createFeature(emptyDocument(), "mirror").mirror?.unset).toBeUndefined();
  });
});
