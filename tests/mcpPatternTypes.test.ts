/**
 * Pattern types (parts / features / faces) and composite parts through the
 * Claude extension, run with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return s;
}

const volume = (s: Session) => s.withEngine((e) => e.check("normal").parts.reduce((t, p) => t + p.exactVolume!, 0));

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");

async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

const partCount = (s: Session) => s.build().parts.length;

describe("pattern types and composite parts in the Claude extension", () => {
  it("repeats whole parts, faces of a part, and groups parts into a composite", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Plates" });
    await ok(s, "add_feature", { type: "box", width: 60, depth: 20, height: 10, x: 0, y: 0, z: 0 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 6, height: 10, x: 10, y: 10, z: 0, operation: "remove", name: "Hole" });
    const before = volume(s);
    // Faces: the hole's inside, repeated along X.
    const said = await ok(s, "add_feature", { type: "linear_pattern", faces: [{ near: [7, 10, 5] }], direction: "x", count: 3, spacing: 20 });
    expect(said).toMatch(/face/);
    expect(volume(s)).toBeCloseTo(before - 2 * Math.PI * 9 * 10, 1);
    // Parts: the plate copied up twice, each a new part.
    await ok(s, "add_feature", { type: "linear_pattern", parts: ["Part 1"], direction: "z", count: 3, spacing: 30, skip: [2] });
    expect(partCount(s)).toBe(2);
    // A composite of both.
    await ok(s, "add_feature", { type: "composite_part", parts: ["Part 1", "Part 2"] });
    const parts = s.build().parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].members?.map((m) => m.name)).toEqual(["Part 1", "Part 2"]);
    // Plain problems.
    const r = await callTool(s, "add_feature", { type: "linear_pattern", parts: ["Part 1"], features: ["Hole"], count: 2, spacing: 5 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not several/);
  });
});
