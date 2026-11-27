/**
 * Coastlines kept in the browser between visits (pure part: the key, and packing the lines small). A big coast like
 * Lewis and Harris's takes the map service a minute or more to send (18 MB), so once fetched it's kept — as the lines
 * on the OS grid, packed into typed arrays (a few MB at most, never the XML) — for KEEP_DAYS, by the box fetched.
 * The browser glue (IndexedDB) is src/app/coastKeep.ts.
 */

type XY = [number, number];

/** How long (days) a kept coastline is used before it's fetched afresh (the map changes, slowly). */
export const KEEP_DAYS = 30;
export const KEEP_MS = KEEP_DAYS * 24 * 3600 * 1000;
/** Bump when the packing changes: older entries are then ignored. */
export const KEEP_VERSION = 1;

/** A coastline as kept: points as offsets (m) from `origin`, Float32 (to ~1 cm over 130 km), each line's length. */
export interface KeptCoast {
  v: number;
  /** When it was fetched (ms since 1970). */
  at: number;
  origin: XY;
  lengths: Uint32Array;
  xy: Float32Array;
}

/** The key a coastline is kept under: the box it was fetched for (coastBox). */
export const coastKeepKey = (box: string) => `coast:${box}`;

/** The lines (OS grid m) packed small; an empty list (no coast there) is kept too. */
export function packCoast(lines: XY[][], at: number): KeptCoast {
  let n = 0;
  let ox = Infinity;
  let oy = Infinity;
  for (const l of lines)
    for (const [x, y] of l) {
      n++;
      if (x < ox) ox = x;
      if (y < oy) oy = y;
    }
  if (!n) ox = oy = 0;
  const origin: XY = [Math.round(ox), Math.round(oy)];
  const xy = new Float32Array(n * 2);
  const lengths = new Uint32Array(lines.length);
  let k = 0;
  lines.forEach((l, i) => {
    lengths[i] = l.length;
    for (const [x, y] of l) {
      xy[k++] = x - origin[0];
      xy[k++] = y - origin[1];
    }
  });
  return { v: KEEP_VERSION, at, origin, lengths, xy };
}

/** Whether a kept entry is no use any more (another version, damaged, or older than KEEP_MS at `now`) — cheap: nothing unpacked. */
export function keptStale(kept: unknown, now: number): boolean {
  if (!kept || typeof kept !== "object") return true;
  const k = kept as Partial<KeptCoast>;
  return k.v !== KEEP_VERSION || typeof k.at !== "number" || !(now - k.at < KEEP_MS);
}

/** The lines back (null when it isn't a kept coastline of this version, is damaged, or is older than KEEP_MS at `now`). */
export function unpackCoast(kept: unknown, now: number): XY[][] | null {
  if (!kept || typeof kept !== "object") return null;
  const k = kept as Partial<KeptCoast>;
  if (k.v !== KEEP_VERSION || typeof k.at !== "number" || !(now - k.at < KEEP_MS) || k.at > now + 24 * 3600 * 1000) return null;
  if (!Array.isArray(k.origin) || k.origin.length !== 2 || !k.origin.every(Number.isFinite)) return null;
  if (!(k.lengths instanceof Uint32Array) || !(k.xy instanceof Float32Array)) return null;
  let total = 0;
  for (const len of k.lengths) total += len;
  if (total * 2 !== k.xy.length) return null;
  const [ox, oy] = k.origin;
  const out: XY[][] = [];
  let p = 0;
  for (const len of k.lengths) {
    const line: XY[] = new Array(len);
    for (let i = 0; i < len; i++, p += 2) {
      const x = k.xy[p] + ox;
      const y = k.xy[p + 1] + oy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      line[i] = [x, y];
    }
    out.push(line);
  }
  return out;
}
