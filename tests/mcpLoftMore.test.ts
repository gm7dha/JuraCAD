/**
 * The Claude extension and Loft's newer choices (surface, thin, curve paths, new ends, edges sections),
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-loft2-"));
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


describe("more loft choices from Claude", () => {
  it("tells Claude about them", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/tangent_to_profile/);
    expect(add.description).toMatch(/thin_centred/);
  });

  it("makes thin and surface lofts, follows a curve and leaves along a direction", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Lofts" });
    await ok(s, "add_sketch", { name: "Base", plane: "Top", shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    await ok(s, "add_sketch", { name: "Cap", plane: "Top", offset: 30, shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    // Thin: 2 mm into the squares.
    const thin = await ok(s, "add_feature", { type: "loft", sections: ["Base", "Cap"], thin: 2 });
    expect(thin).toMatch(/thin loft/);
    exactly(total(s), (400 - 256) * 30);
    await ok(s, "edit_feature", { feature: "Loft 1", thin_centred: true });
    exactly(total(s), (484 - 324) * 30);
    expect(await fails(s, "edit_feature", { feature: "Loft 1", surface: true, thin: 2 })).toMatch(/not both/);
    // Back to solid, leaving the base along X: refused (it lies in the base's plane); along Z: square to it.
    await ok(s, "edit_feature", { feature: "Loft 1", thin: null });
    expect(await fails(s, "edit_feature", { feature: "Loft 1", start: "direction" })).toMatch(/start_direction/);
    expect(await fails(s, "edit_feature", { feature: "Loft 1", start: "direction", start_direction: "x" })).toMatch(/own plane/);
    await ok(s, "edit_feature", { feature: "Loft 1", start: "direction", start_direction: "z" });
    expect(Math.abs(total(s) / 12000 - 1)).toBeLessThan(1e-3);
    await ok(s, "edit_feature", { feature: "Loft 1", start: "tangent_to_profile" });
    expect(s.doc.features.find((f) => f.name === "Loft 1")!.loft?.start?.kind).toBe("profileTangent");
    // A surface.
    await ok(s, "edit_feature", { feature: "Loft 1", start: "none", surface: true });
    expect(s.withEngine((e) => e.check("normal").parts.length)).toBeGreaterThan(0);
    expect(s.doc.features.find((f) => f.name === "Loft 1")!.surface).toBe(true);
  });

  it("takes a curve feature as the path", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Curved" });
    await ok(s, "add_sketch", { name: "Base", plane: "Top", shapes: [{ type: "circle", center: [0, 0], diameter: 6 }] });
    await ok(s, "add_sketch", { name: "Far", plane: "Top", offset: 30, shapes: [{ type: "circle", center: [5, 0], diameter: 4 }] });
    await ok(s, "add_feature", { type: "curve", curve_type: "fit_spline", points: [[0, 0, 0], [2, 0, 15], [5, 0, 30]] });
    const added = await ok(s, "add_feature", { type: "loft", sections: ["Base", "Far"], path: "Fit spline 1" });
    expect(added).toMatch(/along Fit spline 1/);
    expect(s.doc.features.find((f) => f.type === "loft")!.loft?.path).toEqual({ curve: s.doc.features.find((f) => f.type === "curve")!.id });
    expect(total(s)).toBeGreaterThan(400);
  });
});
