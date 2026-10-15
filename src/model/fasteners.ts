/**
 * Standard metric fasteners (Onshape's standard content, for the common
 * sizes): hex bolts (ISO 4017), hex nuts (ISO 4032) and plain washers
 * (ISO 7089). Sizes in mm.
 */
export type FastenerKind = "bolt" | "nut" | "washer";

export interface FastenerSize {
  name: string;
  /** Nominal (thread) diameter. */
  d: number;
  pitch: number;
  /** Hex across the flats. */
  flats: number;
  /** Bolt head height. */
  head: number;
  /** Nut height. */
  nut: number;
  /** Washer hole, outside diameter and thickness. */
  washerHole: number;
  washerOd: number;
  washerThickness: number;
}

export const FASTENER_SIZES: FastenerSize[] = [
  { name: "M3", d: 3, pitch: 0.5, flats: 5.5, head: 2, nut: 2.4, washerHole: 3.2, washerOd: 7, washerThickness: 0.5 },
  { name: "M4", d: 4, pitch: 0.7, flats: 7, head: 2.8, nut: 3.2, washerHole: 4.3, washerOd: 9, washerThickness: 0.8 },
  { name: "M5", d: 5, pitch: 0.8, flats: 8, head: 3.5, nut: 4.7, washerHole: 5.3, washerOd: 10, washerThickness: 1 },
  { name: "M6", d: 6, pitch: 1, flats: 10, head: 4, nut: 5.2, washerHole: 6.4, washerOd: 12, washerThickness: 1.6 },
  { name: "M8", d: 8, pitch: 1.25, flats: 13, head: 5.3, nut: 6.8, washerHole: 8.4, washerOd: 16, washerThickness: 1.6 },
  { name: "M10", d: 10, pitch: 1.5, flats: 16, head: 6.4, nut: 8.4, washerHole: 10.5, washerOd: 20, washerThickness: 2 },
  { name: "M12", d: 12, pitch: 1.75, flats: 18, head: 7.5, nut: 10.8, washerHole: 13, washerOd: 24, washerThickness: 2.5 },
];

export const FASTENER_LABELS: Record<FastenerKind, string> = { bolt: "Hex bolt", nut: "Hex nut", washer: "Washer" };

export const fastenerSize = (name: string): FastenerSize | undefined => FASTENER_SIZES.find((s) => s.name === name);

/** A name for the part, e.g. "M6 × 20 hex bolt", "M6 hex nut", "M6 washer". */
export function fastenerName(kind: FastenerKind, size: string, length: number): string {
  if (kind === "bolt") return `${size} × ${Math.round(length * 100) / 100} hex bolt`;
  return kind === "nut" ? `${size} hex nut` : `${size} washer`;
}

/** Corners of a hexagon `flats` across the flats, centred on (x, y), flats parallel to X. */
export function hexagon(flats: number, x = 0, y = 0): [number, number][] {
  const r = flats / Math.sqrt(3);
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [x + r * Math.cos(a), y + r * Math.sin(a)];
  });
}
