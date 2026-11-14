/**
 * The light lock on the library's Map puzzles (pure). The real password is never in a test: these use a password of
 * their own, by passing its hash as the one expected.
 */
import { describe, expect, it } from "vitest";
import { forgetUnlock, passwordHash, PUZZLE_HASH, PUZZLE_SALT, PUZZLES_UNLOCKED_KEY, puzzlesUnlocked, rememberUnlock, sha256Hex } from "../src/library/puzzleLock";
import { LIBRARY_SECTIONS, sectionFrom, sectionLabel, sectionLocked } from "../src/library/sections";
import { rememberedTab, rememberTab } from "../src/library/tabMemory";

const memory = () => {
  const kept = new Map<string, string>();
  return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
};

describe("Map puzzles lock", () => {
  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(PUZZLE_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(PUZZLE_SALT).toBe("juracad-puzzles:");
  });

  it("opens only for the right password", async () => {
    const expected = await sha256Hex(PUZZLE_SALT + "test-only secret");
    expect(await passwordHash("test-only secret", expected)).toBe(expected);
    expect(await passwordHash("  test-only secret ", expected)).toBe(expected);
    expect(await passwordHash("test-only Secret", expected)).toBeNull();
    expect(await passwordHash("", expected)).toBeNull();
    // The salt matters: the bare password's hash isn't the one kept.
    expect(await sha256Hex("test-only secret")).not.toBe(expected);
    expect(await passwordHash("test-only secret")).toBeNull();
  });

  it("stays unlocked in this browser until locked again, and a new password locks everyone", async () => {
    const store = memory();
    const expected = await sha256Hex(PUZZLE_SALT + "test-only secret");
    expect(puzzlesUnlocked(store, expected)).toBe(false);
    rememberUnlock(expected, store);
    expect(store.kept.get(PUZZLES_UNLOCKED_KEY)).toBe(expected);
    expect(puzzlesUnlocked(store, expected)).toBe(true);
    // The real password's hash is different, so this browser is locked as far as the app is concerned.
    expect(puzzlesUnlocked(store)).toBe(false);
    // Any other value kept there doesn't count.
    store.kept.set(PUZZLES_UNLOCKED_KEY, "true");
    expect(puzzlesUnlocked(store, expected)).toBe(false);
    rememberUnlock(expected, store);
    forgetUnlock(store);
    expect(puzzlesUnlocked(store, expected)).toBe(false);
    expect(store.kept.has(PUZZLES_UNLOCKED_KEY)).toBe(false);
  });

  it("copes without storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(puzzlesUnlocked(broken)).toBe(false);
    rememberUnlock(PUZZLE_HASH, broken);
    forgetUnlock(broken);
    expect(puzzlesUnlocked(null)).toBe(false);
  });
});

describe("library tabs", () => {
  it("has Map puzzles after Laser cutting and 3D printing, locked", () => {
    expect(LIBRARY_SECTIONS.map((s) => [s.id, s.label])).toEqual([
      ["laser", "Laser cutting"],
      ["print", "3D printing"],
      ["maps", "Map puzzles"],
    ]);
    expect(sectionLocked("maps")).toBe(true);
    expect(sectionLocked("print")).toBe(false);
    expect(sectionLabel("maps")).toBe("Map puzzles");
    expect(sectionFrom("maps")).toBe("maps");
    expect(sectionFrom("Map puzzles")).toBe("maps");
    expect(sectionFrom("3d")).toBe("print");
    expect(sectionFrom("wood")).toBeNull();
  });

  it("remembers the Map puzzles tab like the others (locked, it just shows the password box)", () => {
    const store = memory();
    rememberTab("maps", store);
    expect(rememberedTab(store)).toBe("maps");
  });
});
