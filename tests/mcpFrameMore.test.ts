/**
 * The Claude extension and Frames along part edges and curves, a mitred cube corner, and a cut list table on a
 * drawing sheet, with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-frame-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return s;
}
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");
async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}
async function fails(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  expect(r.isError).toBe(true);
  return textOf(r);
}

describe("frames from Claude, more", () => {
  it("follows a box's top edges and a helix, mitres a cube corner, and puts a cut list on a drawing", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 200, depth: 100, height: 50 });
    await ok(s, "add_feature", { type: "frame", edges: [{ near: [100, 0, 50] }, { near: [200, 50, 50] }, { near: [100, 100, 50] }, { near: [0, 50, 50] }], edge_part: "Part 1", profile: "timber", size: "44x44", corners: [{ at: [0, 0, 50], type: "butt" }] });
    const fr = s.doc.features.find((f) => f.type === "frame")!;
    expect(fr.frame!.edges).toHaveLength(4);
    // Its corners could be set in the same call (the edges were found first), and every edge has its lasting name.
    expect(fr.frame!.corners).toHaveLength(1);
    expect(new Set(fr.frame!.edges!.map((e) => e.key)).size).toBe(4);
    expect(s.build().parts.filter((p) => p.frame)).toHaveLength(4);
    expect(await fails(s, "add_feature", { type: "frame", edges: [{ near: [100, 0, 50] }] })).toContain("edge_part");
    expect(await fails(s, "add_feature", { type: "frame", profile: "timber", size: "44x44" })).toContain("needs a path");

    await ok(s, "add_feature", { type: "curve", curve_type: "helix", axis: "z", diameter: 300, height: 200, turns: 1 });
    await ok(s, "add_feature", { type: "frame", curves: ["Helix 1"], profile: "flat", size: "20x3" });
    const rail = s.build().parts.filter((p) => p.frame?.curved);
    expect(rail).toHaveLength(1);

    // A cube corner, mitred.
    await ok(s, "add_sketch", { name: "XY", plane: "Top", shapes: [{ type: "line", from: [0, 0], to: [300, 0] }, { type: "line", from: [0, 0], to: [0, 300] }] });
    await ok(s, "add_sketch", { name: "Z", plane: "Front", shapes: [{ type: "line", from: [0, 0], to: [0, 300] }] });
    await ok(s, "add_feature", { type: "frame", sketches: ["XY", "Z"], profile: "timber", size: "44x44", corners: [{ at: [0, 0, 0], type: "mitre" }] });
    const corner = s.doc.features.filter((f) => f.type === "frame").pop()!;
    expect(corner.frame!.corners?.[0].type).toBe("mitre");
    const cube = s.build().parts.filter((p) => p.frame?.frame === corner.id);
    expect(cube.map((p) => p.frame!.length)).toEqual([322, 322, 322]);
    expect(await ok(s, "describe_cut_list")).toContain("compound mitre 45°");

    // The cut list on a drawing of one of the members (its Part Studio's members).
    await ok(s, "create_drawing", { part: cube[0].name, views: ["front"] });
    const added = await ok(s, "add_drawing_note", { cut_list: true });
    expect(added).toContain("Added a cut list");
    expect(added).toContain("44 × 44");
    expect(await fails(s, "add_drawing_note", { cut_list: true })).toContain("already has a cut list");
    expect(await ok(s, "describe_drawing", {})).toContain("cut list");
  });
});
