/**
 * The Claude extension and Loft's several guides, connections and a sketch on a face carrying on from the faces
 * round it, with the real OpenCascade engine.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-loft-"));
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


describe("loft guides and connections from Claude", () => {
  it("takes a list of guides, and connections that twist it", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Guides" });
    await ok(s, "add_sketch", { name: "Base", plane: "Top", shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    await ok(s, "add_sketch", { name: "Cap", plane: "Top", offset: 30, shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    // On Front (x across, z up): arcs from the square's sides at x = ±10 out to 15 and −13 halfway up.
    await ok(s, "add_sketch", { name: "G1", plane: "Front", shapes: [{ type: "arc", center: [-10, 15], radius: 25, start_angle: -36.8699, end_angle: 36.8699 }] });
    await ok(s, "add_sketch", { name: "G2", plane: "Front", shapes: [{ type: "arc", center: [26, 15], radius: 39, start_angle: 157.3801, end_angle: 202.6199 }] });
    const added = await ok(s, "add_feature", { type: "loft", sections: ["Base", "Cap"], guides: ["G1", "G2"] });
    expect(added).toMatch(/guides G1, G2/);
    expect(total(s)).toBeGreaterThan(20 * 20 * 30 * 1.1);
    expect(await fails(s, "add_feature", { type: "loft", sections: ["Base", "Cap"], guide: "G1", guides: ["G2"] })).toMatch(/not both/);
  });

  it("joins the corners given", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Twist" });
    await ok(s, "add_sketch", { name: "Base", plane: "Top", shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    await ok(s, "add_sketch", { name: "Cap", plane: "Top", offset: 30, shapes: [{ type: "rectangle", corner: [-10, -10], width: 20, height: 20 }] });
    await ok(s, "add_feature", { type: "loft", sections: ["Base", "Cap"], connections: [[[10, 10, 0], [10, 10, 30]]] });
    exactly(total(s), 20 * 20 * 30);
    await ok(s, "undo");
    const twisted = await ok(s, "add_feature", { type: "loft", sections: ["Base", "Cap"], connections: [[[10, 10, 0], [-10, 10, 30]]] });
    expect(twisted).toMatch(/1 connection/);
    expect(total(s)).toBeLessThan(20 * 20 * 30 * 0.95);
  });

  it("carries a sketch on a face on from the faces round it", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "On a face" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 10, x: 0, y: 0, z: 0 });
    await ok(s, "add_sketch", { name: "On top", on_face: "top", shapes: [{ type: "rectangle", corner: [0, 0], width: 40, height: 40 }] });
    await ok(s, "add_sketch", { name: "Cap", plane: "Top", offset: 40, shapes: [{ type: "rectangle", center: [20, 20], width: 10, height: 10 }] });
    await ok(s, "add_feature", { type: "loft", sections: ["On top", "Cap"], start: "match_tangent", operation: "add" });
    // The box's upright sides carried on upright: more than the plain loft's frustum on top of the box.
    const v = total(s);
    expect(v).toBeGreaterThan(40 * 40 * 10 + (30 * (1600 + 100 + 400)) / 3);
    // A sketch on Top (a default plane) can't.
    await ok(s, "add_sketch", { name: "Low", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 40, height: 40 }] });
    expect(await fails(s, "add_feature", { type: "loft", sections: ["Low", "Cap"], start: "match_tangent" })).toMatch(/doesn't suit/);
  });
});

describe("a guide matching tangent, from Claude", () => {
  it("takes part edges as a guide with continuity, and refuses ones it hasn't got", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Blend" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 30, height: 10 });
    const tri = { type: "outline", points: [[0, 10], [8, 10], [3, 18]], closed: true };
    await ok(s, "add_sketch", { name: "A", plane: "Right", offset: 5, shapes: [tri] });
    await ok(s, "add_sketch", { name: "B", plane: "Right", offset: 35, shapes: [tri] });
    const edge = { part: "Part 1", edges: [{ near: [20, 0, 10] }] };
    expect(await fails(s, "add_feature", { type: "loft", sections: ["A", "B"], guide: { ...edge, continuity: "match_curvature" }, operation: "new" })).toMatch(/aren't available/);
    await ok(s, "add_feature", { type: "loft", sections: ["A", "B"], guide: { ...edge, continuity: "match_tangent" }, operation: "new" });
    const lo = s.doc.features.find((f) => f.type === "loft")!;
    expect(lo.loft?.guide && "edges" in lo.loft.guide && lo.loft.guide.continuity).toBe("matchTangent");
    expect(volumes(s).length).toBe(2);
  });
});
