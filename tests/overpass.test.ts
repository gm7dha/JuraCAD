/**
 * Asking OpenStreetMap's query service: busy, unreachable or timed-out answers are tried again, after a short wait and on
 * the other public server, within the overall limit; answers that would only come out the same aren't.
 */
import { describe, expect, it } from "vitest";
import { askOverpass, overpassAnswer, OverpassError, OVERPASS_SERVERS, type OverpassAsk } from "../src/terrain/overpass";

/** A real wait, stopped early by nothing (the lanes check for themselves). */
const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const MAP = `<?xml version="1.0"?><osm><node id="1" lat="56" lon="-5.9"/><node id="2" lat="56.01" lon="-5.9"/><way id="3"><nd ref="1"/><nd ref="2"/><tag k="natural" v="coastline"/></way></osm>`;
type Answer = { status: number; text: string } | "offline";

/** Each server answers its own list in turn (index 0 = OVERPASS_SERVERS[0]); a plain list = the first server's. */
function stand(answers: Answer[], second: Answer[] = ["offline", "offline", "offline"]) {
  const asked: string[] = [];
  const waited: number[] = [];
  const lists = [answers, second];
  const ask: OverpassAsk = {
    fetch: async (url) => {
      asked.push(url);
      const a = lists[OVERPASS_SERVERS.indexOf(url)].shift() ?? "offline";
      if (a === "offline") throw new TypeError("Failed to fetch");
      return { status: a.status, text: async () => a.text };
    },
    sleep: async (ms) => {
      waited.push(ms);
      await realSleep(Math.min(ms, 5) * (ms >= 3000 ? 3 : 1));
    },
  };
  return { ask, asked, waited };
}

describe("asking OpenStreetMap's map service", () => {
  it("the first answer, when it's good", async () => {
    const s = stand([{ status: 200, text: MAP }]);
    const d = await askOverpass("q", "coastline", s.ask);
    expect(d.coastline?.length).toBe(1);
    expect(s.asked).toEqual([OVERPASS_SERVERS[0]]);
  });

  it("busy or unreachable: that server is asked again after a short wait, while the other is asked too", async () => {
    const s = stand(["offline", { status: 200, text: MAP }], [{ status: 429, text: "" }, "offline"]);
    const d = await askOverpass("q", "coastline", s.ask);
    expect(d.coastline?.length).toBe(1);
    expect(s.asked.filter((u) => u === OVERPASS_SERVERS[0]).length).toBe(2);
    expect(s.asked).toContain(OVERPASS_SERVERS[1]);
    expect(s.waited.every((w) => w > 0 && w <= 5000)).toBe(true);
  });

  it("a server that ran out of time is tried again; one that couldn't read the query isn't", async () => {
    const timedOut = stand([{ status: 200, text: `<osm><remark>runtime error: Query timed out in "query" at line 1</remark></osm>` }, { status: 200, text: MAP }]);
    expect((await askOverpass("q", "coastline", timedOut.ask)).coastline?.length).toBe(1);
    const bad = stand([{ status: 400, text: "" }, { status: 200, text: MAP }], [{ status: 200, text: MAP }]);
    await expect(askOverpass("q", "coastline", bad.ask)).rejects.toThrow(/couldn't make sense/);
    expect(bad.asked.length).toBe(1);
    const big = stand([{ status: 200, text: `<osm><remark>runtime error: out of memory</remark></osm>` }]);
    await expect(askOverpass("q", "coastline", big.ask)).rejects.toThrow(/too much coastline/);
  });

  it("every ask failing gives the last reason, in plain words", async () => {
    const s = stand(["offline", { status: 504, text: "" }], ["offline", { status: 504, text: "" }]);
    await expect(askOverpass("q", "coastline", s.ask)).rejects.toThrow(/busy/);
    expect(s.asked.length).toBe(4);
  });

  it("stopped (the time limit, or the window moving on): no more tries", async () => {
    const stop = new AbortController();
    const s = stand(["offline", { status: 200, text: MAP }], [{ status: 200, text: MAP }]);
    s.ask.signal = stop.signal;
    s.ask.sleep = async () => stop.abort();
    await expect(askOverpass("q", "coastline", s.ask)).rejects.toThrow(/took too long/);
    expect(s.asked.length).toBe(1);
  });

  it("an empty answer is an empty map; errors say whether trying again could help", () => {
    expect(overpassAnswer(200, "<osm></osm>", "coastline").lines).toEqual([]);
    for (const [status, again] of [[429, true], [504, true], [500, true], [400, false], [404, false]] as const) {
      try {
        overpassAnswer(status, "", "coastline");
        throw new Error("no error");
      } catch (e) {
        expect(e instanceof OverpassError).toBe(true);
        expect((e as OverpassError).again).toBe(again);
      }
    }
  });
});

/** A server that answers after `ms` (or fails, or never answers), stopped by its signal. */
type Server = { ms: number; answer: Answer | "never" };
function racing(servers: Server[][], extra: Partial<OverpassAsk> = {}) {
  const asked: { url: string; at: number }[] = [];
  const stopped: string[] = [];
  const t0 = Date.now();
  const ask: OverpassAsk = {
    fetch: (url, init) => {
      asked.push({ url, at: Date.now() - t0 });
      const s = servers[OVERPASS_SERVERS.indexOf(url)].shift() ?? { ms: 0, answer: "offline" as const };
      return new Promise((done, fail) => {
        const t =
          s.answer === "never"
            ? null
            : setTimeout(() => {
                const a = s.answer as Answer;
                if (a === "offline") fail(new TypeError("Failed to fetch"));
                else done({ status: a.status, text: async () => a.text });
              }, s.ms);
        init.signal.addEventListener("abort", () => {
          if (t !== null) clearTimeout(t);
          stopped.push(url);
          fail(new Error("aborted"));
        });
      });
    },
    sleep: realSleep,
    lanes: [
      { server: 0, start: 0 },
      { server: 1, start: 20 },
    ],
    retryWait: 20,
    ...extra,
  };
  return { ask, asked, stopped };
}

describe("asking both servers at once (a race)", () => {
  it("a slow first server, a quick second: the second's answer wins and the first is stopped", async () => {
    const r = racing([[{ ms: 2000, answer: { status: 200, text: MAP } }], [{ ms: 30, answer: { status: 200, text: MAP } }]]);
    const t = Date.now();
    const d = await askOverpass("q", "coastline", r.ask);
    expect(d.coastline?.length).toBe(1);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(r.asked.map((a) => a.url)).toEqual([OVERPASS_SERVERS[0], OVERPASS_SERVERS[1]]);
    // The second is asked a little after the first, not only once the first has failed.
    expect(r.asked[1].at).toBeGreaterThanOrEqual(15);
    expect(r.stopped).toEqual([OVERPASS_SERVERS[0]]);
  });

  it("the first server failing: the second's answer still comes", async () => {
    const r = racing([[{ ms: 5, answer: "offline" }, { ms: 5, answer: { status: 504, text: "" } }], [{ ms: 100, answer: { status: 200, text: MAP } }]]);
    expect((await askOverpass("q", "coastline", r.ask)).coastline?.length).toBe(1);
  });

  it("both slow but inside the limit: the first to finish wins, nothing is cut off by another server's turn", async () => {
    // tryLimit is shorter than either answer, but with one ask per lane each is its lane's last, so neither is cut off.
    const r = racing([[{ ms: 250, answer: { status: 200, text: MAP } }], [{ ms: 400, answer: { status: 200, text: MAP } }]], { attempts: 1, tryLimit: 50 });
    const stop = new AbortController();
    const limit = setTimeout(() => stop.abort(), 5000);
    r.ask.signal = stop.signal;
    const d = await askOverpass("q", "coastline", r.ask);
    clearTimeout(limit);
    expect(d.coastline?.length).toBe(1);
    expect(r.stopped).toEqual([OVERPASS_SERVERS[1]]);
  });

  it("a server that never answers is asked afresh after tryLimit; the lane's last ask isn't cut short", async () => {
    const r = racing([[{ ms: 0, answer: "never" }, { ms: 120, answer: { status: 200, text: MAP } }], [{ ms: 0, answer: "never" }, { ms: 0, answer: "never" }]], { tryLimit: 40 });
    const stop = new AbortController();
    const limit = setTimeout(() => stop.abort(), 5000);
    r.ask.signal = stop.signal;
    expect((await askOverpass("q", "coastline", r.ask)).coastline?.length).toBe(1);
    clearTimeout(limit);
    expect(r.asked.filter((a) => a.url === OVERPASS_SERVERS[0]).length).toBe(2);
  });

  it("the whole ask's limit stops every server", async () => {
    const r = racing([[{ ms: 0, answer: "never" }], [{ ms: 0, answer: "never" }]], { attempts: 1 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 80);
    r.ask.signal = stop.signal;
    await expect(askOverpass("q", "coastline", r.ask)).rejects.toThrow(/took too long/);
    expect(r.stopped.sort()).toEqual([...OVERPASS_SERVERS].sort());
  });

  it("one server out of memory or refusing (403) ends only its own lane: the other's answer still wins", async () => {
    for (const fast of [{ status: 200, text: `<osm><remark>runtime error: out of memory</remark></osm>` }, { status: 403, text: "" }]) {
      const r = racing([[{ ms: 100, answer: { status: 200, text: MAP } }], [{ ms: 0, answer: fast }]], { lanes: [{ server: 0, start: 0 }, { server: 1, start: 0 }] });
      expect((await askOverpass("q", "coastline", r.ask)).coastline?.length).toBe(1);
    }
  });

  it("every lane failed: the reason asking again wouldn't help is given", async () => {
    const r = racing([[{ ms: 5, answer: "offline" }, { ms: 5, answer: "offline" }], [{ ms: 0, answer: { status: 200, text: `<osm><remark>runtime error: out of memory</remark></osm>` } }]]);
    await expect(askOverpass("q", "coastline", r.ask)).rejects.toThrow(/too much coastline/);
  });

  it("a query no server can read ends the race at once", async () => {
    const r = racing([[{ ms: 5, answer: { status: 400, text: "" } }], [{ ms: 300, answer: { status: 200, text: MAP } }]]);
    await expect(askOverpass("q", "coastline", r.ask)).rejects.toThrow(/couldn't make sense/);
  });
});
