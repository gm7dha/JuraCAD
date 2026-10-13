import { describe, expect, it } from "vitest";

import {
  addAssembly,
  billOfMaterials,
  bomCsv,
  boundsOfVertices,
  insertInstance,
  nextInstanceName,
  parseAssemblies,
  placedBox,
  removeAssembly,
  removeInstances,
  renameAssembly,
  spotBeside,
  updateInstance,
} from "../src/assembly/assembly";
import {
  applyPlacement,
  compose,
  eulerDegFromQuat,
  invert,
  placementMatrix,
  quatFromAxisAngle,
  quatFromEulerDeg,
  rotate,
  samePlacement,
  type Placement,
} from "../src/assembly/math";
import { emptyDocument, parseDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";

const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("assembly maths", () => {
  it("turns points", () => {
    close(rotate(quatFromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0]);
    close(rotate(quatFromEulerDeg(90, 0, 0), [0, 1, 0]), [0, 0, 1]);
  });

  it("converts turns to angles and back", () => {
    for (const t of [
      [0, 0, 0],
      [30, 0, 0],
      [0, -45, 0],
      [10, 20, 30],
      [-170, 60, 95],
      [0, 90, 40],
    ] as [number, number, number][]) {
      const q = quatFromEulerDeg(...t);
      const back = eulerDegFromQuat(q);
      // Same turn (angles may differ only where the turn is straight up or down).
      const p: [number, number, number] = [0.3, -1.2, 2.5];
      close(rotate(quatFromEulerDeg(...back), p), rotate(q, p));
      if (Math.abs(t[1]) < 89) close(back, t, 6);
    }
  });

  it("composes and inverts placements", () => {
    const a: Placement = { position: [10, 0, 5], rotation: quatFromEulerDeg(0, 0, 90) };
    const b: Placement = { position: [1, 2, 3], rotation: quatFromEulerDeg(45, 0, 0) };
    const p: [number, number, number] = [2, -1, 4];
    close(applyPlacement(compose(a, b), p), applyPlacement(a, applyPlacement(b, p)));
    close(applyPlacement(compose(a, invert(a)), p), p);
    expect(samePlacement(compose(invert(b), b), { position: [0, 0, 0], rotation: [0, 0, 0, 1] })).toBe(true);
  });

  it("makes a matrix three.js can use (column by column)", () => {
    const m = placementMatrix({ position: [5, 6, 7], rotation: quatFromEulerDeg(0, 0, 90) });
    // X axis turns to Y; the move is in the last column.
    close(m.slice(0, 3), [0, 1, 0]);
    close(m.slice(12, 15), [5, 6, 7]);
    const p = [1, 2, 3];
    const out = [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    close(out, applyPlacement({ position: [5, 6, 7], rotation: quatFromEulerDeg(0, 0, 90) }, [1, 2, 3]));
  });
});

describe("assembly documents", () => {
  const part = { id: "f1", name: "Part 1" };

  it("adds, names, renames and removes assemblies", () => {
    let doc = addAssembly(emptyDocument(), "a1");
    doc = addAssembly(doc, "a2");
    expect(doc.assemblies?.map((a) => a.name)).toEqual(["Assembly 1", "Assembly 2"]);
    doc = renameAssembly(doc, "a2", "  Gearbox ");
    expect(doc.assemblies?.[1].name).toBe("Gearbox");
    expect(renameAssembly(doc, "a2", "  ")).toBe(doc);
    doc = removeAssembly(removeAssembly(doc, "a1"), "a2");
    expect(doc.assemblies).toBeUndefined();
  });

  it("inserts numbered copies; the first is fixed", () => {
    let doc = addAssembly(emptyDocument(), "a1");
    doc = insertInstance(doc, "a1", part, undefined, "i1");
    doc = insertInstance(doc, "a1", part, { position: [50, 0, 0], rotation: [0, 0, 0, 1] }, "i2");
    doc = insertInstance(doc, "a1", { id: "f2", name: "Part 2" }, undefined, "i3");
    const a = doc.assemblies![0];
    expect(a.instances.map((i) => i.name)).toEqual(["Part 1 <1>", "Part 1 <2>", "Part 2 <1>"]);
    expect(a.instances.map((i) => i.fixed)).toEqual([true, false, false]);
    expect(a.instances[1].placement.position).toEqual([50, 0, 0]);
    // Gaps in the numbering are reused.
    doc = removeInstances(doc, "a1", ["i1"]);
    expect(nextInstanceName(doc.assemblies![0], "Part 1")).toBe("Part 1 <1>");
  });

  it("updates an instance without changing the others", () => {
    let doc = insertInstance(insertInstance(addAssembly(emptyDocument(), "a1"), "a1", part, undefined, "i1"), "a1", part, undefined, "i2");
    const before = doc.assemblies![0].instances[1];
    doc = updateInstance(doc, "a1", "i1", { fixed: false, name: "Base", placement: { position: [1, 2, 3], rotation: [0, 0, 0, 1] } });
    const [i1, i2] = doc.assemblies![0].instances;
    expect([i1.fixed, i1.name]).toEqual([false, "Base"]);
    expect(i1.placement.position).toEqual([1, 2, 3]);
    expect(i2).toBe(before);
    expect(updateInstance(doc, "a1", "i1", { name: "  " }).assemblies![0].instances[0].name).toBe("Base");
  });

  it("lists parts with quantities", () => {
    let doc = addAssembly(emptyDocument(), "a1");
    for (const p of [part, { id: "f2", name: "Part 2" }, part, { id: "gone", name: "Old part" }]) doc = insertInstance(doc, "a1", p);
    const rows = billOfMaterials(doc.assemblies![0], { f1: "Part 1", f2: "Part 2" });
    expect(rows.map((r) => [r.name, r.quantity, r.missing])).toEqual([
      ["Part 1", 2, false],
      ["Part 2", 1, false],
      ["Old part", 1, true],
    ]);
    expect(bomCsv(rows)).toBe('Item,Part,Quantity\n1,Part 1,2\n2,Part 2,1\n3,Old part,1\n');
    expect(bomCsv([{ partId: "x", name: 'Bracket, "big"', quantity: 1, missing: false }])).toContain('"Bracket, ""big"""');
  });

  it("saves and reopens assemblies", () => {
    let doc = insertInstance(addAssembly(emptyDocument(), "a1"), "a1", part, { position: [1, 2, 3], rotation: quatFromEulerDeg(0, 0, 90) }, "i1");
    const read = readDocumentFile(serializeDocument(doc));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.assemblies).toEqual(doc.assemblies);
    // Older files without assemblies still open.
    expect(parseDocument({ format: "partsmith", version: 1, name: "x", features: [] })?.assemblies).toBeUndefined();
  });

  it("drops damaged assembly entries rather than refusing the file", () => {
    const a = parseAssemblies([
      { id: "a1", name: "A", instances: [{ id: "i1", partId: "f1", name: "P <1>", placement: { position: [1, "x", 3], rotation: [0, 0, 0, 2] }, fixed: true }, { id: 5 }] },
      { name: "no id" },
      "junk",
    ]);
    expect(a).toHaveLength(1);
    expect(a[0].instances).toHaveLength(1);
    expect(a[0].instances[0].placement).toEqual({ position: [1, 0, 3], rotation: [0, 0, 0, 1] });
    expect(parseAssemblies("nope")).toEqual([]);
  });
});

describe("placing new copies", () => {
  it("finds a part's box, also when turned", () => {
    const box = boundsOfVertices([0, 0, 0, 10, 20, 5, 3, 4, 1])!;
    expect(box).toEqual({ min: [0, 0, 0], max: [10, 20, 5] });
    expect(boundsOfVertices([])).toBeNull();
    const turned = placedBox(box, { position: [100, 0, 0], rotation: quatFromEulerDeg(0, 0, 90) });
    close(turned.min, [80, 0, 0]);
    close(turned.max, [100, 10, 5]);
  });

  it("puts a new copy just beside everything else", () => {
    const part = { min: [-5, 0, 0], max: [5, 10, 10] } as const;
    expect(spotBeside([], { min: [...part.min], max: [...part.max] })).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    const spot = spotBeside([{ min: [-5, 0, 0], max: [5, 10, 10] }, { min: [10, 0, 0], max: [40, 5, 5] }], { min: [-5, 0, 0], max: [5, 10, 10] });
    expect(spot.position).toEqual([55, 0, 0]);
  });
});
