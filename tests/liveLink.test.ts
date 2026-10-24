/**
 * Live with Claude, end to end in Node: the extension's real WebSocket server
 * and bridge (src/mcp/websocket.ts, live.ts), the app's real live client
 * (src/live/client.ts) over Node's own WebSocket, a stand-in for the app's
 * store (a design and its undo history), and Claude's tools with the real
 * OpenCascade engine.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commit, emptyDocument, historyOf, undo as undoHistory, type History } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { addStudio, MAIN_STUDIO, studioFeatures } from "../src/model/studios";
import type { JuraCADDocument } from "../src/model/types";
import { LiveClient, type LiveHost, type SocketLike } from "../src/live/client";
import { LIVE_PATH, LIVE_SUBPROTOCOL } from "../src/live/protocol";
import { DesignFolder } from "../src/mcp/files";
import { LiveBridge } from "../src/mcp/live";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";
import { startLiveServer } from "../src/mcp/websocket";

beforeAll(async () => {
  setOC(await opencascade());
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((f) => f());
});

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Generous: a busy CI machine can be slow to build a part or pass a message.
async function until(cond: () => boolean, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(10);
  }
}

/** The app, as far as the live link sees it: a design with undo, the Part Studio on show, and a dialog that may be open. */
class FakeApp implements LiveHost {
  appVersion = "test";
  browser = "chrome" as const;
  history: History;
  studio = MAIN_STUDIO;
  dialog: string | null = null;
  applied: { label: string; replace: boolean }[] = [];
  private listeners = new Set<() => void>();
  constructor(doc: JuraCADDocument) {
    this.history = historyOf(doc);
  }
  get doc() {
    return this.history.present;
  }
  current() {
    const doc = this.history.present;
    return { key: `${JSON.stringify(doc).length}:${this.history.past.length}:${this.studio}:${doc.features.length}`, studio: this.studio, file: () => serializeDocument(doc) };
  }
  busy() {
    return this.dialog;
  }
  apply(file: string, _studio: string, label: string, replace: boolean) {
    const r = readDocumentFile(file);
    if (!r.ok) return r.error;
    this.history = commit(this.history, r.doc);
    this.applied.push({ label, replace });
    // Like the real store, which tells its listeners (the live link among them) straight away.
    this.listeners.forEach((f) => f());
    return null;
  }
  /** Set while the link watches whether the tab is in view: call it to hide or show the tab. */
  setVisible: ((visible: boolean) => void) | null = null;
  watchVisibility(onChange: (visible: boolean) => void) {
    this.setVisible = onChange;
    return () => (this.setVisible = null);
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** The user changes the design (and the app tells the link, unless `quietly`). */
  edit(fn: (d: JuraCADDocument) => JuraCADDocument, quietly = false) {
    this.history = commit(this.history, fn(this.history.present));
    if (!quietly) this.listeners.forEach((f) => f());
  }
  undo() {
    this.history = undoHistory(this.history);
    this.listeners.forEach((f) => f());
  }
}

const socketFrom = (origin: string) => (url: string, protocol: string) => new WebSocket(url, { protocols: [protocol], headers: { origin } } as unknown as string[]) as unknown as SocketLike;

async function setup(doc: JuraCADDocument = emptyDocument("Lid"), opts: { allowLocalOrigins?: boolean; helloTimeout?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "juracad-live-"));
  const bridge = new LiveBridge("test-ext", () => {}, 20_000, opts.helloTimeout);
  const started = await startLiveServer({ ports: [0], accept: (c) => bridge.connect(c), allowLocalOrigins: opts.allowLocalOrigins });
  if (!started) throw new Error("no port");
  const session = new Session(new DesignFolder(join(dir, "JuraCAD")));
  session.live = bridge;
  const app = new FakeApp(doc);
  const client = new LiveClient(app, socketFrom("https://gm7dha.github.io"), [started.port]);
  cleanups.push(() => {
    client.disconnect();
    bridge.close();
    (started.server as Server).close();
    session.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bridge, port: started.port, session, app, client };
}

async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

/** Try a raw WebSocket handshake; resolves with the HTTP status. */
function handshake(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: LIVE_PATH,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": LIVE_SUBPROTOCOL,
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.on("error", reject);
    req.end();
  });
}

describe("Live with Claude", () => {
  it("only lets the JuraCAD site in", async () => {
    const { port, bridge } = await setup();
    expect(await handshake(port, { Origin: "https://evil.example" })).toBe(403);
    expect(await handshake(port, {})).toBe(403);
    expect(await handshake(port, { Origin: "https://gm7dha.github.io", Host: `evil.example:${port}` })).toBe(403);
    expect(await handshake(port, { Origin: "https://gm7dha.github.io", "Sec-WebSocket-Protocol": "chat" })).toBe(400);
    // A page from another site, through the real client: turned away, with advice.
    const app = new FakeApp(emptyDocument("x"));
    const stranger = new LiveClient(app, socketFrom("https://evil.example"), [port]);
    const state = await stranger.connect();
    expect(state.kind).toBe("failed");
    expect(bridge.connected).toBe(false);
    // Pages served on this computer (a dev server, another program's page) are kept out too.
    for (const origin of ["http://localhost:9999", "http://127.0.0.1:1234", "http://[::1]:8080", "https://localhost"]) {
      expect(await handshake(port, { Origin: origin })).toBe(403);
    }
    // The right origin gets in (the server answers 101).
    expect(await handshake(port, { Origin: "https://gm7dha.github.io" })).toBe(101);
  });

  it("lets JuraCAD on this computer in only in development mode (JURACAD_LIVE_DEV=1)", async () => {
    const { port } = await setup(emptyDocument("x"), { allowLocalOrigins: true });
    expect(await handshake(port, { Origin: "http://localhost:4173" })).toBe(101);
  });

  it("works on the new tab's design after reconnecting, never the old one's", async () => {
    const { bridge, session, port } = await setup(emptyDocument("First"));
    const first = new FakeApp(emptyDocument("First"));
    const firstClient = new LiveClient(first, socketFrom("https://gm7dha.github.io"), [port]);
    cleanups.push(() => firstClient.disconnect());
    await firstClient.connect();
    await until(() => bridge.connected, "the first tab");
    expect(await ok(session, "describe_design")).toMatch(/Design "First"/);
    firstClient.disconnect();
    await until(() => !bridge.connected, "the first tab to go");
    // Another tab connects (its versions start at 1 again, like the first one's did).
    const second = new FakeApp(emptyDocument("Second"));
    const secondClient = new LiveClient(second, socketFrom("https://gm7dha.github.io"), [port]);
    cleanups.push(() => secondClient.disconnect());
    await secondClient.connect();
    await until(() => bridge.connected, "the second tab");
    expect(bridge.version).toBe(1);
    expect(await ok(session, "describe_design")).toMatch(/Design "Second"/);
    await ok(session, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    expect(second.doc.name).toBe("Second");
    expect(second.doc.features.map((f) => f.type)).toEqual(["box"]);
    expect(first.doc.features).toEqual([]);
  });

  it("lets go of a connection that never says hello, and a new tab can take its place", async () => {
    const { bridge, port } = await setup(emptyDocument("x"), { helloTimeout: 300 });
    // Opens the link but says nothing.
    const silent = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}`, { protocols: [LIVE_SUBPROTOCOL], headers: { origin: "https://gm7dha.github.io" } } as unknown as string[]);
      ws.onopen = () => resolve(ws);
    });
    let closed = false;
    silent.onclose = () => (closed = true);
    await until(() => closed, "the silent connection to be closed");
    // Another silent one, then a real tab: the real tab takes the place at once.
    const silent2 = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_PATH}`, { protocols: [LIVE_SUBPROTOCOL], headers: { origin: "https://gm7dha.github.io" } } as unknown as string[]);
      ws.onopen = () => resolve(ws);
    });
    cleanups.push(() => silent2.close());
    const app = new FakeApp(emptyDocument("Real tab"));
    const client = new LiveClient(app, socketFrom("https://gm7dha.github.io"), [port]);
    cleanups.push(() => client.disconnect());
    expect((await client.connect()).kind).toBe("connected");
    expect(bridge.connected).toBe(true);
  });

  it("says plainly when Claude isn't there", async () => {
    const app = new FakeApp(emptyDocument("x"));
    // A port nothing listens on.
    const client = new LiveClient(app, socketFrom("https://gm7dha.github.io"), [1]);
    const state = await client.connect();
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.title).toBe("Claude isn't connected");
      expect(state.help.join(" ")).toMatch(/Claude desktop app is open/);
    }
  });

  it("builds a bracket live: each change arrives once, with the next version, as one undo step", async () => {
    const { app, client, bridge, session } = await setup(emptyDocument("Mounting bracket"));
    const state = await client.connect();
    expect(state.kind).toBe("connected");
    await until(() => bridge.connected, "the extension to see the tab");
    expect(textOf(await callTool(session, "live_status", {}))).toMatch(/Live: connected .*"Mounting bracket"/);

    await ok(session, "add_sketch", { name: "Plate outline", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
    expect(app.applied).toEqual([{ label: "Claude: added Plate outline", replace: false }]);
    expect(bridge.version).toBe(2);
    const extrude = await ok(session, "add_feature", { type: "extrude", sketch: "Plate outline", depth: 3 });
    expect(extrude).toMatch(/Live: this now shows in the user's open JuraCAD tab, as one step in its undo list \("Claude: added Extrude 1"\)/);
    await ok(session, "add_sketch", { name: "Hole positions", on_face: "top", shapes: [[5, 5], [55, 5], [5, 35], [55, 35]].map((at) => ({ type: "point", at })) });
    await ok(session, "add_feature", { type: "hole", sketch: "Hole positions", size: "M4" });
    await ok(session, "add_feature", { type: "fillet", edges: ["along z"], radius: 4, name: "Round corners" });
    // Looking changes nothing and sends nothing.
    await ok(session, "describe_design");
    await ok(session, "list_faces");
    expect(app.applied.map((a) => a.label)).toEqual([
      "Claude: added Plate outline",
      "Claude: added Extrude 1",
      "Claude: added Hole positions",
      "Claude: added Hole 1",
      "Claude: added Round corners",
    ]);
    expect(bridge.version).toBe(6);
    // One undo step in the app for each change.
    expect(app.history.past.length).toBe(5);
    expect(app.doc.features.map((f) => f.name)).toEqual(["Plate outline", "Extrude 1", "Hole positions", "Hole 1", "Round corners"]);

    // The design in the app builds to the same bracket, on its own.
    const check = new Session(null);
    cleanups.push(() => check.dispose());
    check.reset(app.doc, null);
    const b = check.build();
    expect(Object.keys(b.errors)).toEqual([]);
    const BRACKET = 60 * 40 * 3 - 4 * Math.PI * 2.25 ** 2 * 3 - 4 * 3 * (16 - 4 * Math.PI);
    expect(b.parts[0].volume!).toBeCloseTo(BRACKET, 1);

    // The user undoes the fillet in the app; Claude sees that straight away.
    app.undo();
    await until(() => bridge.version === 7, "the undo to reach the extension");
    const described = await ok(session, "describe_design");
    expect(described).toMatch(/open live in the user's JuraCAD tab/);
    expect(described).not.toMatch(/Round corners/);
    // Claude's undo has nothing of its own left to undo (the user changed things since).
    expect(await ok(session, "undo")).toMatch(/nothing of yours to undo/);
    // Claude carries on from what the user has.
    await ok(session, "add_feature", { type: "chamfer", edges: ["along z"], distance: 2 });
    expect(app.doc.features.map((f) => f.name)).toEqual(["Plate outline", "Extrude 1", "Hole positions", "Hole 1", "Chamfer 1"]);
    expect(bridge.version).toBe(8);
    // ... and can undo its own change: that's a new step in the app too.
    await ok(session, "undo");
    expect(app.doc.features.map((f) => f.name)).toEqual(["Plate outline", "Extrude 1", "Hole positions", "Hole 1"]);
    expect(app.applied[app.applied.length - 1].label).toBe("Claude: undid its last change");
    expect(bridge.version).toBe(9);

    // Saving still writes a file, of the design open in the app.
    await ok(session, "save_design", { filename: "live bracket" });
    const saved = readDocumentFile(readFileSync(join(session.folder!.root, "live bracket.juracad"), "utf8"));
    expect(saved.ok && saved.doc.features.length).toBe(4);
  });

  it("never loses either side's change when both change at once", async () => {
    const { app, client, bridge, session } = await setup();
    await client.connect();
    await until(() => bridge.connected, "connected");
    await ok(session, "add_feature", { type: "box", width: 20, depth: 20, height: 10 });
    expect(app.applied.length).toBe(1);

    // The user renames the design just as Claude adds a cylinder (the app hasn't sent it yet).
    app.edit((d) => ({ ...d, name: "Renamed by the user" }), true);
    const r = await callTool(session, "add_feature", { type: "cylinder", diameter: 5, height: 20, x: 10, y: 10, z: 0 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/changed the design in JuraCAD at the same moment, so this change was NOT applied/);
    // The user's change stands; Claude's wasn't applied.
    expect(app.doc.name).toBe("Renamed by the user");
    expect(app.doc.features.length).toBe(1);
    expect(app.applied.length).toBe(1);
    await until(() => bridge.version === 3, "the user's change to reach the extension");
    // Claude tries again, on the user's latest design: both changes are kept.
    await ok(session, "add_feature", { type: "cylinder", diameter: 5, height: 20, x: 10, y: 10, z: 0 });
    expect(app.doc.name).toBe("Renamed by the user");
    expect(app.doc.features.map((f) => f.type)).toEqual(["box", "cylinder"]);
    expect(bridge.version).toBe(4);

    // A dialog open in the app: Claude is asked to wait.
    app.dialog = 'The user has "Extrude 3" open for editing in JuraCAD.';
    const busy = await callTool(session, "add_feature", { type: "sphere", diameter: 4, x: 0, y: 0, z: 10 });
    expect(busy.isError).toBe(true);
    expect(textOf(busy)).toMatch(/Extrude 3" open for editing.*Nothing was changed/);
    expect(app.doc.features.length).toBe(2);
    app.dialog = null;
    await ok(session, "add_feature", { type: "sphere", diameter: 4, x: 0, y: 0, z: 10 });
    expect(app.doc.features.length).toBe(3);
  });

  it("refuses a change if the user's edit arrives while the tool is still running", async () => {
    const { app, client, bridge, session } = await setup(emptyDocument("Start"));
    await client.connect();
    await until(() => bridge.connected, "connected");
    // A slow tool (like an export): the user's change reaches the extension half-way through.
    const r = await bridge.call(session, "rename", async () => {
      app.edit((d) => ({ ...d, name: "The user's name" }));
      await until(() => bridge.version === 2, "the user's change");
      session.commit({ ...session.doc, name: "Claude's name" });
      return { content: [{ type: "text", text: "renamed" }] };
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/at the same moment/);
    expect(app.doc.name).toBe("The user's name");
    expect(app.applied).toEqual([]);
    // Claude's next look is at the user's design.
    expect(await ok(session, "describe_design")).toMatch(/Design "The user's name"/);
  });

  it("works on the Part Studio on show and leaves the others alone", async () => {
    const second = "ps2";
    const { app, client, bridge, session } = await setup(addStudio(emptyDocument("Two studios"), second));
    app.studio = second;
    await client.connect();
    await until(() => bridge.connected, "connected");
    await ok(session, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    expect(studioFeatures(app.doc, second).map((f) => f.type)).toEqual(["box"]);
    expect(app.doc.features).toEqual([]);
    expect(app.doc.partStudios!.length).toBe(1);
    // Switching to Part Studio 1 in the app: Claude now works there.
    app.studio = MAIN_STUDIO;
    app.edit((d) => ({ ...d, name: "Switched" }));
    await until(() => bridge.studio === MAIN_STUDIO, "the switch");
    await ok(session, "add_feature", { type: "cylinder", diameter: 10, height: 5 });
    expect(app.doc.features.map((f) => f.type)).toEqual(["cylinder"]);
    expect(studioFeatures(app.doc, second).map((f) => f.type)).toEqual(["box"]);
  });

  it("replaces the open design only when asked (new_design), as an undoable step", async () => {
    const { app, client, bridge, session } = await setup(emptyDocument("Old"));
    await client.connect();
    await until(() => bridge.connected, "connected");
    await ok(session, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    await ok(session, "new_design", { name: "Fresh" });
    expect(app.doc.name).toBe("Fresh");
    expect(app.applied[app.applied.length - 1]).toEqual({ label: 'Claude: started a new design, "Fresh"', replace: true });
    app.undo();
    expect(app.doc.name).toBe("Old");
  });

  it("one tab at a time; after disconnecting, the tools work on Claude's own copy", async () => {
    const { app, client, bridge, session, port } = await setup();
    await client.connect();
    await until(() => bridge.connected, "connected");
    const other = new LiveClient(new FakeApp(emptyDocument("Other tab")), socketFrom("https://gm7dha.github.io"), [port]);
    const state = await other.connect();
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") expect(state.title).toBe("Another JuraCAD tab is connected");
    expect(bridge.connected).toBe(true);

    await ok(session, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    client.disconnect();
    await until(() => !bridge.connected, "the disconnect");
    expect(textOf(await callTool(session, "live_status", {}))).toMatch(/Live: not connected/);
    await ok(session, "add_feature", { type: "cylinder", diameter: 4, height: 30 });
    // The app didn't get that one.
    expect(app.doc.features.length).toBe(1);
    expect(session.doc.features.length).toBe(2);
    // Connecting again: Claude takes the design from the tab.
    await client.connect();
    await until(() => bridge.connected, "reconnected");
    await ok(session, "describe_design");
    expect(session.doc.features.length).toBe(1);
  });

  it("links every Claude chat: changes from any of them appear, and all see the latest design", async () => {
    // Three extensions running (one per Claude chat), each on its own port.
    const instance = async (port = 0) => {
      const bridge = new LiveBridge("test-ext", () => {}, 60_000);
      const started = await startLiveServer({ ports: [port], accept: (c) => bridge.connect(c) });
      if (!started) throw new Error("no port");
      const session = new Session(null);
      session.live = bridge;
      const stop = () => {
        bridge.close();
        started.server.close();
      };
      cleanups.push(() => {
        stop();
        session.dispose();
      });
      return { bridge, session, port: started.port, stop };
    };
    const a = await instance();
    const b = await instance();
    const c = await instance();
    // A port for a chat started later: find a free one now.
    const spare = await startLiveServer({ ports: [0], accept: () => {} });
    const laterPort = spare!.port;
    await new Promise((r) => spare!.server.close(r));

    const app = new FakeApp(emptyDocument("Shared"));
    const client = new LiveClient(app, socketFrom("https://gm7dha.github.io"), [a.port, b.port, c.port, laterPort], { open: 2_000, openWithPrompt: 2_000, welcome: 5_000, recheck: { fast: 150 } });
    cleanups.push(() => client.disconnect());
    const state = await client.connect();
    expect(state.kind === "connected" && state.chats).toBe(3);
    await until(() => a.bridge.connected && b.bridge.connected && c.bridge.connected, "all three linked");

    // Claude in chat B adds a box: it appears in the tab, and A and C get the new design.
    await ok(b.session, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    expect(app.doc.features.map((f) => f.type)).toEqual(["box"]);
    expect(app.applied.map((x) => x.label)).toEqual(["Claude: added Box 1"]);
    await until(() => a.bridge.version === 2 && c.bridge.version === 2, "A and C to get the new design");
    expect(b.bridge.version).toBe(2);
    expect(await ok(a.session, "describe_design")).toMatch(/Box 1/);
    // Chat A builds on it.
    await ok(a.session, "add_feature", { type: "cylinder", diameter: 4, height: 20 });
    expect(app.doc.features.map((f) => f.type)).toEqual(["box", "cylinder"]);
    await until(() => b.bridge.version === 3 && c.bridge.version === 3, "B and C to see the cylinder");
    expect(await ok(b.session, "describe_design")).toMatch(/Cylinder 1/);
    // The user's own change reaches every chat.
    app.edit((d) => ({ ...d, name: "Renamed by the user" }));
    await until(() => [a, b, c].every((x) => x.bridge.doc?.name === "Renamed by the user"), "the user's change everywhere");

    // Two chats changing at the same moment: the second one's change is refused (nothing lost), and it can retry.
    const clash = await b.bridge.call(b.session, "rename", async () => {
      await ok(a.session, "set_variables", { variables: [{ name: "wall", value: "3" }] });
      await until(() => b.bridge.doc?.variables?.length === 1, "B to hear of A's change");
      b.session.commit({ ...b.session.doc, name: "B's name" });
      return { content: [{ type: "text", text: "renamed" }] };
    });
    expect(clash.isError).toBe(true);
    expect(textOf(clash)).toMatch(/at the same moment/);
    expect(app.doc.name).toBe("Renamed by the user");
    expect(app.doc.variables?.map((v) => v.name)).toEqual(["wall"]);

    // A chat started after connecting is linked by itself within moments.
    const d = await instance(laterPort);
    await until(() => d.bridge.connected && client.chats === 4, "the new chat to be linked");
    expect(await ok(d.session, "describe_design")).toMatch(/Design "Renamed by the user"[\s\S]*Box 1[\s\S]*Cylinder 1/);
    await ok(d.session, "add_feature", { type: "sphere", diameter: 6, x: 0, y: 0, z: 30 });
    expect(app.doc.features.map((f) => f.type)).toEqual(["box", "cylinder", "sphere"]);

    // Chat B's extension stops: it's dropped quietly and the others carry on.
    b.stop();
    await until(() => client.chats === 3, "B to be dropped");
    expect(client.state.kind).toBe("connected");
    expect(client.linkedPorts).toEqual([a.port, c.port, d.port].sort((x, y) => x - y));
    await ok(c.session, "add_feature", { type: "box", name: "From C", width: 2, depth: 2, height: 2, x: 40, y: 0, z: 0, operation: "new" });
    expect(app.doc.features.map((f) => f.name)).toContain("From C");
    await until(() => a.bridge.doc?.features.some((f) => f.name === "From C") === true, "A to see C's box");
  });

  it("looks for new chats often at first, then rarely, and not at all while the tab is hidden", async () => {
    const { bridge, port } = await setup(emptyDocument("x"));
    // A port with nothing on it, as most are: each look tries it.
    const spare = await startLiveServer({ ports: [0], accept: () => {} });
    const empty = spare!.port;
    await new Promise((r) => spare!.server.close(r));
    const app = new FakeApp(emptyDocument("Timing"));
    const client = new LiveClient(app, socketFrom("https://gm7dha.github.io"), [port, empty], { open: 1_000, recheck: { fast: 50, fastFor: 1_200, slow: 60_000 } });
    cleanups.push(() => client.disconnect());
    await client.connect();
    await until(() => bridge.connected, "connected");
    expect(app.setVisible).not.toBeNull();
    // Hidden straight away: no looking at all.
    app.setVisible!(false);
    const hiddenAt = client.rechecks;
    await wait(300);
    expect(client.rechecks).toBe(hiddenAt);
    // Back in view: one look at once, then often (still in the first stretch).
    app.setVisible!(true);
    expect(client.rechecks).toBe(hiddenAt + 1);
    await wait(500);
    expect(client.rechecks).toBeGreaterThanOrEqual(hiddenAt + 3);
    // After the first stretch: rarely (here once a minute), so nothing more for a good while.
    // (Waits well past the 1.2 s stretch, so a late timer on a busy machine can't land in the check below.)
    await wait(1_500);
    const settled = client.rechecks;
    await wait(500);
    expect(client.rechecks).toBe(settled);
    // Focus (or showing the tab) looks straight away, whatever the schedule.
    app.setVisible!(true);
    expect(client.rechecks).toBe(settled + 1);
    // Disconnecting stops watching.
    client.disconnect();
    expect(app.setVisible).toBeNull();
  });
});
