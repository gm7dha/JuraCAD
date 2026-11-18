/**
 * Engine test (heavy, on its own): Simplify on a printed nut's STL — a thread, which nothing simple fits — stays
 * about as quick as it was. Once tori fitted better, its thread crest was grown into the same thin band, and turned
 * down, from hundreds of seeds one after another (13 times the work, for nothing).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { planMesh } from "../src/geometry/meshSimplify";
import { weld } from "../src/geometry/threeMf";
import { emptyDocument } from "../src/model/document";
import { SIMPLIFY_TOLERANCES } from "../src/model/simplify";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import { loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

/** A binary STL's triangles, welded. */
function readStl(stl: Uint8Array) {
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const n = dv.getUint32(80, true);
  const v: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) v.push(dv.getFloat32(o + 4 * k, true));
    t.push(3 * i, 3 * i + 1, 3 * i + 2);
  }
  return weld(v, t);
}

describe("a thread", () => {
  it("isn't searched over and over (a printed M8 nut's STL)", () => {
    const d = findDesign("bolt-set")!;
    const doc = insertDesign(emptyDocument(), d, defaultValues(d), { into: MAIN_STUDIO }).doc;
    const engine = new GeometryEngine();
    const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
    expect(r.featureErrors).toEqual({});
    const nut = r.parts.find((p) => p.id.endsWith("_nut"))!;
    expect(nut).toBeDefined();
    const mesh = readStl(new Uint8Array(engine.exportStl([nut.id], "normal").stl));
    engine.dispose();
    const stats = { work: 0 };
    planMesh(mesh.vertices, mesh.triangles, SIMPLIFY_TOLERANCES.normal, { stats });
    // (About 150,000 points looked at; it was 2.4 million.)
    expect(stats.work).toBeLessThan(500_000);
  });
});
