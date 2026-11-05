/** The fourth batch of 3D printing designs through Claude's tools: a French cleat and shelf inserted with insert_library_design (real OCCT). */
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
import { cleatVolumes } from "../src/library/designs/frenchCleat";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-lib4-"));
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

describe("the fourth batch through Claude's tools", () => {
  it("lists the new headings, and inserts a French cleat strip with a shelf holder", async () => {
    const s = newSession();
    const list = await call(s, "list_library_designs", { category: "print" });
    expect(list.text).toMatch(/enclosure — Electronics enclosure \[3D printing › Electronics\]/);
    expect(list.text).toMatch(/fit-test — Fit \(tolerance\) test \[3D printing › Test prints\]/);
    const sizes = { holder: "shelf", length: 150, shelf: 40 };
    const r = await call(s, "insert_library_design", { design: "french-cleat", sizes });
    expect(r.error).toBe(false);
    const parts = s.withEngine((e) => e.check("normal").parts);
    expect(parts).toHaveLength(2);
    const want = cleatVolumes({ ...defaultValues(findDesign("french-cleat")!), ...sizes });
    const vols = parts.map((p) => p.exactVolume!).sort((a, b) => a - b);
    expect(vols[0]).toBeCloseTo(Math.min(want.strip, want.holder), 1);
    expect(vols[1]).toBeCloseTo(Math.max(want.strip, want.holder), 1);
    for (const p of parts) expect(p.geometryValid).toBe(true);
    const bad = await call(s, "insert_library_design", { design: "french-cleat", sizes: { holder: "shelf", shelf: 80 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/braced at 45°/);
  });
});
