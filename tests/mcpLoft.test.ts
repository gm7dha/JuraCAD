/**
 * The Claude extension and Loft (sections, points, end conditions, guide, ring),
 * with the real OpenCascade engine.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, TOOLS, type ToolResult } from "../src/mcp/tools";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-loft-"));
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
  expect(r.isError).toBe(true);
  return textOf(r);
}
const volumes = (s: Session) => s.withEngine((e) => e.check("normal").parts.map((p) => p.exactVolume!));
const total = (s: Session) => volumes(s).reduce((a, b) => a + b, 0);
const exactly = (actual: number, exact: number) => expect(Math.abs(actual / exact - 1)).toBeLessThan(1e-6);


describe("loft from Claude", () => {
  it("tells Claude about it", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/loft \(a smooth solid/);
  });

  it("lofts between sketches, to a point, rounded and square", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Lofts" });
    await ok(s, "add_sketch", { name: "Base", plane: "Top", shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    await ok(s, "add_sketch", { name: "Cap", plane: "Top", offset: 10, shapes: [{ type: "rectangle", corner: [-5, -5], width: 10, height: 10 }] });
    const added = await ok(s, "add_feature", { type: "loft", sections: ["Base", "Cap"] });
    expect(added).toMatch(/loft through Base, Cap/);
    exactly(total(s), (10 / 3) * (400 + 100 + 200));
    // A pyramid: from Base to a point 30 up.
    await ok(s, "edit_feature", { feature: "Loft 1", sections: ["Base"], end_point: [0, 0, 30] });
    exactly(total(s), 4000);
    expect(await fails(s, "edit_feature", { feature: "Loft 1", end: "match_tangent" })).toMatch(/doesn't suit/);
    await ok(s, "edit_feature", { feature: "Loft 1", end: "rounded" });
    expect(total(s)).toBeGreaterThan(4000);
    // Square to the base, reaching further: still builds.
    await ok(s, "edit_feature", { feature: "Loft 1", end_point: null, sections: ["Base", "Cap"], end: "none", start: "normal", start_magnitude: 2 });
    expect(total(s)).toBeGreaterThan((10 / 3) * 700);
    expect(await fails(s, "edit_feature", { feature: "Loft 1", sections: ["Base"] })).toMatch(/at least two/);
    // A start point put in front: the square start no longer suits the first section, so it's dropped.
    await ok(s, "edit_feature", { feature: "Loft 1", start_point: [0, 0, -20] });
    const lo = s.doc.features.find((f) => f.name === "Loft 1")!;
    expect(lo.loft?.start).toBeUndefined();
  });
});
