/** The casting moulds through Claude's tools: a wax melt tray and a wick bar inserted with insert_library_design (real OCCT), and a locking pattern refused. */
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
import { meltTrayVolume } from "../src/library/designs/meltTray";
import { wickBarVolume } from "../src/library/designs/candleMould";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-moulds-"));
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

describe("the casting moulds through Claude's tools", () => {
  it("lists them, inserts a heart wax melt tray and a wick bar, and refuses rings on a concrete pot", async () => {
    const s = newSession();
    const list = await call(s, "list_library_designs", { category: "print" });
    expect(list.text).toMatch(/pillar-candle-mould — Pillar candle mould \[3D printing › Moulds and casting\]/);
    const tray = await call(s, "insert_library_design", { design: "wax-melt-tray", sizes: { shape: "heart", columns: 2, rows: 2 } });
    expect(tray.error).toBe(false);
    const bar = await call(s, "insert_library_design", { design: "wick-bar", sizes: { span: 80 } });
    expect(bar.error).toBe(false);
    const parts = s.withEngine((e) => e.check("normal").parts);
    expect(parts).toHaveLength(2);
    for (const p of parts) expect(p.geometryValid).toBe(true);
    const want = [meltTrayVolume({ ...defaultValues(findDesign("wax-melt-tray")!), shape: "heart", columns: 2, rows: 2 }), wickBarVolume({ ...defaultValues(findDesign("wick-bar")!), span: 80 })].sort((a, b) => a - b);
    const vols = parts.map((p) => p.exactVolume!).sort((a, b) => a - b);
    expect(vols[0]).toBeCloseTo(want[0], 1);
    expect(vols[1]).toBeCloseTo(want[1], 1);
    const bad = await call(s, "insert_library_design", { design: "concrete-pot-mould", sizes: { pattern: "rings" } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/would lock the concrete in a one-piece mould/);
  });
});
