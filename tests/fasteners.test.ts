import { describe, expect, it } from "vitest";

import { FASTENER_KINDS, FASTENER_SIZES, fastenerName, hasLength, shankOf } from "../src/model/fasteners";
import { emptyDocument, parseDocument } from "../src/model/document";

describe("fastener sizes", () => {
  it("names parts for what they are", () => {
    expect(fastenerName("socketCap", "M5", 16)).toBe("M5 × 16 socket cap screw");
    expect(fastenerName("countersunk", "M4", 10)).toBe("M4 × 10 countersunk screw");
    expect(fastenerName("nut", "M8", 0)).toBe("M8 hex nut");
    expect(hasLength("grub")).toBe(true);
    expect(hasLength("washer")).toBe(false);
  });

  it("has sensible heads for every size", () => {
    for (const s of FASTENER_SIZES) {
      for (const h of [s.socketCap, s.buttonHead, s.countersunk]) {
        expect(h.dk).toBeGreaterThan(s.d);
        // The hex key fits inside the head and the socket is shallower than it.
        expect(h.s! / Math.sqrt(3) * 2).toBeLessThan(h.dk);
        expect(h.t!).toBeLessThan(h.k + (h === s.countersunk ? 2 : 0));
      }
      expect(s.panHead.dk).toBeGreaterThan(s.d);
      expect(s.grub.s).toBeLessThan(s.d * 0.6);
    }
  });

  it("measures countersunk screws overall", () => {
    const m6 = FASTENER_SIZES.find((s) => s.name === "M6")!;
    expect(shankOf("countersunk", m6, 20)).toEqual({ top: -3.3, length: 20 - 3.3 });
    expect(shankOf("socketCap", m6, 20)).toEqual({ top: 0, length: 20 });
  });

  it("keeps the kind when a file is opened again", () => {
    for (const kind of FASTENER_KINDS) {
      const doc = emptyDocument();
      const f = { id: "f1", type: "fastener", name: "Fastener 1", operation: "new", params: { length: "10", x: "0", y: "0", z: "0" }, fastener: { kind, size: "M4", threaded: true } };
      const back = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [f] })))!;
      expect(back.features[0].fastener).toEqual({ kind, size: "M4", threaded: true });
    }
  });
});
