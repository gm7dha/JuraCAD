import { describe, expect, it } from "vitest";

import { FEATURE_DEFS, resolveParams, visibleParamKeys } from "../src/model/features";
import type { FeatureType } from "../src/model/types";

/**
 * The boxes a feature hides when it's first set up, on purpose (each depends on an option that is off at first).
 * Anything else must be shown: a box missing from a dialog can't be changed at all (Shell's "Wall thickness"
 * went missing from v0.60 to v0.104, hidden by the Thin walls rule meant only for Extrude/Revolve/Sweep/Loft).
 */
const HIDDEN_AT_FIRST: Partial<Record<FeatureType, string[]>> = {
  extrude: ["depth2", "offset", "thickness", "thickness2"],
  revolve: ["angle2", "thickness", "thickness2"],
  transform: ["turn", "distance", "factor"],
  circularPattern: ["cz"],
  sweep: ["turns", "pitch", "scale", "thickness", "thickness2"],
  loft: ["thickness", "thickness2"],
  chamfer: ["distance2", "angle"],
  moveFace: ["angle"],
  sheetMetal: ["ripGap"],
  flange: ["cornerGap"],
  hem: ["cornerGap"],
  frame: ["width", "height", "wall"],
  gusset: ["chamfer"],
  plane: ["angle"],
};

describe("which size boxes a dialog shows", () => {
  it("shows every box of every feature but the ones hidden on purpose", () => {
    for (const [type, def] of Object.entries(FEATURE_DEFS) as [FeatureType, (typeof FEATURE_DEFS)[FeatureType]][]) {
      if (type === "curve") continue; // Its kind chooses its boxes (tests/curves).
      const shown = visibleParamKeys({ type } as never);
      const hidden = def.params.filter((p) => !shown.has(p.key)).map((p) => p.key);
      expect({ type, hidden }).toEqual({ type, hidden: HIDDEN_AT_FIRST[type] ?? [] });
    }
  });

  it("keeps the thickness of Shell, Thicken, Rib, Sheet metal and Gusset, which have no Thin option", () => {
    for (const type of ["shell", "thicken", "rib", "sheetMetal", "gusset"] as FeatureType[]) {
      expect(visibleParamKeys({ type } as never).has("thickness")).toBe(true);
    }
  });

  it("still hides Thin's boxes until Thin is on", () => {
    expect(visibleParamKeys({ type: "extrude" } as never).has("thickness")).toBe(false);
    expect(visibleParamKeys({ type: "extrude", thin: {} } as never).has("thickness")).toBe(true);
    expect(visibleParamKeys({ type: "extrude", thin: { midPlane: true } } as never).has("thickness2")).toBe(false);
  });

  it("says what's wrong with a shell's thickness instead of quietly using 2 mm", () => {
    const bad = resolveParams({ type: "shell", params: { thickness: "0" } });
    expect(bad.errors.thickness).toMatch(/more than 0/);
    expect(resolveParams({ type: "shell", params: { thickness: "3.5" } }).values.thickness).toBe(3.5);
  });
});
