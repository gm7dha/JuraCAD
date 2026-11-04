/** Claude's simplify_part tool (src/mcp/tools.ts), with the real OpenCascade engine. */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeBinaryStl } from "../src/geometry/stl";
import { addFeature, createFeature, emptyDocument } from "../src/model/document";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";
import { base64, washer } from "./support/meshShapes";

beforeAll(async () => {
  setOC(await opencascade());
});

const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");

describe("simplify_part", () => {
  it("tidies an imported STL into real faces and says what it found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-simplify-"));
    dirs.push(dir);
    const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
    sessions.push(s);
    const m = washer();
    const doc = emptyDocument();
    const imp = { ...createFeature(doc, "import"), import: { fileName: "washer.stl", format: "stl" as const, data: base64(new Uint8Array(writeBinaryStl([m]))), units: "mm" as const } };
    s.commit(addFeature(doc, imp));
    const before = s.build().parts[0].faceGroups.length;
    expect(before).toBeGreaterThan(50);

    const r = await callTool(s, "simplify_part", { level: "normal" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/→ 4 faces: 2 flat, 2 round \(hole Ø8, round Ø20\)/);
    expect(s.build().parts[0].faceGroups).toHaveLength(4);
    expect(s.doc.features.at(-1)?.type).toBe("simplify");

    const bad = await callTool(s, "simplify_part", { level: "rough" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/fine|normal|coarse/);
  });
});
