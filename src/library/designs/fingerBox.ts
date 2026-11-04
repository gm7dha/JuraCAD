/** A finger-jointed box, cut from flat sheet on a laser: 5 or 6 panels that slot together. */
import { minus, plus, times, type Ex } from "../ex";
import { boxProblems, fingerCounts, panelOutlines, type BoxSizes, type PanelName } from "../fingers";
import { copyFeature, extrudeFeature, outlineSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { SketchPlane } from "../../sketch/planes";
import { num, varsOf } from "./common";

const VARS = ["width", "depth", "height", "thickness", "kerf"];

function sizes(values: DesignValues, vars: Record<string, Ex> = varsOf(values, VARS)): BoxSizes {
  const t = vars.thickness;
  const inside = values.measure === "inside";
  const lid = values.lid !== false;
  return {
    W: inside ? plus(vars.width, times(t, 2)) : vars.width,
    D: inside ? plus(vars.depth, times(t, 2)) : vars.depth,
    H: inside ? plus(vars.height, times(t, lid ? 2 : 1)) : vars.height,
    t,
    kerf: vars.kerf,
    lid,
    finger: num(values, "finger"),
  };
}

const PLANES: Record<PanelName, SketchPlane> = {
  bottom: { kind: "default", name: "Top" },
  front: { kind: "default", name: "Front" },
  left: { kind: "default", name: "Right" },
};
const LABEL: Record<PanelName, string> = { bottom: "Bottom", front: "Front", left: "Left side" };

export const fingerBox: LibraryDesign = {
  id: "finger-box",
  name: "Finger-joint box",
  description: "A box of flat panels with interlocking fingers, to cut on a laser and slot together. Shown put together; every panel has a big flat face, ready to lay flat for cutting.",
  madeBy: "laser",
  prefix: "box",
  icon: '<path d="M8 18 24 10l16 8v18l-16 8-16-8z"/><path d="M8 18l16 8 16-8M24 26v18"/><path d="M12 20v3l3 1.5v-3M18 23v3l3 1.5v-3M27 25.5v3l3-1.5v-3M33 22.5v3l3-1.5v-3"/>',
  inputs: [
    {
      key: "measure",
      label: "Sizes are",
      kind: "choice",
      default: "outside",
      choices: [
        { value: "outside", label: "Outside" },
        { value: "inside", label: "Inside" },
      ],
      help: "Inside: the space in the box. Outside: the box's overall size.",
    },
    { key: "width", label: "Width", kind: "length", default: 120, min: 10, max: 2000, variable: true },
    { key: "depth", label: "Depth", kind: "length", default: 80, min: 10, max: 2000, variable: true },
    { key: "height", label: "Height", kind: "length", default: 60, min: 10, max: 2000, variable: true },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 10, min: 2, max: 500, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "lid", label: "Lid", kind: "toggle", default: true, help: "Off: an open-topped box (5 panels)." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, variable: true, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: (values) => boxProblems(sizes(values)),
  summary: (values) => {
    const n = fingerCounts(sizes(values));
    return `${values.lid !== false ? 6 : 5} panels; ${n.width} fingers along the width, ${n.depth} along the depth, ${n.height} up the height.`;
  },
  make: (ctx) => {
    const b = sizes(ctx.values, ctx.vars);
    const outlines = panelOutlines(b);
    const features = [];
    const partNames: Record<string, string> = {};
    const part = (role: string, label: string) => (partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`);
    for (const p of outlines) {
      const sk = ctx.id(`${p.name}-sketch`);
      features.push(sketchFeature(sk, `${LABEL[p.name]} sketch`, PLANES[p.name], outlineSketch(p.outline, ctx.scope)));
      // The front is drawn on the Front plane, which faces −Y: flip it so it goes into the box.
      features.push(extrudeFeature(ctx.id(p.name), LABEL[p.name], sk, { depth: b.t, operation: "new", flip: p.name === "front" }));
      part(p.name, LABEL[p.name]);
      const across = minus(p.name === "bottom" ? b.H : p.name === "front" ? b.D : b.W, b.t);
      const copy = p.name === "bottom" ? "lid" : p.name === "front" ? "back" : "right";
      if (copy === "lid" && !b.lid) continue;
      const label = copy === "lid" ? "Lid" : copy === "back" ? "Back" : "Right side";
      features.push(copyFeature(ctx.id(copy), label, ctx.id(p.name), p.name === "bottom" ? { dz: across } : p.name === "front" ? { dy: across } : { dx: across }));
      part(copy, label);
    }
    return { features, partNames };
  },
  preview: (values) => {
    const b = sizes(values);
    if (boxProblems(b).length) return [];
    const panels = panelOutlines(b);
    const gap = Math.max(b.W.v, b.D.v, b.H.v) * 0.08;
    const out: PreviewShape[] = [];
    const rows: [PanelName, string, string | null][] = [
      ["bottom", "Bottom", b.lid ? "Lid" : null],
      ["front", "Front", "Back"],
      ["left", "Left", "Right"],
    ];
    let y = 0;
    for (const [name, label, copy] of rows) {
      const p = panels.find((x) => x.name === name)!;
      const xs = p.outline.map((q) => q[0].v);
      const ys = p.outline.map((q) => q[1].v);
      const [w, h] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
      y -= h;
      for (const [i, text] of [label, copy].entries()) {
        if (!text) continue;
        const dx = i * (w + gap) - Math.min(...xs);
        const dy = y - Math.min(...ys);
        out.push({ kind: "poly", closed: true, points: p.outline.map((q) => [q[0].v + dx, q[1].v + dy]) });
        out.push({ kind: "text", at: [dx + Math.min(...xs) + w / 2, y + h / 2], text });
      }
      y -= gap;
    }
    return out;
  },
};

/** For tests: the box's sizes from plain values. */
export const fingerBoxSizes = (values: DesignValues) => sizes(values);
