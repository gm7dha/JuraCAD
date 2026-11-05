/**
 * A spice or bottle rack: shelves between two side panels, each shelf with a low rail along its front and back so the
 * jars can't slide off, all held by tabs through slots in the sides (sidePanels.ts). Sized from the jars: each shelf
 * takes `count` jars of the given diameter side by side, with room round each.
 *
 * Seen side-on (x from the back to the front, z up): shelf i is level at z = m + i × pitch (its underside), from x = m to
 * the depth − m; its rails stand on it, `m` in from the sides' edges, rail-height tall. The sides reach a margin above
 * the top shelf's rails.
 */
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { assemblyFeatures, assemblyProblems, evenTabs, sectionOf, sideSlots, type CrossPiece, type SideAssembly } from "../sidePanels";
import { r6, type P2 } from "../outlines";
import { mm, num } from "./common";

/** Room between jars, and between a jar and the rails (mm). */
export const JAR_ROOM = 2;
/** Room above a jar, below the shelf over it, at least (mm, besides the shelf's thickness); more when the rails are tall, so a jar can be lifted over the front one. */
export const HEADROOM = 12;
/** A jar is lifted this much higher than the front rail to take it out (mm). */
export const RAIL_LIFT = 5;

export interface SpiceRack {
  a: SideAssembly;
  depth: number;
  height: number;
  /** Each shelf's top (z). */
  shelves: number[];
}

export function spiceRack(v: DesignValues): SpiceRack {
  const [d, count, rows, tall, rail, t, kerf] = ["diameter", "count", "shelves", "jarHeight", "rail", "thickness", "kerf"].map((k) => num(v, k));
  const m = Math.max(5, t);
  const width = r6(count * d + (count + 1) * JAR_ROOM);
  const depth = r6(2 * m + 2 * t + d + 2 * JAR_ROOM);
  // Room over each jar to lift it over the front rail (and a little more), or the usual headroom if that's more.
  const pitch = tall + Math.max(HEADROOM, rail + RAIL_LIFT) + t;
  const pieces: CrossPiece[] = [];
  const shelves: number[] = [];
  for (let i = 0; i < rows; i++) {
    const z0 = m + i * pitch;
    const top = r6(z0 + t);
    shelves.push(top);
    const n = i + 1;
    const len = depth - 2 * m;
    pieces.push({ role: n === 1 ? "shelf" : `shelf-${n}`, label: `Shelf ${n}`, centre: [r6(depth / 2), r6(z0 + t / 2)], angle: 0, length: r6(len), tabs: [[r6(len * 0.3), r6(len * 0.7)]] });
    const railTabs = evenTabs(rail, 1);
    pieces.push({ role: `rail-back-${n}`, label: `Back rail ${n}`, centre: [r6(m + t / 2), r6(top + rail / 2)], angle: 90, length: rail, tabs: railTabs });
    pieces.push({ role: `rail-front-${n}`, label: `Front rail ${n}`, centre: [r6(depth - m - t / 2), r6(top + rail / 2)], angle: 90, length: rail, tabs: railTabs });
  }
  const height = r6(shelves[shelves.length - 1] + rail + m);
  const side: P2[] = [
    [0, 0],
    [depth, 0],
    [depth, height],
    [0, height],
  ];
  return { a: { side, pieces, width, t, kerf }, depth, height, shelves };
}

export function rackProblems(v: DesignValues): string[] {
  const [t, kerf, rail] = ["thickness", "kerf", "rail"].map((k) => num(v, k));
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (rail < 3 * t + 3) return [`Make the rails at least ${mm(3 * t + 3)} tall, so their tabs hold.`];
  const r = spiceRack(v);
  return assemblyProblems(r.a);
}

export const spiceRackDesign: LibraryDesign = {
  id: "spice-rack",
  name: "Spice or bottle rack",
  group: "Home",
  description:
    "Shelves for spice jars or small bottles, sized from your jars: how wide they are, how tall, and how many on each shelf. A low rail along the front and back of each shelf stops them sliding off. The shelves and rails have tabs that go through slots in the two sides. Shown put together.",
  category: "laser",
  prefix: "spice",
  icon: '<path d="M6 4v40M42 4v40M6 18h36M6 34h36"/><path d="M10 18V9h6v9M20 18V8h6v10M30 18V9h6v9M10 34v-9h6v9M20 34v-10h6v10M30 34v-9h6v9" opacity=".6"/>',
  inputs: [
    { key: "diameter", label: "Jar diameter", kind: "length", default: 45, min: 15, max: 150, help: "Measure the widest part of your jars or bottles." },
    { key: "jarHeight", label: "Jar height", kind: "length", default: 100, min: 20, max: 280 },
    { key: "count", label: "Jars on each shelf", kind: "count", default: 4, min: 1, max: 12 },
    { key: "shelves", label: "Shelves", kind: "count", default: 3, min: 1, max: 6 },
    { key: "rail", label: "Rail height", kind: "length", default: 20, min: 10, max: 80, help: "The low rails along the front and back of each shelf." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger and slots this much smaller, so the tabs fit snugly." },
  ],
  problems: rackProblems,
  summary: (v) => {
    const r = spiceRack(v);
    return `${num(v, "shelves") * num(v, "count")} jars; ${mm(r.a.width + 2 * r.a.t)} wide, ${mm(r.height)} tall; ${r.a.pieces.length + 2} pieces.`;
  },
  make: (ctx) => assemblyFeatures(ctx, spiceRack(ctx.values).a),
  preview: (v) => {
    if (rackProblems(v).length) return [];
    const r = spiceRack(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: r.a.side }];
    for (const p of r.a.pieces) out.push({ kind: "poly", closed: true, points: sectionOf(p, r.a.t), faint: true });
    for (const s of sideSlots(r.a)) out.push({ kind: "poly", closed: true, points: s });
    out.push({ kind: "text", at: [r.depth / 2, -10], text: "side" });
    // The front of the rack beside it: its shelves and jars.
    const x0 = r.depth + 20;
    const w = r.a.width;
    const d = num(v, "diameter");
    for (const z of r.shelves) {
      out.push({ kind: "poly", closed: true, points: [[x0, z - r.a.t], [x0 + w, z - r.a.t], [x0 + w, z], [x0, z]] });
      for (let i = 0; i < num(v, "count"); i++) {
        const cx = x0 + JAR_ROOM + d / 2 + i * (d + JAR_ROOM);
        out.push({ kind: "poly", closed: true, faint: true, points: [[cx - d / 2, z], [cx + d / 2, z], [cx + d / 2, z + num(v, "jarHeight")], [cx - d / 2, z + num(v, "jarHeight")]] });
      }
    }
    out.push({ kind: "text", at: [x0 + w / 2, -10], text: "from the front" });
    return out;
  },
};
