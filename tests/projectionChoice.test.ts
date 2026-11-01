import { describe, expect, it } from "vitest";

import { chooseProjections } from "../src/app/projectionChoice";

const sheet1 = { front: "Bracket front" };
const sheet3 = { front: "Assembly front" };

describe("which views a drawing sheet shows", () => {
  it("never shows another sheet's views after switching sheets", () => {
    // The sheet was showing sheet 3; sheet 1's views are in the cache.
    expect(chooseProjections({ cacheId: "d1#p3", result: sheet3 }, "d1", sheet1)).toEqual({ base: sheet1, upToDate: true });
    // …or are still being worked out: nothing yet, rather than sheet 3's.
    expect(chooseProjections({ cacheId: "d1#p3", result: sheet3 }, "d1", null)).toEqual({ base: null, upToDate: false });
    // Another drawing likewise.
    expect(chooseProjections({ cacheId: "d2", result: sheet3 }, "d1", null).base).toBe(null);
  });

  it("keeps showing its own last views while new ones are worked out", () => {
    const old = { front: "before the change" };
    expect(chooseProjections({ cacheId: "d1", result: old }, "d1", null)).toEqual({ base: old, upToDate: false });
    expect(chooseProjections({ cacheId: "d1", result: sheet1 }, "d1", sheet1)).toEqual({ base: sheet1, upToDate: true });
    expect(chooseProjections({ cacheId: "d1", result: null }, "d1", sheet1)).toEqual({ base: sheet1, upToDate: true });
  });
});
