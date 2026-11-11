/** The six-piece burr's surface patterns through Claude's tools: a patterned, numbered burr inserted (real OCCT), and too much detail refused. */
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-burr-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return s;
}
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
async function call(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  return { text: textOf(r), error: !!r.isError };
}

describe("the six-piece burr's surface patterns through Claude's tools", () => {
  it("inserts a burr with ribs and numbered ends, and refuses too much detail", async () => {
    const s = newSession();
    const burr = await call(s, "insert_library_design", { design: "six-piece-burr", sizes: { size: 16, surface: "ribs", ends: "number", difficulty: "easy" } });
    expect(burr.error, burr.text).toBe(false);
    expect(burr.text).toMatch(/Pattern cut 0\.6 mm deep/);
    expect(burr.text).toMatch(/number \(1–6\)/);
    const parts = s.withEngine((e) => e.check("normal").parts);
    expect(parts).toHaveLength(6);
    for (const p of parts) expect(p.geometryValid).toBe(true);
    const bad = await call(s, "insert_library_design", { design: "six-piece-burr", sizes: { size: 60, surface: "lattice", surfaceRepeats: 6 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/too much pattern detail/);
  });
});
