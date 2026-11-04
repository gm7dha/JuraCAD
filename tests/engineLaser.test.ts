/**
 * Export for laser against the real OpenCascade engine: exact flat outlines
 * of faces, whole parts and sheet metal flat patterns.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import { layoutPieces, pathsBox } from "../src/laser/laser";
import { laserSvg } from "../src/laser/laserFiles";
import { outlinePiece, partFacing, type LaserOutline } from "../src/laser/sources";
import type { Feature } from "../src/model/types";
import { addCircle, addRectangle } from "../src/sketch/ops";
import type { Segment } from "../src/sketch/regions";
import { emptySketch } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const okOf = (o: LaserOutline) => {
  if (!o.ok) throw new Error(o.error);
  return o;
};

/** An 80 × 50 plate, 3 mm thick, with a 10 mm and a 6 mm hole. */
function plate() {
  let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 80, y: 50 }).sketch;
  s = addCircle(s, { x: 20, y: 25 }, 5).sketch;
  s = addCircle(s, { x: 60, y: 25 }, 3).sketch;
  const sk = sketchFeature({ kind: "default", name: "Top" }, s);
  return [sk, extrudeFeature(sk.id, 3)];
}

describe("export for laser (engine)", () => {
  it("reads a plate's outline exactly: the outer cut a rectangle, the inner cuts circles of the right size", () => {
    const r = build(plate());
    expect(r.featureErrors).toEqual({});
    const [out] = engine.laserOutlines([{ kind: "part", partId: r.parts[0].id }]);
    const piece = outlinePiece(okOf(out));
    const outer = piece.paths.filter((p) => p.layer === "outer");
    const inner = piece.paths.filter((p) => p.layer === "inner");
    expect(outer).toHaveLength(1);
    expect(outer[0].segments.every((s) => s.kind === "line")).toBe(true);
    expect(outer[0].segments).toHaveLength(4);
    const box = pathsBox(outer)!;
    expect(box[2] - box[0]).toBeCloseTo(80, 6);
    expect(box[3] - box[1]).toBeCloseTo(50, 6);
    expect(inner).toHaveLength(2);
    const radii = inner.map((p) => (p.segments[0] as Extract<Segment, { kind: "circle" }>).radius).sort();
    expect(inner.every((p) => p.segments.length === 1 && p.segments[0].kind === "circle")).toBe(true);
    expect(radii[0]).toBeCloseTo(3, 9);
    expect(radii[1]).toBeCloseTo(5, 9);
    // The top face, seen from above: holes where they were drawn (the corner at the origin).
    const sheet = layoutPieces([piece]);
    const centres = sheet.paths.filter((p) => p.layer === "inner").map((p) => (p.segments[0] as Extract<Segment, { kind: "circle" }>).center[0]).sort((a, b) => a - b);
    expect(centres[0]).toBeCloseTo(20, 6);
    expect(centres[1]).toBeCloseTo(60, 6);
    expect(laserSvg(sheet)).toContain('width="80mm" height="50mm"');
  });

  for (const plane of ["Top", "Front", "Right"] as const)
    for (const flip of [false, true])
      it(`lays a plate sketched on ${plane}${flip ? " (extruded the other way)" : ""} out as drawn, never mirrored`, () => {
        let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 80, y: 50 }).sketch;
        s = addCircle(s, { x: 15, y: 10 }, 4).sketch;
        const sk = sketchFeature({ kind: "default", name: plane }, s);
        const features = [sk, extrudeFeature(sk.id, 3, { flip })];
        const r = build(features);
        expect(r.featureErrors).toEqual({});
        const toward = partFacing(r.parts[0].featureIds, features);
        const [out] = engine.laserOutlines([{ kind: "part", partId: r.parts[0].id, toward: toward ?? undefined }]);
        const sheet = layoutPieces([outlinePiece(okOf(out))]);
        expect(sheet.size[0]).toBeCloseTo(80, 6);
        expect(sheet.size[1]).toBeCloseTo(50, 6);
        const hole = sheet.paths.find((p) => p.layer === "inner")!.segments[0] as Extract<Segment, { kind: "circle" }>;
        expect(hole.center[0]).toBeCloseTo(15, 6);
        expect(hole.center[1]).toBeCloseTo(10, 6);
        // Without knowing the sketch, Front and Right parts still come out as drawn when seen from the front / right.
        if (!flip) {
          const [plain] = engine.laserOutlines([{ kind: "part", partId: r.parts[0].id }]);
          const h2 = layoutPieces([outlinePiece(okOf(plain))]).paths.find((p) => p.layer === "inner")!.segments[0] as Extract<Segment, { kind: "circle" }>;
          expect(h2.center[0]).toBeCloseTo(15, 6);
        }
      });

  it("takes a clicked flat face, and refuses a curved one plainly", () => {
    const r = build(plate());
    const part = r.parts[0];
    const front = part.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[1] < -0.99);
    const hole = part.faceRefs.findIndex((f) => f.surface === "CYLINDRE");
    const [face, curved] = engine.laserOutlines([
      { kind: "face", pick: { partId: part.id, ref: part.faceRefs[front] } },
      { kind: "face", pick: { partId: part.id, ref: part.faceRefs[hole] } },
    ]);
    const box = pathsBox(outlinePiece(okOf(face)).paths)!;
    // The front face is 80 wide and 3 tall.
    expect(box[2] - box[0]).toBeCloseTo(80, 6);
    expect(box[3] - box[1]).toBeCloseTo(3, 6);
    expect(curved.ok).toBe(false);
    expect(!curved.ok && curved.error).toMatch(/Pick a flat face/);
  });

  it("keeps a rounded corner as an arc of the right radius", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 30 }).sketch);
    const ext = extrudeFeature(sk.id, 2);
    const r0 = build([sk, ext]);
    const p = r0.parts[0];
    // The vertical edge at the corner (40, 30).
    const corner = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[0] - 40) < 1e-6 && Math.abs(e.a[1] - 30) < 1e-6 && Math.abs(e.b[0] - 40) < 1e-6 && Math.abs(e.b[1] - 30) < 1e-6)!;
    expect(corner).toBeTruthy();
    const fillet = { ...feature("fillet", { radius: 6 }, "add"), picks: [{ partId: p.id, ref: corner }] };
    const r = build([sk, ext, fillet]);
    expect(r.featureErrors).toEqual({});
    const [out] = engine.laserOutlines([{ kind: "part", partId: r.parts[0].id }]);
    const outer = outlinePiece(okOf(out)).paths.find((q) => q.layer === "outer")!;
    const arcs = outer.segments.filter((s) => s.kind === "arc") as Extract<Segment, { kind: "arc" }>[];
    expect(arcs).toHaveLength(1);
    const a = arcs[0];
    const rad = Math.hypot(a.from[0] - a.to[0], a.from[1] - a.to[1]) / Math.SQRT2;
    expect(rad).toBeCloseTo(6, 6);
    const box = pathsBox([outer])!;
    expect(box[2] - box[0]).toBeCloseTo(40, 6);
    expect(laserSvg(layoutPieces([outlinePiece(okOf(out))]))).toMatch(/ A6 6 0 0 [01] /);
  });

  it("lays a sheet metal part out flat, at the flat pattern's size, with its bend line to score", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, addCircle(addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 100, y: 50 }).sketch, { x: 30, y: 25 }, 4).sketch);
    const sheet: Feature = { id: "sm", name: "Sheet metal 1", type: "sheetMetal", operation: "new", suppressed: false, params: { thickness: "2", radius: "2", kFactor: "0.45" }, sketchRef: sk.id };
    const r1 = build([sk, sheet]);
    const p = r1.parts[0];
    const ref = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[0] - 100) < 1e-6 && Math.abs(e.b[0] - 100) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const flange: Feature = { id: "fl", name: "Flange 1", type: "flange", operation: "add", suppressed: false, params: { length: "30", angle: "90" }, picks: [{ partId: p.id, ref }] };
    const r = build([sk, sheet, flange]);
    expect(r.featureErrors).toEqual({});
    const [out] = engine.laserOutlines([{ kind: "flat", partId: r.parts[0].id }]);
    const piece = outlinePiece(okOf(out));
    const outer = piece.paths.filter((q) => q.layer === "outer");
    expect(outer).toHaveLength(1);
    const box = pathsBox(outer)!;
    expect(box[2] - box[0]).toBeCloseTo(100 + (Math.PI / 2) * (2 + 0.45 * 2) + 26, 3);
    expect(box[3] - box[1]).toBeCloseTo(50, 6);
    // The hole comes through exactly round.
    const holes = piece.paths.filter((q) => q.layer === "inner");
    expect(holes).toHaveLength(1);
    expect(holes[0].segments[0].kind).toBe("circle");
    const scores = piece.paths.filter((q) => q.layer === "score");
    expect(scores).toHaveLength(1);
    // The bend line runs right across the sheet, inside its outline, where the flat wall meets the bend.
    const bend = pathsBox(scores)!;
    expect(bend[3] - bend[1]).toBeCloseTo(50, 3);
    expect(bend[0]).toBeGreaterThan(box[0] + 50);
    expect(bend[2]).toBeLessThan(box[2] - 20);
    // Not a sheet metal part: said plainly.
    const plain = build(plate());
    const [no] = engine.laserOutlines([{ kind: "flat", partId: plain.parts[0].id }]);
    expect(!no.ok && no.error).toMatch(/isn't a sheet metal part/);
  });
});
