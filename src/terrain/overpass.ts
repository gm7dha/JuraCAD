/**
 * Asking OpenStreetMap's query service (Overpass) for a map (pure: the fetch and the wait are passed in, so tests need no
 * network). Public Overpass servers are often busy: a request that can't get through, is turned away as busy, or runs
 * out of time on the server is tried again after a short wait, within an overall time limit; and every public server is
 * asked at once, so the quickest answers. Answers that would come out the same again (a query the server can't read, an area with too much in it) aren't.
 */
import { readOsm, type OsmData } from "./osm";

/** Public Overpass servers (any web page may ask them; no key), tried in this order. */
export const OVERPASS_SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

/**
 * The servers are asked AT THE SAME TIME (a race): each "lane" is one server, first asked `start` ms after the ask
 * begins. The first good answer wins and the others are stopped. Big, detailed coasts (Lewis and Harris: 18 MB) can take
 * either server anything from a few seconds to over a minute, and which is quicker changes from day to day, so a slow
 * answer is never thrown away just because another server was due its turn.
 */
export const OVERPASS_LANES: { server: number; start: number }[] = [
  { server: 0, start: 0 },
  { server: 1, start: 1000 },
];
/** A lane whose server was busy, unreachable or ran out of time asks it again after this long (ms)… */
export const OVERPASS_RETRY_WAIT = 3000;
/** …up to this many times in all per lane. */
export const OVERPASS_ATTEMPTS = 2;

/** Why a request for a map didn't work, in plain words; `again`: worth asking again (busy, unreachable, timed out). */
export class OverpassError extends Error {
  constructor(
    message: string,
    readonly again: boolean,
    /** The query itself can't be read: every server would say the same, so a race ends at once. */
    readonly everyServer = false,
  ) {
    super(message);
  }
}

const EMPTY: OsmData = { bounds: null, lines: [], shapes: [], names: [], boundaries: [], regionNames: [], nodes: 0 };

/**
 * What the service answered (`status`, `text`), as a map — or an OverpassError. It answers 200 even when a query ran
 * out of time or memory, with a <remark> saying so instead of the map.
 */
export function overpassAnswer(status: number, text: string, what: string): OsmData {
  if (status === 429 || status === 504 || status === 502 || status === 503)
    throw new OverpassError(`OpenStreetMap's map service is busy — try again in a minute, or use a map file.`, true);
  if (status === 400) throw new OverpassError(`OpenStreetMap's map service couldn't make sense of the request for ${what}. Please use a map file instead.`, false, true);
  if (status < 200 || status >= 300) throw new OverpassError(`OpenStreetMap's map service didn't answer properly (error ${status}). Try again later, or use a map file.`, status >= 500);
  const remark = /<remark>([\s\S]*?)<\/remark>/.exec(text)?.[1] ?? "";
  if (/out of memory|memory/i.test(remark))
    throw new OverpassError(`There's too much ${what} in this area for OpenStreetMap's map service to send at once. Use a map file instead (on openstreetmap.org, Export a smaller area).`, false);
  // A query timing out is usually a busy server: another may manage it.
  if (/timed out|timeout/i.test(remark))
    throw new OverpassError(`OpenStreetMap's map service ran out of time sending the ${what}. Try again in a minute, or use a map file.`, true);
  if (remark && !/<node\b/.test(text)) throw new OverpassError(`OpenStreetMap's map service couldn't send the ${what} (${remark.trim().slice(0, 120)}). Try again later, or use a map file.`, true);
  if (!/<node\b/.test(text)) return EMPTY;
  return readOsm(text);
}

export interface OverpassAsk {
  /** The browser's fetch (or a stand-in). */
  fetch: (url: string, init: { method: string; body: URLSearchParams; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
  /** Waits ms (rejects or resolves early when stopped is fine). */
  sleep: (ms: number) => Promise<void>;
  /** Stops everything: the overall time limit, or the window moving on. */
  signal?: AbortSignal;
  /** Called before a server is asked again after it failed (the number of the ask, counting every server's: 2, 3…). */
  retrying?: (attempt: number) => void;
  lanes?: { server: number; start: number }[];
  servers?: string[];
  /** Asks per lane (default OVERPASS_ATTEMPTS) and the wait before asking a lane's server again (default OVERPASS_RETRY_WAIT). */
  attempts?: number;
  retryWait?: number;
  /**
   * The longest (ms) one ask may take before that server is asked afresh (missing: no limit but `signal`). A lane's last
   * ask has only `signal`'s limit, so a slow answer that is coming is never cut off.
   */
  tryLimit?: number;
}

/** The map from the query, asked of every server at once (see OVERPASS_LANES): the first good answer. The last error when every ask failed. */
export async function askOverpass(query: string, what: string, ask: OverpassAsk): Promise<OsmData> {
  const lanes = ask.lanes ?? OVERPASS_LANES;
  const servers = ask.servers ?? OVERPASS_SERVERS;
  const attempts = Math.max(1, ask.attempts ?? OVERPASS_ATTEMPTS);
  const retryWait = ask.retryWait ?? OVERPASS_RETRY_WAIT;
  const tooLong = () => new OverpassError(`OpenStreetMap's map service took too long to send the ${what}.`, true);
  if (ask.signal?.aborted) throw tooLong();
  // Everything stops when the race is decided, or with the whole ask.
  const all = new AbortController();
  const stopAll = () => all.abort();
  ask.signal?.addEventListener("abort", stopAll);
  let asks = 0;

  /** One ask of one server; `limited`: cut off after tryLimit. */
  const once = async (url: string, limited: boolean): Promise<OsmData> => {
    const one = new AbortController();
    const stopOne = () => one.abort();
    all.signal.addEventListener("abort", stopOne);
    let slow = false;
    const timer =
      limited && ask.tryLimit !== undefined
        ? setTimeout(() => {
            slow = true;
            one.abort();
          }, ask.tryLimit)
        : null;
    try {
      let res: { status: number; text(): Promise<string> };
      try {
        res = await ask.fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: one.signal });
      } catch {
        throw slow || ask.signal?.aborted ? tooLong() : new OverpassError(`Couldn't reach OpenStreetMap's map service for the ${what} — check you're online, or use a map file.`, true);
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw slow || ask.signal?.aborted ? tooLong() : new OverpassError(`OpenStreetMap's map service stopped part-way through sending the ${what}.`, true);
      }
      if (all.signal.aborted) throw tooLong();
      return overpassAnswer(res.status, text, what);
    } finally {
      if (timer !== null) clearTimeout(timer);
      all.signal.removeEventListener("abort", stopOne);
    }
  };

  /** One server: asked, and asked again while it's busy, unreachable or out of time. */
  const lane = async (l: { server: number; start: number }): Promise<OsmData> => {
    const url = servers[l.server % servers.length];
    if (l.start > 0) await ask.sleep(l.start);
    let last: OverpassError = new OverpassError(`Couldn't reach OpenStreetMap's map service for the ${what}.`, true);
    for (let a = 0; a < attempts; a++) {
      if (all.signal.aborted) throw tooLong();
      if (a > 0) {
        ask.retrying?.(asks + 1);
        if (retryWait > 0) await ask.sleep(retryWait);
        if (all.signal.aborted) throw tooLong();
      }
      asks++;
      try {
        return await once(url, a + 1 < attempts);
      } catch (e) {
        if (!(e instanceof OverpassError)) throw e;
        last = e;
        if (!e.again) throw e;
      }
    }
    throw last;
  };

  try {
    return await new Promise<OsmData>((win, lose) => {
      let left = lanes.length;
      let last: unknown = new OverpassError(`Couldn't reach OpenStreetMap's map service for the ${what}.`, true);
      if (!left) lose(last);
      for (const l of lanes)
        lane(l).then(win, (e: unknown) => {
          // A query no server can read — or a fault of our own — ends the race at once. Anything else (one server out
          // of memory, refusing…) ends only that server's lane: another may still be sending a good answer.
          if (!(e instanceof OverpassError) || e.everyServer) return lose(e);
          // When every lane has failed, the most telling reason is given: one that asking again wouldn't help.
          if (!(last instanceof OverpassError) || last.again || !e.again) last = e;
          if (--left === 0) lose(ask.signal?.aborted && last instanceof OverpassError && last.again ? tooLong() : last);
        });
    });
  } finally {
    all.abort();
    ask.signal?.removeEventListener("abort", stopAll);
  }
}
