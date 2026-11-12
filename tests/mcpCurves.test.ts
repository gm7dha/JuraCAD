/**
 * Claude's curve features (add_feature "curve") and sweeps along them or along part edges, with the real
 * OpenCascade engine: a helix swept into a spring, a fit spline, a composite of edges, and errors in plain words.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-curves-"));
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
void r;

describe("curves made by Claude", () => {
  it("a helix swept into a spring", async () => {
    const s = newSession();
    const out = await ok(s, "add_feature", { type: "curve", curve_type: "helix", axis: "z", diameter: 20, height: 30, turns: 5 });
    expect(out).toMatch(/Helix 1/);
    expect(out).toMatch(/helix round an axis/);
    await ok(s, "add_sketch", { name: "Wire", plane: "Front", shapes: [{ type: "circle", center: [10, 0], diameter: 2 }] });
    await ok(s, "add_feature", { type: "sweep", sketch: "Wire", path: "Helix 1" });
    const b = s.build();
    expect(b.errors).toEqual({});
    expect(b.parts).toHaveLength(1);
    expect(Object.keys(b.curves ?? {})).toHaveLength(1);
  });

  it("a fit spline, a composite of edges, and a sweep along part edges", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 5 });
    await ok(s, "add_feature", { type: "curve", curve_type: "fit_spline", points: [[0, 0, 10], [10, 5, 12], [20, 0, 15]] });
    await ok(s, "add_feature", { type: "curve", curve_type: "composite", part: "Part 1", edges: [{ near: [10, 0, 5] }, { near: [20, 10, 5] }] });
    await ok(s, "add_sketch", { name: "Rod", plane: "Right", shapes: [{ type: "circle", center: [0, 5], diameter: 2 }] });
    await ok(s, "add_feature", { type: "sweep", sketch: "Rod", path_part: "Part 1", path_edges: [{ near: [10, 0, 5] }] });
    expect(s.build().errors).toEqual({});
    expect(Object.keys(s.build().curves ?? {})).toHaveLength(2);
    const bad = await fails(s, "add_feature", { type: "curve", curve_type: "fit_spline", points: [[0, 0, 0]] });
    expect(bad).toMatch(/at least two/);
  });

  it("projected and bridging curves from Claude's inputs", async () => {
    const s = newSession();
    await ok(s, "add_feature", { type: "sphere", diameter: 40 });
    await ok(s, "add_sketch", { name: "Ring", plane: "Top", shapes: [{ type: "circle", center: [0, 0], diameter: 20 }] });
    const proj = await ok(s, "add_feature", { type: "curve", curve_type: "projected", sketch: "Ring", part: "Part 1", faces: [{ near: [0, 0, 20] }] });
    expect(proj).toMatch(/Projected curve 1/);
    await ok(s, "add_sketch", { name: "Line", plane: "Front", shapes: [{ type: "line", from: [-30, 5], to: [30, 5] }] });
    await ok(s, "add_feature", { type: "curve", curve_type: "projected", sketch: "Ring", second_sketch: "Line" });
    await ok(s, "add_feature", { type: "curve", curve_type: "fit_spline", points: [[30, 0, 0], [40, 10, 0], [50, 0, 0]] });
    const br = await ok(s, "add_feature", { type: "curve", curve_type: "bridging", from: { curve: "Fit spline 1", end: "end" }, to: [70, 20, 5], match_from: "curvature", bulge: 1.5 });
    expect(br).toMatch(/Bridging curve 1/);
    const b = s.build();
    expect(b.errors).toEqual({});
    expect(Object.keys(b.curves ?? {})).toHaveLength(4);
    // The bridge starts where the spline ends.
    const bridge = s.doc.features.find((f) => f.name === "Bridging curve 1")!;
    const line = b.curves![bridge.id][0];
    expect(Math.hypot(line[0] - 50, line[1], line[2])).toBeLessThan(1e-3);
    expect(await fails(s, "add_feature", { type: "curve", curve_type: "projected", sketch: "Ring" })).toMatch(/faces/);
    expect(await fails(s, "add_feature", { type: "curve", curve_type: "bridging", from: [0, 0, 0] })).toMatch(/"to"/);
  });
});
