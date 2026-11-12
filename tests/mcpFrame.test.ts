/**
 * The Claude extension and Frames (Frame, Trim frame, Gusset, the cut list), with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-frame-"));
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

describe("frames from Claude", () => {
  it("makes a 2020 frame, sets a corner, adds a gusset, trims, and lists the cuts", async () => {
    const s = newSession();
    await ok(s, "add_sketch", { name: "Base", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 400, height: 300 }] });
    await ok(s, "add_feature", { type: "frame", sketches: ["Base"], profile: "extrusion", size: "2020" });
    expect(s.build().parts).toHaveLength(4);
    const list = await ok(s, "describe_cut_list");
    expect(list).toContain("2 × 2020 aluminium extrusion, 420.0 mm, ends 45° / 45°");
    expect(list).toContain("Total 2020 aluminium extrusion: 4 pieces, 1.480 m");
    const names = s.build().parts.map((p) => p.name);
    await ok(s, "edit_feature", { feature: "Frame 1", corners: [{ at: [0, 0, 0], type: "butt", through: 1 }] });
    expect(s.doc.features.find((f) => f.type === "frame")!.frame!.corners).toHaveLength(1);
    await ok(s, "add_feature", { type: "gusset", members: [names[0], names[3]], size: 60, thickness: 4, chamfer: 5 });
    expect(s.build().parts).toHaveLength(5);
    await ok(s, "add_feature", { type: "trim_frame", members: [names[1]], plane: { point: [0, 150, 0], normal: [0, 1, 0] }, flip: true });
    const csv = await ok(s, "describe_cut_list", { csv: true });
    expect(csv.split("\n")[0]).toBe("Item,Quantity,Profile,Cut length (mm),End cuts,Mass each (g),Parts");
    expect(await fails(s, "add_feature", { type: "frame", sketches: ["Base"], corners: [{ at: [5, 5, 5], type: "butt" }] })).toContain("no corner");
    expect(await fails(s, "add_feature", { type: "gusset", members: [names[0]] })).toContain("exactly two");
  });
});
