/** Tools in the Design library (pure): the Mountain puzzle's card sits on the 3D printing tab and the search finds it. */
import { describe, expect, it } from "vitest";
import { searchDesigns } from "../src/library/browse";
import { LIBRARY_TOOLS, searchTools, toolsIn } from "../src/library/tools";

describe("Library tools", () => {
  it("puts the Mountain puzzle on the 3D printing tab, under Puzzles", () => {
    expect(toolsIn("print").map((t) => t.id)).toEqual(["mountain"]);
    expect(toolsIn("laser")).toEqual([]);
    expect(LIBRARY_TOOLS[0].group).toBe("Puzzles");
  });

  it("is found by searching, like a design", () => {
    for (const q of ["mountain", "munro", "Ben Nevis", "puz", "snow caps"]) expect(searchTools(q).map((t) => t.id), q).toEqual(["mountain"]);
    expect(searchTools("bolt")).toEqual([]);
    expect(searchTools("")).toEqual([]);
    // The ordinary design search still works as before.
    expect(searchDesigns("bolt").length).toBeGreaterThan(0);
  });
});
