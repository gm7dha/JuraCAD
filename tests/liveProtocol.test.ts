/**
 * Live with Claude: the rules of the local link (src/live/protocol.ts), the
 * WebSocket frames (src/mcp/websocket.ts) and the undo labels (src/mcp/live.ts).
 */
import { describe, expect, it } from "vitest";
import { decideChange, hostAllowed, isNewer, LIVE_PATH, LIVE_SUBPROTOCOL, originAllowed, parseAppMessage, parseExtensionMessage } from "../src/live/protocol";
import { blockedHelp, notFoundHelp, recheckDelay, RECHECK } from "../src/live/client";
import { acceptKey, CLOSE, encodeFrame, FrameReader, upgradeProblem } from "../src/mcp/websocket";
import { describeChange } from "../src/mcp/live";
import { createFeature, addFeature, emptyDocument } from "../src/model/document";

describe("who may connect", () => {
  it("only the JuraCAD site; pages on this computer only in development mode", () => {
    expect(originAllowed("https://gm7dha.github.io")).toBe(true);
    for (const local of ["http://localhost:4173", "http://localhost", "http://127.0.0.1:5173", "http://[::1]:5173", "https://localhost:4443", "http://localhost:9999", "http://127.0.0.1:1234"]) {
      // A local dev server, or a page some other program serves, can't connect to the shipped extension...
      expect(originAllowed(local)).toBe(false);
      // ...only when JURACAD_LIVE_DEV=1 (JuraCAD's own tests).
      expect(originAllowed(local, true)).toBe(true);
    }
    for (const bad of [
      undefined,
      null,
      "",
      "null",
      "https://evil.example",
      "http://gm7dha.github.io",
      "https://gm7dha.github.io.evil.example",
      "https://evil.gm7dha.github.io",
      "https://gm7dha.github.io:444",
      "ws://localhost:4173",
      "http://localhost.evil.example",
      "http://localhost:4173/path",
      "http://127.0.0.2",
      "file://",
      "chrome-extension://abcdef",
    ]) {
      expect(originAllowed(bad)).toBe(false);
      expect(originAllowed(bad, true)).toBe(false);
    }
  });

  it("only our own loopback address and port as the Host (no DNS tricks)", () => {
    expect(hostAllowed("127.0.0.1:47615", 47615)).toBe(true);
    expect(hostAllowed("localhost:47615", 47615)).toBe(true);
    expect(hostAllowed("[::1]:47615", 47615)).toBe(true);
    expect(hostAllowed("127.0.0.1:47616", 47615)).toBe(false);
    expect(hostAllowed("evil.example:47615", 47615)).toBe(false);
    expect(hostAllowed("127.0.0.1", 47615)).toBe(false);
    expect(hostAllowed(undefined, 47615)).toBe(false);
  });

  it("checks every part of the WebSocket request", () => {
    const good = {
      method: "GET",
      url: LIVE_PATH,
      headers: {
        host: "127.0.0.1:47615",
        origin: "https://gm7dha.github.io",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": `other, ${LIVE_SUBPROTOCOL}`,
      },
    };
    expect(upgradeProblem(good, 47615)).toBeNull();
    const without = (k: string, v?: string) => ({ ...good, headers: { ...good.headers, [k]: v } });
    expect(upgradeProblem(without("origin", "https://evil.example"), 47615)!.status).toBe(403);
    expect(upgradeProblem(without("origin"), 47615)!.status).toBe(403);
    expect(upgradeProblem(without("origin", "http://localhost:5173"), 47615)!.status).toBe(403);
    expect(upgradeProblem(without("origin", "http://localhost:5173"), 47615, true)).toBeNull();
    expect(upgradeProblem(without("host", "evil.example:47615"), 47615)!.status).toBe(403);
    expect(upgradeProblem(without("sec-websocket-protocol", "chat"), 47615)!.status).toBe(400);
    expect(upgradeProblem(without("sec-websocket-key", "short"), 47615)!.status).toBe(400);
    expect(upgradeProblem(without("sec-websocket-version", "8"), 47615)!.status).toBe(426);
    expect(upgradeProblem({ ...good, url: "/other" }, 47615)!.status).toBe(404);
    expect(upgradeProblem({ ...good, method: "POST" }, 47615)!.status).toBe(405);
  });

  it("answers the handshake as RFC 6455 says", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("messages", () => {
  const file = '{"format":"partsmith"}';
  it("accepts well-formed messages from the app and turns away anything else", () => {
    expect(parseAppMessage(JSON.stringify({ type: "hello", protocol: 1, app: "0.26.1", version: 1, studio: "main", file }))).toEqual({ type: "hello", protocol: 1, app: "0.26.1", version: 1, studio: "main", file });
    expect(parseAppMessage(JSON.stringify({ type: "doc", version: 4, studio: "s2", file, extra: 1 }))).toEqual({ type: "doc", version: 4, studio: "s2", file });
    expect(parseAppMessage(JSON.stringify({ type: "applied", id: 3, version: 5 }))).toEqual({ type: "applied", id: 3, version: 5 });
    expect(parseAppMessage(JSON.stringify({ type: "refused", id: 3, version: 5, reason: "busy", message: "a dialog is open" }))).toMatchObject({ reason: "busy" });
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ type: "hello", protocol: 2, app: "x", version: 1, studio: "main", file }),
      JSON.stringify({ type: "doc", version: -1, studio: "main", file }),
      JSON.stringify({ type: "doc", version: 1.5, studio: "main", file }),
      JSON.stringify({ type: "doc", version: 1, studio: "main", file: 42 }),
      JSON.stringify({ type: "refused", id: 1, version: 1, reason: "whatever", message: "" }),
      JSON.stringify({ type: "save", path: "/etc/passwd" }),
      JSON.stringify({ type: "change", id: 1, base: 1, studio: "main", file, label: "x", replace: false }),
    ]) {
      expect("error" in parseAppMessage(bad)).toBe(true);
    }
  });

  it("accepts well-formed messages from the extension", () => {
    expect(parseExtensionMessage(JSON.stringify({ type: "welcome", protocol: 1, extension: "0.26.1" }))).toEqual({ type: "welcome", protocol: 1, extension: "0.26.1" });
    expect(parseExtensionMessage(JSON.stringify({ type: "change", id: 1, base: 2, studio: "main", file, label: "Claude: added Extrude 1", replace: false }))).toMatchObject({ base: 2 });
    expect("error" in parseExtensionMessage(JSON.stringify({ type: "change", id: 1, base: 2, studio: "main", file, label: "x" }))).toBe(true);
    expect("error" in parseExtensionMessage(JSON.stringify({ type: "hello" }))).toBe(true);
  });
});

describe("versions", () => {
  it("applies Claude's change only on top of exactly the design it was made from", () => {
    expect(decideChange(4, 4, null)).toEqual({ apply: true, version: 5 });
    expect(decideChange(5, 4, null)).toMatchObject({ apply: false, reason: "changed" });
    expect(decideChange(3, 4, null)).toMatchObject({ apply: false, reason: "changed" });
    expect(decideChange(4, 4, "A dialog is open.")).toEqual({ apply: false, reason: "busy", message: "A dialog is open." });
  });

  it("never goes back to an older version", () => {
    expect(isNewer(4, 5)).toBe(true);
    expect(isNewer(5, 5)).toBe(false);
    expect(isNewer(5, 4)).toBe(false);
  });
});

describe("WebSocket frames", () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  function reader(max?: number) {
    const got: string[] = [];
    const pings: string[] = [];
    const closes: number[] = [];
    const r = new FrameReader(true, { onMessage: (t) => got.push(t), onPing: (d) => pings.push(d.toString()), onClose: (c) => closes.push(c) }, max);
    return { r, got, pings, closes };
  }

  it("reads masked text messages of every length, split anywhere, and joins continued ones", () => {
    const { r, got } = reader();
    const long = "é".repeat(40_000); // 80 000 bytes: a 64-bit length
    const mid = "x".repeat(300); // a 16-bit length
    const bytes = Buffer.concat([
      encodeFrame(1, Buffer.from("hello"), mask),
      encodeFrame(1, Buffer.from(mid), mask),
      encodeFrame(1, Buffer.from(long), mask),
      encodeFrame(1, Buffer.from("par"), mask, false),
      encodeFrame(9, Buffer.from("ping!"), mask),
      encodeFrame(0, Buffer.from("ts"), mask),
    ]);
    // Arrives in awkward pieces.
    for (let i = 0; i < bytes.length; i += 7777) r.push(bytes.subarray(i, i + 7777));
    expect(got).toEqual(["hello", mid, long, "parts"]);
  });

  it("answers pings, and closes on anything not allowed", () => {
    const a = reader();
    a.r.push(encodeFrame(9, Buffer.from("hi"), mask));
    expect(a.pings).toEqual(["hi"]);
    const unmasked = reader();
    unmasked.r.push(encodeFrame(1, Buffer.from("hello")));
    expect(unmasked.closes).toEqual([CLOSE.protocol]);
    const binary = reader();
    binary.r.push(encodeFrame(2, Buffer.from([1, 2, 3]), mask));
    expect(binary.closes).toEqual([CLOSE.unsupported]);
    const big = reader(1000);
    big.r.push(encodeFrame(1, Buffer.alloc(1001, 65), mask).subarray(0, 20));
    expect(big.closes).toEqual([CLOSE.tooBig]);
    expect(big.got).toEqual([]);
    const bigInParts = reader(1000);
    bigInParts.r.push(encodeFrame(1, Buffer.alloc(600, 65), mask, false));
    bigInParts.r.push(encodeFrame(0, Buffer.alloc(600, 65), mask));
    expect(bigInParts.closes).toEqual([CLOSE.tooBig]);
    const badText = reader();
    badText.r.push(encodeFrame(1, Buffer.from([0xff, 0xfe]), mask));
    expect(badText.closes).toEqual([CLOSE.badData]);
    const stray = reader();
    stray.r.push(encodeFrame(0, Buffer.from("x"), mask));
    expect(stray.closes).toEqual([CLOSE.protocol]);
    const closing = reader();
    const payload = Buffer.from([0x03, 0xe8]);
    closing.r.push(encodeFrame(8, payload, mask));
    expect(closing.closes).toEqual([1000]);
  });
});

describe("undo step labels", () => {
  it("say what Claude did, in a few words", () => {
    const empty = emptyDocument("Lid");
    const sketch = createFeature(empty, "sketch");
    const one = addFeature(empty, sketch);
    const ext = createFeature(one, "extrude");
    const two = addFeature(one, ext);
    expect(describeChange("add_sketch", empty, one, false)).toBe(`Claude: added ${sketch.name}`);
    expect(describeChange("add_feature", one, two, false)).toBe(`Claude: added ${ext.name}`);
    expect(describeChange("delete_feature", two, one, false)).toBe(`Claude: deleted ${ext.name}`);
    const renamed = { ...two, features: two.features.map((f) => (f.id === ext.id ? { ...f, params: { ...f.params, depth: "9" } } : f)) };
    expect(describeChange("edit_feature", two, renamed, false)).toBe(`Claude: changed ${ext.name}`);
    expect(describeChange("undo", two, one, false)).toBe("Claude: undid its last change");
    expect(describeChange("new_design", two, emptyDocument("Box"), true)).toBe('Claude: started a new design, "Box"');
    expect(describeChange("open_design", two, emptyDocument("Bracket"), true)).toBe('Claude: opened "Bracket"');
    expect(describeChange("set_variables", one, { ...one, variables: [{ id: "v1", name: "t", value: "3" }] }, false)).toBe("Claude: changed the variables");
  });
});

describe("looking for Claude chats started later", () => {
  it("looks every 4 s for the first minute after Connect, then every 25 s", () => {
    expect(RECHECK).toEqual({ fast: 4_000, fastFor: 60_000, slow: 25_000 });
    expect(recheckDelay(0)).toBe(4_000);
    expect(recheckDelay(59_999)).toBe(4_000);
    expect(recheckDelay(60_000)).toBe(25_000);
    expect(recheckDelay(3_600_000)).toBe(25_000);
    // About 15 + 142 = 157 looks in the first hour, instead of 900.
    let t = 0;
    let looks = 0;
    while ((t += recheckDelay(t)) <= 3_600_000) looks++;
    expect(looks).toBeLessThan(160);
    expect(recheckDelay(500, { fast: 100, fastFor: 1_000, slow: 5_000 })).toBe(100);
    expect(recheckDelay(1_000, { fast: 100, fastFor: 1_000, slow: 5_000 })).toBe(5_000);
  });
});

describe("advice when Claude can't be reached", () => {
  it("is plain English and always offers the file route", () => {
    for (const b of ["chrome", "edge", "firefox", "safari", "other"] as const) {
      const h = notFoundHelp(b);
      expect(h.help.join(" ")).toMatch(/\.juracad file/);
      expect(blockedHelp(b).help.join(" ")).toMatch(/\.juracad file/);
    }
    expect(notFoundHelp("safari").title).toBe("Safari can't connect to Claude");
    expect(notFoundHelp("chrome").help.join(" ")).toMatch(/Claude desktop app is open/);
  });
});
