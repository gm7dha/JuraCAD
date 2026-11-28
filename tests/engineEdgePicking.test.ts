/**
 * Fillet/Chamfer while their edges are being clicked (`edgesCheck`): built and checked on the real engine — a radius
 * too big still says so — but the part is left as it was, so its edges stay there to click.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { measureVolume, type Shape3D } from "replicad";
import type { EdgeRef, TopoPick } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { checkWhilePicking } from "../src/model/edgePicking";
import type { Feature } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const volume = () => measureVolume((engine as unknown as { parts: { shape: Shape3D }[] }).parts[0].shape);

describe("checking a fillet while its edges are picked", () => {
  it("leaves the part as it was, and still reports a radius that doesn't fit", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const first = build([box]);
    const part = first.parts[0];
    const edge = (part.edgeRefs as EdgeRef[]).find((e) => e.mid[2] > 9.9 && e.mid[1] > 9.9) ?? (part.edgeRefs as EdgeRef[])[0];
    const pick: TopoPick = { partId: part.id, ref: edge };
    for (const type of ["fillet", "chamfer"] as const) {
      const f: Feature = { ...feature(type, type === "fillet" ? { radius: 2 } : { distance: 2 }), picks: [pick], edgesPicking: true };
      const plain = build([box, f]);
      expect(plain.featureErrors[f.id]).toBeUndefined();
      const rounded = volume();
      expect(rounded).toBeLessThan(1000 - 0.1);
      const checked = build(checkWhilePicking([box, f], f));
      expect(checked.featureErrors[f.id]).toBeUndefined();
      expect(volume()).toBeCloseTo(1000, 6);
      // As many faces as the box: nothing rounded.
      expect(checked.parts[0].faceGroups.length).toBe(6);
    }
    const big: Feature = { ...feature("fillet", { radius: 50 }), picks: [pick], edgesPicking: true };
    const r = build(checkWhilePicking([box, big], big));
    expect(r.featureErrors[big.id]).toMatch(/smaller radius/);
    expect(volume()).toBeCloseTo(1000, 6);
  });
});
