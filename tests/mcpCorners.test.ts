/**
 * Claude naming corners (vertices) of parts: list_edges "corners", a three-point plane on {"vertex": [x, y, z]}
 * points that follows the box, and an extrude "up_to_vertex". Real OpenCascade engine.
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
import { framesOf } from "../src/sketch/planeFeature";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-corners-"));
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

describe("corners named by Claude", () => {
  it("lists corners, makes a three-point plane on them that follows the box, and extrudes up to one", async () => {
    const s = newSession();
    await ok(s, "set_variables", { variables: [{ name: "w", value: 40 }, { name: "h", value: 10 }] });
    await ok(s, "add_feature", { type: "box", width: "w", depth: 20, height: "h", name: "Block" });
    const listed = await ok(s, "list_edges", { part: "Part 1", corners: true });
    expect(listed).toMatch(/Part 1 has 8 corners/);
    expect(listed).toMatch(/\(40, 20, 10\)/);
    await ok(s, "add_feature", { type: "plane", name: "End", plane_type: "three_point", points: [{ vertex: [40, 0, 10], part: "Part 1" }, { vertex: [40, 20, 10], part: "Part 1" }, { vertex: [40, 0, 0], part: "Part 1" }] });
    const plane = s.doc.features.find((f) => f.name === "End")!;
    const origin = () => framesOf(s.doc.features, undefined, s.build().followed).get(plane.id)!.origin;
    expect(Math.abs(origin()[0] - 40)).toBeLessThan(1e-6);
    await ok(s, "set_variables", { variables: [{ name: "w", value: 60 }] });
    expect(Math.abs(origin()[0] - 60)).toBeLessThan(1e-6);
    // Not a corner: the nearest are named.
    expect(await fails(s, "add_feature", { type: "plane", plane_type: "point", point: { vertex: [30, 0, 10], part: "Part 1" } })).toMatch(/no corner at/);
    // A pad beside it, up to the box's top corner.
    await ok(s, "add_sketch", { name: "Pad", plane: "Top", shapes: [{ type: "rectangle", corner: [80, 0], width: 5, height: 5 }] });
    await ok(s, "add_feature", { type: "extrude", sketch: "Pad", end: "up_to_vertex", up_to_vertex: [60, 20, 10], up_to_part: "Part 1", name: "Up" });
    const vol = () => s.build().parts.find((p) => s.doc.features.find((f) => f.name === "Up")!.id === p.id)!.volume!;
    expect(Math.abs(vol() - 250)).toBeLessThan(1e-3);
    await ok(s, "set_variables", { variables: [{ name: "h", value: 4 }] });
    expect(Math.abs(vol() - 100)).toBeLessThan(1e-3);
  });

  it("fastens a copy's corner to another's in an assembly, pointing the same way", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 40, depth: 20, height: 10, name: "Block" });
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10, x: 100, name: "Cube", operation: "new" });
    await ok(s, "create_assembly", { name: "A" });
    await ok(s, "insert_into_assembly", { part: "Part 1" });
    await ok(s, "insert_into_assembly", { part: "Part 2" });
    const names = s.doc.assemblies![0].instances.map((i) => i.name);
    const mated = await ok(s, "add_mate", { type: "fasten", first: { instance: names[0], vertex: [40, 20, 10] }, second: { instance: names[1], vertex: [s.doc.assemblies![0].instances[1].placement.position[0] + 100, 0, 0] } });
    expect(mated).toMatch(/corner/);
    const asm = s.doc.assemblies![0];
    expect(asm.mates![0].flip).toBe(true);
    expect(asm.mates![0].b.vertex?.p).toEqual([100, 0, 0]);
    const placed = asm.instances[1].placement;
    [-60, 20, 10].forEach((v, k) => expect(placed.position[k]).toBeCloseTo(v, 5));
    expect(Math.abs(placed.rotation[3])).toBeCloseTo(1, 6);
    // Not a corner: the nearest are named.
    expect(await fails(s, "add_mate", { type: "fasten", first: { instance: names[0], vertex: [20, 20, 10] }, second: { instance: names[1], face: "top" } })).toMatch(/no corner at/);
  });
});
