/**
 * 3MF and OBJ imports through the real engine: each file's triangles, kept as an STL, come in as solids of the right
 * size (and a 3MF in inches comes in at 25.4 times its numbers).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import { meshFileToStl } from "../src/model/meshImport";
import { readImport } from "../src/model/importFile";
import type { Feature, ImportedFile } from "../src/model/types";
import { loadOpenCascade, importFeature } from "./support/engineHelpers";
import { cubeObject, modelXml, objCube, threeMf } from "./support/meshFixtures";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

async function imported(name: string, bytes: Uint8Array, from: "3mf" | "obj"): Promise<ImportedFile> {
  const mesh = await meshFileToStl(name, bytes, from);
  if (!mesh.ok) throw new Error(mesh.error);
  const r = readImport(name, mesh.stl, mesh.from);
  if (r.ok !== true) throw new Error("not packaged");
  return r.file;
}

const volumes = (r: ReturnType<typeof build>) => r.parts.map((p) => analyzeMesh(p.vertices, p.triangles).volume).sort((a, b) => a - b);

describe("importing 3MF and OBJ files", () => {
  it("brings an OBJ cube in as a 20 mm solid with 6 faces", async () => {
    const file = await imported("cube.obj", new TextEncoder().encode(objCube(20)), "obj");
    const r = build([importFeature(file)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(volumes(r)[0]).toBeCloseTo(8000, 1);
    expect(r.parts[0].faceGroups).toHaveLength(6);
  });

  it("brings a 3MF's two placed cubes in as two parts, in millimetres", async () => {
    const body = cubeObject(1, 10);
    const zip = await threeMf(modelXml(body, `<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>`), [], true);
    const r = build([importFeature(await imported("two.3mf", zip, "3mf"))]);
    expect(r.featureErrors).toEqual({});
    expect(volumes(r)).toHaveLength(2);
    for (const v of volumes(r)) expect(v).toBeCloseTo(1000, 1);
  });

  it("reads a 3MF saved in inches at its real size", async () => {
    const zip = await threeMf(modelXml(cubeObject(1, 1), `<item objectid="1"/>`, "inch"));
    const r = build([importFeature(await imported("inch.3mf", zip, "3mf"))]);
    expect(r.featureErrors).toEqual({});
    expect(volumes(r)[0] / 25.4 ** 3).toBeCloseTo(1, 4);
  });
});
