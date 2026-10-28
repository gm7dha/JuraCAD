/**
 * Safari's link window (src/live/relayPage.ts, the script exactly as the
 * extension serves it) and the tab's side of it (src/live/relayTransport.ts),
 * with pretend WebSockets. The real extension, end to end, is in
 * tests/liveLink.test.ts ("Safari: through the link window").
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_PATH,
  LIVE_PORTS,
  LIVE_SUBPROTOCOL,
  MAX_MESSAGE_BYTES,
  parseRelayEvent,
  RELAY_MAX_SOCKETS,
  RELAY_PATH,
  RELAY_SCRIPT_PATH,
  RELAY_TAG,
  relayOriginAllowed,
  relayUrl,
} from "../src/live/protocol";
import { relayHeaders, relayPageHtml, relayScript } from "../src/live/relayPage";
import { RelayTransport } from "../src/live/relayTransport";
import { relayPageFor, upgradeProblem } from "../src/mcp/websocket";
import { RelaySim, type SocketMaker } from "./support/relaySim";

const SITE = "https://gm7dha.github.io";
// Close every window and stop every transport after each test (their timers would keep running).
const made: { sims: RelaySim[]; transports: RelayTransport[] } = { sims: [], transports: [] };
afterEach(() => {
  made.transports.splice(0).forEach((t) => t.stop());
  made.sims.splice(0).forEach((s) => s.popup?.close());
});
const track = <T extends RelaySim | RelayTransport>(x: T): T => {
  if (x instanceof RelaySim) made.sims.push(x);
  else made.transports.push(x as RelayTransport);
  return x;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(5);
  }
}

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocol: string,
    readonly origin: string,
  ) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closedWith = code;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}
const fakeSockets: SocketMaker = (url, protocol, origin) => new FakeWS(url, protocol, origin);

/** A tab and its link window (served on LIVE_PORTS[0]) with pretend sockets; `got` collects what the window says back. */
async function linkWindow(opts: { tabOrigin?: string; allowLocal?: boolean } = {}) {
  FakeWS.all = [];
  const sim = track(new RelaySim({ tabOrigin: opts.tabOrigin ?? SITE, served: () => [LIVE_PORTS[0]], relayPorts: LIVE_PORTS, makeSocket: fakeSockets, allowLocal: opts.allowLocal }));
  const got: Record<string, unknown>[] = [];
  sim.env.listen((ev) => got.push(ev.data as Record<string, unknown>));
  const popup = sim.env.open(relayUrl(LIVE_PORTS[0]), "w", "") as NonNullable<ReturnType<typeof sim.env.open>>;
  await until(() => !!sim.popup?.relay, "the link window to load");
  const target = `http://127.0.0.1:${LIVE_PORTS[0]}`;
  const say = (msg: Record<string, unknown>, session = "s1") => popup.postMessage({ juracad: RELAY_TAG, session, ...msg }, target);
  return { sim, got, popup, say, relay: () => sim.popup!.relay! };
}

describe("Safari's link window: who it's served to and who may use it", () => {
  it("accepts only its own origin, http://127.0.0.1 on a live port", () => {
    for (const p of LIVE_PORTS) expect(relayOriginAllowed(`http://127.0.0.1:${p}`)).toBe(true);
    for (const bad of [
      undefined,
      null,
      "",
      "null",
      "http://127.0.0.1:1234",
      "http://127.0.0.1",
      "https://127.0.0.1:47615",
      "http://localhost:47615",
      "http://[::1]:47615",
      "http://127.0.0.2:47615",
      "http://127.0.0.1:47615/x",
      "http://127.0.0.1:476150",
      "http://127.0.0.1.evil.example:47615",
      "https://evil.example",
    ]) {
      expect(relayOriginAllowed(bad)).toBe(false);
    }
  });

  it("the live link lets the link window in, and still nothing else new", () => {
    const req = (origin: string, host = "127.0.0.1:47616") => ({
      method: "GET",
      url: LIVE_PATH,
      headers: { host, origin, upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-protocol": LIVE_SUBPROTOCOL },
    });
    // The window may be served by one chat's extension and link to every other chat's.
    expect(upgradeProblem(req("http://127.0.0.1:47615"), 47616)).toBeNull();
    expect(upgradeProblem(req("http://127.0.0.1:47624"), 47616)).toBeNull();
    expect(upgradeProblem(req("http://127.0.0.1:8080"), 47616)?.status).toBe(403);
    expect(upgradeProblem(req("http://localhost:47615"), 47616)?.status).toBe(403);
    // Host checks still apply (DNS tricks).
    expect(upgradeProblem(req("http://127.0.0.1:47615", "evil.example:47616"), 47616)?.status).toBe(403);
  });

  it("serves the page and script only at http://127.0.0.1:<its own live port>, for GET", () => {
    const get = (url: string, host = "127.0.0.1:47615", method = "GET") => relayPageFor({ method, url, headers: { host } }, 47615);
    const page = get(RELAY_PATH);
    expect(page?.body).toBe(relayPageHtml());
    expect(page?.headers["Content-Type"]).toMatch(/^text\/html/);
    expect(get(`${RELAY_PATH}?x=1`)?.body).toBe(relayPageHtml());
    const script = get(RELAY_SCRIPT_PATH);
    expect(script?.body).toBe(relayScript());
    expect(script?.headers["Content-Type"]).toMatch(/^text\/javascript/);
    expect(get(RELAY_PATH, "localhost:47615")).toBeNull();
    expect(get(RELAY_PATH, "evil.example:47615")).toBeNull();
    expect(get(RELAY_PATH, "127.0.0.1:47616")).toBeNull();
    expect(get(RELAY_PATH, "127.0.0.1:47615", "POST")).toBeNull();
    expect(get("/other")).toBeNull();
    // Not on a port outside the live ports.
    expect(relayPageFor({ method: "GET", url: RELAY_PATH, headers: { host: "127.0.0.1:9000" } }, 9000)).toBeNull();
    // Development mode is passed on to the script.
    expect(relayPageFor({ method: "GET", url: RELAY_SCRIPT_PATH, headers: { host: "127.0.0.1:47615" } }, 47615, LIVE_PORTS, true)?.body).toBe(relayScript({ allowLocal: true }));
  });

  it("is never framed, cached or upgraded, and may only reach the live ports", () => {
    const h = relayHeaders("page");
    expect(h["X-Frame-Options"]).toBe("DENY");
    // Other sites can't load it (as a <script>, say) to find out whether the extension is running.
    expect(h["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(relayHeaders("script")["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(h["Cache-Control"]).toBe("no-store");
    const csp = h["Content-Security-Policy"];
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/upgrade-insecure-requests/);
    expect(csp).toContain(LIVE_PORTS.map((p) => `ws://127.0.0.1:${p}`).join(" "));
    // It must keep its opener.
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("cross-origin-opener-policy");
    // The page loads only its own script, and shows nothing it's sent.
    expect(relayPageHtml()).toContain(`<script src="${RELAY_SCRIPT_PATH}"></script>`);
    expect(relayScript()).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});

describe("Safari's link window: the script", () => {
  it("does nothing when loaded anywhere but http://127.0.0.1", () => {
    let listened = 0;
    const win = { location: { origin: "https://evil.example" }, opener: {}, addEventListener: () => listened++, close() {} };
    new Function("window", "document", "WebSocket", "setInterval", "clearInterval", relayScript())(win, {}, FakeWS, setInterval, clearInterval);
    expect(listened).toBe(0);
  });

  it("answers only the window that opened it, and only if it's the JuraCAD site", async () => {
    const { sim, got, say, relay } = await linkWindow();
    const r = relay();
    // Not the opener (some other window with the right origin): ignored.
    sim.sendAsIf({ source: {}, origin: SITE }, { juracad: RELAY_TAG, session: "x", kind: "ping" });
    // The opener, but another site: ignored.
    sim.sendAsIf({ source: sim.tabProxy, origin: "https://evil.example" }, { juracad: RELAY_TAG, session: "x", kind: "ping" });
    sim.sendAsIf({ source: sim.tabProxy, origin: "http://localhost:4173" }, { juracad: RELAY_TAG, session: "x", kind: "ping" });
    // Not ours, or damaged.
    sim.sendAsIf({ source: sim.tabProxy, origin: SITE }, { juracad: "other", session: "x", kind: "ping" });
    sim.sendAsIf({ source: sim.tabProxy, origin: SITE }, { juracad: RELAY_TAG, session: "", kind: "ping" });
    sim.sendAsIf({ source: sim.tabProxy, origin: SITE }, "ping");
    // Something other than a ping first: ignored (it must be tied to a page first).
    sim.sendAsIf({ source: sim.tabProxy, origin: SITE }, { juracad: RELAY_TAG, session: "x", kind: "open", id: 1, port: LIVE_PORTS[0] });
    await wait(20);
    expect(got).toEqual([]);
    expect(FakeWS.all).toHaveLength(0);
    // The JuraCAD tab that opened it: answered.
    say({ kind: "ping" });
    await until(() => got.length === 1, "the pong");
    expect(got[0]).toMatchObject({ juracad: RELAY_TAG, session: "s1", kind: "pong" });
    // Every reply names this page load, the same each time.
    expect(typeof got[0].load).toBe("string");
    say({ kind: "ping" });
    await until(() => got.length === 2, "the second pong");
    expect(got[1].load).toBe(got[0].load);
    expect(r.status).toMatch(/Keep this window open/);
  });

  it("lets JuraCAD on this computer use it only in development mode", async () => {
    const off = await linkWindow({ tabOrigin: "http://localhost:4173" });
    off.say({ kind: "ping" });
    await wait(30);
    expect(off.got).toEqual([]);
    const on = await linkWindow({ tabOrigin: "http://localhost:4173", allowLocal: true });
    on.say({ kind: "ping" });
    await until(() => on.got.length === 1, "the pong in development mode");
  });

  it("opens only the live link on the live ports, and passes text both ways untouched", async () => {
    const { got, say } = await linkWindow();
    say({ kind: "ping" });
    say({ kind: "open", id: 1, port: 80 });
    say({ kind: "open", id: 2, port: "47615" });
    say({ kind: "open", id: 3, port: LIVE_PORTS[3] });
    await until(() => got.length >= 3, "the replies");
    expect(got.filter((m) => m.kind === "closed").map((m) => [m.id, m.code])).toEqual([
      [1, 1008],
      [2, 1008],
    ]);
    expect(FakeWS.all).toHaveLength(1);
    const ws = FakeWS.all[0];
    expect(ws.url).toBe(`ws://127.0.0.1:${LIVE_PORTS[3]}${LIVE_PATH}`);
    expect(ws.protocol).toBe(LIVE_SUBPROTOCOL);
    expect(ws.origin).toBe(`http://127.0.0.1:${LIVE_PORTS[0]}`);
    // The same id can't be opened twice.
    say({ kind: "open", id: 3, port: LIVE_PORTS[4] });
    ws.open();
    await until(() => got.some((m) => m.kind === "opened"), "opened");
    expect(FakeWS.all).toHaveLength(1);
    say({ kind: "send", id: 3, data: '{"type":"hello"}' });
    say({ kind: "send", id: 3, data: 42 });
    say({ kind: "send", id: 99, data: "nobody" });
    await until(() => ws.sent.length === 1, "the message out");
    await wait(20);
    expect(ws.sent).toEqual(['{"type":"hello"}']);
    ws.receive('{"type":"welcome"}');
    ws.receive(new ArrayBuffer(4));
    await until(() => got.some((m) => m.kind === "message"), "the message in");
    await wait(20);
    expect(got.filter((m) => m.kind === "message")).toEqual([{ juracad: RELAY_TAG, session: "s1", kind: "message", id: 3, data: '{"type":"welcome"}' }]);
    say({ kind: "close", id: 3 });
    await until(() => got.some((m) => m.kind === "closed" && m.id === 3), "closed");
    expect(ws.closedWith).toBe(1000);
  });

  it("refuses messages bigger than the live link allows", async () => {
    const { got, say } = await linkWindow();
    say({ kind: "ping" });
    say({ kind: "open", id: 1, port: LIVE_PORTS[0] });
    await until(() => FakeWS.all.length === 1, "the socket");
    const ws = FakeWS.all[0];
    ws.open();
    const big = "x".repeat(MAX_MESSAGE_BYTES + 1);
    say({ kind: "send", id: 1, data: big });
    ws.receive(big);
    // Counted in UTF-8 bytes, as the live link counts them: fewer characters than the limit, but too many bytes.
    const wide = "é".repeat(MAX_MESSAGE_BYTES / 2 + 1);
    say({ kind: "send", id: 1, data: wide });
    ws.receive(wide);
    const justFits = "é".repeat(MAX_MESSAGE_BYTES / 2 - 1);
    say({ kind: "send", id: 1, data: justFits });
    say({ kind: "send", id: 1, data: "ok" });
    await until(() => ws.sent.length === 2, "the messages that fit");
    expect(ws.sent.map((x) => x.length)).toEqual([justFits.length, 2]);
    await wait(20);
    expect(got.filter((m) => m.kind === "message")).toHaveLength(0);
  });

  it("keeps at most RELAY_MAX_SOCKETS open", async () => {
    const { got, say } = await linkWindow();
    say({ kind: "ping" });
    for (let id = 1; id <= RELAY_MAX_SOCKETS + 2; id++) say({ kind: "open", id, port: LIVE_PORTS[0] });
    await until(() => got.filter((m) => m.kind === "closed").length === 2, "the extra ones refused");
    expect(FakeWS.all).toHaveLength(RELAY_MAX_SOCKETS);
  });

  it("a reloaded tab (new session) replaces the old one, whose links are closed", async () => {
    const { got, say } = await linkWindow();
    say({ kind: "ping" });
    say({ kind: "open", id: 1, port: LIVE_PORTS[0] });
    await until(() => FakeWS.all.length === 1, "the socket");
    FakeWS.all[0].open();
    say({ kind: "ping" }, "s2");
    await until(() => got.some((m) => m.session === "s2"), "the new session's pong");
    expect(FakeWS.all[0].closedWith).toBe(1000);
    // The old session is no longer obeyed.
    say({ kind: "open", id: 2, port: LIVE_PORTS[0] });
    await wait(20);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("bye closes every link and the window; so does closing the JuraCAD tab", async () => {
    const a = await linkWindow();
    a.say({ kind: "ping" });
    a.say({ kind: "open", id: 1, port: LIVE_PORTS[0] });
    await until(() => FakeWS.all.length === 1, "the socket");
    const first = FakeWS.all[0];
    a.say({ kind: "bye" });
    await until(() => a.popup.closed, "the window to close");
    expect(first.closedWith).toBe(1000);

    const b = await linkWindow();
    b.say({ kind: "ping" });
    b.say({ kind: "open", id: 1, port: LIVE_PORTS[0] });
    await until(() => FakeWS.all.length === 1, "the socket");
    const second = FakeWS.all[0];
    b.sim.tabClosed = true;
    await until(() => b.popup.closed, "the window to close after the tab", 5_000);
    expect(second.readyState).toBe(3);
  });
});

describe("Safari's link window: the tab's side", () => {
  it("parses only well-formed replies for this tab", () => {
    expect(parseRelayEvent({ juracad: RELAY_TAG, session: "a", kind: "pong", load: "L1" }, "a")).toEqual({ juracad: RELAY_TAG, session: "a", kind: "pong", load: "L1" });
    expect(parseRelayEvent({ juracad: RELAY_TAG, session: "a", kind: "pong" }, "a")).toBeNull();
    expect(parseRelayEvent({ juracad: RELAY_TAG, session: "b", kind: "pong", load: "L1" }, "a")).toBeNull();
    expect(parseRelayEvent({ juracad: "x", session: "a", kind: "pong" }, "a")).toBeNull();
    expect(parseRelayEvent({ juracad: RELAY_TAG, session: "a", kind: "message", id: 1, data: 5 }, "a")).toBeNull();
    expect(parseRelayEvent({ juracad: RELAY_TAG, session: "a", kind: "closed", id: -1, code: 1000, reason: "" }, "a")).toBeNull();
    expect(parseRelayEvent({ juracad: RELAY_TAG, session: "a", kind: "nope" }, "a")).toBeNull();
    expect(parseRelayEvent(null, "a")).toBeNull();
  });

  it("says so when Safari blocks the window", async () => {
    const sim = track(new RelaySim({ tabOrigin: SITE, served: () => [LIVE_PORTS[0]], relayPorts: LIVE_PORTS, makeSocket: fakeSockets, blockPopups: true }));
    const t = track(new RelayTransport(sim.env));
    const problem = await t.start();
    expect(problem?.title).toBe("Safari blocked the link window");
    expect(problem?.help.join(" ")).toMatch(/Pop-up Windows to Allow/);
  });

  it("moves the window on to the next port until an extension answers, and tries that one first next time", async () => {
    const ports = [LIVE_PORTS[0], LIVE_PORTS[1], LIVE_PORTS[2]];
    const sim = track(new RelaySim({ tabOrigin: SITE, served: () => [ports[2]], relayPorts: ports, makeSocket: fakeSockets }));
    const t = track(new RelayTransport(sim.env, ports, { portWait: 60, tick: 10 }));
    expect(await t.start()).toBeNull();
    expect(sim.popup!.visited).toEqual(ports.map(relayUrl));
    expect(t.linked).toBe(true);
    expect(t.windowPort).toBe(ports[2]);
    t.stop();
    expect(sim.popup!.closed).toBe(true);
    expect(t.linked).toBe(false);
    expect(await t.start()).toBeNull();
    expect(sim.popup!.visited).toEqual([relayUrl(ports[2])]);
    t.stop();
  });

  it("gives up (and closes the window) when no extension answers", async () => {
    const ports = [LIVE_PORTS[0], LIVE_PORTS[1]];
    const sim = track(new RelaySim({ tabOrigin: SITE, served: () => [], relayPorts: ports, makeSocket: fakeSockets }));
    const t = track(new RelayTransport(sim.env, ports, { portWait: 40, tick: 10 }));
    const problem = await t.start();
    expect(problem?.title).toBe("Claude isn't connected");
    expect(problem?.help.join(" ")).toMatch(/Start a chat in Claude/);
    expect(sim.popup!.closed).toBe(true);
  });

  it("another website can't use the window: it never answers one", async () => {
    FakeWS.all = [];
    const ports = [LIVE_PORTS[0]];
    const sim = track(new RelaySim({ tabOrigin: "https://evil.example", served: () => ports, relayPorts: ports, makeSocket: fakeSockets }));
    const t = track(new RelayTransport(sim.env, ports, { portWait: 80, tick: 10 }));
    expect((await t.start())?.title).toBe("Claude isn't connected");
    expect(FakeWS.all.filter((w) => w.origin === `http://127.0.0.1:${ports[0]}`).length).toBe(0);
  });

  it("makes WebSocket look-alikes, and tells when the window is closed", async () => {
    FakeWS.all = [];
    const ports = [LIVE_PORTS[0]];
    const sim = track(new RelaySim({ tabOrigin: SITE, served: () => ports, relayPorts: ports, makeSocket: fakeSockets }));
    const t = track(new RelayTransport(sim.env, ports, { portWait: 200, tick: 10 }));
    expect(() => t.makeSocket(`ws://127.0.0.1:${ports[0]}${LIVE_PATH}`, LIVE_SUBPROTOCOL)).toThrow();
    expect(await t.start()).toBeNull();
    expect(() => t.makeSocket(`ws://evil.example:${ports[0]}${LIVE_PATH}`, LIVE_SUBPROTOCOL)).toThrow();
    const s = t.makeSocket(`ws://127.0.0.1:${ports[0]}${LIVE_PATH}`, LIVE_SUBPROTOCOL);
    const seen: string[] = [];
    s.onopen = () => seen.push("open");
    s.onmessage = (ev) => seen.push(`message ${String(ev.data)}`);
    s.onclose = (ev) => seen.push(`close ${ev.code}`);
    await until(() => FakeWS.all.length === 1, "the real socket");
    FakeWS.all[0].open();
    await until(() => s.readyState === 1, "open");
    s.send("hello");
    await until(() => FakeWS.all[0].sent.length === 1, "sent");
    FakeWS.all[0].receive("welcome");
    await until(() => seen.length === 2, "the message");
    let lost = 0;
    t.onLost = () => lost++;
    sim.popup!.close();
    await until(() => lost === 1, "the window being closed to be noticed");
    expect(seen).toEqual(["open", "message welcome", "close 1006"]);
    expect(t.linked).toBe(false);
  });

  it("notices when the window is reloaded: every link closes and it says why", async () => {
    FakeWS.all = [];
    const ports = [LIVE_PORTS[0]];
    const sim = track(new RelaySim({ tabOrigin: SITE, served: () => ports, relayPorts: ports, makeSocket: fakeSockets }));
    const t = track(new RelayTransport(sim.env, ports, { portWait: 500, tick: 10, heartbeat: 30, deadAfter: 200 }));
    expect(await t.start()).toBeNull();
    const s = t.makeSocket(`ws://127.0.0.1:${ports[0]}${LIVE_PATH}`, LIVE_SUBPROTOCOL);
    const seen: string[] = [];
    s.onclose = (ev) => seen.push(`close ${ev.code}`);
    await until(() => FakeWS.all.length === 1, "the real socket");
    FakeWS.all[0].open();
    await until(() => s.readyState === 1, "open");
    // Several heartbeats go by without trouble.
    await wait(200);
    expect(t.linked).toBe(true);
    const lost: string[] = [];
    t.onLost = (why) => lost.push(why);
    sim.popup!.reload();
    await until(() => lost.length === 1, "the reload to be noticed");
    expect(lost).toEqual(["broken"]);
    expect(seen).toEqual(["close 1006"]);
    expect(FakeWS.all[0].readyState).toBe(3);
    expect(t.linked).toBe(false);
  });

  it("notices when the window leaves its page (Back, or another address) and stops answering", async () => {
    const ports = [LIVE_PORTS[0]];
    const sim = track(new RelaySim({ tabOrigin: SITE, served: () => ports, relayPorts: ports, makeSocket: fakeSockets }));
    let clock = 0;
    const t = track(new RelayTransport(sim.env, ports, { portWait: 500, tick: 10, heartbeat: 20, deadAfter: 1_000 }, () => clock));
    expect(await t.start()).toBeNull();
    const lost: string[] = [];
    t.onLost = (why) => lost.push(why);
    sim.popup!.go("https://example.com/");
    // Unanswered checks alone aren't enough (a background tab's timers may be slowed right down)...
    await wait(300);
    expect(lost).toEqual([]);
    // ...nor is time alone; both together are.
    clock = 5_000;
    await until(() => lost.length === 1, "the silence to be noticed");
    expect(lost).toEqual(["broken"]);
  });

  it("each tab has its own window: a second tab's Connect never touches the first tab's", async () => {
    const ports = [LIVE_PORTS[0]];
    const windows = new Map();
    const tabA = track(new RelaySim({ tabOrigin: SITE, served: () => ports, relayPorts: ports, makeSocket: fakeSockets }, windows));
    const tabB = track(new RelaySim({ tabOrigin: SITE, served: () => ports, relayPorts: ports, makeSocket: fakeSockets }, windows));
    const a = track(new RelayTransport(tabA.env, ports, { portWait: 500, tick: 10 }));
    const b = track(new RelayTransport(tabB.env, ports, { portWait: 500, tick: 10 }));
    expect(await a.start()).toBeNull();
    const aWindow = tabA.popup!;
    expect(await b.start()).toBeNull();
    expect(tabB.popup).not.toBe(aWindow);
    expect(tabA.names[0]).not.toBe(tabB.names[0]);
    expect(aWindow.visited).toHaveLength(1);
    expect(a.linked).toBe(true);
    // The same tab connecting again uses its own window again (one per tab).
    a.stop();
    expect(await a.start()).toBeNull();
    expect(tabA.names[1]).toBe(tabA.names[0]);
    // The name the app gives (kept across reloads of the tab) is used when there is one.
    const named = new RelayTransport({ ...tabA.env, windowName: () => "juracad-claude-link-abc" }, ports);
    expect(named.windowName).toBe("juracad-claude-link-abc");
  });
});
