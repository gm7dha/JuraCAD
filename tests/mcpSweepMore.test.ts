/**
 * Claude's sweeps with Onshape's further choices (scale, twist as turns or a pitch, Lock profile direction, a surface,
 * a part's face as the profile), with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-sweep-"));
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
  if (!r.isError) throw new Error(`${name} should have failed: ${textOf(r)}`);
  return textOf(r);
}
const volumes = (s: Session) => s.withEngine((e) => e.check("normal").parts.map((p) => p.exactVolume!));
const near = (actual: number, exact: number, tol = 1e-5) => expect(Math.abs(actual / exact - 1)).toBeLessThan(tol);

describe("sweeps from Claude", () => {
  it("tells Claude about the new choices", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/lock_direction/);
    expect(add.description).toMatch(/profile_face/);
  });

  it("scales, twists by turns and pitch, locks a direction and makes a surface", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Sweeps" });
    await ok(s, "add_sketch", { name: "Path", plane: "Top", shapes: [{ type: "line", from: [0, 0], to: [100, 0] }] });
    await ok(s, "add_sketch", { name: "Disc", plane: "Right", shapes: [{ type: "circle", center: [0, 0], diameter: 4 }] });
    await ok(s, "add_feature", { type: "sweep", sketch: "Disc", path: "Path", scale: 0.5 });
    near(volumes(s)[0], (Math.PI * 100 * (4 + 2 + 1)) / 3);
    const f = s.doc.features.find((x) => x.type === "sweep")!;
    expect(f.sweepControl).toEqual({ scaled: true });
    await ok(s, "edit_feature", { feature: f.name, scale: 1 });
    expect(s.doc.features.find((x) => x.type === "sweep")!.sweepControl).toBeUndefined();
    near(volumes(s)[0], Math.PI * 4 * 100);
    await ok(s, "edit_feature", { feature: f.name, twist_turns: 2 });
    expect(s.doc.features.find((x) => x.type === "sweep")!.sweepControl).toEqual({ twistBy: "turns" });
    await ok(s, "edit_feature", { feature: f.name, twist_pitch: 25, twist_opposite: true });
    expect(s.doc.features.find((x) => x.type === "sweep")!.sweepControl).toEqual({ twistBy: "pitch", opposite: true });
    near(volumes(s)[0], Math.PI * 4 * 100, 1e-4);
    expect(await fails(s, "edit_feature", { feature: f.name, twist: 90, twist_turns: 1 })).toMatch(/one way only/);
    expect(await fails(s, "edit_feature", { feature: f.name, twist: 90, lock_direction: "z" })).toMatch(/"twist" isn't used with "lock_direction"/);
    await ok(s, "edit_feature", { feature: f.name, lock_direction: "z" });
    expect(s.doc.features.find((x) => x.type === "sweep")!.sweepControl?.lockDirection).toEqual({ p: [0, 0, 0], axis: "z" });
    expect(await fails(s, "edit_feature", { feature: f.name, lock_direction: "x" })).toMatch(/runs along the direction/);
    await ok(s, "add_sketch", { name: "Strip", plane: "Right", shapes: [{ type: "line", from: [-2, 5], to: [2, 5] }] });
    await ok(s, "add_feature", { type: "sweep", sketch: "Strip", path: "Path", surface: true, operation: "new" });
    expect(s.build().parts.some((p) => p.surface)).toBe(true);
  });

  it("sweeps a part's face", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Face sweep" });
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    await ok(s, "add_sketch", { name: "Up", plane: "Front", shapes: [{ type: "line", from: [5, 10], to: [5, 40] }] });
    await ok(s, "add_feature", { type: "sweep", profile_face: { part: "Part 1", face: "top" }, path: "Up", operation: "new" });
    const v = volumes(s);
    expect(v).toHaveLength(2);
    near(v[1], 3000);
    expect(await fails(s, "add_feature", { type: "sweep", profile_face: { part: "Part 1", face: "top" }, sketch: "Up", path: "Up" })).toMatch(/not both/);
  });
});
