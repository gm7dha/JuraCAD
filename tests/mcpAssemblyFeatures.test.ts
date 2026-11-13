/**
 * Claude's assembly features (src/mcp/assemblyFeatureTools.ts) with the real
 * engine: a hole drilled through two stacked plates in an assembly cuts both
 * copies there only; a cut of chosen copies; refusals; deleting with its sketch.
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
import { cutMeshesOf, solve } from "../src/mcp/assemblyTools";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-asmfeat-"));
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

/** Two plates (40 × 40 × 5 and 40 × 40 × 4) stacked in an assembly. */
async function plates(s: Session) {
  await ok(s, "new_design", { name: "Plates" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 4, x: 100, operation: "new" });
  const parts = s.build().parts;
  await ok(s, "rename_part", { part: parts[0].name, name: "Lower" });
  await ok(s, "rename_part", { part: parts[1].name, name: "Upper" });
  await ok(s, "create_assembly", { name: "Stack" });
  await ok(s, "insert_into_assembly", { part: "Lower", at: [0, 0, 0] });
  await ok(s, "insert_into_assembly", { part: "Upper", at: [-100, 0, 5] });
}

describe("assembly features for Claude", () => {
  it("drills through both plates in the assembly only", async () => {
    const { s, folder } = newSession();
    await plates(s);
    const said = await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Upper <1>", face: "top" }, points: [[20, 20]], diameter: 6 });
    expect(said).toMatch(/cuts Lower <1>, Upper <1> in this assembly only/);
    const hole = Math.PI * 9;
    expect(said).toContain(`${Math.round((1600 * 5 - hole * 5) * 100) / 100} mm³`);
    const text = await ok(s, "describe_assembly", {});
    expect(text).toMatch(/Assembly features/);
    expect(text).toMatch(/Hole 1 \(hole, from Sketch 1; cuts only Lower <1>, Upper <1>\)/);
    expect(text).toMatch(/Lower \(modified in assembly\) × 1/);
    // Exported STEP has the hole; the Part Studio's parts are unchanged.
    await ok(s, "export_model", { assembly: "Stack", format: "step", filename: "stack" });
    expect(readFileSync(join(folder, "stack.step"), "utf8")).toContain("CYLINDRICAL_SURFACE");
    expect(s.build().parts.map((p) => Math.round(p.volume!))).toEqual([8000, 6400]);
  });

  it("cuts only the parts named, and refuses a cut that reaches nothing", async () => {
    const { s } = newSession();
    await plates(s);
    const said = await ok(s, "add_assembly_feature", { kind: "cut", on: "top", rectangles: [{ corner: [5, 5], size: [10, 10] }], parts: ["Upper <1>"] });
    expect(said).toMatch(/cuts Upper <1> in this assembly only/);
    const miss = await fails(s, "add_assembly_feature", { kind: "hole", on: "top", points: [[500, 500]], diameter: 4 });
    expect(miss).toMatch(/wouldn't cut anything/);
    expect(await fails(s, "add_assembly_feature", { kind: "hole", on: { instance: "Upper <1>", face: "top" }, rectangles: [] })).toMatch(/"points"/);
  });

  it("deletes a sketch with the hole made from it", async () => {
    const { s } = newSession();
    await plates(s);
    await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Upper <1>", face: "top" }, points: [[10, 10]], diameter: 3, through_all: false, depth: 6 });
    expect(await ok(s, "delete_assembly_feature", { feature: "Sketch 1" })).toMatch(/Deleted Sketch 1, Hole 1/);
    expect(s.doc.assemblies![0].features).toBeUndefined();
  });
  it("mates a pin into the hole it drilled (the hole's wall is a face of the cut copy)", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Pin" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 6, height: 20, x: 100, y: 0, z: 0, operation: "new" });
    const parts = s.build().parts;
    await ok(s, "rename_part", { part: parts[0].name, name: "Plate" });
    await ok(s, "rename_part", { part: parts[1].name, name: "Pin" });
    await ok(s, "create_assembly", { name: "Pinned" });
    await ok(s, "insert_into_assembly", { part: "Plate", at: [0, 0, 0] });
    await ok(s, "insert_into_assembly", { part: "Pin", at: [-130, 7, 0] });
    await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Plate <1>", face: "top" }, points: [[20, 12]], diameter: 6 });
    const said = await ok(s, "add_mate", { type: "cylindrical", first: { instance: "Plate <1>", face: { near: [20, 12, 2.5] } }, second: { instance: "Pin <1>", face: { near: [-30, 7, 10] } } });
    expect(said).not.toMatch(/PROBLEM/);
    const text = await ok(s, "describe_assembly", {});
    expect(text).not.toMatch(/doesn't work|can't be found/i);
    // The pin's axis is now the hole's: its part's axis (x = 100) moved to x = 20.
    const pos = s.doc.assemblies![0].instances.find((i) => i.name === "Pin <1>")!.placement.position;
    expect(pos[0] + 100).toBeCloseTo(20, 3);
    expect(pos[1]).toBeCloseTo(12, 3);
  });

  it("refuses a mate that would move the drilled part off its own hole, the same way every time", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Pin" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 6, height: 20, x: 100, y: 0, z: 0, operation: "new" });
    const parts = s.build().parts;
    await ok(s, "rename_part", { part: parts[0].name, name: "Plate" });
    await ok(s, "rename_part", { part: parts[1].name, name: "Pin" });
    await ok(s, "create_assembly", { name: "Pinned" });
    await ok(s, "insert_into_assembly", { part: "Plate", at: [0, 0, 0], fixed: false });
    await ok(s, "insert_into_assembly", { part: "Pin", at: [-70, 70, 0], fixed: true });
    await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Plate <1>", face: "top" }, points: [[20, 12]], diameter: 6 });
    const args = { type: "cylindrical", first: { instance: "Pin <1>", face: { near: [30, 70, 10] } }, second: { instance: "Plate <1>", face: { near: [20, 12, 2.5] } } };
    const said = await fails(s, "add_mate", args);
    expect(said).toMatch(/made by an assembly feature on Plate <1>/);
    expect(await fails(s, "add_mate", args)).toBe(said);
    expect(s.doc.assemblies![0].instances.find((i) => i.name === "Plate <1>")!.placement.position).toEqual([0, 0, 0]);
  });

  it("keeps a pin in the hole shown when the base under the drilled plate is made wider (the plate slides along)", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Slide" });
    await ok(s, "set_variables", { variables: [{ name: "w", value: 40 }] });
    await ok(s, "add_feature", { type: "box", width: "w", depth: 40, height: 5 });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 5, x: 100, operation: "new" });
    await ok(s, "add_feature", { type: "cylinder", diameter: 6, height: 20, x: 200, y: 0, z: 0, operation: "new" });
    const parts = s.build().parts;
    await ok(s, "rename_part", { part: parts[0].name, name: "Base" });
    await ok(s, "rename_part", { part: parts[1].name, name: "Plate" });
    await ok(s, "rename_part", { part: parts[2].name, name: "Pin" });
    await ok(s, "create_assembly", { name: "Slide" });
    await ok(s, "insert_into_assembly", { part: "Base", at: [0, 0, 0] });
    await ok(s, "insert_into_assembly", { part: "Plate", at: [0, 0, 20], fixed: false });
    await ok(s, "insert_into_assembly", { part: "Pin", at: [-250, 0, 0], fixed: false });
    // The plate fastened centred on the base, a hole drilled off its middle, a pin mated into the hole.
    await ok(s, "add_mate", { type: "fasten", first: { instance: "Base <1>", face: "top" }, second: { instance: "Plate <1>", face: "bottom" } });
    await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Plate <1>", face: "top" }, points: [[22, 20]], diameter: 6 });
    await ok(s, "add_mate", { type: "cylindrical", first: { instance: "Plate <1>", face: { near: [22 + 3, 20, 7.5] } }, second: { instance: "Pin <1>", face: { near: [-47, 3, 10] } } });
    const pinAt = () => {
      const asm = s.doc.assemblies![0];
      const solved = solve(s, asm);
      const id = asm.instances.find((i) => i.name === "Pin <1>")!.id;
      const plate = asm.instances.find((i) => i.name === "Plate <1>")!.id;
      const wall = cutMeshesOf(s, asm, s.doc.assemblies!, solved)![plate].faceRefs.find((f) => f.surface === "CYLINDRE")!.center;
      return { pin: solved.placements[id].position[0] + 200, hole: wall[0] + solved.placements[plate].position[0] };
    };
    const before = pinAt();
    expect(before.hole).toBeCloseTo(22, 3);
    expect(before.pin).toBeCloseTo(22, 3);
    // The base 46 wide: the plate slides 3 mm along X; the hole stays where it was drilled, and so does the pin.
    await ok(s, "set_variables", { variables: [{ name: "w", value: 46 }] });
    const after = pinAt();
    expect(after.hole).toBeCloseTo(22, 3);
    expect(after.pin).toBeCloseTo(after.hole, 3);
    expect(await ok(s, "describe_assembly", {})).not.toMatch(/PROBLEM|doesn't work/);
  });

  it("rounds and bevels edges of copies in the assembly only; a mated pin is untouched", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Pin" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 5 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 6, height: 20, x: 100, y: 0, z: 0, operation: "new" });
    const parts = s.build().parts;
    await ok(s, "rename_part", { part: parts[0].name, name: "Plate" });
    await ok(s, "rename_part", { part: parts[1].name, name: "Pin" });
    await ok(s, "create_assembly", { name: "Pinned" });
    await ok(s, "insert_into_assembly", { part: "Plate", at: [0, 0, 0] });
    await ok(s, "insert_into_assembly", { part: "Pin", at: [-130, 7, 0] });
    await ok(s, "add_assembly_feature", { kind: "hole", on: { instance: "Plate <1>", face: "top" }, points: [[20, 12]], diameter: 6 });
    await ok(s, "add_mate", { type: "cylindrical", first: { instance: "Plate <1>", face: { near: [20, 12, 2.5] } }, second: { instance: "Pin <1>", face: { near: [-30, 7, 10] } } });
    const pinAt = () => s.doc.assemblies![0].instances.find((i) => i.name === "Pin <1>")!.placement.position;
    const before = [...pinAt()];
    const r = 2;
    const rounded = await ok(s, "add_assembly_feature", { kind: "fillet", edges: [{ instance: "Plate <1>", edge: "along z" }], radius: r });
    expect(rounded).toMatch(/Made Fillet 1 in Pinned: rounds 4 edges of Plate <1> \(radius 2 mm\) in this assembly only/);
    const hole = Math.PI * 9 * 5;
    const corners = 4 * (r * r - (Math.PI * r * r) / 4) * 5;
    expect(rounded).toContain(`Plate <1> ${Math.round((8000 - hole - corners) * 100) / 100} mm³`);
    // The hole's top rim, which only the assembly's hole made: the chamfer needs the hole.
    const bevelled = await ok(s, "add_assembly_feature", { kind: "chamfer", edges: [{ instance: "Plate <1>", edge: { near: [23, 12, 5] } }], distance: 0.5 });
    expect(bevelled).toMatch(/bevels 1 edge of Plate <1>/);
    expect(bevelled).toMatch(/edges made by Hole 1, so deleting that deletes it too/);
    const text = await ok(s, "describe_assembly", {});
    expect(text).toMatch(/Fillet 1 \(fillet, radius 2 mm, on 4 edges of Plate <1>\)/);
    expect(text).toMatch(/Chamfer 1 \(chamfer, distance 0.5 mm, on 1 edge of Plate <1>\)/);
    expect(text).not.toMatch(/PROBLEM|doesn't work/);
    // The pin mated into the hole hasn't moved and isn't changed; the Part Studio's parts are as they were.
    expect(pinAt()).toEqual(before);
    expect(text).toMatch(/Pin × 1/);
    expect(text).not.toMatch(/Pin \(modified in assembly\)/);
    expect(s.build().parts.map((p) => Math.round(p.volume!))).toEqual([8000, Math.round(Math.PI * 9 * 20)]);
    // Refusals: a radius too big, edges of a copy that isn't there, sizes of the other kind.
    expect(await fails(s, "add_assembly_feature", { kind: "fillet", edges: [{ instance: "Plate <1>", edge: "along z" }], radius: 30 })).toMatch(/smaller radius.*Nothing was changed/);
    expect(await fails(s, "add_assembly_feature", { kind: "fillet", edges: [{ instance: "Plate <9>", edge: "along z" }] })).toMatch(/no copy called "Plate <9>"/);
    expect(await fails(s, "add_assembly_feature", { kind: "chamfer", edges: [{ instance: "Plate <1>", edge: "top" }], radius: 1 })).toMatch(/takes "distance"/);
    // Deleting the hole takes the chamfer of its rim with it (and its sketch stays).
    expect(await ok(s, "delete_assembly_feature", { feature: "Hole 1" })).toMatch(/Deleted Hole 1, Chamfer 1/);
    expect(s.doc.assemblies![0].features!.map((f) => f.name)).toEqual(["Sketch 1", "Fillet 1"]);
  });
});
