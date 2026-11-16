/**
 * The Claude extension and Move face (Offset / Translate / Rotate), with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-moveface-"));
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

describe("move_face, from Claude", () => {
  it("tells Claude about it", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/move_face/);
  });

  it("offsets a hole's wall, translates and rotates a face, and refuses mixed-up settings", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 30, depth: 30, height: 20 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 10, height: 20, x: 15, y: 15, operation: "remove" });
    const before = volume(s);
    expect(before).toBeCloseTo(18000 - Math.PI * 25 * 20, 4);
    const said = await ok(s, "add_feature", { type: "move_face", faces: [{ near: [15, 15, 10] }], distance: -0.2 });
    expect(said).toMatch(/offset/);
    expect(volume(s)).toBeCloseTo(18000 - Math.PI * 5.2 * 5.2 * 20, 4);
    const mf = s.doc.features.find((f) => f.type === "moveFace")!;
    expect(mf.moveFace).toEqual({ mode: "offset" });
    // Translate the top up 2 along Z.
    await ok(s, "add_feature", { type: "move_face", move: "translate", faces: ["top"], direction: "z", distance: 2 });
    expect(volume(s)).toBeCloseTo(22 * 900 - Math.PI * 5.2 * 5.2 * 22, 3);
    // Rotate the right side 5° about its bottom edge (along Y at x = 30, z = 0).
    const turned = await ok(s, "add_feature", { type: "move_face", move: "rotate", faces: ["right"], axis: { edge: { near: [30, 15, 0] } }, angle: 5 });
    expect(turned).toMatch(/rotate/);
    // Mixed up: an angle on a translate, a direction on a rotate, an axis on an offset.
    expect(await fails(s, "add_feature", { type: "move_face", move: "translate", faces: ["top"], direction: "z", angle: 5 })).toMatch(/angle/);
    expect(await fails(s, "add_feature", { type: "move_face", move: "rotate", faces: ["top"], direction: "z", angle: 5 })).toMatch(/axis/);
    expect(await fails(s, "add_feature", { type: "move_face", faces: ["top"], axis: "x", distance: 1 })).toMatch(/Offset/);
    // A curved face for the direction of a translate.
    expect(await fails(s, "add_feature", { type: "move_face", move: "translate", faces: ["top"], direction: { face: { near: [15, 15, 10] } }, distance: 1 })).toMatch(/curved/);
  });
});
