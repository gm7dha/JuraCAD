/**
 * Claude's assembly and drawing tools (src/mcp/assemblyTools.ts,
 * drawingTools.ts), run as plain functions with the real OpenCascade engine:
 * a lid fastened onto a box with a hole, checked for clashes, exploded,
 * pictured and exported; then drawings of the part and of the assembly,
 * dimensioned and saved as PDF, SVG and DXF.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyPlacement } from "../src/assembly/math";
import { instancesForKernel } from "../src/assembly/placed";
import { solveWithParts } from "../src/assembly/mates";
import { readDocumentFile } from "../src/model/fileFormat";
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

/** Where an assembly's copy sits: the box round its part's corners as placed. */
function placedBounds(s: Session, assemblyName: string, instanceName: string) {
  const asm = s.doc.assemblies!.find((a) => a.name === assemblyName)!;
  const parts = s.buildAll().parts;
  const solved = solveWithParts(asm, parts, { assemblies: s.doc.assemblies });
  const inst = instancesForKernel(asm, parts, s.doc.assemblies, solved).find((i) => i.name === instanceName)!;
  const mesh = parts.find((p) => p.id === inst.partId)!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const p = applyPlacement({ position: inst.position, rotation: inst.rotation }, [mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

const near = (a: number[], b: number[]) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], 4));

describe("assemblies made by Claude", () => {
  it("fastens a lid onto a box, checks it, explodes it, draws a picture and exports it", async () => {
    const { s, folder } = newSession();
    await buildParts(s);
    const made = await okText(s, "create_assembly", { name: "Box" });
    expect(made).toMatch(/Parts you can insert: "Base", "Lid"/);
    const ins = await okText(s, "insert_into_assembly", { part: "Base" });
    expect(ins).toMatch(/Base <1>: fixed, at \(0, 0, 0\)/);
    // The second copy goes just beside the first (the lid's own box starts at x = 60, so it moves back).
    expect(await okText(s, "insert_into_assembly", { part: "lid" })).toMatch(/Lid <1>: at \(-10, 0, 0\)/);
    near(placedBounds(s, "Box", "Lid <1>").min, [50, 0, 0]);

    // Faces are chosen as the copies sit in the assembly.
    expect(await okText(s, "list_faces", { assembly: "Box", instance: "Lid <1>" })).toMatch(/facing −Z \(bottom\), centre \(70, 20, 0\)/);

    const mated = await okText(s, "add_mate", { type: "fasten", first: { instance: "Base <1>", face: "top" }, second: { instance: "Lid <1>", face: "bottom" } });
    expect(mated).toMatch(/Added Fasten 1 \(Fasten\) between Base <1> \(face top\) and Lid <1> \(face bottom\)/);
    // The lid now sits exactly on top of the box.
    const lid = placedBounds(s, "Box", "Lid <1>");
    near(lid.min, [0, 0, 10]);
    near(lid.max, [40, 40, 15]);
    // …and stays there when saved and opened again (the place is stored, as the app does).
    const asm = s.doc.assemblies![0];
    expect(asm.mates).toHaveLength(1);
    expect(asm.mates![0].type).toBe("fastened");

    // A gap of 2 mm with a second mate is refused when it fights the first (nothing changes).
    const before = s.doc;
    const refused = await fails(s, "add_mate", { type: "fasten", first: { instance: "Base <1>", face: "top" }, second: { instance: "Lid <1>", face: "bottom" }, values: { gap: 2 } });
    expect(refused).toMatch(/Couldn't add the Fasten mate — .*Nothing was changed/s);
    expect(s.doc).toBe(before);
    // Plain-English input problems.
    expect(await fails(s, "add_mate", { type: "glue", first: { instance: "Base <1>", face: "top" }, second: { instance: "Lid <1>", face: "bottom" } })).toMatch(/type must be one of "fasten"/);
    expect(await fails(s, "add_mate", { type: "fasten", first: { instance: "Base <9>", face: "top" }, second: { instance: "Lid <1>", face: "bottom" } })).toMatch(/no copy called "Base <9>".*Base <1>/s);
    expect(await fails(s, "add_mate", { type: "fasten", first: { instance: "Base <1>", face: "F99" }, second: { instance: "Lid <1>", face: "bottom" } })).toMatch(/faces F1 to F\d+/);
    expect(await fails(s, "add_mate", { type: "fasten", first: { instance: "Lid <1>", face: "top" }, second: { origin: "Top" } })).toMatch(/origin never moves/);

    expect(await okText(s, "describe_design")).toMatch(/Assemblies: "Box" \(2 copies, 1 mates\)/);
    const described = await okText(s, "describe_assembly", {});
    expect(described).toMatch(/Lid <1>: placed by Fasten 1, at \(/);
    expect(described).toMatch(/Parts list:\n1\. Base × 1\n2\. Lid × 1/);

    // Touching isn't a clash.
    expect(await okText(s, "check_assembly", {})).toMatch(/Everything fits: 2 parts, no clashes/);
    // A second base pushed into the first is.
    await ok(s, "insert_into_assembly", { part: "Base", at: [30, 0, 0] });
    const clash = await okText(s, "check_assembly", {});
    expect(clash).toMatch(/Base <1> and Base <2> overlap by/);
    expect(clash).toMatch(/CLASH/);
    await ok(s, "remove_from_assembly", { instances: ["Base <2>"] });
    expect(await okText(s, "check_assembly", { list_touching: true })).toMatch(/Base <1> and Lid <1> touch/);

    // Exploded: only the picture changes.
    await ok(s, "explode_assembly", { spread: 1 });
    expect(s.doc.assemblies![0].explode).toBe(1);
    const pic = await ok(s, "get_views", { assembly: "Box", views: ["iso", "front"] });
    const png = pic.content.find((c) => c.type === "image");
    expect(png && png.type === "image" && Buffer.from(png.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(textOf(pic)).toMatch(/Box \(exploded view\).*Base <1> blue, Lid <1> tan/s);

    // Exported in their real places (STEP: one solid per copy).
    expect(await okText(s, "export_model", { assembly: "Box", format: "step" })).toMatch(/Exported Box \(2 parts, each in its place\)/);
    const step = readFileSync(join(folder, "Box and lid Box.step"), "utf8");
    expect(step).toMatch(/Base <1>/);
    expect(step).toMatch(/Lid <1>/);
    // Its structure kept, as the app's export does: each copy a placed use of its part.
    expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(2);
    await ok(s, "export_model", { assembly: "Box", format: "stl", filename: "box" });
    const stl = readFileSync(join(folder, "box.stl"));
    // Binary STL: 80-byte header, then the triangle count.
    expect(stl.readUInt32LE(80)).toBeGreaterThan(20);

    // The saved file opens with the assembly as made here.
    await ok(s, "save_design", {});
    const back = readDocumentFile(readFileSync(join(folder, "Box and lid.juracad"), "utf8"), "x");
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.doc.assemblies![0].instances.map((i) => i.name)).toEqual(["Base <1>", "Lid <1>"]);
      expect(back.doc.assemblies![0].mates![0].name).toBe("Fasten 1");
    }
    // Undo takes back one assembly step at a time.
    await ok(s, "undo");
    expect(s.doc.assemblies![0].explode).toBeUndefined();
  });

  it("hinges a part on a pin and fixes, moves and switches copies off", async () => {
    const { s } = newSession();
    await buildParts(s);
    await ok(s, "create_assembly", {});
    await ok(s, "insert_into_assembly", { part: "Lid" });
    await ok(s, "insert_into_assembly", { part: "Base", rotate: [0, 0, 0] });
    // Base <1> is free; Lid <1> (first in) is fixed. A hinge on the hole's round top edge to the lid's top face.
    const edges = await okText(s, "list_edges", { assembly: "Assembly 1", instance: "Base <1>", along: "round" });
    const top = /(E\d+): circle through \([\d.-]+, [\d.-]+, 10\)/.exec(edges)?.[1];
    expect(top).toBeDefined();
    const r = await okText(s, "add_mate", { type: "hinge", first: { instance: "Lid <1>", face: "top" }, second: { instance: "Base <1>", edge: top }, flip: true, values: { angle: 90 } });
    expect(r).toMatch(/Added Hinge 1/);
    expect(r).toMatch(/It can still move: angle/);
    expect(s.doc.assemblies![0].mates![0].values.angle).toBe("90");
    // Fixing a copy keeps it where the mate put it; moving a fixed copy moves it.
    await ok(s, "place_instance", { instance: "Base <1>", fixed: true });
    expect(s.doc.assemblies![0].instances[1].fixed).toBe(true);
    await ok(s, "delete_mate", { mate: "Hinge 1" });
    await ok(s, "place_instance", { instance: "Base <1>", at: [100, 0, 0], rotate: [0, 0, 0] });
    near(placedBounds(s, "Assembly 1", "Base <1>").min, [100, 0, 0]);
    await ok(s, "place_instance", { instance: "Base <1>", suppressed: true });
    expect(await okText(s, "describe_assembly", {})).toMatch(/Base <1>: suppressed/);
    expect(await okText(s, "describe_assembly", {})).toMatch(/Parts list:\n1\. Lid × 1$/m);
  });
});

describe("drawings made by Claude", () => {
  it("draws the part, dimensions it, adds a section and a detail, and saves a PDF", async () => {
    const { s, folder } = newSession();
    await buildParts(s);
    const made = await okText(s, "create_drawing", { part: "Base", title: { title: "Base plate", material: "PLA", drawn_by: "Claude" } });
    expect(made).toMatch(/Made Drawing 1\./);
    expect(made).toMatch(/part "Base"\. Paper A4, scale \d+:\d+ \(chosen to fit\)/);
    expect(made).toMatch(/- Front — across = X, up = Z; from \(0, 0\) to \(40, 10\) mm/);
    expect(made).toMatch(/- Top — across = X, up = Y; from \(0, 0\) to \(40, 40\) mm; circles: ⌀10 at \(20, 20\)/);
    expect(made).toMatch(/Title block: title "Base plate", material "PLA", drawn by "Claude"/);

    // One dimension between model corners, one on the hole.
    expect(await okText(s, "add_dimension", { view: "front", from: [0, 0, 0], to: [40, 0, 0] })).toMatch(/Added a horizontal dimension on Front: 40\./);
    expect(await okText(s, "add_dimension", { view: "top", circle: [20, 20, 10] })).toMatch(/Added a diameter dimension on Top: Ø10\./);
    expect(await okText(s, "add_dimension", { view: "front", from: [0, 0, 0], to: [0, 0, 10], tolerance: 0.1 })).toMatch(/vertical dimension on Front: 10 ±0\.1/);
    expect(await fails(s, "add_dimension", { view: "front", from: [3, 0, 3], to: [40, 0, 0] })).toMatch(/no corner, end or circle centre at \(3, 3\) on Front.*nearest are: \(0, 0\)/s);
    expect(await fails(s, "add_dimension", { view: "side", from: [0, 0, 0], to: [40, 0, 0] })).toMatch(/no "side" view.*"front", "top", "right"/s);

    const auto = await okText(s, "auto_dimension", {});
    expect(auto).toMatch(/Added \d+ dimensions? to Drawing 1/);
    const dims = s.doc.drawings![0].dimensions!.length;
    expect(dims).toBeGreaterThan(3);

    const section = await okText(s, "add_section_view", { on: "top", direction: "horizontal", through: [20, 20, 0] });
    expect(section).toMatch(/Added Section A/);
    // The cut goes through the hole: the section shows the base split in two (it's a view of its own).
    expect(section).toMatch(/- Section A — across = X, up = Z; from \(0, 0\) to \(40, 10\) mm/);
    expect(await fails(s, "add_section_view", { on: "top", through: [500, 500, 0] })).toMatch(/The cutting line misses the part on the top view.*Nothing was changed/s);
    const detail = await okText(s, "add_detail_view", { on: "front", around: [20, 0, 5], radius: 8, zoom: 3 });
    expect(detail).toMatch(/Added Detail B \(3× the front view/);

    expect(await okText(s, "edit_drawing", { paper: "A3", scale: "2:1", title: { part_number: "BP-1", drawn_by: "" } })).toMatch(/Paper A3, scale 2:1,/);
    expect(s.doc.drawings![0].title).toEqual({ title: "Base plate", material: "PLA", partNumber: "BP-1" });
    expect(await fails(s, "edit_drawing", { scale: "huge" })).toMatch(/scale/);
    expect(await fails(s, "edit_drawing", { views: ["front"] })).toMatch(/section or detail is drawn on a view you'd take away/);

    const look = await ok(s, "view_drawing", {});
    const png = look.content.find((c) => c.type === "image");
    expect(png && png.type === "image" && Buffer.from(png.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(textOf(look)).toMatch(/Dimensions:\n- Front: 40 \(horizontal/);

    expect(await okText(s, "export_drawing", { format: "pdf" })).toMatch(/Saved Drawing 1 to .*Box and lid Drawing 1\.pdf \(PDF, 1 page/);
    const pdf = readFileSync(join(folder, "Box and lid Drawing 1.pdf"), "latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toMatch(/\(Base plate\) Tj/);
    expect(pdf).toMatch(/\(BP-1\) Tj/);
    expect(pdf).toMatch(/\(40\) Tj/);
    await ok(s, "export_drawing", { format: "dxf", filename: "base" });
    expect(readFileSync(join(folder, "base.dxf"), "utf8")).toMatch(/ENTITIES/);
    await ok(s, "export_drawing", { format: "svg", filename: "base" });
    expect(readFileSync(join(folder, "base.svg"), "utf8")).toMatch(/<svg/);
    expect(await fails(s, "export_drawing", { format: "svg", filename: "base" })).toMatch(/already a file called "base\.svg"/);
    // Nothing outside the chosen folder.
    expect(await fails(s, "export_drawing", { format: "pdf", filename: "../outside" })).toMatch(/isn't a plain file name/);
    expect(await fails(s, "export_drawing", { format: "dxf", filename: "/tmp/outside" })).toMatch(/isn't a plain file name/);
    expect(existsSync(join(folder, "..", "outside.pdf"))).toBe(false);

    // It's an ordinary drawing in the saved file.
    await ok(s, "save_design", {});
    const back = readDocumentFile(readFileSync(join(folder, "Box and lid.juracad"), "utf8"), "x");
    expect(back.ok && back.doc.drawings![0].dimensions!.length).toBe(dims);
  });

  it("draws an assembly with its parts list", async () => {
    const { s, folder } = newSession();
    await buildParts(s);
    await ok(s, "create_assembly", { name: "Box" });
    await ok(s, "insert_into_assembly", { part: "Base" });
    await ok(s, "insert_into_assembly", { part: "Lid" });
    await ok(s, "add_mate", { type: "fasten", first: { instance: "Base <1>", face: "top" }, second: { instance: "Lid <1>", face: "bottom" } });
    const made = await okText(s, "create_drawing", { assembly: "Box", views: ["front", "iso"], exploded: true });
    expect(made).toMatch(/assembly "Box"/);
    expect(made).toMatch(/Parts list on the sheet: 1\. Base × 1; 2\. Lid × 1\./);
    // Exploded: the lid is drawn lifted off the base, so the front view is taller than 15 mm.
    const front = /- Front — across = X, up = Z; from \(([\d.-]+), ([\d.-]+)\) to \(([\d.-]+), ([\d.-]+)\)/.exec(made)!;
    expect(Number(front[4]) - Number(front[2])).toBeGreaterThan(15.5);
    expect(await fails(s, "create_drawing", { assembly: "Nope" })).toMatch(/no assembly "Nope"/);
    await ok(s, "export_drawing", { drawing: "Drawing 1", format: "pdf" });
    const pdf = readFileSync(join(folder, "Box and lid Drawing 1.pdf"), "latin1");
    expect(pdf).toMatch(/\(Lid\) Tj/);
  });
});
