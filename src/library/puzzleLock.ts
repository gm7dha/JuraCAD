/**
 * The light lock on the library's Map puzzles tab (pure apart from the browser's own SHA-256). It only keeps casual
 * visitors out — the code is public. The password itself is never written anywhere: what's typed is hashed with
 * `PUZZLE_SALT` in front and compared with `PUZZLE_HASH`. Once it matches, the hash is kept in this browser
 * (`PUZZLES_UNLOCKED_KEY`) and counts only while it still equals `PUZZLE_HASH`, so a new password locks everyone again.
 */

export const PUZZLES_UNLOCKED_KEY = "juracad.puzzlesUnlocked";
export const PUZZLE_SALT = "juracad-puzzles:";
/** SHA-256 (hex) of PUZZLE_SALT + the password. */
export const PUZZLE_HASH = "df24f371b7f39e083ea1257fe81741315784d2efb7f17cb91c6af9b858914fac";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined | null;

const storage = (): Store => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

/** SHA-256 of a text (UTF-8), as lower-case hex. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The hash to keep if `typed` is the password (spaces round it are forgiven), else null. `expected` is for tests,
 * which use a password of their own.
 */
export async function passwordHash(typed: string, expected: string = PUZZLE_HASH): Promise<string | null> {
  for (const t of new Set([typed, typed.trim()])) {
    if (!t) continue;
    const h = await sha256Hex(PUZZLE_SALT + t);
    if (h === expected) return h;
  }
  return null;
}

/** Whether this browser has the Map puzzles unlocked. */
export function puzzlesUnlocked(store: Store = storage(), expected: string = PUZZLE_HASH): boolean {
  try {
    return store?.getItem(PUZZLES_UNLOCKED_KEY) === expected;
  } catch {
    return false;
  }
}

/** Keep the unlock in this browser (a hash from `passwordHash`). */
export function rememberUnlock(hash: string, store: Store = storage()): void {
  try {
    store?.setItem(PUZZLES_UNLOCKED_KEY, hash);
  } catch {
    // Private windows and blocked storage: it stays open until the window is closed, as the app keeps it too.
  }
}

/** Lock the section again in this browser. */
export function forgetUnlock(store: Store = storage()): void {
  try {
    store?.removeItem(PUZZLES_UNLOCKED_KEY);
  } catch {
    // Nothing kept, so nothing to forget.
  }
}
