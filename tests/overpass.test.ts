/**
 * Asking OpenStreetMap's query service: busy, unreachable or timed-out answers are tried again, after a short wait and on
 * the other public server, within the overall limit; answers that would only come out the same aren't.
 */
import { describe, expect, it } from "vitest";
import { askOverpass, overpassAnswer, OverpassError, OVERPASS_SERVERS, type OverpassAsk } from "../src/terrain/overpass";

const MAP = `<?xml version="1.0"?><osm><node id="1" lat="56" lon="-5.9"/><node id="2" lat="56.01" lon="-5.9"/><way id="3"><nd ref="1"/><nd ref="2"/><tag k="natural" v="coastline"/></way></osm>`;
type Answer = { status: number; text: string } | "offline";

function stand(answers: Answer[]) {
  const asked: string[] = [];
  const waited: number[] = [];
  const ask: OverpassAsk = {
    fetch: async (url) => {
      asked.push(url);
      const a = answers.shift() ?? "offline";
      if (a === "offline") throw new TypeError("Failed to fetch");
      return { status: a.status, text: async () => a.text };
    },
    sleep: async (ms) => {
      waited.push(ms);
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

  it("busy or unreachable: tried again on the other server after a short wait, then the first again", async () => {
    const s = stand(["offline", { status: 429, text: "" }, { status: 200, text: MAP }]);
    const d = await askOverpass("q", "coastline", s.ask);
    expect(d.coastline?.length).toBe(1);
    expect(s.asked).toEqual([OVERPASS_SERVERS[0], OVERPASS_SERVERS[1], OVERPASS_SERVERS[0]]);
    expect(s.waited.every((w) => w > 0 && w <= 5000)).toBe(true);
  });

  it("a server that ran out of time is tried again; one that couldn't read the query isn't", async () => {
    const timedOut = stand([{ status: 200, text: `<osm><remark>runtime error: Query timed out in "query" at line 1</remark></osm>` }, { status: 200, text: MAP }]);
    expect((await askOverpass("q", "coastline", timedOut.ask)).coastline?.length).toBe(1);
    const bad = stand([{ status: 400, text: "" }, { status: 200, text: MAP }]);
    await expect(askOverpass("q", "coastline", bad.ask)).rejects.toThrow(/couldn't make sense/);
    expect(bad.asked.length).toBe(1);
    const big = stand([{ status: 200, text: `<osm><remark>runtime error: out of memory</remark></osm>` }]);
    await expect(askOverpass("q", "coastline", big.ask)).rejects.toThrow(/too much coastline/);
  });

  it("every try failing gives the last reason, in plain words", async () => {
    const s = stand(["offline", "offline", { status: 504, text: "" }]);
    await expect(askOverpass("q", "coastline", s.ask)).rejects.toThrow(/busy/);
    expect(s.asked.length).toBe(3);
  });

  it("stopped (the time limit, or the window moving on): no more tries", async () => {
    const stop = new AbortController();
    const s = stand(["offline", { status: 200, text: MAP }]);
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

describe("a server that doesn't answer", () => {
  it("is given up after the time one try may take, and the next server asked", async () => {
    const asked: string[] = [];
    const ask: OverpassAsk = {
      fetch: (url, init) => {
        asked.push(url);
        if (asked.length === 1)
          return new Promise((_, fail) => init.signal.addEventListener("abort", () => fail(new Error("aborted"))));
        return Promise.resolve({ status: 200, text: async () => MAP });
      },
      sleep: async () => {},
      tryLimit: 30,
    };
    const d = await askOverpass("q", "coastline", ask);
    expect(d.coastline?.length).toBe(1);
    expect(asked).toEqual([OVERPASS_SERVERS[0], OVERPASS_SERVERS[1]]);
  });
});
