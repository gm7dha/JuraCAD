/**
 * Sweep's "Lock profile faces", pure: the Profile control choice, clicking faces in and out, reading and saving (a
 * sweep without it saves exactly as before), the parts Delete with dependents sees.
 */
import { describe, expect, it } from "vitest";
import { defaultParams } from "../src/model/features";
import { findDependents } from "../src/model/dependents";
import { lockFacesLabel, parseSweepControl, profileControlOf, sweepClick, sweepPartsUsed, tidySweepControl, withProfileControl, withoutSweepPicking, canTwist } from "../src/model/sweepOptions";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

const sweep = (extra: Partial<Feature> = {}): Feature => ({ id: "s", name: "Sweep 1", type: "sweep", operation: "new", suppressed: false, params: defaultParams("sweep"), sketchRef: "a", ...extra });
const side = (x: number): TopoPick => ({ partId: "box", ref: { kind: "face", surface: "PLANE", center: [x, 15, 5], normal: [x > 0 ? 1 : -1, 0, 0] } });
const other: TopoPick = { partId: "lid", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } };

describe("Lock profile faces", () => {
  it("is a Profile control choice that asks for faces, and switching away forgets them", () => {
    const c = withProfileControl(sweep(), "faces");
    expect(c).toEqual({ picking: "lockFaces" });
    expect(profileControlOf({ sweepControl: c })).toBe("faces");
    expect(canTwist({ sweepControl: c })).toBe(false);
    const picked = { lockFaces: [side(0)] };
    expect(withProfileControl({ sweepControl: picked }, "none")).toBeUndefined();
    expect(withProfileControl({ sweepControl: { lockDirection: { p: [0, 0, 0], axis: "z" } } }, "faces")).toEqual({ picking: "lockFaces" });
    expect(withProfileControl({ sweepControl: picked }, "faces")).toEqual(picked);
  });

  it("clicks faces in and out (one part only), staying ready for more", () => {
    const d = sweep({ sweepControl: { picking: "lockFaces" } });
    const one = sweepClick(d, { kind: "part", pick: side(0) });
    expect(one).toEqual({ sweepControl: { lockFaces: [side(0)], picking: "lockFaces" } });
    const two = sweepClick({ sweepControl: (one as Partial<Feature>).sweepControl }, { kind: "part", pick: side(40) });
    expect((two as Partial<Feature>).sweepControl?.lockFaces).toEqual([side(0), side(40)]);
    const back = sweepClick({ sweepControl: (two as Partial<Feature>).sweepControl }, { kind: "part", pick: side(0) });
    expect((back as Partial<Feature>).sweepControl?.lockFaces).toEqual([side(40)]);
    expect(sweepClick({ sweepControl: (two as Partial<Feature>).sweepControl }, { kind: "part", pick: other })).toMatch(/one part/);
    expect(sweepClick(d, { kind: "corner" })).toMatch(/Click the faces/);
    expect(lockFacesLabel([side(0), side(40)])).toBe("2 faces");
  });

  it("reads and saves only what's set, picking never kept", () => {
    expect(parseSweepControl({ lockFaces: [side(0), { nonsense: 1 }] }, () => null, (p) => (p && typeof p === "object" && "ref" in p ? (p as TopoPick) : null))).toEqual({ lockFaces: [side(0)] });
    expect(tidySweepControl({ lockFaces: [] })).toBeUndefined();
    expect(withoutSweepPicking(sweep({ sweepControl: { lockFaces: [side(0)], picking: "lockFaces" } })).sweepControl).toEqual({ lockFaces: [side(0)] });
  });

  it("needs the faces' part", () => {
    const f = sweep({ sweepControl: { lockFaces: [side(0)] } });
    expect(sweepPartsUsed(f)).toEqual(["box"]);
    const box: Feature = { id: "box", name: "Box 1", type: "box", operation: "new", suppressed: false, params: defaultParams("box") };
    expect(findDependents([box, f], ["box"]).dependents).toContain("s");
  });
});
