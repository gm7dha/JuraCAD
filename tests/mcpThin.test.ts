/**
 * The Claude extension and thin walls (thin, thin_other_side, thin_centred, thin_flip) and a revolve's
 * second_angle, with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-thin-"));
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

describe("thin walls and two-way revolves, from Claude", () => {
  it("tells Claude about them", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/thin \(a wall this thick/);
    expect(add.description).toMatch(/second_angle/);
  });

  it("extrudes an L of lines into a wall, changes it, and turns it back into a solid", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Walls" });
    await ok(s, "add_sketch", { name: "L", plane: "Top", shapes: [{ type: "outline", points: [[0, 0], [40, 0], [40, 30]], closed: false }] });
    const added = await ok(s, "add_feature", { type: "extrude", sketch: "L", depth: 10, thin: 2, thin_centred: true });
    expect(added).toMatch(/a thin wall 2 mm thick \(centred on the lines\)/);
    exactly(total(s), 70 * 2 * 10);
    await ok(s, "edit_feature", { feature: "Extrude 1", thin_centred: false, thin_other_side: 1 });
    // 2 mm inside the corner, 1 mm outside: the inner corner loses 2², the outer gains 1².
    exactly(total(s), (70 * 3 - 2 * 2 + 1 * 1) * 10);
    expect(await fails(s, "edit_feature", { feature: "Extrude 1", thin_centred: true, thin_other_side: 1 })).toMatch(/thin_other_side/);
    // Off again: an open L has no closed shape to fill.
    expect(await fails(s, "edit_feature", { feature: "Extrude 1", thin: null })).toMatch(/closed/);
  });

  it("revolves two ways and refuses more than a full turn", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Ring" });
    await ok(s, "add_sketch", { name: "P", plane: "Front", shapes: [{ type: "rectangle", corner: [10, 0], width: 10, height: 10 }] });
    const added = await ok(s, "add_feature", { type: "revolve", sketch: "P", axis: "vertical", angle: 90, second_angle: 45 });
    expect(added).toMatch(/90° .*\+ 45° the other way/);
    expect(Math.abs(total(s) / ((135 / 360) * Math.PI * 300 * 10) - 1)).toBeLessThan(0.005);
    expect(await fails(s, "edit_feature", { feature: "Revolve 1", angle: 300, second_angle: 100 })).toMatch(/more than a full turn/);
    expect(await fails(s, "edit_feature", { feature: "Revolve 1", symmetric: true, second_angle: 30 })).toMatch(/symmetric/);
    await ok(s, "edit_feature", { feature: "Revolve 1", second_angle: 0 });
    expect(Math.abs(total(s) / ((90 / 360) * Math.PI * 300 * 10) - 1)).toBeLessThan(0.005);
  });

  it("keeps a new two-way revolve within a full turn, and refuses a tapering thin wall", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Two" });
    await ok(s, "add_sketch", { name: "P", plane: "Front", shapes: [{ type: "rectangle", corner: [10, 0], width: 10, height: 10 }] });
    // No angle given: 360° + 90° would be more than a turn, so it starts at 180° + 90°, as the app does.
    await ok(s, "add_feature", { type: "revolve", sketch: "P", axis: "vertical", second_angle: 90 });
    expect(Math.abs(total(s) / ((270 / 360) * Math.PI * 300 * 10) - 1)).toBeLessThan(0.005);
    await ok(s, "add_sketch", { name: "L", plane: "Top", offset: 50, shapes: [{ type: "line", from: [0, 0], to: [40, 0] }] });
    expect(await fails(s, "add_feature", { type: "extrude", sketch: "L", depth: 10, thin: 2, draft: 5 })).toMatch(/can't taper/);
  });

  it("makes the wall round just the areas picked", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Pick" });
    await ok(s, "add_sketch", { name: "Two", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 20, height: 20 }, { type: "rectangle", corner: [30, 0], width: 20, height: 20 }] });
    await ok(s, "add_feature", { type: "extrude", sketch: "Two", depth: 10, thin: 2, areas: [[5, 5]] });
    exactly(total(s), (400 - 256) * 10);
  });
});
