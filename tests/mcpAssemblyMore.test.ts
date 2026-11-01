/**
 * More of Claude's assembly tools (src/mcp/assemblyExtras.ts), with the real
 * OpenCascade engine: Replicate into matching holes, linear, circular and
 * mirror patterns (across a plane, across a face, and as the same part),
 * groups, mate limits, gear and screw relations, exploded view steps of a part
 * inside a sub-assembly, a Width mate between two parts of one sub-assembly
 * copy, and taking each of them away again.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyPlacement, type Vec3 } from "../src/assembly/math";
import { applyRelations } from "../src/assembly/relations";
import { DesignFolder } from "../src/mcp/files";
import { assemblyInstances } from "../src/mcp/assemblyTools";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";
import type { InstanceInput } from "../src/kernel/protocol";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-asm2-"));
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

/** A 60 × 40 × 10 base with four ⌀6 holes through it, a ⌀6 × 20 pin, and a 10 mm cube. */
async function buildParts(s: Session) {
  await ok(s, "new_design", { name: "Kit" });
  await ok(s, "add_feature", { type: "box", width: 60, depth: 40, height: 10 });
  await ok(s, "add_sketch", { on_face: "top", shapes: [[10, 10], [50, 10], [10, 30], [50, 30]].map((c) => ({ type: "circle", center: c, diameter: 6 })) });
  await ok(s, "add_feature", { type: "extrude", operation: "remove", end: "through_all" });
  await ok(s, "add_feature", { type: "cylinder", diameter: 6, height: 20, x: 0, y: 0, z: 0, operation: "new" });
  await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10, x: 0, y: 0, z: 0, operation: "new" });
  const parts = s.build().parts;
  expect(parts).toHaveLength(3);
  await ok(s, "rename_part", { part: parts[0].name, name: "Base" });
  await ok(s, "rename_part", { part: parts[1].name, name: "Pin" });
  await ok(s, "rename_part", { part: parts[2].name, name: "Cube" });
}

const asmNamed = (s: Session, name: string) => s.doc.assemblies!.find((a) => a.name === name)!;

/** The box round a copy as it's shown (mirror images flipped, exploded view steps applied). */
function shownBox(s: Session, asmName: string, instName: string) {
  const parts = s.buildAll().parts;
  const inst = assemblyInstances(s, asmNamed(s, asmName)).find((i: InstanceInput) => i.name === instName);
  if (!inst) throw new Error(`No ${instName} in ${asmName}`);
  const mesh = parts.find((p) => p.id === inst.partId)!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const v: Vec3 = [inst.mirrored ? -mesh.vertices[i] : mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]];
    const p = applyPlacement({ position: inst.position, rotation: inst.rotation }, v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max, centre: min.map((v, k) => (v + max[k]) / 2) };
}
const near = (a: number[], b: number[], digits = 3) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], digits));

/** The round top edge of the base's hole at (x, y), as list_edges numbers it (it lists a point on the circle, 3 mm along +X). */
async function holeEdge(s: Session, asm: string, x: number, y: number) {
  const edges = await ok(s, "list_edges", { assembly: asm, instance: "Base <1>", along: "round" });
  const e = new RegExp(`(E\\d+): circle through \\(${x + 3}, ${y}, 10\\)`).exec(edges)?.[1];
  if (!e) throw new Error(`No hole edge at (${x}, ${y}):\n${edges}`);
  return e;
}
/** A pin's bottom round edge. */
async function pinBottom(s: Session, asm: string, pin: string) {
  const edges = await ok(s, "list_edges", { assembly: asm, instance: pin, along: "round" });
  const e = /(E\d+): circle[^\n]*, 0\)/.exec(edges)?.[1];
  if (!e) throw new Error(`No bottom edge on ${pin}:\n${edges}`);
  return e;
}

describe("more assembly tools for Claude", () => {
  it("replicates a pin into every matching hole, and takes it away again", async () => {
    const s = newSession();
    await buildParts(s);
    await ok(s, "create_assembly", { name: "Pins" });
    await ok(s, "insert_into_assembly", { part: "Base" });
    await ok(s, "insert_into_assembly", { part: "Pin" });
    await ok(s, "add_mate", { type: "fasten", first: { instance: "Base <1>", edge: await holeEdge(s, "Pins", 10, 10) }, second: { instance: "Pin <1>", edge: await pinBottom(s, "Pins", "Pin <1>") } });
    near(shownBox(s, "Pins", "Pin <1>").centre.slice(0, 2), [10, 10], 1);

    const r = await ok(s, "replicate_part", { instance: "Pin <1>" });
    expect(r).toMatch(/Added Replicate 1: Pin <1> copied into 3 more holes/);
    const asm = asmNamed(s, "Pins");
    expect(asm.instances.filter((i) => i.replicaOf)).toHaveLength(3);
    expect(asm.mates!.filter((m) => m.replicateOf)).toHaveLength(3);
    const centres = ["Pin <2>", "Pin <3>", "Pin <4>"].map((n) => shownBox(s, "Pins", n).centre.slice(0, 2).map((v) => Math.round(v)).join(",")).sort();
    expect(centres).toEqual(["10,30", "50,10", "50,30"]);
    expect(await ok(s, "describe_assembly", { assembly: "Pins" })).toMatch(/Replicates:\n- Replicate 1: Pin <1> \(held by Fasten 1\) copied into every matching hole: Pin <2>, Pin <3>, Pin <4>/);

    // Plain-English refusals.
    await ok(s, "insert_into_assembly", { part: "Cube", at: [100, 0, 0] });
    expect(await fails(s, "replicate_part", { instance: "Cube <1>" })).toMatch(/Mate this part into one hole first/);
    // The base is "in" the pin's round edge, but the pin has no other edges like that one.
    expect(await fails(s, "replicate_part", { instance: "Base <1>" })).toMatch(/No other holes like the one Fasten 1 holds Base <1> in were found.*Nothing was changed/);
    expect(await fails(s, "replicate_part", { instance: "Pin <2>" })).toMatch(/That's a copy/);

    expect(await ok(s, "remove_assembly_item", { assembly: "Pins", replicate: "Replicate 1" })).toMatch(/Removed Replicate 1 and its 3 copies/);
    expect(asmNamed(s, "Pins").instances).toHaveLength(3);
    expect(asmNamed(s, "Pins").replicates).toBeUndefined();
  });

  it("patterns copies in a line and round an axis, and mirrors them across a plane and a face", async () => {
    const s = newSession();
    await buildParts(s);
    await ok(s, "create_assembly", { name: "Rows" });
    await ok(s, "insert_into_assembly", { part: "Base" });
    await ok(s, "insert_into_assembly", { part: "Cube", at: [0, 50, 0] });
    near(shownBox(s, "Rows", "Cube <1>").min, [0, 50, 0]);

    // Linear: three in a row, 15 mm apart along +X.
    const lin = await ok(s, "add_assembly_pattern", { kind: "linear", instances: ["Cube <1>"], count: 3, spacing: 15, direction: "x" });
    expect(lin).toMatch(/Added Pattern 1 to Rows: 2 copies of Cube <1>/);
    near(shownBox(s, "Rows", "Cube <2>").min, [15, 50, 0]);
    near(shownBox(s, "Rows", "Cube <3>").min, [30, 50, 0]);
    // The copies follow their original.
    await ok(s, "place_instance", { instance: "Cube <1>", at: [0, 60, 0] });
    near(shownBox(s, "Rows", "Cube <3>").min, [30, 60, 0]);

    // Circular: four round Z through the origin (a quarter turn each).
    await ok(s, "insert_into_assembly", { part: "Cube", at: [100, 0, 0] });
    await ok(s, "add_assembly_pattern", { kind: "circular", instances: ["Cube <4>"], count: 4, axis: "z" });
    near(shownBox(s, "Rows", "Cube <5>").min, [-10, 100, 0]);
    near(shownBox(s, "Rows", "Cube <6>").min, [-110, -10, 0]);
    near(shownBox(s, "Rows", "Cube <7>").min, [0, -110, 0]);

    // Mirror across the Right plane moved 100 mm along X: a mirror-image copy at x = 200 − x.
    await ok(s, "insert_into_assembly", { part: "Cube", at: [0, -50, 0] });
    const mirror = await ok(s, "add_assembly_pattern", { kind: "mirror", instances: ["Cube <8>"], plane: "Right", offset: 100 });
    expect(mirror).toMatch(/Added Mirror 1 to Rows: 1 copy of Cube <8>:\n- Cube <9> \(mirror image\)/);
    near(shownBox(s, "Rows", "Cube <9>").min, [190, -50, 0]);

    // Mirror across the base's right face (x = 60), showing the cube as itself (it's symmetric).
    await ok(s, "insert_into_assembly", { part: "Cube", at: [40, 0, 20] });
    const face = await ok(s, "add_assembly_pattern", { kind: "mirror", instances: ["Cube <10>"], face: { instance: "Base <1>", face: "right" }, same_part: true, name: "Across the base" });
    expect(face).toMatch(/Added Across the base/);
    const copy = asmNamed(s, "Rows").instances.find((i) => i.name === "Cube <11>")!;
    expect(copy.mirrored).toBeUndefined();
    near(shownBox(s, "Rows", "Cube <11>").min, [70, 0, 20]);
    expect(asmNamed(s, "Rows").patterns!.find((p) => p.name === "Across the base")!.plane!.instanceId).toBe(asmNamed(s, "Rows").instances[0].id);

    const described = await ok(s, "describe_assembly", { assembly: "Rows" });
    expect(described).toMatch(/Patterns:\n- Pattern 1: linear, 3 in a row along \+X, 15 mm apart; of Cube <1>; copies Cube <2>, Cube <3>/);
    expect(described).toMatch(/- Mirror 1: mirror across the plane square to X through \(100, 0, 0\); of Cube <8>; copies Cube <9>/);
    expect(described).toMatch(/- Across the base: mirror across a face of Base <1>, symmetric parts shown as themselves/);

    // Plain-English refusals, nothing changed.
    const before = s.doc;
    expect(await fails(s, "add_assembly_pattern", { kind: "linear", instances: ["Cube <2>"], count: 2, spacing: 5 })).toMatch(/Cube <2> is a copy made by Pattern 1\. Pattern its original instead/);
    expect(await fails(s, "add_assembly_pattern", { kind: "linear", instances: ["Cube <1>"], count: 1, spacing: 5 })).toMatch(/count must be at least 2/);
    expect(await fails(s, "add_assembly_pattern", { kind: "mirror", instances: ["Cube <1>"], face: { instance: "Pin <1>", face: "top" } })).toMatch(/no copy called "Pin <1>"/);
    expect(await fails(s, "add_assembly_pattern", { kind: "circular", instances: ["Cube <1>"], count: 3, spacing: 5 })).toMatch(/"spacing" doesn't go with a circular pattern/);
    expect(s.doc).toBe(before);

    await ok(s, "remove_assembly_item", { assembly: "Rows", pattern: "Pattern 1" });
    expect(asmNamed(s, "Rows").instances.some((i) => i.name === "Cube <3>")).toBe(false);
  });

  it("groups parts, limits and relates mates, and drives a hinge with edit_mate", async () => {
    const s = newSession();
    await buildParts(s);
    await ok(s, "create_assembly", { name: "Gears" });
    await ok(s, "insert_into_assembly", { part: "Base" });
    await ok(s, "insert_into_assembly", { part: "Pin", count: 2 });
    await ok(s, "add_mate", { type: "hinge", first: { instance: "Base <1>", edge: await holeEdge(s, "Gears", 10, 10) }, second: { instance: "Pin <1>", edge: await pinBottom(s, "Gears", "Pin <1>") } });
    await ok(s, "add_mate", { type: "hinge", first: { instance: "Base <1>", edge: await holeEdge(s, "Gears", 50, 10) }, second: { instance: "Pin <2>", edge: await pinBottom(s, "Gears", "Pin <2>") } });

    // Gear: Hinge 2 turns twice as far as Hinge 1, the other way.
    const gear = await ok(s, "add_mate_relation", { kind: "gear", driver: "Hinge 1", driven: "Hinge 2", ratio: 2 });
    expect(gear).toMatch(/Added Gear 1 \(Gear\): Hinge 1 now drives Hinge 2 \(ratio 2×\)/);
    const quat = (name: string) => asmNamed(s, "Gears").instances.find((i) => i.name === name)!.placement.rotation;
    const turned = (q0: number[], q1: number[]) => (2 * Math.acos(Math.min(1, Math.abs(q0.reduce((t, v, k) => t + v * q1[k], 0)))) * 180) / Math.PI;
    const [pin1, pin2] = [quat("Pin <1>"), quat("Pin <2>")];
    await ok(s, "edit_mate", { mate: "Hinge 1", values: { angle: 30 } });
    // The solve turns the pins: Pin <1> by 30°, Pin <2> by 60° (kept where the mates put them, as the app does).
    expect(turned(pin1, quat("Pin <1>"))).toBeCloseTo(30, 3);
    expect(turned(pin2, quat("Pin <2>"))).toBeCloseTo(60, 3);
    const related = applyRelations(asmNamed(s, "Gears")).assembly.mates!;
    expect(related.find((m) => m.name === "Hinge 2")!.values.angle).toBe("-60");
    expect(await ok(s, "describe_assembly", { assembly: "Gears" })).toMatch(/Mate relations:\n- Gear 1 \[Gear\]: Hinge 1 drives Hinge 2, ratio 2×/);
    // A screw needs a slider to drive.
    expect(await fails(s, "add_mate_relation", { kind: "screw", driver: "Hinge 1", driven: "Hinge 2", ratio: 1.5 })).toMatch(/Hinge 2 is a Hinge mate and doesn't slide/);
    expect(await fails(s, "add_mate_relation", { kind: "gear", driver: "Hinge 2", driven: "Hinge 2" })).toMatch(/same mate/);

    // Limits: Hinge 1 may turn −10° to 10°; 30° is then held at 10°.
    const limited = await ok(s, "edit_mate", { mate: "Hinge 1", limits: { angle: { min: -10, max: 10 } } });
    expect(limited).toMatch(/angle 30 is outside its limits, so it's held at 10/);
    expect(asmNamed(s, "Gears").mates![0].limits).toEqual({ angle: { min: "-10", max: "10" } });
    expect(applyRelations(asmNamed(s, "Gears")).assembly.mates!.find((m) => m.name === "Hinge 2")!.values.angle).toBe("-20");
    expect(await ok(s, "describe_assembly", { assembly: "Gears" })).toMatch(/Hinge 1 \[Hinge\][^\n]*; limits: angle -10 to 10/);
    expect(await fails(s, "edit_mate", { mate: "Hinge 1", limits: { angle: { min: 20, max: 10 } } })).toMatch(/lowest limit is more than the highest/);
    expect(await fails(s, "edit_mate", { mate: "Hinge 1", limits: { gap: { max: 1 } } })).toMatch(/"gap" isn't a setting here/);
    await ok(s, "edit_mate", { mate: "Hinge 1", limits: { angle: null } });
    expect(asmNamed(s, "Gears").mates![0].limits).toBeUndefined();

    // Switching a mate off: it holds nothing.
    expect(await ok(s, "edit_mate", { mate: "Hinge 2", suppressed: true })).toMatch(/switched off/);
    expect(asmNamed(s, "Gears").mates![1].suppressed).toBe(true);
    await ok(s, "remove_assembly_item", { assembly: "Gears", relation: "Gear 1" });
    expect(asmNamed(s, "Gears").relations).toBeUndefined();

    // Groups: two cubes locked together; mating one carries the other along.
    await ok(s, "create_assembly", { name: "Grouped" });
    await ok(s, "insert_into_assembly", { assembly: "Grouped", part: "Base" });
    await ok(s, "insert_into_assembly", { assembly: "Grouped", part: "Cube", at: [100, 0, 0] });
    await ok(s, "insert_into_assembly", { assembly: "Grouped", part: "Cube", at: [100, 20, 0] });
    expect(await ok(s, "group_parts", { assembly: "Grouped", instances: ["Cube <1>", "Cube <2>"] })).toMatch(/Made Group 1: Cube <1>, Cube <2> now move as one/);
    expect(await fails(s, "group_parts", { assembly: "Grouped", instances: ["Cube <1>", "Base <1>"] })).toMatch(/Cube <1> is already in Group 1/);
    await ok(s, "add_mate", { assembly: "Grouped", type: "fasten", first: { instance: "Base <1>", face: "top" }, second: { instance: "Cube <1>", face: "bottom" } });
    const c1 = shownBox(s, "Grouped", "Cube <1>");
    const c2 = shownBox(s, "Grouped", "Cube <2>");
    near(c1.min.slice(2), [10]);
    // Cube <2> is still 20 mm along Y from Cube <1>, at the same height.
    near([c2.min[0] - c1.min[0], c2.min[1] - c1.min[1], c2.min[2] - c1.min[2]], [0, 20, 0]);
    expect(await ok(s, "remove_assembly_item", { assembly: "Grouped", group: "Group 1" })).toMatch(/Removed Group 1/);
    expect(asmNamed(s, "Grouped").groups).toBeUndefined();
  });

  it("explodes a part inside a sub-assembly, and holds a Width mate between two parts of one copy", async () => {
    const s = newSession();
    await buildParts(s);
    // A slot made by two cubes 10 mm apart, as a sub-assembly.
    await ok(s, "create_assembly", { name: "Slot" });
    await ok(s, "insert_into_assembly", { assembly: "Slot", part: "Cube", at: [0, 0, 0] });
    await ok(s, "insert_into_assembly", { assembly: "Slot", part: "Cube", at: [20, 0, 0], fixed: true });
    await ok(s, "create_assembly", { name: "Top" });
    await ok(s, "insert_into_assembly", { assembly: "Top", sub_assembly: "Slot" });
    await ok(s, "insert_into_assembly", { assembly: "Top", part: "Cube", at: [100, 0, 0] });
    const width = await ok(s, "add_mate", {
      assembly: "Top",
      type: "width",
      first: { instance: "Slot <1> / Cube <1>", face: "right", instance2: "Slot <1> / Cube <2>", face2: "left" },
      second: { instance: "Cube <1>", face: "left", face2: "right" },
    });
    expect(width).toMatch(/Added Width 1 \(Width\) between Slot <1> \/ Cube <1> \(face right and Slot <1> \/ Cube <2>'s left\) and Cube <1>/);
    const mate = asmNamed(s, "Top").mates![0];
    expect(mate.a.path).toHaveLength(1);
    expect(mate.a.path2).toHaveLength(1);
    expect(mate.a.path2![0]).not.toBe(mate.a.path![0]);
    // The tab sits centred in the slot: x from 10 to 20.
    const tab = shownBox(s, "Top", "Cube <1>");
    expect(tab.min[0]).toBeCloseTo(10, 3);
    expect(tab.max[0]).toBeCloseTo(20, 3);
    expect(await fails(s, "add_mate", { assembly: "Top", type: "width", first: { instance: "Slot <1> / Cube <1>", face: "right", instance2: "Cube <1>", face2: "left" }, second: { instance: "Cube <1>", face: "left", face2: "right" } })).toMatch(/only inside the same sub-assembly copy/);
    expect(await fails(s, "add_mate", { assembly: "Top", type: "fasten", first: { instance: "Slot <1> / Cube <1>", face: "top", instance2: "Slot <1> / Cube <2>" }, second: { instance: "Cube <1>", face: "bottom" } })).toMatch(/instance2 is only for Width mates/);

    // Exploded view steps: the part inside the sub-assembly on its own, then the tab.
    const zBefore = shownBox(s, "Top", "Slot <1> / Cube <2>").min[2];
    const step = await ok(s, "add_explode_step", { assembly: "Top", parts: ["Slot <1> / Cube <2>"], direction: "z", distance: 25 });
    expect(step).toMatch(/Added step 1 to Top's exploded view: Slot <1> \/ Cube <2> moves 25 mm along \+Z/);
    expect(asmNamed(s, "Top").explodeSteps![0].parts).toHaveLength(1);
    expect(shownBox(s, "Top", "Slot <1> / Cube <2>").min[2]).toBeCloseTo(zBefore + 25, 3);
    // Only the part inside moved; the other part of the copy stays.
    expect(shownBox(s, "Top", "Slot <1> / Cube <1>").min[2]).toBeCloseTo(0, 3);
    await ok(s, "add_explode_step", { assembly: "Top", parts: ["Cube <1>"], direction: "-y", distance: "10 + 5" });
    expect(shownBox(s, "Top", "Cube <1>").min[1]).toBeCloseTo(-15, 3);
    expect(await ok(s, "describe_assembly", { assembly: "Top" })).toMatch(/Exploded view steps[^\n]*:\n- Step 1: Slot <1> \/ Cube <2> moved 25 mm along \+Z\n- Step 2: Cube <1> moved 10 \+ 5 mm along −Y/);
    // Mates and exports keep the real places: the step only moves the picture.
    expect(asmNamed(s, "Top").instances.find((i) => i.name === "Cube <1>")!.placement.position[1]).toBeCloseTo(0, 3);
    expect(await fails(s, "add_explode_step", { assembly: "Top", parts: ["Slot <1> / Nope"], direction: "z", distance: 5 })).toMatch(/no "Slot <1> \/ Nope".*parts inside sub-assemblies: "Slot <1> \/ Cube <1>"/s);
    expect(await fails(s, "add_explode_step", { assembly: "Top", parts: ["Cube <1>"], direction: "up", distance: 5 })).toMatch(/direction must be a direction/);
    await ok(s, "remove_assembly_item", { assembly: "Top", explode_step: 1 });
    expect(asmNamed(s, "Top").explodeSteps).toHaveLength(1);
    expect(await fails(s, "remove_assembly_item", { assembly: "Top", explode_step: 5 })).toMatch(/from 1 to 1/);
    expect(await fails(s, "remove_assembly_item", { assembly: "Top" })).toMatch(/Give one of "pattern"/);
  });
});
