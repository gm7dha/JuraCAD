/**
 * Asking OpenStreetMap's query service (Overpass) for a map (pure: the fetch and the wait are passed in, so tests need no
 * network). Public Overpass servers are often busy: a request that can't get through, is turned away as busy, or runs
 * out of time on the server is tried again — after a short wait, and on another public server — within an overall time
 * limit. Answers that would come out the same again (a query the server can't read, an area with too much in it) aren't.
 */
import { readOsm, type OsmData } from "./osm";

/** Public Overpass servers (any web page may ask them; no key), tried in this order. */
export const OVERPASS_SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

/** The tries: which server (index into the list) and how long (ms) to wait before asking. */
export const OVERPASS_TRIES: { server: number; wait: number }[] = [
  { server: 0, wait: 0 },
  { server: 1, wait: 1000 },
  { server: 0, wait: 3000 },
];

/** Why a request for a map didn't work, in plain words; `again`: worth asking again (busy, unreachable, timed out). */
export class OverpassError extends Error {
  constructor(
    message: string,
    readonly again: boolean,
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
  if (status === 400) throw new OverpassError(`OpenStreetMap's map service couldn't make sense of the request for ${what}. Please use a map file instead.`, false);
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
  /** Called before each try after the first (1-based try number), so the window can say it's trying again. */
  retrying?: (attempt: number) => void;
  tries?: { server: number; wait: number }[];
  servers?: string[];
  /** The longest (ms) one try may take before the next server is asked (missing: no limit but `signal`; the last try has only `signal`'s). */
  tryLimit?: number;
}

/** The map from the query, tried on the servers in turn (see OVERPASS_TRIES). The last error when every try failed. */
export async function askOverpass(query: string, what: string, ask: OverpassAsk): Promise<OsmData> {
  const tries = ask.tries ?? OVERPASS_TRIES;
  const servers = ask.servers ?? OVERPASS_SERVERS;
  let last: OverpassError = new OverpassError(`Couldn't reach OpenStreetMap's map service for the ${what}.`, true);
  for (let t = 0; t < tries.length; t++) {
    if (ask.signal?.aborted) break;
    if (t > 0) {
      ask.retrying?.(t + 1);
      if (tries[t].wait > 0) await ask.sleep(tries[t].wait);
      if (ask.signal?.aborted) break;
    }
    const url = servers[tries[t].server % servers.length];
    // This try stops with the whole ask, or on its own once it has taken `tryLimit`.
    const one = new AbortController();
    const stopOne = () => one.abort();
    ask.signal?.addEventListener("abort", stopOne);
    let slow = false;
    const timer =
      ask.tryLimit !== undefined && t + 1 < tries.length
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
        throw slow
          ? new OverpassError(`OpenStreetMap's map service took too long to send the ${what}.`, true)
          : new OverpassError(`Couldn't reach OpenStreetMap's map service for the ${what} — check you're online, or use a map file.`, true);
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new OverpassError(slow ? `OpenStreetMap's map service took too long to send the ${what}.` : `OpenStreetMap's map service stopped part-way through sending the ${what}.`, true);
      }
      return overpassAnswer(res.status, text, what);
    } catch (e) {
      if (!(e instanceof OverpassError)) throw e;
      last = e;
      if (!e.again) throw e;
    } finally {
      if (timer !== null) clearTimeout(timer);
      ask.signal?.removeEventListener("abort", stopOne);
    }
  }
  if (ask.signal?.aborted) throw new OverpassError(`OpenStreetMap's map service took too long to send the ${what}.`, true);
  throw last;
}
