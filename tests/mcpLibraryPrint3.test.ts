/** The third batch of 3D printing designs through Claude's tools: a Gridfinity bin inserted with insert_library_design (real OCCT). */
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
import { binVolume } from "../src/library/designs/gridfinity";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-lib3-"));
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

describe("the third batch through Claude's tools", () => {
  it("lists the Gridfinity designs under their heading, and inserts a 2 × 2 bin with magnet holes", async () => {
    const s = newSession();
    const list = await call(s, "list_library_designs", { category: "print" });
    expect(list.text).toMatch(/gridfinity-bin — Gridfinity bin \[3D printing › Gridfinity\]/);
    expect(list.text).toContain("gridfinity-baseplate —");
    const r = await call(s, "insert_library_design", { design: "gridfinity-bin", sizes: { across: 2, along: 2, magnets: true, dividers: 1 } });
    expect(r.error).toBe(false);
    const parts = s.withEngine((e) => e.check("normal").parts);
    expect(parts).toHaveLength(1);
    expect(parts[0].geometryValid).toBe(true);
    const v = { ...defaultValues(findDesign("gridfinity-bin")!), across: 2, along: 2, magnets: true, dividers: 1 };
    expect(parts[0].exactVolume!).toBeCloseTo(binVolume(v), 1);
    const bad = await call(s, "insert_library_design", { design: "gridfinity-bin", sizes: { across: 1, dividers: 9 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/compartments only/);
  });
});
