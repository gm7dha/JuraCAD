import { describe, expect, it } from "vitest";

import { activeConfiguration, addConfiguration, removeConfiguration, renameConfiguration, switchConfiguration } from "../src/model/configurations";
import { emptyDocument, parseDocument } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { applyVariables } from "../src/model/variables";

const box = (id: string): Feature => ({ id, name: id, type: "box", operation: "new", suppressed: false, params: { ...defaultParams("box"), width: "w" } });

function start(): JuraCADDocument {
  const doc: JuraCADDocument = { ...emptyDocument(), features: [box("b1"), box("b2")] };
  return applyVariables(doc, [{ id: "v1", name: "w", value: "20" }]);
}
const w = (d: JuraCADDocument) => d.variables![0].value;
const off = (d: JuraCADDocument) => d.features.filter((f) => f.suppressed).map((f) => f.id);

describe("configurations", () => {
  it("keeps the first state as Default and starts the new one as a copy", () => {
    const d = addConfiguration(start(), "Large", "large");
    expect(d.configurations!.map((c) => c.name)).toEqual(["Default", "Large"]);
    expect(activeConfiguration(d)!.id).toBe("large");
    expect(w(d)).toBe("20");
  });

  it("remembers each one's variable values and suppressed features", () => {
    let d = addConfiguration(start(), "Large", "large");
    // Change "Large": bigger, without the second box.
    d = applyVariables(d, [{ id: "v1", name: "w", value: "50" }]);
    d = { ...d, features: d.features.map((f) => (f.id === "b2" ? { ...f, suppressed: true } : f)) };
    const def = d.configurations![0].id;
    d = switchConfiguration(d, def);
    expect(w(d)).toBe("20");
    expect(off(d)).toEqual([]);
    d = switchConfiguration(d, "large");
    expect(w(d)).toBe("50");
    expect(off(d)).toEqual(["b2"]);
    // Saved and opened again: still there, still showing Large.
    const back = parseDocument(JSON.parse(JSON.stringify(d)))!;
    expect(back.configurations).toEqual(d.configurations);
    expect(back.activeConfiguration).toBe("large");
  });

  it("can be renamed and deleted", () => {
    let d = addConfiguration(start(), "Large", "large");
    d = renameConfiguration(d, "large", "  Big  ");
    expect(d.configurations![1].name).toBe("Big");
    d = addConfiguration(d, "Tiny", "tiny");
    // Deleting the one on show leaves the design as it is, now counted as the first left.
    d = applyVariables(d, [{ id: "v1", name: "w", value: "5" }]);
    d = removeConfiguration(d, "tiny");
    expect(d.configurations!.map((c) => c.name)).toEqual(["Default", "Big"]);
    expect(activeConfiguration(d)!.name).toBe("Default");
    expect(w(d)).toBe("5");
    expect(d.configurations![0].values.v1).toBe("5");
    // With only one left there's nothing to choose between.
    d = removeConfiguration(d, "large");
    expect(d.configurations).toBe(undefined);
    expect(d.activeConfiguration).toBe(undefined);
  });
});
