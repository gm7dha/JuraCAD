import { describe, expect, it } from "vitest";

import { nextRevision, parseDrawings } from "../src/drawing/drawing";
import { bottomReserve, layoutSheet } from "../src/drawing/sheet";

describe("drawing revisions", () => {
  const rev = (r: string) => ({ id: r, rev: r, description: "", date: "" });

  it("letters carry on A, B … Z, AA", () => {
    expect(nextRevision({})).toBe("A");
    expect(nextRevision({ revisions: [rev("A")] })).toBe("B");
    expect(nextRevision({ revisions: [rev("Z")] })).toBe("AA");
    expect(nextRevision({ revisions: [rev("AZ")] })).toBe("BA");
    expect(nextRevision({ revisions: [rev("3")] })).toBe("A");
  });

  it("are saved, read back, and drawn above the title block", () => {
    const drawing = {
      id: "d",
      name: "Drawing 1",
      source: null,
      sheet: "A4",
      views: [],
      hiddenLines: false,
      title: {},
      revisions: [
        { id: "a", rev: "A", description: "First issue", date: "15/10/2026" },
        { id: "b", rev: "B", description: "Holes moved", date: "16/10/2026" },
      ],
    };
    const [back] = parseDrawings(JSON.parse(JSON.stringify([drawing])));
    expect(back.revisions).toEqual(drawing.revisions);
    expect(bottomReserve(back, undefined)).toBeGreaterThan(bottomReserve({ title: {} }, undefined));
    const layout = layoutSheet(back, {}, { designName: "x", subject: "y", date: "1/1/2026" });
    const texts = layout.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    for (const t of ["REV", "DESCRIPTION", "First issue", "Holes moved", "16/10/2026"]) expect(texts).toContain(t);
  });
});
