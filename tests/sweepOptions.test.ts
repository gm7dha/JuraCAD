/**
 * Sweep's further choices, pure: twist as an angle, turns or a pitch; what the kernel is told; the size boxes shown;
 * profile control; clicks; reading and saving (older sweeps byte for byte); what Delete with dependents sees; and how
 * a path is shared out either side of a profile part way along it.
 */
import { describe, expect, it } from "vitest";
import { defaultParams, resolveParams, visibleParamKeys } from "../src/model/features";
import { emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { findDependents } from "../src/model/dependents";
import { directionLabel, parseSweepControl, profileControlOf, sweepClick, sweepSettings, twistDegrees, withProfileControl, withoutSweepPicking } from "../src/model/sweepOptions";
import { scaleAlong, shareHalves, splitAtPlace } from "../src/kernel/sweepPath";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

const sweep = (extra: Partial<Feature> = {}): Feature => ({ id: "s", name: "Sweep 1", type: "sweep", operation: "new", suppressed: false, params: defaultParams("sweep"), sketchRef: "a", pathRef: "b", ...extra });
const face: TopoPick = { partId: "box", ref: { kind: "face", surface: "PLANE", center: [5, 5, 10], normal: [0, 0, 1] } };
const edge: TopoPick = { partId: "box", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [0, 0, 10], mid: [0, 0, 5] } };

describe("twist", () => {
  it("as an angle, turns or a pitch, either way", () => {
    expect(twistDegrees("angle", 90, false, () => 0)).toBe(90);
    expect(twistDegrees("angle", 90, true, () => 0)).toBe(-90);
    expect(twistDegrees("turns", 2, false, () => 0)).toBe(720);
    expect(twistDegrees("pitch", 25, false, () => 100)).toBe(1440);
    expect(twistDegrees("pitch", 25, true, () => 100)).toBe(-1440);
    expect(() => twistDegrees("pitch", 0, false, () => 100)).toThrow(/more than 0/);
  });

  it("tells the kernel exactly what an older sweep always did", () => {
    expect(sweepSettings(sweep(), { twist: 30 })).toEqual({ twist: 30, lockOrientation: false });
    expect(sweepSettings(sweep({ sweepControl: { lockOrientation: true } }), { twist: 30 })).toEqual({ twist: 30, lockOrientation: true });
    expect(sweepSettings(sweep({ sweepControl: { twistBy: "turns", opposite: true } }), { turns: 1.5 })).toEqual({ twist: -540, lockOrientation: false });
    expect(sweepSettings(sweep({ sweepControl: { twistBy: "pitch" } }), { pitch: 20 })).toEqual({ pitch: 20, lockOrientation: false });
    expect(sweepSettings(sweep({ sweepControl: { scaled: true } }), { twist: 0, scale: 0.5 })).toEqual({ twist: 0, lockOrientation: false, scale: 0.5 });
    expect(sweepSettings(sweep({ sweepControl: { lockDirection: { p: [0, 0, 0], axis: "z" } } }), { twist: 0 }, [0, 0, 1]).lockDirection).toEqual([0, 0, 1]);
  });

  it("shows one twist box, none when the profile is held, and the scale when on", () => {
    const keys = (f: Feature) => [...visibleParamKeys(f)].filter((k) => ["twist", "turns", "pitch", "scale"].includes(k));
    expect(keys(sweep())).toEqual(["twist"]);
    expect(keys(sweep({ sweepControl: { twistBy: "turns" } }))).toEqual(["turns"]);
    expect(keys(sweep({ sweepControl: { twistBy: "pitch", scaled: true } }))).toEqual(["pitch", "scale"]);
    expect(keys(sweep({ sweepControl: { lockOrientation: true } }))).toEqual([]);
    expect(keys(sweep({ sweepControl: { lockDirection: { p: [0, 0, 0], axis: "x" }, scaled: true } }))).toEqual(["scale"]);
  });

  it("leaves new sweeps' params as they were (the new boxes only when typed)", () => {
    const p = defaultParams("sweep");
    expect(p.turns).toBeUndefined();
    expect(p.pitch).toBeUndefined();
    expect(p.scale).toBeUndefined();
    expect(resolveParams(sweep({ sweepControl: { scaled: true } })).values.scale).toBe(1);
    expect(resolveParams(sweep({ sweepControl: { scaled: true }, params: { ...p, scale: "0" } })).errors.scale).toMatch(/more than 0/);
  });
});

describe("profile control", () => {
  it("switches between None, Keep profile orientation and Lock profile direction", () => {
    const f = sweep();
    expect(profileControlOf(f)).toBe("none");
    const keep = withProfileControl(f, "keep");
    expect(keep).toEqual({ lockOrientation: true });
    // Lock profile direction with nothing clicked yet: asks for a click.
    expect(withProfileControl({ sweepControl: keep }, "direction")).toEqual({ picking: "direction" });
    expect(withProfileControl({ sweepControl: { picking: "direction" } }, "none")).toBeUndefined();
    const dir = { p: [0, 0, 0] as [number, number, number], axis: "z" as const };
    expect(profileControlOf({ sweepControl: { lockDirection: dir } })).toBe("direction");
    expect(withProfileControl({ sweepControl: { lockDirection: dir, scaled: true } }, "keep")).toEqual({ lockOrientation: true, scaled: true });
  });

  it("takes clicks for the face and the direction", () => {
    expect(sweepClick(sweep(), { kind: "part", pick: face })).toBeNull();
    const pf = sweepClick(sweep({ sweepControl: { picking: "face" } }), { kind: "part", pick: face });
    expect(pf).toEqual({ sweepControl: { face }, sketchRef: undefined, areas: undefined, moreAreas: undefined });
    expect(sweepClick(sweep({ sweepControl: { picking: "face" } }), { kind: "part", pick: edge })).toMatch(/flat face/);
    const round: TopoPick = { partId: "c", ref: { kind: "face", surface: "CYLINDRE", center: [0, 0, 0], normal: [0, 0, 1] } };
    expect(sweepClick(sweep({ sweepControl: { picking: "face" } }), { kind: "part", pick: round })).toMatch(/curved/);
    const d = sweep({ sweepControl: { picking: "direction", scaled: true } });
    expect(sweepClick(d, { kind: "part", pick: edge })).toEqual({ sweepControl: { scaled: true, lockDirection: { p: [0, 0, 0], dir: [0, 0, 1], pick: edge } } });
    expect(sweepClick(d, { kind: "plane", plane: { kind: "default", name: "Front" }, frame: { origin: [0, 0, 0], n: [0, -1, 0] } })).toEqual({ sweepControl: { scaled: true, lockDirection: { p: [0, 0, 0], axis: "y" } } });
    expect(sweepClick(d, { kind: "connector", id: "mc", origin: [1, 2, 3], z: [1, 0, 0] })).toEqual({ sweepControl: { scaled: true, lockDirection: { p: [1, 2, 3], dir: [1, 0, 0], connector: "mc" } } });
    expect(sweepClick(d, { kind: "corner" })).toMatch(/no direction/);
    expect(directionLabel({ p: [0, 0, 0], axis: "y" })).toBe("The Y axis");
    expect(directionLabel(undefined)).toMatch(/Not chosen/);
  });
});

describe("saving and reading", () => {
  it("an older sweep saves byte for byte the same after being read", () => {
    for (const extra of [{}, { sweepControl: { lockOrientation: true } }] as Partial<Feature>[]) {
      const doc = { ...emptyDocument(), features: [sweep({ ...extra, params: { ...defaultParams("sweep"), twist: "45" } })] };
      const at = new Date(0);
      const text = serializeDocument(doc, at);
      const read = readDocumentFile(text);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(serializeDocument(read.doc, at)).toBe(text);
        expect(read.doc.features[0].sweepControl).toEqual(extra.sweepControl);
      }
    }
  });

  it("keeps the new choices, drops odd ones and never the view-click state", () => {
    const c = { lockDirection: { p: [0, 0, 0], axis: "z" }, twistBy: "pitch", opposite: true, scaled: true, face, picking: "face", junk: 3 };
    const pickOf = (p: unknown) => (p && typeof p === "object" ? (p as TopoPick) : null);
    const geomOf = (g: unknown) => (g && typeof g === "object" ? (g as { p: [number, number, number] }) : null);
    expect(parseSweepControl(c, geomOf, pickOf)).toEqual({ lockDirection: { p: [0, 0, 0], axis: "z" }, twistBy: "pitch", opposite: true, scaled: true, face });
    expect(parseSweepControl({ twistBy: "spin", lockOrientation: "yes" }, geomOf, pickOf)).toBeUndefined();
    expect(withoutSweepPicking(sweep({ sweepControl: { picking: "direction" } })).sweepControl).toBeUndefined();
    const doc = { ...emptyDocument(), features: [sweep({ sweepControl: { twistBy: "turns", scaled: true, face }, params: { twist: "0", turns: "2", scale: "0.5" } })] };
    const text = serializeDocument(doc, new Date(0));
    const read = readDocumentFile(text);
    expect(read.ok && read.doc.features[0].sweepControl).toEqual({ twistBy: "turns", scaled: true, face });
  });

  it("Delete with dependents knows the profile face's part and a locked direction's sketch", () => {
    const box: Feature = { id: "box", name: "Box 1", type: "box", operation: "new", suppressed: false, params: {} };
    const line: Feature = { id: "ln", name: "Sketch 2", type: "sketch", operation: "new", suppressed: false, params: {} };
    const s = sweep({ sketchRef: undefined, sweepControl: { face } });
    expect(findDependents([box, s], ["box"]).dependents).toEqual(["s"]);
    const d = sweep({ sweepControl: { lockDirection: { p: [0, 0, 0], sketchLine: { sketch: "ln", line: "l1" } } } });
    expect(findDependents([line, d], ["ln"]).dependents).toEqual(["s"]);
  });
});

describe("a profile part way along", () => {
  it("splits the path there and shares the twist and size by length", () => {
    const segs = [
      { kind: "line" as const, from: [0, 0] as [number, number], to: [100, 0] as [number, number] },
      { kind: "line" as const, from: [100, 0] as [number, number], to: [100, 20] as [number, number] },
    ];
    const [before, after] = splitAtPlace(segs, { index: 0, t: 0.5 });
    expect(before).toEqual([{ kind: "line", from: [0, 0], to: [50, 0] }]);
    expect(after).toEqual([{ kind: "line", from: [50, 0], to: [100, 0] }, segs[1]]);
    expect(splitAtPlace(segs, { index: 1, t: 0 })).toEqual([[segs[0]], [segs[1]]]);
    const share = shareHalves(50, 70, 240, 0.5);
    expect(share.before.twist).toBeCloseTo(100, 9);
    expect(share.after.twist).toBeCloseTo(140, 9);
    expect(share.after.scale).toBe(0.5);
    expect(share.before.scale).toBeCloseTo(1 + 0.5 * (50 / 70), 9);
    expect(scaleAlong(1, 0.5, 100, 25, 50)).toEqual([0.875, 0.625]);
    expect(scaleAlong(1, 0.5, 0, 0, 0)).toEqual([1, 1]);
  });
});
