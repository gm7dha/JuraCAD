/**
 * The Claude extension and Boundary surface / Face blend, with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-bsurf-"));
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


describe("boundary surface and face blend, from Claude", () => {
  it("tells Claude about them", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/boundary_surface/);
    expect(add.description).toMatch(/face_blend/);
  });

  it("rounds where two faces of a block meet, and makes a boundary surface between two of its edges", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Blend" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 10, height: 10 });
    await ok(s, "add_feature", { type: "face_blend", faces: ["top"], faces2: ["right"], radius: 2 });
    expect(Math.abs(volume(s) - (2000 - (4 - Math.PI) * 10))).toBeLessThan(1e-4);
    expect(await ok(s, "describe_design")).toMatch(/face blend radius 2 mm between 1 and 1 face\(s\)/);
    // Two opposite edges of the bottom (along y, at x = 0 and x = 20), joined by straight lines: a flat patch.
    await ok(s, "add_feature", { type: "boundary_surface", u: [{ part: "Part 1", edge: { near: [0, 5, 0] } }, { part: "Part 1", edge: { near: [20, 5, 0] } }] });
    const built = s.build();
    expect(built.parts.map((p) => !!p.surface)).toEqual([false, true]);
    expect(await fails(s, "add_feature", { type: "boundary_surface", u: [{ sketch: "nothing" }] })).toMatch(/sketch|at least two/);
    expect(await fails(s, "add_feature", { type: "face_blend", part: "Part 1", faces: ["top"], faces2: ["bottom"], radius: 2 })).toMatch(/can't roll|ball/);
  });
});
