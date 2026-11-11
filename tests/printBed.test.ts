import { describe, expect, it } from "vitest";

import { bedFit, bedSize, bothNozzlesNote, CUSTOM_PRINTER, printerOf, PRINTERS } from "../src/model/printBed";

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

  it("has the Bambu Lab X2D, with its main-nozzle bed and the room both nozzles reach", () => {
    const x2d = printerOf("bambu-x2d")!;
    expect(x2d.name).toBe("Bambu Lab X2D");
    expect(PRINTERS.map((p) => p.id)).toContain("bambu-x2d");
    // Next to the other Bambu printers.
    expect(PRINTERS.findIndex((p) => p.id === "bambu-x2d")).toBe(PRINTERS.findIndex((p) => p.id === "bambu-h2d") + 1);
    expect(bedSize("bambu-x2d")).toEqual([256, 256, 260]);
    expect(x2d.bothNozzles).toEqual([235.5, 256, 256]);
    expect(x2d.note).toMatch(/235.5 × 256 × 256 mm with the second nozzle or both/);
    // The bed checks use its size: 258 tall fits the X2D but not an X1.
    expect(bedFit([100, 100, 258], bedSize("bambu-x2d")).fits).toBe(true);
    expect(bedFit([100, 100, 258], bedSize("bambu-x1")).fits).toBe(false);
    // 250 × 250 fits the main nozzle only; 200 wide fits both; 250 × 100 fits both turned a quarter turn.
    expect(bothNozzlesNote("bambu-x2d", [250, 250, 100])).toMatch(/main nozzle only/);
    expect(bothNozzlesNote("bambu-x2d", [250, 100, 100])).toMatch(/turn it a quarter turn/);
    expect(bothNozzlesNote("bambu-x2d", [200, 250, 100])).toBeNull();
    expect(bothNozzlesNote("bambu-x2d", [100, 100, 258])).toMatch(/main nozzle only/);
    expect(bothNozzlesNote("bambu-x2d", [300, 100, 100])).toBeNull();
    expect(bothNozzlesNote("bambu-x1", [250, 100, 100])).toBeNull();
  });
});
