/**
 * A set of dividers that slot together crosswise ("egg-crate") to split a box, drawer or toolbox into compartments:
 * dividers running along the box have slots down from the top, those across it slots up from the bottom, each a
 * little more than halfway, so they push together flush. Every divider prints lying flat (drawn on Top, `thickness`
 * up), laid out in a grid. The compartments come out equal. Sizes are Edit design sizes (the slots follow them).
 */
import { lit } from "../ex";
import { copyFeature, extrudeFeature, outlineSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { DEFAULT_FITS } from "../../model/printSettings";
import { mm, num, polygonArea } from "./common";
import type { P2 } from "./printShapes";

const TOP = { kind: "default", name: "Top" } as const;
/** How much shorter than the inside each divider is (mm), and the space between them on the bed. */
export const DIVIDER_ROOM = 0.5;
export const DIVIDER_GAP = 5;
/** How much more than half the height each slot goes, so the two meet with this much to spare. */
export const SLOT_EXTRA = 0.25;

/** How wide the layout on the bed may be (mm): most beds are 256. */
export const LAYOUT_WIDTH = 240;
/** How many dividers `len` long go side by side on the bed. */
export const layoutColumns = (len: number, count: number) => Math.max(1, Math.min(count, Math.floor((LAYOUT_WIDTH + DIVIDER_GAP) / (len + DIVIDER_GAP))));

/** Middles of `n` dividers `t` thick splitting `inside` into n + 1 equal spaces (from −inside/2). */
export function dividerPlaces(inside: number, n: number, t: number): number[] {
  const gap = (inside - n * t) / (n + 1);
  return Array.from({ length: n }, (_, k) => -inside / 2 + (k + 1) * gap + (k + 0.5) * t);
}

export function dividerPlan(v: DesignValues) {
  const length = num(v, "length");
  const width = num(v, "width");
  const height = num(v, "height");
  const t = num(v, "thickness");
  const along = Math.max(0, Math.round(num(v, "along")));
  const across = Math.max(0, Math.round(num(v, "across")));
  const slot = t + num(v, "fit");
  const depth = height / 2 + SLOT_EXTRA;
  return {
    length,
    width,
    height,
    t,
    along,
    across,
    slot,
    depth,
    /** Where the dividers across the box stand along it (x), and those along it across it (y). */
    xs: dividerPlaces(length, across, t),
    ys: dividerPlaces(width, along, t),
    /** Each divider's length. */
    longLength: length - DIVIDER_ROOM,
    crossLength: width - DIVIDER_ROOM,
    compartments: [(length - across * t) / (across + 1), (width - along * t) / (along + 1)] as [number, number],
  };
}

/** A divider laid flat at height y0: `len` long, `height` high, with slots at `at` from the top (down) or bottom (up). */
export function dividerOutline(len: number, height: number, at: number[], slot: number, depth: number, fromTop: boolean, y0 = 0): P2[] {
  const h = len / 2;
  const s = slot / 2;
  const notches = [...at].sort((a, b) => a - b);
  if (fromTop) {
    const top: P2[] = [];
    for (const x of [...notches].reverse()) top.push([x + s, y0 + height], [x + s, y0 + height - depth], [x - s, y0 + height - depth], [x - s, y0 + height]);
    return [[-h, y0], [h, y0], [h, y0 + height], ...top, [-h, y0 + height]];
  }
  const bottom: P2[] = [];
  for (const x of notches) bottom.push([x - s, y0], [x - s, y0 + depth], [x + s, y0 + depth], [x + s, y0]);
  return [[-h, y0], ...bottom, [h, y0], [h, y0 + height], [-h, y0 + height]];
}

export const dividerSet: LibraryDesign = {
  id: "divider-set",
  name: "Box divider set",
  description:
    "Dividers for a toolbox, drawer or storage box that slot together crosswise into a grid of equal compartments. Measure the inside of your box and choose how many dividers go each way; they print lying flat (quick, no supports) and push together without glue.",
  category: "print",
  group: "Storage",
  prefix: "dividers",
  icon: '<rect x="4" y="8" width="40" height="32" rx="1"/><path d="M4 24h40M17 8v32M31 8v32" opacity=".7"/>',
  inputs: [
    { key: "length", label: "Box inside length", kind: "length", default: 160, min: 30, max: 400, help: "Left to right." },
    { key: "width", label: "Box inside width", kind: "length", default: 100, min: 30, max: 400, help: "Front to back." },
    { key: "height", label: "Divider height", kind: "length", default: 40, min: 10, max: 150 },
    { key: "along", label: "Dividers along the box", kind: "count", default: 1, min: 0, max: 10, help: "Running left to right." },
    { key: "across", label: "Dividers across the box", kind: "count", default: 2, min: 0, max: 15, help: "Running front to back." },
    { key: "thickness", label: "Thickness", kind: "length", default: 1.6, min: 1, max: 5 },
    { key: "fit", label: "Slot fit", kind: "length", default: DEFAULT_FITS.sliding, min: 0, max: 1, help: "How much wider each slot is than a divider, so they slide together." },
  ],
  problems: (v) => {
    const p = dividerPlan(v);
    const out: string[] = [];
    if (p.along + p.across === 0) out.push("Choose at least one divider.");
    if (p.compartments[0] < 5 || p.compartments[1] < 5) out.push("The compartments would be less than 5 mm wide: use fewer dividers.");
    if (Math.max(p.longLength, p.crossLength) > 250) out.push("A divider would be longer than most printers' beds (256 mm): make the box smaller.");
    return out;
  },
  summary: (v) => {
    const p = dividerPlan(v);
    return `${p.along + p.across} parts: ${p.along} along (${mm(p.longLength)}) and ${p.across} across (${mm(p.crossLength)}), making ${(p.along + 1) * (p.across + 1)} compartments about ${mm(Math.round(p.compartments[0] * 10) / 10)} × ${mm(Math.round(p.compartments[1] * 10) / 10)}.`;
  },
  make: (ctx) => {
    const p = dividerPlan(ctx.values);
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const kinds: [string, string, string, number, number[], boolean, number][] = [
      ["long", "Divider along", "along", p.longLength, p.across ? p.xs : [], true, p.along],
      ["cross", "Divider across", "across", p.crossLength, p.along ? p.ys : [], false, p.across],
    ];
    // Laid out in a grid on the bed: as many side by side as fit in `LAYOUT_WIDTH`, then the next row.
    let row = 0;
    for (const [role, name, word, len, at, fromTop, count] of kinds) {
      if (!count) continue;
      const cols = layoutColumns(len, count);
      const first = ctx.id(`${role}1`);
      const y0 = row * (p.height + DIVIDER_GAP);
      const outline = dividerOutline(len, p.height, at, p.slot, p.depth, fromTop, y0);
      features.push(
        sketchFeature(ctx.id(`${role}-sketch`), `${name} sketch`, TOP, outlineSketch(outline.map(([x, y]) => [lit(x), lit(y)]), ctx.scope)),
        extrudeFeature(first, `${name} 1`, ctx.id(`${role}-sketch`), { depth: lit(p.t), operation: "new" }),
      );
      partNames[first] = `${ctx.name}: ${word} 1`;
      for (let i = 1; i < count; i++) {
        const id = ctx.id(`${role}${i + 1}`);
        const [c, r] = [i % cols, Math.floor(i / cols)];
        features.push(copyFeature(id, `${name} ${i + 1}`, first, { dx: lit(c * (len + DIVIDER_GAP)), dy: lit(r * (p.height + DIVIDER_GAP)) }));
        partNames[id] = `${ctx.name}: ${word} ${i + 1}`;
      }
      row += Math.ceil(count / cols);
    }
    return { features, partNames };
  },
  preview: (v) => {
    const p = dividerPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, faint: true, points: [[-p.length / 2, -p.width / 2], [p.length / 2, -p.width / 2], [p.length / 2, p.width / 2], [-p.length / 2, p.width / 2]] }];
    for (const y of p.ys) out.push({ kind: "poly", points: [[-p.longLength / 2, y], [p.longLength / 2, y]] });
    for (const x of p.xs) out.push({ kind: "poly", points: [[x, -p.crossLength / 2], [x, p.crossLength / 2]] });
    out.push({ kind: "text", at: [0, -p.width / 2 - 8], text: "seen from above, in the box" });
    return out;
  },
};

/** For tests: each kind of divider's volume (mm³). */
export function dividerVolumes(v: DesignValues): { long: number; cross: number } {
  const p = dividerPlan(v);
  return {
    long: polygonArea(dividerOutline(p.longLength, p.height, p.across ? p.xs : [], p.slot, p.depth, true)) * p.t,
    cross: polygonArea(dividerOutline(p.crossLength, p.height, p.along ? p.ys : [], p.slot, p.depth, false)) * p.t,
  };
}
