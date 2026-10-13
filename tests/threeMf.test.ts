import { describe, expect, it } from "vitest";

import { crc32, weld, write3mf, zipStored } from "../src/geometry/threeMf";

/** Read a stored (uncompressed) zip back into name → text, checking each file's CRC. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out[name] = new TextDecoder().decode(data);
    at += 30 + nameLen + size;
  }
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return out;
}

describe("3MF files", () => {
  it("computes standard CRC-32 checksums", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("joins repeated corners and drops collapsed triangles", () => {
    const m = weld([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 0, 1, 3]);
    expect(m.vertices).toHaveLength(9);
    expect(m.triangles).toEqual([0, 1, 2, 1, 2, 0]);
  });

  it("packs the three files a 3MF needs", () => {
    const files = unzip(write3mf([{ name: "Part <1>", vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }], "Test"));
    expect(Object.keys(files)).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    expect(files["3D/3dmodel.model"]).toMatch(/name="Part &lt;1&gt;"/);
    expect(files["3D/3dmodel.model"]).toMatch(/<item objectid="1"\/>/);
  });

  it("writes identical files for identical models", () => {
    const a = zipStored([{ name: "a.txt", data: "hello" }]);
    const b = zipStored([{ name: "a.txt", data: "hello" }]);
    expect(a).toEqual(b);
  });
});
