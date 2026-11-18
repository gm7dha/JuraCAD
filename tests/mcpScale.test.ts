/** The Claude extension: scale_part (Scale uniformly) and an import's Scale / File units, with the real OpenCascade engine. */
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
import { callTool, TOOLS, type ToolResult } from "../src/mcp/tools";
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
function newSession() {
  const dir = mkdtempSync(join(tmpdir(), "juracad-scale-"));
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
const volumes = (s: Session) => s.withEngine((e) => e.check("normal").parts.map((p) => p.exactVolume!));

describe("scaling from Claude", () => {
  it("tells Claude about it", () => {
    expect(TOOLS.find((t) => t.name === "add_feature")!.description).toMatch(/scale_part/);
  });

  it("scales a part about its centre, makes a scaled copy, and refuses 0", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    const said = await ok(s, "add_feature", { type: "scale_part", part: "Part 1", scale: 2 });
    expect(said).toMatch(/scale .* by 2 about its centre/);
    expect((await volumes(s))[0]).toBeCloseTo(8000, 3);
    await ok(s, "add_feature", { type: "scale_part", part: "Part 1", scale: 0.5, about: [0, 0, 0], copy: true });
    const v = await volumes(s);
    expect(v).toHaveLength(2);
    expect(v[1]).toBeCloseTo(1000, 3);
    const bad = await callTool(s, "add_feature", { type: "scale_part", part: "Part 1", scale: 0 });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/more than 0/);
  });

  it("changes an import's scale and file units", async () => {
    const s = newSession();
    const doc = emptyDocument();
    const imp = { ...createFeature(doc, "import"), import: { fileName: "washer.stl", format: "stl" as const, data: base64(new Uint8Array(writeBinaryStl([washer()]))), units: "mm" as const } };
    s.commit(addFeature(doc, imp));
    const v0 = (await volumes(s))[0];
    await ok(s, "edit_feature", { feature: imp.name, scale: 2 });
    expect((await volumes(s))[0] / v0).toBeCloseTo(8, 3);
    const said = await ok(s, "edit_feature", { feature: imp.name, scale: 1, units: "cm" });
    expect(said).toMatch(/read as cm/);
    expect((await volumes(s))[0] / v0).toBeCloseTo(1000, 1);
  });
});
