import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { addCircle } from "../src/sketch/ops";
import { addEllipse } from "../src/sketch/tools";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";

beforeAll(async () => setOC(await opencascade()));
let n = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sk = (plane: any, data: SketchData): Feature => ({ id: `s${++n}`, name: `Sketch ${n}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const f = (type: Feature["type"], params: Record<string, number>, extra: Partial<Feature> = {}): Feature => ({ id: `f${++n}`, name: `${type} ${n}`, type, operation: "new", suppressed: false, params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) }, ...extra });

describe("probe", () => {
  it("reports edges", () => {
    const out: string[] = [];
    const e = new GeometryEngine();
    const c = sk({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch);
    let r = e.rebuild([c, f("extrude", { depth: 10 }, { sketchRef: c.id, extrude: { end: "blind", flip: false } })]);
    out.push(`circle-extrude edges=${JSON.stringify(r.parts[0]?.edgeRefs.map((x) => x.curve))} faces=${JSON.stringify(r.parts[0]?.faceRefs.map((x) => x.surface))} err=${JSON.stringify(r.featureErrors)}`);
    const el = sk({ kind: "default", name: "Top" }, addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 }, [0, 5]).sketch);
    r = e.rebuild([el, f("extrude", { depth: 10 }, { sketchRef: el.id, extrude: { end: "blind", flip: false } })]);
    out.push(`ellipse-extrude edges=${JSON.stringify(r.parts[0]?.edgeRefs.map((x) => x.curve))} faces=${JSON.stringify(r.parts[0]?.faceRefs.map((x) => x.surface))}`);
    const el2 = sk(planeOnFace([0, 0, 1], [0, 0, 20], "up"), addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 6, y: 0 }, [0, 12]).sketch);
    r = e.rebuild([el, el2, f("loft", {}, { sections: [el.id, el2.id] })]);
    out.push(`ellipse-loft edges=${JSON.stringify(r.parts[0]?.edgeRefs.map((x) => [x.curve, x.a, x.b]))} faces=${JSON.stringify(r.parts[0]?.faceRefs.map((x) => x.surface))} err=${JSON.stringify(r.featureErrors)}`);
    const c2 = sk(planeOnFace([0, 0, 1], [0, 0, 20], "up"), addCircle(emptySketch(), { x: 0, y: 0 }, 8).sketch);
    r = e.rebuild([c, c2, f("loft", {}, { sections: [c.id, c2.id] })]);
    out.push(`circle-loft edges=${JSON.stringify(r.parts[0]?.edgeRefs.map((x) => [x.curve, x.a, x.b]))} faces=${JSON.stringify(r.parts[0]?.faceRefs.map((x) => x.surface))}`);
    r = e.rebuild([c, f("revolve", { angle: 360 }, { sketchRef: c.id, revolve: { axis: "vertical", flip: false } })]);
    out.push(`circle-revolve err=${JSON.stringify(r.featureErrors)}`);
    expect(out.join("\n")).toBe("");
  });
});
