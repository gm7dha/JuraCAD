import { describe, expect, it } from "vitest";

import { bedFit, bedSize, CUSTOM_PRINTER, PRINTERS } from "../src/model/printBed";

describe("print bed", () => {
  it("knows the printers' sizes, and custom ones", () => {
    expect(bedSize("prusa-mk4")).toEqual([250, 210, 220]);
    expect(bedSize(CUSTOM_PRINTER, [100, 120, 90])).toEqual([100, 120, 90]);
    expect(bedSize("nonsense")).toEqual(PRINTERS[0].size);
    expect(new Set(PRINTERS.map((p) => p.id)).size).toBe(PRINTERS.length);
  });

  it("says whether a part fits, by how much it's too big, and if turning helps", () => {
    expect(bedFit([200, 200, 200], [256, 256, 256])).toEqual({ fits: true, over: [0, 0, 0], fitsTurned: false });
    const tall = bedFit([100, 100, 300], [256, 256, 256]);
    expect(tall.fits).toBe(false);
    expect(tall.over).toEqual([0, 0, 44]);
    expect(tall.fitsTurned).toBe(false);
    // 240 long in Y on a bed 210 deep: turned, it lies along the 250 X.
    const long = bedFit([150, 240, 50], [250, 210, 220]);
    expect(long.fits).toBe(false);
    expect(long.over).toEqual([0, 30, 0]);
    expect(long.fitsTurned).toBe(true);
  });
});
