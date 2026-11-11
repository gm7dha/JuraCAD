/**
 * The six-piece burr's search (pure): made faster without changing any puzzle people may already have, and with its work
 * bounded by a count of positions looked at (never a clock), so every puzzle number is made in about a second at most.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SEARCH_MOST, WORK_MOST, burrWork, contested, disassembly, makeBurr, piecesFrom, repaired, searchWithin } from "../src/library/burr";
import { seeded } from "../src/library/puzzle";
import { disassemblySlow } from "./support/burrSlow";

/**
 * makeBurr(seed, difficulty) for seeds 1–30, as the burr maker made them before it was sped up (sha-256 of the burr's
 * JSON, first 16 hex digits). A saved insert keeps only the seed, so these must never change.
 */
const BEFORE: Record<string, string[]> = {
  easy: [
    "a710602a81a33054", "ffd580a8f5520fb0", "91dc0c9cb27b024e", "1a4d2081d412f5ea", "63f9a3faef70b017", "aa3c36083a94c3d8",
    "f8f4d9bba1068888", "6b6b58272e19b6c0", "9decc024ca7cffa8", "1a4f30de53422340", "336cc22c55668952", "3fc3782e2de0a67a",
    "a9fa89a44c06407c", "1c2a3a199566342c", "9d1f22d8c6264550", "78235fd9a96f0df7", "edd342a8c5299434", "e0180016f4fb7f6b",
    "0dd4c18f67ab72e4", "0b0c7aa09bd97aaa", "b6e1cb16e33a8a25", "3309680d5bd06852", "41e10db0544f0a53", "476681c0078c3abf",
    "066e76b170830f6a", "39b68d32ff445c0c", "7bad5098049ea113", "a65e882cd6d6da12", "1c2a3a199566342c", "39ca17673bbfc129",
  ],
  medium: [
    "186c5a4cba488885", "2a88bdfcc2f0655b", "15e26355ce53a7ec", "622b2770a9818fd5", "9c17c2e855a46386", "39d888145e9c4d1f",
    "ea39f3e88b4a4374", "c3c464ff869a9397", "2a90cc79d51f1b8d", "d6ae65e675f2282f", "980f70c1cbf1ff9c", "2f1531ea4e735558",
    "20cba6028e5d9f91", "87484de5cd957330", "d1c89222c4147d42", "f3f0d4a161806e8d", "ff6a13bcea7b03a4", "2aa48813eb6a77ed",
    "ce41ed0eeee40892", "3f11955f44770956", "85dc0c81362362e0", "e222a7c50c3820cf", "eac80cd9bab1a15b", "7bf8681d91733e27",
    "7c761aa9838a1a4b", "01787774c0264c04", "caa960a67d2b6c7b", "0ee86ec6f3258859", "c3e01aab10645e7a", "4ffd82383b436bdb",
  ],
  hard: [
    "f745f96b2f66c4ba", "df0497e598eec54d", "b7b8255c576f2ab0", "45d5b08999c223e7", "99ecff185298e2d6", "217cca95d5c520db",
    "ddabe585a7d15594", "0941e3787a2c0841", "94365b53b55400db", "4567675bc8b89e59", "576e2c2908e36978", "8dcf823ba1e71986",
    "d33431ef000b4390", "ed1fae7aa5d8f3eb", "8540ea1a5c4315f2", "baf2d740a15477e3", "12776711329d082c", "00f6d9bbc98f9e29",
    "6d7645c90f9f9f86", "bf0fb3754a80af09", "ab749c84693700a7", "a50e8db744c78199", "70920d6e22552d93", "d3087b46f6b46d26",
    "7189a642bce8875a", "ee7e7234cfa8245d", "5a50fe6bf26d9336", "39626f5dc73d6273", "b62f8f8d246a0edc", "bb1f25613208e8b3",
  ],
};

const fingerprint = (seed: number, difficulty: string) => createHash("sha256").update(JSON.stringify(makeBurr(seed, difficulty))).digest("hex").slice(0, 16);

describe("Six-piece burr search", () => {
  it("makes exactly the same puzzles as before for numbers 1–30 at every difficulty", () => {
    for (const [difficulty, prints] of Object.entries(BEFORE))
      prints.forEach((print, i) => expect(fingerprint(i + 1, difficulty), `${difficulty} ${i + 1}`).toBe(print));
    // Hard 39 and 42 give up on one slow set each (below), yet come out as the full search (minutes long) makes them.
    expect(fingerprint(39, "hard")).toBe("f2e7b1e447503805");
    expect(fingerprint(42, "hard")).toBe("cf25b2d94a0f9c93");
  });

  it("gives the same answers as the original solver, whether a set comes apart or not", () => {
    const rnd = seeded(5);
    const c = contested();
    let apart = 0;
    let stuck = 0;
    for (let t = 0; t < 120; t++) {
      const owners = repaired(c.map(({ by }) => (rnd() < 0.3 ? -1 : by[Math.floor(rnd() * by.length)])), rnd);
      if (!owners) continue;
      const pieces = piecesFrom(owners);
      const level = disassembly(pieces, 8000);
      expect(level).toBe(disassemblySlow(pieces, 8000));
      if (level === null) stuck++;
      else apart++;
    }
    // Both kinds were checked.
    expect(apart).toBeGreaterThan(20);
    expect(stuck).toBeGreaterThan(5);
    // And the burrs themselves, levels 1 to 5.
    for (const [seed, difficulty] of [[1, "easy"], [3, "medium"], [6, "hard"], [12, "hard"], [42, "hard"]] as const) {
      const b = makeBurr(seed, difficulty);
      expect(disassembly(b.pieces)).toBe(b.level);
      expect(disassemblySlow(b.pieces)).toBe(b.level);
    }
  });

  it("bounds the work: every puzzle number takes a limited count of positions looked at", () => {
    for (const difficulty of ["easy", "medium", "hard"])
      for (let seed = 1; seed <= 30; seed++) {
        const w = burrWork(seed, difficulty);
        // Well inside the budget, so the budget never changed these puzzles.
        expect(w.gaveUp, `${difficulty} ${seed}`).toBe(0);
        expect(w.biggest, `${difficulty} ${seed}`).toBeLessThan(SEARCH_MOST / 1.5);
        expect(w.positions, `${difficulty} ${seed}`).toBeLessThan(WORK_MOST / 2);
      }
    // Hard 6 used to take the burr maker close to a minute; it's the same puzzle, found with the same searching.
    expect(burrWork(6, "hard").positions).toBeLessThan(30_000);
    expect(makeBurr(6, "hard").level).toBe(4);
    // Hard 39 and 42 each have one set the solver could search for minutes: it gives up on that one and carries on.
    for (const seed of [39, 42]) {
      const w = burrWork(seed, "hard");
      expect(w.gaveUp).toBe(1);
      expect(w.biggest).toBe(SEARCH_MOST);
      expect(w.positions).toBeLessThanOrEqual(WORK_MOST);
      expect(disassembly(makeBurr(seed, "hard").pieces)).toBe(makeBurr(seed, "hard").level);
    }
  });

  it("gives up after the given count of positions, the same way every time", () => {
    // Hard 39's slow set (it doesn't come apart, but that takes millions of positions to find out).
    const owners = [-1, -1, 0, 2, -1, 2, 0, -1, 2, 1, -1, 0, 2, 1, 5, 5, 4, 3, 0, 4, 4, 4, -1, 3, 1, 1, 3, 3, -1, 3, -1, 3];
    const a = searchWithin(piecesFrom(owners), 8000, 5000);
    expect(a).toEqual({ level: "too long", positions: 5000 });
    expect(searchWithin(piecesFrom(owners), 8000, 5000)).toEqual(a);
    // A quick one is answered as usual.
    const quick = searchWithin(makeBurr(3, "medium").pieces, 8000, 5000);
    expect(quick.level).toBe(makeBurr(3, "medium").level);
    expect(quick.positions).toBeLessThan(5000);
  });
});
