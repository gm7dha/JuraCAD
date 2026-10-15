import { describe, expect, it } from "vitest";

import { billOfMaterials } from "../src/assembly/assembly";
import { configurationsInUse, findMesh, meshIdOf } from "../src/assembly/configured";
import { syncPattern } from "../src/assembly/patterns";
import { addConfiguration } from "../src/model/configurations";
import { emptyDocument } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import type { Assembly, Instance, PartSmithDocument } from "../src/model/types";

const P = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
const inst = (id: string, configuration?: string): Instance => ({ id, partId: "b1", name: `Bracket <${id}>`, placement: P, fixed: false, ...(configuration ? { configuration } : {}) });

function doc(instances: Instance[]): PartSmithDocument {
  let d: PartSmithDocument = { ...emptyDocument(), features: [{ id: "b1", name: "Box 1", type: "box", operation: "new", suppressed: false, params: defaultParams("box") }] };
  d = addConfiguration(d, "Large", "large");
  const def = d.configurations![0].id;
  // Show Default in the Part Studio.
  d = { ...d, activeConfiguration: def };
  return { ...d, assemblies: [{ id: "a", name: "A", instances: instances.map((i) => (i.configuration === "default" ? { ...i, configuration: def } : i)) }] };
}

describe("parts in other configurations", () => {
  it("names the part an instance shows, falling back to the ordinary one", () => {
    expect(meshIdOf(inst("1"))).toBe("b1");
    expect(meshIdOf(inst("1", "large"))).toBe("b1@large");
    const parts = [{ id: "b1" }, { id: "b1@large" }];
    expect(findMesh(parts, "b1@large")).toBe(parts[1]);
    expect(findMesh(parts, "b1@small")).toBe(parts[0]);
  });

  it("builds only the configurations instances use, other than the one on show", () => {
    expect(configurationsInUse(doc([inst("1"), inst("2", "default")]))).toEqual([]);
    expect(configurationsInUse(doc([inst("1"), inst("2", "large"), inst("3", "large")]))).toEqual([{ studioId: "main", configurationId: "large" }]);
  });

  it("lists each configuration of a part on its own line", () => {
    const a = doc([inst("1"), inst("2", "large"), inst("3", "large")]).assemblies![0];
    expect(billOfMaterials(a, { b1: "Bracket" }, { large: "Large" }).map((r) => [r.name, r.quantity])).toEqual([
      ["Bracket", 1],
      ["Bracket (Large)", 2],
    ]);
  });

  it("pattern copies show their original's configuration", () => {
    const a: Assembly = { id: "a", name: "A", instances: [inst("1", "large")] };
    const out = syncPattern(a, { id: "p", name: "Pattern 1", kind: "linear", seeds: ["1"], count: 3, amount: "20", axis: "x" }, (() => {
      let n = 0;
      return () => `c${++n}`;
    })());
    expect(out.instances.map((i) => i.configuration)).toEqual(["large", "large", "large"]);
  });
});
