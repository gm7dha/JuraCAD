/**
 * Standard metric fasteners (Onshape's standard content, for the common
 * sizes): hex bolts (ISO 4017), socket cap screws (ISO 4762), button head
 * screws (ISO 7380), countersunk socket screws (ISO 10642), pan head screws
 * with a cross recess (ISO 7045), grub screws (ISO 4026), hex nuts (ISO 4032)
 * and plain washers (ISO 7089). Sizes in mm.
 */
export type FastenerKind = "bolt" | "socketCap" | "buttonHead" | "countersunk" | "panHead" | "grub" | "nut" | "washer";

/** A head: its diameter and height, and the hex key socket (across flats, depth) or cross recess in it. */
export interface HeadSize {
  dk: number;
  k: number;
  s?: number;
  t?: number;
}

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
  socketCap: HeadSize;
  buttonHead: HeadSize;
  countersunk: HeadSize;
  panHead: HeadSize;
  /** Grub screw: the hex key socket in its end. */
  grub: { s: number; t: number };
}

export const FASTENER_SIZES: FastenerSize[] = [
  {
    name: "M3", d: 3, pitch: 0.5, flats: 5.5, head: 2, nut: 2.4, washerHole: 3.2, washerOd: 7, washerThickness: 0.5,
    socketCap: { dk: 5.5, k: 3, s: 2.5, t: 1.3 }, buttonHead: { dk: 5.7, k: 1.65, s: 2, t: 1.04 }, countersunk: { dk: 6, k: 1.7, s: 2, t: 1.1 }, panHead: { dk: 6, k: 2.4 }, grub: { s: 1.5, t: 1.2 },
  },
  {
    name: "M4", d: 4, pitch: 0.7, flats: 7, head: 2.8, nut: 3.2, washerHole: 4.3, washerOd: 9, washerThickness: 0.8,
    socketCap: { dk: 7, k: 4, s: 3, t: 2 }, buttonHead: { dk: 7.6, k: 2.2, s: 2.5, t: 1.3 }, countersunk: { dk: 8, k: 2.3, s: 2.5, t: 1.5 }, panHead: { dk: 8, k: 3.1 }, grub: { s: 2, t: 1.6 },
  },
  {
    name: "M5", d: 5, pitch: 0.8, flats: 8, head: 3.5, nut: 4.7, washerHole: 5.3, washerOd: 10, washerThickness: 1,
    socketCap: { dk: 8.5, k: 5, s: 4, t: 2.5 }, buttonHead: { dk: 9.5, k: 2.75, s: 3, t: 1.56 }, countersunk: { dk: 10, k: 2.8, s: 3, t: 1.9 }, panHead: { dk: 10, k: 3.8 }, grub: { s: 2.5, t: 2 },
  },
  {
    name: "M6", d: 6, pitch: 1, flats: 10, head: 4, nut: 5.2, washerHole: 6.4, washerOd: 12, washerThickness: 1.6,
    socketCap: { dk: 10, k: 6, s: 5, t: 3 }, buttonHead: { dk: 10.5, k: 3.3, s: 4, t: 2.08 }, countersunk: { dk: 12, k: 3.3, s: 4, t: 2.2 }, panHead: { dk: 12, k: 4.6 }, grub: { s: 3, t: 2.4 },
  },
  {
    name: "M8", d: 8, pitch: 1.25, flats: 13, head: 5.3, nut: 6.8, washerHole: 8.4, washerOd: 16, washerThickness: 1.6,
    socketCap: { dk: 13, k: 8, s: 6, t: 4 }, buttonHead: { dk: 14, k: 4.4, s: 5, t: 2.6 }, countersunk: { dk: 16, k: 4.4, s: 5, t: 3 }, panHead: { dk: 16, k: 6 }, grub: { s: 4, t: 3.2 },
  },
  {
    name: "M10", d: 10, pitch: 1.5, flats: 16, head: 6.4, nut: 8.4, washerHole: 10.5, washerOd: 20, washerThickness: 2,
    socketCap: { dk: 16, k: 10, s: 8, t: 5 }, buttonHead: { dk: 17.5, k: 5.5, s: 6, t: 3.12 }, countersunk: { dk: 20, k: 5.5, s: 6, t: 3.6 }, panHead: { dk: 20, k: 7.5 }, grub: { s: 5, t: 4 },
  },
  {
    name: "M12", d: 12, pitch: 1.75, flats: 18, head: 7.5, nut: 10.8, washerHole: 13, washerOd: 24, washerThickness: 2.5,
    socketCap: { dk: 18, k: 12, s: 10, t: 6 }, buttonHead: { dk: 21, k: 6.6, s: 8, t: 4.16 }, countersunk: { dk: 24, k: 6.5, s: 8, t: 4.3 }, panHead: { dk: 24, k: 9 }, grub: { s: 6, t: 4.8 },
  },
];

export const FASTENER_KINDS: FastenerKind[] = ["bolt", "socketCap", "buttonHead", "countersunk", "panHead", "grub", "nut", "washer"];

export const FASTENER_LABELS: Record<FastenerKind, string> = {
  bolt: "Hex bolt",
  socketCap: "Socket cap screw (Allen key)",
  buttonHead: "Button head screw (Allen key)",
  countersunk: "Countersunk screw (Allen key)",
  panHead: "Pan head screw (cross)",
  grub: "Grub screw (Allen key)",
  nut: "Hex nut",
  washer: "Washer",
};

/** Short names for parts, e.g. "M6 × 20 socket cap screw". */
const PART_NAMES: Record<FastenerKind, string> = {
  bolt: "hex bolt",
  socketCap: "socket cap screw",
  buttonHead: "button head screw",
  countersunk: "countersunk screw",
  panHead: "pan head screw",
  grub: "grub screw",
  nut: "hex nut",
  washer: "washer",
};

/** Kinds with a length (bolts and screws). */
export const hasLength = (kind: FastenerKind) => kind !== "nut" && kind !== "washer";

export const fastenerSize = (name: string): FastenerSize | undefined => FASTENER_SIZES.find((s) => s.name === name);

/** A name for the part, e.g. "M6 × 20 hex bolt", "M6 hex nut", "M6 washer". */
export function fastenerName(kind: FastenerKind, size: string, length: number): string {
  return hasLength(kind) ? `${size} × ${Math.round(length * 100) / 100} ${PART_NAMES[kind]}` : `${size} ${PART_NAMES[kind]}`;
}

/** Corners of a hexagon `flats` across the flats, centred on (x, y), flats parallel to X. */
export function hexagon(flats: number, x = 0, y = 0): [number, number][] {
  const r = flats / Math.sqrt(3);
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [x + r * Math.cos(a), y + r * Math.sin(a)];
  });
}

/**
 * Where a screw's threaded shank is, relative to its reference point (the
 * middle of the bearing face): from `top` down for `length`. Countersunk
 * screws are measured overall (their head is part of the length); grub
 * screws are all shank.
 */
export function shankOf(kind: FastenerKind, s: FastenerSize, length: number): { top: number; length: number } {
  if (kind === "countersunk") return { top: -s.countersunk.k, length: length - s.countersunk.k };
  return { top: 0, length };
}
