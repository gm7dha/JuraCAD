import { describe, expect, it } from "vitest";
import { GROUND_BROWN, LOWLAND_GREEN, PATH_RED, ROAD_BLACK, SEA_BLUE, SNOW_IVORY, UPLAND_GREY, WATER_BLUE } from "../src/terrain/colour";
import { inMaterial, matchNotes, sameHue, USUAL_MATERIAL } from "../src/terrain/puzzleMaterial";

const USUAL: [string, string][] = [
  ["roads", ROAD_BLACK],
  ["snow", SNOW_IVORY],
  ["paths", PATH_RED],
  ["water", WATER_BLUE],
  ["Lowland", LOWLAND_GREEN],
  ["Upland", UPLAND_GREY],
  ["the base", GROUND_BROWN],
  ["sea", SEA_BLUE],
];
const picks = (line: string) => Object.fromEntries(USUAL.map(([n, h]) => [n, inMaterial(h, line).spool?.name]));

describe("the usual colours in a line, hue first", () => {
  it("leaves the usual PLA exactly as it was", () => {
    for (const [, h] of USUAL) expect(inMaterial(h, USUAL_MATERIAL)).toEqual({ hex: h, close: true });
  });

  it("keeps PLA Basic, PLA Matte, PETG HF, PETG Basic and ASA as they were", () => {
    expect(picks("PLA Basic")).toEqual({ roads: "Black", snow: "Jade White", paths: "Red", water: "Cyan", Lowland: "Bronze", Upland: "Gray", "the base": "Cocoa Brown", sea: "Cyan" });
    expect(picks("PLA Matte")).toEqual({ roads: "Charcoal", snow: "Ivory White", paths: "Scarlet Red", water: "Marine Blue", Lowland: "Dark Green", Upland: "Nardo Gray", "the base": "Dark Brown", sea: "Marine Blue" });
    expect(picks("PETG HF")).toEqual({ roads: "Black", snow: "White", paths: "Red", water: "Lake Blue", Lowland: "Forest Green", Upland: "Dark Gray", "the base": "Peanut Brown", sea: "Lake Blue" });
    expect(picks("PETG Basic")).toEqual({ roads: "Black", snow: "White", paths: "Red", water: "Navy Blue", Lowland: "Pine Green", Upland: "Gray", "the base": "Dark Brown", sea: "Navy Blue" });
    expect(picks("ASA")).toEqual({ roads: "Black", snow: "White", paths: "Red", water: "Blue", Lowland: "Gray", Upland: "Gray", "the base": "Gray", sea: "Blue" });
  });

  it("gives Lowland a green in PETG Matte and ABS, and the base a brown or beige", () => {
    expect(picks("PETG Matte")).toEqual({ roads: "Black", snow: "White", paths: "Red", water: "Cyan", Lowland: "Avocado Green", Upland: "Gray", "the base": "Caramel", sea: "Cyan" });
    expect(picks("ABS")).toEqual({ roads: "Black", snow: "White", paths: "Red", water: "Azure", Lowland: "Olive", Upland: "Silver", "the base": "Beige", sea: "Azure" });
  });

  it("knows a green from a tan", () => {
    expect(sameHue(LOWLAND_GREEN, "#bce194")).toBe(true); // Avocado Green
    expect(sameHue(LOWLAND_GREEN, "#bf9474")).toBe(false); // Caramel
    expect(sameHue(LOWLAND_GREEN, "#7f7e83")).toBe(false); // a grey
  });

  it("says plainly when the line's colour of the same name is another shade", () => {
    const notes = matchNotes([{ name: "water", hex: WATER_BLUE }], "PETG Matte");
    expect(notes).toEqual(["PETG Matte's Cyan is used for water, a different shade from the usual Cyan (PLA Basic) — pick another if you like."]);
    expect(matchNotes([{ name: "Lowland", hex: LOWLAND_GREEN }], "PETG Matte")[0]).toMatch(/no colour close to the usual Dark Green for Lowland: Avocado Green/);
  });
});
