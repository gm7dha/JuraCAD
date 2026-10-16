import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { boldPieces, changesFor, parseChangelog } from "../src/model/changelog";

describe("what's new", () => {
  it("reads every version from CHANGELOG.md, with its title and changes", () => {
    const versions = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
    expect(versions.length).toBeGreaterThan(10);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    // The version being built has an entry.
    const now = changesFor(versions, pkg.version);
    expect(!!now).toBe(true);
    expect(now!.changes.length).toBeGreaterThan(0);
    expect(now!.title.includes("commit")).toBe(false);
    expect(changesFor(versions, "0.1.0")!.version).toBe("0.1");
  });

  it("joins changes that run over two lines, and finds the bold bits", () => {
    const v = parseChangelog("# Title\n\nintro\n\n## v1.2 — Big one · commit `abc`\n\n- **Fast** thing that\n  goes on\n- Second\n")[0];
    expect(v).toEqual({ version: "1.2", title: "Big one", changes: ["**Fast** thing that goes on", "Second"] });
    expect(boldPieces(v.changes[0])).toEqual([
      { text: "Fast", bold: true },
      { text: " thing that goes on", bold: false },
    ]);
  });
});
