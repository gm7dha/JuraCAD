import { describe, expect, it } from "vitest";

import { completeWith, suggestionsAt, variableMatches, wordAt } from "../src/model/varComplete";

const names = ["wall", "width", "box_wall", "height", "w2"];

describe("variable names offered while typing a size", () => {
  it("finds the word at the cursor", () => {
    expect(wordAt("wa", 2)).toEqual({ start: 0, end: 2, word: "wa" });
    expect(wordAt("10 + wi", 7)).toEqual({ start: 5, end: 7, word: "wi" });
    expect(wordAt("wall * 2", 2)).toEqual({ start: 0, end: 4, word: "wall" });
    expect(wordAt("10 + ", 5)).toBe(null);
    expect(wordAt("12", 2)).toBe(null);
  });

  it("offers names starting with it first, then ones containing it", () => {
    expect(variableMatches("w", names)).toEqual(["wall", "width", "w2", "box_wall"]);
    expect(variableMatches("WAL", names)).toEqual(["wall", "box_wall"]);
    expect(variableMatches("wall", ["wall"])).toEqual([]);
    expect(variableMatches("zz", names)).toEqual([]);
    expect(variableMatches("w", names, 2)).toHaveLength(2);
  });

  it("puts the chosen name in place of the word", () => {
    const s = suggestionsAt("10 + wi * 2", 7, names);
    expect(s.names).toEqual(["width"]);
    expect(completeWith("10 + wi * 2", s.word!, "width")).toEqual({ text: "10 + width * 2", caret: 10 });
  });
});
