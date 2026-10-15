import { describe, expect, it } from "vitest";

import { parseAssemblies, removeInstances, removeMate } from "../src/assembly/assembly";
import { removeReplicate, replicateSource, syncReplicate } from "../src/assembly/replicate";
import type { TopoPick, Vec3 } from "../src/geometry/topoRef";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate } from "../src/model/types";

const P = { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] };
const inst = (id: string, partId: string, fixed = false): Instance => ({ id, partId, name: `${partId} <1>`, placement: P, fixed });
const circle = (x: number): TopoPick => ({ partId: "plate", ref: { kind: "edge", curve: "CIRCLE", a: [x + 3, 0, 5], b: [x + 3, 0, 5], mid: [x - 3, 0, 5] } });
const boltEdge: TopoPick = { partId: "bolt", ref: { kind: "edge", curve: "CIRCLE", a: [3, 0, 0], b: [3, 0, 0], mid: [-3, 0, 0] } };
const flat: TopoPick = { partId: "plate", ref: { kind: "face", surface: "PLANE", center: [0, 0, 5], normal: [0, 0, 1] } };

let n = 0;
const ids = () => `x${++n}`;

function start(): Assembly {
  const mate: Mate = { id: "m1", name: "Fasten 1", type: "fastened", a: { instanceId: "plate1", pick: circle(10) }, b: { instanceId: "bolt1", pick: boltEdge }, flip: false, values: {} };
  return { id: "a", name: "A", instances: [inst("plate1", "plate", true), inst("bolt1", "bolt")], mates: [mate] };
}

describe("replicate", () => {
  it("finds the mate holding a part in a hole", () => {
    const a = start();
    const src = replicateSource(a, "bolt1");
    expect(typeof src).toBe("object");
    expect((src as { side: string }).side).toBe("b");
    // A part only mated face to face isn't in a hole.
    const flatOnly: Assembly = { ...a, mates: [{ ...a.mates![0], a: { instanceId: "plate1", pick: flat } }] };
    expect(typeof replicateSource(flatOnly, "bolt1")).toBe("string");
  });

  it("puts a copy, with its own mate, in each hole", () => {
    const rep = { id: "r", name: "Replicate 1", seed: "bolt1", mate: "m1" };
    const a = syncReplicate(start(), rep, [circle(30), circle(50)], ids);
    const copies = a.instances.filter((i) => i.replicaOf);
    expect(copies.map((c) => c.name)).toEqual(["bolt <2>", "bolt <3>"]);
    const mates = a.mates!.filter((m) => m.replicateOf === "r");
    expect(mates).toHaveLength(2);
    expect(mates[1].a.pick).toEqual(circle(50));
    expect(mates[1].b.instanceId).toBe(copies[1].id);
    // Fewer holes later: the extra copy and its mate go; the first stays the same.
    const fewer = syncReplicate(a, rep, [circle(30)], ids);
    expect(fewer.instances.filter((i) => i.replicaOf).map((i) => i.id)).toEqual([copies[0].id]);
    expect(fewer.mates!.filter((m) => m.replicateOf)).toHaveLength(1);
    // Saved and opened again.
    const back = parseAssemblies(JSON.parse(JSON.stringify([a])))[0];
    expect(back.replicates).toEqual(a.replicates);
    expect(back.mates!.filter((m) => m.replicateOf)).toHaveLength(2);
    expect(back.instances.filter((i) => i.replicaOf)).toHaveLength(2);
    // Removing it takes the copies and their mates.
    const gone = removeReplicate(a, "r");
    expect(gone.instances.map((i) => i.id)).toEqual(["plate1", "bolt1"]);
    expect(gone.mates!.map((m) => m.id)).toEqual(["m1"]);
  });

  it("goes when its original part or mate is removed", () => {
    const rep = { id: "r", name: "Replicate 1", seed: "bolt1", mate: "m1" };
    const doc = { ...emptyDocument(), assemblies: [syncReplicate(start(), rep, [circle(30)], ids)] };
    const noBolt = removeInstances(doc, "a", ["bolt1"]).assemblies![0];
    expect(noBolt.instances.map((i) => i.id)).toEqual(["plate1"]);
    expect(noBolt.replicates).toBe(undefined);
    const noMate = removeMate(doc, "a", "m1").assemblies![0];
    expect(noMate.instances.map((i) => i.id)).toEqual(["plate1", "bolt1"]);
    expect(noMate.mates).toBe(undefined);
  });
});
