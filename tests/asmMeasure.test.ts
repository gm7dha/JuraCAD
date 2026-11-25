/**
 * Measure and Mass in assemblies, the pure parts: which copies are weighed, where a copy's points and directions
 * end up, materials of configured parts, the summary of placed copies, and how clicks pick faces for Measure.
 */
import { describe, expect, it } from "vitest";

import { copiesToWeigh, keyWithin, materialPartOf, placedDir, placedPoint, placedRef } from "../src/assembly/asmMeasure";
import { quatFromAxisAngle } from "../src/assembly/math";
import { asmMeasureClick, asmPicksNow, asmSelectionAfterClick, clearAsmPicks, livePicks } from "../src/app/asmMeasureState";
import type { InstanceInput } from "../src/kernel/protocol";
import { massSummary, type PartMassProps } from "../src/model/massProps";
import type { SelectionItem } from "../src/model/store";

type V3 = [number, number, number];
const copy = (id: string, position: V3 = [0, 0, 0], extra: Partial<InstanceInput> = {}): InstanceInput => ({ id, partId: "p", name: id, position, rotation: [0, 0, 0, 1], ...extra });

describe("which copies are weighed", () => {
  const all = [copy("a"), copy("b"), copy("sub/x"), copy("sub/y")];
  it("the picked ones (a sub-assembly picked = every part in it)", () => {
    expect(copiesToWeigh(all, ["sub"], []).instances.map((i) => i.id)).toEqual(["sub/x", "sub/y"]);
    expect(copiesToWeigh(all, ["sub"], []).all).toBe(false);
    expect(copiesToWeigh(all, ["b", "sub/y"], []).instances.map((i) => i.id)).toEqual(["b", "sub/y"]);
  });
  it("else every copy not hidden", () => {
    const r = copiesToWeigh(all, [], ["a", "sub"]);
    expect(r.all).toBe(true);
    expect(r.instances.map((i) => i.id)).toEqual(["b"]);
    // A picked copy that's no longer there: all of them.
    expect(copiesToWeigh(all, ["gone"], []).all).toBe(true);
  });
  it("keys within a copy, not one whose name merely starts the same", () => {
    expect(keyWithin("sub/x", "sub")).toBe(true);
    expect(keyWithin("sub2/x", "sub")).toBe(false);
  });
});

describe("where a copy's points go", () => {
  it("turned, moved and mirrored as the engine places the part", () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const p = placedPoint({ position: [100, 0, 0], rotation: q }, [10, 20, 30]);
    expect(p[0]).toBeCloseTo(80, 9);
    expect(p[1]).toBeCloseTo(10, 9);
    expect(p[2]).toBeCloseTo(30, 9);
    // Mirrored: across the part's own YZ plane first.
    expect(placedPoint({ position: [50, 0, 0], rotation: [0, 0, 0, 1], mirrored: true }, [10, 2, 3])).toEqual([40, 2, 3]);
    expect(placedDir({ position: [50, 0, 0], rotation: [0, 0, 0, 1] }, [1, 0, 0])).toEqual([1, 0, 0]);
  });
  it("references follow (for the angle between picks on two copies)", () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const f = placedRef({ kind: "face", surface: "PLANE", center: [10, 0, 0], normal: [1, 0, 0] }, { position: [0, 0, 0], rotation: q });
    expect(f.kind === "face" && f.normal[1]).toBeCloseTo(1, 9);
    expect(f.rel).toBeUndefined();
  });
  it("configured parts take their part's material", () => {
    expect(materialPartOf("p@c1", { p: "steel" })).toBe("p");
    expect(materialPartOf("p@c1", { "p@c1": "oak" })).toBe("p@c1");
    expect(materialPartOf("p", {})).toBe("p");
  });
});

describe("adding up placed copies", () => {
  const props = (id: string, x: number): PartMassProps => ({ partId: id, name: id, volume: 6000, area: 2200, centre: [x, 10, 15], box: [[x - 5, 0, 0], [x + 5, 20, 30]] });
  it("sums every copy and finds the centre of mass between them", () => {
    const s = massSummary([props("a", 5), props("b", 55)], () => 1);
    expect(s.volume).toBe(12000);
    expect(s.mass).toBeCloseTo(12, 9);
    expect(s.centre![0]).toBeCloseTo(30, 9);
    expect(s.box![1][0] - s.box![0][0]).toBe(60);
  });
});

describe("clicking faces of copies for Measure", () => {
  const face = (partId: string, index: number): { kind: "part"; item: SelectionItem } => ({ kind: "part", item: { partId, kind: "face", index } });
  it("a click picks, Shift adds a second, the same one again lets go", () => {
    clearAsmPicks();
    expect(asmMeasureClick(face("a", 1), false)).toBe(false);
    expect(asmPicksNow()).toHaveLength(1);
    expect(asmMeasureClick(face("b", 2), true)).toBe(false);
    expect(asmPicksNow().map((p) => p.partId)).toEqual(["a", "b"]);
    // A third with Shift: the last two are kept.
    asmMeasureClick(face("b", 3), true);
    expect(asmPicksNow().map((p) => p.index)).toEqual([2, 3]);
    // Clicking one of them with Shift takes it out (and says it was picked).
    expect(asmMeasureClick(face("b", 3), true)).toBe(true);
    expect(asmPicksNow().map((p) => p.index)).toEqual([2]);
    // A plain click on the only one picked: let go.
    expect(asmMeasureClick(face("b", 2), false)).toBe(true);
    expect(asmPicksNow()).toHaveLength(0);
    // Empty space: let go.
    asmMeasureClick(face("a", 1), false);
    asmMeasureClick(null, false);
    expect(asmPicksNow()).toHaveLength(0);
  });
  it("picks count only while their copy is selected", () => {
    const picks: SelectionItem[] = [{ partId: "sub/x", kind: "face", index: 0 }, { partId: "b", kind: "edge", index: 1 }];
    expect(livePicks(picks, ["sub", "b"])).toBe(picks);
    expect(livePicks(picks, ["b"]).map((p) => p.partId)).toEqual(["b"]);
  });
  it("what a click does to the copies selected", () => {
    // As handleAssemblyPick: the pick first, then the selection.
    let sel: string[] = [];
    const click = (partId: string, index: number, additive = false) => {
      const top = partId.split("/")[0];
      sel = asmSelectionAfterClick(sel, top, additive, asmMeasureClick(face(partId, index), additive), asmPicksNow());
    };
    clearAsmPicks();
    click("x", 1);
    expect(sel).toEqual(["x"]);
    // Another face of the same copy: still selected, that face picked.
    click("x", 2);
    expect(sel).toEqual(["x"]);
    expect(asmPicksNow().map((p) => p.index)).toEqual([2]);
    // Shift adds a second face of the same copy; the copy stays selected.
    click("x", 3, true);
    expect(sel).toEqual(["x"]);
    expect(asmPicksNow().map((p) => p.index)).toEqual([2, 3]);
    // Shift takes one of the two off: the copy keeps the other, still selected.
    click("x", 3, true);
    expect(sel).toEqual(["x"]);
    expect(livePicks(asmPicksNow(), sel).map((p) => p.index)).toEqual([2]);
    // A plain click on one of two picks keeps just it, and the copy.
    click("x", 3, true);
    click("x", 2);
    expect(sel).toEqual(["x"]);
    expect(asmPicksNow().map((p) => p.index)).toEqual([2]);
    // The only pick clicked again: the copy is let go, as before.
    click("x", 2);
    expect(sel).toEqual([]);
    expect(asmPicksNow()).toHaveLength(0);
    // Two copies with Shift, then a plain click on one of them: just that one.
    click("x", 1);
    click("s/y", 1, true);
    expect(sel).toEqual(["x", "s"]);
    click("s/y", 4);
    expect(sel).toEqual(["s"]);
    // Shift on the only pick of a copy among two: that copy goes, as before.
    click("x", 1, true);
    expect(sel).toEqual(["s", "x"]);
    click("x", 1, true);
    expect(sel).toEqual(["s"]);
  });
});
