/**
 * "Live with Claude", the app's side: connects (only when the user clicks
 * Connect to Claude) to the JuraCAD extension running in the Claude desktop
 * app on this computer, sends the design and every change the user makes, and
 * applies Claude's changes. Kept free of React and the store (they come in
 * through `LiveHost`), so it's tested in Node against the real extension link.
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
  | { kind: "connected"; extension: string; port: number; last: string | null }
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

export class LiveClient {
  state: LiveState = { kind: "off" };
  private socket: SocketLike | null = null;
  private port = 0;
  private version = 0;
  private lastKey: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  /** Bumped by connect/disconnect so an attempt that's been given up on stops. */
  private attempt = 0;
  /** True while Claude's change is being applied (the store tells its listeners straight away: that's not the user). */
  private applying = false;

  constructor(
    private readonly host: LiveHost,
    private readonly makeSocket: SocketFactory,
    private readonly ports: readonly number[] = LIVE_PORTS,
    private readonly timeouts = { open: 5_000, openWithPrompt: 60_000, welcome: 20_000 },
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

  /** Try each port until the extension answers. Only ever called from the user's click. */
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
    let first = true;
    for (const port of this.ports) {
      const r = await this.tryPort(port, first && permission === "prompt" ? this.timeouts.openWithPrompt : this.timeouts.open, attempt);
      first = false;
      if (attempt !== this.attempt) return this.state;
      if (r === "connected") return this.state;
      if (typeof r === "object") return this.fail(r);
    }
    const after = (await this.host.permission?.().catch(() => "unknown" as const)) ?? "unknown";
    return this.fail(after === "denied" ? blockedHelp(this.host.browser) : notFoundHelp(this.host.browser));
  }

  private fail(f: { title: string; help: string[] }): LiveState {
    this.setState({ kind: "failed", ...f });
    return this.state;
  }

  /** "connected", "next" (nothing there: try the next port), or a reason to stop trying. */
  private tryPort(port: number, openTimeout: number, attempt: number): Promise<"connected" | "next" | { title: string; help: string[] }> {
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
      const done = (r: "connected" | "next" | { title: string; help: string[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (r !== "connected") {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          try {
            socket.close();
          } catch {
            // already closed
          }
        }
        resolve(r);
      };
      let timer = setTimeout(() => done("next"), openTimeout);
      socket.onerror = () => done("next");
      socket.onclose = () => done("next");
      socket.onopen = () => {
        if (attempt !== this.attempt) return done("next");
        clearTimeout(timer);
        timer = setTimeout(() => done({ title: "Claude didn't answer", help: ["The JuraCAD extension was found but didn't reply. Restart the Claude desktop app, then click Connect to Claude again."] }), this.timeouts.welcome);
        const now = this.host.current();
        const file = now.file();
        if (file.length > MAX_MESSAGE_BYTES) {
          done({ title: "This design is too big to share live", help: ["Ask Claude to work on a saved .juracad file instead, or remove large imported models."] });
          return;
        }
        this.version = 1;
        this.lastKey = now.key;
        this.sendTo(socket, { type: "hello", protocol: 1, app: this.host.appVersion, version: this.version, studio: now.studio, file });
      };
      socket.onmessage = (ev) => {
        const msg = parseExtensionMessage(String(ev.data));
        if ("error" in msg) return done({ title: "Claude's extension didn't understand JuraCAD", help: ["Update the JuraCAD extension (Help › Use JuraCAD with Claude) and reload this page."] });
        if (msg.type === "busy") return done({ title: "Another JuraCAD tab is connected", help: [msg.message] });
        if (msg.type === "error") return done({ title: "Claude's extension couldn't connect", help: [msg.message] });
        if (msg.type !== "welcome") return done({ title: "Claude's extension didn't say hello", help: ["Update the JuraCAD extension (Help › Use JuraCAD with Claude) and reload this page."] });
        if (attempt !== this.attempt) return done("next");
        done("connected");
        this.started(socket, port, msg.extension);
      };
    });
  }

  private sendTo(socket: SocketLike, msg: AppMessage): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
  }

  private started(socket: SocketLike, port: number, extension: string): void {
    this.socket = socket;
    this.port = port;
    this.setState({ kind: "connected", extension, port, last: null });
    socket.onmessage = (ev) => this.receive(String(ev.data));
    socket.onerror = null;
    socket.onclose = () => this.closed("Claude disconnected (the Claude app or its JuraCAD extension stopped). Click Connect to Claude to connect again.");
    this.unsubscribe = this.host.subscribe(() => this.pushIfChanged());
  }

  /** Send the design if the user changed it (or switched Part Studio). */
  private pushIfChanged(): void {
    if (!this.socket || this.applying) return;
    const now = this.host.current();
    if (now.key === this.lastKey) return;
    this.lastKey = now.key;
    const file = now.file();
    if (file.length > MAX_MESSAGE_BYTES) {
      this.disconnect("The design is now too big to share live, so JuraCAD disconnected from Claude.");
      return;
    }
    this.version++;
    this.sendTo(this.socket, { type: "doc", version: this.version, studio: now.studio, file });
  }

  private receive(text: string): void {
    const socket = this.socket;
    if (!socket) return;
    const msg = parseExtensionMessage(text);
    if ("error" in msg || msg.type === "welcome" || msg.type === "busy") return;
    if (msg.type === "error") {
      this.disconnect(msg.message);
      return;
    }
    // Anything the user did just before this arrived goes first (and makes the change out of date).
    this.pushIfChanged();
    const decision = decideChange(this.version, msg.base, this.host.busy());
    if (!decision.apply) {
      this.sendTo(socket, { type: "refused", id: msg.id, version: this.version, reason: decision.reason, message: decision.message });
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
      this.sendTo(socket, { type: "refused", id: msg.id, version: this.version, reason: "invalid", message: problem });
      return;
    }
    this.version = decision.version;
    // The change is now on show: not something to send back.
    this.lastKey = this.host.current().key;
    this.sendTo(socket, { type: "applied", id: msg.id, version: this.version });
    if (this.state.kind === "connected") this.setState({ ...this.state, last: msg.label });
  }

  private closed(notice: string): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.socket = null;
    this.setState({ kind: "off", notice });
  }

  /** The user clicked Disconnect (or the link must stop). */
  disconnect(notice?: string): void {
    this.attempt++;
    const s = this.socket;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      try {
        s.close(1000, "disconnected");
      } catch {
        // already closed
      }
    }
    this.closed(notice ?? "");
    if (!notice) this.setState({ kind: "off" });
  }

  /** The port connected on (for tests and the status line). */
  get connectedPort(): number {
    return this.port;
  }
}
