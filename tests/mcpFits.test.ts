/**
 * Claude's fit check (check_assembly's Fits section and mark_fit), with the
 * real OpenCascade engine: a ⌀10.1 pin in a ⌀10 hole is a clash with its
 * amount until it's marked as a press fit; then it's judged in its range.
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-fits-"));
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

describe("fits made by Claude", () => {
  it("reports a pin's interference, then judges it once marked as a press fit", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Pin and plate" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 40, height: 10, x: 0, y: 0, z: 0 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 10, height: 10, x: 20, y: 20, z: 0, operation: "remove" });
    await ok(s, "add_feature", { type: "cylinder", diameter: 10.1, height: 20, x: 80, y: 20, z: -5, operation: "new" });
    const parts = s.build().parts;
    await ok(s, "rename_part", { part: parts[0].name, name: "Plate" });
    await ok(s, "rename_part", { part: parts[1].name, name: "Pin" });
    await ok(s, "create_assembly", { name: "Fit" });
    await ok(s, "insert_into_assembly", { part: "Plate" });
    await ok(s, "insert_into_assembly", { part: "Pin", at: [-60, 0, 0] });

    const clash = await ok(s, "check_assembly", {});
    expect(clash).toMatch(/CLASH: Plate <1> and Pin <1> overlap by .* \(the pin is 0.1 mm too big on the diameter, 0.05 mm a side\)/);
    expect(clash).toMatch(/Fits:\n- A press \(interference\) fit is/);
    expect(clash).toMatch(/mark one as a press fit/);

    expect(await ok(s, "mark_fit", { first: "Pin <1>", second: "Plate <1>", kind: "press", min: 0.05, max: 0.15 })).toMatch(/Marked Pin <1> and Plate <1> as a press \(interference\) fit of 0.05–0.15 mm/);
    expect(s.doc.assemblies![0].fits).toHaveLength(1);
    const good = await ok(s, "check_assembly", {});
    expect(good).toMatch(/Everything fits: 2 parts, no clashes/);
    expect(good).toMatch(/Pin <1> and Plate <1>: press fit OK — 0.1 mm on the diameter \(0.05 mm a side\) of interference \(wanted 0.05–0.15 mm on the diameter\)/);

    // Too tight for a smaller range; marking again replaces the mark.
    await ok(s, "mark_fit", { first: "Plate <1>", second: "Pin <1>", kind: "press", min: 0.01, max: 0.05 });
    expect(s.doc.assemblies![0].fits).toHaveLength(1);
    const tight = await ok(s, "check_assembly", {});
    expect(tight).toMatch(/1 fit to look at/);
    expect(tight).toMatch(/LOOK: Plate <1> and Pin <1>: press fit too tight/);
    // A clearance fit is wrong here.
    await ok(s, "mark_fit", { first: "Plate <1>", second: "Pin <1>", kind: "clearance" });
    expect(await ok(s, "check_assembly", {})).toMatch(/meant to have a gap, but they overlap by 0.1 mm on the diameter/);

    // Undo goes back a step; remove takes it away (a clash again).
    await ok(s, "undo");
    expect(s.doc.assemblies![0].fits![0].kind).toBe("press");
    expect(await ok(s, "mark_fit", { first: "Plate <1>", second: "Pin <1>", remove: true })).toMatch(/Removed the press fit/);
    expect(s.doc.assemblies![0].fits).toBeUndefined();
    expect(await ok(s, "check_assembly", { fits: false })).not.toMatch(/Fits:/);

    // Plain-English problems.
    expect(await fails(s, "mark_fit", { first: "Pin <1>", second: "Pin <1>", kind: "press" })).toMatch(/same copy/);
    expect(await fails(s, "mark_fit", { first: "Pin <1>", kind: "press" })).toMatch(/"first" and "second"/);
    expect(await fails(s, "mark_fit", { first: "Pin <1>", second: "Plate <1>", kind: "snug" })).toMatch(/kind/);
    expect(await fails(s, "mark_fit", { first: "Pin <1>", second: "Plate <1>", kind: "press", min: 0.2, max: 0.1 })).toMatch(/more than max/);
  });
});
