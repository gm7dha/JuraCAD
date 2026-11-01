/**
 * The Claude extension and features using areas of several sketches (real
 * OpenCascade): making them with "more_sketches" (extrude, revolve, sweep),
 * reading them back, changing them, and the ways it can go wrong.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-more-"));
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

describe("features using areas of several sketches, from Claude", () => {
  it("tells Claude about more_sketches and sweeps", () => {
    const add = TOOLS.find((t) => t.name === "add_feature")!;
    expect(add.description).toMatch(/more_sketches \(\[\{"sketch": name, "areas": \[\[x,y\],…\]\}, …\]/);
    expect(add.description).toMatch(/sweep: sketch \(the closed shape/);
    expect((add.inputSchema.properties.type as { enum: string[] }).enum).toContain("sweep");
  });

  it("extrudes areas of two sketches, describes it, and changes or clears the extra sketch", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Two" });
    await ok(s, "add_sketch", { name: "Left", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 10, height: 10 }] });
    await ok(s, "add_sketch", { name: "Right", plane: "Top", shapes: [{ type: "rectangle", corner: [20, 0], width: 10, height: 20 }, { type: "rectangle", corner: [40, 0], width: 5, height: 5 }] });
    const said = await ok(s, "add_feature", { type: "extrude", sketch: "Left", depth: 5, areas: [[5, 5]], more_sketches: [{ sketch: "Right", areas: [[25, 5]] }] });
    expect(said).toMatch(/extrude Left \(with areas of Right too\) 5 mm/);
    const right = s.doc.features[1].id;
    expect(s.doc.features[2].moreAreas).toEqual([{ sketch: right, areas: [[25, 5]] }]);
    expect(volumes(s).sort((a, b) => a - b)).toHaveLength(2);
    exactly(total(s), 100 * 5 + 200 * 5);
    // Both of Right's areas, then none.
    await ok(s, "edit_feature", { feature: "Extrude 1", more_sketches: [{ sketch: "Right", areas: [[25, 5], [42, 2]] }] });
    exactly(total(s), 100 * 5 + 200 * 5 + 25 * 5);
    await ok(s, "edit_feature", { feature: "Extrude 1", more_sketches: null });
    expect(s.doc.features[2].moreAreas).toBeUndefined();
    exactly(total(s), 100 * 5);
    expect(await ok(s, "describe_design")).not.toMatch(/with areas of/);
  });

  it("explains mistakes in more_sketches", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Mistakes" });
    await ok(s, "add_sketch", { name: "A", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 10, height: 10 }] });
    await ok(s, "add_sketch", { name: "B", plane: "Top", shapes: [{ type: "rectangle", corner: [20, 0], width: 10, height: 10 }] });
    const base = { type: "extrude", sketch: "A", depth: 5 };
    expect(await fails(s, "add_feature", { ...base, more_sketches: [{ sketch: "A", areas: [[5, 5]] }] })).toMatch(/A is already the feature's own sketch; choose its areas with "areas" instead/);
    expect(await fails(s, "add_feature", { ...base, more_sketches: [{ sketch: "B", areas: [] }] })).toMatch(/more_sketches\[0\]\.areas is empty/);
    expect(await fails(s, "add_feature", { ...base, more_sketches: [{ sketch: "B", areas: [[25, 5]] }, { sketch: "B", areas: [[21, 1]] }] })).toMatch(/B is listed twice/);
    expect(await fails(s, "add_feature", { ...base, more_sketches: [{ sketch: "B", area: [[25, 5]] }] })).toMatch(/more_sketches\[0\]/);
    expect(await fails(s, "add_feature", { ...base, more_sketches: ["B"] })).toMatch(/more_sketches\[0\] must be \{"sketch"/);
    // A point outside every area of B: the build says so, and nothing is kept.
    expect(await fails(s, "add_feature", { ...base, more_sketches: [{ sketch: "B", areas: [[90, 90]] }] })).toMatch(/B/);
    expect(s.doc.features).toHaveLength(2);
  });

  it("revolves sections from Front and Right round one axis", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Rings" });
    await ok(s, "add_sketch", { name: "Inner", plane: "Front", shapes: [{ type: "rectangle", corner: [10, 0], width: 10, height: 10 }] });
    await ok(s, "add_sketch", { name: "Outer", plane: "Right", shapes: [{ type: "rectangle", corner: [30, 0], width: 10, height: 5 }] });
    await ok(s, "add_sketch", { name: "Flat", plane: "Top", shapes: [{ type: "rectangle", corner: [50, 50], width: 5, height: 5 }] });
    const said = await ok(s, "add_feature", { type: "revolve", sketch: "Inner", axis: "vertical", more_sketches: [{ sketch: "Outer", areas: [[35, 2]] }] });
    expect(said).toMatch(/revolve Inner \(with areas of Outer too, round the same axis\) 360° about the sketch's vertical axis/);
    exactly(total(s), Math.PI * 300 * 10 + Math.PI * 700 * 5);
    // A sketch made after the revolve can't be used.
    await ok(s, "add_sketch", { name: "Later", plane: "Front", shapes: [{ type: "rectangle", corner: [50, 0], width: 5, height: 5 }] });
    expect(await fails(s, "edit_feature", { feature: "Revolve 1", more_sketches: [{ sketch: "Later", areas: [[52, 2]] }] })).toMatch(/Later comes after Revolve 1 in the list/);
    // A sketch on Top doesn't contain the upright axis: refused with the reason, nothing changed.
    expect(await fails(s, "edit_feature", { feature: "Revolve 1", more_sketches: [{ sketch: "Flat", areas: [[52, 52]] }] })).toMatch(/Flat: the axis doesn't lie in its plane/);
    expect(s.doc.features.find((f) => f.name === "Revolve 1")!.moreAreas).toHaveLength(1);
  });

  it("sweeps two shapes along one path, and edits the sweep", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Rods" });
    await ok(s, "add_sketch", { name: "Path", plane: "Top", shapes: [{ type: "line", from: [0, 0], to: [0, 50] }] });
    await ok(s, "add_sketch", { name: "Small", plane: "Front", shapes: [{ type: "circle", center: [-10, 0], diameter: 4 }] });
    await ok(s, "add_sketch", { name: "Big", plane: "Front", shapes: [{ type: "circle", center: [10, 0], diameter: 6 }] });
    expect(await fails(s, "add_feature", { type: "sweep", sketch: "Small" })).toMatch(/A sweep needs "sketch" .* and "path"/);
    expect(await fails(s, "add_feature", { type: "sweep", sketch: "Small", path: "Small" })).toMatch(/must be different sketches/);
    expect(await fails(s, "add_feature", { type: "sweep", sketch: "Small", path: "Path", more_sketches: [{ sketch: "Path", areas: [[0, 0]] }] })).toMatch(/Path is the path, so it can't also be a shape swept along it/);
    const said = await ok(s, "add_feature", { type: "sweep", sketch: "Small", path: "Path", more_sketches: [{ sketch: "Big", areas: [[10, 0]] }] });
    expect(said).toMatch(/sweep Small \(with areas of Big too\) along Path, new part/);
    const v = volumes(s).sort((a, b) => a - b);
    exactly(v[0], Math.PI * 4 * 50);
    exactly(v[1], Math.PI * 9 * 50);
    expect(await fails(s, "edit_feature", { feature: "Sweep 1", keep_orientation: true, twist: 10 })).toMatch(/"twist" isn't used with "keep_orientation"/);
    expect(await ok(s, "edit_feature", { feature: "Sweep 1", keep_orientation: true })).toMatch(/keeping its orientation/);
    // Choosing another shape drops the old shape's extra sketches (they were picked to go with it).
    await ok(s, "edit_feature", { feature: "Sweep 1", sketch: "Big" });
    expect(s.doc.features.find((f) => f.name === "Sweep 1")!.moreAreas).toBeUndefined();
    exactly(total(s), Math.PI * 9 * 50);
  });
});
