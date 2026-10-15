/**
 * Drawing symbols: datum feature symbols, GD&T feature control frames and
 * surface finish marks. Each is drawn from plain lines and text (sheet mm,
 * y up), so it looks the same on screen, in the PDF and in the DXF — the
 * GD&T characteristic signs are drawn, not typed, since PDF fonts lack them.
 */
import type { DrawingNote, DrawingSymbol, GdtCharacteristic } from "../model/types";
import type { Prim } from "./sheet";

type P2 = [number, number];

/** The characteristics, in the order the menu lists them, with their names. */
export const GDT_CHARACTERISTICS: { key: GdtCharacteristic; label: string; datums: boolean }[] = [
  { key: "straightness", label: "Straightness", datums: false },
  { key: "flatness", label: "Flatness", datums: false },
  { key: "circularity", label: "Circularity (roundness)", datums: false },
  { key: "cylindricity", label: "Cylindricity", datums: false },
  { key: "profileLine", label: "Profile of a line", datums: true },
  { key: "profileSurface", label: "Profile of a surface", datums: true },
  { key: "perpendicularity", label: "Perpendicularity", datums: true },
  { key: "parallelism", label: "Parallelism", datums: true },
  { key: "angularity", label: "Angularity", datums: true },
  { key: "position", label: "Position", datums: true },
  { key: "concentricity", label: "Concentricity", datums: true },
  { key: "symmetry", label: "Symmetry", datums: true },
  { key: "runout", label: "Circular runout", datums: true },
  { key: "totalRunout", label: "Total runout", datums: true },
];

const TEXT = 3;
const CELL = 6;

const line = (pts: number[], style: "thin" | "visible" = "thin", extra: Partial<Extract<Prim, { kind: "path" }>> = {}): Prim => ({ kind: "path", points: pts, style, ...extra });
const circle = (cx: number, cy: number, r: number, n = 24): Prim => {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) pts.push(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n));
  return line(pts);
};
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 16): number[] => {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
};

/** A characteristic's sign, centred on (cx, cy), about 4 mm across. */
export function characteristicSign(c: GdtCharacteristic, cx: number, cy: number): Prim[] {
  const s = 2;
  const at = (pts: number[]) => pts.map((v, i) => v + (i % 2 ? cy : cx));
  switch (c) {
    case "straightness":
      return [line(at([-s, 0, s, 0]))];
    case "flatness":
      return [line(at([-s, -1.2, s - 0.8, -1.2, s, 1.2, -s + 0.8, 1.2]), "thin", { closed: true })];
    case "circularity":
      return [circle(cx, cy, 1.6)];
    case "cylindricity":
      return [circle(cx, cy, 1.3), line(at([-2.2, -1.8, -0.4, 1.8])), line(at([0.4, -1.8, 2.2, 1.8]))];
    case "profileLine":
      return [line(at(arc(0, -1, 1.9, 0, Math.PI)))];
    case "profileSurface":
      return [line(at([...arc(0, -1, 1.9, 0, Math.PI), 1.9, -1]), "thin", { closed: true })];
    case "perpendicularity":
      return [line(at([0, -1.8, 0, 1.8])), line(at([-s, -1.8, s, -1.8]))];
    case "parallelism":
      return [line(at([-1.8, -1.8, -0.4, 1.8])), line(at([0.4, -1.8, 1.8, 1.8]))];
    case "angularity":
      return [line(at([s, -1.6, -s, -1.6, s, 1.8]))];
    case "position":
      return [circle(cx, cy, 1.3), line(at([-s, 0, s, 0])), line(at([0, -s, 0, s]))];
    case "concentricity":
      return [circle(cx, cy, 0.8), circle(cx, cy, 1.8)];
    case "symmetry":
      return [line(at([-1.2, 1, 1.2, 1])), line(at([-s, 0, s, 0])), line(at([-1.2, -1, 1.2, -1]))];
    case "runout":
      return [line(at([-1.4, -1.8, 1.4, 1.8])), line(at([1.4, 1.8, 0.2, 1.4, 1.4, 1.8, 1.2, 0.6]))];
    case "totalRunout":
      return [line(at([-1.8, -1.8, 0.6, 1.8])), line(at([0.6, 1.8, -0.4, 1.3, 0.6, 1.8, 0.6, 0.6])), line(at([-1.8, -1.8, 1.4, -1.8])), line(at([1.4, -1.8, 2.2, 1.0]))];
  }
}

const textWidth = (t: string) => t.length * TEXT * 0.62;

/** A symbol's drawing: its shapes and the box round it (for picking), with `at` as its top-left corner. */
export function symbolPrims(note: Pick<DrawingNote, "at" | "leader">, symbol: DrawingSymbol): { prims: Prim[]; box: [number, number, number, number]; anchor: P2 } {
  const [x, y] = note.at;
  const prims: Prim[] = [];
  let box: [number, number, number, number];
  // Where the leader leaves the symbol.
  let anchor: P2;
  if (symbol.kind === "datum") {
    const s = 6;
    prims.push(line([x, y, x + s, y, x + s, y - s, x, y - s], "thin", { closed: true }));
    prims.push({ kind: "text", x: x + s / 2, y: y - s / 2 - 1.2, text: symbol.letter, size: 3.5, anchor: "middle" });
    anchor = [x + s / 2, y - s];
    box = [x, y - s, x + s, y];
    // The triangle sits where the leader ends (or just under the box).
    const tip: P2 = note.leader ?? [x + s / 2, y - s - 4];
    const dx = tip[0] - anchor[0];
    const dy = tip[1] - anchor[1];
    const l = Math.hypot(dx, dy) || 1;
    const u: P2 = [dx / l, dy / l];
    const n: P2 = [-u[1], u[0]];
    const base: P2 = [tip[0] - u[0] * 2.6, tip[1] - u[1] * 2.6];
    prims.push(line([anchor[0], anchor[1], base[0], base[1]]));
    prims.push(line([tip[0] + n[0] * 1.6, tip[1] + n[1] * 1.6, tip[0] - n[0] * 1.6, tip[1] - n[1] * 1.6, base[0], base[1]], "thin", { closed: true, fill: true }));
    return { prims, box, anchor };
  }
  if (symbol.kind === "fcf") {
    const tol = `${symbol.diameter ? "Ø" : ""}${symbol.tolerance || "0"}`;
    const datums = symbol.datums.filter((d) => d.trim());
    const widths = [CELL + 1, Math.max(CELL + 2, textWidth(tol) + 3), ...datums.map((d) => Math.max(CELL, textWidth(d) + 2.5))];
    const total = widths.reduce((a, b) => a + b, 0);
    prims.push(line([x, y, x + total, y, x + total, y - CELL, x, y - CELL], "thin", { closed: true }));
    let cx = x;
    widths.forEach((w, i) => {
      if (i > 0) prims.push(line([cx, y, cx, y - CELL]));
      const mid = cx + w / 2;
      if (i === 0) prims.push(...characteristicSign(symbol.characteristic, mid, y - CELL / 2));
      else prims.push({ kind: "text", x: mid, y: y - CELL / 2 - 1.05, text: i === 1 ? tol : datums[i - 2], size: TEXT, anchor: "middle" });
      cx += w;
    });
    box = [x, y - CELL, x + total, y];
    anchor = [x, y - CELL / 2];
  } else {
    // Surface finish: the tick (with a bar across when material is to be removed by machining) and the roughness.
    const h = 4.5;
    const v: P2 = [x + 3, y - 8];
    const left: P2 = [v[0] - h * 0.58, v[1] + h];
    const top: P2 = [v[0] + 2 * h * 0.58, v[1] + 2 * h];
    prims.push(line([left[0], left[1], v[0], v[1], top[0], top[1]]));
    if (symbol.machined !== false) prims.push(line([left[0], left[1], v[0] + h * 0.58, left[1]]));
    const label = symbol.ra ? `Ra ${symbol.ra}` : "";
    const end = top[0] + Math.max(6, textWidth(label) + 1);
    prims.push(line([top[0], top[1], end, top[1]]));
    if (label) prims.push({ kind: "text", x: top[0] + 0.8, y: top[1] - 3.4, text: label, size: TEXT, anchor: "start" });
    box = [left[0], v[1], end, top[1]];
    anchor = v;
  }
  if (note.leader) {
    const [lx, ly] = note.leader;
    // From the nearest side of the symbol, with an arrowhead where it points.
    const from: P2 = symbol.kind === "fcf" ? (lx > (box[0] + box[2]) / 2 ? [box[2], anchor[1]] : anchor) : anchor;
    const dx = lx - from[0];
    const dy = ly - from[1];
    const l = Math.hypot(dx, dy) || 1;
    const u: P2 = [dx / l, dy / l];
    const n: P2 = [-u[1], u[0]];
    prims.push(line([from[0], from[1], lx, ly]));
    if (symbol.kind === "fcf") prims.push(line([lx, ly, lx - u[0] * 2.5 + n[0] * 0.8, ly - u[1] * 2.5 + n[1] * 0.8, lx - u[0] * 2.5 - n[0] * 0.8, ly - u[1] * 2.5 - n[1] * 0.8], "thin", { closed: true, fill: true }));
  }
  return { prims, box, anchor };
}

/** Plain-English summary for lists and tooltips. */
export function describeSymbol(s: DrawingSymbol): string {
  if (s.kind === "datum") return `Datum ${s.letter}`;
  if (s.kind === "finish") return s.ra ? `Surface finish Ra ${s.ra}` : "Surface finish";
  const c = GDT_CHARACTERISTICS.find((x) => x.key === s.characteristic)?.label ?? s.characteristic;
  const datums = s.datums.filter((d) => d.trim());
  return `${c} ${s.diameter ? "Ø" : ""}${s.tolerance}${datums.length ? ` to ${datums.join(", ")}` : ""}`;
}

/** The next datum letter not used yet on the drawing (A, B, C…; I, O and Q are skipped, as is usual). */
export function nextDatumLetter(notes: readonly DrawingNote[] = []): string {
  const used = new Set(notes.map((n) => (n.symbol?.kind === "datum" ? n.symbol.letter : "")));
  for (const c of "ABCDEFGHJKLMNPRSTUVWXYZ") if (!used.has(c)) return c;
  return "A";
}
