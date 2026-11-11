/**
 * delete_feature with `with_dependents` (Onshape's Delete with the features
 * that use it), run with the real OpenCascade engine.
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

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");

async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

describe("delete_feature with dependents", () => {
  it("deletes a sketch with everything built on it, in one undo step", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Bracket" });
    await ok(s, "add_sketch", { name: "Plate outline", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
    await ok(s, "add_feature", { type: "extrude", sketch: "Plate outline", depth: 3 });
    await ok(s, "add_feature", { type: "fillet", edges: ["along z"], radius: 4, name: "Round corners" });
    await ok(s, "add_sketch", { name: "Elsewhere", plane: "Front", shapes: [{ type: "circle", center: [100, 10], diameter: 10 }] });
    const names = () => s.doc.features.map((f) => f.name);
    const all = names();

    const refused = await callTool(s, "delete_feature", { feature: "Extrude 1" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/used by Round corners\. [\s\S]*"with_dependents": true/);
    expect(names()).toEqual(all);

    const said = await ok(s, "delete_feature", { feature: "Plate outline", with_dependents: true });
    expect(said).toMatch(/Deleted Plate outline and the 2 features that used it: Extrude 1 and Round corners\./);
    expect(names()).toEqual(["Elsewhere"]);
    await ok(s, "undo");
    expect(names()).toEqual(all);

    // Nothing uses the last sketch: with_dependents just deletes it.
    expect(await ok(s, "delete_feature", { feature: "Elsewhere", with_dependents: true })).toMatch(/^Deleted Elsewhere\./);
  });
});
