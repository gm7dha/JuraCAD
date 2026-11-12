/**
 * Claude's assembly features (src/mcp/assemblyFeatureTools.ts) with the real
 * engine: a hole drilled through two stacked plates in an assembly cuts both
 * copies there only; a cut of chosen copies; refusals; deleting with its sketch.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-asmfeat-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return { s, folder: join(dir, "JuraCAD") };
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

/** Two plates (40 × 40 × 5 and 40 × 40 × 4) stacked in an assembly. */
async function plates(s: Session) {
  await ok(s, "new_design", { name: "Plates" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 4, x: 100, operation: "new" });
  const parts = s.build().parts;
  await ok(s, "rename_part", { part: parts[0].name, name: "Lower" });
  await ok(s, "rename_part", { part: parts[1].name, name: "Upper" });
  await ok(s, "create_assembly", { name: "Stack" });
  await ok(s, "insert_into_assembly", { part: "Lower", at: [0, 0, 0] });
  await ok(s, "insert_into_assembly", { part: "Upper", at: [-100, 0, 5] });
}

describe("assembly features for Claude", () => {
  it("drills through both plates in the assembly only", async () => {
    const { s, folder } = newSession();
    await plates(s);
    const said = await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Upper <1>", face: "top" }, points: [[20, 20]], diameter: 6 });
    expect(said).toMatch(/cuts Lower <1>, Upper <1> in this assembly only/);
    const hole = Math.PI * 9;
    expect(said).toContain(`${Math.round((1600 * 5 - hole * 5) * 100) / 100} mm³`);
    const text = await ok(s, "describe_assembly", {});
    expect(text).toMatch(/Assembly features/);
    expect(text).toMatch(/Hole 1 \(hole, from Sketch 1; cuts every part it reaches\)/);
    expect(text).toMatch(/Lower \(modified in assembly\) × 1/);
    // Exported STEP has the hole; the Part Studio's parts are unchanged.
    await ok(s, "export_model", { assembly: "Stack", format: "step", filename: "stack" });
    expect(readFileSync(join(folder, "stack.step"), "utf8")).toContain("CYLINDRICAL_SURFACE");
    expect(s.build().parts.map((p) => Math.round(p.volume!))).toEqual([8000, 6400]);
  });

  it("cuts only the parts named, and refuses a cut that reaches nothing", async () => {
    const { s } = newSession();
    await plates(s);
    const said = await ok(s, "add_assembly_feature", { kind: "cut", on: "top", rectangles: [{ corner: [5, 5], size: [10, 10] }], parts: ["Upper <1>"] });
    expect(said).toMatch(/cuts Upper <1> in this assembly only/);
    const miss = await fails(s, "add_assembly_feature", { kind: "hole", on: "top", points: [[500, 500]], diameter: 4 });
    expect(miss).toMatch(/wouldn't cut anything/);
    expect(await fails(s, "add_assembly_feature", { kind: "hole", on: { instance: "Upper <1>", face: "top" }, rectangles: [] })).toMatch(/"points"/);
  });

  it("deletes a sketch with the hole made from it", async () => {
    const { s } = newSession();
    await plates(s);
    await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Upper <1>", face: "top" }, points: [[10, 10]], diameter: 3, through_all: false, depth: 6 });
    expect(await ok(s, "delete_assembly_feature", { feature: "Sketch 1" })).toMatch(/Deleted Sketch 1, Hole 1/);
    expect(s.doc.assemblies![0].features).toBeUndefined();
  });
});
