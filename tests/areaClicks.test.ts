import { describe, expect, it } from "vitest";

import { areaClickMode, areaOutlines, areaShades, areaUnderRay, clickAreaAt, followedSketch, MAX_SHADED_AREAS, rayOnPlane } from "../src/sketch/areaClicks";
import { areasUsedByAll, pickOf, sketchAreas, toggleArea } from "../src/sketch/areas";
import { addCircle, addLine, addRectangle } from "../src/sketch/ops";
import { planeFrame, type PlaneFrame } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
/** A 40 × 30 rectangle split by an upright line at x = 10: a 300 mm² piece on the left, 900 mm² on the right. */
function split(): SketchData {
  const s = addRectangle(emptySketch(), at(0, 0), at(40, 30)).sketch;
  return addLine(s, at(10, 0), at(10, 30)).sketch;
}
const sizeAt = (s: SketchData, i: number) => sketchAreas(s).areas[i].area;

describe("clicking sketch areas in the 3D view", () => {
  const top = planeFrame({ kind: "default", name: "Top" });
  const front = planeFrame({ kind: "default", name: "Front" });
  /** A sloping plane: origin (5, 5, 5), across along X, up tilted 45° between Y and Z. */
  const r = Math.SQRT1_2;
  const tilted: PlaneFrame = { origin: [5, 5, 5], u: [1, 0, 0], v: [0, r, r], n: [0, -r, r] };

  it("finds where a line from the eye meets the plane, in sketch coordinates", () => {
    const hit = rayOnPlane(top, [12, 7, 100], [0, 0, -1])!;
    expect(hit.at[0]).toBeCloseTo(12, 12);
    expect(hit.at[1]).toBeCloseTo(7, 12);
    expect(hit.distance).toBeCloseTo(100, 12);
    // Front: sketch y is world Z; looking along +Y from y = -50.
    const f = rayOnPlane(front, [3, -50, 8], [0, 2, 0])!;
    expect(f.at).toEqual([3, 8]);
    expect(f.distance).toBeCloseTo(50, 12);
    // Sloping plane, looking straight at it from 10 mm away.
    // The point at sketch (2, 2) is (7, 5 + 2r, 5 + 2r); the eye is 10 mm back from it along the normal.
    const eye: [number, number, number] = [7, 5 + 2 * r + 10 * r, 5 + 2 * r - 10 * r];
    const t = rayOnPlane(tilted, eye, tilted.n)!;
    expect(t.at[0]).toBeCloseTo(2, 9);
    expect(t.at[1]).toBeCloseTo(2, 9);
    expect(t.distance).toBeCloseTo(10, 9);
  });

  it("misses a plane seen edge-on or behind the eye", () => {
    expect(rayOnPlane(top, [0, 0, 10], [1, 0, 0])).toBeNull();
    expect(rayOnPlane(top, [0, 0, 10], [0, 0, 1])).toBeNull();
  });

  it("names the area under the pointer (and nothing outside the sketch)", () => {
    const s = split();
    const map = sketchAreas(s);
    const left = areaUnderRay(map, top, [5, 15, 50], [0, 0, -1])!;
    const right = areaUnderRay(map, top, [25, 15, 50], [0, 0, -1])!;
    expect(sizeAt(s, left.index)).toBeCloseTo(300, 9);
    expect(sizeAt(s, right.index)).toBeCloseTo(900, 9);
    expect(left.distance).toBeCloseTo(50, 12);
    expect(areaUnderRay(map, top, [50, 15, 50], [0, 0, -1])).toBeNull();
  });

  it("a click toggles the area with exactly the picks the 2D map makes", () => {
    const s = split();
    const map = sketchAreas(s);
    const right = map.areaAt([25, 15]);
    const once = clickAreaAt(s, top, [25, 15, 0], undefined);
    expect(once).toEqual(toggleArea(map, undefined, right));
    expect(once).toEqual([pickOf(map.areas[right])]);
    expect(once![0][2]).toBe(900);
    // Clicking the other area adds it; clicking the first again leaves just the other.
    const both = clickAreaAt(s, top, [5, 15, 0], once)!;
    expect(both).toHaveLength(2);
    const after = clickAreaAt(s, top, [25, 15, 0], both)!;
    expect(after).toHaveLength(1);
    expect(after[0][2]).toBe(300);
    // Last one off: back to every closed shape.
    expect(clickAreaAt(s, top, [5, 15, 0], after)).toBeUndefined();
    // A click outside every area changes nothing.
    expect(clickAreaAt(s, top, [80, 15, 0], once)).toBe(once);
  });

  it("works on a sketch on a sloping plane", () => {
    const s = split();
    // Sketch (25, 15) on the tilted plane.
    const p: [number, number, number] = [5 + 25, 5 + 15 * r, 5 + 15 * r];
    const picks = clickAreaAt(s, tilted, p, undefined)!;
    expect(picks[0][2]).toBe(900);
  });

  it("shades picked areas strongly, and with nothing picked the areas every closed shape uses", () => {
    const s = split();
    const map = sketchAreas(s);
    const left = map.areaAt([5, 15]);
    const right = map.areaAt([25, 15]);
    const all = areaShades(s, undefined);
    expect(all[left]).toBe("used");
    expect(all[right]).toBe("used");
    const one = areaShades(s, clickAreaAt(s, top, [25, 15, 0], undefined));
    expect(one[right]).toBe("picked");
    expect(one[left]).toBe("none");
  });

  it("decides when area clicks come before faces", () => {
    expect(areaClickMode(null)).toBe("off");
    expect(areaClickMode({ type: "extrude" })).toBe("off");
    expect(areaClickMode({ type: "extrude", sketchRef: "s1" })).toBe("first");
    expect(areaClickMode({ type: "revolve", sketchRef: "s1" })).toBe("first");
    expect(areaClickMode({ type: "sweep", sketchRef: "s1" })).toBe("first");
    expect(areaClickMode({ type: "extrude", sketchRef: "s1", surface: true })).toBe("off");
    expect(areaClickMode({ type: "fillet", sketchRef: "s1" })).toBe("off");
    expect(areaClickMode({ type: "extrude", sketchRef: "s1", extrude: { end: "blind", flip: false } })).toBe("first");
    for (const end of ["upToFace", "upToVertex", "upToPart"] as const) {
      expect(areaClickMode({ type: "extrude", sketchRef: "s1", extrude: { end, flip: false } })).toBe("afterParts");
    }
  });

  it("uses the sketch as it follows its face (where the engine moved it), not where it was saved", () => {
    const plate = addRectangle(emptySketch(), at(0, 0), at(40, 30)).sketch;
    const saved = addCircle(plate, at(10, 10), 2).sketch;
    const moved = addCircle(plate, at(13, 10), 2).sketch;
    const feature = { id: "s1", sketch: { plane: { kind: "default", name: "Top" } as const, data: saved } };
    const follows = followedSketch(feature, { s1: { edges: [], links: {}, sketch: { plane: { kind: "default", name: "Top" }, data: moved } } })!;
    expect(follows.data).toBe(moved);
    // The hole is at x = 13 now: a click at 13.5 picks the disc in it (π × 2² mm²), not the plate.
    const picks = clickAreaAt(follows.data, top, [13.5, 10, 0], undefined)!;
    expect(picks[0][2]).toBeCloseTo(Math.PI * 4, 1); // a circle is drawn as 72 straight pieces
    // With the saved sketch the same click lands on the plate.
    expect(clickAreaAt(saved, top, [13.5, 10, 0], undefined)![0][2]).toBeCloseTo(1200 - Math.PI * 4, 0);
    // Not moved: the saved sketch (and a moved plane on its own).
    expect(followedSketch(feature, {})!.data).toBe(saved);
    const plane = { kind: "face", origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], label: "Face" } as const;
    expect(followedSketch(feature, { s1: { edges: [], links: {}, plane } })).toEqual({ plane, data: saved });
    expect(followedSketch(undefined, {})).toBeNull();
  });

  it("keeps one outline list per sketch, so the 3D drawing is only remade when the areas change", () => {
    const s = split();
    expect(areaOutlines(sketchAreas(s))).toBe(areaOutlines(sketchAreas(s)));
    expect(areaOutlines(sketchAreas(s))).toHaveLength(2);
  });

  it("shades a plate with 900 holes quickly (it took 7.5 s)", () => {
    let s = addRectangle(emptySketch(), at(0, 0), at(310, 310)).sketch;
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) s = addCircle(s, at(10 + i * 10, 10 + j * 10), 3).sketch;
    const map = sketchAreas(s); // found once per sketch anyway (the 2D map needs it too)
    expect(map.areas).toHaveLength(901);
    const t = performance.now();
    const shades = areaShades(s, undefined);
    expect(performance.now() - t).toBeLessThan(2000);
    // Only the plate is used; the discs in its holes aren't.
    expect(shades.filter((x) => x === "used")).toHaveLength(1);
    expect(map.areas[shades.indexOf("used")].area).toBeCloseTo(310 * 310 - 900 * Math.PI * 9, -2); // within 50 mm² (circles are many-sided)
  });

  it("doesn't shade a fine grid of lines (9801 areas), and answers at once", () => {
    let g = emptySketch();
    for (let i = 0; i < 100; i++) {
      g = addLine(g, at(i, -0.5), at(i, 99.5)).sketch;
      g = addLine(g, at(-0.5, i), at(99.5, i)).sketch;
    }
    const map = sketchAreas(g);
    expect(map.areas.length).toBeGreaterThan(MAX_SHADED_AREAS);
    const t = performance.now();
    const shades = areaShades(g, undefined);
    expect(performance.now() - t).toBeLessThan(500);
    expect(shades.every((x) => x === "none")).toBe(true);
    // Working it out anyway is quick too now (it took 4 s): crossing lines make no closed shapes.
    const t2 = performance.now();
    expect(areasUsedByAll(g).size).toBe(0);
    expect(performance.now() - t2).toBeLessThan(2000);
  });
});
