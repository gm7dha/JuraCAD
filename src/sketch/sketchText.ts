/**
 * Text and pictures in a sketch.
 *
 * Text (Onshape's sketch Text tool): each text hangs from a point of the
 * sketch (its anchor), so it can be dimensioned and constrained like any
 * point; its letters' outlines are closed shapes that Extrude, Revolve and the
 * area picker use like any other (see regions.ts and areas.ts). The words,
 * size, turn and font can be changed at any time.
 *
 * Pictures are laid on the sketch plane to trace over; they never make shapes.
 *
 * Texts and pictures are kept in `SketchData.texts` / `.images`, which older
 * sketches don't have. Many sketch edits build a fresh sketch from its points,
 * curves and constraints only, so `keepSketchExtras` carries them across.
 *
 * All positions are sketch millimetres.
 */
import { FONTS } from "../geometry/fonts";
import { evaluate } from "../model/expr";
import { textOutlines } from "../geometry/text";
import { addPoint, curvePoints, deleteItems, pointPos, sketchId, type EditResult, type Placed } from "./ops";
import type { SketchData, SketchImage, SketchText } from "./types";

type Pt = [number, number];

export const textsOf = (s: SketchData): SketchText[] => s.texts ?? [];
export const imagesOf = (s: SketchData): SketchImage[] => s.images ?? [];
export const textById = (s: SketchData, id: string) => s.texts?.find((t) => t.id === id);
export const imageById = (s: SketchData, id: string) => s.images?.find((m) => m.id === id);

/** The settings for a new text (the sketch panel's boxes). */
export interface TextSettings {
  value: string;
  size: number;
  angle: number;
  font: SketchText["font"];
  anchorAt: NonNullable<SketchText["anchorAt"]>;
}

export const DEFAULT_TEXT: TextSettings = { value: "Text", size: 10, angle: 0, font: "regular", anchorAt: "start" };

/** The Text tool's boxes as typed (size and turn may be sums or variables). */
export interface TypedTextSettings {
  textValue?: string;
  textSize?: string;
  textAngle?: string;
  textFont?: TextSettings["font"];
  textAnchorAt?: TextSettings["anchorAt"];
}

/** The Text tool's settings from what's typed in the sketch panel, or a problem in plain English. */
export function readTextSettings(o: TypedTextSettings): TextSettings | string {
  const num = (text: string | undefined, fallback: number): number | null => {
    if (text === undefined || text.trim() === "") return fallback;
    const r = evaluate(text);
    return r.ok && Number.isFinite(r.value) ? r.value : null;
  };
  const size = num(o.textSize, DEFAULT_TEXT.size);
  const angle = num(o.textAngle, DEFAULT_TEXT.angle);
  if (size === null) return "The text size must be a number (mm).";
  if (angle === null) return "The turn must be a number of degrees.";
  return { value: o.textValue ?? DEFAULT_TEXT.value, size, angle, font: o.textFont ?? DEFAULT_TEXT.font, anchorAt: o.textAnchorAt ?? DEFAULT_TEXT.anchorAt };
}

interface LocalText {
  /** Each letter outline, relative to the anchor before turning. */
  contours: Pt[][];
  /** The box round the text (x0, y0, x1, y1), relative to the anchor before turning. */
  box: [number, number, number, number];
}

/** Worked-out text, per font (so a font swapped in by a test isn't mixed up with the real one). */
const localCaches = new WeakMap<object, Map<string, LocalText>>();

/** The text's outlines and box as if its anchor were at (0, 0) and it weren't turned. */
function localText(t: Pick<SketchText, "value" | "size" | "font" | "anchorAt">): LocalText {
  const font = FONTS[t.font] ?? FONTS.regular;
  let localCache = localCaches.get(font);
  if (!localCache) localCaches.set(font, (localCache = new Map()));
  const key = `${t.size}|${t.anchorAt ?? "start"}|${t.value}`;
  const known = localCache.get(key);
  if (known) return known;
  const { contours, width } = t.size > 0 ? textOutlines(font, t.value, t.size, 6) : { contours: [] as Pt[][], width: 0 };
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of contours)
    for (const [x, y] of c) {
      box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    }
  // Nothing to draw (spaces, or no letters the font has): a box the size of the text anyway, so it can still be clicked.
  if (!Number.isFinite(box[0])) box = [0, 0, Math.max(width, t.size), Math.max(t.size, 0)];
  let shift: Pt = [0, 0];
  if (t.anchorAt === "centre") shift = [-(box[0] + box[2]) / 2, -(box[1] + box[3]) / 2];
  const out: LocalText = {
    contours: contours.map((c) => c.map(([x, y]): Pt => [x + shift[0], y + shift[1]])),
    box: [box[0] + shift[0], box[1] + shift[1], box[2] + shift[0], box[3] + shift[1]],
  };
  if (localCache.size >= 500) localCache.clear();
  localCache.set(key, out);
  return out;
}

/** Turn by the text's angle and move to its anchor. */
function placer(s: SketchData, t: SketchText): (p: Pt) => Pt {
  const [ax, ay] = pointPos(s, t.anchor);
  const a = ((t.angle || 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const n = Math.sin(a);
  return ([x, y]) => [ax + x * c - y * n, ay + x * n + y * c];
}

/** The closed outlines of a text's letters (holes too, such as the inside of an "o"), in sketch mm. */
export function textContours(s: SketchData, t: SketchText): Pt[][] {
  if (!s.points.some((p) => p.id === t.anchor) && t.anchor !== "origin") return [];
  const place = placer(s, t);
  return localText(t).contours.map((c) => c.map(place));
}

/** The four corners of the box round a text (anticlockwise from bottom-left), in sketch mm. */
export function textBox(s: SketchData, t: SketchText): Pt[] {
  const place = placer(s, t);
  const [x0, y0, x1, y1] = localText(t).box;
  return [place([x0, y0]), place([x1, y0]), place([x1, y1]), place([x0, y1])];
}

/** Ids the pieces of a text's outlines go by in areas (one per letter outline). */
export const textPieceId = (t: SketchText, k: number) => `${t.id}.${k}`;

/** The text whose box is under (x, y) (within `tol` of it), or null. The smallest wins when boxes overlap. */
export function textAt(s: SketchData, x: number, y: number, tol: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const t of textsOf(s)) {
    if (!s.points.some((p) => p.id === t.anchor) && t.anchor !== "origin") continue;
    const a = ((t.angle || 0) * Math.PI) / 180;
    const [ax, ay] = pointPos(s, t.anchor);
    // Into the text's own directions.
    const dx = x - ax;
    const dy = y - ay;
    const u = dx * Math.cos(a) + dy * Math.sin(a);
    const v = -dx * Math.sin(a) + dy * Math.cos(a);
    const [x0, y0, x1, y1] = localText(t).box;
    if (u < x0 - tol || u > x1 + tol || v < y0 - tol || v > y1 + tol) continue;
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      bestArea = area;
      best = t.id;
    }
  }
  return best;
}

/** A plain-English problem with text settings, or null when they're fine. */
export function textProblem(t: Partial<TextSettings>): string | null {
  if (t.value !== undefined && !t.value.trim()) return "Type some text first (in the sketch panel).";
  if (t.size !== undefined && !(t.size > 0 && t.size <= 10000)) return "The text size must be more than 0 mm.";
  if (t.angle !== undefined && !Number.isFinite(t.angle)) return "The turn must be a number of degrees.";
  return null;
}

/** Put text in the sketch, hanging from the clicked point (snapped like any point). */
export function addText(s: SketchData, at: Placed, settings: TextSettings, construction = false): EditResult & { textId: string } {
  const problem = textProblem(settings);
  if (problem) return { sketch: s, textId: "", error: problem };
  const r = addPoint(s, at);
  const id = sketchId("t");
  const text: SketchText = {
    id,
    anchor: r.pointId,
    value: settings.value,
    size: settings.size,
    angle: settings.angle,
    font: settings.font,
    ...(settings.anchorAt === "centre" ? { anchorAt: "centre" as const } : {}),
    construction,
  };
  return { sketch: { ...r.sketch, texts: [...textsOf(s), text] }, textId: id };
}

/** Change a text's words, size, turn, font, anchor or construction. */
export function changeText(s: SketchData, id: string, patch: Partial<TextSettings> & { construction?: boolean }): EditResult {
  const t = textById(s, id);
  if (!t) return { sketch: s, error: "That text isn't in the sketch any more." };
  const problem = textProblem(patch);
  if (problem) return { sketch: s, error: problem };
  const { anchorAt, ...rest } = patch;
  const next: SketchText = { ...t, ...rest };
  if (anchorAt === "centre") next.anchorAt = "centre";
  else if (anchorAt === "start") delete next.anchorAt;
  // Switching where the anchor is keeps the letters where they are: the anchor point moves instead.
  let sketch = s;
  if (anchorAt !== undefined && (anchorAt === "centre") !== (t.anchorAt === "centre")) {
    const before = textBox(s, t);
    const after = textBox(s, next);
    const [dx, dy] = [before[0][0] - after[0][0], before[0][1] - after[0][1]];
    const [ax, ay] = pointPos(s, t.anchor);
    sketch = { ...s, points: s.points.map((p) => (p.id === t.anchor ? { ...p, x: ax + dx, y: ay + dy } : p)) };
  }
  return { sketch: { ...sketch, texts: textsOf(s).map((x) => (x.id === id ? next : x)) } };
}

/**
 * Delete texts and pictures by id, and anything else in `ids` the usual way.
 * A text's anchor point goes with it unless something else uses that point.
 */
export function deleteWithExtras(s: SketchData, ids: string[]): SketchData {
  const gone = new Set(ids);
  const texts = textsOf(s).filter((t) => !gone.has(t.id));
  const dropped = textsOf(s).filter((t) => gone.has(t.id));
  const usedByCurves = new Set(s.curves.flatMap(curvePoints));
  const anchors = dropped.map((t) => t.anchor).filter((a) => a !== "origin" && !usedByCurves.has(a) && !texts.some((t) => t.anchor === a));
  const images = imagesOf(s).filter((m) => !gone.has(m.id));
  const rest = ids.filter((id) => !dropped.some((t) => t.id === id) && !imagesOf(s).some((m) => m.id === id));
  const toDelete = [...rest, ...anchors];
  const base: SketchData = { ...s, texts, images };
  const out = toDelete.length ? deleteItems(base, toDelete) : base;
  return tidyExtras({ ...out, texts: out.texts ?? texts, images: out.images ?? images });
}

/** Drop texts whose anchor point has gone, and empty lists (so a sketch without any stays as older files have it). */
function tidyExtras(s: SketchData): SketchData {
  const ids = new Set(s.points.map((p) => p.id));
  const texts = s.texts?.filter((t) => t.anchor === "origin" || ids.has(t.anchor));
  const out: SketchData = { ...s };
  if (texts?.length) out.texts = texts;
  else delete out.texts;
  if (s.images?.length) out.images = s.images;
  else delete out.images;
  return out;
}

/**
 * The sketch after an edit, keeping the texts and pictures from before it when
 * the edit didn't know about them (it built the sketch from points, curves and
 * constraints only). Texts whose anchor point the edit deleted go too.
 */
export function keepSketchExtras(prev: SketchData, next: SketchData): SketchData {
  const texts = next.texts ?? prev.texts;
  const images = next.images ?? prev.images;
  if (texts === next.texts && images === next.images && (!texts || texts.every((t) => t.anchor === "origin" || next.points.some((p) => p.id === t.anchor)))) return next;
  return tidyExtras({ ...next, ...(texts ? { texts } : {}), ...(images ? { images } : {}) });
}

/** Is this id a text or a picture in the sketch? */
export const isExtraId = (s: SketchData, id: string) => !!textById(s, id) || !!imageById(s, id);

// ---------------------------------------------------------------------------
// Pictures

/**
 * Lay a picture on the sketch, `width` mm wide (its height keeps the
 * picture's shape), with its middle at `centre`.
 */
export function addImage(s: SketchData, src: string, pixels: { width: number; height: number }, width: number, centre: Pt = [0, 0], name?: string): EditResult & { imageId: string } {
  if (!(pixels.width > 0 && pixels.height > 0)) return { sketch: s, imageId: "", error: "That picture couldn't be read. Try a PNG or JPEG file." };
  if (!(width > 0)) return { sketch: s, imageId: "", error: "The picture's width must be more than 0 mm." };
  const height = (width * pixels.height) / pixels.width;
  const id = sketchId("img");
  const image: SketchImage = { id, src, x: centre[0] - width / 2, y: centre[1] - height / 2, width, height, opacity: 0.5, ...(name ? { name } : {}) };
  return { sketch: { ...s, images: [...imagesOf(s), image] }, imageId: id };
}

/** Change a picture's place, width (its height follows, keeping its shape) or how see-through it is. */
export function changeImage(s: SketchData, id: string, patch: { x?: number; y?: number; width?: number; opacity?: number }): EditResult {
  const m = imageById(s, id);
  if (!m) return { sketch: s, error: "That picture isn't in the sketch any more." };
  if (patch.width !== undefined && !(patch.width > 0)) return { sketch: s, error: "The picture's width must be more than 0 mm." };
  if (patch.opacity !== undefined && !(patch.opacity >= 0 && patch.opacity <= 1)) return { sketch: s, error: "How solid the picture is goes from 0% to 100%." };
  const next: SketchImage = { ...m, ...patch };
  if (patch.width !== undefined) {
    // Resized about its middle.
    next.height = (patch.width * m.height) / m.width;
    if (patch.x === undefined) next.x = m.x + (m.width - patch.width) / 2;
    if (patch.y === undefined) next.y = m.y + (m.height - next.height) / 2;
  }
  return { sketch: { ...s, images: imagesOf(s).map((x) => (x.id === id ? next : x)) } };
}

/** The topmost picture under (x, y), or null. */
export function imageAt(s: SketchData, x: number, y: number): string | null {
  const list = imagesOf(s);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (x >= m.x && x <= m.x + m.width && y >= m.y && y <= m.y + m.height) return m.id;
  }
  return null;
}
