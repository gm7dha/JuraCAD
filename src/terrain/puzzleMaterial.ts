/**
 * The filament a puzzle is printed in (pure): "PLA" (the usual — Bambu Lab PLA Basic and Matte, the colours as they've
 * always been) or one of Bambu Lab's lines (PLA Matte, PETG HF, PETG Basic…). With a line chosen, the usual colours are
 * the nearest colours that line comes in (each spool named), and the breakaway layers' advice suits the material.
 *
 * Breakaway advice, from Bambu Lab:
 * - Support for PLA/PETG: "designed for seamless use with both PLA and PETG", for supports only (Bambu Lab store,
 *   https://jp.store.bambulab.com/en/products/support-for-pla-petg); Bambu Studio lists Support for PLA, Support for
 *   PLA/PETG and Support for ABS among its filaments (filaments_color_codes.json).
 * - PLA Basic and PETG HF "don't adhere very well with each other, making them a good option to use for support
 *   interface" (Bambu Lab wiki, https://wiki.bambulab.com/en/filament-acc/filament/pla-basic-and-petg-hf), so plain PLA
 *   Basic also works between PETG layers (warmer room: open the door, as PLA softens in an enclosed printer).
 */
import { BAMBU_COLOURS, coloursOfMaterial, materialOfLine, spoolFor, type BambuColour } from "./bambuColours";
import { GROUND_BROWN, LOWLAND_GREEN, PATH_RED, ROAD_BLACK, SEA_BLUE, SNOW_IVORY, UPLAND_GREY, WATER_BLUE } from "./colour";

/** "PLA" = the usual PLA Basic/Matte colours; else a Bambu Lab line ("PETG HF"…). */
export type PuzzleMaterial = string;

export const USUAL_MATERIAL: PuzzleMaterial = "PLA";

/**
 * The lines offered for a puzzle: solid colours only (no translucent, silk, sparkle, wood or fibre-filled lines), of the
 * materials there's breakaway advice for.
 */
export const MATERIAL_CHOICES: { material: string; lines: string[] }[] = [
  { material: "PLA", lines: ["PLA Basic", "PLA Matte"] },
  { material: "PETG", lines: ["PETG HF", "PETG Basic", "PETG Matte"] },
  { material: "ABS", lines: ["ABS"] },
  { material: "ASA", lines: ["ASA"] },
];

/** The material family of a choice ("PLA", "PETG"…). */
export const familyOf = (m: PuzzleMaterial): string => (m === USUAL_MATERIAL ? "PLA" : materialOfLine(m));

/** "PETG HF" or, for the usual, "PLA". */
export const materialName = (m: PuzzleMaterial) => (m === USUAL_MATERIAL ? "PLA (Basic and Matte)" : m);

const rgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** sRGB → CIE L*a*b* (D65). */
function lab(h: string): [number, number, number] {
  const lin = rgb(h.toLowerCase()).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * How different colour `b` looks from `a` (the one wanted): the CIE76 ΔE*ab with the difference in colourfulness and
 * hue counted 1.5 times, and a grey for a coloured `a` counted `GREY_FOR_COLOUR` further — so a dark green becomes a
 * green and a brown base stays a brown, not a grey of the same darkness.
 */
export function colourDistance(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  const grey = Math.hypot(a1, b1) > 8 && Math.hypot(a2, b2) < 5 ? GREY_FOR_COLOUR : 0;
  return Math.sqrt((l1 - l2) ** 2 + 2.25 * ((a1 - a2) ** 2 + (b1 - b2) ** 2)) + grey;
}

export const GREY_FOR_COLOUR = 30;

/** Further apart than this, a line's nearest colour is said not to be a close match. */
export const CLOSE_MATCH = 30;

/**
 * The usual colours, most telling first: each line's colours are handed out in this order, each a colour of its own where
 * the line has another close enough (so Lowland and Upland don't both become the same grey). The island's sea comes last
 * and may share the mountain's water colour (they're never in one window).
 */
const USUAL_ORDER = [ROAD_BLACK, SNOW_IVORY, PATH_RED, WATER_BLUE, LOWLAND_GREEN, UPLAND_GREY, GROUND_BROWN];
const assigned = new Map<string, Map<string, { c: BambuColour; d: number }>>();

function lineColours(m: PuzzleMaterial): BambuColour[] {
  return coloursOfMaterial(familyOf(m)).find((g) => g.line === m)?.colours ?? [];
}

/** Hue (degrees) and colourfulness of a colour, in L*a*b*. */
function hueOf(h: string): { hue: number; chroma: number } {
  const [, a, b] = lab(h);
  return { hue: (Math.atan2(b, a) * 180) / Math.PI, chroma: Math.hypot(a, b) };
}

/** Wanted colours more colourful than this look for their own hue first. */
export const COLOURED = 8;
/** A candidate of the same hue: within this many degrees… */
export const SAME_HUE = 20;

/**
 * Whether `b` is the same kind of colour as a coloured `a` (a green for a green): its hue within `SAME_HUE` degrees and
 * at least half as colourful. A muted green then becomes a lighter green rather than a tan of nearer lightness.
 */
export function sameHue(a: string, b: string): boolean {
  const x = hueOf(a);
  const y = hueOf(b);
  if (y.chroma < x.chroma / 2) return false;
  const apart = Math.abs(((y.hue - x.hue + 540) % 360) - 180);
  return apart <= SAME_HUE;
}

/**
 * The line's nearest colour to `hex`. A coloured `hex` takes the nearest of the same hue instead when there is one no more
 * than `HUE_ROOM` further off (a muted green → Avocado Green, not Caramel); else the nearest of any.
 */
function nearest(hex: string, colours: BambuColour[], skip: Set<string> = new Set()): { c: BambuColour; d: number } | undefined {
  const best = nearestOf(hex, colours, skip);
  if (!best || hueOf(hex).chroma <= COLOURED) return best;
  const alike = nearestOf(hex, colours.filter((c) => sameHue(hex, c.hex)), skip);
  return alike && alike.d <= best.d + HUE_ROOM ? alike : best;
}

/** How much further off a colour of the same hue may be and still be taken. */
export const HUE_ROOM = 15;

function nearestOf(hex: string, colours: BambuColour[], skip: Set<string>): { c: BambuColour; d: number } | undefined {
  let best: { c: BambuColour; d: number } | undefined;
  for (const c of colours) {
    if (skip.has(c.code)) continue;
    const d = colourDistance(hex, c.hex);
    if (!best || d < best.d) best = { c, d };
  }
  return best;
}

function usualIn(m: PuzzleMaterial): Map<string, { c: BambuColour; d: number }> {
  let out = assigned.get(m);
  if (out) return out;
  out = new Map();
  const colours = lineColours(m);
  const taken = new Set<string>();
  for (const u of USUAL_ORDER) {
    const own = nearest(u, colours);
    if (!own) continue;
    const free = nearest(u, colours, taken);
    const pick = free && free.d <= Math.max(CLOSE_MATCH, own.d * 1.5) ? free : own;
    taken.add(pick.c.code);
    out.set(u, pick);
  }
  const sea = nearest(SEA_BLUE, colours, new Set([...taken].filter((c) => c !== out!.get(WATER_BLUE)?.c.code)));
  if (sea) out.set(SEA_BLUE, sea);
  assigned.set(m, out);
  return out;
}

/** The colour of a line nearest `hex` (the usual material: `hex` itself), and whether it's a close match. */
export function inMaterial(hex: string, m: PuzzleMaterial): { hex: string; code?: string; spool?: BambuColour; close: boolean } {
  if (m === USUAL_MATERIAL) return { hex, close: true };
  const best = usualIn(m).get(hex.toLowerCase()) ?? nearest(hex, lineColours(m));
  if (!best) return { hex, close: true };
  return { hex: best.c.hex, code: best.c.code, spool: best.c, close: best.d <= CLOSE_MATCH };
}

/** The usual colours of a puzzle window (each band's, by place, then the base, water, paths and roads). */
export interface UsualColours {
  bands: string[];
  base: string | null;
  water: string | null;
  paths: string | null;
  roads: string | null;
}

/**
 * A colour spec's colours moved from material `from` to `to`: each colour still the usual one for `from` (by place)
 * becomes the usual one for `to`; colours picked by hand stay. Spools are recorded for the new ones (several lines share
 * a colour). Works on any object with these colour fields (a ColourSpec).
 */
export function changeMaterial<
  S extends { bands: { colour: string }[]; base: string | null; water: string | null; paths?: string | null; roads?: string | null; spools?: Record<string, string> },
>(spec: S, usual: UsualColours, from: PuzzleMaterial, to: PuzzleMaterial, usualSpools: Readonly<Record<string, string>> = {}): S {
  if (from === to) return spec;
  const spools: Record<string, string> = { ...spec.spools };
  const move = (now: string | null | undefined, u: string | null): string | null | undefined => {
    if (!now || !u) return now;
    const next = inMaterial(u, to);
    // Already the new material's usual colour (made so before the change was seen): just name its spool.
    if (next.code && now.toLowerCase() === next.hex.toLowerCase() && !spec.spools?.[now.toLowerCase()]) {
      spools[next.hex.toLowerCase()] = next.code;
      return now;
    }
    const was = inMaterial(u, from);
    const same = now.toLowerCase() === was.hex.toLowerCase() && (!was.code || (spec.spools?.[now.toLowerCase()] ?? was.code) === was.code);
    if (!same) return now;
    if (was.code && spools[was.hex.toLowerCase()] === was.code) delete spools[was.hex.toLowerCase()];
    if (next.code) spools[next.hex.toLowerCase()] = next.code;
    else if (to === USUAL_MATERIAL) {
      const code = usualSpools[u.toLowerCase()];
      if (code) spools[u.toLowerCase()] = code;
      else delete spools[u.toLowerCase()];
    }
    return next.hex;
  };
  const bands = spec.bands.map((b, i) => ({ ...b, colour: move(b.colour, usual.bands[i] ?? null) ?? b.colour }));
  const out = { ...spec, bands, base: move(spec.base, usual.base) ?? null, water: move(spec.water, usual.water) ?? null };
  if ("paths" in spec) (out as S).paths = move(spec.paths, usual.paths) ?? null;
  if ("roads" in spec) (out as S).roads = move(spec.roads, usual.roads) ?? null;
  return { ...out, spools: Object.keys(spools).length ? spools : undefined };
}

/**
 * Notes for the usual colours in a line: ones it has nothing close to, and two that land on the same spool (they then
 * print in one filament, and look the same).
 */
export function matchNotes(usual: { name: string; hex: string }[], m: PuzzleMaterial): string[] {
  if (m === USUAL_MATERIAL) return [];
  const out: string[] = [];
  const bySpool = new Map<string, string[]>();
  for (const u of usual) {
    const r = inMaterial(u.hex, m);
    if (!r.spool) continue;
    if (!r.close) {
      const usualSpool = spoolFor(u.hex);
      const was = usualSpool?.name ?? u.hex;
      // The line's colour of the same name (PETG Matte's Cyan for PLA Basic's Cyan) is another shade: say so plainly.
      if (usualSpool && r.spool.name === usualSpool.name)
        out.push(`${m}'s ${r.spool.name} is used for ${u.name}, a different shade from the usual ${was} (${usualSpool.line}) — pick another if you like.`);
      else out.push(`${m} has no colour close to the usual ${was} for ${u.name}: ${r.spool.name} is used — pick another if you like.`);
    }
    const names = bySpool.get(r.spool.code) ?? [];
    if (!names.includes(u.name)) names.push(u.name);
    bySpool.set(r.spool.code, names);
  }
  for (const [code, names] of bySpool)
    if (names.length > 1) {
      const c = usual.length ? inMaterialName(code) : code;
      out.push(`In ${m}, ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} become ${c}, so they print in one filament and look the same — pick another colour for one if you like.`);
    }
  return out;
}

const inMaterialName = (code: string) => BAMBU_COLOURS.find((c) => c.code === code)?.name ?? code;

/** What to load for the breakaway layers, for the puzzle's material. */
export function breakawayAdvice(m: PuzzleMaterial): { filament: string; words: string } {
  const family = familyOf(m);
  if (family === "PETG")
    return {
      filament: "Support for PLA/PETG",
      words:
        "Load Bambu's Support for PLA/PETG, which Bambu makes to come away cleanly from both PLA and PETG. Plain PLA Basic works too: Bambu's own guide uses PLA Basic between PETG HF layers, as the two don't stick well to each other (open the printer's door, as PLA softens in a warm enclosed printer).",
    };
  if (family === "ABS" || family === "ASA")
    return { filament: "Support for ABS", words: `Load Bambu's Support for ABS: Support for PLA/PETG isn't made for ${family}.` };
  return {
    filament: "Support for PLA",
    words: "Load Bambu's Support for PLA (or Support for PLA/PETG), which doesn't stick to PLA.",
  };
}
