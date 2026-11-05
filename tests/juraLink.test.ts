import { describe, expect, it } from "vitest";

import { LinkEnd, readMessage, siblingUrl, type AppName, type ChannelLike, type LinkEnv, type Parcel, type SendResult } from "../src/link/juraLink";

/** Tabs on one site: a broadcast channel (messages go to every other tab, later), a clock and timers run by hand. */
function site() {
  const channels = new Set<ChannelLike>();
  let queue: [ChannelLike, unknown][] = [];
  let clock = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 0;
  const opened: { to: AppName; id: string }[] = [];
  const env = (blocked = false): LinkEnv => {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage: (m) => {
        for (const c of channels) if (c !== channel) queue.push([c, JSON.parse(JSON.stringify(m))]);
      },
      close: () => channels.delete(channel),
    };
    channels.add(channel);
    return {
      channel,
      now: () => clock,
      setTimer: (fn, ms) => {
        const t = { at: clock + ms, fn, id: next++ };
        timers.push(t);
        return t.id;
      },
      clearTimer: (id) => (timers = timers.filter((t) => t.id !== id)),
      openTab: (to, id) => {
        opened.push({ to, id });
        return blocked ? null : { focus: () => undefined };
      },
      newId: () => `id${next++}`,
    };
  };
  /** Deliver every message (and those they cause). */
  const settle = () => {
    for (let i = 0; i < 1000 && queue.length; i++) {
      const [c, m] = queue.shift()!;
      c.onmessage?.({ data: m });
    }
  };
  /** Move the clock on, running timers and delivering messages as it goes. */
  const wait = (ms: number) => {
    const end = clock + ms;
    settle();
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      timers = timers.filter((t) => t !== due);
      due.fn();
      settle();
    }
    clock = end;
  };
  return { env, settle, wait, opened, drop: () => (queue = []) };
}

const taker = (got: Parcel[]) => (p: Parcel) => {
  got.push(p);
  return { ok: true, message: `Put "${p.name}" on the bed.` };
};

describe("the JuraCAD ↔ JuraCUT link", () => {
  it("sends to an open tab of the other app, which takes it once and says what it did", async () => {
    const s = site();
    const got: Parcel[] = [];
    const cad = new LinkEnd({ app: "juracad", env: s.env(), receive: () => ({ ok: true, message: "" }) });
    const cut = new LinkEnd({ app: "juracut", env: s.env(), receive: taker(got) });
    s.settle();
    expect(cad.peerOpen("juracut")).toBe(true);
    expect(cut.peerOpen("juracad")).toBe(true);
    const sent = cad.send("juracut", "Bracket", "svg", "<svg/>");
    s.wait(10);
    const r = await sent;
    expect(r).toEqual({ ok: true, via: "tab", message: 'Put "Bracket" on the bed.' });
    expect(got.map((p) => [p.name, p.kind, p.content, p.from])).toEqual([["Bracket", "svg", "<svg/>", "juracad"]]);
    expect(s.opened).toEqual([]);
  });

  it("only one of several open tabs takes it: the one seen most recently", async () => {
    const s = site();
    const [a, b]: Parcel[][] = [[], []];
    new LinkEnd({ app: "juracut", env: s.env(), receive: taker(a) });
    s.wait(5);
    new LinkEnd({ app: "juracut", env: s.env(), receive: taker(b) });
    s.wait(5);
    const cad = new LinkEnd({ app: "juracad", env: s.env(), receive: () => ({ ok: true, message: "" }) });
    s.settle();
    const sent = cad.send("juracut", "Plate", "svg", "<svg/>");
    s.wait(10);
    expect((await sent).ok).toBe(true);
    expect(a.length + b.length).toBe(1);
  });

  it("opens the other app when no tab of it is open, and hands the design to the new tab when it's ready", async () => {
    const s = site();
    const cut = new LinkEnd({ app: "juracut", env: s.env(), receive: () => ({ ok: true, message: "" }) });
    s.settle();
    const sent = cut.send("juracad", "Tag", "dxf", "0\nEOF\n");
    expect(s.opened.map((o) => o.to)).toEqual(["juracad"]);
    s.wait(800);
    // The new tab loads a moment later, knowing which parcel it was opened for.
    const got: Parcel[] = [];
    new LinkEnd({ app: "juracad", env: s.env(), receive: taker(got), waitingFor: s.opened[0].id });
    s.wait(500);
    const r = await sent;
    expect(r.ok).toBe(true);
    expect(r.via).toBe("new");
    expect(got).toHaveLength(1);
  });

  it("opens a new tab when the open one doesn't answer (it was closed without saying)", async () => {
    const s = site();
    const cad = new LinkEnd({ app: "juracad", env: s.env(), receive: () => ({ ok: true, message: "" }) });
    const gone = new LinkEnd({ app: "juracut", env: s.env(), receive: () => ({ ok: true, message: "" }) });
    s.settle();
    gone.close();
    s.drop();
    const sent = cad.send("juracut", "Box", "svg", "<svg/>");
    s.wait(2000);
    expect(s.opened).toHaveLength(1);
    const got: Parcel[] = [];
    new LinkEnd({ app: "juracut", env: s.env(), receive: taker(got), waitingFor: s.opened[0].id });
    s.wait(1000);
    expect((await sent).via).toBe("new");
    expect(got).toHaveLength(1);
  });

  it("when the browser blocks the new tab, the next tab of that app to open gets it; else it gives up in plain words", async () => {
    const s = site();
    const cad = new LinkEnd({ app: "juracad", env: s.env(true), receive: () => ({ ok: true, message: "" }) });
    s.settle();
    const first = cad.send("juracut", "One", "svg", "<svg/>");
    s.wait(3000);
    const got: Parcel[] = [];
    new LinkEnd({ app: "juracut", env: s.env(), receive: taker(got) });
    s.wait(100);
    expect((await first).ok).toBe(true);
    expect(got.map((p) => p.name)).toEqual(["One"]);
    // Nobody at all.
    const s2 = site();
    const lonely = new LinkEnd({ app: "juracad", env: s2.env(true), receive: () => ({ ok: true, message: "" }) });
    const second = lonely.send("juracut", "Two", "svg", "<svg/>");
    s2.wait(31000);
    const r: SendResult = await second;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/didn't open/);
  });

  it("passes on a refusal, and a receiver that throws", async () => {
    const s = site();
    const cad = new LinkEnd({ app: "juracad", env: s.env(), receive: () => ({ ok: true, message: "" }) });
    new LinkEnd({ app: "juracut", env: s.env(), receive: () => { throw new Error("That drawing has no lines."); } });
    s.settle();
    const sent = cad.send("juracut", "Empty", "svg", "<svg/>");
    s.wait(10);
    expect(await sent).toEqual({ ok: false, via: "tab", message: "That drawing has no lines." });
  });

  it("checks every message", () => {
    expect(readMessage({ type: "here", app: "juracut", tab: "a" })).toEqual({ type: "here", app: "juracut", tab: "a" });
    expect(readMessage({ type: "here", app: "photoshop", tab: "a" })).toBeNull();
    expect(readMessage({ type: "parcel", tab: "a", parcel: { id: "p", from: "juracad", to: "juracut", name: "x", kind: "exe", content: "" } })).toBeNull();
    expect(readMessage({ type: "parcel", tab: "a", parcel: { id: "p", from: "juracad", to: "juracut", name: "x", kind: "svg", content: 5 } })).toBeNull();
    expect(readMessage("hello")).toBeNull();
    expect(readMessage(null)).toBeNull();
  });

  it("finds the other app's address on the same site", () => {
    expect(siblingUrl("/JuraCUT/", "https://gm7dha.github.io", "juracad", "p1")).toBe("https://gm7dha.github.io/JuraCAD/?link=p1");
    expect(siblingUrl("/JuraCAD/", "https://gm7dha.github.io", "juracut", "p 2")).toBe("https://gm7dha.github.io/JuraCUT/?link=p%202");
    expect(siblingUrl("/", "http://localhost:5173", "juracad", "p")).toBe("http://localhost:5173/JuraCAD/?link=p");
  });
});
