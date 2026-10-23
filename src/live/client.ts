/**
 * "Live with Claude", the app's side: connects (only when the user clicks
 * Connect to Claude) to every JuraCAD extension running on this computer —
 * Claude starts one for each chat — sends each of them the design and every
 * change the user makes, and applies Claude's changes from any of them.
 * While connected it looks again every few seconds, so a chat started later
 * is linked too, and one that has stopped is dropped quietly. Kept free of
 * React and the store (they come in through `LiveHost`), so it's tested in
 * Node against real extension links.
 */
import { decideChange, LIVE_PATH, LIVE_PORTS, LIVE_SUBPROTOCOL, MAX_MESSAGE_BYTES, parseExtensionMessage, type AppMessage } from "./protocol";

export type BrowserKind = "chrome" | "edge" | "firefox" | "safari" | "other";
export type PermissionState = "granted" | "denied" | "prompt" | "unknown";

/** What the app gives the live link. */
export interface LiveHost {
  appVersion: string;
  browser: BrowserKind;
  /** The design now. `key` changes whenever the design or the Part Studio on show does. */
  current(): { key: unknown; studio: string; file: () => string };
  /** Why a change from Claude can't be applied right now (a dialog is open…), or null. */
  busy(): string | null;
  /** Apply Claude's change as one undo step. Returns a problem in words, or null when done. */
  apply(file: string, studio: string, label: string, replace: boolean): string | null;
  /** Call `listener` after every change in the app. Returns how to stop. */
  subscribe(listener: () => void): () => void;
  /** The browser's "apps on this device" (loopback) permission, if it can tell. */
  permission?: () => Promise<PermissionState>;
}

/** The parts of a WebSocket used here (the browser's own, or Node's in tests). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string, protocol: string) => SocketLike;

export type LiveState =
  | { kind: "off"; notice?: string }
  | { kind: "connecting"; message: string }
  | { kind: "connected"; extension: string; chats: number; last: string | null }
  | { kind: "failed"; title: string; help: string[] };

const OPEN = 1;

/** Plain-English advice when no extension answered, for this browser. */
export function notFoundHelp(browser: BrowserKind): { title: string; help: string[] } {
  if (browser === "safari") {
    return {
      title: "Safari can't connect to Claude",
      help: [
        "Safari doesn't let websites talk to apps on your computer, so the live link only works in Chrome or Edge.",
        "Open JuraCAD in Chrome or Edge and click Connect to Claude there — or, in Safari, ask Claude to save the design and open the .juracad file here with Open.",
      ],
    };
  }
  return {
    title: "Claude isn't connected",
    help: [
      "Make sure the Claude desktop app is open and the JuraCAD extension is installed and switched on (Claude › Settings › Extensions). Get the latest from Help › Use JuraCAD with Claude — older versions can't connect live.",
      "Start a chat in Claude and ask it something about JuraCAD (the extension starts with the chat), then click Connect to Claude again.",
      ...(browser === "firefox"
        ? ["If Firefox asks whether JuraCAD may use \"apps and services on this device\", choose Allow. If it still won't connect, use Chrome or Edge."]
        : ["If your browser asks whether JuraCAD may reach apps on this device (local network access), click Allow."]),
      "You can always ask Claude to save the design as a .juracad file and open it here with Open instead.",
    ],
  };
}

/** Advice when the browser has been told not to let JuraCAD reach apps on this computer. */
export function blockedHelp(browser: BrowserKind): { title: string; help: string[] } {
  return {
    title: "Your browser is blocking the connection",
    help: [
      browser === "firefox"
        ? "Firefox has been told not to let JuraCAD use apps and services on this device. Click the icon at the left of the address bar, allow it, and try again."
        : "Your browser has been told not to let JuraCAD reach apps on this device. Click the icon at the left of the address bar (Site settings), set \"Apps on this device\" / \"Local network access\" to Allow, then reload the page and try again.",
      "Or ask Claude to save the design as a .juracad file and open it here with Open.",
    ],
  };
}

/** One linked JuraCAD extension (one Claude chat): its own socket and its own version count. */
interface Link {
  socket: SocketLike;
  port: number;
  extension: string;
  version: number;
  lastKey: unknown;
}

type Outcome = { link: Link } | "nothing" | { title: string; help: string[] };

export class LiveClient {
  state: LiveState = { kind: "off" };
  private links = new Map<number, Link>();
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  /** Bumped by connect/disconnect so an attempt that's been given up on stops. */
  private attempt = 0;
  /** True while Claude's change is being applied (the store tells its listeners straight away: that's not the user). */
  private applying = false;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private probing = new Set<number>();
  /** Ports whose chat belongs to another JuraCAD tab: not asked again for a while. */
  private skipUntil = new Map<number, number>();
  private last: string | null = null;

  constructor(
    private readonly host: LiveHost,
    private readonly makeSocket: SocketFactory,
    private readonly ports: readonly number[] = LIVE_PORTS,
    private readonly timeouts = { open: 5_000, openWithPrompt: 60_000, welcome: 20_000, recheck: 4_000 },
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(s: LiveState): void {
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }

  get connected(): boolean {
    return this.state.kind === "connected";
  }

  /** How many Claude chats are linked now. */
  get chats(): number {
    return this.links.size;
  }

  /** The ports linked (for tests and the details). */
  get linkedPorts(): number[] {
    return [...this.links.keys()].sort((a, b) => a - b);
  }

  private showConnected(): void {
    const newest = [...this.links.values()].pop();
    this.setState({ kind: "connected", extension: newest?.extension ?? "", chats: this.links.size, last: this.last });
  }

  /** Look on every port for running extensions and link them all. Only ever started by the user's click. */
  async connect(): Promise<LiveState> {
    if (this.state.kind === "connected" || this.state.kind === "connecting") return this.state;
    const attempt = ++this.attempt;
    this.setState({ kind: "connecting", message: "Looking for Claude on this computer…" });
    const permission = (await this.host.permission?.().catch(() => "unknown" as const)) ?? "unknown";
    if (attempt !== this.attempt) return this.state;
    if (permission === "denied") return this.fail(blockedHelp(this.host.browser));
    if (permission === "prompt") {
      this.setState({ kind: "connecting", message: "Your browser may ask whether JuraCAD can reach apps on this device — click Allow." });
    }
    const wait = permission === "prompt" ? this.timeouts.openWithPrompt : this.timeouts.open;
    const outcomes = await Promise.all(this.ports.map((port) => this.tryPort(port, wait, attempt)));
    if (attempt !== this.attempt) {
      outcomes.forEach((o) => typeof o === "object" && "link" in o && this.closeSocket(o.link.socket));
      return this.state;
    }
    for (const o of outcomes) if (typeof o === "object" && "link" in o) this.adopt(o.link);
    if (this.links.size) {
      this.unsubscribe = this.host.subscribe(() => this.pushAll());
      this.showConnected();
      this.scheduleRecheck();
      return this.state;
    }
    const reason = outcomes.find((o): o is { title: string; help: string[] } => typeof o === "object" && !("link" in o));
    if (reason) return this.fail(reason);
    const after = (await this.host.permission?.().catch(() => "unknown" as const)) ?? "unknown";
    return this.fail(after === "denied" ? blockedHelp(this.host.browser) : notFoundHelp(this.host.browser));
  }

  private fail(f: { title: string; help: string[] }): LiveState {
    this.setState({ kind: "failed", ...f });
    return this.state;
  }

  /** While connected: look again for extensions started since (a new Claude chat), every few seconds. */
  private scheduleRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    const attempt = this.attempt;
    this.recheckTimer = setTimeout(async () => {
      this.recheckTimer = null;
      if (attempt !== this.attempt || !this.connected) return;
      const now = Date.now();
      const free = this.ports.filter((p) => !this.links.has(p) && !this.probing.has(p) && (this.skipUntil.get(p) ?? 0) <= now);
      free.forEach((p) => this.probing.add(p));
      const outcomes = await Promise.all(free.map((port) => this.tryPort(port, this.timeouts.open, attempt)));
      free.forEach((p) => this.probing.delete(p));
      if (attempt !== this.attempt || !this.connected) {
        outcomes.forEach((o) => typeof o === "object" && "link" in o && this.closeSocket(o.link.socket));
        return;
      }
      const added = outcomes.filter((o): o is { link: Link } => typeof o === "object" && "link" in o);
      for (const o of added) this.adopt(o.link);
      if (added.length) {
        // The design may have changed while saying hello: bring the new ones up to date.
        this.pushAll();
        this.showConnected();
      }
      this.scheduleRecheck();
    }, this.timeouts.recheck);
  }

  private closeSocket(socket: SocketLike): void {
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try {
      socket.close(1000, "disconnected");
    } catch {
      // already closed
    }
  }

  /** Open one port and say hello: the link, "nothing" there, or a reason to give up. */
  private tryPort(port: number, openTimeout: number, attempt: number): Promise<Outcome> {
    return new Promise((resolve) => {
      let socket: SocketLike;
      try {
        socket = this.makeSocket(`ws://127.0.0.1:${port}${LIVE_PATH}`, LIVE_SUBPROTOCOL);
      } catch {
        // The browser refused outright (e.g. Safari: an https page may not use ws://).
        resolve(notFoundHelp(this.host.browser));
        return;
      }
      let settled = false;
      let hello: { key: unknown } | null = null;
      const done = (r: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof r !== "object" || !("link" in r)) this.closeSocket(socket);
        resolve(r);
      };
      let timer = setTimeout(() => done("nothing"), openTimeout);
      socket.onerror = () => done("nothing");
      socket.onclose = () => done("nothing");
      socket.onopen = () => {
        if (attempt !== this.attempt) return done("nothing");
        clearTimeout(timer);
        timer = setTimeout(() => done({ title: "Claude didn't answer", help: ["The JuraCAD extension was found but didn't reply. Restart the Claude desktop app, then click Connect to Claude again."] }), this.timeouts.welcome);
        const now = this.host.current();
        const file = now.file();
        if (file.length > MAX_MESSAGE_BYTES) {
          done({ title: "This design is too big to share live", help: ["Ask Claude to work on a saved .juracad file instead, or remove large imported models."] });
          return;
        }
        hello = { key: now.key };
        this.sendTo(socket, { type: "hello", protocol: 1, app: this.host.appVersion, version: 1, studio: now.studio, file });
      };
      socket.onmessage = (ev) => {
        const msg = parseExtensionMessage(String(ev.data));
        if ("error" in msg) return done({ title: "Claude's extension didn't understand JuraCAD", help: ["Update the JuraCAD extension (Help › Use JuraCAD with Claude) and reload this page."] });
        // Another tab has that chat: not ours to link (others may still be free).
        if (msg.type === "busy") {
          this.skipUntil.set(port, Date.now() + 30_000);
          return done({ title: "Another JuraCAD tab is connected", help: [msg.message] });
        }
        if (msg.type === "error") return done({ title: "Claude's extension couldn't connect", help: [msg.message] });
        if (msg.type !== "welcome" || !hello) return done({ title: "Claude's extension didn't say hello", help: ["Update the JuraCAD extension (Help › Use JuraCAD with Claude) and reload this page."] });
        if (attempt !== this.attempt) return done("nothing");
        done({ link: { socket, port, extension: msg.extension, version: 1, lastKey: hello.key } });
      };
    });
  }

  private adopt(link: Link): void {
    this.links.set(link.port, link);
    link.socket.onmessage = (ev) => this.receive(link, String(ev.data));
    link.socket.onerror = null;
    link.socket.onclose = () => this.dropped(link);
  }

  private sendTo(socket: SocketLike, msg: AppMessage): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
  }

  /** Send the design to every linked chat that hasn't seen it yet (the user changed it, or switched Part Studio). */
  private pushAll(): void {
    if (this.applying) return;
    for (const link of [...this.links.values()]) this.pushTo(link);
  }

  private pushTo(link: Link): void {
    const now = this.host.current();
    if (now.key === link.lastKey) return;
    link.lastKey = now.key;
    const file = now.file();
    if (file.length > MAX_MESSAGE_BYTES) {
      this.disconnect("The design is now too big to share live, so JuraCAD disconnected from Claude.");
      return;
    }
    link.version++;
    this.sendTo(link.socket, { type: "doc", version: link.version, studio: now.studio, file });
  }

  private receive(link: Link, text: string): void {
    if (this.links.get(link.port) !== link) return;
    const msg = parseExtensionMessage(text);
    if ("error" in msg || msg.type === "welcome" || msg.type === "busy") return;
    if (msg.type === "error") {
      this.dropped(link, msg.message);
      return;
    }
    // Anything the user did just before this arrived goes first (and makes the change out of date).
    this.pushAll();
    const decision = decideChange(link.version, msg.base, this.host.busy());
    if (!decision.apply) {
      this.sendTo(link.socket, { type: "refused", id: msg.id, version: link.version, reason: decision.reason, message: decision.message });
      return;
    }
    this.applying = true;
    let problem: string | null;
    try {
      problem = this.host.apply(msg.file, msg.studio, msg.label, msg.replace);
    } catch (e) {
      problem = `JuraCAD couldn't show it (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      this.applying = false;
    }
    if (problem) {
      this.sendTo(link.socket, { type: "refused", id: msg.id, version: link.version, reason: "invalid", message: problem });
      return;
    }
    link.version = decision.version;
    // The change is on show: not something to send back to the chat that made it...
    link.lastKey = this.host.current().key;
    this.sendTo(link.socket, { type: "applied", id: msg.id, version: link.version });
    // ...but every other linked chat gets the new design.
    this.pushAll();
    this.last = msg.label;
    if (this.state.kind === "connected") this.showConnected();
  }

  /** A linked chat went away (its extension stopped): drop it quietly, unless it was the last. */
  private dropped(link: Link, why?: string): void {
    if (this.links.get(link.port) !== link) return;
    this.links.delete(link.port);
    this.closeSocket(link.socket);
    if (this.links.size) {
      if (this.state.kind === "connected") this.showConnected();
      return;
    }
    this.stop(why ?? "Claude disconnected (the Claude app or its JuraCAD extension stopped). Click Connect to Claude to connect again.");
  }

  private stop(notice: string): void {
    this.attempt++;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const link of this.links.values()) this.closeSocket(link.socket);
    this.links.clear();
    this.skipUntil.clear();
    this.last = null;
    this.setState(notice ? { kind: "off", notice } : { kind: "off" });
  }

  /** The user clicked Disconnect (or the link must stop). */
  disconnect(notice?: string): void {
    this.stop(notice ?? "");
  }
}
