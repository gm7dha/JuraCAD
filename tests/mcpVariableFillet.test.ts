/**
 * The Claude extension's variable fillet (fillet `variable`), with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-vfil-"));
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
const volume = (s: Session) => s.withEngine((e) => e.check("normal").parts[0].exactVolume!);

describe("variable fillet, from Claude", () => {
  it("tells Claude about it", () => {
    expect(TOOLS.find((t) => t.name === "add_feature")!.description).toMatch(/variable/);
  });

  it("grows a fillet along an edge, and is changed and turned off by edit_feature", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Vary" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    const edge = { near: [10, 0, 10] };
    await ok(s, "add_feature", { type: "fillet", edges: [edge], radius: 1 });
    const one = volume(s);
    await ok(s, "edit_feature", { feature: "Fillet 1", radius: 4 });
    const four = volume(s);
    await ok(s, "edit_feature", { feature: "Fillet 1", radius: 1, variable: [{ edge, at: "start", radius: 1 }, { edge, at: "end", radius: 4 }] });
    const v = volume(s);
    expect(v).toBeLessThan(one);
    expect(v).toBeGreaterThan(four);
    const f = s.doc.features.find((x) => x.name === "Fillet 1")!;
    expect(f.variableFillet?.points.map((p) => [p.at, p.radius])).toEqual([
      [0, "1"],
      [1, "4"],
    ]);
    await ok(s, "edit_feature", { feature: "Fillet 1", variable: [{ edge, at: 0.5, radius: 3 }], variable_straight: true });
    expect(s.doc.features.find((x) => x.name === "Fillet 1")!.variableFillet).toEqual({ points: [{ part: f.variableFillet!.points[0].part, edge: f.variableFillet!.points[0].edge, at: 0.5, radius: "3" }], straight: true });
    await ok(s, "edit_feature", { feature: "Fillet 1", variable: false });
    expect(s.doc.features.find((x) => x.name === "Fillet 1")!.variableFillet).toBeUndefined();
    expect(Math.abs(volume(s) - one)).toBeLessThan(1e-6);
  });

  it("refuses points off the fillet's edges and odd places, in plain words", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Vary" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    expect(await fails(s, "add_feature", { type: "fillet", edges: [{ near: [10, 0, 10] }], radius: 1, variable: [{ edge: { near: [10, 20, 10] }, radius: 2 }] })).toMatch(/fillet's own edges/);
    expect(await fails(s, "add_feature", { type: "fillet", edges: [{ near: [10, 0, 10] }], radius: 1, variable: [{ edge: { near: [10, 0, 10] }, at: 3, radius: 2 }] })).toMatch(/share of the edge/);
  });
});
