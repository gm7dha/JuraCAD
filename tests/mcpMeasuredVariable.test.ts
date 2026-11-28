/**
 * The Claude extension and measured variables, with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-measured-"));
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

describe("measured_variable, from Claude", () => {
  it("tells Claude about it", () => {
    expect(TOOLS.find((t) => t.name === "add_feature")!.description).toMatch(/measured_variable/);
  });

  it("measures a box's width; a later box uses it and follows when the first one grows; renames follow", async () => {
    const s = newSession();
    await ok(s, "set_variables", { variables: [{ name: "w", value: "40" }] });
    await ok(s, "add_feature", { type: "box", width: "w", depth: 30, height: 20 });
    const said = await ok(s, "add_feature", { type: "measured_variable", variable: "width", targets: [{ part: "Part 1", face: "left" }, { part: "Part 1", face: "right" }] });
    expect(said).toMatch(/40 mm now/);
    await ok(s, "add_feature", { type: "box", width: "width / 2", depth: 5, height: 5, x: 100, operation: "new" });
    const second = () => s.withEngine((e) => e.check("normal").parts[1].exactVolume!);
    expect(second()).toBeCloseTo(20 * 25, 4);
    expect(s.build().errors).toEqual({});
    await ok(s, "set_variables", { variables: [{ name: "w", value: "60" }] });
    expect(s.build().errors).toEqual({});
    expect(Object.values(s.build().measured ?? {})[0].value).toBeCloseTo(60, 6);
    expect(second()).toBeCloseTo(30 * 25, 4);
    // Renamed: the box using it follows.
    await ok(s, "edit_feature", { feature: "Variable 1", variable: "span" });
    expect(s.doc.features[2].params.width).toBe("span / 2");
    // Refused: a name the Variables table has, a corner for a diameter, too few things.
    expect(await fails(s, "add_feature", { type: "measured_variable", variable: "w", targets: ["Top", "Front"] })).toMatch(/Variables table/);
    expect(await fails(s, "add_feature", { type: "measured_variable", variable: "d", measure: "diameter", targets: [{ part: "Part 1", vertex: [0, 0, 0] }] })).toMatch(/round/);
    expect(await fails(s, "add_feature", { type: "measured_variable", variable: "d", targets: ["Top"] })).toMatch(/one more/);
    // The angle between the top and a side.
    expect(await ok(s, "add_feature", { type: "measured_variable", variable: "a", measure: "angle", targets: [{ part: "Part 1", face: "top" }, "Front"] })).toMatch(/90° now/);
  });
});
