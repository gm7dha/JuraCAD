/**
 * A stand-in for the browser around Safari's link window, for tests: the
 * JuraCAD tab (an origin, its message listeners) and the popup it opens. The
 * popup runs the REAL link-window script (relayScript, exactly as served) with
 * a pretend `window`; postMessage between the two is delivered later (as in a
 * browser), as a copy, and only if the target origin matches — so the origin
 * rules are tested for real. Navigating the popup to a port where no
 * extension serves the page gives an "error page" (nothing answers there).
 */
import { relayScript } from "../../src/live/relayPage";
import type { RelayEnv, RelayWindow } from "../../src/live/relayTransport";

type Listener = (ev: { source: unknown; origin: string; data: unknown }) => void;

/** What the link window's script may make sockets with: `new WebSocket(url, protocol)`, with the page's origin. */
export type SocketMaker = (url: string, protocol: string, origin: string) => {
  readyState: number;
  close(code?: number, reason?: string): void;
  onopen: unknown;
  onmessage: unknown;
  onerror: unknown;
  onclose: unknown;
};

export interface SimOptions {
  /** The JuraCAD tab's origin. */
  tabOrigin: string;
  /** Ports where an extension serves the link window now. */
  served: () => readonly number[];
  /** The ports the served script may link to. */
  relayPorts: readonly number[];
  makeSocket: SocketMaker;
  allowLocal?: boolean;
  /** The browser blocks pop-ups. */
  blockPopups?: boolean;
}

const later = (fn: () => void) => setTimeout(fn, 0);
const copy = <T>(v: T): T => structuredClone(v);

class LoadedRelay {
  private listeners: Listener[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  private sockets: ReturnType<SocketMaker>[] = [];
  status = "";
  unloaded = false;
  constructor(
    readonly origin: string,
    opener: unknown,
    popup: SimPopup,
    opts: SimOptions,
    script: string,
  ) {
    const self = this;
    const win = {
      location: { origin },
      get opener() {
        return opener;
      },
      addEventListener(type: string, fn: Listener) {
        if (type === "message") self.listeners.push(fn);
      },
      close() {
        popup.close();
      },
    };
    const doc = {
      getElementById: (id: string) =>
        id === "status"
          ? {
              set textContent(t: string) {
                self.status = t;
              },
            }
          : null,
    };
    function PageSocket(this: unknown, url: string, protocol: string) {
      const s = opts.makeSocket(url, protocol, origin);
      self.sockets.push(s);
      return s;
    }
    const every = (fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      this.intervals.push(t);
      return t;
    };
    new Function("window", "document", "WebSocket", "setInterval", "clearInterval", script)(win, doc, PageSocket, every, clearInterval);
  }
  deliver(ev: { source: unknown; origin: string; data: unknown }): void {
    if (this.unloaded) return;
    this.listeners.forEach((f) => f(ev));
  }
  /** The page goes away: the browser closes its sockets and stops its timers. */
  unload(): void {
    if (this.unloaded) return;
    this.unloaded = true;
    this.intervals.forEach(clearInterval);
    for (const s of this.sockets) {
      try {
        if (s.readyState < 2) s.close(); // (a browser drops them at once; Node only allows plain codes here)
      } catch {
        // already closed
      }
    }
  }
  get openSockets(): number {
    return this.sockets.filter((s) => s.readyState < 2).length;
  }
}

export class SimPopup implements RelayWindow {
  closed = false;
  relay: LoadedRelay | null = null;
  /** Every address it was sent to, in order. */
  visited: string[] = [];
  constructor(private readonly sim: RelaySim) {}
  postMessage(message: unknown, targetOrigin: string): void {
    const relay = this.relay;
    if (this.closed || !relay || targetOrigin !== relay.origin) return;
    const data = copy(message);
    later(() => relay.deliver({ source: this.sim.tabProxy, origin: this.sim.opts.tabOrigin, data }));
  }
  close(): void {
    if (this.closed) return;
    this.relay?.unload();
    this.relay = null;
    this.closed = true;
  }
  go(url: string): void {
    this.relay?.unload();
    this.relay = null;
    this.visited.push(url);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/juracad-relay$/.exec(url);
    const port = m ? Number(m[1]) : NaN;
    if (!this.sim.opts.served().includes(port)) return; // an error page
    later(() => {
      if (this.closed || this.visited[this.visited.length - 1] !== url) return;
      this.relay = new LoadedRelay(`http://127.0.0.1:${port}`, this.sim.tabProxy, this, this.sim.opts, this.sim.script);
    });
  }
}

export class RelaySim {
  readonly script: string;
  private listeners = new Set<Listener>();
  popup: SimPopup | null = null;
  tabClosed = false;
  opened = 0;
  /** The tab as the popup sees it (window.opener). */
  readonly tabProxy: { readonly closed: boolean; postMessage(m: unknown, target: string): void };

  constructor(readonly opts: SimOptions) {
    this.script = relayScript({ ports: opts.relayPorts, allowLocal: opts.allowLocal });
    const sim = this;
    this.tabProxy = {
      get closed() {
        return sim.tabClosed;
      },
      postMessage(m: unknown, target: string) {
        const popup = sim.popup;
        if (sim.tabClosed || target !== sim.opts.tabOrigin || !popup?.relay) return;
        const data = copy(m);
        const origin = popup.relay.origin;
        later(() => sim.listeners.forEach((f) => f({ source: popup, origin, data })));
      },
    };
  }

  readonly env: RelayEnv = {
    open: (url) => {
      if (this.opts.blockPopups) return null;
      this.opened++;
      // Like a named window: opening it again reuses (and reloads) it.
      if (!this.popup || this.popup.closed) this.popup = new SimPopup(this);
      this.popup.go(url);
      return this.popup;
    },
    navigate: (win, url) => (win as SimPopup).go(url),
    listen: (fn) => {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    newSession: () => Math.random().toString(36).slice(2),
  };

  /** Send a message to the link window as some page would (for the rule checks). */
  sendAsIf(from: { source: unknown; origin: string }, data: unknown): void {
    this.popup?.relay?.deliver({ ...from, data: copy(data) });
  }
}
