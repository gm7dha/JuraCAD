/**
 * The link between JuraCAD and JuraCUT: one sends a flat design to the other, inside the browser.
 *
 * Both apps are pages of the same website (gm7dha.github.io), so their tabs can talk over a BroadcastChannel — nothing
 * leaves the computer. Every tab of either app opens one `LinkEnd`:
 *  - it says "here" when it starts (and when it's brought back into view), answers "who" with "here", and says "bye"
 *    when it closes, so each tab knows which tabs of the other app are open;
 *  - to send, it posts the parcel to the other app's tab seen most recently; if there's none, or none answers "got"
 *    within `answerWait`, it opens the other app in a new tab with `?link=<parcel id>` (still within the click, so the
 *    browser allows it — Chrome counts a click for 5 seconds) and waits;
 *  - a tab opened that way says "ready" for that parcel until it arrives, and the sender posts it to that tab;
 *  - the receiving tab puts the design in and answers "got" with what it did (or why it couldn't), which the sender
 *    shows. A parcel nobody takes is given up after `giveUp`.
 *
 * Messages come from other tabs of the same site, but they're still checked (`readMessage`): the right shape, known
 * apps, content within `MAX_CONTENT`. Pure: the channel, clock, timers and window opening are passed in, so tests drive
 * it without a browser. The same file is in JuraCAD (src/link/juraLink.ts) and JuraCUT: keep the two identical.
 */

export type AppName = "juracad" | "juracut";
export const APP_NAMES: readonly AppName[] = ["juracad", "juracut"];
export const APP_LABEL: Record<AppName, string> = { juracad: "JuraCAD", juracut: "JuraCUT" };
export const LINK_CHANNEL = "jura-link.v1";
/** The biggest design that can be sent (characters of SVG or DXF text). */
export const MAX_CONTENT = 20_000_000;

export interface Parcel {
  id: string;
  from: AppName;
  to: AppName;
  /** The design's name. */
  name: string;
  /** JuraCAD sends SVG (laser layers as colours); JuraCUT sends DXF (for a sketch). */
  kind: "svg" | "dxf";
  content: string;
}

export type LinkMessage =
  | { type: "who"; from: AppName; tab: string }
  | { type: "here"; app: AppName; tab: string }
  | { type: "bye"; tab: string }
  | { type: "ready"; app: AppName; tab: string; id: string }
  | { type: "parcel"; tab: string; parcel: Parcel }
  | { type: "got"; tab: string; id: string; ok: boolean; message: string };

const isApp = (x: unknown): x is AppName => x === "juracad" || x === "juracut";
const isText = (x: unknown, max = 200): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

/** A message from the channel, checked; null for anything else. */
export function readMessage(data: unknown): LinkMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case "who":
      return isApp(m.from) && isText(m.tab) ? { type: "who", from: m.from, tab: m.tab } : null;
    case "here":
      return isApp(m.app) && isText(m.tab) ? { type: "here", app: m.app, tab: m.tab } : null;
    case "bye":
      return isText(m.tab) ? { type: "bye", tab: m.tab } : null;
    case "ready":
      return isApp(m.app) && isText(m.tab) && isText(m.id) ? { type: "ready", app: m.app, tab: m.tab, id: m.id } : null;
    case "got":
      return isText(m.tab) && isText(m.id) && typeof m.ok === "boolean" && typeof m.message === "string" && m.message.length <= 2000
        ? { type: "got", tab: m.tab, id: m.id, ok: m.ok, message: m.message }
        : null;
    case "parcel": {
      const p = m.parcel as Record<string, unknown> | undefined;
      if (!isText(m.tab) || !p || typeof p !== "object") return null;
      if (!isText(p.id) || !isApp(p.from) || !isApp(p.to) || typeof p.name !== "string" || p.name.length > 200) return null;
      if ((p.kind !== "svg" && p.kind !== "dxf") || typeof p.content !== "string" || p.content.length > MAX_CONTENT) return null;
      return { type: "parcel", tab: m.tab, parcel: { id: p.id, from: p.from, to: p.to, name: p.name, kind: p.kind, content: p.content } };
    }
    default:
      return null;
  }
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface LinkEnv {
  channel: ChannelLike;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** Open the other app in a new tab (null when the browser stopped it). */
  openTab: (to: AppName, parcelId: string) => { focus(): void } | null;
  /** A new random id. */
  newId: () => string;
}

/** What a receiving tab did with a parcel, in plain words. */
export interface Received {
  ok: boolean;
  message: string;
}

/** How a send ended. */
export interface SendResult {
  ok: boolean;
  message: string;
  /** "tab": an open tab took it; "new": a tab opened for it took it; "none": nobody did. */
  via: "tab" | "new" | "none";
}

export interface LinkOptions {
  app: AppName;
  env: LinkEnv;
  /** Put a design that's arrived into this tab. */
  receive: (parcel: Parcel) => Received;
  /** This tab was opened for parcel `id` (its `?link=` value). */
  waitingFor?: string | null;
  /** How long to wait for an open tab to answer before opening a new one (ms). */
  answerWait?: number;
  /** How long a new tab may take to load and take the parcel (ms). */
  giveUp?: number;
  /** How often a new tab says "ready" until its parcel comes (ms), and for how long. */
  readyEvery?: number;
  readyFor?: number;
}

interface Pending {
  parcel: Parcel;
  /** The tab it was posted to, if any. */
  tab: string | null;
  via: "tab" | "new";
  opened: { focus(): void } | null;
  timer: unknown;
  done: (r: SendResult) => void;
}

export class LinkEnd {
  readonly tab: string;
  private readonly app: AppName;
  private readonly env: LinkEnv;
  private readonly receive: (parcel: Parcel) => Received;
  /** Tabs of either app seen, and when. */
  private readonly peers = new Map<string, { app: AppName; seen: number }>();
  private readonly pending = new Map<string, Pending>();
  /** Parcels this tab has taken (so one posted twice is only put in once). */
  private readonly taken = new Map<string, Received>();
  private waitingFor: string | null;
  private readyTimer: unknown = null;
  private readonly opts: Required<Pick<LinkOptions, "answerWait" | "giveUp" | "readyEvery" | "readyFor">>;

  constructor(o: LinkOptions) {
    this.app = o.app;
    this.env = o.env;
    this.receive = o.receive;
    this.tab = o.env.newId();
    this.waitingFor = o.waitingFor ?? null;
    this.opts = { answerWait: o.answerWait ?? 1500, giveUp: o.giveUp ?? 30000, readyEvery: o.readyEvery ?? 400, readyFor: o.readyFor ?? 20000 };
    this.env.channel.onmessage = (e) => {
      const m = readMessage(e.data);
      if (m) this.handle(m);
    };
    this.post({ type: "here", app: this.app, tab: this.tab });
    this.post({ type: "who", from: this.app, tab: this.tab });
    if (this.waitingFor) this.sayReady(this.env.now());
  }

  /** Is a tab of that app open (as far as this tab knows)? */
  peerOpen(app: AppName): boolean {
    return [...this.peers.values()].some((p) => p.app === app);
  }

  /** Say "here" again (when the tab comes back into view), and ask who's there. */
  wake(): void {
    this.post({ type: "here", app: this.app, tab: this.tab });
    this.post({ type: "who", from: this.app, tab: this.tab });
  }

  /** The tab is closing. */
  close(): void {
    this.post({ type: "bye", tab: this.tab });
    for (const p of this.pending.values()) this.env.clearTimer(p.timer);
    if (this.readyTimer !== null) this.env.clearTimer(this.readyTimer);
    this.env.channel.onmessage = null;
    this.env.channel.close();
  }

  /**
   * Send a design to the other app. Call it straight from the click: when no tab of the other app is open, the new tab
   * is opened before this returns. Resolves when it's been taken (or not).
   */
  send(to: AppName, name: string, kind: Parcel["kind"], content: string): Promise<SendResult> {
    const parcel: Parcel = { id: this.env.newId(), from: this.app, to, name: name.slice(0, 200), kind, content };
    if (content.length > MAX_CONTENT) return Promise.resolve({ ok: false, via: "none", message: `That design is too big to send to ${APP_LABEL[to]}. Save it as a file and open that instead.` });
    return new Promise((done) => {
      const tab = this.newestPeer(to);
      const p: Pending = { parcel, tab, via: tab ? "tab" : "new", opened: null, timer: null, done };
      this.pending.set(parcel.id, p);
      if (tab) {
        this.post({ type: "parcel", tab, parcel });
        p.timer = this.env.setTimer(() => this.noAnswer(parcel.id), this.opts.answerWait);
      } else this.openNew(p);
    });
  }

  private newestPeer(app: AppName): string | null {
    let best: [string, number] | null = null;
    for (const [tab, p] of this.peers) if (p.app === app && (!best || p.seen > best[1])) best = [tab, p.seen];
    return best ? best[0] : null;
  }

  /** The open tab didn't answer (it may have gone): forget it and open a new one. */
  private noAnswer(id: string): void {
    const p = this.pending.get(id);
    if (!p || p.via !== "tab") return;
    if (p.tab) this.peers.delete(p.tab);
    p.via = "new";
    p.tab = null;
    this.openNew(p);
  }

  private openNew(p: Pending): void {
    p.opened = this.env.openTab(p.parcel.to, p.parcel.id);
    const label = APP_LABEL[p.parcel.to];
    if (!p.opened) {
      // Blocked: it still goes to the first tab of that app that opens in the next while.
      p.timer = this.env.setTimer(() => this.finish(p.parcel.id, { ok: false, via: "none", message: `${label} didn't open (the browser may have stopped a new tab). Open ${label} yourself within half a minute and the design will go there, or allow pop-ups for this site.` }), this.opts.giveUp);
      return;
    }
    p.timer = this.env.setTimer(() => this.finish(p.parcel.id, { ok: false, via: "none", message: `${label} didn't answer. Check its tab has opened, then send again.` }), this.opts.giveUp);
  }

  private finish(id: string, r: SendResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.env.clearTimer(p.timer);
    this.pending.delete(id);
    p.done(r);
  }

  private sayReady(start: number): void {
    if (!this.waitingFor) return;
    this.post({ type: "ready", app: this.app, tab: this.tab, id: this.waitingFor });
    if (this.env.now() - start >= this.opts.readyFor) {
      this.waitingFor = null;
      return;
    }
    this.readyTimer = this.env.setTimer(() => this.sayReady(start), this.opts.readyEvery);
  }

  private handle(m: LinkMessage): void {
    switch (m.type) {
      case "who":
        if (m.tab !== this.tab) {
          this.peers.set(m.tab, { app: m.from, seen: this.env.now() });
          this.post({ type: "here", app: this.app, tab: this.tab });
        }
        return;
      case "here":
        if (m.tab === this.tab) return;
        this.peers.set(m.tab, { app: m.app, seen: this.env.now() });
        // A parcel whose new tab was blocked goes to the first tab of that app that turns up.
        for (const p of this.pending.values())
          if (p.via === "new" && !p.tab && p.parcel.to === m.app && !p.opened) {
            p.tab = m.tab;
            this.post({ type: "parcel", tab: m.tab, parcel: p.parcel });
          }
        return;
      case "bye":
        this.peers.delete(m.tab);
        return;
      case "ready": {
        const p = this.pending.get(m.id);
        if (!p || p.parcel.to !== m.app) return;
        p.tab = m.tab;
        this.post({ type: "parcel", tab: m.tab, parcel: p.parcel });
        return;
      }
      case "parcel": {
        if (m.tab !== this.tab || m.parcel.to !== this.app) return;
        if (this.waitingFor === m.parcel.id) {
          this.waitingFor = null;
          if (this.readyTimer !== null) this.env.clearTimer(this.readyTimer);
        }
        let r = this.taken.get(m.parcel.id);
        if (!r) {
          try {
            r = this.receive(m.parcel);
          } catch (e) {
            r = { ok: false, message: e instanceof Error ? e.message : String(e) };
          }
          this.taken.set(m.parcel.id, r);
        }
        this.post({ type: "got", tab: this.tab, id: m.parcel.id, ok: r.ok, message: r.message });
        return;
      }
      case "got": {
        const p = this.pending.get(m.id);
        if (!p || (p.tab && p.tab !== m.tab)) return;
        if (p.opened) p.opened.focus();
        this.finish(m.id, { ok: m.ok, via: p.via, message: m.message });
        return;
      }
    }
  }

  private post(m: LinkMessage): void {
    this.env.channel.postMessage(m);
  }
}

/** The other app's address on this site: JuraCAD is at /JuraCAD/, JuraCUT at /JuraCUT/ (any capitals). */
export function siblingUrl(base: string, origin: string, to: AppName, parcelId: string): string {
  const name = APP_LABEL[to];
  const path = /\/(JuraCAD|JuraCUT)\/?$/i.test(base) ? base.replace(/(JuraCAD|JuraCUT)\/?$/i, `${name}/`) : `/${name}/`;
  return `${origin}${path}?link=${encodeURIComponent(parcelId)}`;
}
