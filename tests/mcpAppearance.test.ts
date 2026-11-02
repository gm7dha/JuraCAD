/**
 * Claude's set_appearance tool (src/mcp/tools.ts), with the real OpenCascade
 * engine: a part's colour and finish, saved in the design and carried into a
 * 3MF export (see-through for "clear").
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-look-"));
  dirs.push(dir);
  const folder = join(dir, "JuraCAD");
  const s = new Session(new DesignFolder(folder));
  sessions.push(s);
  return { s, folder };
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");
async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

describe("set_appearance", () => {
  it("sets a part's colour and finish, undoably, and exports a clear part see-through", async () => {
    const { s, folder } = newSession();
    await ok(s, "new_design", { name: "Look" });
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    const part = s.build().parts[0];
    expect(await ok(s, "set_appearance", { part: part.name, colour: "red", finish: "glossy" })).toMatch(/glossy plastic/i);
    expect(s.doc.appearance?.[part.id]).toBe("#d64545");
    expect(s.doc.finishes?.[part.id]).toBe("glossy");
    // The same again changes nothing and adds no undo step (undo below goes straight back past it).
    expect(await ok(s, "set_appearance", { colour: "#d64545", finish: "Glossy plastic" })).toMatch(/already/);

    await ok(s, "set_appearance", { part: part.name, finish: "clear" });
    expect(s.doc.appearance?.[part.id]).toBe("#d64545");
    await ok(s, "export_model", { format: "3mf", filename: "look" });
    const file = readdirSync(folder).find((f) => f.endsWith(".3mf"))!;
    // The model part of the zip is stored, not compressed, so the colour can be read straight from the bytes.
    expect(readFileSync(join(folder, file)).toString("latin1")).toMatch(/displaycolor="#D6454559"/);

    await ok(s, "undo");
    expect(s.doc.finishes?.[part.id]).toBe("glossy");
    await ok(s, "undo");
    expect(s.doc.finishes).toBeUndefined();
    await ok(s, "set_appearance", { finish: "Silk PLA" });
    expect(s.doc.finishes?.[part.id]).toBe("silk");
    await ok(s, "set_appearance", { part: part.name, colour: "default", finish: "default" });
    expect(s.doc.appearance).toBeUndefined();
    expect(s.doc.finishes).toBeUndefined();

    const bad = await callTool(s, "set_appearance", { part: part.name, finish: "sparkly" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/isn't a finish/);
    const none = await callTool(s, "set_appearance", { part: part.name });
    expect(none.isError).toBe(true);
  });
});
