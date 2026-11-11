/**
 * delete_feature with `with_dependents` (Onshape's Delete with the features
 * that use it), run with the real OpenCascade engine.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";

beforeAll(async () => {
  setOC(await opencascade());
});

const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function newSession() {
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return s;
}

const volume = (s: Session) => s.withEngine((e) => e.check("normal").parts.reduce((t, p) => t + p.exactVolume!, 0));

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");

async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

describe("delete_feature with dependents", () => {
  it("deletes a sketch with everything built on it, in one undo step", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Bracket" });
    await ok(s, "add_sketch", { name: "Plate outline", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
    await ok(s, "add_feature", { type: "extrude", sketch: "Plate outline", depth: 3 });
    await ok(s, "add_feature", { type: "fillet", edges: ["along z"], radius: 4, name: "Round corners" });
    await ok(s, "add_sketch", { name: "Elsewhere", plane: "Front", shapes: [{ type: "circle", center: [100, 10], diameter: 10 }] });
    const names = () => s.doc.features.map((f) => f.name);
    const all = names();

    const refused = await callTool(s, "delete_feature", { feature: "Extrude 1" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/used by Round corners\. [\s\S]*"with_dependents": true/);
    expect(names()).toEqual(all);

    const said = await ok(s, "delete_feature", { feature: "Plate outline", with_dependents: true });
    expect(said).toMatch(/Deleted Plate outline and the 2 features that used it: Extrude 1 and Round corners\./);
    expect(names()).toEqual(["Elsewhere"]);
    await ok(s, "undo");
    expect(names()).toEqual(all);

    // Nothing uses the last sketch: with_dependents just deletes it.
    expect(await ok(s, "delete_feature", { feature: "Elsewhere", with_dependents: true })).toMatch(/^Deleted Elsewhere\./);
  });

  it("keeps a pattern of two cuts building when one of them goes", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Pattern" });
    await ok(s, "add_feature", { type: "box", width: 100, depth: 20, height: 5 });
    await ok(s, "add_sketch", { name: "Sketch A", on_face: "top", shapes: [{ type: "circle", center: [10, 6], diameter: 4 }] });
    await ok(s, "add_feature", { type: "extrude", sketch: "Sketch A", end: "through_all", operation: "remove", name: "Cut A" });
    await ok(s, "add_sketch", { name: "Sketch B", on_face: "top", shapes: [{ type: "circle", center: [10, 14], diameter: 4 }] });
    await ok(s, "add_feature", { type: "extrude", sketch: "Sketch B", end: "through_all", operation: "remove", name: "Cut B" });
    await ok(s, "add_feature", { type: "linear_pattern", features: ["Cut A", "Cut B"], direction: "x", count: 3, spacing: 20, name: "Row" });
    const hole = Math.PI * 4 * 5;
    expect(volume(s)).toBeCloseTo(100 * 20 * 5 - 6 * hole, 2);
    const said = await ok(s, "delete_feature", { feature: "Sketch B", with_dependents: true });
    expect(said).toMatch(/Deleted Sketch B and the feature that used it: Cut B\./);
    expect(said).toMatch(/Row \(lost 1 of its 2 features it repeats\)/);
    expect(s.doc.features.find((f) => f.name === "Row")!.pattern!.sources).toHaveLength(1);
    expect(Object.keys(s.build().errors)).toEqual([]);
    expect(volume(s)).toBeCloseTo(100 * 20 * 5 - 3 * hole, 2);
  });

  it("keeps a fillet over two parts rounding the one that's left", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Two blocks" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10, x: 40, operation: "new" });
    await ok(s, "add_feature", { type: "fillet", part: "Part 1", edges: ["along z"], radius: 2, name: "Round" });
    await ok(s, "add_feature", { type: "fillet", part: "Part 2", edges: ["along z"], radius: 2, name: "Round 2" });
    // One fillet over both parts' edges (as clicking them in the app makes).
    const round = s.doc.features.find((f) => f.name === "Round")!;
    const round2 = s.doc.features.find((f) => f.name === "Round 2")!;
    s.doc = { ...s.doc, features: s.doc.features.filter((f) => f !== round2).map((f) => (f === round ? { ...f, picks: [...f.picks!, ...round2.picks!] } : f)) };
    expect(Object.keys(s.build().errors)).toEqual([]);
    const rounded = 20 * 20 * 10 - 4 * 10 * (4 - Math.PI);
    expect(volume(s)).toBeCloseTo(2 * rounded, 2);
    const box2 = s.doc.features.filter((f) => f.type === "box")[1].name;
    const said = await ok(s, "delete_feature", { feature: box2, with_dependents: true });
    expect(said).toMatch(/Round \(lost 4 of its 8 picked edges and faces\)/);
    expect(Object.keys(s.build().errors)).toEqual([]);
    expect(volume(s)).toBeCloseTo(rounded, 2);
  });

  it("never lets a design's cuts carve the user's own part when the design's part goes", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Block and stencil" });
    await ok(s, "add_feature", { type: "box", width: 200, depth: 200, height: 10, name: "My block" });
    await ok(s, "insert_library_design", { design: "stencil", sizes: { words: "HI" } });
    const said = await ok(s, "delete_feature", { feature: "Sheet sketch", with_dependents: true });
    expect(said).toMatch(/^Deleted Sheet sketch and the \d+ features that used it: .*Letters/);
    expect(Object.keys(s.build().errors)).toEqual([]);
    expect(volume(s)).toBeCloseTo(200 * 200 * 10, 1);
  });
});
