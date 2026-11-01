/**
 * Claude's drawing tools with views of other parts (other_parts): a drawing
 * of the base with a view of the lid, dimensioned, cut and saved — with the
 * real OpenCascade engine.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-asm-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return { s, folder: join(dir, "JuraCAD") };
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");

async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return r;
}
const okText = async (s: Session, name: string, args: unknown = {}) => textOf(await ok(s, name, args));

async function fails(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  expect(r.isError).toBe(true);
  return textOf(r);
}

/** A 40 × 40 × 10 base with a ⌀10 hole through its middle, and a separate 40 × 40 × 5 lid off to the side. */
async function buildParts(s: Session) {
  await ok(s, "new_design", { name: "Box and lid" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 10, x: 0, y: 0, z: 0 });
  await ok(s, "add_sketch", { on_face: "top", shapes: [{ type: "circle", center: [20, 20], diameter: 10 }] });
  await ok(s, "add_feature", { type: "extrude", operation: "remove", end: "through_all" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5, x: 60, y: 0, z: 0, operation: "new" });
  const parts = s.build().parts;
  expect(parts).toHaveLength(2);
  await ok(s, "rename_part", { part: parts[0].name, name: "Base" });
  await ok(s, "rename_part", { part: parts[1].name, name: "Lid" });
}


describe("drawings by Claude with views of other parts", () => {
  it("puts a view of another part (and an assembly) on the sheet, dimensions, cuts and saves it", async () => {
    const { s, folder } = newSession();
    await buildParts(s);
    const made = await okText(s, "create_drawing", { part: "Base", views: ["front", "top"], other_parts: [{ part: "Lid", views: ["front", "top"] }] });
    expect(made).toMatch(/- Front — across = X, up = Z; from \(0, 0\) to \(40, 10\) mm/);
    expect(made).toMatch(/- Front of Lid — across = X, up = Z; from \(60, 0\) to \(100, 5\) mm/);
    expect(made).toMatch(/- Top of Lid — across = X, up = Y; from \(60, 0\) to \(100, 40\) mm/);
    const d = s.doc.drawings![0];
    const base = d.views.find((v) => v.source)!;
    expect(base.source!.kind).toBe("part");
    expect(d.views.find((v) => v.parent === base.id)!.kind).toBe("top");

    expect(await okText(s, "add_dimension", { view: "front of lid", from: [60, 0, 0], to: [100, 0, 0] })).toMatch(/horizontal dimension on Front of Lid: 40\./);
    expect(await okText(s, "add_dimension", { view: "front of Lid", from: [60, 0, 0], to: [60, 0, 5] })).toMatch(/vertical dimension on Front of Lid: 5\./);
    expect(s.doc.drawings![0].dimensions!.map((x) => x.view)).toEqual([`front@${base.id}`, `front@${base.id}`]);
    const auto = await okText(s, "auto_dimension", {});
    expect(auto).toMatch(/Added \d+ dimensions? to Drawing 1/);
    expect(s.doc.drawings![0].dimensions!.some((x) => x.view === `top@${base.id}`)).toBe(true);
    expect(s.doc.drawings![0].dimensions!.some((x) => x.view === "top")).toBe(true);

    // A section of the lid, cut on its own top view: the lid's 40 × 5 cross-section.
    const cut = await okText(s, "add_section_view", { on: "top of Lid", direction: "horizontal", through: [80, 20, 0] });
    expect(cut).toMatch(/Added Section A \(cut along a line on the top of lid view\)/);
    expect(cut).toMatch(/- Section A — across = X, up = Z; from \(60, 0\) to \(100, 5\) mm/);
    const detail = await okText(s, "add_detail_view", { on: "front of Lid", around: [60, 0, 0], radius: 4 });
    expect(detail).toMatch(/Added Detail B \(2× the front of lid view/);
    expect(s.doc.drawings![0].sections![0].host).toBe(`top@${base.id}`);
    expect(await fails(s, "edit_drawing", { other_parts: [{ part: "Lid", views: ["front"] }] })).toMatch(/section or detail is drawn on its top view/);
    expect(await fails(s, "edit_drawing", { other_parts: [{ part: "Base" }] })).toMatch(/sheet's own part/);
    // Kept (same part, same first view): its dimensions and section stay; the sheet's own views can change freely.
    await ok(s, "edit_drawing", { views: ["front"], other_parts: [{ part: "Lid", views: ["front", "top", "iso"] }] });
    const after = s.doc.drawings![0];
    expect(after.views.find((v) => v.source)!.id).toBe(base.id);
    expect(after.views.filter((v) => v.parent === base.id).map((v) => v.kind)).toEqual(["top", "iso"]);
    expect(after.sections!.length).toBe(1);

    expect(await okText(s, "export_drawing", { format: "pdf" })).toMatch(/1 page/);
    const pdf = readFileSync(join(folder, "Box and lid Drawing 1.pdf"), "latin1");
    expect(pdf).toMatch(/\(SECTION A-A\) Tj/);

    // An assembly in a view: its parts list goes on the sheet.
    await ok(s, "create_assembly", { name: "Box" });
    await ok(s, "insert_into_assembly", { part: "Base" });
    await ok(s, "insert_into_assembly", { part: "Lid" });
    const two = await okText(s, "edit_drawing", { other_parts: [{ part: "Lid", views: ["front", "top", "iso"] }, { assembly: "Box", views: ["iso"] }] });
    expect(two).toMatch(/3D \(isometric\) of Box/);
    expect(two).toMatch(/Parts list on the sheet: 1\. Base × 1; 2\. Lid × 1\./);
    // Removing them all leaves the drawing as it was made.
    await ok(s, "edit_drawing", { other_parts: [] });
    expect(s.doc.drawings![0].views.some((v) => v.source || v.parent)).toBe(false);
    expect(s.doc.drawings![0].sections).toBeUndefined();
  });
});
