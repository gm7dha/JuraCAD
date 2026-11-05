/** The fifth batch of 3D printing designs through Claude's tools: a Honeycomb wall hook and a pipe clip inserted with insert_library_design (real OCCT). */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";
import { defaultValues, findDesign } from "../src/library/insert";
import { hookVolume } from "../src/library/designs/honeycomb";
import { pipeClipVolume } from "../src/library/designs/pipeClip";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-lib5-"));
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

describe("the fifth batch through Claude's tools", () => {
  it("lists the new designs, and inserts a Honeycomb wall hook and a pipe clip", async () => {
    const s = newSession();
    const list = await call(s, "list_library_designs", { category: "print" });
    expect(list.text).toMatch(/hsw-tile — Honeycomb wall tile \(HSW\) \[3D printing › Storage\]/);
    expect(list.text).toMatch(/pipe-clip — Pipe \/ hose clip \[3D printing › Fixings\]/);
    const hook = await call(s, "insert_library_design", { design: "hsw-hook", sizes: { reach: 50 } });
    expect(hook.error).toBe(false);
    const clip = await call(s, "insert_library_design", { design: "pipe-clip", sizes: { pipe: 15 } });
    expect(clip.error).toBe(false);
    const parts = s.withEngine((e) => e.check("normal").parts);
    expect(parts).toHaveLength(2);
    for (const p of parts) expect(p.geometryValid).toBe(true);
    const want = [hookVolume({ ...defaultValues(findDesign("hsw-hook")!), reach: 50 }), pipeClipVolume({ ...defaultValues(findDesign("pipe-clip")!), pipe: 15 })].sort((a, b) => a - b);
    const vols = parts.map((p) => p.exactVolume!).sort((a, b) => a - b);
    expect(vols[0]).toBeCloseTo(want[0], 1);
    expect(vols[1]).toBeCloseTo(want[1], 1);
    const bad = await call(s, "insert_library_design", { design: "pipe-clip", sizes: { grip: 35, wall: 5 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/would have to stretch/);
  });
});
