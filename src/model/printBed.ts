/**
 * 3D printers' build volumes, for the print bed preview: does the part fit,
 * and if not, by how much is it too big (and would turning it a quarter turn help)?
 * Sizes are the usual printable area in mm (X × Y × Z).
 */
export interface Printer {
  id: string;
  name: string;
  /** The usual build volume (with the main nozzle, for a printer with two). */
  size: [number, number, number];
  /** Two nozzles: the room both reach, for a print using the second nozzle or both (two colours or materials). */
  bothNozzles?: [number, number, number];
  /** A line about the printer for its description (e.g. how two nozzles change the room). */
  note?: string;
}

export const PRINTERS: Printer[] = [
  { id: "bambu-x1", name: "Bambu Lab X1 / P1 series", size: [256, 256, 256] },
  { id: "bambu-a1", name: "Bambu Lab A1", size: [256, 256, 256] },
  { id: "bambu-a1-mini", name: "Bambu Lab A1 mini", size: [180, 180, 180] },
  { id: "bambu-h2d", name: "Bambu Lab H2D", size: [325, 320, 325] },
  {
    // From 3D Printing Industry's launch article: 256 × 256 × 260 with the main nozzle; 235.5 × 256 × 256 for the
    // second nozzle and for both together. Nozzles up to 300 °C, a heated chamber up to 65 °C.
    id: "bambu-x2d",
    name: "Bambu Lab X2D",
    size: [256, 256, 260],
    bothNozzles: [235.5, 256, 256],
    note: "Two nozzles: 256 × 256 × 260 mm with the main nozzle; 235.5 × 256 × 256 mm with the second nozzle or both (two colours). Nozzles up to 300 °C, heated chamber up to 65 °C.",
  },
  {
    // From 3DPrinting.com's launch news (on sale 3 November 2026): 330 × 320 × 325 mm, full colour by mixing CMYKW.
    id: "bambu-h3c",
    name: "Bambu Lab H3C",
    size: [330, 320, 325],
    note: "Full colour: Bambu Studio mixes cyan, magenta, yellow, black and white (CMYKW) filaments to print the colours of a full-colour file (choose Colour: Full colour in the puzzle windows).",
  },
  { id: "prusa-mk4", name: "Prusa MK4 / MK4S", size: [250, 210, 220] },
  { id: "prusa-mini", name: "Prusa MINI+", size: [180, 180, 180] },
  { id: "prusa-xl", name: "Prusa XL", size: [360, 360, 360] },
  { id: "prusa-core-one", name: "Prusa CORE One", size: [250, 220, 270] },
  { id: "ender-3", name: "Creality Ender-3 (V2 / V3 SE)", size: [220, 220, 250] },
  { id: "creality-k1", name: "Creality K1 / K1C", size: [220, 220, 250] },
  { id: "creality-k1-max", name: "Creality K1 Max", size: [300, 300, 300] },
  { id: "anycubic-kobra-2", name: "Anycubic Kobra 2", size: [220, 220, 250] },
  { id: "elegoo-neptune-4", name: "Elegoo Neptune 4 / 4 Pro", size: [225, 225, 265] },
  { id: "voron-2.4-350", name: "Voron 2.4 (350)", size: [350, 350, 340] },
];

export const CUSTOM_PRINTER = "custom";

/** A printer's build volume (custom: the size given, else a usual 220 mm cube). */
export function bedSize(printer: string, custom?: [number, number, number]): [number, number, number] {
  if (printer === CUSTOM_PRINTER) return custom ?? [220, 220, 250];
  return PRINTERS.find((p) => p.id === printer)?.size ?? PRINTERS[0].size;
}

/** The printer by its id (undefined for a custom printer or an unknown id). */
export function printerOf(printer: string): Printer | undefined {
  return PRINTERS.find((p) => p.id === printer);
}

/**
 * For a two-nozzle printer, what to say about a part that fits with the main
 * nozzle but not where both nozzles reach (null: nothing to say).
 */
export function bothNozzlesNote(printer: string, part: [number, number, number]): string | null {
  const p = printerOf(printer);
  if (!p?.bothNozzles) return null;
  if (!bedFit(part, p.size).fits && !bedFit(part, p.size).fitsTurned) return null;
  const both = bedFit(part, p.bothNozzles);
  if (both.fits) return null;
  const room = p.bothNozzles.join(" × ");
  return both.fitsTurned
    ? `With the second nozzle or both (two colours) the room is ${room} mm: turn it a quarter turn to fit.`
    : `It fits with the main nozzle only: with the second nozzle or both (two colours) the room is ${room} mm.`;
}

export interface BedFit {
  fits: boolean;
  /** How much too big along X, Y and Z (0 where it fits). */
  over: [number, number, number];
  /** It doesn't fit as it is, but would if turned a quarter turn about Z. */
  fitsTurned: boolean;
}

/** Does a part this size (X × Y × Z mm) fit in the build volume? */
export function bedFit(part: [number, number, number], bed: [number, number, number]): BedFit {
  const tol = 1e-6;
  const over = part.map((v, i) => Math.max(0, v - bed[i])) as [number, number, number];
  const fits = over.every((v) => v <= tol);
  const fitsTurned = !fits && part[1] <= bed[0] + tol && part[0] <= bed[1] + tol && part[2] <= bed[2] + tol;
  return { fits, over: over.map((v) => (v <= tol ? 0 : v)) as [number, number, number], fitsTurned };
}
