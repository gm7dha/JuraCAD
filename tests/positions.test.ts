import { describe, expect, it } from "vitest";

import { addAssembly, applyPosition, nextPositionName, parseAssemblies, putMate, removePosition, savePosition } from "../src/assembly/assembly";
import { emptyDocument } from "../src/model/document";
import type { Mate, JuraCADDocument } from "../src/model/types";

type Vec3 = [number, number, number];
const assembliesOf = (d: JuraCADDocument) => d.assemblies ?? [];

const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
const hinge = (angle: string): Mate => ({ id: "m1", name: "Hinge 1", type: "revolute", a: { instanceId: "i1", pick }, b: { instanceId: "i2", pick }, flip: false, values: { angle } });

describe("named positions", () => {
  it("saves the mates' amounts and goes back to them", () => {
    let doc = addAssembly(emptyDocument(), "a");
    doc = putMate(doc, "a", hinge("0"));
    doc = savePosition(doc, "a", "p1", "Closed");
    doc = putMate(doc, "a", hinge("90"));
    expect(nextPositionName(assembliesOf(doc)[0])).toBe("Position 1");
    doc = savePosition(doc, "a", "p2", "Open");
    doc = applyPosition(doc, "a", "p1");
    expect(assembliesOf(doc)[0].mates![0].values.angle).toBe("0");
    doc = applyPosition(doc, "a", "p2");
    expect(assembliesOf(doc)[0].mates![0].values.angle).toBe("90");
    doc = removePosition(doc, "a", "p1");
    expect(assembliesOf(doc)[0].positions!.map((p) => p.name)).toEqual(["Open"]);
  });

  it("are saved in the file", () => {
    let doc = addAssembly(emptyDocument(), "a");
    doc = putMate(doc, "a", hinge("45"));
    doc = savePosition(doc, "a", "p1", "Half");
    const asm = assembliesOf(doc)[0];
    const raw = JSON.parse(JSON.stringify([{ ...asm, instances: [{ id: "i1", partId: "x", name: "A", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } }, { id: "i2", partId: "x", name: "B", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } }] }]));
    expect(parseAssemblies(raw)[0].positions).toEqual([{ id: "p1", name: "Half", values: { m1: { angle: "45" } } }]);
  });
});
