/**
 * Claude's export_for_laser tool (src/mcp/laserTools.ts) with the real
 * OpenCascade engine: a plate's top face as a true-size SVG, a sketch, and
 * the plain-English refusals.
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
import { parseDxf } from "../src/sketch/dxf";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-laser-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return { s, folder: join(dir, "JuraCAD") };
}
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
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

async function plate(s: Session) {
  await ok(s, "new_design", { name: "Sign" });
  await ok(s, "add_sketch", {
    shapes: [
      { type: "rectangle", center: [0, 0], width: 90, height: 40 },
      { type: "circle", center: [-35, 0], diameter: 6 },
      { type: "circle", center: [35, 0], diameter: 6 },
    ],
  });
  await ok(s, "add_feature", { type: "extrude", depth: 3 });
}

describe("export_for_laser", () => {
  it("saves a part's top face as an SVG at true size, red outside and blue holes", async () => {
    const { s, folder } = newSession();
    await plate(s);
    const said = await ok(s, "export_for_laser", { faces: [{ part: "Part 1", face: "top" }] });
    expect(said).toMatch(/90 × 40 mm overall, 1 piece/);
    expect(said).toMatch(/2 inner cuts \(#0000FF, CUT_INNER\), 1 outer cut \(#FF0000, CUT_OUTER\)/);
    const svg = readFileSync(join(folder, "Part 1.svg"), "utf8");
    expect(svg).toContain('width="90mm" height="40mm" viewBox="0 0 90 40"');
    expect(svg.match(/<circle [^>]*r="3" [^>]*stroke="#0000FF"/g)).toHaveLength(2);
    // The whole part gives the same outline; as DXF it's in millimetres.
    await ok(s, "export_for_laser", { parts: ["Part 1"], format: "dxf", filename: "plate" });
    const dxf = parseDxf(readFileSync(join(folder, "plate.dxf"), "utf8"));
    expect(dxf.unitMm).toBe(1);
    expect(dxf.entities.filter((e) => e.kind === "circle")).toHaveLength(2);
  });

  it("lays two parts out side by side and mirrors on request", async () => {
    const { s, folder } = newSession();
    await plate(s);
    await ok(s, "add_feature", { type: "box", width: 20, depth: 10, height: 2, x: 200, y: 0, z: 0, operation: "new" });
    const said = await ok(s, "export_for_laser", { gap: 4, mirror: true, filename: "both" });
    expect(said).toMatch(/2 pieces, mirrored/);
    const svg = readFileSync(join(folder, "both.svg"), "utf8");
    expect(svg).toContain('width="114mm" height="40mm"');
  });

  it("cuts a sketch, and refuses curved faces and two sources at once", async () => {
    const { s, folder } = newSession();
    await plate(s);
    expect(await ok(s, "export_for_laser", { sketch: "Sketch 1", filename: "sketch" })).toMatch(/90 × 40 mm/);
    expect(readFileSync(join(folder, "sketch.svg"), "utf8")).toContain('stroke="#FF0000"');
    expect(await fails(s, "export_for_laser", { sketch: "Sketch 1", parts: ["Part 1"] })).toMatch(/Give just one of/);
    const faces = await ok(s, "list_faces", { part: "Part 1" });
    const round = faces.match(/(F\d+)[^\n]*round/)![1];
    expect(await fails(s, "export_for_laser", { faces: [{ part: "Part 1", face: round }] })).toMatch(/curved.*Pick a flat face/);
  });
});
