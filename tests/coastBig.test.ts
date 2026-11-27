/**
 * Big coasts (Lewis and Harris: 18 MB, ~180k points, which a server has taken over a minute to send): the waits grow
 * with the area and the server's own limit is longer than the window's; the coastline is kept small in the browser
 * (packed, a month); and reading a file that size is quick.
 */
import { describe, expect, it } from "vitest";
import { coastBox, coastOnGrid, coastQuery, coastWaitMs, COAST_SERVER_TIMEOUT } from "../src/terrain/coastline";
import { coastKeepKey, KEEP_MS, keptStale, packCoast, unpackCoast } from "../src/terrain/coastStore";
import { ISLANDS } from "../src/terrain/islands";
import { readOsm } from "../src/terrain/osm";

type XY = [number, number];

describe("waiting for a big coast", () => {
  it("a small island waits about a minute, Lewis and Harris up to 150 s", () => {
    const lewis = ISLANDS.find((i) => i.id === "lewis-harris")!;
    const arran = ISLANDS.find((i) => i.id === "arran")!;
    expect(coastWaitMs(3000, 3000)).toBe(60_000);
    expect(coastWaitMs(arran.width, arran.height)).toBeLessThan(90_000);
    expect(coastWaitMs(lewis.width, lewis.height)).toBe(150_000);
    // The servers' own limit (s) is longer than the longest wait, so they never give up first.
    expect(COAST_SERVER_TIMEOUT * 1000).toBeGreaterThan(coastWaitMs(130_000, 130_000));
    expect(coastQuery(lewis.sw, lewis.width, lewis.height)).toContain(`[timeout:${COAST_SERVER_TIMEOUT}]`);
    expect(coastQuery(lewis.sw, lewis.width, lewis.height)).toContain(`(${coastBox(lewis.sw, lewis.width, lewis.height)})`);
  });
});

describe("keeping a coastline in the browser", () => {
  const lines: XY[][] = [
    [
      [123456.78, 912345.67],
      [123500.12, 912400.5],
      [140000, 950000.25],
    ],
    [],
    [
      [200000, 960000],
      [200001.5, 960002.5],
    ],
  ];
  const now = Date.UTC(2026, 10, 27);

  it("packed and unpacked comes back to within a couple of centimetres, line for line", () => {
    const kept = packCoast(lines, now);
    expect(kept.xy instanceof Float32Array).toBe(true);
    expect(kept.xy.length).toBe(10);
    const back = unpackCoast(kept, now + 1000)!;
    expect(back.map((l) => l.length)).toEqual([3, 0, 2]);
    back.forEach((l, i) => l.forEach((p, j) => {
      expect(Math.abs(p[0] - lines[i][j][0])).toBeLessThan(0.02);
      expect(Math.abs(p[1] - lines[i][j][1])).toBeLessThan(0.02);
    }));
    // No coast there is kept too (so it isn't asked for again).
    expect(unpackCoast(packCoast([], now), now)).toEqual([]);
  });

  it("older than a month, another version or damaged: not used", () => {
    const kept = packCoast(lines, now);
    expect(unpackCoast(kept, now + KEEP_MS + 1)).toBeNull();
    expect(keptStale(kept, now + KEEP_MS + 1)).toBe(true);
    expect(keptStale(kept, now)).toBe(false);
    expect(unpackCoast({ ...kept, v: 99 }, now)).toBeNull();
    expect(unpackCoast({ ...kept, xy: new Float32Array(3) }, now)).toBeNull();
    expect(unpackCoast({ ...kept, lengths: [3, 0, 2] }, now)).toBeNull();
    expect(unpackCoast(null, now)).toBeNull();
    expect(unpackCoast("nonsense", now)).toBeNull();
  });

  it("is kept by the box fetched, small", () => {
    expect(coastKeepKey("58.0,-7.0,58.5,-6.0")).toBe("coast:58.0,-7.0,58.5,-6.0");
    // 180k points = 1.4 MB packed, against 18 MB of map file.
    const many: XY[][] = [Array.from({ length: 180_000 }, (_, i) => [100000 + i, 900000 + (i % 1000)] as XY)];
    expect(packCoast(many, now).xy.byteLength).toBe(180_000 * 8);
  });
});

describe("reading a coast the size of Lewis and Harris's", () => {
  it("16 MB, 180k points, read and put on the grid in a few seconds", () => {
    // Overpass's "out qt" order: the ways first, then their nodes; ways of 600 points round a wiggly island.
    const N = 180_000;
    const per = 600;
    const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="Overpass API 0.7.62">\n<note>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</note>\n<meta osm_base="2026-11-27T10:00:00Z"/>\n'];
    for (let w = 0; w < N / per; w++) {
      parts.push(`  <way id="${100000000 + w}">\n`);
      for (let k = 0; k <= per; k++) parts.push(`    <nd ref="${1000000000 + ((w * per + k) % N)}"/>\n`);
      parts.push('    <tag k="natural" v="coastline"/>\n    <tag k="source" v="PGS"/>\n  </way>\n');
    }
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      const r = 0.25 + 0.01 * Math.sin(i / 7);
      parts.push(`  <node id="${1000000000 + i}" lat="${(58.1 + r * Math.sin(a)).toFixed(7)}" lon="${(-6.6 + r * 2 * Math.cos(a)).toFixed(7)}"/>\n`);
    }
    parts.push("</osm>\n");
    const text = parts.join("");
    expect(text.length).toBeGreaterThan(15_000_000);
    const t0 = performance.now();
    const data = readOsm(text);
    const t1 = performance.now();
    const lines = coastOnGrid(data.coastline ?? []);
    const t2 = performance.now();
    expect(data.coastline?.length).toBe(N / per);
    expect(lines.reduce((s, l) => s + l.length, 0)).toBe(N + N / per);
    console.log(`read ${(text.length / 1e6).toFixed(1)} MB in ${Math.round(t1 - t0)} ms, on the grid in ${Math.round(t2 - t1)} ms`);
    // Generous (CI is often busy): it's a fraction of this here.
    expect(t2 - t0).toBeLessThan(20_000);
  });
});

describe("looking for a kept coastline never holds up the fetch", () => {
  it("an IndexedDB that never answers: given up after a few seconds, or at once when stopped", async () => {
    const { keptCoast } = await import("../src/app/coastKeep");
    const g = globalThis as { indexedDB?: unknown };
    const before = g.indexedDB;
    // An open request whose events never fire (a Safari bug, a broken profile).
    g.indexedDB = { open: () => ({}) };
    try {
      const stop = new AbortController();
      const t0 = Date.now();
      const stopped = keptCoast("box", stop.signal);
      stop.abort();
      expect(await stopped).toBeNull();
      expect(Date.now() - t0).toBeLessThan(500);
      const t1 = Date.now();
      expect(await keptCoast("box")).toBeNull();
      expect(Date.now() - t1).toBeLessThan(10_000);
    } finally {
      g.indexedDB = before;
    }
  });
});
