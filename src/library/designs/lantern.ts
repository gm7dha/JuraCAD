/**
 * A tealight lantern: an open-topped finger-joint box (fingers.ts) — a square base and four walls — whose walls are cut
 * with a pattern of simple shapes (patterns.ts) for the light to shine through. Every shape is a separate hole with sheet
 * all round it, so nothing falls out and nothing needs a bridge; the design refuses patterns whose shapes would come
 * closer than the bridge width to each other or to a wall's edge.
 *
 * The sizes aren't variables: the pattern is worked out for the walls' sizes, so change them with "Edit design sizes".
 */
import { lit } from "../ex";
import { boxProblems, panelOutlines, type BoxSizes, type PanelName, type Pt } from "../fingers";
import { joinSketches } from "../laserKit";
import { offsetPolygon, round6, type Box, type P2 } from "../outlines";
import { patternGap, patternHoles, patternIslands, type Hole, type PatternKind } from "../patterns";
import { copyFeature, extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import type { SketchPlane } from "../../sketch/planes";
import { mm, num } from "./common";

const PLANES: Record<PanelName, SketchPlane> = {
  bottom: { kind: "default", name: "Top" },
  front: { kind: "default", name: "Front" },
  left: { kind: "default", name: "Right" },
};
const LABEL: Record<PanelName, string> = { bottom: "Base", front: "Front", left: "Left side" };

/** More holes than this on one wall is too slow to build. */
export const MAX_HOLES = 300;

export function lanternBox(v: DesignValues): BoxSizes {
  const [s, h, t, kerf] = ["size", "height", "thickness", "kerf"].map((k) => num(v, k));
  return { W: lit(s), D: lit(s), H: lit(h), t: lit(t), kerf: lit(kerf), lid: false, finger: num(v, "finger") };
}

/** Where a wall's pattern goes (its own across and up): clear of its fingers by the margin; the top edge is plain. */
export function patternWindow(v: DesignValues, across: number): Box {
  const [h, t, m] = ["height", "thickness", "margin"].map((k) => num(v, k));
  return [t + m, t + m, across - t - m, h - m];
}

/** Each wall's holes at their true size (front/back and the sides are the same size, so share one pattern). */
export function lanternHoles(v: DesignValues): Hole[] {
  return patternHoles(String(v.pattern) as PatternKind, patternWindow(v, num(v, "size")), num(v, "shape"), num(v, "bridge"));
}

/** A hole as drawn: kerf/2 smaller all round, so it comes out its true size. */
function drawn(h: Hole, kerf: number): Hole {
  if (h.kind === "circle") return { ...h, d: h.d - kerf };
  return { kind: "poly", points: round6(offsetPolygon(h.points, -kerf / 2)) };
}

function holesSketch(holes: Hole[], scope: Record<string, number>): SketchData {
  return joinSketches(
    ...holes.map((h) => (h.kind === "circle" ? shapesSketch([{ type: "circle", center: h.c, diameter: Math.round(h.d * 1e6) / 1e6 }], scope) : outlineSketch(h.points.map(([x, y]) => [lit(x), lit(y)] as Pt), scope))),
  );
}

export function lanternProblems(v: DesignValues): string[] {
  const out = boxProblems(lanternBox(v));
  if (out.length) return out;
  const [shape, bridge, t] = ["shape", "bridge", "thickness"].map((k) => num(v, k));
  if (bridge < t / 2) return [`Make the bridges at least ${mm(t / 2)} wide for ${mm(t)} sheet, so they don't snap.`];
  const holes = lanternHoles(v);
  if (!holes.length) return ["The shapes are too big for the walls: make them smaller, or the lantern bigger."];
  if (holes.length > MAX_HOLES) return [`That's over ${MAX_HOLES} shapes on each wall: make them bigger.`];
  // Nothing can fall out: no hole inside another, and sheet at least a bridge wide between every two.
  if (patternIslands(holes).nested) return ["Some shapes would sit inside others."];
  if (patternGap(holes, bridge - 1e-6) < bridge - 1e-6) return [`Some shapes come closer than ${mm(bridge)} to each other.`];
  if (shape < 4) out.push("Make the shapes at least 4 mm across, or they'll char rather than cut cleanly.");
  return out;
}

export const lanternDesign: LibraryDesign = {
  id: "lantern",
  name: "Tealight lantern",
  group: "Home",
  description:
    "A square lantern with a pattern cut into its four walls — circles, diamonds, a honeycomb or stars — for the light to shine through. The walls and base are finger-jointed. Every shape is its own hole with sheet all round it, so nothing falls out. Use an LED tealight: never a real flame in a wooden lantern.",
  category: "laser",
  prefix: "lantern",
  icon: '<path d="M10 12h28v32H10z"/><circle cx="18" cy="20" r="3"/><circle cx="30" cy="20" r="3"/><circle cx="24" cy="28" r="3"/><circle cx="18" cy="36" r="3"/><circle cx="30" cy="36" r="3"/><path d="M16 12l4-6h8l4 6" opacity=".5"/>',
  inputs: [
    { key: "size", label: "Width", kind: "length", default: 90, min: 50, max: 280, help: "Outside, each way: the base is square." },
    { key: "height", label: "Height", kind: "length", default: 130, min: 50, max: 280 },
    {
      key: "pattern",
      label: "Pattern",
      kind: "choice",
      default: "circles",
      choices: [
        { value: "circles", label: "Circles" },
        { value: "diamonds", label: "Diamonds" },
        { value: "hexagons", label: "Honeycomb" },
        { value: "stars", label: "Stars" },
      ],
    },
    { key: "shape", label: "Shape size", kind: "length", default: 12, min: 4, max: 100, help: "How big each shape is across (corner to corner; flat to flat for the honeycomb)." },
    { key: "bridge", label: "Bridge width", kind: "length", default: 3, min: 1, max: 30, help: "The sheet left between shapes. Wider is stronger." },
    { key: "margin", label: "Plain border", kind: "length", default: 8, min: 2, max: 60, help: "Uncut sheet round the pattern on each wall." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 10, min: 2, max: 100, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: lanternProblems,
  summary: (v) => `5 pieces: a base and 4 walls with ${lanternHoles(v).length} shapes each.`,
  make: (ctx) => {
    const b = lanternBox(ctx.values);
    const kerf = num(ctx.values, "kerf");
    const holes = lanternHoles(ctx.values).map((h) => drawn(h, kerf));
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const name = (role: string, label: string) => (partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`);
    for (const p of panelOutlines(b)) {
      const sk = ctx.id(`${p.name}-sketch`);
      let s = outlineSketch(p.outline, ctx.scope);
      if (p.name !== "bottom") s = joinSketches(s, holesSketch(holes, ctx.scope));
      features.push(sketchFeature(sk, `${LABEL[p.name]} sketch`, PLANES[p.name], s));
      features.push(extrudeFeature(ctx.id(p.name), LABEL[p.name], sk, { depth: b.t, operation: "new", flip: p.name === "front" }));
      name(p.name, LABEL[p.name]);
      if (p.name === "bottom") continue;
      const [copy, label, move] = p.name === "front" ? ["back", "Back", { dy: lit(b.D.v - b.t.v) }] : ["right", "Right side", { dx: lit(b.W.v - b.t.v) }];
      features.push(copyFeature(ctx.id(copy), label, ctx.id(p.name), move));
      name(copy, label);
    }
    return { features, partNames };
  },
  preview: (v) => {
    if (lanternProblems(v).length) return [];
    const b = lanternBox(v);
    const panels = panelOutlines(b);
    const flat = (p: Pt[], dx = 0, dy = 0) => p.map(([x, y]) => [x.v + dx, y.v + dy] as P2);
    const s = b.W.v;
    const out: PreviewShape[] = [];
    const holes = lanternHoles(v);
    const front = panels.find((p) => p.name === "front")!;
    for (const [i, dx] of [0, s + 8].entries()) {
      out.push({ kind: "poly", closed: true, points: flat(i ? panels.find((p) => p.name === "left")!.nominal : front.nominal, dx) });
      for (const h of holes) out.push(h.kind === "circle" ? { kind: "circle", c: [h.c[0] + dx, h.c[1]], r: h.d / 2 } : { kind: "poly", closed: true, points: h.points.map(([x, y]) => [x + dx, y] as P2) });
    }
    out.push({ kind: "poly", closed: true, points: flat(panels.find((p) => p.name === "bottom")!.nominal, 2 * (s + 8)) });
    out.push({ kind: "text", at: [s / 2, -8], text: "front, back" }, { kind: "text", at: [1.5 * s + 8, -8], text: "sides" }, { kind: "text", at: [2.5 * s + 16, -8], text: "base" });
    return out;
  },
};
