import { describe, expect, it } from "vitest";

import { describeHole, holeProfile, holeVolume, standardParams, type HoleSize } from "../src/model/holes";

const base: HoleSize = { kind: "simple", diameter: 6, depth: 10, throughAll: false, throughLength: 50, cboreDiameter: 11, cboreDepth: 6, cskDiameter: 12, cskAngle: 90 };

describe("hole sizes", () => {
  it("looks up standard screw sizes", () => {
    expect(standardParams("M4", "clearance")?.diameter).toBe("4.5");
    expect(standardParams("M4", "tapped")?.diameter).toBe("3.3");
    const m6 = standardParams("M6", "clearance")!;
    expect([m6.cboreDiameter, m6.cboreDepth, m6.cskDiameter]).toEqual(["11", "6.4", "12.6"]);
    expect(standardParams("Custom", "clearance")).toBeNull();
    expect(describeHole({ kind: "simple", standard: "M4", fit: "tapped" })).toBe("M4 tapped hole (thread M4 × 0.7)");
    expect(describeHole({ kind: "counterbore", standard: "M3", fit: "clearance" })).toBe("M3 clearance, counterbored hole");
  });

  it("works out volumes: straight, with drill point, counterbored, countersunk", () => {
    const through = holeVolume({ ...base, throughAll: true, throughLength: 20 });
    expect(through).toBeCloseTo(Math.PI * 9 * 20, 6);
    const tip = 3 / Math.tan((59 * Math.PI) / 180);
    expect(holeVolume(base)).toBeCloseTo(Math.PI * 9 * 10 + (Math.PI * 9 * tip) / 3, 6);
    const cb = holeVolume({ ...base, kind: "counterbore", throughAll: true, throughLength: 20 });
    expect(cb).toBeCloseTo(Math.PI * 5.5 * 5.5 * 6 + Math.PI * 9 * 14, 6);
    const cs = holeVolume({ ...base, kind: "countersink", throughAll: true, throughLength: 20 });
    // 90° countersink from r=6 to r=3 is 3 mm deep: a frustum, then the plain hole.
    expect(cs).toBeCloseTo((Math.PI * 3 * (36 + 18 + 9)) / 3 + Math.PI * 9 * 17, 6);
  });

  it("explains sizes that don't fit together", () => {
    expect(() => holeProfile({ ...base, kind: "counterbore", cboreDiameter: 5 })).toThrow(/wider than the hole/);
    expect(() => holeProfile({ ...base, kind: "counterbore", cboreDepth: 12 })).toThrow(/shallower/);
    expect(() => holeProfile({ ...base, kind: "countersink", cskDiameter: 40 })).toThrow(/deeper than the hole/);
  });
});
