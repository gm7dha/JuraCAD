/**
 * A pen and tool pot for a desk: an open-topped, square finger-joint box (fingers.ts, boxPanels.ts) whose four walls are
 * cut with a honeycomb (or another pattern, patterns.ts) inside a plain border, and — if chosen — a cross of two dividers
 * that slot together (a halving joint) and stand loose on the floor, making four compartments.
 *
 * Finger box coordinates: x across (0…S), y front to back (0…S), z up (0…H). The dividers are `DIVIDER_ROOM` shorter
 * than the inside each way and stop `DIVIDER_BELOW` under the top: one stands across x at y = S/2 (slotted from the top),
 * the other across y at x = S/2 (slotted from the bottom).
 */
import { lit } from "../ex";
import { boxProblems, type BoxSizes } from "../fingers";
import { boxFeatures, plateSketch, type PlateHole } from "../boxPanels";
import { offsetPolygon, r6, type Box, type P2 } from "../outlines";
import { patternGap, patternHoles, patternIslands, type Hole, type PatternKind } from "../patterns";
import { extrudeFeature, moveFeature, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import { mm, num } from "./common";

/** The dividers are this much shorter than the inside, each way (mm, in all). */
export const DIVIDER_ROOM = 0.5;
/** The dividers' tops are this far under the walls' (mm). */
export const DIVIDER_BELOW = 15;
/** More shapes than this on one wall is too slow to build. */
export const MAX_SHAPES = 300;

export function penBox(v: DesignValues): BoxSizes {
  const [s, h, t, kerf] = ["size", "height", "thickness", "kerf"].map((k) => num(v, k));
  return { W: lit(s), D: lit(s), H: lit(h), t: lit(t), kerf: lit(kerf), lid: false, finger: num(v, "finger") };
}

/** Where a wall's pattern goes (its own across and up): clear of the fingers by the border; the top edge is plain. */
export function penWindow(v: DesignValues): Box {
  const [s, h, t, m] = ["size", "height", "thickness", "margin"].map((k) => num(v, k));
  return [t + m, t + m, s - t - m, h - m];
}

export const penHoles = (v: DesignValues): Hole[] => patternHoles(String(v.pattern) as PatternKind, penWindow(v), num(v, "shape"), num(v, "bridge"));

export interface Dividers {
  /** Each divider's true outline in its own (across, up), across from the inside's start: [across x, across y]. */
  plates: [P2[], P2[]];
  length: number;
  height: number;
}

/** The two dividers: each L = inside − DIVIDER_ROOM long, (H − t − DIVIDER_BELOW) tall, with a halving slot t wide at its middle. */
export function penDividers(v: DesignValues): Dividers {
  const [s, h, t] = ["size", "height", "thickness"].map((k) => num(v, k));
  const L = r6(s - 2 * t - DIVIDER_ROOM);
  const H = r6(h - t - DIVIDER_BELOW);
  const [m0, m1] = [r6(L / 2 - t / 2), r6(L / 2 + t / 2)];
  const half = r6(H / 2);
  const fromTop: P2[] = [
    [0, 0],
    [L, 0],
    [L, H],
    [m1, H],
    [m1, half],
    [m0, half],
    [m0, H],
    [0, H],
  ];
  const fromBottom: P2[] = [
    [0, 0],
    [m0, 0],
    [m0, half],
    [m1, half],
    [m1, 0],
    [L, 0],
    [L, H],
    [0, H],
  ];
  return { plates: [fromTop, fromBottom], length: L, height: H };
}

export function penProblems(v: DesignValues): string[] {
  const out = boxProblems(penBox(v));
  if (out.length) return out;
  const [shape, bridge, t] = ["shape", "bridge", "thickness"].map((k) => num(v, k));
  if (bridge < t / 2) return [`Make the bridges at least ${mm(t / 2)} wide for ${mm(t)} sheet, so they don't snap.`];
  if (shape < 4) return ["Make the shapes at least 4 mm across, or they'll char rather than cut cleanly."];
  const holes = penHoles(v);
  if (holes.length > MAX_SHAPES) return [`That's over ${MAX_SHAPES} shapes on each wall: make them bigger.`];
  if (holes.length && patternIslands(holes).nested) return ["Some shapes would sit inside others."];
  if (holes.length && patternGap(holes, bridge - 1e-6) < bridge - 1e-6) return [`Some shapes come closer than ${mm(bridge)} to each other.`];
  if (v.dividers !== false && penDividers(v).height < 3 * t) return ["The pot is too short for dividers: make it taller, or turn them off."];
  return out;
}

export const penHolderDesign: LibraryDesign = {
  id: "pen-holder",
  name: "Honeycomb desk pot",
  group: "Desk",
  description:
    "A square pen and tool pot for your desk, with a honeycomb (or circles, diamonds or stars) cut into its four finger-jointed walls. Two dividers that slot together into a cross split it into four compartments — leave them out for one big pot. Every shape is its own hole with sheet all round it, so nothing falls out.",
  category: "laser",
  prefix: "pens",
  icon: '<path d="M10 14h28v30H10z"/><path d="M17 20l3 2v3l-3 2-3-2v-3zM31 20l3 2v3l-3 2-3-2v-3zM24 30l3 2v3l-3 2-3-2v-3z"/><path d="M18 14l4-10M28 14l-2-9" opacity=".5"/>',
  inputs: [
    { key: "size", label: "Width", kind: "length", default: 90, min: 40, max: 280, help: "Outside, each way: the pot is square." },
    { key: "height", label: "Height", kind: "length", default: 110, min: 40, max: 280 },
    {
      key: "pattern",
      label: "Pattern",
      kind: "choice",
      default: "hexagons",
      choices: [
        { value: "hexagons", label: "Honeycomb" },
        { value: "circles", label: "Circles" },
        { value: "diamonds", label: "Diamonds" },
        { value: "stars", label: "Stars" },
      ],
    },
    { key: "shape", label: "Shape size", kind: "length", default: 9, min: 4, max: 60, help: "How big each shape is across (flat to flat for the honeycomb). Keep it smaller than your pens." },
    { key: "bridge", label: "Bridge width", kind: "length", default: 3, min: 1, max: 30, help: "The sheet left between shapes. Wider is stronger." },
    { key: "margin", label: "Plain border", kind: "length", default: 8, min: 2, max: 60, help: "Uncut sheet round the pattern on each wall." },
    { key: "dividers", label: "Dividers", kind: "toggle", default: true, help: "Two pieces that slot together into a cross, making four compartments." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 10, min: 2, max: 100, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: penProblems,
  summary: (v) => `${v.dividers !== false ? 7 : 5} pieces: a base and 4 walls with ${penHoles(v).length} shapes each${v.dividers !== false ? ", and 2 dividers" : ""}.`,
  make: (ctx) => {
    const b = penBox(ctx.values);
    const [S, t] = [b.W.v, b.t.v];
    const k = Math.max(0, b.kerf.v);
    const holes = penHoles(ctx.values) as PlateHole[];
    const made = boxFeatures(ctx, {
      b,
      stance: "upright",
      panels: { bottom: "Base", front: "Front", back: "Back", left: "Left side", right: "Right side" },
      holes: { front: holes, back: holes, left: holes, right: holes },
    });
    const features: Feature[] = [...made.features];
    const partNames = { ...made.partNames };
    if (ctx.values.dividers !== false) {
      const d = penDividers(ctx.values);
      const start = r6(t + DIVIDER_ROOM / 2);
      const pieces = [
        // Across x, standing at y = S/2: drawn on Front (x, z), flipped towards +y, moved to its middle.
        { role: "divider-x", label: "Divider across", plane: "Front" as const, flip: true, move: { dx: lit(start), dy: lit(r6(S / 2 - t / 2)), dz: lit(t) } },
        // Across y, standing at x = S/2: drawn on Right (y, z), made towards +x.
        { role: "divider-y", label: "Divider along", plane: "Right" as const, flip: false, move: { dx: lit(r6(S / 2 - t / 2)), dy: lit(start), dz: lit(t) } },
      ];
      pieces.forEach((p, i) => {
        const sk = ctx.id(`${p.role}-sketch`);
        features.push(
          sketchFeature(sk, `${p.label} sketch`, { kind: "default", name: p.plane }, plateSketch(offsetPolygon(d.plates[i], k / 2), [], ctx.scope)),
          extrudeFeature(ctx.id(p.role), p.label, sk, { depth: lit(t), operation: "new", flip: p.flip }),
          moveFeature(ctx.id(`${p.role}-move`), `${p.label} in place`, ctx.id(p.role), p.move),
        );
        partNames[ctx.id(p.role)] = `${ctx.name} ${p.label.toLowerCase()}`;
      });
    }
    return { features, partNames };
  },
  preview: (v) => {
    if (penProblems(v).length) return [];
    const s = num(v, "size");
    const h = num(v, "height");
    const out: PreviewShape[] = [];
    out.push({ kind: "poly", closed: true, points: [[0, 0], [s, 0], [s, h], [0, h]] });
    for (const hole of penHoles(v)) out.push(hole.kind === "circle" ? { kind: "circle", c: hole.c, r: hole.d / 2 } : { kind: "poly", closed: true, points: hole.points });
    out.push({ kind: "text", at: [s / 2, -8], text: "each wall" });
    if (v.dividers !== false) {
      const d = penDividers(v);
      d.plates.forEach((p, i) => out.push({ kind: "poly", closed: true, faint: true, points: p.map(([x, y]) => [x + s + 15 + i * (d.length + 10), y] as P2) }));
      out.push({ kind: "text", at: [s + 15 + d.length + 5, -8], text: "dividers" });
    }
    return out;
  },
};
