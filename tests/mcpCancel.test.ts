/**
 * Cancelling a call (MCP's notifications/cancelled, which aborts the call's
 * signal): the tool stops at its next checkpoint, the design is put back as it
 * was, nothing is written, and — when live with a JuraCAD tab — nothing is
 * sent to the tab; a change already sent stays in step with the tab's reply.
 * Real OpenCascade engine.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument } from "../src/model/document";
import { serializeDocument } from "../src/model/fileFormat";
import { DesignFolder } from "../src/mcp/files";
import { LiveBridge, type LiveConnection } from "../src/mcp/live";
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
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-cancel-"));
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

/** Start a call and cancel it as soon as it first waits (as a cancellation arriving from Claude mid-call would). */
function cancelledSoon(s: Session, name: string, args: unknown) {
  const ac = new AbortController();
  const running = callTool(s, name, args, ac.signal);
  setImmediate(() => ac.abort("cancelled by Claude"));
  return running;
}

async function plate(s: Session) {
  await ok(s, "new_design", { name: "Plate" });
  await ok(s, "add_feature", { type: "box", width: 40, depth: 30, height: 5 });
}

describe("cancelling a call", () => {
  it("doesn't start a call cancelled before it runs", async () => {
    const { s } = newSession();
    await plate(s);
    const before = s.doc;
    const ac = new AbortController();
    ac.abort();
    const r = await callTool(s, "add_feature", { type: "cylinder", diameter: 10, height: 20 }, ac.signal);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Cancelled: .*nothing was changed/);
    expect(s.doc).toBe(before);
  });

  it("stops a feature part-way and leaves the design and its undo list as they were", async () => {
    const { s } = newSession();
    await plate(s);
    const before = s.doc;
    const past = s.past.length;
    const r = await cancelledSoon(s, "add_feature", { type: "cylinder", diameter: 10, height: 20, x: 20, y: 15 });
    expect(textOf(r)).toMatch(/^Cancelled: /);
    expect(s.doc).toBe(before);
    expect(s.past).toHaveLength(past);
    // The session carries on normally, with the engine in step.
    expect(await ok(s, "describe_design")).toMatch(/volume 6000 mm³/);
    expect(await ok(s, "add_feature", { type: "cylinder", diameter: 10, height: 20, x: 20, y: 15 })).toMatch(/Added Cylinder 1/);
    expect(s.signal).toBeNull();
  });

  it("runs calls sent together one after another, and drops one cancelled while it waits its turn", async () => {
    const { s } = newSession();
    await plate(s);
    const ac = new AbortController();
    const [a, b, c] = [
      callTool(s, "add_feature", { type: "cylinder", diameter: 4, height: 10, x: 5, y: 5 }),
      callTool(s, "add_feature", { type: "cylinder", diameter: 4, height: 10, x: 35, y: 5 }, ac.signal),
      callTool(s, "add_feature", { type: "cylinder", diameter: 4, height: 10, x: 35, y: 25 }),
    ];
    ac.abort();
    expect(textOf(await a)).toMatch(/Added Cylinder 1/);
    expect(textOf(await b)).toMatch(/^Cancelled: /);
    // Neither change is lost (they'd overwrite each other if they ran at once).
    expect(textOf(await c)).toMatch(/Added Cylinder 2/);
    expect(s.doc.features.map((f) => f.type)).toEqual(["box", "cylinder", "cylinder"]);
  });

  it("stops an assembly change and a drawing, writing no file", async () => {
    const { s, folder } = newSession();
    await plate(s);
    await ok(s, "create_assembly", { name: "Pair" });
    await ok(s, "insert_into_assembly", { part: "Part 1" });
    const before = s.doc;
    expect(textOf(await cancelledSoon(s, "insert_into_assembly", { part: "Part 1" }))).toMatch(/^Cancelled: /);
    expect(s.doc).toBe(before);
    expect(s.doc.assemblies![0].instances).toHaveLength(1);
    expect(textOf(await cancelledSoon(s, "create_drawing", { part: "Part 1" }))).toMatch(/^Cancelled: /);
    expect(s.doc.drawings).toBeUndefined();
    await ok(s, "create_drawing", { part: "Part 1" });
    // An export cancelled while its views are worked out writes nothing.
    expect(textOf(await cancelledSoon(s, "export_drawing", { format: "pdf", filename: "plate" }))).toMatch(/^Cancelled: /);
    expect(existsSync(join(folder, "plate.pdf"))).toBe(false);
    expect(textOf(await cancelledSoon(s, "export_model", { format: "step", filename: "plate" }))).toMatch(/^Cancelled: /);
    expect(existsSync(join(folder, "plate.step"))).toBe(false);
    // Not cancelled: written.
    await ok(s, "export_drawing", { format: "pdf", filename: "plate" });
    expect(existsSync(join(folder, "plate.pdf"))).toBe(true);
  });
});

/** A stand-in for the JuraCAD tab's connection: records what the extension sends, and can answer changes. */
function fakeTab(bridge: LiveBridge, answer: (msg: { type: string; id: number; base: number }, reply: (m: object) => void) => void) {
  const sent: { type: string; id: number; base: number; label?: string; file?: string }[] = [];
  const conn: LiveConnection = {
    send: (text) => {
      const msg = JSON.parse(text);
      sent.push(msg);
      if (msg.type === "change") answer(msg, (m) => conn.onMessage(JSON.stringify(m)));
    },
    close: () => {},
    onMessage: () => {},
    onClose: () => {},
  };
  bridge.connect(conn);
  conn.onMessage(JSON.stringify({ type: "hello", protocol: 1, app: "test", version: 1, studio: "main", file: serializeDocument(emptyDocument("Live design")) }));
  return sent;
}

describe("cancelling a call while live with a JuraCAD tab", () => {
  it("sends nothing to the tab when the call is cancelled before its change is made", async () => {
    const { s } = newSession();
    const bridge = new LiveBridge("test", () => {}, 20_000);
    s.live = bridge;
    const sent = fakeTab(bridge, (msg, reply) => setImmediate(() => reply({ type: "applied", id: msg.id, version: msg.base + 1 })));
    expect(sent[0].type).toBe("welcome");
    const r = await cancelledSoon(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    expect(textOf(r)).toMatch(/^Cancelled: /);
    expect(sent.filter((m) => m.type === "change")).toHaveLength(0);
    // The next call works on the tab's design as usual, as one undo step there.
    expect(await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 })).toMatch(/Live: this now shows/);
    expect(sent.filter((m) => m.type === "change")).toHaveLength(1);
    // Assembly and drawing changes go to the tab the same way, labelled for its undo list.
    await ok(s, "create_assembly", {});
    await ok(s, "create_drawing", {});
    const labels = sent.filter((m) => m.type === "change").map((m) => m.label);
    expect(labels).toEqual(["Claude: added Box 1", "Claude: added Assembly 1", "Claude: added Drawing 1"]);
    expect(JSON.parse(sent[sent.length - 1].file!).drawings).toHaveLength(1);
  });

  it("keeps in step with the tab when the cancellation comes after the change was sent", async () => {
    const { s } = newSession();
    const bridge = new LiveBridge("test", () => {}, 20_000);
    s.live = bridge;
    const ac = new AbortController();
    // The tab takes the change; Claude cancels while it's on its way.
    const sent = fakeTab(bridge, (msg, reply) => {
      ac.abort();
      setImmediate(() => reply({ type: "applied", id: msg.id, version: msg.base + 1 }));
    });
    await callTool(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 }, ac.signal);
    expect(sent.filter((m) => m.type === "change")).toHaveLength(1);
    // The tab has it, so the session has it too (the next change builds on it).
    expect(s.doc.features).toHaveLength(1);
    await ok(s, "add_feature", { type: "box", width: 5, depth: 5, height: 5, x: 20 });
    const last = sent.filter((m) => m.type === "change")[1];
    expect(last.base).toBe(2);
    expect(JSON.parse(last.file!).features).toHaveLength(2);
  });
});
