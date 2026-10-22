import { describe, expect, it } from "vitest";

import { parseAssemblies } from "../src/assembly/assembly";
import type { Vec3 } from "../src/assembly/math";
import type { Assembly } from "../src/model/types";

const pick = { partId: "p", ref: { kind: "edge" as const, curve: "LINE", a: [0, 0, 0] as Vec3, b: [0, 0, 20] as Vec3, mid: [0, 0, 10] as Vec3 } };
const asm = (a: Record<string, unknown>): unknown[] => [
  {
    id: "asm",
    name: "A",
    instances: [
      { id: "i1", partId: "p", name: "P <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
      { id: "i2", partId: "p", name: "P <2>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false },
    ],
    mates: [{ id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "i1", pick, ...a }, b: { instanceId: "i2", pick }, flip: false, values: {} }],
  },
];

describe("connector spots in files", () => {
  it("keep a corner, or a clicked point, and drop anything odd", () => {
    const read = (a: Record<string, unknown>) => (parseAssemblies(asm(a))[0] as Assembly).mates![0].a;
    expect(read({ spot: "end" })).toEqual({ instanceId: "i1", pick, spot: "end" });
    expect(read({ spot: "clicked", point: [1, 2, 3] })).toEqual({ instanceId: "i1", pick, spot: "clicked", point: [1, 2, 3] });
    // "Where you clicked" without a point means nothing: the usual spot (the point alone is kept).
    expect(read({ spot: "clicked" })).toEqual({ instanceId: "i1", pick });
    expect(read({ spot: "corner", point: [1, 2] })).toEqual({ instanceId: "i1", pick });
    expect(read({ point: [1, 2, 3] })).toEqual({ instanceId: "i1", pick, point: [1, 2, 3] });
    // Files from before have neither, and read back exactly as they were.
    expect(read({})).toEqual({ instanceId: "i1", pick });
  });
});
