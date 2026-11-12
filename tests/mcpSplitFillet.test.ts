/**
 * The Claude extension and Split face, Modify fillet and Fillet's all_edges, with the real OpenCascade engine.
 */
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-sfmf-"));
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
const volume = (s: Session) => s.withEngine((e) => e.check("normal").parts[0].exactVolume!);
const faceCount = (s: Session) => s.build().parts[0].faceRefs.filter((f) => f.kind === "face").length;

describe("split face, modify fillet and all edges, from Claude", () => {
  it("tells Claude about them", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/modify_fillet/);
    expect(add.description).toMatch(/split_face/);
    expect(add.description).toMatch(/all_edges/);
  });

  it("splits a face along an offset plane", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Split" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    await ok(s, "add_feature", { type: "split_face", faces: ["front"], plane: "Top", offset: 5 });
    expect(faceCount(s)).toBe(7);
    expect(Math.abs(volume(s) - 4000)).toBeLessThan(1e-6);
    expect(await ok(s, "describe_design")).toMatch(/split 1 face\(s\) along Top plane \+ 5 mm/);
    expect(await fails(s, "add_feature", { type: "split_face", faces: ["front"], plane: "Top", offset: 50 })).toMatch(/doesn't cross/);
  });

  it("re-sizes and then takes off a fillet", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Round" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    await ok(s, "add_feature", { type: "fillet", edges: [{ near: [20, 20, 5] }], radius: 2 });
    const round = { near: [20 - 2 + 2 * Math.SQRT1_2, 20 - 2 + 2 * Math.SQRT1_2, 5] };
    await ok(s, "add_feature", { type: "modify_fillet", faces: [round], radius: 4 });
    expect(Math.abs(volume(s) - (4000 - 10 * (16 - 4 * Math.PI)))).toBeLessThan(1e-3);
    await ok(s, "edit_feature", { feature: "Modify fillet 1", remove: true });
    expect(Math.abs(volume(s) - 4000)).toBeLessThan(1e-6);
    expect(await fails(s, "add_feature", { type: "modify_fillet", faces: ["top"], radius: 3 })).toMatch(/rounded faces/);
  });

  it("rounds every edge of a part", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Soft" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    await ok(s, "add_feature", { type: "fillet", all_edges: true, radius: 1 });
    expect(faceCount(s)).toBe(26);
  });
});
