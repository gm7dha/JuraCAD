/**
 * "Live with Claude", the extension's side: keeps the design open in the
 * user's JuraCAD tab (sent by the tab over the local link, see
 * src/live/protocol.ts), runs Claude's tools on it, and sends each change
 * back for the tab to apply as one undo step.
 *
 * Nothing here touches files: the tab only ever sends a design (checked like
 * a .juracad file) and replies; files are still only written by save_design
 * and export_model, inside the chosen folder.
 */
import type { Feature, JuraCADDocument } from "../model/types";
import { readDocumentFile, serializeDocument } from "../model/fileFormat";
import { MAIN_STUDIO, studioExists, studioName, studioView } from "../model/studios";
import { resolveVariables } from "../model/variables";
import { refreshDocumentPlanes } from "../sketch/planeFeature";
import { isNewer, parseAppMessage, type AppMessage, type ExtensionMessage } from "../live/protocol";
import type { LiveLink, LiveStatus, Session } from "./session";
import type { ToolResult } from "./tools";

/** What the bridge needs from a connection (a WebSocketConnection, or a stand-in in tests). */
export interface LiveConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
}

type Reply = Extract<AppMessage, { type: "applied" | "refused" }> | { type: "timeout" } | { type: "disconnected" };

interface Pending {
  full: JuraCADDocument;
  studio: string;
  base: number;
  resolve: ((r: Reply) => void) | null;
}

/** How long to wait for the tab to apply a change (it rebuilds the part first). */
const REPLY_TIMEOUT_MS = 30_000;
/** How long a late reply to a change is still listened for, after giving up waiting. */
const LATE_REPLY_MS = 5 * 60_000;
/** A tab must say hello this soon after connecting, or it's let go (so it can't hold the one place). */
const HELLO_TIMEOUT_MS = 10_000;

const names = (fs: Feature[]) => fs.map((f) => f.name);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * A short description of what a tool changed, for the undo step in the app
 * ("Claude: added Extrude 2"). Pure.
 */
export function describeChange(tool: string, before: JuraCADDocument, after: JuraCADDocument, replaced: boolean): string {
  const say = (t: string) => `Claude: ${t.length > 110 ? `${t.slice(0, 107)}…` : t}`;
  if (replaced) return say(tool === "open_design" ? `opened "${after.name}"` : `started a new design, "${after.name}"`);
  if (tool === "undo") return say("undid its last change");
  const old = new Map(before.features.map((f) => [f.id, f]));
  const now = new Set(after.features.map((f) => f.id));
  const added = after.features.filter((f) => !old.has(f.id));
  const removed = before.features.filter((f) => !now.has(f.id));
  const changed = after.features.filter((f) => old.has(f.id) && JSON.stringify(old.get(f.id)) !== JSON.stringify(f));
  const parts: string[] = [];
  if (added.length) parts.push(`added ${list(names(added))}`);
  if (removed.length) parts.push(`deleted ${list(names(removed))}`);
  if (changed.length && tool !== "set_variables") parts.push(`changed ${list(names(changed))}`);
  if (JSON.stringify(before.variables ?? []) !== JSON.stringify(after.variables ?? [])) parts.push("changed the variables");
  if (JSON.stringify(before.partNames ?? {}) !== JSON.stringify(after.partNames ?? {})) parts.push("renamed a part");
  if (before.name !== after.name) parts.push("renamed the design");
  return say(parts.length ? parts.join("; ") : "changed the design");
}

export class LiveBridge implements LiveLink {
  private conn: LiveConnection | null = null;
  /** Has the connected tab said hello (so it's the one in use)? */
  private ready = false;
  private app = "";
  /** The whole document open in the tab, the Part Studio on show there, and its version. */
  doc: JuraCADDocument | null = null;
  studio = MAIN_STUDIO;
  version = 0;
  /** Counts the tabs that have connected (said hello): versions start again at 1 with each. */
  private link = 0;
  /** Which tab and version the session last took the design from ("link:version"), or null. */
  private adopted: string | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  /** The port listened on, or why the link couldn't start. */
  port: number | null = null;
  startProblem: string | null = null;

  constructor(
    readonly extensionVersion: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly replyTimeout = REPLY_TIMEOUT_MS,
    private readonly helloTimeout = HELLO_TIMEOUT_MS,
  ) {}

  /** The open design as the session should have it now. */
  private get current(): string {
    return `${this.link}:${this.version}`;
  }

  get connected(): boolean {
    return !!this.conn && this.ready;
  }

  private send(conn: LiveConnection, msg: ExtensionMessage): void {
    conn.send(JSON.stringify(msg));
  }

  /** A JuraCAD tab has opened the link. Only one tab at a time: a second is turned away, with the reason. */
  connect(conn: LiveConnection): void {
    if (this.conn && !this.ready) {
      // The tab holding the place never said hello: let the new one have it.
      this.log("Live link: a connection that never said hello was replaced by a new one.");
      const old = this.conn;
      this.disconnected(old);
      old.close(1008, "no hello");
    }
    if (this.conn) {
      this.send(conn, {
        type: "busy",
        message: "Another JuraCAD tab is already connected to Claude. Disconnect that one first (or close it), then click Connect to Claude here.",
      });
      conn.close(1008, "another tab is connected");
      return;
    }
    this.conn = conn;
    this.ready = false;
    conn.onMessage = (text) => this.receive(conn, text);
    conn.onClose = () => this.disconnected(conn);
    const timer = setTimeout(() => {
      if (conn === this.conn && !this.ready) this.refuse(conn, "JuraCAD didn't say hello in time. Click Connect to Claude again.");
    }, this.helloTimeout);
    (timer as { unref?: () => void }).unref?.();
  }

  private refuse(conn: LiveConnection, message: string): void {
    this.log(`Live link: ${message}`);
    this.send(conn, { type: "error", message });
    conn.close(1008, "bad message");
  }

  private readDesign(file: string): JuraCADDocument | null {
    const r = readDocumentFile(file, "The design from JuraCAD");
    return r.ok ? r.doc : null;
  }

  private receive(conn: LiveConnection, text: string): void {
    if (conn !== this.conn) return;
    const msg = parseAppMessage(text);
    if ("error" in msg) return this.refuse(conn, `JuraCAD sent ${msg.error}. Reload the JuraCAD page and connect again.`);
    if (!this.ready && msg.type !== "hello") return this.refuse(conn, "JuraCAD didn't say hello first. Reload the JuraCAD page and connect again.");
    switch (msg.type) {
      case "hello": {
        if (this.ready) return this.refuse(conn, "JuraCAD said hello twice.");
        const doc = this.readDesign(msg.file);
        if (!doc) return this.refuse(conn, "The design open in JuraCAD couldn't be read by the extension. Save it to a file and reload the page, or update the extension (Help › Use JuraCAD with Claude).");
        this.ready = true;
        this.link++;
        this.adopted = null;
        this.app = msg.app;
        this.setDesign(doc, msg.studio, msg.version);
        this.send(conn, { type: "welcome", protocol: 1, extension: this.extensionVersion });
        this.log(`Live link: connected to JuraCAD ${msg.app} ("${doc.name}").`);
        return;
      }
      case "doc": {
        if (!isNewer(this.version, msg.version)) return;
        const doc = this.readDesign(msg.file);
        if (!doc) return this.refuse(conn, "A change from JuraCAD couldn't be read. Reload the JuraCAD page and connect again.");
        this.setDesign(doc, msg.studio, msg.version);
        return;
      }
      case "applied":
      case "refused": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === "applied") {
          if (msg.version !== p.base + 1 || !isNewer(this.version, msg.version)) {
            // Shouldn't happen; if it does, start again cleanly rather than guess (the tool says so).
            p.resolve?.({ type: "disconnected" });
            return this.refuse(conn, "JuraCAD and the extension lost track of the design's versions. Click Connect to Claude again.");
          }
          this.doc = p.full;
          this.studio = p.studio;
          this.version = msg.version;
        }
        // (No one waiting: a late reply after giving up; the session takes the design afresh next time.)
        p.resolve?.(msg);
        return;
      }
    }
  }

  private setDesign(doc: JuraCADDocument, studio: string, version: number): void {
    this.doc = doc;
    this.studio = studioExists(doc, studio) ? studio : MAIN_STUDIO;
    this.version = version;
  }

  private disconnected(conn: LiveConnection): void {
    if (conn !== this.conn) return;
    this.conn = null;
    this.ready = false;
    // Whichever tab connects next, the session takes its design afresh.
    this.adopted = null;
    for (const p of this.pending.values()) p.resolve?.({ type: "disconnected" });
    this.pending.clear();
    this.log("Live link: JuraCAD disconnected.");
  }

  /** Close the link (the extension is stopping). */
  close(): void {
    this.conn?.close(1001, "Claude's JuraCAD extension stopped");
  }

  status(): LiveStatus {
    if (this.connected && this.doc) {
      const studio = studioName(this.doc, this.studio);
      const features = studioView(this.doc, this.studio).features.length;
      return {
        connected: true,
        text: `Live: connected to the user's open JuraCAD tab (JuraCAD ${this.app}). Design "${this.doc.name}", Part Studio "${studio}" (${features} feature${features === 1 ? "" : "s"}). Every tool works on it, and each change you make appears there straight away as one step in its undo list. The user can keep editing and undoing there too; if they change something at the same moment, your change is refused (nothing lost) and you just look again and retry. save_design still saves a .juracad file.`,
      };
    }
    const where = this.port ? `on this computer (port ${this.port})` : null;
    return {
      connected: false,
      text: this.startProblem
        ? `Live: not available — ${this.startProblem} The tools work on Claude's own copy of the design; save_design saves it as a .juracad file to open in JuraCAD.`
        : `Live: not connected. The tools work on Claude's own copy of the design (save_design saves it as a .juracad file). To build live in the user's open JuraCAD instead, ask them to open https://gm7dha.github.io/JuraCAD/ in Chrome or Edge and click "Connect to Claude" in the top bar (the extension is ready ${where ?? "for it"}). Safari can't connect to apps on the computer; there, use save_design and Open.`,
    };
  }

  /** Run one tool: on the open JuraCAD design when connected, one at a time, sending any change back. */
  call(s: Session, tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    const next = this.queue.then(() => this.callNow(s, tool, run));
    this.queue = next.catch(() => {});
    return next;
  }

  private async callNow(s: Session, tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    if (!this.connected || !this.doc) return run();
    if (this.adopted !== this.current) {
      s.adopt(studioView(this.doc, this.studio), { doc: this.doc, studio: this.studio });
      this.adopted = this.current;
    }
    // The version and Part Studio this change is made from (more may arrive from the tab while the tool runs).
    const base = this.version;
    const studioAtStart = this.studio;
    const snap = s.snapshot();
    const result = await run();
    const replaced = s.generation !== snap.generation;
    if (result.isError || (s.doc === snap.doc && !replaced)) return result;
    const conn = this.conn;
    if (!conn || !this.ready || !this.doc) {
      s.restore(snap);
      return this.notApplied("The JuraCAD tab disconnected before this change could be sent, so it wasn't made. Nothing was changed. Ask the user to click Connect to Claude again (or work on your own copy and save_design).");
    }
    const studio = replaced ? MAIN_STUDIO : studioAtStart;
    const id = this.nextId++;
    let full: JuraCADDocument;
    let label: string;
    let reply: Reply;
    let refreshed = false;
    try {
      const whole = replaced ? s.doc : s.wholeDoc();
      // Sketches on Plane features follow their planes, as the app does when it takes the change.
      full = refreshDocumentPlanes(whole, resolveVariables(whole.variables).values);
      refreshed = full !== whole;
      label = describeChange(tool, snap.doc, s.doc, replaced);
      const message = { type: "change", id, base, studio, file: serializeDocument(full), label, replace: replaced } as const;
      reply = await new Promise<Reply>((resolve) => {
        const p: Pending = { full, studio, base, resolve };
        this.pending.set(id, p);
        const timer = setTimeout(() => {
          // Keep listening for a while: if it's applied later, the bridge still learns the new version.
          p.resolve = null;
          resolve({ type: "timeout" });
          const forget = setTimeout(() => this.pending.get(id) === p && this.pending.delete(id), LATE_REPLY_MS);
          (forget as { unref?: () => void }).unref?.();
        }, this.replyTimeout);
        timer.unref?.();
        p.resolve = (r) => {
          clearTimeout(timer);
          p.resolve = null;
          resolve(r);
        };
        this.send(conn, message);
      });
    } catch (e) {
      this.pending.delete(id);
      s.restore(snap);
      this.adopted = null;
      return this.notApplied(`This change couldn't be sent to JuraCAD (${e instanceof Error ? e.message : String(e)}). Nothing was changed.`);
    }
    if (reply.type === "applied") {
      this.adopted = this.current;
      s.outer = { doc: full, studio };
      if (refreshed) s.doc = replaced ? full : studioView(full, studio);
      return { ...result, content: [...result.content, { type: "text", text: `Live: this now shows in the user's open JuraCAD tab, as one step in its undo list ("${label}").` }] };
    }
    s.restore(snap);
    // Take the tab's design afresh next time.
    this.adopted = null;
    if (reply.type === "refused") {
      return this.notApplied(
        reply.reason === "changed"
          ? "The user changed the design in JuraCAD at the same moment, so this change was NOT applied (nothing was lost or changed). Look at the design again (describe_design) and make the change again."
          : reply.reason === "busy"
            ? `JuraCAD didn't take this change: ${reply.message} Nothing was changed. Ask the user to finish what they're doing (✓ or ✗), then try again.`
            : `JuraCAD couldn't use this change (${reply.message}). Nothing was changed.`,
      );
    }
    if (reply.type === "disconnected") {
      return this.notApplied("The JuraCAD tab disconnected before it confirmed this change, so it may not have arrived. Nothing was changed here. Ask the user to click Connect to Claude again, then check with describe_design.");
    }
    return this.notApplied("The JuraCAD tab didn't confirm this change in time (it may be busy rebuilding a big design), so it may still appear there. Don't repeat it yet: run describe_design (it shows the design as the tab has it) and only redo the change if it's missing.");
  }

  private notApplied(why: string): ToolResult {
    return { content: [{ type: "text", text: why }], isError: true };
  }
}
