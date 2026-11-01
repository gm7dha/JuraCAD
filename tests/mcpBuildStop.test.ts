/**
 * Stopping a long build part-way, and freeing the second engine when it's
 * idle (src/kernel/engine.ts rebuildStudiosAsync, src/mcp/session.ts). Real
 * OpenCascade engine.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { StudioInput } from "../src/kernel/protocol";
import { feature } from "./support/engineHelpers";
import type { Feature } from "../src/model/types";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";

beforeAll(async () => {
  setOC(await opencascade());
});

const dirs: string[] = [];
const sessions: Session[] = [];
const engines: GeometryEngine[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  engines.splice(0).forEach((e) => e.dispose());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function newSession(idleMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-stop-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")), undefined, idleMs);
  sessions.push(s);
  return s;
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");
async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

/** A row of `n` 10 mm cubes joined into one bar, as features (each one adds a cube). */
const bar = (n: number): Feature[] => Array.from({ length: n }, (_, k) => feature("box", { width: 10, depth: 10, height: 10, x: k * 10, y: 0, z: 0 }, k ? "add" : "new"));

const volumesOf = (r: { parts: { name: string; volume?: number }[] }) => r.parts.map((p) => Math.round(p.volume ?? 0));

describe("stopping a build part-way", () => {
  it("stops between features, and the next build is exactly as from a fresh engine", async () => {
    const e = new GeometryEngine();
    engines.push(e);
    const studios: StudioInput[] = [
      { id: "main", features: bar(4) },
      { id: "s2", features: bar(5) },
    ];
    // Everything built once.
    expect(volumesOf(e.rebuildStudios(studios))).toEqual([4000, 5000]);
    // Both studios change; stopped at the 7th feature (the second studio's 3rd), after the first was rebuilt.
    const changed: StudioInput[] = [
      { id: "main", features: bar(6) },
      { id: "s2", features: bar(7) },
    ];
    let pauses = 0;
    const stop = new Error("stop");
    await expect(
      e.rebuildStudiosAsync(changed, {}, {}, async () => {
        if (++pauses === 9) throw stop;
      }),
    ).rejects.toThrow("stop");
    expect(pauses).toBe(9);
    // The next build gives both studios again (the first one's new parts were never handed back), as a fresh engine would.
    const after = e.rebuildStudios(changed);
    expect(after.rebuilt).toEqual(["main", "s2"]);
    expect(volumesOf(after)).toEqual([6000, 7000]);
    const fresh = new GeometryEngine();
    engines.push(fresh);
    expect(volumesOf(after)).toEqual(volumesOf(fresh.rebuildStudios(changed)));
    // Unchanged now: nothing rebuilt; and a whole async build pauses once per feature.
    expect(e.rebuildStudios(changed).rebuilt).toEqual([]);
    let count = 0;
    const whole = await e.rebuildStudiosAsync([{ id: "main", features: bar(3) }, changed[1]], {}, {}, async () => void count++);
    expect(count).toBe(3);
    expect(volumesOf(whole)).toEqual([3000]);
  });

  it("stops a tool's build between features when Claude cancels, leaving the design as it was", async () => {
    const s = newSession();
    await ok(s, "new_design", { name: "Bar" });
    for (let k = 0; k < 8; k++) await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10, x: k * 10, operation: k ? "add" : "new" });
    const before = s.doc;
    // Cancelled during the build of the change: at the 3rd feature (after the checkpoint before the build).
    const ac = new AbortController();
    let checks = 0;
    const real = s.checkpoint.bind(s);
    s.checkpoint = async () => {
      if (++checks === 4) ac.abort();
      return real();
    };
    // A change to the first box: every feature after it is built again.
    const r = await callTool(s, "edit_feature", { feature: "Box 1", height: 20 }, ac.signal);
    expect(textOf(r)).toMatch(/^Cancelled: /);
    // It stopped there: not after building all 8 features.
    expect(checks).toBe(4);
    expect(s.doc).toBe(before);
    s.checkpoint = real;
    // The session carries on, the engine in step with the design.
    expect(await ok(s, "describe_design")).toMatch(/volume 8000 mm³/);
    expect(await ok(s, "edit_feature", { feature: "Box 1", height: 20 })).toMatch(/9000 mm³/);
  });
});

describe("freeing the second engine when it's idle", () => {
  it("frees it after a while unused, and builds again when it's next needed", async () => {
    const s = newSession(40);
    await ok(s, "new_design", { name: "Plate" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 30, height: 5 });
    await ok(s, "create_assembly", {});
    await ok(s, "insert_into_assembly", { part: "Part 1", count: 2 });
    expect(s.wholeReleases).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(s.wholeReleases).toBe(1);
    // Needed again: built again, and everything works as before.
    expect(await ok(s, "check_assembly", {})).toMatch(/2 parts, no clashes/);
    expect(await ok(s, "describe_assembly", {})).toMatch(/Part 1 <2>/);
    expect(s.releaseWholeEngine()).toBe(true);
    expect(s.releaseWholeEngine()).toBe(false);
    expect(await ok(s, "create_drawing", { assembly: "Assembly 1" })).toMatch(/Made Drawing 1/);
  });

  it("never frees it while a call is running", async () => {
    const s = newSession(20);
    await ok(s, "new_design", { name: "Plate" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 30, height: 5 });
    await ok(s, "create_assembly", {});
    // A call that uses the second engine, then waits longer than the idle time before using it again.
    const r = await s.serial(async () => {
      s.buildAll();
      await new Promise((resolve) => setTimeout(resolve, 80));
      return s.wholeReleases;
    });
    expect(r).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.wholeReleases).toBe(1);
  });
});
