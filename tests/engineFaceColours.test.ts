/**
 * Face colours on real parts (real OpenCascade): a coloured face stays on its face when the part is made bigger and when
 * a fillet is added before it, and the 3MF export paints exactly that face's triangles with its filament (Bambu's
 * paint_color) while the part's own colour is its filament; STEP gets the face's colour too.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { facesColoured, setFaceColoursIn } from "../src/model/faceColours";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const doc = (): JuraCADDocument => ({ format: "partsmith", version: 1, name: "t", features: [] });

/** The face of a part facing `normal` that is furthest that way. */
function faceFacing(p: PartMesh, normal: [number, number, number]): number {
  let best = -1;
  let far = -Infinity;
  p.faceRefs.forEach((f, i) => {
    if (f.surface !== "PLANE") return;
    const d = f.normal[0] * normal[0] + f.normal[1] * normal[1] + f.normal[2] * normal[2];
    const at = f.center[0] * normal[0] + f.center[1] * normal[1] + f.center[2] * normal[2];
    if (d > 0.999 && at > far) [best, far] = [i, at];
  });
  return best;
}

const box = (width: number): Feature => ({ ...feature("box", { width, depth: 30, height: 20 }), id: "box", name: "Box" });

function unzip(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    out.set(name, new TextDecoder().decode(bytes.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size)));
    at += 30 + nameLen + extra + size;
  }
  return out;
}

describe("face colours on real parts", () => {
  it("follow their faces when the part grows and when a fillet comes before them", () => {
    const e = new GeometryEngine();
    const first = e.rebuild([box(40)]).parts[0];
    const side = faceFacing(first, [1, 0, 0]);
    const top = faceFacing(first, [0, 0, 1]);
    let d = setFaceColoursIn(doc(), "box", [side], "#c12e1f", first, "10200");
    d = setFaceColoursIn(d, "box", [top], "#0056b8", first);
    const list = d.faceAppearance!.box;
    expect(list).toHaveLength(2);

    // Made twice as wide: the right-hand face moved 40 mm, and is still the one coloured.
    const wide = e.rebuild([box(80)]).parts[0];
    const got = facesColoured(list, wide);
    expect(got.lost).toBe(0);
    expect(got.colours.get(faceFacing(wide, [1, 0, 0]))?.colour).toBe("#c12e1f");
    expect(got.colours.get(faceFacing(wide, [1, 0, 0]))?.spool).toBe("10200");
    expect(got.colours.get(faceFacing(wide, [0, 0, 1]))?.colour).toBe("#0056b8");
    expect(got.colours.size).toBe(2);

    // A fillet on an upright edge first: more faces, renumbered, the side and top smaller — still the same two.
    const edge = wide.edgeRefs.findIndex((r) => r.curve === "LINE" && Math.abs(r.a[2] - r.b[2]) > 19 && r.mid[0] > 79 && r.mid[1] > 29);
    expect(edge).toBeGreaterThanOrEqual(0);
    const fillet: Feature = { ...feature("fillet", { radius: 5 }, "add"), picks: [{ partId: "box", ref: wide.edgeRefs[edge] }] };
    const rounded = e.rebuild([box(80), fillet]).parts[0];
    expect(rounded.faceRefs.length).toBe(7);
    const after = facesColoured(list, rounded);
    expect(after.lost).toBe(0);
    expect(after.colours.get(faceFacing(rounded, [1, 0, 0]))?.colour).toBe("#c12e1f");
    expect(after.colours.get(faceFacing(rounded, [0, 0, 1]))?.colour).toBe("#0056b8");
    expect(after.colours.size).toBe(2);
    e.dispose();
  });

  it("are left out quietly when their face is gone", () => {
    const e = new GeometryEngine();
    const first = e.rebuild([box(40)]).parts[0];
    const d = setFaceColoursIn(doc(), "box", [faceFacing(first, [0, 0, 1])], "#00ae42", first);
    // A different part altogether (a cylinder): no flat top where the box's was… the colour is lost, nothing breaks.
    const cyl = e.rebuild([{ ...feature("cylinder", { radius: 3, height: 60 }), id: "box", name: "Box" }]).parts[0];
    const got = facesColoured(d.faceAppearance!.box, cyl);
    expect(got.colours.size + got.lost).toBe(1);
    e.dispose();
  });

  it("paint the 3MF: the part's colour is filament 1, the face's triangles filament 2", () => {
    const e = new GeometryEngine();
    const p = e.rebuild([box(40)]).parts[0];
    const side = faceFacing(p, [1, 0, 0]);
    const d = setFaceColoursIn(doc(), "box", [side], "#c12e1f", p, "10200");
    // Plain (no face colours given): the old file, no painting.
    const plain = unzip(new Uint8Array(e.export3mf([], "normal", "t", { box: "#ffffff" }).data));
    expect(plain.has("Metadata/model_settings.config")).toBe(false);
    expect(plain.get("3D/3dmodel.model")).not.toContain("paint_color");

    const r = e.export3mf([], "normal", "t", { box: "#ffffff" }, undefined, { faceAppearance: d.faceAppearance!, partSpools: { box: "10100" } });
    expect(r.filaments).toEqual([
      { colour: "#ffffff", spool: "10100" },
      { colour: "#c12e1f", spool: "10200" },
    ]);
    const files = unzip(new Uint8Array(r.data));
    const model = files.get("3D/3dmodel.model")!;
    const config = files.get("Metadata/model_settings.config")!;
    expect(config).toContain('<metadata key="extruder" value="1"/>');
    expect(model).toContain('displaycolor="#FFFFFF"');
    expect(model).toContain('displaycolor="#C12E1F"');
    // The +X face as triangles: each painted with filament 2 ("8"), and only those.
    const vertices = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const xMax = Math.max(...vertices.map((v) => v[0]));
    const triangles = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^/]*)\/>/g)];
    let painted = 0;
    for (const t of triangles) {
      const onSide = [t[1], t[2], t[3]].every((i) => Math.abs(vertices[Number(i)][0] - xMax) < 1e-6);
      const paint = / paint_color="8"/.test(t[4]);
      expect(paint, `triangle ${t[0]}`).toBe(onSide);
      if (paint) {
        expect(t[4]).toContain('p1="1"');
        painted++;
      }
    }
    expect(painted).toBeGreaterThanOrEqual(2);
    e.dispose();
  });

  it("give STEP a face style", async () => {
    const e = new GeometryEngine();
    const p = e.rebuild([box(40)]).parts[0];
    const d = setFaceColoursIn(doc(), "box", [faceFacing(p, [0, 0, 1])], "#c12e1f", p);
    const plain = new TextDecoder().decode(new Uint8Array((await e.exportStep([], { box: "#ffffff" })).step));
    const styled = new TextDecoder().decode(new Uint8Array((await e.exportStep([], { box: "#ffffff" }, undefined, undefined, { faceAppearance: d.faceAppearance! })).step));
    const colours = (t: string) => (t.match(/COLOUR_RGB/g) ?? []).length;
    expect(colours(styled)).toBeGreaterThan(colours(plain));
    expect(styled).toMatch(/ADVANCED_FACE/);
    e.dispose();
  });
  it("paint the 3D print panel's 3MF too, laid on the bed, and leave it plain without face colours", () => {
    const e = new GeometryEngine();
    const p = e.rebuild([box(40)]).parts[0];
    const top = faceFacing(p, [0, 0, 1]);
    const d = setFaceColoursIn(doc(), "box", [top], "#c12e1f", p, "10200");
    // Printed on its side (+Y face down): the coloured top face is then upright, at x = its far end.
    const parts = [{ partId: "box", down: [0, 1, 0] as [number, number, number] }];
    const plain = unzip(new Uint8Array(e.exportPrint3mf(parts, [256, 256], 5, "normal", "t", {}).data));
    expect(plain.has("Metadata/model_settings.config")).toBe(false);
    const r = e.exportPrint3mf(parts, [256, 256], 5, "normal", "t", {}, { faceAppearance: d.faceAppearance! });
    expect(r.filaments).toEqual([{ colour: "#a8b4c0" }, { colour: "#c12e1f", spool: "10200" }]);
    expect(r.layout.places[0].onBed).toBe(true);
    const files = unzip(new Uint8Array(r.data));
    const model = files.get("3D/3dmodel.model")!;
    expect(files.get("Metadata/model_settings.config")).toContain('<metadata key="extruder" value="1"/>');
    const vertices = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const triangles = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^/]*)\/>/g)];
    // The part stands at z 0; the old top (now facing −Y or +Y) is the only face painted.
    expect(Math.min(...vertices.map((v) => v[2]))).toBeCloseTo(0, 6);
    let painted = 0;
    for (const t of triangles) {
      if (!/ paint_color="8"/.test(t[4])) continue;
      painted++;
      const ys = [t[1], t[2], t[3]].map((i) => vertices[Number(i)][1]);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6);
    }
    expect(painted).toBeGreaterThanOrEqual(2);
    expect(triangles.length).toBe(12);
    e.dispose();
  });
});
