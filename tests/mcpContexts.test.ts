/**
 * Claude's Edit in context (src/mcp/contextTools.ts) with the real engine: a context made for a copy shows the
 * assembly's other parts in its Part Studio where they sit next to it, is updated after a part moves, can be hidden,
 * and is removed.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { contextInputs } from "../src/assembly/inContext";
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-ctx-"));
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

/** A plate in the first Part Studio, a bracket in a second, both in an assembly. */
async function twoStudios(s: Session) {
  await ok(s, "new_design", { name: "Context" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
  await ok(s, "rename_part", { part: s.build().parts[0].name, name: "Plate" });
  const main = s.doc;
  // A second Part Studio with the bracket (made as the app makes one).
  const { addStudio } = await import("../src/model/studios");
  s.commit(addStudio(main, "ps2"));
  return "ps2";
}

describe("Edit in context for Claude", () => {
  it("makes, updates, hides and removes a context for a copy", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Context" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10, x: 100, operation: "new" });
    const parts = s.build().parts;
    await ok(s, "rename_part", { part: parts[0].name, name: "Plate" });
    await ok(s, "rename_part", { part: parts[1].name, name: "Block" });
    await ok(s, "create_assembly", { name: "Stack" });
    await ok(s, "insert_into_assembly", { part: "Plate", at: [0, 0, 0] });
    await ok(s, "insert_into_assembly", { part: "Block", at: [-100, 0, 5], fixed: false });
    // Both parts are in the same Part Studio: nothing more to show, said plainly.
    const same = await ok(s, "edit_in_context", { instance: "Block <1>" });
    expect(same).toMatch(/Made the context "Stack \(Block <1>\)"/);
    expect(same).toMatch(/shows nothing more/);
    expect(await ok(s, "remove_context", { context: "Block <1>" })).toMatch(/Removed the context "Stack \(Block <1>\)"/);
    expect(s.doc.contexts).toBeUndefined();
    expect(await fails(s, "remove_context", {})).toMatch(/no contexts/);
    expect(await fails(s, "edit_in_context", { instance: "Lid <1>" })).toMatch(/no copy called "Lid <1>"/);
  });

  it("shows a part from another Part Studio where it sits next to the copy, and follows it when updated", async () => {
    const s = newSession();
    const studio = await twoStudios(s);
    // Build the bracket in the second Part Studio through the document (Claude works on the first one here).
    const { inStudio } = await import("../src/model/studios");
    const { feature } = await import("./support/engineHelpers");
    const box = feature("box", { width: 10, depth: 20, height: 30 });
    s.commit(inStudio(s.doc, studio, (d) => ({ ...d, features: [box] })));
    await ok(s, "create_assembly", { name: "Mount" });
    await ok(s, "insert_into_assembly", { part: "Plate", at: [0, 0, 0] });
    const asm = s.doc.assemblies![0];
    const built = s.buildAll().parts.find((p) => p.studioId === studio)!;
    await ok(s, "insert_into_assembly", { part: built.name, at: [15, 10, 5], fixed: false });
    const bracket = s.doc.assemblies![0].instances[1].name;
    const made = await ok(s, "edit_in_context", { assembly: asm.name, instance: bracket });
    expect(made).toMatch(new RegExp(`Made the context "Mount \\(${bracket.replace(/[<>]/g, ".")}\\)".*shows the assembly's other part round it`));
    // The plate sits 15, 10, 5 back from the bracket's own origin.
    expect(made).toMatch(/- Plate <1>: at \(-15, -10, -5\) from its origin/);
    const inputs = contextInputs(s.doc, studio)!;
    expect(inputs).toHaveLength(1);
    expect(inputs[0].parts[0].placement.position).toEqual([-15, -10, -5]);
    // Asked again with nothing moved: kept as it was.
    expect(await ok(s, "edit_in_context", { instance: bracket })).toMatch(/Nothing had moved since, so kept/);
    // The bracket moved in the assembly: updated, and hidden.
    await ok(s, "place_instance", { instance: bracket, at: [20, 10, 5] });
    const again = await ok(s, "edit_in_context", { instance: bracket, hidden: true });
    expect(again).toMatch(/Updated the context.*hidden for now/);
    expect(again).toMatch(/- Plate <1>: at \(-20, -10, -5\)/);
    expect(s.doc.contexts!).toHaveLength(1);
    expect(s.doc.contexts![0].hidden).toBe(true);
    expect(await ok(s, "remove_context", {})).toMatch(/Removed/);
    expect(contextInputs(s.doc, studio)).toBeUndefined();
  });
});
