/**
 * Mate connectors worked out from real meshes (the OpenCascade engine runs in Node).
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { beforeAll, describe, expect, it } from "vitest";

import { connectorFrame, framePlacement, quatFromBasis, symmetricEigen } from "../src/assembly/connectors";
import { applyPlacement, cross, rotate } from "../src/assembly/math";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType, Operation } from "../src/model/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let n = 0;
function feature(type: FeatureType, params: Record<string, number>, operation: Operation = "new"): Feature {
  n++;
  return {
    id: `c${n}`,
    name: `${type} ${n}`,
    type,
    operation,
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}

const close = (a: number[], b: number[], digits = 4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const parallel = (a: number[], b: number[]) => expect(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])).toBeCloseTo(1, 5);

describe("maths for connectors", () => {
  it("finds eigenvectors", () => {
    const { values, vectors } = symmetricEigen([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    const sorted = [...values].sort((a, b) => a - b);
    close(sorted, [1, 3, 5], 9);
    const i1 = values.findIndex((v) => Math.abs(v - 1) < 1e-9);
    parallel(vectors[i1], [Math.SQRT1_2, -Math.SQRT1_2, 0]);
  });

  it("turns world axes onto a frame", () => {
    const x: [number, number, number] = [0, 1, 0];
    const z: [number, number, number] = [1, 0, 0];
    const q = quatFromBasis(x, cross(z, x), z);
    close(rotate(q, [1, 0, 0]), x, 9);
    close(rotate(q, [0, 0, 1]), z, 9);
  });
});

describe("connectors on real parts", () => {
  // A 40 × 30 × 20 block with a 10 mm hole straight down through (20, 15).
  const engine = new GeometryEngine();
  let part: ReturnType<GeometryEngine["rebuild"]>["parts"][number];
  beforeAll(() => {
    const r = engine.rebuild([
      feature("box", { width: 40, depth: 30, height: 20 }),
      feature("cylinder", { diameter: 10, height: 40, x: 20, y: 15, z: -10 }, "remove"),
    ]);
    part = r.parts[0];
  });

  const faceWhere = (test: (s: string, c: number[], nrm: number[]) => boolean) => part.faceRefs.findIndex((f) => test(f.surface, f.center, f.normal));

  it("puts a flat face's connector at its centre, pointing out", () => {
    const top = faceWhere((s, _c, nrm) => s === "PLANE" && nrm[2] > 0.99);
    const f = connectorFrame(part, "face", top)!;
    // The top face has the hole in it, but it's symmetric, so its centre is still the middle.
    close(f.origin, [20, 15, 20]);
    close(f.z, [0, 0, 1], 6);
    expect(Math.abs(f.x[0] * f.z[0] + f.x[1] * f.z[1] + f.x[2] * f.z[2])).toBeLessThan(1e-9);
    const side = faceWhere((s, _c, nrm) => s === "PLANE" && nrm[0] < -0.99);
    const fs = connectorFrame(part, "face", side)!;
    close(fs.origin, [0, 15, 10]);
    close(fs.z, [-1, 0, 0], 6);
  });

  it("puts a hole's connector on its axis, halfway down", () => {
    const hole = part.faceRefs.findIndex((f) => f.surface.startsWith("CYLIND"));
    expect(hole).toBeGreaterThanOrEqual(0);
    const f = connectorFrame(part, "face", hole)!;
    close(f.origin, [20, 15, 10], 3);
    parallel(f.z, [0, 0, 1]);
  });

  it("puts a circular edge's connector at its centre", () => {
    const rim = part.edgeRefs.findIndex((e) => e.curve === "CIRCLE" && e.mid[2] > 19.99);
    const f = connectorFrame(part, "edge", rim)!;
    close(f.origin, [20, 15, 20], 4);
    parallel(f.z, [0, 0, 1]);
  });

  it("puts a straight edge's connector at its middle, along it", () => {
    const edge = part.edgeRefs.findIndex((e) => e.curve === "LINE" && Math.abs(e.a[2] - e.b[2]) > 19 && e.a[0] === 0 && e.a[1] === 0);
    const f = connectorFrame(part, "edge", edge)!;
    close(f.origin, [0, 0, 10]);
    parallel(f.z, [0, 0, 1]);
    // As a placement, its origin maps to the connector point.
    close(applyPlacement(framePlacement(f), [0, 0, 0]), f.origin, 9);
  });

  it("finds a ball's centre", () => {
    const e2 = new GeometryEngine();
    const r = e2.rebuild([feature("sphere", { diameter: 20, x: 5, y: -3, z: 7 })]);
    const p = r.parts[0];
    const f = connectorFrame(p, "face", 0)!;
    close(f.origin, [5, -3, 7], 3);
    e2.dispose();
  });
});
