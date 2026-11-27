/**
 * Coastlines kept in this browser (IndexedDB) between visits, so a big coast is fetched only once a month. Everything
 * here may fail (private windows, storage turned off or full): it then quietly keeps nothing. Packing is in
 * src/terrain/coastStore.ts.
 */
import { coastKeepKey, keptStale, packCoast, unpackCoast } from "../terrain/coastStore";

const DB = "juracad.coastlines";
const STORE = "coasts";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((done) => {
    try {
      if (typeof indexedDB === "undefined") return done(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE);
        } catch {
          // Already there.
        }
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}

/** The coastline kept for the box (coastBox), or null (none kept, too old, or storage not to be had). */
export async function keptCoast(box: string): Promise<[number, number][][] | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise((done) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(coastKeepKey(box));
        req.onsuccess = () => done(unpackCoast(req.result, Date.now()));
        req.onerror = () => done(null);
      } catch {
        done(null);
      }
    });
  } finally {
    db.close();
  }
}

/** Keeps the coastline (OS grid m) for the box; old entries are cleared out at the same time. Never throws. */
export async function keepCoast(box: string, lines: [number, number][][]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((done) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const now = Date.now();
        // Coastlines past their time are dropped, so the store doesn't grow for ever.
        const all = store.openCursor();
        all.onsuccess = () => {
          const c = all.result;
          if (!c) return;
          if (keptStale(c.value, now)) c.delete();
          c.continue();
        };
        store.put(packCoast(lines, now), coastKeepKey(box));
        tx.oncomplete = () => done();
        tx.onerror = () => done();
        tx.onabort = () => done();
      } catch {
        done();
      }
    });
  } finally {
    db.close();
  }
}
