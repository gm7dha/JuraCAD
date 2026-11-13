/**
 * Real Bambu Lab filament colours (pure), so a coloured puzzle's preview and files use the colours of the spools that
 * will be loaded: PLA Basic first, then PLA Matte, then PLA Silk+ — single colours only (no gradients or dual colours).
 *
 * Source: Bambu Studio's own filament colour list, resources/profiles/BBL/filament/filaments_color_codes.json in
 * github.com/bambulab/BambuStudio (master at 930fe93, 10 Nov 2026): each entry's English name (`fila_color_name.en`),
 * its colour (`fila_color`, the alpha dropped) and Bambu's colour code (`fila_color_code`), in the file's order.
 */

export type BambuLine = "PLA Basic" | "PLA Matte" | "PLA Silk+";

export interface BambuColour {
  /** Bambu's colour code (as on the spool's label, e.g. 10501). */
  code: string;
  line: BambuLine;
  name: string;
  /** "#rrggbb", lower case. */
  hex: string;
}

export const BAMBU_LINES: BambuLine[] = ["PLA Basic", "PLA Matte", "PLA Silk+"];

export const BAMBU_COLOURS: BambuColour[] = [
  { code: "10300", line: "PLA Basic", name: "Orange", hex: "#ff6a13" },
  { code: "10301", line: "PLA Basic", name: "Pumpkin Orange", hex: "#ff9016" },
  { code: "10602", line: "PLA Basic", name: "Blue Gray", hex: "#5b6579" },
  { code: "10604", line: "PLA Basic", name: "Cobalt Blue", hex: "#0056b8" },
  { code: "10605", line: "PLA Basic", name: "Turquoise", hex: "#00b1b7" },
  { code: "10603", line: "PLA Basic", name: "Cyan", hex: "#0086d6" },
  { code: "10601", line: "PLA Basic", name: "Blue", hex: "#0a2989" },
  { code: "10103", line: "PLA Basic", name: "Gray", hex: "#8e9089" },
  { code: "10102", line: "PLA Basic", name: "Silver", hex: "#a6a9aa" },
  { code: "10104", line: "PLA Basic", name: "Light Gray", hex: "#d1d3d5" },
  { code: "10105", line: "PLA Basic", name: "Dark Gray", hex: "#545454" },
  { code: "10502", line: "PLA Basic", name: "Mistletoe Green", hex: "#3f8e43" },
  { code: "10503", line: "PLA Basic", name: "Bright Green", hex: "#becf00" },
  { code: "10501", line: "PLA Basic", name: "Bambu Green", hex: "#00ae42" },
  { code: "10101", line: "PLA Basic", name: "Black", hex: "#000000" },
  { code: "10800", line: "PLA Basic", name: "Brown", hex: "#9d432c" },
  { code: "10802", line: "PLA Basic", name: "Cocoa Brown", hex: "#6f5034" },
  { code: "10201", line: "PLA Basic", name: "Beige", hex: "#f7e6de" },
  { code: "10203", line: "PLA Basic", name: "Pink", hex: "#f55a74" },
  { code: "10701", line: "PLA Basic", name: "Indigo Purple", hex: "#482960" },
  { code: "10700", line: "PLA Basic", name: "Purple", hex: "#5e43b7" },
  { code: "10202", line: "PLA Basic", name: "Magenta", hex: "#ec008c" },
  { code: "10200", line: "PLA Basic", name: "Red", hex: "#c12e1f" },
  { code: "10205", line: "PLA Basic", name: "Maroon Red", hex: "#9d2235" },
  { code: "10204", line: "PLA Basic", name: "Hot Pink", hex: "#f5547c" },
  { code: "10100", line: "PLA Basic", name: "Jade White", hex: "#ffffff" },
  { code: "10400", line: "PLA Basic", name: "Yellow", hex: "#f4ee2a" },
  { code: "10402", line: "PLA Basic", name: "Sunflower Yellow", hex: "#fec600" },
  { code: "10801", line: "PLA Basic", name: "Bronze", hex: "#847d48" },
  { code: "10401", line: "PLA Basic", name: "Gold", hex: "#e4bd68" },
  { code: "11300", line: "PLA Matte", name: "Mandarin Orange", hex: "#f99963" },
  { code: "11603", line: "PLA Matte", name: "Sky Blue", hex: "#56b7e6" },
  { code: "11600", line: "PLA Matte", name: "Marine Blue", hex: "#0078bf" },
  { code: "11601", line: "PLA Matte", name: "Ice Blue", hex: "#a3d8e1" },
  { code: "11602", line: "PLA Matte", name: "Dark Blue", hex: "#042f56" },
  { code: "11104", line: "PLA Matte", name: "Nardo Gray", hex: "#757575" },
  { code: "11102", line: "PLA Matte", name: "Ash Gray", hex: "#9b9ea0" },
  { code: "11502", line: "PLA Matte", name: "Apple Green", hex: "#c2e189" },
  { code: "11500", line: "PLA Matte", name: "Grass Green", hex: "#61c680" },
  { code: "11501", line: "PLA Matte", name: "Dark Green", hex: "#68724d" },
  { code: "11101", line: "PLA Matte", name: "Charcoal", hex: "#000000" },
  { code: "11802", line: "PLA Matte", name: "Dark Chocolate", hex: "#4d3324" },
  { code: "11800", line: "PLA Matte", name: "Latte Brown", hex: "#d3b7a7" },
  { code: "11801", line: "PLA Matte", name: "Dark Brown", hex: "#7d6556" },
  { code: "11803", line: "PLA Matte", name: "Caramel", hex: "#ae835b" },
  { code: "11201", line: "PLA Matte", name: "Sakura Pink", hex: "#e8afcf" },
  { code: "11700", line: "PLA Matte", name: "Lilac Purple", hex: "#ae96d4" },
  { code: "11200", line: "PLA Matte", name: "Scarlet Red", hex: "#de4343" },
  { code: "11203", line: "PLA Matte", name: "Terracotta", hex: "#b15533" },
  { code: "11204", line: "PLA Matte", name: "Plum", hex: "#950051" },
  { code: "11202", line: "PLA Matte", name: "Dark Red", hex: "#bb3d43" },
  { code: "11100", line: "PLA Matte", name: "Ivory White", hex: "#ffffff" },
  { code: "11103", line: "PLA Matte", name: "Bone White", hex: "#cbc6b8" },
  { code: "11400", line: "PLA Matte", name: "Lemon Yellow", hex: "#f7d959" },
  { code: "11401", line: "PLA Matte", name: "Desert Tan", hex: "#e8dbb7" },
  { code: "13603", line: "PLA Silk+", name: "Baby Blue", hex: "#a8c6ee" },
  { code: "13604", line: "PLA Silk+", name: "Blue", hex: "#008bda" },
  { code: "13108", line: "PLA Silk+", name: "Titan Gray", hex: "#5f6367" },
  { code: "13109", line: "PLA Silk+", name: "Silver", hex: "#c8c8c8" },
  { code: "13506", line: "PLA Silk+", name: "Candy Green", hex: "#018814" },
  { code: "13507", line: "PLA Silk+", name: "Mint", hex: "#96dcb9" },
  { code: "13702", line: "PLA Silk+", name: "Purple", hex: "#8671cb" },
  { code: "13205", line: "PLA Silk+", name: "Candy Red", hex: "#d02727" },
  { code: "13206", line: "PLA Silk+", name: "Rose Gold", hex: "#ba9594" },
  { code: "13207", line: "PLA Silk+", name: "Pink", hex: "#f7ada6" },
  { code: "13110", line: "PLA Silk+", name: "White", hex: "#ffffff" },
  { code: "13404", line: "PLA Silk+", name: "Champagne", hex: "#f3cfb2" },
  { code: "13405", line: "PLA Silk+", name: "Gold", hex: "#f4a925" },
];

/** A colour by its Bambu code. */
export const bambuColour = (code: string): BambuColour | undefined => BAMBU_COLOURS.find((c) => c.code === code);

/** The spool for a colour: the one chosen (by code) if it has that colour, else the first with it (PLA Basic first). */
export function spoolFor(hex: string, chosen?: string): BambuColour | undefined {
  const h = hex.toLowerCase();
  const c = chosen ? bambuColour(chosen) : undefined;
  if (c && c.hex === h) return c;
  return BAMBU_COLOURS.find((x) => x.hex === h);
}

/** "Bambu Green (PLA Basic)". */
export const spoolLabel = (c: BambuColour) => `${c.name} (${c.line})`;

/** A colour's hex by line and name, for the usual colour sets (throws if Bambu's list has no such colour). */
export function bambu(line: BambuLine, name: string): string {
  const c = BAMBU_COLOURS.find((x) => x.line === line && x.name === name);
  if (!c) throw new Error(`No ${line} ${name} in Bambu's list`);
  return c.hex;
}
