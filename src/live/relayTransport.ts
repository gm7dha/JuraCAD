/**
 * Safari's way to the extensions: the JuraCAD tab opens the extension's small
 * link window (src/live/relayPage.ts) and talks to it with postMessage; the
 * window opens the real WebSockets. This side makes each of those look like a
 * WebSocket to LiveClient (`makeSocket`), so the live link itself works
 * exactly as in Chrome and Firefox.
 *
 * `start()` must be called straight from the user's click (browsers only open
 * windows then): it opens the window on the first live port at once, and if
 * no extension answers there within `portWait` ms it moves the window on to
 * the next port, until one answers or none is left. Messages go only to the
 * window it opened, addressed to that window's exact origin
 * (http://127.0.0.1:<port>), and only replies from that window and origin with
 * this tab's session id are taken. Kept free of the DOM (it comes in through
 * `RelayEnv`), so it's tested in Node.
 */
import type { SocketLike } from "./client";
import { LIVE_PATH, LIVE_PORTS, parseRelayEvent, RELAY_TAG, RELAY_WINDOW, relayOrigin, relayUrl, type RelayEvent, type RelayRequest } from "./protocol";

/** The parts of the link window used here (a browser WindowProxy, or a stand-in in tests). */
export interface RelayWindow {
  readonly closed: boolean;
  postMessage(message: unknown, targetOrigin: string): void;
  close(): void;
}

/** What the transport needs from the browser. */
export interface RelayEnv {
  /** window.open(url, name, features): the window, or null if it was blocked. */
  open(url: string, name: string, features: string): RelayWindow | null;
  /** Send the window to another address (it's on another origin, so only this is allowed). */
  navigate(win: RelayWindow, url: string): void;
  /** Listen to postMessages arriving at this tab. Returns how to stop. */
  listen(fn: (ev: { source: unknown; origin: string; data: unknown }) => void): () => void;
  /** A fresh, unguessable id for this page's link. */
  newSession(): string;
  /**
   * The link window's name for this tab: the same across reloads of this tab
   * (so a reload takes over its old window), different in every other tab (so
   * one tab's Connect never reloads another's window). Optional: without it,
   * a fresh name is made once per page.
   */
  windowName?(): string;
}

/** Why the link stopped while linked: the window was closed, or it reloaded / left its page (or stopped answering). */
export type RelayLoss = "closed" | "broken";

export type RelayProblem = { title: string; help: string[] };

/** When the browser blocked the link window. */
export function popupBlockedHelp(): RelayProblem {
  return {
    title: "Safari blocked the link window",
    help: [
      "In Safari, JuraCAD connects to Claude through a small window. Safari stopped it from opening.",
      "Choose Safari › Settings for This Website… (or click the blocked-window icon in the address bar), set Pop-up Windows to Allow, then click Connect to Claude again.",
      "Or ask Claude to save the design as a .juracad file and open it here with Open.",
    ],
  };
}

/** When the link window found no JuraCAD extension on any port. */
export function relayNotFoundHelp(): RelayProblem {
  return {
    title: "Claude isn't connected",
    help: [
      "In Safari, JuraCAD connects through a small window from the JuraCAD extension in the Claude app. No extension answered, so it was closed.",
      "Make sure the Claude desktop app is open and the JuraCAD extension is installed, up to date (Help › Use JuraCAD with Claude — older versions can't link with Safari) and switched on (Claude › Settings › Extensions).",
      "Start a chat in Claude and ask it something about JuraCAD (the extension starts with the chat), then click Connect to Claude again.",
      "If you opened JuraCAD from the Dock (Add to Dock), open it in a normal Safari window for this instead.",
      "You can always ask Claude to save the design as a .juracad file and open it here with Open.",
    ],
  };
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class RelaySocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(
    readonly id: number,
    private readonly owner: RelayTransport,
  ) {}
  send(data: string): void {
    if (this.readyState === OPEN) this.owner.request({ kind: "send", id: this.id, data });
  }
  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.owner.request({ kind: "close", id: this.id });
  }
  /** The link window reported on this socket. */
  event(ev: RelayEvent): void {
    switch (ev.kind) {
      case "opened":
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this.onopen?.({});
        return;
      case "message":
        if (this.readyState === OPEN) this.onmessage?.({ data: ev.data });
        return;
      case "error":
        this.onerror?.({});
        return;
      case "closed":
        this.readyState = CLOSED;
        this.owner.forget(this.id);
        this.onclose?.({ code: ev.code, reason: ev.reason });
        return;
    }
  }
  /** The window is gone: this socket is too. */
  lost(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code: 1006, reason: "the link window was closed" });
  }
}

/** Timings (ms). */
export interface RelayTiming {
  /** How long to wait for an extension's link window to answer before trying the next port. */
  portWait: number;
  /** How often to ask the window whether it's there, while waiting, and to check it hasn't been closed. */
  tick: number;
  /** While linked: how often to check the window is still the same page and answering. */
  heartbeat: number;
  /** While linked: the window counts as gone after this long without an answer (and `MISSED_PINGS` unanswered checks). */
  deadAfter: number;
}
export const RELAY_TIMING: RelayTiming = { portWait: 3_000, tick: 250, heartbeat: 1_000, deadAfter: 8_000 };
/**
 * Unanswered checks needed (as well as `deadAfter`) before the window counts
 * as gone — so a tab whose timers the browser slows right down while it's in
 * the background (one check a minute, say) isn't mistaken for a dead link.
 */
export const MISSED_PINGS = 4;

export const RELAY_FEATURES = "popup,width=440,height=280";

export class RelayTransport {
  private win: RelayWindow | null = null;
  private port = 0;
  private session = "";
  private ready = false;
  private sockets = new Map<number, RelaySocket>();
  private nextId = 1;
  private unlisten: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The port whose extension served the window last time (tried first next time). */
  private lastPort: number | null = null;
  /** Ends a start() still waiting (stopped before any window answered). */
  private cancel: (() => void) | null = null;
  /** The page load of the link window that answered (it puts a fresh id in every reply). */
  private load = "";
  /** When the window last answered, and how many checks have gone unanswered since. */
  private lastPong = 0;
  private missed = 0;
  private sinceBeat = 0;
  /** This tab's window name (see RelayEnv.windowName). */
  private name: string | null = null;
  /** Called when the link stops while linked: the window was closed, or it reloaded or left its page. */
  onLost: (why: RelayLoss) => void = () => {};
  private readonly timing: RelayTiming;

  constructor(
    private readonly env: RelayEnv,
    private readonly ports: readonly number[] = LIVE_PORTS,
    timing: Partial<RelayTiming> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.timing = { ...RELAY_TIMING, ...timing };
  }

  /** The name the link window is opened with (one per tab). */
  get windowName(): string {
    if (this.name === null) {
      let given = "";
      try {
        given = this.env.windowName?.() ?? "";
      } catch {
        given = "";
      }
      this.name = given || `${RELAY_WINDOW}-${this.env.newSession()}`;
    }
    return this.name;
  }

  get linked(): boolean {
    return this.ready && !!this.win && !this.win.closed;
  }

  /** The port whose extension serves the link window (0 = none yet). */
  get windowPort(): number {
    return this.ready ? this.port : 0;
  }

  /**
   * Open the link window (call straight from a click) and wait until an
   * extension's window answers. Resolves null when linked, or what to tell the user.
   */
  start(): Promise<RelayProblem | null> {
    this.stop();
    const order = this.lastPort !== null && this.ports.includes(this.lastPort) ? [this.lastPort, ...this.ports.filter((p) => p !== this.lastPort)] : [...this.ports];
    this.session = this.env.newSession();
    this.port = order[0];
    let win: RelayWindow | null = null;
    try {
      win = this.env.open(relayUrl(this.port), this.windowName, RELAY_FEATURES);
    } catch {
      win = null;
    }
    if (!win) return Promise.resolve(popupBlockedHelp());
    this.win = win;
    const session = this.session;
    return new Promise((resolve) => {
      let index = 0;
      let since = 0;
      let settled = false;
      const settle = (r: RelayProblem | null) => {
        if (settled) return;
        settled = true;
        this.cancel = null;
        resolve(r);
      };
      this.cancel = () => settle({ title: "Not connected", help: ["Connecting was stopped. Click Connect to Claude to try again."] });
      this.unlisten = this.env.listen((ev) => this.receive(ev, session, () => settle(null)));
      this.timer = setInterval(() => {
        if (this.session !== session || !this.win) return settle(relayNotFoundHelp());
        if (this.win.closed) {
          const wasReady = this.ready;
          settle({ title: "The link window was closed", help: ["In Safari, JuraCAD connects to Claude through a small window that has to stay open. Click Connect to Claude to open it again."] });
          this.stop();
          if (wasReady) this.onLost("closed");
          return;
        }
        if (this.ready) {
          this.heartbeat();
          return;
        }
        since += this.timing.tick;
        if (since >= this.timing.portWait) {
          since = 0;
          index++;
          if (index >= order.length) {
            settle(relayNotFoundHelp());
            this.stop();
            return;
          }
          this.port = order[index];
          try {
            this.env.navigate(this.win, relayUrl(this.port));
          } catch {
            settle(relayNotFoundHelp());
            this.stop();
            return;
          }
        }
        this.post({ kind: "ping" });
      }, this.timing.tick);
      this.post({ kind: "ping" });
    });
  }

  /**
   * While linked: ask the window now and then. If it stops answering (it was
   * sent Back, or to another address), the link is gone — it can't tell us.
   */
  private heartbeat(): void {
    this.sinceBeat += this.timing.tick;
    if (this.sinceBeat < this.timing.heartbeat) return;
    this.sinceBeat = 0;
    if (this.missed >= MISSED_PINGS && this.now() - this.lastPong >= this.timing.deadAfter) return this.broken();
    this.missed++;
    this.post({ kind: "ping" });
  }

  /** The window reloaded or left its page: its links went with it. Tell LiveClient (every socket closes). */
  private broken(): void {
    if (!this.ready) return;
    this.stop();
    this.onLost("broken");
  }

  private post(msg: { kind: RelayRequest["kind"] } & Record<string, unknown>): void {
    if (!this.win || this.win.closed) return;
    try {
      // Addressed to the exact origin: if the window is anywhere else (an error page, another site), it isn't delivered.
      this.win.postMessage({ ...msg, juracad: RELAY_TAG, session: this.session }, relayOrigin(this.port));
    } catch {
      // The window is going away.
    }
  }

  /** Send a request to the link window (for the sockets). */
  request(msg: { kind: "send"; id: number; data: string } | { kind: "close"; id: number }): void {
    if (this.ready) this.post(msg);
  }

  forget(id: number): void {
    this.sockets.delete(id);
  }

  private receive(ev: { source: unknown; origin: string; data: unknown }, session: string, linked: () => void): void {
    if (session !== this.session || !this.win || ev.source !== this.win || ev.origin !== relayOrigin(this.port)) return;
    const msg = parseRelayEvent(ev.data, session);
    if (!msg) return;
    if (msg.kind === "pong") {
      if (!this.ready) {
        this.ready = true;
        this.load = msg.load;
        this.lastPong = this.now();
        this.missed = 0;
        this.sinceBeat = 0;
        this.lastPort = this.port;
        linked();
        return;
      }
      // Another page load answering: the window was reloaded (or went Back and Forward), and its links are gone.
      if (msg.load !== this.load) return this.broken();
      this.lastPong = this.now();
      this.missed = 0;
      return;
    }
    if (!this.ready) return;
    this.sockets.get(msg.id)?.event(msg);
  }

  /** A WebSocket look-alike through the link window, for LiveClient. Throws if the window isn't linked. */
  makeSocket = (url: string, _protocol: string): SocketLike => {
    const m = /^ws:\/\/127\.0\.0\.1:(\d+)(\/[^?#]*)$/.exec(url);
    if (!this.linked || !m || m[2] !== LIVE_PATH) throw new Error("The link window isn't open.");
    const port = Number(m[1]);
    const socket = new RelaySocket(this.nextId++, this);
    this.sockets.set(socket.id, socket);
    this.post({ kind: "open", id: socket.id, port });
    return socket;
  };

  /** Close every link and the window (the user disconnected, or the page is going away). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const cancel = this.cancel;
    this.cancel = null;
    this.unlisten?.();
    this.unlisten = null;
    if (this.ready) this.post({ kind: "bye" });
    const win = this.win;
    this.win = null;
    this.ready = false;
    this.session = "";
    this.load = "";
    this.missed = 0;
    this.sinceBeat = 0;
    for (const s of [...this.sockets.values()]) s.lost();
    this.sockets.clear();
    if (win && !win.closed) {
      try {
        win.close();
      } catch {
        // Not ours to close any more.
      }
    }
    cancel?.();
  }
}
