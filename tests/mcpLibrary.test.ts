/** The Design library through Claude's tools: list_library_designs and insert_library_design (real OCCT). */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, TOOLS, type ToolResult } from "../src/mcp/tools";
import { shellVolume } from "../src/library/fingers";
import { fingerBoxSizes } from "../src/library/designs/fingerBox";
import { defaultValues, findDesign } from "../src/library/insert";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-lib-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return s;
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
async function call(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  return { text: textOf(r), error: !!r.isError };
}
const volume = (s: Session) => s.withEngine((e) => e.check("normal").parts.reduce((n, p) => n + p.exactVolume!, 0));

describe("Design library tools", () => {
  it("are listed, and describe every design and its sizes", async () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_library_designs");
    expect(names).toContain("insert_library_design");
    const s = newSession();
    const r = await call(s, "list_library_designs");
    expect(r.error).toBe(false);
    for (const id of ["finger-box", "tray", "bracket", "spacer", "knob"]) expect(r.text).toContain(id);
    expect(r.text).toMatch(/thickness: Material thickness \(mm, default 3/);
  });

  it("list one section on its own: laser or 3D printing", async () => {
    const s = newSession();
    const laser = await call(s, "list_library_designs", { category: "laser" });
    expect(laser.error).toBe(false);
    expect(laser.text).toMatch(/Laser cutting \(category "laser"\)/);
    for (const id of ["finger-box", "flat-stand"]) expect(laser.text).toContain(`${id} —`);
    for (const id of ["tray", "box-lid", "hinge", "hook"]) expect(laser.text).not.toMatch(new RegExp(`^${id} —`, "m"));
    const print = await call(s, "list_library_designs", { category: "print" });
    for (const id of ["tray", "box-lid", "bracket", "hook", "cable-clip", "phone-stand", "hinge", "spacer", "knob"]) expect(print.text).toContain(`${id} —`);
    expect(print.text).not.toContain("finger-box —");
    expect(print.text).toMatch(/\[3D printing( › \w+)?\]/);
    const both = await call(s, "list_library_designs");
    expect(both.text).toMatch(/Laser cutting[\s\S]*3D printing/);
    const bad = await call(s, "list_library_designs", { category: "wood" });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/"laser".*"print"/);
  });

  it("insert a piano hinge and a bolt set from the newer 3D printing designs", async () => {
    const s = newSession();
    const list = await call(s, "list_library_designs", { category: "print" });
    for (const id of ["bolt-set", "piano-hinge", "jar", "pegboard-hook"]) expect(list.text).toContain(`${id} —`);
    expect(list.text).toMatch(/bolt-set — Bolt, nut and washer set \[3D printing › Fixings\]/);
    const r = await call(s, "insert_library_design", { design: "piano-hinge", sizes: { length: 60, holes: 2 } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/piano_length = 60/);
    expect(s.build().parts).toHaveLength(3);
    const set = await call(s, "insert_library_design", { design: "bolt-set", sizes: { size: "M6", thread: false, nuts: 2 } });
    expect(set.error).toBe(false);
    expect(set.text).toMatch(/bolts_fit = 0.2/);
    // The hinge's 3 parts, then a bolt, two nuts and a washer.
    expect(s.build().parts).toHaveLength(7);
    const bad = await call(s, "insert_library_design", { design: "bolt-set", sizes: { bolts: 0, nuts: 0, washers: 0 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/at least one bolt, nut or washer/);
  });

  it("insert a box with lid: two parts", async () => {
    const s = newSession();
    const r = await call(s, "insert_library_design", { design: "box-lid", sizes: { width: 70 } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/lidbox_clearance = 0.2/);
    expect(s.build().parts).toHaveLength(2);
  });

  it("insert a finger box whose variables then resize it", async () => {
    const s = newSession();
    const r = await call(s, "insert_library_design", { design: "finger-box", sizes: { width: 150, lid: false } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/box_width = 150/);
    expect(r.text).toMatch(/5 panels/);
    expect(s.build().parts).toHaveLength(5);
    const values = { ...defaultValues(findDesign("finger-box")!), width: 150, lid: false };
    expect(volume(s)).toBeCloseTo(shellVolume(fingerBoxSizes(values)), 0);
    const changed = await call(s, "set_variables", { variables: [{ name: "box_width", value: "180" }] });
    expect(changed.error).toBe(false);
    expect(volume(s)).toBeCloseTo(shellVolume(fingerBoxSizes({ ...values, width: 180 })), 0);
    // A second one gets its own variables.
    const two = await call(s, "insert_library_design", { design: "spacer" });
    expect(two.text).toMatch(/spacer_outer = 12/);
    expect(s.doc.libraryInserts).toHaveLength(2);
  });

  it("insert beside the user's own part without cutting into it", async () => {
    const s = newSession();
    expect((await call(s, "add_feature", { type: "box", width: 100, depth: 100, height: 10, x: -50, y: -50, z: -2 })).error).toBe(false);
    const r = await call(s, "insert_library_design", { design: "knob" });
    expect(r.error).toBe(false);
    const parts = s.withEngine((e) => e.check("normal").parts);
    expect(parts).toHaveLength(2);
    expect(parts[0].exactVolume!).toBeCloseTo(100 * 100 * 10, 3);
  });

  it("refuse sizes that don't work, changing nothing", async () => {
    const s = newSession();
    const bad = await call(s, "insert_library_design", { design: "tray", sizes: { floor: 40 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/floor/);
    expect(bad.text).toMatch(/Nothing was changed/);
    expect((await call(s, "insert_library_design", { design: "tray", sizes: { colour: 3 } })).text).toMatch(/has no "colour"/);
    expect((await call(s, "insert_library_design", { design: "teapot" })).text).toMatch(/no library design/);
    expect(s.doc.features).toHaveLength(0);
  });
});
