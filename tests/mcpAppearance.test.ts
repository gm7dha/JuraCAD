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
  it("colours single faces, and the 3MF then paints them for Bambu Studio", async () => {
    const { s, folder } = newSession();
    await ok(s, "new_design", { name: "Faces" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 10, height: 10 });
    const part = s.build().parts[0];
    expect(await ok(s, "set_appearance", { colour: "red", faces: ["top"] })).toMatch(/1 face coloured #d64545 \(1 face colour on it now\)/);
    const list = s.doc.faceAppearance?.[part.id];
    expect(list).toHaveLength(1);
    expect(list![0].face.normal[2]).toBeCloseTo(1, 6);
    expect(s.doc.appearance).toBeUndefined();
    // The same again: nothing changes.
    expect(await ok(s, "set_appearance", { colour: "#d64545", faces: ["top"] })).toMatch(/already/);
    await ok(s, "export_model", { format: "3mf", filename: "faces" });
    const file = readdirSync(folder).find((f) => f.endsWith(".3mf"))!;
    const bytes = readFileSync(join(folder, file)).toString("latin1");
    expect(bytes).toMatch(/paint_color="8"/);
    expect(bytes).toMatch(/Metadata\/model_settings\.config/);

    expect(textOf(await callTool(s, "set_appearance", { colour: "red", faces: ["top"], finish: "glossy" }))).toMatch(/whole part/);
    expect(textOf(await callTool(s, "set_appearance", { faces: ["top"] }))).toMatch(/give the faces a "colour"/);
    expect((await callTool(s, "set_appearance", { colour: "red", faces: ["F99"] })).isError).toBe(true);
    expect(await ok(s, "set_appearance", { colour: "default", faces: ["top"] })).toMatch(/back to the part's own colour \(no face colours/);
    expect(s.doc.faceAppearance).toBeUndefined();
  });
});
