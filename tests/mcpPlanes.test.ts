/**
 * Claude's newer Plane types and mate connectors (add_feature "plane" and
 * "mate_connector"), with the real OpenCascade engine: they follow the part
 * when a variable changes, a sketch goes on them, describe_design lists them,
 * and an assembly mate can use a part's own connector.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-planes-"));
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
const r = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000 + 0);

describe("planes and mate connectors made by Claude", () => {
  it("a point-normal plane on a corner follows the box; a sketch on it goes with it", async () => {
    const s = newSession();
    await ok(s, "set_variables", { variables: [{ name: "w", value: 40 }] });
    await ok(s, "add_feature", { type: "box", width: "w", depth: 20, height: 10, name: "Block" });
    // The edge along X at the front top: list_edges numbers it; pick it by a point near its middle instead.
    await ok(s, "add_feature", { type: "plane", name: "End plane", plane_type: "point_normal", point: { corner: { near: [20, 0, 10] }, end: "end" }, line: "x" });
    const plane = s.doc.features.find((f) => f.name === "End plane")!;
    expect(r(framesOf(s.doc.features, undefined, s.build().followed).get(plane.id)!.origin)).toEqual([40, 0, 10]);
    await ok(s, "add_sketch", { name: "On end", plane: "End plane", shapes: [{ type: "circle", center: [0, 0], diameter: 4 }] });
    await ok(s, "set_variables", { variables: [{ name: "w", value: 60 }] });
    // Followed: the plane and the sketch on it are at the new end.
    expect(r(framesOf(s.doc.features, undefined, s.build().followed).get(plane.id)!.origin)).toEqual([60, 0, 10]);
    const sk = s.build().links?.[s.doc.features.find((f) => f.name === "On end")!.id]?.plane;
    expect(sk?.kind === "face" && r(sk.origin)).toEqual([60, 0, 10]);
    const described = await ok(s, "describe_design");
    expect(described).toMatch(/End plane .*plane \(point_normal\) through a corner of Block, square to x axis/);
  });

  it("a round edge as the line gives its axis", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "cylinder", diameter: 10, height: 10 });
    await ok(s, "add_feature", { type: "plane", plane_type: "point_normal", point: [0, 0, 5], line: { edge: "E1", part: "Part 1" }, name: "Across" });
    const pl = s.doc.features.find((f) => f.name === "Across")!;
    // Stored as clicked: square to the cylinder's axis (Z), not along a chord of the circle.
    expect(r(pl.planeDef!.line!.dir!.map(Math.abs))).toEqual([0, 0, 1]);
    const fr = framesOf(s.doc.features, undefined, s.build().followed).get(pl.id)!;
    expect(r(fr.n.map(Math.abs))).toEqual([0, 0, 1]);
    expect(r(fr.origin)).toEqual([0, 0, 5]);
  });

  it("three point, line angle and fit planes; plain errors", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    await ok(s, "add_feature", { type: "plane", plane_type: "three_point", points: [[0, 0, 0], [10, 0, 10], [0, 10, 0]], name: "Slope" });
    const slope = framesOf(s.doc.features).get(s.doc.features.find((f) => f.name === "Slope")!.id)!;
    expect(Math.abs(slope.n[0])).toBeCloseTo(Math.SQRT1_2, 6);
    await ok(s, "add_feature", { type: "plane", plane_type: "line_angle", line: "z", angle: 45, name: "Turned" });
    expect(await fails(s, "add_feature", { type: "plane", plane_type: "three_point", points: [[0, 0, 0], [1, 1, 1], [2, 2, 2]] })).toMatch(/in a line/);
    expect(await fails(s, "add_feature", { type: "plane", plane_type: "fit", points: [[0, 0, 0], [1, 0, 0]] })).toMatch(/at least three/);
    await ok(s, "add_feature", { type: "plane", plane_type: "fit", points: [[0, 0, 1], [5, 0, 1], [0, 5, 1], [5, 5, 1]], name: "Fitted" });
    expect(await ok(s, "describe_design")).toMatch(/Fitted .*plane \(fit\) through 4 points/);
  });

  it("a mate connector on a part, used by an assembly mate", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 10, name: "Base" });
    await ok(s, "add_feature", { type: "mate_connector", at: { face: "top", part: "Part 1" }, move: [5, 0, 0], name: "Peg spot" });
    expect(await ok(s, "describe_design")).toMatch(/Peg spot .*mate connector at a flat face of Base.*origin \(25, 20, 10\), Z \(0, 0, 1\), dx 5/);
    await ok(s, "add_feature", { type: "box", width: 4, depth: 4, height: 4, x: 100, name: "Peg", operation: "new" });
    await ok(s, "create_assembly", { name: "Kit" });
    await ok(s, "insert_into_assembly", { part: "Part 1" });
    await ok(s, "insert_into_assembly", { part: "Part 2" });
    const mated = await ok(s, "add_mate", { type: "fasten", first: { instance: "Part 1 <1>", connector: "Peg spot" }, second: { instance: "Part 2 <1>", face: "bottom" } });
    expect(mated).toMatch(/Part 1 <1> \(Peg spot\)/);
    expect(s.doc.assemblies![0].mates![0].a.connector).toBeTruthy();
    // The peg's bottom middle (102, 2, 0) went onto the connector (25, 20, 10).
    const peg = s.doc.assemblies![0].instances.find((i) => i.name === "Part 2 <1>")!;
    expect(r(peg.placement.position)).toEqual([-77, 18, 10]);
    expect(await fails(s, "add_mate", { type: "fasten", first: { instance: "Part 2 <1>", connector: "nothing" }, second: { instance: "Part 1 <1>", face: "top" } })).toMatch(/no mate connectors of its own/);
  });
});
