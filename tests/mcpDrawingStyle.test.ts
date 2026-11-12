/**
 * Claude's add_revision, crop_view and set_drawing_style (src/mcp/drawingExtras.ts), with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-drwstyle-"));
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
const drawing = (s: Session) => s.doc.drawings![0];

describe("drawing revisions, crops and style for Claude", () => {
  it("adds revisions, crops a view and sets the standard", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Plate" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 20, height: 10 });
    await ok(s, "create_drawing", { views: ["front", "top"] });

    expect(await ok(s, "add_revision", { description: "First issue", date: "01/11/2026" })).toMatch(/Added revision A \(01\/11\/2026\)/);
    expect(await ok(s, "add_revision", { description: "Wider", by: "AB", approved: "CD" })).toMatch(/revision B/);
    expect(drawing(s).revisions!.map((r) => [r.rev, r.by ?? null])).toEqual([
      ["A", null],
      ["B", "AB"],
    ]);

    expect(await ok(s, "crop_view", { view: "front", corners: [[0, 0, 0], [20, 0, 10]] })).toMatch(/Cropped Front/);
    const crop = drawing(s).views.find((v) => v.kind === "front")!.crop!;
    expect("a" in crop).toBe(true);
    expect(await ok(s, "crop_view", { view: "top", outline: [[0, 0, 0], [40, 0, 0], [20, 20, 0]], smooth: true })).toMatch(/Cropped Top/);
    expect(drawing(s).views.find((v) => v.kind === "top")!.crop).toMatchObject({ smooth: true });
    expect(await fails(s, "crop_view", { view: "front", corners: [[0, 0, 0]] })).toMatch(/exactly two/);
    expect(await ok(s, "crop_view", { view: "front", remove: true })).toMatch(/Took the crop off/);
    expect(drawing(s).views.find((v) => v.kind === "front")!.crop).toBeUndefined();
    expect(await fails(s, "crop_view", { view: "front", remove: true })).toMatch(/isn't cropped/);

    expect(await ok(s, "set_drawing_style", { standard: "ansi", decimal_comma: true, title_fields: [{ label: "Finish", value: "Anodised" }] })).toMatch(/ANSI/);
    expect([drawing(s).standard, drawing(s).projection, drawing(s).decimalComma]).toEqual(["ansi", "third", true]);
    expect(drawing(s).fields).toEqual([{ label: "Finish", value: "Anodised" }]);
    await ok(s, "set_drawing_style", { standard: "iso", decimal_comma: false, title_fields: [] });
    expect([drawing(s).standard, drawing(s).projection, drawing(s).decimalComma, drawing(s).fields]).toEqual([undefined, undefined, undefined, undefined]);
    expect(await fails(s, "set_drawing_style", {})).toMatch(/at least one/);
  });
});
