/**
 * More of Claude's drawing tools (src/mcp/drawingExtras.ts and the wider
 * add_dimension), with the real OpenCascade engine: angle, chamfer, arc
 * length and ordinate dimensions, notes and drawing symbols, deleting them,
 * and adding, changing and removing sheets.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pageIds, pageOf } from "../src/drawing/pages";
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-drw2-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return { s, folder: join(dir, "JuraCAD") };
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

/**
 * A 40 × 20 × 10 block with a 3 mm chamfer along its top right edge and a
 * 4 mm round along its top left edge (seen from the front: a slanted edge
 * from (37, 10) to (40, 7) and a quarter circle round (4, 6)), and a 10 mm cube.
 */
async function buildParts(s: Session) {
  await ok(s, "new_design", { name: "Block" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 20, height: 10 });
  await ok(s, "add_feature", { type: "chamfer", edges: [{ near: [40, 10, 10] }], distance: 3 });
  await ok(s, "add_feature", { type: "fillet", edges: [{ near: [0, 10, 10] }], radius: 4 });
  await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10, x: 100, y: 0, z: 0, operation: "new" });
  const parts = s.build().parts;
  await ok(s, "rename_part", { part: parts[0].name, name: "Block" });
  await ok(s, "rename_part", { part: parts[1].name, name: "Cube" });
}

const drawing = (s: Session) => s.doc.drawings![0];

describe("more drawing tools for Claude", () => {
  it("adds angle, chamfer, arc length and ordinate dimensions, and deletes them", async () => {
    const { s } = newSession();
    await buildParts(s);
    await ok(s, "create_drawing", { part: "Block", views: ["front", "top", "iso"] });

    // The angle at the corner between the right edge and the chamfer: 135° (the outside one 225°).
    const angle = await ok(s, "add_dimension", { view: "front", type: "angle", edge: [[40, 0, 0], [40, 0, 7]], edge2: [[37, 0, 10], [40, 0, 7]] });
    expect(angle).toMatch(/Added an angle dimension on Front: 135°\./);
    expect(await ok(s, "add_dimension", { view: "front", type: "angle", edge: [[40, 0, 0], [40, 0, 7]], edge2: [[37, 0, 10], [40, 0, 7]], outside: true })).toMatch(/: 225°\./);
    expect(await fails(s, "add_dimension", { view: "front", type: "angle", edge: [[0, 0, 0], [40, 0, 0]], edge2: [[40, 0, 7], [37, 0, 10]], from: [0, 0, 0] })).toMatch(/"from" doesn't go with an angle/);
    expect(await fails(s, "add_dimension", { view: "front", type: "angle", edge: [[0, 0, 0], [40, 0, 7]], edge2: [[37, 0, 10], [40, 0, 7]] })).toMatch(/no straight edge from \(0, 0\) to \(40, 7\) on Front/);
    expect(await fails(s, "add_dimension", { view: "front", type: "angle", edge: [[0, 0, 0], [40, 0, 0]], edge2: [[40, 0, 0], [0, 0, 0]] })).toMatch(/parallel/);

    // The chamfer callout.
    expect(await ok(s, "add_dimension", { view: "front", type: "chamfer", edge: [[37, 0, 10], [40, 0, 7]] })).toMatch(/Added a chamfer callout dimension on Front: 3 × 45°\./);
    expect(await fails(s, "add_dimension", { view: "front", type: "chamfer", edge: [[0, 0, 0], [40, 0, 0]] })).toMatch(/level or upright/);

    // The length round the quarter round: π/2 × 4.
    expect(await ok(s, "add_dimension", { view: "front", type: "arc_length", circle: [4, 0, 6] })).toMatch(/Added an arc length dimension on Front: 6\.28/);

    // An ordinate run from the bottom left corner: 0, 40 and 37 across.
    const ord = await ok(s, "add_dimension", { view: "front", type: "ordinate", datum: [0, 0, 0], points: [[40, 0, 0], [37, 0, 10], [0, 0, 6]] });
    expect(ord).toMatch(/Added 3 ordinate dimensions on Front: 0, 40, 37\./);
    expect(ord).toMatch(/1 point was skipped/);
    expect(drawing(s).dimensions!.filter((d) => d.type === "ordinate").every((d) => d.axis === "h")).toBe(true);

    const described = await ok(s, "describe_drawing", {});
    expect(described).toMatch(/- D1 Front: 135° \(angle between \(40, 0\)–\(40, 7\) and \(37, 10\)–\(40, 7\)\)/);
    expect(described).toMatch(/- D2 Front: 225° \(angle[^\n]*, outside\)/);
    expect(described).toMatch(/- D3 Front: 3 × 45° \(chamfer/);
    expect(described).toMatch(/- D4 Front: 6\.28 \(arc length/);
    expect(described).toMatch(/- D5 Front: 0 \(ordinate across/);

    // Delete two by number; the rest close up.
    expect(await ok(s, "delete_drawing_item", { dimensions: ["D2", "d4"] })).toMatch(/Deleted 2 dimensions from Drawing 1/);
    expect(drawing(s).dimensions!.map((d) => d.type)).toEqual(["angle", "chamfer", "ordinate", "ordinate", "ordinate"]);
    expect(await fails(s, "delete_drawing_item", { dimensions: ["D9"] })).toMatch(/"D9" isn't one of this sheet's dimensions \(D1 to D5\)/);
    expect(await fails(s, "delete_drawing_item", {})).toMatch(/Give "dimensions"/);
  });

  it("adds notes and symbols with leaders, and deletes one", async () => {
    const { s, folder } = newSession();
    await buildParts(s);
    await ok(s, "create_drawing", { part: "Block", views: ["front", "top"] });
    expect(await ok(s, "add_drawing_note", { text: "ALL EDGES DEBURRED\nPLA, 20% INFILL", at: [20, 60] })).toMatch(/Added a note \(N1\) at \(20, 60\)/);
    const datum = await ok(s, "add_drawing_note", { symbol: { kind: "datum" }, pointing_at: { view: "front", point: [20, 0, 0] } });
    expect(datum).toMatch(/Added datum A \(N2\) at \([\d.]+, [\d.]+\), its leader pointing to \([\d.]+, [\d.]+\)/);
    expect(await ok(s, "add_drawing_note", { symbol: { kind: "gdt", characteristic: "perpendicularity", tolerance: 0.05, datums: ["A"] }, pointing_at: { view: "front", point: [40, 0, 3] } })).toMatch(/geometric tolerance frame \(N3\)/);
    expect(await ok(s, "add_drawing_note", { symbol: { kind: "finish", ra: 1.6, machined: true }, pointing_at: { view: "top", point: [20, 10, 10] } })).toMatch(/surface finish mark \(N4\)/);
    const notes = drawing(s).notes!;
    expect(notes.map((n) => n.symbol?.kind ?? "text")).toEqual(["text", "datum", "fcf", "finish"]);
    expect(notes[2].symbol).toEqual({ kind: "fcf", characteristic: "perpendicularity", tolerance: "0.05", datums: ["A"] });
    expect(notes[1].leader).toBeDefined();
    // The leader lands on the front view's bottom edge: inside the view's box on the sheet.
    const described = await ok(s, "describe_drawing", {});
    expect(described).toMatch(/Notes and symbols[^\n]*:\n- N1: note "ALL EDGES DEBURRED \/ PLA, 20% INFILL" at \(20, 60\)\n- N2: Datum A at/);
    expect(described).toMatch(/- N3: Perpendicularity 0\.05 to A/);
    expect(described).toMatch(/- N4: Surface finish Ra 1\.6/);

    // Plain-English refusals.
    expect(await fails(s, "add_drawing_note", { symbol: { kind: "gdt", characteristic: "flatness", tolerance: 0.1, datums: ["A"] } })).toMatch(/flatness is a form tolerance/);
    expect(await fails(s, "add_drawing_note", { symbol: { kind: "datum", letter: "A" } })).toMatch(/already a datum A/);
    expect(await fails(s, "add_drawing_note", { symbol: { kind: "weld" } })).toMatch(/symbol\.kind must be one of "datum", "gdt", "finish"/);
    expect(await fails(s, "add_drawing_note", { text: "x", at: [500, 10] })).toMatch(/off the paper: A4 is 297 × 210 mm/);
    expect(await fails(s, "add_drawing_note", { text: "x", pointing_at: { view: "front", point: [500, 0, 0] } })).toMatch(/outside Front/);
    expect(await fails(s, "add_drawing_note", { text: "x", symbol: { kind: "datum" } })).toMatch(/either "text"/);

    expect(await ok(s, "delete_drawing_item", { notes: ["N1"] })).toMatch(/Deleted 1 note/);
    expect(drawing(s).notes!.map((n) => n.symbol?.kind)).toEqual(["datum", "fcf", "finish"]);
    // On the PDF: the datum letter and the tolerance.
    await ok(s, "export_drawing", { format: "pdf", filename: "notes" });
    const pdf = readFileSync(join(folder, "notes.pdf"), "latin1");
    expect(pdf).toMatch(/\(A\) Tj/);
    expect(pdf).toMatch(/\(0\.05\) Tj/);
  });

  it("adds, changes and removes sheets", async () => {
    const { s, folder } = newSession();
    await buildParts(s);
    await ok(s, "create_drawing", { part: "Block", title: { title: "Block", part_number: "B-1" } });
    // A sheet of another part: the usual views, and a title block of its own.
    const added = await ok(s, "add_sheet", { part: "Cube" });
    expect(added).toMatch(/Added sheet 2 of Cube\. Its title and part number are its own: fill them in\./);
    expect(added).toMatch(/part "Cube", sheet 2 of 2/);
    await ok(s, "edit_drawing", { sheet: 2, title: { part_number: "C-1" } });
    const d = drawing(s);
    const second = pageOf(d, pageIds(d)[1]);
    expect(second.title.partNumber).toBe("C-1");
    expect(d.title.partNumber).toBe("B-1");
    // An empty sheet of the drawing's own part.
    expect(await ok(s, "add_sheet", {})).toMatch(/Added sheet 3\. Tick the views it shows\./);
    expect(pageOf(drawing(s), pageIds(drawing(s))[2]).views).toHaveLength(0);
    await ok(s, "edit_drawing", { sheet: 3, views: ["front", "right"] });
    expect(await ok(s, "describe_drawing", { sheet: 3 })).toMatch(/part "Block", sheet 3 of 3[^\n]*\nViews[^\n]*\n- Front/);
    // Sheet 3 shows the cube instead; the others keep theirs.
    expect(await ok(s, "edit_drawing", { sheet: 3, part: "Cube" })).toMatch(/part "Cube", sheet 3 of 3/);
    expect(await ok(s, "describe_drawing", { sheet: 1 })).toMatch(/part "Block", sheet 1 of 3/);
    expect(await fails(s, "edit_drawing", { sheet: 3, part: "Nope" })).toMatch(/no part "Nope"/);

    await ok(s, "export_drawing", { format: "pdf", filename: "sheets" });
    const pdf = readFileSync(join(folder, "sheets.pdf"), "latin1");
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(3);

    expect(await ok(s, "remove_sheet", { sheet: 2 })).toMatch(/Removed sheet 2 of Drawing 1; it has 2 sheets now\.\n- Sheet 1: part "Block", 4 views\n- Sheet 2: part "Cube", 2 views/);
    // Removing sheet 1 makes the next one the first, still showing what it did.
    await ok(s, "remove_sheet", { sheet: 1 });
    expect(await ok(s, "describe_drawing", {})).toMatch(/part "Cube"\. Paper A4/);
    expect(await fails(s, "remove_sheet", { sheet: 1 })).toMatch(/only one sheet/);
    expect(await fails(s, "remove_sheet", { sheet: 4 })).toMatch(/sheet must be a sheet number from 1 to 1/);
    // One undo step each.
    await ok(s, "undo");
    expect(pageIds(drawing(s))).toHaveLength(2);
  });
});
