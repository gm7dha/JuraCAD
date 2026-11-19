/** The Claude extension and Onshape's Merge scope (`merge_with`), with the real OpenCascade engine. */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, TOOLS, type ToolResult } from "../src/mcp/tools";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-scope-"));
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
const volumes = (s: Session) => s.withEngine((e) => e.check("normal").parts.map((p) => p.exactVolume!));
const exactly = (actual: number, exact: number) => expect(Math.abs(actual / exact - 1)).toBeLessThan(1e-6);

describe("merge_with, from Claude", () => {
  it("tells Claude about it", () => {
    expect(TOOLS.find((t) => t.name === "add_feature")!.description).toMatch(/merge_with/);
  });

  it("cuts only the parts named, and can be changed back to every part", async () => {
    const s = newSession();
    for (const x of [0, 20, 40]) await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10, x, y: 0, z: 0, operation: "new" });
    await ok(s, "add_sketch", { name: "Slot", plane: "Top", shapes: [{ type: "rectangle", corner: [-5, 4], width: 60, height: 2 }] });
    await ok(s, "add_feature", { type: "extrude", name: "Cut", sketch: "Slot", operation: "remove", end: "symmetric", depth: 40, merge_with: ["Part 2"] });
    let v = volumes(s);
    exactly(v[0], 1000);
    exactly(v[1], 800);
    exactly(v[2], 1000);
    await ok(s, "edit_feature", { feature: "Cut", merge_with: "all" });
    v = volumes(s);
    for (const x of v) exactly(x, 800);
    expect(await fails(s, "edit_feature", { feature: "Cut", merge_with: ["Part 9"] })).toMatch(/no part "Part 9"/);
  });
});
