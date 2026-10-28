import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, encodePng } from "../src/mcp/png";
import { renderViews } from "../src/mcp/render";
import { sheetPicture } from "../src/mcp/sheetPicture";
import { glyph, UNKNOWN_GLYPH } from "../src/mcp/font5x7";

/** A cube from (0,0,0) to (10,10,h) as triangles, and its 12 edges as line pairs. */
function block(h: number) {
  const v: number[] = [];
  for (const z of [0, h]) for (const y of [0, 10]) for (const x of [0, 10]) v.push(x, y, z);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const triangles = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const lines = edges.flatMap(([a, b]) => [...v.slice(3 * a, 3 * a + 3), ...v.slice(3 * b, 3 * b + 3)]);
  return { vertices: v, triangles, lines };
}

/** Decode our own PNGs (RGB, no filter) back to pixels. */
function pixels(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  let at = 8;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, at: (x: number, y: number) => [...raw.subarray(y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)] };
}

describe("pictures of parts", () => {
  it("writes valid PNG files", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]));
    const p = pixels(png);
    expect([p.width, p.height]).toEqual([2, 1]);
    expect(p.at(0, 0)).toEqual([255, 0, 0]);
    expect(p.at(1, 0)).toEqual([0, 0, 255]);
  });

  it("draws a tall block filling the middle of the front view, and a square from the top", () => {
    const img = renderViews([block(30)], ["front", "top"], 200);
    expect(img.layout).toBe("front (left), top (right)");
    const p = pixels(img.png);
    expect([p.width, p.height]).toEqual([400, 200]);
    const isWhite = (c: number[]) => c.every((v) => v === 255);
    // Front view: 10 wide by 30 high, scaled so the height fits (120 px): about 40 px wide, centred.
    expect(isWhite(p.at(100, 100))).toBe(false);
    expect(isWhite(p.at(100, 45))).toBe(false);
    expect(isWhite(p.at(100, 35))).toBe(true);
    expect(isWhite(p.at(140, 100))).toBe(true);
    expect(isWhite(p.at(100, 170))).toBe(true);
    // Top view, at the same scale: a 40 px square in the middle of the right-hand panel.
    expect(isWhite(p.at(300, 100))).toBe(false);
    expect(isWhite(p.at(300 + 17, 100 + 17))).toBe(false);
    expect(isWhite(p.at(300 + 25, 100))).toBe(true);
    expect(isWhite(p.at(300, 100 - 25))).toBe(true);
  });
});

describe("pictures of drawing sheets", () => {
  it("draws lines where they are on the paper (y up), dashed hidden lines, filled arrowheads and text", () => {
    // A 100 × 50 mm sheet at 4 pixels per mm.
    const img = sheetPicture(
      [
        { kind: "path", points: [10, 10, 90, 10], style: "visible" },
        { kind: "path", points: [10, 40, 90, 40], style: "hidden" },
        { kind: "path", points: [50, 20, 54, 22, 50, 24], closed: true, fill: true, style: "thin" },
        { kind: "text", x: 20, y: 25, text: "40", size: 5, anchor: "start" },
      ],
      [100, 50],
      400,
    );
    expect([img.width, img.height, img.pxPerMm]).toEqual([400, 200, 4]);
    const p = pixels(img.png);
    const dark = (x: number, y: number) => p.at(x, y).every((v) => v < 200);
    // The visible line 10 mm up the sheet is 40 px from the bottom of the picture.
    expect(dark(200, 160)).toBe(true);
    expect(dark(200, 150)).toBe(false);
    // The hidden line is dashed: some of it drawn, some gaps.
    const along = Array.from({ length: 200 }, (_, i) => !p.at(100 + i, 40).every((v) => v === 255));
    expect(along.some((x) => x)).toBe(true);
    expect(along.some((x) => !x)).toBe(true);
    // The arrowhead is filled.
    expect(dark(201, 112)).toBe(true);
    // The text sits on its baseline (25 mm up = 100 px down), starting at x = 20 mm.
    let inked = 0;
    for (let y = 85; y < 100; y++) for (let x = 80; x < 110; x++) if (dark(x, y)) inked++;
    expect(inked).toBeGreaterThan(20);
    expect(dark(75, 92)).toBe(false);
  });

  it("has every letter, digit and drawing sign a sheet uses", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:-+/()°Ø⌀×±") expect(glyph(ch).join("")).not.toBe(UNKNOWN_GLYPH.join(""));
    for (const g of "AZ09".split("").map(glyph)) {
      expect(g).toHaveLength(7);
      for (const row of g) expect(row).toHaveLength(5);
    }
  });
});
