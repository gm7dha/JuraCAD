/**
 * Words in library designs (a stencil's letters, a stamp's lines, a name on a
 * tag): placed as ordinary sketch Text (src/sketch/sketchText.ts), so they can
 * be changed in the sketch afterwards like any text, and measured with the
 * very same letter outlines the sketch will draw.
 */
import { FONTS, FONT_LABELS, type FontName } from "../geometry/fonts";
import { textOutlines } from "../geometry/text";
import { sketchId } from "../sketch/ops";
import { textContours } from "../sketch/sketchText";
import { ORIGIN_ID, type SketchConstraint, type SketchData, type SketchText } from "../sketch/types";
import { lit } from "./ex";
import { placeFromOrigin } from "./sketchKit";
import type { DesignInput, DesignValues } from "./types";

type Pt = [number, number];

/** The library's font choice (the fonts sketch Text has). */
export const fontInput = (def: FontName = "bold"): DesignInput => ({
  key: "font",
  label: "Font",
  kind: "choice",
  default: def,
  choices: (Object.keys(FONT_LABELS) as FontName[]).map((f) => ({ value: f, label: FONT_LABELS[f] })),
});

export const fontOf = (values: DesignValues): FontName => (values.font === "regular" ? "regular" : "bold");

/** How tall a capital H is, as a share of the text size sketch Text uses (the font's full height). */
export function capShare(font: FontName): number {
  const f = FONTS[font] ?? FONTS.regular;
  const { contours } = textOutlines(f, "H", 100, 2);
  const ys = contours.flat().map((p) => p[1]);
  const h = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  return h > 1 ? h / 100 : 0.7;
}

/** The sketch Text size that makes capital letters `capHeight` mm tall. */
export const sizeForCaps = (font: FontName, capHeight: number) => Math.round((capHeight / capShare(font)) * 1e6) / 1e6;

/** The lines of a text value (blank ones left out). */
export const linesOf = (words: unknown): string[] =>
  String(words ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Letters the font hasn't got (they'd come out as "?"), for a plain message — or "". */
export function missingLetters(font: FontName, words: string): string {
  const f = FONTS[font] ?? FONTS.regular;
  // A stand-in font with no letters at all (as in some tests) can't be judged.
  if (!Object.keys(f.glyphs).length) return "";
  const missing = new Set<string>();
  for (const ch of Array.from(words)) if (ch.trim() && !f.glyphs[ch]) missing.add(ch);
  return [...missing].join(" ");
}

export interface TextBlock {
  /** Text with each capital `capHeight` tall. */
  font: FontName;
  capHeight: number;
  /** Lines, top to bottom, each centred on x = cx. */
  lines: string[];
  /** The middle of the block. */
  centre?: Pt;
  /** Line pitch as a share of the capital height (default 1.6). */
  pitch?: number;
  /** Flipped left to right, as on a stamp. */
  mirror?: boolean;
}

/** Where each line's middle goes (top line first). */
export function lineCentres(b: TextBlock): Pt[] {
  const [cx, cy] = b.centre ?? [0, 0];
  const step = b.capHeight * (b.pitch ?? 1.6);
  const n = b.lines.length;
  return b.lines.map((_, i) => [cx, cy + ((n - 1) / 2 - i) * step]);
}

/**
 * Add the block's lines to a sketch as Text, each hanging from its middle (anchor "centre") at a point dimensioned
 * from the origin — or from the origin itself.
 */
export function addTextBlock(s: SketchData, b: TextBlock): SketchData {
  const size = sizeForCaps(b.font, b.capHeight);
  const points = [...s.points];
  const constraints: SketchConstraint[] = [...s.constraints];
  const texts: SketchText[] = [...(s.texts ?? [])];
  lineCentres(b).forEach(([x, y], i) => {
    let anchor = ORIGIN_ID;
    if (Math.abs(x) > 1e-9 || Math.abs(y) > 1e-9) {
      anchor = sketchId("p");
      points.push({ id: anchor, x, y });
      constraints.push(...placeFromOrigin(anchor, lit(x), lit(y)));
    }
    texts.push({ id: sketchId("t"), anchor, value: b.lines[i], size, angle: 0, font: b.font, anchorAt: "centre", ...(b.mirror ? { mirror: true } : {}), construction: false });
  });
  return { ...s, points, constraints, texts };
}

/** The block's letter outlines (holes too), exactly as the sketch will draw them. */
export function blockContours(b: TextBlock): Pt[][] {
  const s = addTextBlock({ points: [], curves: [], constraints: [] }, b);
  return (s.texts ?? []).flatMap((t) => textContours(s, t));
}

/** The box round some outlines [x0, y0, x1, y1], or null when there are none. */
export function contoursBox(contours: Pt[][]): [number, number, number, number] | null {
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of contours) for (const [x, y] of c) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  return Number.isFinite(box[0]) ? box : null;
}

/** The area the letters cover (mm²): outlines minus their holes (even–odd). */
export function inkArea(contours: Pt[][]): number {
  let total = 0;
  contours.forEach((c, i) => {
    const depth = contours.filter((d, j) => j !== i && insidePolygon(c[0], d)).length;
    total += (depth % 2 === 0 ? 1 : -1) * Math.abs(signedArea(c));
  });
  return total;
}

export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
