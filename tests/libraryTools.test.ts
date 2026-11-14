/** Tools in the Design library (pure): the puzzle cards sit in the locked Map puzzles tab and the search finds them once it's open. */
import { describe, expect, it } from "vitest";
import { searchDesigns } from "../src/library/browse";
import { LIBRARY_TOOLS, searchTools, shownTools, toolsIn } from "../src/library/tools";

describe("Library tools", () => {
  it("puts the puzzles in the Map puzzles tab, not 3D printing", () => {
    expect(toolsIn("maps").map((t) => t.id)).toEqual(["mountain", "photo", "island"]);
    expect(toolsIn("print")).toEqual([]);
    expect(toolsIn("laser")).toEqual([]);
    expect(LIBRARY_TOOLS.map((t) => t.group)).toEqual(["From maps", "From a picture", "From maps"]);
  });

  it("hides them from the search while the tab is locked", () => {
    expect(shownTools(false)).toEqual([]);
    expect(shownTools(true).map((t) => t.id)).toEqual(["mountain", "photo", "island"]);
    for (const q of ["mountain", "island", "puzzle", "photo relief"]) expect(searchTools(q, shownTools(false)), q).toEqual([]);
    expect(searchTools("mountain", shownTools(true)).map((t) => t.id)).toEqual(["mountain"]);
    // The maze box and burr stay under 3D printing › Puzzles, found whether locked or not.
    expect(searchDesigns("maze").map((d) => d.id)).toContain("maze-box");
  });

  it("is found by searching, like a design", () => {
    for (const q of ["mountain", "munro", "Ben Nevis", "snow caps"]) expect(searchTools(q).map((t) => t.id), q).toEqual(["mountain"]);
    for (const q of ["island", "county", "Great Britain", "Skye"]) expect(searchTools(q).map((t) => t.id), q).toEqual(["island"]);
    expect(searchTools("bolt")).toEqual([]);
    expect(searchTools("")).toEqual([]);
    // The ordinary design search still works as before.
    expect(searchDesigns("bolt").length).toBeGreaterThan(0);
  });
});
