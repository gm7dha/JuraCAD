/**
 * Claude's Offset curve, Isocline and Trim curve (add_feature "curve"), with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-curves-more-"));
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
  if (!r.isError) throw new Error(`${name} should have failed: ${textOf(r)}`);
  return textOf(r);
}
const r = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000 + 0);
void r;

describe("more curves made by Claude", () => {
  it("an offset of a box's top, an isocline on a ball and a trimmed helix", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 40, depth: 30, height: 10 });
    expect(await ok(s, "add_feature", { type: "curve", curve_type: "offset", part: "Part 1", faces: [{ near: [20, 15, 10] }], distance: 5 })).toMatch(/Offset curve 1/);
    const s2 = newSession();
    await ok(s2, "add_feature", { type: "sphere", diameter: 20 });
    expect(await ok(s2, "add_feature", { type: "curve", curve_type: "isocline", part: "Part 1", faces: [{ near: [0, 0, 10] }], angle: 45 })).toMatch(/Isocline 1/);
    expect(s2.build().errors).toEqual({});
    await ok(s, "add_feature", { type: "curve", curve_type: "helix", axis: "z", diameter: 20, height: 20, turns: 4 });
    expect(await ok(s, "add_feature", { type: "curve", curve_type: "trim", curve: "Helix 1", plane: "Top", flip: true })).toMatch(/Trim curve 1/);
    const b = s.build();
    expect(b.errors).toEqual({});
    expect(Object.keys(b.curves ?? {})).toHaveLength(3);
    expect(await fails(s, "add_feature", { type: "curve", curve_type: "trim", curve: "Helix 1" })).toMatch(/cut it back to/);
  });
});
