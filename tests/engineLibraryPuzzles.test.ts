/**
 * Puzzle designs with the real OpenCascade engine: the cylinder maze box's box and lid are sound, and the lid — turned
 * over and put on the box — sits closed, follows the maze all the way out without touching, and is stopped by the
 * maze's walls anywhere else.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import { MAIN_STUDIO } from "../src/model/studios";
import { resolveVariables } from "../src/model/variables";
import { defaultValues, findDesign, insertDesign } from "../src/library/insert";
import type { DesignValues } from "../src/library/types";
import { FLANGE, makeMaze, mazeSizes } from "../src/library/designs/mazeBox";
import { loadOpenCascade } from "./support/engineHelpers";

let engine: GeometryEngine;
beforeAll(async () => {
  await loadOpenCascade();
  engine = new GeometryEngine();
});

function build(id: string, values: DesignValues = {}) {
  const d = findDesign(id)!;
  const doc = insertDesign(emptyDocument(), d, { ...defaultValues(d), ...values }, { into: MAIN_STUDIO }).doc;
  const r = engine.rebuild(doc.features, resolveVariables(doc.variables).values);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal");
  for (const p of check.parts) expect(p.geometryValid, p.partId).toBe(true);
  return { parts: r.parts, volumes: Object.fromEntries(check.parts.map((p) => [p.partId, p.exactVolume ?? 0])) };
}
const partEnding = (parts: PartMesh[], end: string) => parts.find((p) => p.id.endsWith(end))!;

describe("Cylinder maze gift box", () => {
  const values = { ...defaultValues(findDesign("maze-box")!), pattern: 7 };
  const s = mazeSizes(values);
  const maze = makeMaze(s.cols, s.rows, 7);
  const step = 180 / s.cols;
  let box: PartMesh;
  let lid: PartMesh;

  it("makes a sound box and lid", () => {
    const { parts, volumes } = build("maze-box", values);
    expect(parts.length).toBe(2);
    box = partEnding(parts, "_box");
    lid = partEnding(parts, "_lid");
    // The box less its grooves: a little under the solid of revolution's volume.
    const solid = Math.PI * (s.flange ** 2 * FLANGE + s.core ** 2 * (s.boxHeight - FLANGE) - s.inside ** 2 * (s.boxHeight - 2));
    expect(volumes[box.id]).toBeLessThan(solid);
    expect(volumes[box.id]).toBeGreaterThan(solid * 0.7);
  });

  /** The volume the lid shares with the box, the lid turned over, `deg` round and lifted `lift` off the flange. */
  function overlap(deg: number, lift: number): number {
    const lidCentre = s.flange * 2 + 10;
    const t = (deg * Math.PI) / 180;
    // Turn over about x (its top up), then round z by deg: q = Rz(t)·Rx(π).
    const rotation: [number, number, number, number] = [Math.cos(t / 2), Math.sin(t / 2), 0, 0];
    // Its middle (lidCentre, 0) goes to (lidCentre·cos t, lidCentre·sin t): moved back to the box's middle.
    const position: [number, number, number] = [-lidCentre * Math.cos(t), -lidCentre * Math.sin(t), FLANGE + lift + s.lidHeight];
    const found = engine.clashes(
      [
        { id: "box", partId: box.id, name: "box", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        { id: "lid", partId: lid.id, name: "lid", position, rotation },
      ],
      0.001,
      false,
    );
    return found.reduce((n, c) => n + (c.volume ?? 0), 0);
  }
  const at = (i: number) => ({ deg: ((i % s.cols) + 0.5) * step, lift: Math.floor(i / s.cols) * s.pitch });

  it("closes, and the lid follows the maze all the way out without touching", () => {
    for (const i of maze.path) {
      const { deg, lift } = at(i);
      expect(overlap(deg, lift), `cell ${i}`).toBeLessThan(1e-3);
    }
    // Halfway along each move of the way out too, and up past the top.
    for (let k = 1; k < maze.path.length; k++) {
      const [a, b] = [at(maze.path[k - 1]), at(maze.path[k])];
      let d = b.deg - a.deg;
      if (d > 90) d -= 180;
      if (d < -90) d += 180;
      expect(overlap(a.deg + d / 2, (a.lift + b.lift) / 2), `between ${maze.path[k - 1]} and ${maze.path[k]}`).toBeLessThan(1e-3);
    }
    const out = at(maze.path[maze.path.length - 1]);
    expect(overlap(out.deg, out.lift + s.pitch * 1.5)).toBeLessThan(1e-3);
  });

  it("is stopped by the maze's walls", () => {
    // OpenCascade's overlap now and then comes back empty at an exact placement, so look a little either side too.
    const blocked = (deg: number, lift: number) => Math.max(...[-1.5, 0, 1.5].map((d) => overlap(deg + d, lift)));
    let checked = 0;
    for (let i = 0; i < s.cols * s.rows && checked < 16; i++) {
      const { deg, lift } = at(i);
      if (!maze.right[i]) {
        checked++;
        expect(blocked(deg + step / 2, lift), `right of ${i}`).toBeGreaterThan(0.5);
      }
      if (Math.floor(i / s.cols) + 1 < s.rows && !maze.up[i]) {
        checked++;
        expect(Math.max(overlap(deg, lift + s.pitch / 2), overlap(deg + 1, lift + s.pitch / 2)), `above ${i}`).toBeGreaterThan(0.5);
      }
    }
    expect(checked).toBe(16);
  });
});
